/**
 * Export and batch controller.
 *
 * Owns every path from "finished audio" to "file on disk": format selection,
 * encoding, the render report, the render-history panel and the batch queue.
 *
 * ── Render-state locking ─────────────────────────────────────────────────────
 * A render mutates a large buffer and takes seconds. While one is running every
 * control that could change the result is disabled, and the progress text says
 * which stage is running rather than showing a bar that jumps from 45 % to
 * 75 %.
 *
 * ── Batch queue ──────────────────────────────────────────────────────────────
 * The queue is a *workflow*, not a list of filenames. Every item carries its own
 * state (decoding → ready → rendering → done / failed / cancelled), its own
 * failure reason, its own loudness, its own render report and its own output
 * name. Files are processed **sequentially** — the render graph is full-buffer
 * by design, so two concurrent renders would double the peak memory with zero
 * speed benefit. Cancellation stops the *next* file (a running offline render
 * cannot be interrupted); it never stops the current one halfway, so a partial
 * file is never written.
 *
 * A bad file in the queue fails *that row* with a reason the user can act on
 * (and retry); it never aborts the rest of the batch, and it never lets a stale
 * result attach to a different file — each render consumes the exact
 * `AudioBuffer` the item decoded, and each report is stored on that item.
 */

import { renderMaster } from '../audio/render/render-master.js';
import { writeWav, estimateWavBytes } from '../audio/encode/wav.js';
import { writeWavStreamed } from '../audio/encode/wav-stream.js';
import { writeAiff } from '../audio/encode/aiff.js';
import { encodeMp3 } from '../audio/encode/mp3.js';
import { downloadBlob, downloadJson, baseNameOf } from '../audio/encode/download.js';
import { supportsStreamingSave } from '../audio/encode/stream-sinks.js';
import { exportWithStreaming } from './streaming-export.js';
import { summariseReport } from '../audio/render/report.js';
import { analyseBuffer } from '../workers/analysis-client.js';
import { resumeAudioContext } from '../audio/context.js';
import { estimateRender } from '../runtime/render-preflight.js';
import { formatBytes } from '../runtime/memory-budget.js';
import { decodeAudioFile, preflightFile, buildMasterName, uniqueName } from './import-audio.js';
import { LIMITS } from './constants.js';
import { $, $$, el, replaceChildren, formatBytes as uiFormatBytes } from '../ui/dom.js';
import { renderNotice } from '../ui/notifications.js';

