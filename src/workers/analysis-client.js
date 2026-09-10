/**
 * Client for the analysis worker, with an in-thread fallback.
 *
 * Also handles *cancellation*: the audited build fired a full offline re-render 480 ms
 * after every slider move with no way to abandon an in-flight one, so dragging a fader
 * queued a dozen full-file analyses. Here a new request supersedes the previous one and
 * the stale result is discarded.
 */

import { analyseLoudness } from '../audio/analysis/loudness.js';
import { analysePeaks } from '../audio/analysis/true-peak.js';
import { crestFactorDb, rmsDb } from '../audio/analysis/rms.js';
import { monoCompatibility } from '../audio/analysis/correlation.js';
import { spectralFingerprint } from '../audio/analysis/spectral-match.js';
import { measureBrightness } from '../audio/analysis/brightness.js';

let worker = null;
let nextId = 1;
/** @type {Map<number, {resolve:Function, reject:Function}>} */
const pending = new Map();

function ensureWorker() {
  if (worker !== null) return worker;
  if (typeof Worker === 'undefined') {
    worker = false;
    return false;
  }
  try {
    worker = new Worker(new URL('./analysis.worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event) => {
      const { id, ok, result, error } = event.data ?? {};
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (ok) entry.resolve(result);
      else entry.reject(new Error(error));
    });
    worker.addEventListener('error', (event) => {
      console.warn('[signal-rot] analysis worker failed, falling back to main thread:', event);
      for (const [, entry] of pending) entry.reject(new Error('analysis worker error'));
      pending.clear();
      worker = false;
    });
  } catch (error) {
    console.warn('[signal-rot] could not start analysis worker:', error);
    worker = false;
  }
  return worker;
}

/** Run the analyses inline. Used when there is no worker, and by the tests. */
export function analyseInline(data, tasks = ['loudness', 'peaks']) {
  const out = {};
  if (tasks.includes('loudness')) {
    const l = analyseLoudness(data);
    out.loudness = {
      integrated: l.integrated,
      lra: l.lra,
      threshold: l.threshold,
      maxMomentary: l.maxMomentary,
      maxShortTerm: l.maxShortTerm,
      tooShort: l.tooShort,
      silent: l.silent,
      shortTerm: Array.from(l.shortTerm),
      shortTermHopSeconds: l.shortTermHopSeconds,
      momentary: Array.from(l.momentary),
      momentaryHopSeconds: l.momentaryHopSeconds,
    };
  }
  if (tasks.includes('peaks')) out.peaks = analysePeaks(data);
  if (tasks.includes('rms')) {
    out.rmsDb = rmsDb(data);
    out.crestFactorDb = crestFactorDb(data);
  }
  if (tasks.includes('mono')) out.mono = monoCompatibility(data);
  if (tasks.includes('fingerprint')) out.fingerprint = spectralFingerprint(data);
  if (tasks.includes('brightness')) out.brightness = measureBrightness(data);
  return out;
}

/**
 * Analyse an `AudioBuffer` off the main thread when possible.
 *
 * The channel data is *copied* out of the AudioBuffer (an AudioBuffer's backing store
 * cannot be transferred) and then transferred to the worker, so the copy is the only
 * allocation.
 *
 * @param {AudioBuffer} buffer
 * @param {string[]} tasks
 * @returns {Promise<Record<string, any>>}
 */
export async function analyseBuffer(buffer, tasks = ['loudness', 'peaks']) {
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(Float32Array.from(buffer.getChannelData(c)));
  }
  const data = { sampleRate: buffer.sampleRate, length: buffer.length, channels };

  const w = ensureWorker();
  if (!w) return analyseInline(data, tasks);

  const id = nextId++;
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  w.postMessage(
    { id, payload: { sampleRate: buffer.sampleRate, channels, tasks } },
    channels.map((c) => c.buffer),
  );
  try {
    return await promise;
  } catch {
    // The worker died; redo the work inline rather than leave the UI without numbers.
    const retry = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      retry.push(Float32Array.from(buffer.getChannelData(c)));
    }
    return analyseInline(
      { sampleRate: buffer.sampleRate, length: buffer.length, channels: retry },
      tasks,
    );
  }
}

/**
 * A latest-wins analysis scheduler.
 *
 * `request()` returns a promise that resolves only if no newer request has been made.
 * Stale results resolve to `null`, which callers treat as "ignore".
 */
export function createAnalysisScheduler(debounceMs = 400) {
  let timer = null;
  let generation = 0;

  return {
    /**
     * @param {() => Promise<any>} job
     * @param {object} [opts]
     * @param {boolean} [opts.immediate]
     * @returns {Promise<any|null>}
     */
    request(job, opts = {}) {
      const mine = ++generation;
      clearTimeout(timer);
      return new Promise((resolve, reject) => {
        timer = setTimeout(
          async () => {
            if (mine !== generation) return resolve(null);
            try {
              const result = await job();
              resolve(mine === generation ? result : null);
            } catch (error) {
              reject(error);
            }
          },
          opts.immediate ? 0 : debounceMs,
        );
      });
    },
    cancel() {
      generation++;
      clearTimeout(timer);
    },
  };
}

/** Shut the worker down — used by tests. */
export function terminateAnalysisWorker() {
  if (worker && worker !== true) {
    try {
      worker.terminate();
    } catch {
      /* ignore */
    }
  }
  worker = null;
  pending.clear();
}
