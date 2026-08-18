/**
 * Log-frequency spectrum analyser display.
 *
 * Reads `getByteFrequencyData` into a pooled array; the analyser's own smoothing does the
 * temporal averaging so nothing is retained between frames.
 */

import { resizeCanvas, cssVar, signalColor, withAlpha, getByteScratch } from './canvas-util.js';

const F_MIN = 20;
const GRID_FREQS = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

/**
 * @param {HTMLCanvasElement} canvas
 * @param {AnalyserNode} analyser
 * @param {object} opts
 * @param {'A'|'B'} opts.abMode
 */
export function drawSpectrum(canvas, analyser, opts) {
  const surface = resizeCanvas(canvas, 190);
  if (!surface) return;
  const { ctx, width, height } = surface;
  ctx.clearRect(0, 0, width, height);

  const bins = analyser.frequencyBinCount;
  const data = getByteScratch('spectrum', bins);
  analyser.getByteFrequencyData(data);

  const nyquist = analyser.context.sampleRate / 2;
  const fMax = Math.min(nyquist, 22000);
  const lx = Math.log10(F_MIN);
  const rx = Math.log10(fMax);

  // Grid: horizontal dB lines plus vertical decade markers.
  ctx.strokeStyle = cssVar('--grid');
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const f of [0.25, 0.5, 0.75]) {
    ctx.moveTo(0, height * f);
    ctx.lineTo(width, height * f);
  }
  for (const f of GRID_FREQS) {
    if (f > fMax) continue;
    const x = ((Math.log10(f) - lx) / (rx - lx)) * width;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  ctx.stroke();

  const color = signalColor(opts.abMode);
  const trace = (build) => {
    ctx.beginPath();
    for (let x = 0; x <= width; x++) {
      const freq = Math.pow(10, lx + ((rx - lx) * x) / width);
      const bin = Math.min(bins - 1, Math.max(0, Math.round((freq / nyquist) * bins)));
      const v = (data[bin] || 0) / 255;
      const y = height - v * height * 0.96;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    build();
  };

  trace(() => {
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, withAlpha(color, 0.8));
    grad.addColorStop(1, withAlpha(color, 0.06));
    ctx.fillStyle = grad;
    ctx.fill();
  });
  trace(() => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  });

  ctx.fillStyle = cssVar('--faint');
  ctx.font = `9px ${cssVar('--mono') || 'monospace'}`;
  for (const f of [100, 1000, 10000]) {
    if (f > fMax) continue;
    const x = ((Math.log10(f) - lx) / (rx - lx)) * width;
    ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 3, height - 4);
  }
}
