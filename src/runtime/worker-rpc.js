/** Small cancellable RPC adapter for dedicated workers. Payload buffers may be transferred. */
export function createWorkerRpc(worker, { onCrash = () => {} } = {}) {
  let sequence = 0;
  const pending = new Map();
  const onMessage = ({ data }) => { const entry = pending.get(data?.id); if (!entry) return; if (data.type === 'progress') { entry.progress?.(data.progress); return; } pending.delete(data.id); if (data.ok) entry.resolve(data.result); else entry.reject(new Error(data.error ?? 'Worker request failed')); };
  const onError = (error) => { for (const entry of pending.values()) entry.reject(error instanceof Error ? error : new Error('Worker crashed')); pending.clear(); onCrash(error); };
  worker.addEventListener('message', onMessage); worker.addEventListener('error', onError);
  return { request(payload, { transfer = [], progress } = {}) { const id = `rpc-${++sequence}`; let cancel; const promise = new Promise((resolve, reject) => { pending.set(id, { resolve, reject, progress }); cancel = () => { if (pending.delete(id)) { worker.postMessage({ type: 'cancel', id }); reject(new DOMException('The operation was cancelled', 'AbortError')); } }; }); worker.postMessage({ type: 'request', id, payload }, transfer); return { promise, cancel }; }, dispose() { worker.removeEventListener('message', onMessage); worker.removeEventListener('error', onError); for (const entry of pending.values()) entry.reject(new Error('Worker RPC disposed')); pending.clear(); } };
}
