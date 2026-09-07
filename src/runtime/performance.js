/** Local-only performance measurements. No telemetry or global instrumentation. */
export function createPerformanceRecorder(clock = () => performance.now()) {
  const measurements = [];
  return {
    measure(name, fn, metadata = {}) {
      const started = clock();
      try {
        const value = fn();
        if (value && typeof value.then === 'function') {
          return value.then((result) => { measurements.push({ name, durationMs: clock() - started, ...metadata }); return result; }, (error) => { measurements.push({ name, durationMs: clock() - started, failed: true, ...metadata }); throw error; });
        }
        measurements.push({ name, durationMs: clock() - started, ...metadata });
        return value;
      } catch (error) {
        measurements.push({ name, durationMs: clock() - started, failed: true, ...metadata });
        throw error;
      }
    },
    record(entry) { measurements.push({ ...entry }); },
    snapshot() { return measurements.map((entry) => ({ ...entry })); },
    clear() { measurements.length = 0; },
  };
}

export function audioMemoryBytes({ channels = 0, frames = 0, bytesPerSample = 4 } = {}) {
  return Math.max(0, channels) * Math.max(0, frames) * bytesPerSample;
}

export function audioShape(buffer) {
  return { channels: buffer.numberOfChannels, frames: buffer.length, sampleRate: buffer.sampleRate };
}
