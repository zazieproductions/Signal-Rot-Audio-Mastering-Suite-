export const JOB_TYPES = Object.freeze(['ANALYSIS', 'RENDER', 'IMMERSIVE RENDER', 'ENCODE', 'BATCH EXPORT', 'WAVEFORM', 'REFERENCE ANALYSIS']);
export const JOB_STATES = Object.freeze(['QUEUED', 'RUNNING', 'COMPLETED', 'CANCEL REQUESTED', 'CANCELLED', 'FAILED', 'STALE RESULT DISCARDED']);
const transitions = { QUEUED: ['RUNNING', 'CANCEL REQUESTED', 'CANCELLED'], RUNNING: ['COMPLETED', 'CANCEL REQUESTED', 'FAILED', 'STALE RESULT DISCARDED'], 'CANCEL REQUESTED': ['CANCELLED', 'STALE RESULT DISCARDED'], COMPLETED: [], CANCELLED: [], FAILED: [], 'STALE RESULT DISCARDED': [] };

export function createJobScheduler({ concurrency = 1, clock = () => Date.now() } = {}) {
  let sequence = 0;
  const jobs = new Map();
  const queue = [];
  let active = 0;
  let peakConcurrent = 0;
  const listeners = new Set();
  const notify = (job) => listeners.forEach((listener) => listener({ ...job }));
  const transition = (job, state) => { if (!transitions[job.state].includes(state)) throw new Error(`Invalid job transition ${job.state} -> ${state}`); job.state = state; if (state === 'RUNNING') job.startedAt = clock(); if (['COMPLETED', 'CANCELLED', 'FAILED', 'STALE RESULT DISCARDED'].includes(state)) job.finishedAt = clock(); notify(job); };
  const pump = () => { while (active < concurrency && queue.length) { const job = queue.shift(); if (job.state !== 'QUEUED') continue; active++; peakConcurrent = Math.max(peakConcurrent, active); transition(job, 'RUNNING'); Promise.resolve().then(() => job.run({ isCancelled: () => job.cancelRequested, report: (progress) => { job.progress = Math.max(0, Math.min(1, progress)); notify(job); } })).then((result) => { if (job.cancelRequested) transition(job, 'CANCELLED'); else { job.result = result; transition(job, 'COMPLETED'); } }).catch((error) => { if (job.cancelRequested) transition(job, 'CANCELLED'); else { job.error = error; transition(job, 'FAILED'); } }).finally(() => { active--; pump(); }); } };
  return {
    submit(type, run, { key, generation = 0 } = {}) { if (!JOB_TYPES.includes(type)) throw new Error(`Unknown job type: ${type}`); if (key) for (const old of jobs.values()) if (old.key === key && ['QUEUED', 'RUNNING'].includes(old.state)) old.cancel(); const job = { id: `job-${++sequence}`, type, key, generation, state: 'QUEUED', progress: 0, createdAt: clock(), startedAt: null, finishedAt: null, run, cancelRequested: false, result: undefined, error: null, cancel() { if (['QUEUED', 'RUNNING'].includes(job.state)) { job.cancelRequested = true; if (job.state === 'QUEUED') transition(job, 'CANCELLED'); else transition(job, 'CANCEL REQUESTED'); } } }; jobs.set(job.id, job); queue.push(job); notify(job); pump(); return job; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    get(id) { return jobs.get(id); },
    stats() { return { active, queued: queue.filter((job) => job.state === 'QUEUED').length, peakConcurrent }; },
    cancelAll() { for (const job of jobs.values()) job.cancel(); },
  };
}
