/**
 * Application bootstrap.
 *
 * This module owns the wiring: it creates the store, builds the live audio graph, renders
 * the schema-driven controls, starts the animation loop and connects the export
 * controllers. It contains no DSP and no encoding — every numeric routine lives in
 * `src/audio/**` where it can be tested without a browser.
 */

import { ENGINE_NAME, ENGINE_VERSION, EXPORT_SAMPLE_RATES, LIMITS } from './constants.js';
import { createStore } from './state.js';
import { PARAMETER_LIST, previewDivergences } from './parameters.js';
import { serializePreset, parsePreset, expandCatalogPreset } from './presets-io.js';
import { ALL_PRESETS, PRESET_GROUPS, findPreset } from '../presets/index.js';
import { presetFamily, sanitizeForFamily } from '../presets/_shared.js';
import { adaptParameters, spectralSummary } from '../audio/adaptive/source-aware.js';

import {
  getAudioContext,
  resumeAudioContext,
  probeCapabilities,
  probeOfflineSampleRate,
} from '../audio/context.js';
import {
  buildMasteringChain,
  applyParameters,
  readGainReduction,
} from '../audio/graph/build-mastering-chain.js';
import { bandAmountToSettings, resolveDryDelay } from '../audio/graph/multiband.js';
import { dynamicsCompressorMakeupCompensation } from '../audio/dsp/dynamics-compressor.js';
import { linearQToDb } from '../audio/dsp/biquad.js';
import { dbToGain, gainToDb, clamp } from '../audio/dsp/math.js';
import { truePeakEstimate } from '../audio/analysis/true-peak.js';
import { phaseRiskFromParameters } from '../audio/analysis/correlation.js';
import { computeMatchCurve } from '../audio/analysis/spectral-match.js';
import { randomSeed } from '../audio/dsp/prng.js';
import { renderChain } from '../audio/render/render-master.js';
import { baseNameOf, downloadJson, sanitizeFilename } from '../audio/encode/download.js';
import { analyseBuffer, createAnalysisScheduler } from '../workers/analysis-client.js';

import { $, $$, el, replaceChildren, formatTime, formatBytes } from '../ui/dom.js';
import { toast, renderNotice, announce } from '../ui/notifications.js';
import { applyTheme, initialTheme } from '../ui/theme.js';
import { initTabs } from '../ui/tabs.js';
import { initControls } from '../ui/controls.js';
import { initSignalFlow } from '../ui/signal-flow.js';
import { createTransport } from '../ui/transport.js';
import { initPresetPanel } from '../ui/presets-panel.js';
import { initCommandPalette, initShortcuts } from '../ui/command-palette.js';

import { drawWaveform, invalidateWaveformCache } from '../visualizers/waveform.js';
import { drawSpectrum } from '../visualizers/spectrum.js';
import {
  drawVectorscope,
  pushCorrelation,
  resetCorrelationHistory,
} from '../visualizers/vectorscope.js';
import { drawSpeakerMap } from '../visualizers/speaker-map.js';
import { drawMatchCurve } from '../visualizers/match-curve.js';
import { drawCrossoverDiagnostic } from '../visualizers/crossover.js';
import { drawLoudnessGraph } from '../visualizers/loudness-graph.js';
import { getScratch, invalidateCssCache } from '../visualizers/canvas-util.js';

import { createExportController } from './export-controller.js';
import { createImmersiveController } from './immersive-controller.js';
import { initExportSummary } from '../ui/export-summary.js';
import { initHeavyWarning } from '../ui/heavy-warning.js';

import { initWorkspace } from '../ui/workspace.js';
import { initSourceHero } from '../ui/source-analysis.js';
import { initMasterStatus } from '../ui/master-status.js';
import { initSonicSummary } from '../ui/sonic-summary.js';
import { initMacroControls } from '../ui/macro-controls.js';
import { initAbEnhanced } from '../ui/ab-enhanced.js';
import { initPresetBrowserEnhanced } from '../ui/preset-browser-enhanced.js';
import { initSpatialLab } from '../ui/spatial-lab.js';

