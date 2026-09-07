/**
 * Immersive controller — layout selection, binaural monitoring, and immersive export.
 *
 * Every claim this panel makes is qualified in the UI copy; see
 * `docs/IMMERSIVE-AUDIO.md` for the long form. In short: these are synthesised channel
 * beds derived from a stereo master, the ADM is a `DirectSpeakers` interchange file, and
 * the binaural monitor is a fixed HRTF fold-down.
 */

import { createOfflineContext } from '../audio/context.js';
import {
  LAYOUTS,
  LAYOUT_IDS,
  SPEAKERS,
  wavChannelOrder,
  channelMapText,
  channelMapJson,
  lfeChannelIndices,
} from '../audio/immersive/layouts.js';
import { buildSpeakerFeeds } from '../audio/immersive/speaker-feeds.js';
import { buildBinauralFold } from '../audio/immersive/binaural.js';
import { writeAdmBwf } from '../audio/immersive/adm.js';
import { writeAdmBwfStreamed } from '../audio/immersive/adm-stream.js';
import { sonicLabChannelMapText, sonicLabChannelMapJson } from '../audio/immersive/sonic-lab.js';
import { writeWav, estimateWavBytes } from '../audio/encode/wav.js';
import { writeWavStreamed } from '../audio/encode/wav-stream.js';
import { downloadBlob, downloadJson, downloadText, baseNameOf } from '../audio/encode/download.js';
import { exportWithStreaming } from './streaming-export.js';
import { renderMaster } from '../audio/render/render-master.js';
import { fromAudioBuffer, createAudioData } from '../audio/dsp/audio-data.js';
import { limitTruePeak } from '../audio/render/limiter.js';
import { analyseLoudness, CHANNEL_WEIGHTS } from '../audio/analysis/loudness.js';
import { analysePeaks } from '../audio/analysis/true-peak.js';
import { ENGINE_VERSION } from './constants.js';
import { $, el, replaceChildren } from '../ui/dom.js';
import { renderNotice } from '../ui/notifications.js';

/** Immersive parameter descriptors — same pattern as the main schema, scoped locally. */
const IMMERSIVE_CONTROLS = [
  {
    key: 'centerExtract',
    label: 'Centre extraction',
    min: 0,
    max: 1,
    step: 0.01,
    fmt: (v) => `${Math.round(v * 100)} %`,
  },
  {
    key: 'surrLevelDb',
    label: 'Surround level',
    min: -24,
    max: 6,
    step: 0.5,
    fmt: (v) => `${v.toFixed(1)} dB`,
  },
  {
    key: 'surrDelayMs',
    label: 'Surround delay',
    min: 0,
    max: 40,
    step: 1,
    fmt: (v) => `${Math.round(v)} ms`,
  },
  {
    key: 'heightLevelDb',
    label: 'Height level',
    min: -30,
    max: 3,
    step: 0.5,
    fmt: (v) => `${v.toFixed(1)} dB`,
  },
  {
    key: 'heightDecorr',
    label: 'Height decorrelation',
    min: 0,
    max: 1,
    step: 0.01,
    fmt: (v) => `${Math.round(v * 100)} %`,
  },
  {
    key: 'lfeFreqHz',
    label: 'LFE / sub crossover',
    min: 40,
    max: 200,
    step: 5,
    fmt: (v) => `${Math.round(v)} Hz`,
  },
  {
    key: 'lfeLevelDb',
    label: 'LFE / sub level',
    min: -24,
    max: 10,
    step: 1,
    fmt: (v) => `${Math.round(v)} dB`,
  },
  {
    key: 'frontRear',
    label: 'Front ↔ surround balance',
    min: 0,
    max: 1,
    step: 0.01,
    fmt: (v) => (v < 0.45 ? 'front-weighted' : v > 0.55 ? 'surround-weighted' : 'balanced'),
  },
];

/**
 * @param {object} opts
 * @param {import('./state.js').Store} opts.store
 * @param {(msg:string, o?:object)=>void} opts.toast
 * @param {() => any} opts.getLiveGraph
 */
