import { audioMemoryBytes } from './performance.js';

export const MEMORY_CLASSES = Object.freeze(['SAFE', 'HEAVY', 'VERY HEAVY', 'LIKELY UNSAFE']);
const MB = 1024 * 1024;

/** Conservative estimates; browser heap reporting is intentionally not used. */
export function estimateAudioMemory({ channels, frames, bytesPerSample = 4, source = 1, dsp = 1, analysis = 0, immersiveChannels = 0, encoding = 0, output = 0 }) {
  const sourceBytes = audioMemoryBytes({ channels, frames, bytesPerSample }) * source;
  const dspBytes = audioMemoryBytes({ channels, frames, bytesPerSample }) * dsp;
  const analysisBytes = audioMemoryBytes({ channels, frames, bytesPerSample }) * analysis;
  const immersiveBytes = audioMemoryBytes({ channels: immersiveChannels, frames, bytesPerSample });
  const encodingBytes = audioMemoryBytes({ channels, frames, bytesPerSample }) * encoding;
  const outputBytes = audioMemoryBytes({ channels, frames, bytesPerSample }) * output;
  const expectedPeakBytes = sourceBytes + dspBytes + analysisBytes + immersiveBytes + encodingBytes + outputBytes;
  return { sourceBytes, dspBytes, analysisBytes, immersiveBytes, encodingBytes, outputBytes, expectedPeakBytes };
}

export function classifyMemory(expectedPeakBytes, budgetBytes = ((globalThis.navigator?.deviceMemory ?? 4) * 256 * MB)) {
  if (expectedPeakBytes > budgetBytes * 1.25) return 'LIKELY UNSAFE';
  if (expectedPeakBytes > budgetBytes * 0.75) return 'VERY HEAVY';
  if (expectedPeakBytes > budgetBytes * 0.35) return 'HEAVY';
  return 'SAFE';
}

export function formatBytes(bytes) {
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / MB).toFixed(bytes >= 10 * MB ? 0 : 1)} MB`;
}

export function memoryPlan(shape, options = {}) {
  const estimate = estimateAudioMemory({ ...shape, ...options });
  return { ...estimate, classification: classifyMemory(estimate.expectedPeakBytes, options.budgetBytes), label: `Expected peak: approximately ${formatBytes(estimate.expectedPeakBytes)}` };
}