/** Format descriptors: container, bit depth and file extension. */
export const EXPORT_FORMATS = Object.freeze({
  wav16: { container: 'wav', bitDepth: 16, ext: 'wav', label: 'WAV 16-bit' },
  wav24: { container: 'wav', bitDepth: 24, ext: 'wav', label: 'WAV 24-bit' },
  wav32: { container: 'wav', bitDepth: 32, ext: 'wav', label: 'WAV 32-bit float' },
  aif16: { container: 'aiff', bitDepth: 16, ext: 'aif', label: 'AIFF 16-bit' },
  aif24: { container: 'aiff', bitDepth: 24, ext: 'aif', label: 'AIFF 24-bit' },
  mp3: { container: 'mp3', bitDepth: 16, ext: 'mp3', label: 'MP3 320 kbit/s' },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} opts
 * @param {import('./state.js').Store} opts.store
 * @param {(msg:string, o?:object)=>void} opts.toast
 * @param {(msg:string)=>void} opts.announce
 */
export function createExportController(opts) {
  const { store, toast, announce } = opts;
  /** @type {{report:object, at:Date, name:string}[]} */
  const history = [];
  let lastReport = null;
  let busy = false;

  const setBusy = (state, stage = '') => {
    busy = state;
    store.setUi({ rendering: state });
    for (const node of $$('#exportBtn, .expbtn, #batchRunBtn, #imExportBtn')) {
      node.disabled = state;
    }
    const progText = $('#exportProgText');
    if (progText) progText.textContent = stage;
  };

  const progress = (fraction, stage) => {
    const bar = $('#exportProg');
    if (bar) {
      bar.classList.add('on');
      bar.querySelector('i').style.width = `${Math.round(fraction * 100)}%`;
    }
    const text = $('#exportProgText');
    if (text) text.textContent = stage ? `${stage}…` : '';
  };

  const clearProgress = () => {
    setTimeout(() => {
      $('#exportProg')?.classList.remove('on');
      const text = $('#exportProgText');
      if (text) text.textContent = '';
    }, 700);
  };

  /**
   * Encode finished audio into the requested container.
   * @param {import('../audio/dsp/audio-data.js').AudioData} data
   * @param {string} formatKey
   */
  async function encode(data, formatKey) {
    const format = EXPORT_FORMATS[formatKey] ?? EXPORT_FORMATS.wav24;
    switch (format.container) {
      case 'aiff':
        return { blob: writeAiff(data, { bitDepth: format.bitDepth }), format };
      case 'mp3':
        return { blob: await encodeMp3(data), format };
      case 'wav':
      default:
        return { blob: writeWav(data, { bitDepth: format.bitDepth }), format };
    }
  }

  function renderHistoryPanel() {
    const host = $('#renderHistory');
    if (!host) return;
    if (!history.length) {
      replaceChildren(host, el('div', { class: 'hint', text: 'No renders yet in this session.' }));
      return;
    }
    replaceChildren(
      host,
      ...history
        .slice()
        .reverse()
        .map((entry) =>
          el('div', { class: `rh${entry.report.limiter.ceilingRespected ? '' : ' over'}` }, [
            el('span', { class: 'when', text: entry.at.toLocaleTimeString() }),
            el('span', { class: 'sum', text: `${entry.name} — ${summariseReport(entry.report)}` }),
            el('button', {
              class: 'btn ghost',
              style: 'padding:2px 8px',
              text: '⤓ report',
              'aria-label': `Download render report for ${entry.name}`,
              onclick: () =>
                downloadJson(entry.report, `${baseNameOf(entry.name)}_render-report.json`),
            }),
          ]),
        ),
    );
  }

  /**
   * Honest memory preflight for a full-buffer render. The DSP graph is not
   * streaming, so this estimate is the real budget — when it says a render
   * will not fit, it will not fit.
   *
   * @param {AudioBuffer} source
   * @param {number} sampleRate 0 = source rate
   * @returns {{classification:string, expectedPeakBytes:number, effectiveRate:number}}
   */
  function renderPreflight(source, sampleRate) {
    const effectiveRate = sampleRate || source.sampleRate;
    const frames = Math.ceil(source.duration * effectiveRate);
    const plan = estimateRender(
      { channels: source.numberOfChannels, frames },
      { dsp: 1, output: 1 },
    );
    return {
      classification: plan.classification,
      expectedPeakBytes: plan.expectedPeakBytes,
      effectiveRate,
    };
  }

  /**
   * Full export of the loaded source.
   * @param {object} [override] `{formatKey, sampleRate}`
   */
  async function exportMaster(override = {}) {
    if (busy) return;
    const state = store.getState();
    const source = state.source.buffer;
    if (!source) {
      toast('Load a file first', { level: 'error' });
      return;
    }

    const formatKey = override.formatKey ?? $('#fmtSelect').value;
    const sampleRate = Number(override.sampleRate ?? $('#srSelect').value) || 0;
    const format = EXPORT_FORMATS[formatKey] ?? EXPORT_FORMATS.wav24;
    const parameters = store.getParameters();

    // Pre-flight size check: better to say "this may not fit" than to allocate
    // 3 GB and take the tab down.
    const preflight = renderPreflight(source, sampleRate);
    const estimatedSamples =
      Math.ceil(source.duration * preflight.effectiveRate) * source.numberOfChannels;
    if (
      estimatedSamples > LIMITS.WARN_TOTAL_SAMPLES ||
      preflight.classification === 'LIKELY UNSAFE'
    ) {
      toast(
        `${source.numberOfChannels}-channel / ${(preflight.effectiveRate / 1000).toFixed(1)} kHz render ` +
          `needs about ${uiFormatBytes(preflight.expectedPeakBytes)} of float audio and may exceed ` +
          'the memory available to this browser. A lower sample rate, fewer channels or a bigger ' +
          'machine will make it fit.',
        { level: 'error', durationMs: 9000 },
      );
    } else if (preflight.classification === 'VERY HEAVY' || preflight.classification === 'HEAVY') {
      toast(
        `Heavy render (${preflight.classification.toLowerCase()}): about ` +
          `${uiFormatBytes(preflight.expectedPeakBytes)} of float audio. It will be slow.`,
        { durationMs: 7000 },
      );
    }

    setBusy(true, 'starting');
    renderNotice($('#exportNotice'), null);
    // Honesty guard: sliders are NOT locked while a render runs (the engineer should be
    // able to set up the next pass), but `parameters` above is a snapshot. If something
    // moves mid-render, say so — one time — instead of letting the next toast imply the
    // finished file matches the screen.
    let snapshotWarned = false;
    const offSnapshotWatch = store.subscribe((_s, changed) => {
      if (snapshotWarned || !changed.has('parameters')) return;
      snapshotWarned = true;
      toast(
        'Parameters changed mid-render — this export uses the settings captured when it started. Re-render to apply.',
        { level: 'error' },
      );
      offSnapshotWatch();
    });
    try {
      const { data, report } = await renderMaster({
        source,
        parameters,
        sampleRate,
        bitDepth: format.bitDepth,
        moduleBypass: state.ui.moduleBypass,
        sourceName: state.source.name,
        presetName: state.ui.presetName,
        format: format.container,
        onProgress: (stage, fraction) => progress(fraction * 0.85, stage),
      });

      progress(0.9, 'encoding');
      const name = uniqueName(
        buildMasterName({ base: state.source.name, sampleRate: data.sampleRate, format }),
        outputNames,
      );

      if (format.container === 'wav') {
        const bytes = estimateWavBytes(data, format.bitDepth);
        // The streaming-to-disk path promotes to RF64/BW64 automatically, so the hard
        // 4 GiB RIFF ceiling only applies when it is not available.
        if (bytes > LIMITS.RIFF_MAX_BYTES && !supportsStreamingSave()) {
          throw new Error(
            `The encoded file would be ${uiFormatBytes(bytes)}, above the 4 GB RIFF limit, ` +
              'and this browser cannot stream straight to disk (needs the File System ' +
              'Access API — Chromium-based browsers have it). Use a lower sample rate or ' +
              'bit depth, or try a Chromium-based browser.',
          );
        }
        const outcome = await exportWithStreaming({
          filename: name,
          estimatedBytes: bytes,
          onProgress: (fraction, stage) => progress(0.9 + fraction * 0.1, stage),
          stream: (sink) =>
            writeWavStreamed(
              data,
              { bitDepth: format.bitDepth, onProgress: (f, s) => progress(0.9 + f * 0.08, s) },
              sink,
            ),
          encodeBlob: () => writeWav(data, { bitDepth: format.bitDepth }),
        });
        if (outcome.mode === 'cancelled') {
          toast('Save cancelled — no file written.');
          return;
        }
      } else {
        const { blob } = await encode(data, formatKey);

        progress(1, 'saving');
        const result = downloadBlob(blob, name);
        if (!result.ok) throw result.error ?? new Error('Download failed');
      }

      lastReport = report;
      history.push({ report, at: new Date(), name });
      if (history.length > 20) history.shift();
      renderHistoryPanel();

      renderNotice($('#exportNotice'), {
        level: report.warnings.length ? 'caution' : 'ok',
        title: `${format.label} · ${summariseReport(report)}`,
        messages: report.warnings.length
          ? report.warnings
          : ['Ceiling respected, target loudness reached. Render report available above.'],
      });
      toast(`Exported ${format.label} · ${summariseReport(report)}`);
      announce(`Export complete: ${summariseReport(report)}`);
    } catch (error) {
      console.error('[signal-rot] export failed:', error);
      renderNotice($('#exportNotice'), {
        level: 'danger',
        title: 'Export failed',
        messages: [String(error.message ?? error)],
      });
      toast(`Export failed: ${error.message ?? error}`, { level: 'error' });
    } finally {
      offSnapshotWatch();
      setBusy(false);
      clearProgress();
    }
  }

  /* ────────────────────────────── batch queue ────────────────────────────── */

  /**
   * @typedef {object} QueueItem
   * @property {number} id
   * @property {File} file
   * @property {string} name
   * @property {AudioBuffer|null} buffer
   * @property {'decoding'|'ready'|'rendering'|'done'|'failed'|'cancelled'} state
   * @property {string} reason  failure explanation, empty otherwise
   * @property {number|null} lufs
   * @property {object|null} report  render report, when done
   * @property {string|null} outputName  delivered filename, when done
   */

  /** @type {QueueItem[]} */
  const queue = [];
  /** Session registry of delivered output names (collision → `…_2.wav`). */
  const outputNames = new Set();
  let nextItemId = 1;
  let runState = { active: false, cancelled: false };

  function setItemState(item, state, reason = '') {
    item.state = state;
    item.reason = state === 'failed' ? reason : '';
    renderQueue();
  }

  function renderQueue() {
    const host = $('#batchList');
    if (!host) return;
    if (!queue.length) {
      replaceChildren(host, el('div', { class: 'hint', text: 'No files in the queue yet.' }));
    } else {
      replaceChildren(
        host,
        ...queue.map((item) => {
          const statusLabel = {
            decoding: 'decoding…',
            ready: 'ready',
            rendering: 'rendering…',
            done: `done → ${item.outputName ?? ''}`,
            failed: `failed: ${item.reason || 'unknown error'}`,
            cancelled: item.reason || 'cancelled',
          }[item.state];
          const row = el('div', { class: `brow st-${item.state}` }, [
            el('span', { class: 'nm', text: item.name, title: item.name }),
            el('span', { class: 'st', text: statusLabel, title: statusLabel }),
            el('span', {
              class: 'lu',
              text:
                item.state === 'done' && item.lufs !== null
                  ? `${item.lufs.toFixed(1)} LUFS`
                  : item.lufs === null
                    ? item.buffer
                      ? 'analysing…'
                      : '—'
                    : `${item.lufs.toFixed(1)} LUFS`,
            }),
          ]);
          if (item.state === 'done' && item.report) {
            row.append(
              el('button', {
                class: 'btn ghost',
                style: 'padding:2px 8px',
                text: '⤓ report',
                'aria-label': `Download render report for ${item.name}`,
                onclick: () =>
                  downloadJson(item.report, `${baseNameOf(item.name)}_render-report.json`),
              }),
            );
          }
          if (item.state === 'failed' && !runState.active) {
            row.append(
              el('button', {
                class: 'btn ghost',
                style: 'padding:2px 8px',
                text: '↻ retry',
                'aria-label': `Retry ${item.name}`,
                onclick: () => retryItem(item),
              }),
            );
          }
          if (!runState.active) {
            row.append(
              el('button', {
                class: 'btn ghost',
                style: 'padding:2px 8px',
                text: '✕',
                'aria-label': `Remove ${item.name}`,
                onclick: () => {
                  const i = queue.indexOf(item);
                  if (i >= 0) queue.splice(i, 1);
                  renderQueue();
                },
              }),
            );
          }
          return row;
        }),
      );
    }
    const runBtn = $('#batchRunBtn');
    if (runBtn) runBtn.disabled = runState.active || !queue.some((i) => i.state === 'ready');
  }

  /**
   * Decode one file for the queue. Shared by add-files and retry.
   * @param {QueueItem} item
   */
  async function decodeItem(item) {
    const pf = preflightFile(item.file);
    if (pf.errors.length) {
      setItemState(item, 'failed', pf.errors[0]);
      return;
    }
    setItemState(item, 'decoding');
    let ctx;
    try {
      ctx = await resumeAudioContext();
    } catch (error) {
      setItemState(item, 'failed', String(error?.message ?? error));
      return;
    }
    const result = await decodeAudioFile(ctx, item.file);
    if (!result.ok) {
      setItemState(item, 'failed', result.errors[0] ?? 'could not decode');
      return;
    }
    item.buffer = result.buffer;
    for (const message of result.warnings) console.info(`[signal-rot] ${item.name}: ${message}`);
    setItemState(item, 'ready');
    // Loudness runs off-thread; a late result must not resurface on a removed item.
    void analyseBuffer(item.buffer, ['loudness'])
      .then((stats) => {
        if (queue.includes(item) && item.buffer) {
          item.lufs = stats.loudness?.integrated ?? null;
          renderQueue();
        }
      })
      .catch(() => {});
  }

  /**
   * Add files to the batch queue (decode up front so the user sees the real
   * per-file state before the run button is pressed).
   *
   * @param {File[]} files
   * @returns {Promise<number>} how many joined the queue in a ready state
   */
  async function enqueueFiles(files) {
    if (runState.active) {
      toast('A batch is already running — stop it before adding more files.', { level: 'error' });
      return 0;
    }
    let added = 0;
    for (const file of files) {
      const item = {
        id: nextItemId++,
        file,
        name: file.name,
        buffer: null,
        state: 'decoding',
        reason: '',
        lufs: null,
        report: null,
        outputName: null,
      };
      queue.push(item);
      await decodeItem(item);
      if (item.state === 'ready') added += 1;
    }
    renderQueue();
    return added;
  }

  /** Render one item with the settings captured at run time. */
  async function renderItem(item, settings) {
    const { format, formatKey, sampleRate, parameters, moduleBypass, presetName } = settings;
    const source = item.buffer;

    // Memory preflight, item by item: a queue of ten 192 kHz files must not
    // take the tab down at number four.
    const preflight = renderPreflight(source, sampleRate);
    if (preflight.classification === 'LIKELY UNSAFE') {
      throw new Error(
        `${source.numberOfChannels}-channel / ${(preflight.effectiveRate / 1000).toFixed(1)} kHz render ` +
          `would need about ${formatBytes(preflight.expectedPeakBytes)} of float audio — likely to ` +
          'exceed the memory available in this browser. Re-queue it at a lower sample rate or ' +
          'channel count.',
      );
    }
    if (preflight.classification === 'VERY HEAVY') {
      toast(
        `Heavy: ${item.name} needs about ${formatBytes(preflight.expectedPeakBytes)} of float audio. ` +
          'Continuing, but expect slowdowns.',
        { durationMs: 6000 },
      );
    }

    const { data, report } = await renderMaster({
      source,
      parameters,
      sampleRate,
      bitDepth: format.bitDepth,
      moduleBypass,
      sourceName: item.name,
      presetName,
      format: format.container,
      // Batch trades the last 0.2 LU of accuracy for speed; single exports refine.
      refine: false,
    });

    const { blob } = await encode(data, formatKey);
    const name = uniqueName(
      buildMasterName({ base: item.name, sampleRate: data.sampleRate, format }),
      outputNames,
    );
    const result = downloadBlob(blob, name);
    if (!result.ok) {
      throw result.error ?? new Error('The browser blocked or cancelled the download.');
    }
    item.report = report;
    item.outputName = name;
  }

  function batchSettings() {
    const state = store.getState();
    const formatKey = $('#fmtSelect').value;
    const sampleRate = Number($('#srSelect').value) || 0;
    return {
      formatKey,
      format: EXPORT_FORMATS[formatKey] ?? EXPORT_FORMATS.wav24,
      sampleRate,
      parameters: store.getParameters(),
      moduleBypass: state.ui.moduleBypass,
      presetName: state.ui.presetName,
    };
  }

  /**
   * Process the queue: sequential, conservative, per-file status.
   * `settings` is captured once — the batch is rendered with the settings that
   * were visible when the user pressed the button.
   */
  async function runBatch(overrideSettings) {
    if (runState.active) return;
    if (busy) {
      // Same lock as the stereo export and the immersive bed render: two offline
      // renders racing over the shared selects and the busy flag is never acceptable.
      toast('Another render is in progress — wait for it to finish.', { level: 'error' });
      return;
    }
    const pending = queue.filter((i) => i.state === 'ready' && i.buffer);
    if (!pending.length) {
      toast('Nothing in the queue is ready to render — check the failed rows for reasons.', {
        level: 'error',
      });
      return;
    }
    const settings = overrideSettings ?? batchSettings();
    runState = { active: true, cancelled: false };
    setBusy(true, 'batch');
    const cancelBtn = $('#batchCancelBtn');
    if (cancelBtn) cancelBtn.hidden = false;
    const bar = $('#batchProg');
    const text = $('#batchProgText');
    if (bar) bar.classList.add('on');

    const total = pending.length;
    let doneCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (const item of pending) {
      if (runState.cancelled) {
        setItemState(item, 'cancelled', 'skipped — batch stopped');
        skippedCount += 1;
        continue;
      }
      setItemState(item, 'rendering');
      if (text) text.textContent = `${queue.indexOf(item) + 1} of ${total} — ${item.name}`;
      if (bar) {
        bar.querySelector('i').style.width = `${((doneCount + skippedCount) / total) * 100}%`;
      }
      try {
        await renderItem(item, settings);
        setItemState(item, 'done');
        history.push({ report: item.report, at: new Date(), name: item.outputName });
        doneCount += 1;
        // A short pause: browsers rate-limit consecutive programmatic downloads.
        await sleep(450);
      } catch (error) {
        console.error('[signal-rot] batch item failed:', item.name, error);
        setItemState(item, 'failed', String(error?.message ?? error));
        failedCount += 1;
      }
    }

    if (bar) bar.querySelector('i').style.width = '100%';
    const summary = `Batch complete — ${doneCount} exported${
      failedCount ? `, ${failedCount} failed` : ''
    }${skippedCount ? `, ${skippedCount} skipped` : ''} of ${total}.`;
    if (text) text.textContent = summary;
    if (history.length > 40) history.splice(0, history.length - 40);
    renderHistoryPanel();
    runState = { active: false, cancelled: false };
    if (cancelBtn) cancelBtn.hidden = true;
    setBusy(false);
    renderQueue();
    toast(summary, failedCount ? { level: 'error', durationMs: 9000 } : undefined);
    announce(summary);
    setTimeout(() => bar?.classList.remove('on'), 1200);
  }

  /** Stop after the current file finishes; the rest of the queue is skipped. */
  function cancelBatch() {
    if (!runState.active) return;
    runState.cancelled = true;
    toast('Batch stopping — the current file will finish, the rest are skipped.');
  }

  /** Re-process one failed item (re-decode first when the decode was the problem). */
  async function retryItem(item) {
    if (busy) {
      toast('An export is in progress — wait for it to finish first.', { level: 'error' });
      return;
    }
    if (runState.active) {
      toast('A batch is running — wait for it or stop it first.', { level: 'error' });
      return;
    }
    if (!item.buffer) {
      await decodeItem(item);
      if (item.state !== 'ready') return; // re-decode failed again; row shows the reason
    }
    const settings = batchSettings();
    setItemState(item, 'rendering');
    try {
      await renderItem(item, settings);
      setItemState(item, 'done');
      history.push({ report: item.report, at: new Date(), name: item.outputName });
      renderHistoryPanel();
      toast(`Exported ${item.outputName}`);
    } catch (error) {
      setItemState(item, 'failed', String(error?.message ?? error));
      toast(`Retry failed for ${item.name}: ${error?.message ?? error}`, { level: 'error' });
    }
  }

  function init() {
    $('#exportBtn')?.addEventListener('click', () => exportMaster());
    for (const button of $$('.expbtn')) {
      button.addEventListener('click', () => {
        // Route quick-export through the selects so the store, the dropdowns and the
        // export all move together. Assigning `.value` alone does not fire `change`,
        // which used to leave the summary describing one format while the button
        // exported another.
        const fmt = $('#fmtSelect');
        const sr = $('#srSelect');
        if (fmt) {
          fmt.value = button.dataset.fmt;
          fmt.dispatchEvent(new Event('change'));
        }
        if (sr) {
          sr.value = button.dataset.sr;
          sr.dispatchEvent(new Event('change'));
        }
        exportMaster();
      });
    }
    $('#batchAddBtn')?.addEventListener('click', () => $('#batchInput').click());
    $('#batchInput')?.addEventListener('change', async (event) => {
      const files = [...(event.target.files ?? [])];
      event.target.value = '';
      if (files.length) {
        await resumeAudioContext();
        await enqueueFiles(files);
      }
    });
    $('#batchRunBtn')?.addEventListener('click', () => runBatch());
    $('#batchCancelBtn')?.addEventListener('click', cancelBatch);
    renderQueue();
    renderHistoryPanel();
  }

  return {
    init,
    exportMaster,
    runBatch,
    cancelBatch,
    enqueueFiles,
    retryItem,
    isBusy: () => busy,
    isRunning: () => runState.active,
    /**
     * Cross-controller render lock. The immersive workspace takes this so a stereo
     * export, a batch run and an immersive bed render can never interleave — the
     * disabled button set and the render state have ONE owner.
     * @returns {boolean} true when the caller acquired the lock.
     */
    tryLock(stage = 'rendering') {
      if (busy) return false;
      setBusy(true, stage);
      return true;
    },
    unlock() {
      setBusy(false);
    },
    get queue() {
      return queue;
    },
    downloadLastReport() {
      if (!lastReport) {
        toast('No render yet in this session', { level: 'error' });
        return;
      }
      downloadJson(lastReport, 'signal-rot_render-report.json');
    },
  };
}