export function createImmersiveController(opts) {
  const { store, toast, getLiveGraph } = opts;
  /** @type {AudioNode[]|null} */
  let previewNodes = null;
  let busy = false;

  function teardownPreview() {
    const live = getLiveGraph();
    if (previewNodes) {
      for (const node of previewNodes) {
        try {
          node.disconnect();
        } catch {
          /* already gone */
        }
      }
      previewNodes = null;
    }
    if (live && live.monitor) live.monitor.gain.value = 1;
  }

  function buildPreview() {
    teardownPreview();
    const state = store.getState();
    const live = getLiveGraph();
    if (!live || !state.immersive.binauralPreview || state.immersive.layout === 'off') return;

    const tap = live.ctx.createGain();
    live.post.connect(tap);
    const { output, nodes } = buildBinauralFold(
      live.ctx,
      tap,
      state.immersive.layout,
      toUpmixParams(state.immersive),
    );
    output.connect(live.ctx.destination);
    previewNodes = [tap, ...nodes];
    live.monitor.gain.value = 0; // mute the direct stereo path
  }

  const toUpmixParams = (im) => ({
    centerExtract: im.centerExtract,
    surrLevelDb: im.surrLevelDb,
    surrDelayMs: im.surrDelayMs,
    heightLevelDb: im.heightLevelDb,
    heightDecorr: im.heightDecorr,
    lfeFreqHz: im.lfeFreqHz,
    lfeLevelDb: im.lfeLevelDb,
    frontRear: im.frontRear,
  });

  /* ────────────────────────────── export ─────────────────────────────────── */

  async function renderImmersive() {
    if (busy) return;
    const state = store.getState();
    const source = state.source.buffer;
    if (!source) return toast('Load a file first', { level: 'error' });
    const layoutId = state.immersive.layout;
    if (layoutId === 'off') return toast('Choose an output layout first', { level: 'error' });

    busy = true;
    const bar = $('#imProg');
    const text = $('#imProgText');
    bar?.classList.add('on');
    $('#imExportBtn').disabled = true;
    renderNotice($('#imNotice'), null);

    const setProgress = (fraction, stage) => {
      if (bar) bar.querySelector('i').style.width = `${Math.round(fraction * 100)}%`;
      if (text) text.textContent = stage;
    };

    try {
      const sampleRate = Number($('#srSelect')?.value) || 0;
      const bitDepth = ($('#fmtSelect')?.value ?? '').includes('32') ? 32 : 24;

      setProgress(0.05, 'rendering stereo master');
      const { data: stereo, report: stereoReport } = await renderMaster({
        source,
        parameters: store.getParameters(),
        sampleRate,
        bitDepth,
        moduleBypass: state.ui.moduleBypass,
        sourceName: state.source.name,
        presetName: state.ui.presetName,
        format: 'wav',
        onProgress: (stage, f) => setProgress(0.05 + f * 0.4, stage),
      });

      const sr = stereo.sampleRate;
      const length = stereo.length;
      const params = toUpmixParams(state.immersive);
      const target = state.immersive.target;

      setProgress(0.5, 'up-mixing');
      const stereoBuffer = toBuffer(stereo, sr);

      let name;
      let channelData;

      if (target === 'binaural') {
        const ctx = createOfflineContext(2, length, sr);
        const src = ctx.createBufferSource();
        src.buffer = stereoBuffer;
        const { output } = buildBinauralFold(ctx, src, layoutId, params);
        output.connect(ctx.destination);
        src.start(0);
        const rendered = await ctx.startRendering();
        channelData = fromAudioBuffer(rendered);
        setProgress(0.85, 'limiting');
        limitTruePeak(channelData, { ceilingDb: store.getParameters().ceiling });
        name = `${baseNameOf(state.source.name)}_${layoutLabel(layoutId)}_binaural.wav`;
        const outcome = await exportWithStreaming({
          filename: name,
          estimatedBytes: estimateWavBytes(channelData, bitDepth),
          onProgress: (fraction) => setProgress(0.9 + fraction * 0.1, 'writing file'),
          stream: (sink) => writeWavStreamed(channelData, { bitDepth }, sink),
          encodeBlob: () => writeWav(channelData, { bitDepth }),
        });
        if (outcome.mode === 'cancelled') {
          toast('Save cancelled — no file written.');
          return;
        }
      } else {
        const { order, mask } = wavChannelOrder(layoutId);
        const channelCount = order.length;
        const ctx = createOfflineContext(channelCount, length, sr);
        const src = ctx.createBufferSource();
        src.buffer = stereoBuffer;
        const { feeds } = buildSpeakerFeeds(ctx, src, layoutId, params);
        const merger = ctx.createChannelMerger(channelCount);
        order.forEach((key, index) => {
          if (feeds[key]) feeds[key].connect(merger, 0, index);
        });
        merger.connect(ctx.destination);
        src.start(0);
        const rendered = await ctx.startRendering();
        channelData = fromAudioBuffer(rendered);

        setProgress(0.82, 'limiting');
        // LFE / subwoofer channels are excluded from peak *detection* so a kick in the
        // sub does not duck the height channels — but they are still gained.
        limitTruePeak(channelData, {
          ceilingDb: store.getParameters().ceiling,
          lfeChannels: lfeChannelIndices(layoutId, order),
        });

        setProgress(0.9, 'writing file');
        const loudnessOpts = {
          layoutId,
          bitDepth: target === 'adm' ? 24 : bitDepth,
          order,
          lfeCrossoverHz: state.immersive.lfeFreqHz,
          programmeName: `${baseNameOf(state.source.name)} — ${LAYOUTS[layoutId].name}`,
        };
        if (target === 'adm') {
          const weights = order.map((k) => CHANNEL_WEIGHTS[k] ?? (SPEAKERS[k]?.lfe ? 0 : 1));
          const loudness = analyseLoudness(channelData, { weights });
          const peaks = analysePeaks(channelData);
          const admOpts = {
            ...loudnessOpts,
            bitDepth: 24,
            loudness: {
              integrated: loudness.integrated,
              range: loudness.lra,
              truePeak: peaks.truePeakDb,
              maxMomentary: loudness.maxMomentary,
              maxShortTerm: loudness.maxShortTerm,
            },
          };
          name = `${baseNameOf(state.source.name)}_${layoutLabel(layoutId)}_ADM.wav`;
          const outcome = await exportWithStreaming({
            filename: name,
            estimatedBytes: estimateWavBytes(channelData, 24) + 4096,
            onProgress: (fraction) => setProgress(0.9 + fraction * 0.1, 'writing file'),
            stream: (sink) =>
              writeAdmBwfStreamed(
                channelData,
                {
                  ...admOpts,
                  onProgress: (fraction) => setProgress(0.9 + fraction * 0.1, 'writing file'),
                },
                sink,
              ),
            encodeBlob: () => writeAdmBwf(channelData, admOpts),
          });
          if (outcome.mode === 'cancelled') {
            toast('Save cancelled — no file written.');
            return;
          }
        } else {
          name = `${baseNameOf(state.source.name)}_${layoutLabel(layoutId)}.wav`;
          const outcome = await exportWithStreaming({
            filename: name,
            estimatedBytes: estimateWavBytes(channelData, bitDepth),
            onProgress: (fraction) => setProgress(0.9 + fraction * 0.1, 'writing file'),
            stream: (sink) =>
              writeWavStreamed(
                channelData,
                { bitDepth, channelMask: mask, forceExtensible: true },
                sink,
              ),
            encodeBlob: () =>
              writeWav(channelData, { bitDepth, channelMask: mask, forceExtensible: true }),
          });
          if (outcome.mode === 'cancelled') {
            toast('Save cancelled — no file written.');
            return;
          }
        }
      }

      setProgress(1, 'saving');

      const messages = [
        `${LAYOUTS[layoutId].name} · ${channelData.channels.length} channels · ${sr / 1000} kHz.`,
        'Height and surround content is synthesised from the stereo side signal — it is not ' +
          'recovered information.',
      ];
      if (target === 'adm') {
        messages.push(
          'This is a DirectSpeakers channel bed with BS.2076 metadata. It is not object-based ' +
            'authoring and it is not a certified Dolby Atmos master.',
        );
      }
      if (!LAYOUTS[layoutId].standardMask) {
        messages.push(
          'This layout has no standard WAVEFORMATEXTENSIBLE mask; deliver the channel map ' +
            'alongside the audio (buttons above).',
        );
      }
      if (stereoReport.warnings.length) messages.push(...stereoReport.warnings);

      renderNotice($('#imNotice'), { level: 'info', title: 'Immersive render complete', messages });
      toast(`Rendered ${LAYOUTS[layoutId].name}`);
    } catch (error) {
      console.error('[signal-rot] immersive render failed:', error);
      renderNotice($('#imNotice'), {
        level: 'danger',
        title: 'Immersive render failed',
        messages: [String(error.message ?? error)],
      });
      toast(`Immersive render failed: ${error.message ?? error}`, { level: 'error' });
    } finally {
      busy = false;
      $('#imExportBtn').disabled = false;
      setTimeout(() => {
        bar?.classList.remove('on');
        if (text) text.textContent = '';
      }, 800);
    }
    return undefined;
  }

  function toBuffer(data, sampleRate) {
    const ctx = createOfflineContext(data.channels.length, data.length, sampleRate);
    const buffer = ctx.createBuffer(data.channels.length, data.length, sampleRate);
    for (let c = 0; c < data.channels.length; c++) buffer.copyToChannel(data.channels[c], c);
    return buffer;
  }

  const layoutLabel = (id) => (id === 'soniclab' ? 'SonicLab20.4' : id);

  /* ── Channel identification export ──────────────────────────────────────────────
   * A short file that plays a distinct tone burst through each channel in turn, with a
   * silent gap between. Patch the file, press play, and you know within thirty seconds
   * whether channel 17 is where you think it is. Pitch rises with channel number and the
   * burst count encodes the channel index in binary-ish groups, so it is identifiable
   * even without watching a meter.
   */
  async function exportChannelIdentification() {
    const state = store.getState();
    const layoutId = state.immersive.layout;
    if (layoutId === 'off') return toast('Choose a layout first', { level: 'error' });
    const { order } = wavChannelOrder(layoutId);
    const sr = 48000;
    const perChannel = 1.6;
    const gap = 0.4;
    const total = Math.ceil(order.length * (perChannel + gap) * sr);
    const data = createAudioData(order.length, total, sr);

    order.forEach((key, index) => {
      const sp = SPEAKERS[key];
      const start = Math.floor(index * (perChannel + gap) * sr);
      const channel = data.channels[index];
      // Sub channels get a low tone; everything else rises across the layout.
      const freq = sp.lfe ? 55 : 440 * Math.pow(2, (index % 12) / 12);
      const bursts = sp.lfe ? 1 : 1 + (index % 4);
      const burstLen = Math.floor((perChannel / (bursts * 2)) * sr);
      for (let b = 0; b < bursts; b++) {
        const from = start + b * burstLen * 2;
        for (let i = 0; i < burstLen; i++) {
          // 10 ms raised-cosine edges so the bursts do not click.
          const edge = Math.floor(0.01 * sr);
          let env = 1;
          if (i < edge) env = 0.5 - 0.5 * Math.cos((Math.PI * i) / edge);
          else if (i > burstLen - edge) {
            env = 0.5 - 0.5 * Math.cos((Math.PI * (burstLen - i)) / edge);
          }
          const idx = from + i;
          if (idx < total) channel[idx] = 0.25 * env * Math.sin((2 * Math.PI * freq * i) / sr);
        }
      }
    });

    const { mask } = wavChannelOrder(layoutId);
    const blob = writeWav(data, { bitDepth: 24, channelMask: mask, forceExtensible: true });
    downloadBlob(blob, `signal-rot_${layoutLabel(layoutId)}_channel-identification.wav`);
    toast(`Channel identification file — ${order.length} channels, ${(total / sr).toFixed(0)} s`);
    return undefined;
  }

  /* ────────────────────────────── UI ─────────────────────────────────────── */

  function renderControls() {
    const host = $('#imControls');
    if (!host) return;
    const im = store.getState().immersive;
    const nodes = IMMERSIVE_CONTROLS.map((spec) => {
      const id = `im-${spec.key}`;
      const readout = el('span', { class: 'num', text: spec.fmt(im[spec.key]) });
      const input = el('input', {
        type: 'range',
        id,
        min: String(spec.min),
        max: String(spec.max),
        step: String(spec.step),
        value: String(im[spec.key]),
        oninput: (event) => {
          const value = Number(event.target.value);
          store.setImmersive({ [spec.key]: value });
          readout.textContent = spec.fmt(value);
          input.setAttribute('aria-valuetext', spec.fmt(value));
          if (store.getState().immersive.binauralPreview) buildPreview();
        },
      });
      input.setAttribute('aria-valuetext', spec.fmt(im[spec.key]));
      return el('div', { class: 'ctl' }, [
        el('div', { class: 'row' }, [el('label', { for: id, text: spec.label }), readout]),
        input,
      ]);
    });
    replaceChildren(host, ...nodes);
  }

  function populateLayouts() {
    const select = $('#imLayout');
    if (!select) return;
    const options = [el('option', { value: 'off', text: 'Stereo (immersive off)' })];
    for (const id of LAYOUT_IDS) {
      const layout = LAYOUTS[id];
      options.push(
        el('option', {
          value: id,
          text: `${layout.name} — ${layout.channels.length} ch`,
        }),
      );
    }
    replaceChildren(select, ...options);
    select.value = store.getState().immersive.layout;
  }

  function init() {
    populateLayouts();
    renderControls();

    $('#imLayout')?.addEventListener('change', (event) => {
      store.setImmersive({ layout: event.target.value });
      if (event.target.value === 'off') {
        store.setImmersive({ binauralPreview: false });
        $('#imPrevBtn')?.setAttribute('aria-checked', 'false');
        teardownPreview();
      } else if (store.getState().immersive.binauralPreview) {
        buildPreview();
      }
      showLayoutNotice();
    });

    $('#imTarget')?.addEventListener('change', (event) => {
      store.setImmersive({ target: event.target.value });
      showLayoutNotice();
    });

    $('#imPrevBtn')?.addEventListener('click', () => {
      const state = store.getState();
      if (state.immersive.layout === 'off') {
        return toast('Choose a layout first', { level: 'error' });
      }
      const next = !state.immersive.binauralPreview;
      store.setImmersive({ binauralPreview: next });
      $('#imPrevBtn').setAttribute('aria-checked', String(next));
      buildPreview();
      toast(next ? 'Binaural monitor on — fixed HRTF, not head-tracked' : 'Stereo monitor');
      return undefined;
    });

    $('#imExportBtn')?.addEventListener('click', () => renderImmersive());
    $('#imIdentBtn')?.addEventListener('click', () => exportChannelIdentification());

    $('#imMapTxtBtn')?.addEventListener('click', () => {
      const state = store.getState();
      const layoutId = state.immersive.layout;
      if (layoutId === 'off') return toast('Choose a layout first', { level: 'error' });
      const meta = {
        sourceName: state.source.name,
        sampleRate: state.source.sampleRate,
        engineVersion: ENGINE_VERSION,
      };
      const text =
        layoutId === 'soniclab' ? sonicLabChannelMapText(meta) : channelMapText(layoutId, meta);
      downloadText(text, `signal-rot_${layoutLabel(layoutId)}_channel-map.txt`);
      return undefined;
    });

    $('#imMapJsonBtn')?.addEventListener('click', () => {
      const state = store.getState();
      const layoutId = state.immersive.layout;
      if (layoutId === 'off') return toast('Choose a layout first', { level: 'error' });
      const meta = {
        sourceName: state.source.name,
        sampleRate: state.source.sampleRate,
        engineVersion: ENGINE_VERSION,
      };
      const json =
        layoutId === 'soniclab' ? sonicLabChannelMapJson(meta) : channelMapJson(layoutId, meta);
      downloadJson(json, `signal-rot_${layoutLabel(layoutId)}_channel-map.json`);
      return undefined;
    });

    showLayoutNotice();
  }

  function showLayoutNotice() {
    const state = store.getState();
    const layoutId = state.immersive.layout;
    if (layoutId === 'off') return renderNotice($('#imNotice'), null);
    const layout = LAYOUTS[layoutId];
    const messages = [layout.notes];
    if (state.immersive.target === 'adm') {
      messages.push(
        'ADM BWF is an interchange format. Atmos, 360 Reality Audio and MPEG-H authoring tools ' +
          'can ingest a BS.2076 bed, but the licensed final encode happens in those tools, ' +
          'not in a browser.',
      );
    }
    if (state.immersive.target === 'binaural') {
      messages.push(
        'The fold-down uses the browser\u2019s generic HRTF set. It is fixed, not head-tracked, ' +
          'and it will sound different in Chromium and Safari.',
      );
    }
    renderNotice($('#imNotice'), { level: 'info', title: layout.name, messages });
    return undefined;
  }

  return { init, teardownPreview, renderImmersive, exportChannelIdentification };
}
