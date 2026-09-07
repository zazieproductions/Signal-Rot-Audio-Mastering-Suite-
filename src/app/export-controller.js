/**
 * Export and batch controller.
 *
 * Owns every path from "finished audio" to "file on disk": format selection, encoding,
 * the render report, the render-history panel and the batch queue.
 *
 * ── Render-state locking ─────────────────────────────────────────────────────────────
 * A render mutates a large buffer and takes seconds. While one is running every control
 * that could change the result is disabled, and the progress text says which stage is
 * running rather than showing a bar that jumps from 45 % to 75 %.
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
import { getAudioContext, resumeAudioContext } from '../audio/context.js';
import { LIMITS } from './constants.js';
import { $, $$, el, replaceChildren, formatBytes } from '../ui/dom.js';
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
              onclick: () =>
                downloadJson(entry.report, `${baseNameOf(entry.name)}_render-report.json`),
            }),
          ]),
        ),
    );
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

    // Pre-flight size check: better to refuse than to allocate 3 GB and take the tab down.
    const effectiveRate = sampleRate || source.sampleRate;
    const estimatedSamples = Math.ceil(source.duration * effectiveRate) * source.numberOfChannels;
    if (estimatedSamples > LIMITS.WARN_TOTAL_SAMPLES) {
      toast(
        `This render is roughly ${formatBytes(estimatedSamples * 4)} of float audio before ` +
          'encoding. It may exhaust the tab.',
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
      const name = `${baseNameOf(state.source.name)}_master_${(data.sampleRate / 1000).toFixed(1)}k.${format.ext}`;

      if (format.container === 'wav') {
        const bytes = estimateWavBytes(data, format.bitDepth);
        // The streaming-to-disk path promotes to RF64/BW64 automatically, so the hard
        // 4 GiB RIFF ceiling only applies when it is not available.
        if (bytes > LIMITS.RIFF_MAX_BYTES && !supportsStreamingSave()) {
          throw new Error(
            `The encoded file would be ${formatBytes(bytes)}, above the 4 GB RIFF limit, ` +
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

  /** @type {{file:File, name:string, buffer:AudioBuffer|null, lufs:number|null}[]} */
  const queue = [];

  function renderQueue() {
    const host = $('#batchList');
    if (!host) return;
    replaceChildren(
      host,
      ...queue.map((item, index) =>
        el('div', { class: 'brow' }, [
          // textContent, never innerHTML: `item.name` is attacker-controlled and the
          // audited build interpolated it into innerHTML.
          el('span', { class: 'nm', text: item.name, title: item.name }),
          el('span', {
            class: 'lu',
            text: item.lufs === null ? 'analysing…' : `${item.lufs.toFixed(1)} LUFS`,
          }),
          el('button', {
            class: 'btn ghost',
            style: 'padding:2px 8px',
            text: '✕',
            'aria-label': `Remove ${item.name}`,
            onclick: () => {
              queue.splice(index, 1);
              renderQueue();
            },
          }),
        ]),
      ),
    );
    const runBtn = $('#batchRunBtn');
    if (runBtn) runBtn.disabled = queue.length === 0 || busy;
  }

  async function addFiles(files) {
    const ctx = getAudioContext();
    for (const file of files) {
      if (file.size > LIMITS.MAX_FILE_BYTES) {
        toast(`Skipped ${file.name} — too large`, { level: 'error' });
        continue;
      }
      try {
        const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
        queue.push({ file, name: file.name, buffer, lufs: null });
        renderQueue();
      } catch {
        toast(`Skipped ${file.name} — could not decode`, { level: 'error' });
      }
    }
    // Loudness analysis runs off-thread, one file at a time, so the UI stays responsive.
    for (const item of queue) {
      if (item.lufs !== null || !item.buffer) continue;
      const stats = await analyseBuffer(item.buffer, ['loudness']);
      item.lufs = stats.loudness.integrated;
      renderQueue();
    }
  }

  async function runBatch() {
    if (busy || !queue.length) return;
    const state = store.getState();
    const formatKey = $('#fmtSelect').value;
    const sampleRate = Number($('#srSelect').value) || 0;
    const format = EXPORT_FORMATS[formatKey] ?? EXPORT_FORMATS.wav24;
    const parameters = store.getParameters();

    setBusy(true, 'batch');
    const bar = $('#batchProg');
    bar?.classList.add('on');
    const text = $('#batchProgText');

    let completed = 0;
    for (const [index, item] of queue.entries()) {
      if (!item.buffer) continue;
      if (text) text.textContent = `${index + 1} / ${queue.length} — ${item.name}`;
      if (bar) bar.querySelector('i').style.width = `${(index / queue.length) * 100}%`;
      try {
        const { data, report } = await renderMaster({
          source: item.buffer,
          parameters,
          sampleRate,
          bitDepth: format.bitDepth,
          moduleBypass: state.ui.moduleBypass,
          sourceName: item.name,
          presetName: state.ui.presetName,
          format: format.container,
          // Batch trades the last 0.2 LU of accuracy for speed; single exports refine.
          refine: false,
        });
        const { blob } = await encode(data, formatKey);
        const name = `${String(index + 1).padStart(2, '0')}_${baseNameOf(item.name)}_master.${format.ext}`;
        downloadBlob(blob, name);
        history.push({ report, at: new Date(), name });
        completed++;
        // A short pause: browsers rate-limit consecutive programmatic downloads.
        await new Promise((r) => setTimeout(r, 450));
      } catch (error) {
        console.error('[signal-rot] batch item failed:', item.name, error);
        toast(`Batch error on ${item.name}: ${error.message ?? error}`, { level: 'error' });
      }
    }

    if (bar) bar.querySelector('i').style.width = '100%';
    if (text) text.textContent = `Complete — ${completed} of ${queue.length} exported`;
    if (history.length > 40) history.splice(0, history.length - 40);
    renderHistoryPanel();
    setBusy(false);
    renderQueue();
    toast(`Batch complete · ${completed} track(s)`);
    setTimeout(() => bar?.classList.remove('on'), 900);
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
        addFiles(files);
      }
    });
    $('#batchRunBtn')?.addEventListener('click', () => runBatch());
    renderQueue();
    renderHistoryPanel();
  }

  return {
    init,
    exportMaster,
    runBatch,
    addFiles,
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