export function bootstrap() {
  const store = createStore();
  store.restoreAutosave();
  applyTheme(store.getState().ui.theme || initialTheme());

  /** Live graph state. */
  let live = null;
  /** Identity token for the loaded buffer, used to invalidate the waveform cache. */
  let bufferToken = {};
  let previousParameters = null;
  let comparing = false;
  /** Source measurements, cached per loaded file — the source never changes. */
  let sourceStatsCache = { token: null, stats: null };
  /** Latest source-aware adaptation summary, for the loudness-tab notice. */
  let currentAdaptation = { adaptations: [], sourceClass: 'unmeasured' };

  const scheduler = createAnalysisScheduler(420);

  /* ────────────────────────────── live graph ─────────────────────────────── */

  function ensureLiveGraph() {
    if (live) return live;
    const ctx = getAudioContext();
    const chain = buildMasteringChain(ctx, {
      textureSeed: store.getParameters().textureSeed,
    });

    // Safety limiter for the monitor path only. This is NOT the export limiter and the UI
    // says so in three places. Gentle settings: it should catch accidents, not shape sound.
    const safety = ctx.createDynamicsCompressor();
    safety.threshold.value = -1.2;
    safety.knee.value = 1;
    safety.ratio.value = 12;
    safety.attack.value = 0.003;
    safety.release.value = 0.2;

    // `DynamicsCompressorNode` applies a fixed, non-configurable make-up gain of
    // pow(1/Saturate(1,k), 0.6) — here +0.68 dB at −1.2 dB / 20:1. Without an exact
    // inverse, the safety itself pushes the monitor above the ceiling it is meant to
    // protect and the preview level lies by that much. `pushParameters` keeps this node
    // in exact inverse whenever it moves `safety.threshold`.
    const safetyMakeup = ctx.createGain();
    safetyMakeup.gain.value = 1;

    const post = ctx.createGain();
    const monitor = ctx.createGain();
    chain.output.connect(safety);
    safety.connect(safetyMakeup);
    safetyMakeup.connect(post);
    post.connect(monitor);
    monitor.connect(ctx.destination);

    const spectrumAnalyser = ctx.createAnalyser();
    spectrumAnalyser.fftSize = 4096;
    spectrumAnalyser.smoothingTimeConstant = 0.78;
    const splitter = ctx.createChannelSplitter(2);
    const analyserL = ctx.createAnalyser();
    analyserL.fftSize = 2048;
    const analyserR = ctx.createAnalyser();
    analyserR.fftSize = 2048;

    // K-weighting approximation for the live loudness meters. This is a *monitor*, not the
    // BS.1770 meter: it weights the already-summed stereo bus and its window length is
    // frame-rate dependent. The integrated figure always comes from the offline pass.
    const kShelf = ctx.createBiquadFilter();
    kShelf.type = 'highshelf';
    kShelf.frequency.value = 1681.97;
    kShelf.gain.value = 4;
    const kHigh = ctx.createBiquadFilter();
    kHigh.type = 'highpass';
    kHigh.frequency.value = 38.13;
    // BS.1770 pre-filter high-pass, linear Q = 0.5 — but node Q is resonance in dB
    // for highpass, so convert (bare 0.5 would read as +0.5 dB of resonance).
    kHigh.Q.value = linearQToDb(0.5);
    const kAnalyser = ctx.createAnalyser();
    kAnalyser.fftSize = 8192;
    kAnalyser.smoothingTimeConstant = 0;

    post.connect(spectrumAnalyser);
    post.connect(splitter);
    splitter.connect(analyserL, 0);
    splitter.connect(analyserR, 1);
    post.connect(kShelf);
    kShelf.connect(kHigh);
    kHigh.connect(kAnalyser);

    chain.start(0);
    live = {
      ctx,
      chain,
      safety,
      safetyMakeup,
      post,
      monitor,
      spectrumAnalyser,
      analyserL,
      analyserR,
      kAnalyser,
    };
    // Match the multiband dry path to this engine's measured compressor latency. In
    // browsers this resolves to the 6 ms the graph was built with (a no-op assignment);
    // on engines that differ it corrects the alignment without rebuilding the graph.
    // Fire-and-forget: a failed probe keeps the documented default, never silence.
    resolveDryDelay(ctx.sampleRate)
      .then((dry) => {
        if (
          dry.measured &&
          Math.abs(dry.seconds - chain.multiband.dryDelay.delayTime.value) > 1e-9
        ) {
          chain.multiband.dryDelay.delayTime.value = dry.seconds;
        }
      })
      .catch(() => {});
    pushParameters();
    applyMonitorGain();
    return live;
  }

  /**
   * Monitor gain has exactly two inputs — the binaural preview (which mutes the stereo
   * path because binaural is fed directly to the destination) and the −12 dB dim. Both
   * used to write `live.monitor.gain` from their own modules; whoever ran last silently
   * un-muted or un-dimmed the other. Now both states live in the store and this is the
   * only place that touches the node.
   */
  function applyMonitorGain() {
    if (!live) return;
    const s = store.getState();
    const binaural = s.immersive.binauralPreview && s.immersive.layout !== 'off';
    live.monitor.gain.value = binaural ? 0 : s.ui.abDim ? dbToGain(-12) : 1;
  }

  /** Source stats for the live graph, or null before the first analysis lands. */
  function liveSourceStats() {
    if (sourceStatsCache.token !== bufferToken || !sourceStatsCache.stats) return null;
    const s = sourceStatsCache.stats;
    return {
      integrated: s.loudness?.integrated,
      lra: s.loudness?.lra,
      crestDb: s.crestFactorDb,
      truePeakDb: s.peaks?.truePeakDb,
      spectral: spectralSummary(s.fingerprint ?? null),
      channels: store.getState().source.buffer?.numberOfChannels,
    };
  }

  /** Push the current parameters (and A/B/C state) onto the live graph. */
  function pushParameters() {
    if (!live) return;
    const state = store.getState();
    const p = store.getParameters();
    const mode = state.ui.abMode;
    const bypassAll = mode === 'A';

    // Source-aware preview: the same adaptation the export applies, so the monitor and
    // the master agree on how hard each processor works.
    const stats = liveSourceStats();
    const eff = stats ? adaptParameters(p, stats).parameters : p;
    if (stats) {
      const summary = adaptParameters(p, stats);
      currentAdaptation = {
        adaptations: summary.adaptations,
        sourceClass: summary.sourceClass,
      };
    }

    applyParameters(live.chain, eff, {
      bypassAll,
      moduleBypass: state.ui.moduleBypass,
      audition: state.ui.audition,
    });

    live.safety.threshold.value = bypassAll ? 0 : Math.min(-0.2, eff.ceiling - 0.2);
    // Exact inverse of the safety's fixed spec make-up at the threshold just set (knee 0,
    // ratio 20 stay fixed at build time). At threshold 0 (A/B audition of the source) the
    // make-up is 0 dB and this node is transparent.
    live.safetyMakeup.gain.value = dynamicsCompressorMakeupCompensation(
      live.safety.threshold.value,
      0,
      20,
    );

    // ── Monitor level ────────────────────────────────────────────────────────────────
    // Three audition modes, switchable instantly for genuine comparison:
    //   · A — ORIGINAL: the unprocessed source.
    //   · B — MASTERED: the chain plus the normalisation gain toward the target.
    //   · C — MATCHED: the mastered chain level-matched to the original, removing the
    //     psychological advantage of "the master is louder".
    // The legacy "match loudness" toggle additionally level-matches A against B.
    const analysis = state.analysis;
    const orig = analysis.original;
    const proc = analysis.processed;
    let gain = 1;
    if (mode === 'C') {
      if (orig && proc && Number.isFinite(orig.integrated) && Number.isFinite(proc.integrated)) {
        gain = dbToGain(clamp(orig.integrated - proc.integrated, -24, 24));
      } else if (eff.normalize && proc && Number.isFinite(proc.integrated)) {
        gain = dbToGain(clamp(eff.targetLUFS - proc.integrated, -24, 24));
      }
    } else {
      if (eff.normalize && !bypassAll && proc && Number.isFinite(proc.integrated)) {
        gain = dbToGain(clamp(eff.targetLUFS - proc.integrated, -24, 24));
      }
      if (state.ui.matchLoudness && orig && proc) {
        const reference = eff.normalize
          ? eff.targetLUFS
          : Number.isFinite(proc.integrated)
            ? proc.integrated
            : null;
        const current = bypassAll ? orig.integrated : proc.integrated;
        if (reference !== null && Number.isFinite(current)) {
          gain = dbToGain(clamp(reference - current, -24, 24));
        }
      }
    }
    live.post.gain.value = gain;
  }

  /* ────────────────────────────── file loading ───────────────────────────── */

  async function loadFile(file) {
    if (!file) return;
    if (file.size > LIMITS.MAX_FILE_BYTES) {
      toast(
        `${sanitizeFilename(file.name)} is ${formatBytes(file.size)} — the limit is ` +
          `${formatBytes(LIMITS.MAX_FILE_BYTES)}. Decoding it would exhaust this tab's memory.`,
        { level: 'error' },
      );
      return;
    }
    let ctx;
    try {
      ctx = await resumeAudioContext();
    } catch (error) {
      toast(String(error.message ?? error), { level: 'error' });
      return;
    }

    let buffer;
    try {
      const bytes = await file.arrayBuffer();
      buffer = await ctx.decodeAudioData(bytes);
    } catch (error) {
      toast(
        `Could not decode "${sanitizeFilename(file.name)}". Browser codec support varies — ` +
          'WAV and MP3 work everywhere; FLAC, M4A and Opus do not.',
        { level: 'error' },
      );
      console.warn('[signal-rot] decode failed:', error);
      return;
    }

    if (buffer.duration > LIMITS.MAX_DURATION_S) {
      toast(
        `That file is ${formatTime(buffer.duration)} long; the limit is ` +
          `${formatTime(LIMITS.MAX_DURATION_S)}.`,
        { level: 'error' },
      );
      return;
    }
    if (buffer.duration > LIMITS.WARN_DURATION_S) {
      toast(
        `${formatTime(buffer.duration)} at ${(buffer.sampleRate / 1000).toFixed(1)} kHz — renders ` +
          'will be slow and memory-hungry in a browser tab.',
      );
    }

    // ── Staleness barrier ───────────────────────────────────────────────────────────
    // Any result in flight belongs to the PREVIOUS file and must never touch state after
    // this point: cancel the scheduler, drop the measurements, and disarm anything that
    // was computed from them (loudness-matched monitor gain, spectral-match curve).
    // Otherwise meters, the export summary and the C-mode level silently describe the old
    // file for as long as the new render takes.
    scheduler.cancel();
    store.setAnalysis({ original: null, processed: null, match: null, running: false });
    sourceStatsCache = { token: null, stats: null };
    currentAdaptation = { adaptations: [], sourceClass: 'unmeasured' };
    renderNotice($('#adaptNotice'), null);
    if (store.getParameters().matchStrength !== 0) {
      store.setParameter('matchStrength', 0);
      renderNotice($('#matchNotice'), {
        level: 'caution',
        title: 'Match curve is from the previous source',
        messages: [
          'The curve is kept, but its strength was zeroed: a correction measured on ' +
            'another track is not a correction for this one. Press Match to re-measure.',
        ],
      });
      toast('Match curve kept but disarmed — it measured the previous source.');
    }

    ensureLiveGraph();
    transport.stop();
    bufferToken = {};
    invalidateWaveformCache();
    resetCorrelationHistory();

    store.setSource({
      buffer,
      name: file.name,
      durationSeconds: buffer.duration,
      sampleRate: buffer.sampleRate,
      channels: buffer.numberOfChannels,
    });
    // Re-derive the monitor gain now that the source changed (the old figure was a
    // loudness match against the previous file's numbers).
    pushParameters();
    updateAnalysisUi();

    $('#transportEmpty').hidden = true;
    $('#transportFull').hidden = false;
    $('#waveCard').hidden = false;
    $('#scopesRow').hidden = false;
    $('#metersRow').hidden = false;
    $('#analyzeHint').hidden = false;
    $('#fileName').textContent =
      `${file.name}  ·  ${buffer.numberOfChannels} ch · ` +
      `${(buffer.sampleRate / 1000).toFixed(1)} kHz · ${formatTime(buffer.duration)}`;
    $('#fileName').title = file.name;

    populateSampleRates(buffer.sampleRate);
    toast('Loaded — measuring and preview-rendering this takes a moment…');
    runAnalysis({ immediate: true });
  }

  /* ────────────────────────────── analysis ───────────────────────────────── */

  async function runAnalysis({ immediate = false } = {}) {
    const source = store.getState().source.buffer;
    if (!source) return;
    store.setAnalysis({ running: true });
    updateAnalysisUi();
    const token = bufferToken;

    let result = null;
    let failure = null;
    try {
      result = await scheduler.request(
        async () => {
          const parameters = store.getParameters();
          // The source never changes for a loaded file: measure it once (loudness, peaks,
          // crest factor, tonal shape) and reuse the result on every later slider move.
          if (sourceStatsCache.token !== token || !sourceStatsCache.stats) {
            sourceStatsCache = {
              token,
              stats: await analyseBuffer(source, ['loudness', 'peaks', 'rms', 'fingerprint']),
            };
          }
          const srcStats = sourceStatsCache.stats;
          const adaptation = adaptParameters(parameters, {
            integrated: srcStats.loudness?.integrated,
            lra: srcStats.loudness?.lra,
            crestDb: srcStats.crestFactorDb,
            truePeakDb: srcStats.peaks?.truePeakDb,
            spectral: spectralSummary(srcStats.fingerprint ?? null),
            channels: source.numberOfChannels,
          });
          currentAdaptation = {
            adaptations: adaptation.adaptations,
            sourceClass: adaptation.sourceClass,
          };
          const processed = await renderChain(source, adaptation.parameters, {
            moduleBypass: store.getState().ui.moduleBypass,
          });
          const processedStats = await analyseBuffer(processed, ['loudness', 'peaks', 'mono']);
          return { source: srcStats, processed: processedStats };
        },
        { immediate },
      );
    } catch (error) {
      failure = error;
    }

    // Either outcome below must be attributed to THIS file: the staleness barrier in
    // loadFile owns the decision, and this guard covers a swap that started mid-render.
    if (token !== bufferToken) return;
    if (failure) {
      // No zombie spinner: whatever went wrong, `running` must go back to false so the
      // status pill stops saying "analysing…" and the user can retry from Re-analyse.
      store.setAnalysis({ running: false });
      console.error('[signal-rot] analysis failed:', failure);
      toast(
        `Analysis failed: ${failure.message ?? failure} — the figures shown are from the ` +
          'previous pass; press Re-analyse to retry.',
        { level: 'error' },
      );
      updateAnalysisUi();
      return;
    }
    if (!result) return; // superseded by a newer request — that one owns `running`
    store.setAnalysis({
      running: false,
      original: { ...result.source.loudness, peaks: result.source.peaks },
      processed: {
        ...result.processed.loudness,
        peaks: result.processed.peaks,
        mono: result.processed.mono,
      },
    });
    pushParameters();
    updateAnalysisUi();
  }

  function updateAnalysisUi() {
    const state = store.getState();
    const p = store.getParameters();
    const stats = state.ui.abMode === 'A' ? state.analysis.original : state.analysis.processed;

    const setText = (sel, value) => {
      const node = $(sel);
      if (node) node.textContent = value;
    };
    const setBar = (sel, fraction) => {
      const node = $(sel);
      if (node) node.style.width = `${clamp(fraction * 100, 0, 100)}%`;
    };

    // Honest running indicator: without it, "what is the app doing right now?" is only
    // answerable by guessing whether the numbers on screen have settled.
    const statePill = $('#analysisState');
    if (statePill) {
      statePill.hidden = !state.analysis.running;
      statePill.textContent = state.analysis.running ? 'analysing…' : '';
    }

    if (stats) {
      setText('#mLUFS', Number.isFinite(stats.integrated) ? stats.integrated.toFixed(1) : '—');
      setText('#mLRA', Number.isFinite(stats.lra) ? stats.lra.toFixed(1) : '—');
      setBar('#barLUFS', (stats.integrated + 40) / 40);
      setBar('#barLRA', stats.lra / 20);
      const colour = state.ui.abMode === 'A' ? 'var(--orig)' : 'var(--proc)';
      const lufsNode = $('#mLUFS');
      if (lufsNode) lufsNode.style.color = colour;
      drawLoudnessGraph($('#loudnessGraph'), {
        shortTerm: stats.shortTerm ?? [],
        hopSeconds: stats.shortTermHopSeconds ?? 1,
        integrated: stats.integrated,
        target: p.normalize ? p.targetLUFS : NaN,
        abMode: state.ui.abMode,
      });
    } else if (!state.analysis.running) {
      // No measurement for THIS file yet — blank the figures instead of leaving the
      // previous file's numbers on screen looking like current truth.
      setText('#mLUFS', '—');
      setText('#mLRA', '—');
      setBar('#barLUFS', 0);
      setBar('#barLRA', 0);
      const lufsNode = $('#mLUFS');
      if (lufsNode) lufsNode.style.color = '';
      drawLoudnessGraph($('#loudnessGraph'), {
        shortTerm: [],
        hopSeconds: 1,
        integrated: NaN,
        target: NaN,
        abMode: state.ui.abMode,
        emptyLabel: 'No measurement for this source yet.',
      });
    }

    setText('#mLUFSsub', p.normalize ? `target ${p.targetLUFS.toFixed(1)}` : 'normalisation off');
    setText('#mTPsub', `ceiling ${p.ceiling.toFixed(1)} dBTP · export`);

    // Phase-risk notice.
    const risk = phaseRiskFromParameters(p);
    const messages = risk.messages.map((m) => m.replace(/\s+/g, ' ').trim());
    if (state.analysis.processed && state.analysis.processed.mono) {
      const worst = state.analysis.processed.mono.worstBand;
      if (worst && worst.monoLossDb < -6) {
        messages.push(
          `Measured: mono fold-down loses ${worst.monoLossDb.toFixed(1)} dB in the ` +
            `${worst.label} band (${worst.lo}–${Math.round(worst.hi)} Hz).`,
        );
      }
    }
    renderNotice(
      $('#phaseNotice'),
      messages.length
        ? {
            level: risk.level === 'danger' ? 'danger' : 'caution',
            title:
              risk.level === 'danger'
                ? 'Severe phase risk — this will not survive a mono fold-down'
                : 'Phase / mono-compatibility notes',
            messages,
          }
        : null,
    );

    // Source-aware adaptation notice: say what was softened and why.
    renderNotice(
      $('#adaptNotice'),
      currentAdaptation.adaptations.length
        ? {
            level: 'info',
            title: `Source-aware: ${currentAdaptation.sourceClass} source — processing eased off`,
            messages: currentAdaptation.adaptations,
          }
        : null,
    );
  }

  /* ────────────────────────────── render loop ────────────────────────────── */

  let rafHandle = 0;
  let lastFrame = 0;
  const energyMomentary = [];
  const energyShortTerm = [];

  function frame(now) {
    rafHandle = requestAnimationFrame(frame);
    // Cap the visualiser refresh at ~40 fps. Nothing here benefits from 120 Hz and the
    // saving is real on a laptop rendering a 24-channel speaker map.
    if (now - lastFrame < 24) return;
    const dt = (now - lastFrame) / 1000;
    lastFrame = now;

    const state = store.getState();
    if (!live || !state.source.buffer) return;

    transport.tick();
    transport.updateTimeDisplay();

    drawWaveform($('#wave'), {
      buffer: state.source.buffer,
      token: bufferToken,
      position: transport.position(),
      loopRegion: transport.loopRegion,
      abMode: state.ui.abMode,
    });

    if ($('#scopesRow') && !$('#scopesRow').hidden) {
      drawSpectrum($('#spectrum'), live.spectrumAnalyser, { abMode: state.ui.abMode });
      drawVectorscope($('#gonio'), live.analyserL, live.analyserR, { abMode: state.ui.abMode });
    }

    updateLiveMeters(dt);
    updateGainReductionMeters();

    // Immersive legacy map (kept for compatibility)
    if (state.ui.tab === 'immersive' && state.immersive.layout !== 'off') {
      drawSpeakerMap($('#spkmap'), {
        layoutId: state.immersive.layout,
        target: state.immersive.target,
        analyserL: live.analyserL,
        analyserR: live.analyserR,
        params: state.immersive,
        yaw: state.ui.listenerYaw || 0,
      });
    }

    // Spatial Lab tick — runs when lab is visible or when spatial energy is displayed.
    // The mastering status card deliberately does NOT sync here: it renders store data
    // only, and rebuilding its DOM ~40×/s during playback was pure jank. Its own store
    // subscription repaints it whenever the underlying numbers actually change.
    try {
      const labCard = document.querySelector('#spatialLabCard');
      if (labCard && !labCard.hidden) spatialLab.tick();
    } catch {
      void 0;
    }

    // Keep limiter reduction in UI state for the status card. QUANTISED on purpose: the
    // store notifies every subscribed panel on every write, and an unquantised poll wrote
    // ~40 times per second during playback, rebuilding the status/summary DOM continuously
    // — measurable jank that pulled attention from listening. The card shows one decimal,
    // so 0.5 dB steps are the honest display resolution.
    try {
      const reduction = readGainReduction(live.chain);
      const worst = Math.min(reduction.low ?? 0, reduction.mid ?? 0, reduction.high ?? 0);
      if (Number.isFinite(worst)) {
        const quantised = Math.round(worst * 2) / 2;
        if (quantised !== (store.getState().ui.limiterReduction ?? 0)) {
          store.setUi({ limiterReduction: quantised });
        }
      }
    } catch {
      void 0;
    }
  }

  function updateLiveMeters(dt) {
    const p = store.getParameters();
    const state = store.getState();

    const k = getScratch('kmeter', live.kAnalyser.fftSize);
    live.kAnalyser.getFloatTimeDomainData(k);
    let meanSquare = 0;
    for (let i = 0; i < k.length; i++) meanSquare += k[i] * k[i];
    meanSquare /= k.length;

    // Time-based windows rather than frame-count windows: the audited meter averaged a
    // fixed number of animation frames, so "400 ms momentary" was 167 ms at 60 fps and
    // 333 ms at 30 fps.
    energyMomentary.push({ v: meanSquare, t: dt });
    energyShortTerm.push({ v: meanSquare, t: dt });
    trimWindow(energyMomentary, 0.4);
    trimWindow(energyShortTerm, 3.0);

    const average = (arr) => {
      let sum = 0;
      let total = 0;
      for (const e of arr) {
        sum += e.v * e.t;
        total += e.t;
      }
      return total > 0 ? sum / total : 0;
    };

    const momentary = -0.691 + 10 * Math.log10(Math.max(1e-12, average(energyMomentary)));
    const shortTerm = -0.691 + 10 * Math.log10(Math.max(1e-12, average(energyShortTerm)));
    $('#mMom').textContent = Number.isFinite(momentary) ? momentary.toFixed(1) : '—';
    $('#mST').textContent = Number.isFinite(shortTerm) ? shortTerm.toFixed(1) : '—';
    const bar = $('#barST');
    if (bar) bar.style.width = `${clamp(((shortTerm + 40) / 40) * 100, 0, 100)}%`;

    const left = getScratch('meterL', live.analyserL.fftSize);
    const right = getScratch('meterR', live.analyserR.fftSize);
    live.analyserL.getFloatTimeDomainData(left);
    live.analyserR.getFloatTimeDomainData(right);

    const truePeak = Math.max(
      truePeakEstimate(left, live.ctx.sampleRate, 3),
      truePeakEstimate(right, live.ctx.sampleRate, 3),
    );
    const tpDb = gainToDb(truePeak);
    const tpNode = $('#mTP');
    if (tpNode) {
      tpNode.textContent = Number.isFinite(tpDb) ? `${tpDb > 0 ? '+' : ''}${tpDb.toFixed(1)}` : '—';
    }
    $('#tpMeter')?.classList.toggle('over', tpDb > p.ceiling);
    const tpBar = $('#barTP');
    if (tpBar) tpBar.style.width = `${clamp(((tpDb + 24) / 24) * 100, 0, 100)}%`;

    let lr = 0;
    let ll = 0;
    let rr = 0;
    let rms = 0;
    for (let i = 0; i < left.length; i++) {
      lr += left[i] * right[i];
      ll += left[i] * left[i];
      rr += right[i] * right[i];
      rms += (left[i] * left[i] + right[i] * right[i]) * 0.5;
    }
    const correlation = Math.sqrt(ll * rr) < 1e-12 ? 1 : lr / Math.sqrt(ll * rr);
    pushCorrelation(correlation);
    const corrNode = $('#mCorr');
    if (corrNode) {
      corrNode.textContent = correlation.toFixed(2);
      corrNode.style.color =
        correlation < 0 ? 'var(--hot)' : correlation < 0.3 ? 'var(--proc)' : 'var(--text)';
    }
    $('#mCorrTxt').textContent =
      correlation < 0 ? '⚠ out of phase' : correlation > 0.85 ? 'near mono' : 'wide';
    const corrBar = $('#barCorr');
    if (corrBar) corrBar.style.width = `${((correlation + 1) / 2) * 100}%`;

    const rmsDb = gainToDb(Math.sqrt(rms / left.length) * Math.SQRT2);
    $('#mRMS').textContent = Number.isFinite(rmsDb) ? rmsDb.toFixed(0) : '—';

    if (state.ui.abMode) {
      /* nothing else to do; kept for clarity */
    }
  }

  function trimWindow(arr, seconds) {
    let total = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
      total += arr[i].t;
      if (total > seconds) {
        arr.splice(0, i);
        return;
      }
    }
  }

  function updateGainReductionMeters() {
    if (!live) return;
    const reduction = readGainReduction(live.chain);
    const p = store.getParameters();
    const amounts = { low: p.mbLow, mid: p.mbMid, high: p.mbHigh };
    for (const node of $$('#grMeters .gr')) {
      const band = node.dataset.band;
      const db = reduction[band] ?? 0;
      node.querySelector('.v').textContent = `${db.toFixed(1)} dB`;
      node.querySelector('.track i').style.width = `${clamp((-db / 12) * 100, 0, 100)}%`;
      const settings = bandAmountToSettings(amounts[band]);
      node.querySelector('.set').textContent =
        amounts[band] > 0
          ? `${settings.thresholdDb.toFixed(0)} dB · ${settings.ratio.toFixed(1)}:1`
          : 'inactive';
    }
  }

  /* ────────────────────────────── transport ──────────────────────────────── */

  const transport = createTransport({
    getContext: () => getAudioContext(),
    getDestination: () => (live ? live.chain.input : null),
    getBuffer: () => store.getState().source.buffer,
  });

  /* ────────────────────────────── UI wiring ──────────────────────────────── */

  const workspace = initWorkspace({ store });

  const tabs = initTabs({ onChange: (tab) => store.setUi({ tab }) });
  initSourceHero({ store });
  initMasterStatus({ store });
  initSonicSummary({ store });
  // Single owner of A/B/C mode, loudness-match and dim state (buttons + methods; global
  // keys arrive through initShortcuts below, which calls into `abEnh`).
  const abEnh = initAbEnhanced({ store });
  initMacroControls({ store, pushParameters });
  initPresetBrowserEnhanced({ store });
  const spatialLab = initSpatialLab({ store, getLiveGraph: () => live });
  initExportSummary({ store });
  initHeavyWarning({ store });

  const controls = initControls({
    store,
    onChange: (key) => {
      store.setUi({ presetName: 'Custom' });
      presetPanel.sync();
      pushParameters();
      if (key === 'mbMix' || key === 'mbLow' || key === 'mbMid' || key === 'mbHigh') {
        redrawCrossover();
      }
      if (key === 'matchStrength' || key === 'matchMode') redrawMatch();
      if (key === 'textureSeed') rebuildLiveGraph();
      updateAnalysisUi();
      runAnalysis();
    },
  });

  const signalFlow = initSignalFlow({
    store,
    onChange: () => {
      pushParameters();
      runAnalysis();
    },
  });

  const presetPanel = initPresetPanel({
    getActiveName: () => store.getState().ui.presetName,
    onApply: (preset) => applyCatalogPreset(preset),
  });

  function applyCatalogPreset(preset) {
    previousParameters = store.getParameters();
    // Family contract: degradation DSP can never leak into a mastering preset, even from
    // a hand-edited catalogue entry.
    const family = presetFamily(preset);
    const { parameters: clean, scrubbed } = sanitizeForFamily(family, preset.parameters);
    if (scrubbed.length) {
      console.warn(`[signal-rot] ${preset.name}: scrubbed [${scrubbed}] (mastering family)`);
      toast(`Mastering preset — ${scrubbed.join(', ')} forced off`);
    }
    const parameters = expandCatalogPreset(clean, {
      preserve: {
        // A match curve is a measurement of *your* source, not a creative choice, so it
        // survives preset changes. Everything else resets — the audited behaviour of also
        // preserving loudness settings made presets non-deterministic.
        matchGains: previousParameters.matchGains,
        matchMode: previousParameters.matchMode,
        textureSeed: previousParameters.textureSeed,
      },
    });
    store.setParameters(parameters, { replace: true });
    store.setUi({ presetName: preset.name, moduleBypass: {} });
    presetPanel.sync();
    presetPanel.showAudit(preset);
    pushParameters();
    redrawCrossover();
    redrawMatch();
    updateAnalysisUi();
    runAnalysis();
    announce(`Preset ${preset.name} applied`);
  }

  function rebuildLiveGraph() {
    if (!live) return;
    const wasPlaying = transport.playing;
    const position = transport.position();
    transport.stop();
    // Tear the binaural tap down with the graph it hangs off, then rebuild it on the new
    // graph — otherwise a texture-seed change silently strands the preview on dead nodes
    // while the toggle keeps claiming it is on.
    immersiveController.teardownPreview();
    try {
      live.chain.dispose();
      live.monitor.disconnect();
    } catch {
      /* already torn down */
    }
    live = null;
    ensureLiveGraph();
    immersiveController.buildPreview();
    if (wasPlaying) transport.play(position);
  }

  /* ---- transport controls ---- */
  $('#playBtn').addEventListener('click', () => transport.toggle());
  $('#stopBtn').addEventListener('click', () => transport.stop());
  // A/B/C buttons are owned by `abEnh` (single set of listeners, blind-mode aware); the
  // graph/meter reaction is centralised in the store subscription below. A second set of
  // listeners here used to fight ab-enhanced for `abMode` ownership.
  $('#auditionSelect').addEventListener('change', (event) => {
    store.setUi({ audition: event.target.value });
  });
  $('#reanalyzeBtn').addEventListener('click', () => {
    toast('Re-analysing…');
    runAnalysis({ immediate: true });
  });
  $('#clearLoopBtn').addEventListener('click', () => transport.setLoopRegion(null));

  /* ---- waveform interaction (pointer events: mouse, touch and pen) ---- */
  const wave = $('#wave');
  let dragStart = null;
  wave.addEventListener('pointerdown', (event) => {
    const buffer = store.getState().source.buffer;
    if (!buffer) return;
    wave.setPointerCapture(event.pointerId);
    const rect = wave.getBoundingClientRect();
    dragStart = ((event.clientX - rect.left) / rect.width) * buffer.duration;
  });
  wave.addEventListener('pointermove', (event) => {
    const buffer = store.getState().source.buffer;
    if (dragStart === null || !buffer) return;
    const rect = wave.getBoundingClientRect();
    const t = ((event.clientX - rect.left) / rect.width) * buffer.duration;
    if (Math.abs(t - dragStart) > 0.15) {
      transport.setLoopRegion([Math.min(dragStart, t), Math.max(dragStart, t)]);
    }
  });
  const endDrag = (event) => {
    const buffer = store.getState().source.buffer;
    if (dragStart === null || !buffer) return;
    const rect = wave.getBoundingClientRect();
    const t = clamp((event.clientX - rect.left) / rect.width, 0, 1) * buffer.duration;
    const region = transport.loopRegion;
    if (!region || Math.abs(region[1] - region[0]) <= 0.15) {
      transport.setLoopRegion(null);
      transport.seek(t);
    }
    dragStart = null;
  };
  wave.addEventListener('pointerup', endDrag);
  wave.addEventListener('pointercancel', () => {
    dragStart = null;
  });

  /* ---- import ---- */
  $('#importBtn').addEventListener('click', () => $('#fileInput').click());
  $('#dropzone').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) loadFile(file);
    event.target.value = '';
  });
  const dropzone = $('#dropzone');
  for (const type of ['dragover', 'dragenter']) {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add('hot');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.remove('hot');
    });
  }
  dropzone.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) loadFile(file);
  });
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());

  /* ---- theme, undo/redo, reset ---- */
  $('#themeBtn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    store.setUi({ theme: next });
    invalidateCssCache();
  });
  $('#undoBtn').addEventListener('click', () => {
    if (store.undo()) afterHistoryChange();
  });
  $('#redoBtn').addEventListener('click', () => {
    if (store.redo()) afterHistoryChange();
  });
  $('#resetParamsBtn').addEventListener('click', () => {
    store.reset();
    presetPanel.sync();
    presetPanel.showAudit(null);
    pushParameters();
    redrawCrossover();
    redrawMatch();
    runAnalysis();
    toast('Reset to defaults');
  });

  const compareBtn = $('#comparePresetBtn');
  const startCompare = () => {
    if (comparing || !previousParameters) return;
    comparing = true;
    const current = store.getParameters();
    compareBtn.setAttribute('aria-pressed', 'true');
    store.setParameters(previousParameters, { replace: true, history: false });
    pushParameters();
    compareBtn.dataset.stash = JSON.stringify(current);
  };
  const endCompare = () => {
    if (!comparing) return;
    comparing = false;
    compareBtn.setAttribute('aria-pressed', 'false');
    try {
      store.setParameters(JSON.parse(compareBtn.dataset.stash), { replace: true, history: false });
    } catch {
      /* nothing stashed */
    }
    pushParameters();
  };
  compareBtn.addEventListener('pointerdown', startCompare);
  compareBtn.addEventListener('pointerup', endCompare);
  compareBtn.addEventListener('pointerleave', endCompare);
  compareBtn.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') startCompare();
  });
  compareBtn.addEventListener('keyup', endCompare);

  function afterHistoryChange() {
    pushParameters();
    presetPanel.sync();
    redrawCrossover();
    redrawMatch();
    updateAnalysisUi();
    runAnalysis();
  }

  /* ---- preset save / load ---- */
  $('#savePresetBtn').addEventListener('click', () => {
    const state = store.getState();
    const catalogEntry = findPreset(state.ui.presetName);
    const preset = serializePreset({
      parameters: store.getParameters(),
      immersive: state.immersive,
      name: state.ui.presetName,
      family: catalogEntry ? presetFamily(catalogEntry) : undefined,
    });
    downloadJson(preset, `${baseNameOf(state.source.name || 'signal-rot')}_preset.json`);
    toast('Preset saved');
  });
  $('#loadPresetBtn').addEventListener('click', () => $('#presetInput').click());
  $('#presetInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 1024 * 1024) {
      toast('That file is far too large to be a preset.', { level: 'error' });
      return;
    }
    const result = parsePreset(await file.text());
    if (!result.ok) {
      toast(`Preset rejected: ${result.error}`, { level: 'error' });
      return;
    }
    store.setParameters(result.preset.parameters, { replace: true });
    if (result.preset.immersive) store.setImmersive(result.preset.immersive);
    store.setUi({ presetName: result.preset.name });
    presetPanel.sync();
    pushParameters();
    redrawCrossover();
    redrawMatch();
    runAnalysis();
    toast(
      result.warnings.length
        ? `Loaded "${result.preset.name}" with ${result.warnings.length} note(s) — see console`
        : `Loaded "${result.preset.name}"`,
    );
    if (result.warnings.length) console.info('[signal-rot] preset notes:', result.warnings);
  });

  /* ---- character seed ---- */
  $('#randomiseSeedBtn').addEventListener('click', () => {
    store.setParameter('textureSeed', randomSeed());
    rebuildLiveGraph();
    runAnalysis();
    toast('New texture seed — exports will differ until you change it back');
  });

  /* ---- reference matching ---- */
  $('#refLoadBtn').addEventListener('click', () => $('#refInput').click());
  $('#refInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const ctx = await resumeAudioContext();
      const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
      store.setSource({ referenceBuffer: buffer, referenceName: file.name });
      $('#refName').textContent =
        `Reference: ${file.name} · ${buffer.duration.toFixed(1)} s · ` +
        `${(buffer.sampleRate / 1000).toFixed(1)} kHz`;
      toast('Reference loaded');
    } catch {
      toast('Could not decode that reference file.', { level: 'error' });
    }
  });

  $('#matchBtn').addEventListener('click', async () => {
    const state = store.getState();
    if (!state.source.buffer) return toast('Load your track first', { level: 'error' });
    if (!state.source.referenceBuffer) return toast('Load a reference first', { level: 'error' });
    toast('Analysing both tracks…');
    // Capture what we are measuring: if the user swaps either file while this runs, the
    // curve must not be applied to different audio (old work never mutates new state).
    const sourceToken = bufferToken;
    const measuredSource = state.source.buffer;
    const measuredReference = state.source.referenceBuffer;
    let source;
    let reference;
    try {
      [source, reference] = await Promise.all([
        analyseBuffer(measuredSource, ['fingerprint']),
        analyseBuffer(measuredReference, ['fingerprint']),
      ]);
    } catch (error) {
      console.error('[signal-rot] reference analysis failed:', error);
      return toast(`Reference analysis failed: ${error.message ?? error}`, { level: 'error' });
    }
    if (
      sourceToken !== bufferToken ||
      store.getState().source.buffer !== measuredSource ||
      store.getState().source.referenceBuffer !== measuredReference
    ) {
      return toast('Match aborted — the source or reference changed mid-analysis.');
    }
    if (!source.fingerprint || !reference.fingerprint) {
      return toast('Analysis failed — is one of the tracks shorter than 8192 samples?', {
        level: 'error',
      });
    }
    const result = computeMatchCurve(source.fingerprint, reference.fingerprint, {
      mode: store.getParameters().matchMode,
    });
    store.setParameters({ matchGains: result.gainsDb });
    if (store.getParameters().matchStrength === 0) store.setParameter('matchStrength', 70);
    store.setAnalysis({ match: result });
    store.setUi({ presetName: 'Custom' });
    presetPanel.sync();
    pushParameters();
    redrawMatch();
    runAnalysis();

    renderNotice($('#matchNotice'), {
      level: result.confidence > 0.6 ? 'ok' : 'caution',
      title: `Match confidence ${(result.confidence * 100).toFixed(0)} %`,
      messages: result.warnings.length
        ? result.warnings
        : ['Source and reference are tonally comparable; the correction is a modest tilt.'],
    });
    toast(`Matched — confidence ${(result.confidence * 100).toFixed(0)} %`);
    return undefined;
  });

  function redrawMatch() {
    const state = store.getState();
    const p = store.getParameters();
    drawMatchCurve($('#matchViz'), {
      gainsDb: p.matchGains,
      strength: p.matchStrength,
      sourceShapeDb: state.analysis.match?.sourceShapeDb,
      referenceShapeDb: state.analysis.match?.referenceShapeDb,
    });
  }

  function redrawCrossover() {
    const p = store.getParameters();
    drawCrossoverDiagnostic($('#crossoverViz'), {
      sampleRate: store.getState().source.sampleRate || 48000,
      mix: p.mbMix / 100,
      showLegacy: $('#showLegacyXover')?.checked ?? false,
    });
  }
  $('#showLegacyXover')?.addEventListener('change', redrawCrossover);

  /* ---- export settings: the store is the single source of truth ----
   * `ui.exportFormat` / `ui.exportSampleRate` are what the exporter, the export summary
   * and the autosaved session all read. The two <select>s are *views* of that state:
   * they write to it on change and are re-synced from it whenever their option list is
   * rebuilt. (They used to be independent DOM truth that the summary read from a stale
   * store field, so the summary could promise WAV 24-bit while the exporter produced
   * whatever the dropdown was left showing.)
   */
  function populateSampleRates(sourceRate) {
    const select = $('#srSelect');
    if (!select) return;
    const options = [
      el('option', { value: '0', text: `Preserve source rate (${sourceRate || '—'} Hz)` }),
    ];
    for (const rate of EXPORT_SAMPLE_RATES) {
      if (rate === 0) continue;
      const supported = probeOfflineSampleRate(rate);
      options.push(
        el('option', {
          value: String(rate),
          text: `${rate / 1000} kHz${supported ? '' : ' — unsupported in this browser'}`,
          disabled: !supported,
        }),
      );
    }
    replaceChildren(select, ...options);
    const preferred = String(store.getState().ui.exportSampleRate || select.value || '0');
    const wanted = [...select.options].find((o) => o.value === preferred);
    const chosen = wanted && !wanted.disabled ? preferred : '0';
    select.value = chosen;
    if ((Number(chosen) || 0) !== (store.getState().ui.exportSampleRate || 0)) {
      store.setUi({ exportSampleRate: Number(chosen) || 0 });
    }
  }

  const fmtSelect = $('#fmtSelect');
  if (fmtSelect) {
    const wantedFormat = store.getState().ui.exportFormat;
    if (wantedFormat && [...fmtSelect.options].some((o) => o.value === wantedFormat)) {
      fmtSelect.value = wantedFormat;
    }
    fmtSelect.addEventListener('change', (event) => {
      store.setUi({ exportFormat: event.target.value });
    });
  }
  $('#srSelect')?.addEventListener('change', (event) => {
    store.setUi({ exportSampleRate: Number(event.target.value) || 0 });
  });

  /* ---- export and immersive controllers ---- */
  const exportController = createExportController({ store, toast, announce });
  const immersiveController = createImmersiveController({
    store,
    toast,
    getLiveGraph: () => live,
    // One render lock for the whole app: the immersive workspace shares the export
    // controller's busy state, so a stereo/batch render and an immersive render can
    // never interleave, and the disabled-button set has a single owner.
    lock: (stage) => exportController.tryLock(stage),
    unlock: () => exportController.unlock(),
    applyMonitorGain,
    onLayoutChange: () => {
      if (store.getState().immersive.layout !== 'off') tabs.select('immersive');
    },
  });

  /* ---- about panel ---- */
  function renderAbout() {
    $('#engineBadge').textContent = `v${ENGINE_VERSION}`;
    $('#aboutEngine').textContent =
      `${ENGINE_NAME} ${ENGINE_VERSION} — ${PARAMETER_LIST.length} parameters, ` +
      `${ALL_PRESETS.length} presets in ${PRESET_GROUPS.length} groups. ` +
      `All processing is local to this browser tab; nothing is uploaded.`;

    const divergences = previewDivergences();
    replaceChildren(
      $('#divergenceList'),
      el('div', { class: 'notice info' }, [
        el('strong', { text: 'These parameters behave differently in the live monitor' }),
        el(
          'ul',
          {},
          divergences.map((d) => el('li', { text: `${d.label} — ${d.note}` })),
        ),
      ]),
    );

    const caps = probeCapabilities();
    const rates = Object.entries(caps.sampleRates)
      .map(([rate, ok]) => `${Number(rate) / 1000} kHz ${ok ? '✓' : '✕'}`)
      .join(' · ');
    replaceChildren(
      $('#capabilityList'),
      el('div', { class: 'notice info' }, [
        el('div', { text: `Web Audio: ${caps.audioContext ? '✓' : '✕'}` }),
        el('div', { text: `OfflineAudioContext: ${caps.offlineAudioContext ? '✓' : '✕'}` }),
        el('div', { text: `Web Workers (off-thread analysis): ${caps.webWorker ? '✓' : '✕'}` }),
        el('div', { text: `Offline sample rates: ${rates}` }),
        el('div', {
          text: `Decoder hints: ${caps.decoderHints
            .map((h) => `${h.label} ${h.support || 'no'}`)
            .join(' · ')}`,
        }),
      ]),
    );
  }

  /* ---- command palette + shortcuts ----
   * One keyboard map, one owner per key. Space, X, A/B/C, H (blind), M (loudness match),
   * S (side), L (workspace toggle), ⌘K, ⌘Z/⌘⇧Z, ⌘E.
   */
  const palette = initCommandPalette({
    getCommands: () => [
      { id: 'play', label: 'Play / pause', hint: 'Space', run: () => transport.toggle() },
      {
        id: 'ab',
        label: 'Cycle audition: original / mastered / loudness-matched',
        hint: 'X',
        run: () => abEnh.cycle(),
      },
      { id: 'ab-original', label: 'Audition: original', hint: 'A', run: () => abEnh.setAb('A') },
      { id: 'ab-mastered', label: 'Audition: mastered', hint: 'B', run: () => abEnh.setAb('B') },
      {
        id: 'ab-matched',
        label: 'Audition: loudness-matched master',
        hint: 'C',
        run: () => abEnh.setAb('C'),
      },
      {
        id: 'match',
        label: 'Level-match the A/B comparison',
        hint: 'M',
        run: () => abEnh.toggleMatch(),
      },
      {
        id: 'blind',
        label: 'Blind A/B mode',
        hint: 'H',
        run: () => abEnh.toggleBlind(),
      },
      {
        id: 'workspace',
        label: 'Toggle workspace: Master ⇄ Spatial Lab',
        hint: 'L',
        run: () => toggleWorkspace(),
      },
      { id: 'mono', label: 'Monitor: mono sum', run: () => setAudition('mono') },
      { id: 'side', label: 'Monitor: side only', hint: 'S', run: () => setAudition('side') },
      { id: 'stereo', label: 'Monitor: stereo', run: () => setAudition('stereo') },
      {
        id: 'export',
        label: 'Render & export master',
        hint: '⌘E',
        run: () => exportController.exportMaster(),
      },
      {
        id: 'report',
        label: 'Download last render report',
        run: () => exportController.downloadLastReport(),
      },
      { id: 'reset', label: 'Reset all parameters', run: () => $('#resetParamsBtn').click() },
      { id: 'seed', label: 'Randomise texture seed', run: () => $('#randomiseSeedBtn').click() },
      ...[
        'presets',
        'loudness',
        'dynamics',
        'tone',
        'match',
        'stereo',
        'spatial',
        'character',
        'export',
        'immersive',
        'batch',
        'about',
      ].map((tab) => ({ id: `tab-${tab}`, label: `Go to ${tab}`, run: () => tabs.select(tab) })),
      ...ALL_PRESETS.map((p) => ({
        id: `preset-${p.name}`,
        label: `Preset: ${p.name}`,
        hint: p.tag,
        run: () => applyCatalogPreset(p),
      })),
    ],
  });

  function setAudition(mode) {
    store.setUi({ audition: mode });
    const select = $('#auditionSelect');
    if (select) select.value = mode;
    announce(`Monitoring ${mode}`);
  }

  function toggleWorkspace() {
    workspace.set(store.getState().ui.workspace === 'spatial' ? 'master' : 'spatial');
  }

  $('#paletteBtn').addEventListener('click', () => palette.open());
  initShortcuts({
    palette: () => (palette.isOpen() ? palette.close() : palette.open()),
    playPause: () => transport.toggle(),
    toggleAb: () => abEnh.cycle(),
    auditionOriginal: () => abEnh.setAb('A'),
    auditionMastered: () => abEnh.setAb('B'),
    auditionMatched: () => abEnh.setAb('C'),
    toggleBlind: () => abEnh.toggleBlind(),
    toggleMatch: () => abEnh.toggleMatch(),
    sideAudition: () => setAudition(store.getState().ui.audition === 'side' ? 'stereo' : 'side'),
    toggleWorkspace,
    undo: () => {
      if (store.undo()) afterHistoryChange();
    },
    redo: () => {
      if (store.redo()) afterHistoryChange();
    },
    export: () => exportController.exportMaster(),
  });

  /* ---- store-driven UI sync ---- */
  // The ONE reaction point for listening-mode state: whatever changed abMode, the match
  // flag, the dim or the audition path (button, chip, select, keyboard, palette), the
  // graph push + meter repaint happen here and nowhere else. Duplicate per-listener
  // pushParameters calls used to race each other on every A/B click.
  let auditionSignature = null;
  const auditionSig = (state) =>
    `${state.ui.abMode}|${state.ui.matchLoudness ? 1 : 0}|${state.ui.audition}|${state.ui.abDim ? 1 : 0}`;
  auditionSignature = auditionSig(store.getState());
  store.subscribe((state, changed) => {
    if (changed.has('parameters') || changed.has('ui')) {
      $('#undoBtn').disabled = !store.canUndo();
      $('#redoBtn').disabled = !store.canRedo();
    }
    if (changed.has('ui')) signalFlow.sync();
    if (
      (changed.has('ui') || changed.has('immersive')) &&
      (auditionSig(state) !== auditionSignature || changed.has('immersive'))
    ) {
      auditionSignature = auditionSig(state);
      pushParameters();
      updateAnalysisUi();
      applyMonitorGain();
    }
  });

  /* ---- global error surface ---- */
  window.addEventListener('error', (event) => {
    console.error('[signal-rot]', event.error ?? event.message);
    toast(`Error: ${event.message || 'see the console'}`, { level: 'error' });
  });
  window.addEventListener('unhandledrejection', (event) => {
    console.error('[signal-rot] unhandled rejection:', event.reason);
    toast(`Error: ${event.reason?.message ?? 'see the console'}`, { level: 'error' });
    event.preventDefault();
  });

  /* ---- start ---- */
  renderAbout();
  presetPanel.sync();
  controls.sync();
  populateSampleRates(0);
  redrawCrossover();
  redrawMatch();
  updateAnalysisUi();
  immersiveController.init();
  exportController.init();
  tabs.select(store.getState().ui.tab || 'presets');
  rafHandle = requestAnimationFrame(frame);

  window.addEventListener('resize', () => {
    invalidateWaveformCache();
    redrawCrossover();
    redrawMatch();
  });

  // Pause the render loop when the tab is hidden — there is nothing to draw and a
  // background tab burning CPU on canvas work is antisocial.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(rafHandle);
      rafHandle = 0;
    } else if (!rafHandle) {
      lastFrame = performance.now();
      rafHandle = requestAnimationFrame(frame);
    }
  });

  return { store, transport, loadFile };
}
