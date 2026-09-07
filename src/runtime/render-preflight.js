import { memoryPlan } from './memory-budget.js';

function plan(shape, options, kind) {
  const result = memoryPlan(shape, options);
  return { ...result, estimatedBytes: result.sourceBytes, reason: `${kind} requires source, working, and output buffers` };
}

export function estimateRender(shape, options = {}) { return plan(shape, { dsp: 1, output: 1, ...options }, 'Render'); }
export function estimateImmersiveRender(shape, options = {}) { return plan(shape, { dsp: 1, immersiveChannels: options.immersiveChannels ?? shape.channels, output: 1, ...options }, 'Immersive render'); }
