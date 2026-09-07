import { describe, expect, it } from 'vitest';
import { audioMemoryBytes, createPerformanceRecorder } from '../../src/runtime/performance.js';
import { memoryPlan } from '../../src/runtime/memory-budget.js';
import { createJobScheduler } from '../../src/runtime/job-scheduler.js';
import { buildWaveformPyramid } from '../../src/runtime/waveform-pyramid.js';
import { consumeAudioChunks, createAudioChunk } from '../../src/runtime/audio-stream.js';

describe('runtime performance primitives', () => {
  it('estimates audio memory without allocating audio', () => expect(audioMemoryBytes({ channels: 24, frames: 1920000 })).toBe(184320000));
  it('classifies a multichannel plan', () => expect(memoryPlan({ channels: 24, frames: 1920000 }, { dsp: 1, budgetBytes: 512 * 1024 * 1024 }).classification).toBe('HEAVY'));
  it('records successful and failed tasks locally', async () => { const recorder = createPerformanceRecorder(() => 10); expect(await recorder.measure('analysis', async () => 3)).toBe(3); expect(recorder.snapshot()[0]).toMatchObject({ name: 'analysis', durationMs: 0 }); });
  it('keeps jobs bounded and supersedes duplicate keys', async () => { const scheduler = createJobScheduler({ concurrency: 1 }); const first = scheduler.submit('ANALYSIS', async ({ isCancelled }) => { await new Promise((resolve) => setTimeout(resolve, 5)); return isCancelled(); }, { key: 'same' }); const second = scheduler.submit('ANALYSIS', async () => 2, { key: 'same' }); await new Promise((resolve) => setTimeout(resolve, 20)); expect(first.state).toBe('CANCELLED'); expect(second.state).toBe('COMPLETED'); expect(scheduler.stats().peakConcurrent).toBe(1); });
  it('creates multiresolution min/max data', () => { const pyramid = buildWaveformPyramid(Float32Array.from([-1, .5, .2, 1]), { bucketSize: 2, levels: 2 }); expect(Array.from(pyramid[0].values)).toEqual([-1, .5, expect.closeTo(.2), 1]); expect(Array.from(pyramid[1].values)).toEqual([-1, 1]); });
  it('runs stream lifecycle and validates channel shape', async () => { const events = []; const processor = { init: () => events.push('init'), process: (chunk) => events.push(chunk.startFrame), flush: () => events.push('flush'), dispose: () => events.push('dispose') }; await consumeAudioChunks((async function* () { yield createAudioChunk({ channels: [new Float32Array(2)], sampleRate: 48000 }); })(), processor); expect(events).toEqual(['init', 0, 'flush', 'dispose']); });
});
