/** Compact min/max pyramid for viewport-sized waveform rendering. */
export function buildWaveformPyramid(channel, { bucketSize = 256, levels = 8 } = {}) {
  const pyramid = [];
  let values = channel;
  let sourceBucketSize = 1;
  for (let level = 0; level < levels && values.length; level++) {
    const inputBuckets = level === 0 ? values.length : values.length / 2;
    const buckets = Math.ceil(inputBuckets / bucketSize);
    const next = new Float32Array(buckets * 2);
    for (let b = 0; b < buckets; b++) {
      let min = Infinity;
      let max = -Infinity;
      const from = level === 0 ? b * bucketSize : b * bucketSize * 2;
      const to = Math.min(values.length, level === 0 ? (b + 1) * bucketSize : (b + 1) * bucketSize * 2);
      for (let i = from; i < to; i += level === 0 ? 1 : 2) { min = Math.min(min, values[i]); max = Math.max(max, values[Math.min(i + 1, values.length - 1)]); }
      next[b * 2] = min;
      next[b * 2 + 1] = max;
    }
    sourceBucketSize *= bucketSize;
    pyramid.push(Object.freeze({ bucketSize: sourceBucketSize, values: next }));
    values = next;
  }
  return pyramid;
}

export function waveformLevel(pyramid, pixels) { return pyramid.find((level) => level.values.length / 2 <= pixels) ?? pyramid[pyramid.length - 1]; }
