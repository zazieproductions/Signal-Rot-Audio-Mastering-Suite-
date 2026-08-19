/**
 * Waveform overview with playhead and loop region.
 *
 * The peak envelope is computed once per file per canvas width and cached. The audited
 * version recomputed the canvas backing store every frame; this one only redraws.
 */

import { resizeCanvas, cssVar, signalColor, withAlpha } from './canvas-util.js';

/** @type {{peaks: Float32Array, width: number, token: object}|null} */
let cache = null;

/**
 * Min/max peak envelope, one bucket per pixel column.
 * @param {AudioBuffer} buffer
 * @param {number} buckets
 */
export function computePeaks(buffer, buckets) {
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const step = Math.max(1, Math.floor(buffer.length / buckets));
  const peaks = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) {
    const from = b * step;
    const to = Math.min(buffer.length, from + step);
    let max = 0;
    for (let i = from; i < to; i++) {
      for (let c = 0; c < channels.length; c++) {
        const v = Math.abs(channels[c][i]);
        if (v > max) max = v;
      }
    }
    peaks[b] = max;
  }
  return peaks;
}

export function invalidateWaveformCache() {
  cache = null;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} opts
 * @param {AudioBuffer|null} opts.buffer
 * @param {object} opts.token identity of the current buffer, for cache invalidation
 * @param {number} opts.position seconds
 * @param {[number,number]|null} opts.loopRegion
 * @param {'A'|'B'} opts.abMode
 */
export function drawWaveform(canvas, opts) {
  const surface = resizeCanvas(canvas, 120);
  if (!surface) return;
  const { ctx, width, height } = surface;
  ctx.clearRect(0, 0, width, height);

  const { buffer } = opts;
  const mid = height / 2;
  ctx.strokeStyle = cssVar('--grid');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(width, mid);
  ctx.stroke();
  if (!buffer) return;

  const columns = Math.max(1, Math.floor(width));
  if (!cache || cache.width !== columns || cache.token !== opts.token) {
    cache = { peaks: computePeaks(buffer, columns), width: columns, token: opts.token };
  }

  const color = signalColor(opts.abMode);
  ctx.fillStyle = color;
  for (let x = 0; x < columns; x++) {
    const h = (cache.peaks[x] || 0) * (height * 0.46);
    ctx.fillRect(x, mid - h, 1, h * 2);
  }

  if (opts.loopRegion) {
    const [a, b] = opts.loopRegion;
    const x0 = (a / buffer.duration) * width;
    const x1 = (b / buffer.duration) * width;
    ctx.fillStyle = withAlpha(color, 0.14);
    ctx.fillRect(Math.min(x0, x1), 0, Math.abs(x1 - x0), height);
    ctx.strokeStyle = withAlpha(color, 0.5);
    ctx.beginPath();
    ctx.moveTo(x0, 0);
    ctx.lineTo(x0, height);
    ctx.moveTo(x1, 0);
    ctx.lineTo(x1, height);
    ctx.stroke();
  }

  const px = (opts.position / buffer.duration) * width;
  ctx.strokeStyle = cssVar('--text');
  ctx.globalAlpha = 0.8;
  ctx.beginPath();
  ctx.moveTo(px, 0);
  ctx.lineTo(px, height);
  ctx.stroke();
  ctx.globalAlpha = 1;
}
