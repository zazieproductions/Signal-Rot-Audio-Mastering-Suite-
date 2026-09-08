/**
 * Short-term loudness history.
 *
 * Plots the EBU Tech 3341 short-term series against the target, with the integrated value
 * and the loudness range shown as a band. This is the view that tells you whether a
 * master is consistently at target or averaging its way there.
 */

import { resizeCanvas, cssVar, withAlpha } from './canvas-util.js';

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} opts
 * @param {number[]} opts.shortTerm LUFS values
 * @param {number} opts.hopSeconds
 * @param {number} opts.integrated
 * @param {number} opts.target
 * @param {'A'|'B'} opts.abMode
 * @param {string} [opts.emptyLabel] shown instead of the default when there is no series
 */
export function drawLoudnessGraph(canvas, opts) {
  const surface = resizeCanvas(canvas, 120);
  if (!surface) return;
  const { ctx, width, height } = surface;
  ctx.clearRect(0, 0, width, height);

  const top = -5;
  const bottom = -40;
  const yFor = (lufs) => {
    const t = (lufs - bottom) / (top - bottom);
    return height - Math.max(0, Math.min(1, t)) * (height - 14) - 7;
  };

  ctx.strokeStyle = cssVar('--grid');
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const l of [-10, -14, -20, -30]) {
    ctx.moveTo(0, yFor(l));
    ctx.lineTo(width, yFor(l));
  }
  ctx.stroke();
  ctx.fillStyle = cssVar('--faint');
  ctx.font = '8px monospace';
  for (const l of [-10, -14, -20, -30]) ctx.fillText(String(l), 3, yFor(l) - 2);

  const series = opts.shortTerm ?? [];
  if (!series.length) {
    ctx.fillStyle = cssVar('--faint');
    ctx.font = '10px monospace';
    ctx.fillText(
      opts.emptyLabel ?? 'No short-term data — programme shorter than 3 s.',
      40,
      height / 2,
    );
    return;
  }

  // Target line.
  if (Number.isFinite(opts.target)) {
    ctx.strokeStyle = withAlpha(cssVar('--orig'), 0.8);
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(0, yFor(opts.target));
    ctx.lineTo(width, yFor(opts.target));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const color = opts.abMode === 'A' ? cssVar('--orig') : cssVar('--proc');
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  series.forEach((value, i) => {
    const x = (i / Math.max(1, series.length - 1)) * width;
    const y = yFor(Number.isFinite(value) ? value : bottom);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  if (Number.isFinite(opts.integrated)) {
    ctx.strokeStyle = withAlpha(color, 0.55);
    ctx.setLineDash([1, 3]);
    ctx.beginPath();
    ctx.moveTo(0, yFor(opts.integrated));
    ctx.lineTo(width, yFor(opts.integrated));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = '9px monospace';
    ctx.fillText(`I ${opts.integrated.toFixed(1)}`, width - 52, yFor(opts.integrated) - 3);
  }
}
