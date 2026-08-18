/**
 * Multiband crossover reconstruction diagnostic.
 *
 * Plots the summed magnitude response of the three bands plus the phase-matched dry path
 * at the current parallel-mix setting. A correct crossover network draws a flat line at
 * 0 dB at *every* mix position; the audited parallel topology drew two 30 dB notches at
 * 50 % mix. Having this on screen is how you notice that class of bug in ten seconds
 * instead of never.
 */

import { crossoverReconstruction, legacyMultibandResponse } from '../audio/graph/multiband.js';
import { cabs } from '../audio/dsp/biquad.js';
import { resizeCanvas, cssVar, withAlpha } from './canvas-util.js';

const F_MIN = 20;
const SCALE_DB = 12;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} opts
 * @param {number} opts.sampleRate
 * @param {number} opts.mix 0..1
 * @param {boolean} [opts.showLegacy] overlay the pre-7.0 topology for comparison
 */
export function drawCrossoverDiagnostic(canvas, opts) {
  const surface = resizeCanvas(canvas, 120);
  if (!surface) return;
  const { ctx, width, height } = surface;
  ctx.clearRect(0, 0, width, height);

  const sr = opts.sampleRate || 48000;
  const fMax = Math.min(22000, sr / 2 - 1);
  const lx = Math.log10(F_MIN);
  const rx = Math.log10(fMax);
  const yFor = (db) => height / 2 - (db / SCALE_DB) * (height / 2 - 12);

  ctx.strokeStyle = cssVar('--grid');
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const db of [-6, 0, 6]) {
    ctx.moveTo(0, yFor(db));
    ctx.lineTo(width, yFor(db));
  }
  ctx.stroke();

  const points = 400;
  const result = crossoverReconstruction(sr, { mix: opts.mix, points, fMin: F_MIN, fMax });

  if (opts.showLegacy) {
    ctx.strokeStyle = withAlpha(cssVar('--hot'), 0.8);
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    for (let i = 0; i < points; i++) {
      const f = F_MIN * Math.pow(fMax / F_MIN, i / (points - 1));
      const db =
        20 * Math.log10(Math.max(1e-6, cabs(legacyMultibandResponse(f, sr, { mix: opts.mix }))));
      const x = ((Math.log10(f) - lx) / (rx - lx)) * width;
      const y = yFor(Math.max(-SCALE_DB, db));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.strokeStyle = cssVar('--proc');
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (let i = 0; i < points; i++) {
    const x = ((Math.log10(result.freqs[i]) - lx) / (rx - lx)) * width;
    const y = yFor(Math.max(-SCALE_DB, Math.min(SCALE_DB, result.magnitudeDb[i])));
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.fillStyle = cssVar('--faint');
  ctx.font = '9px monospace';
  ctx.fillText(`±${SCALE_DB} dB`, 4, 11);
  ctx.fillText(
    `worst ${result.worstDeviationDb.toFixed(3)} dB @ ${Math.round(result.worstFreq)} Hz`,
    4,
    height - 4,
  );
  for (const f of [100, 1000, 10000]) {
    if (f > fMax) continue;
    const x = ((Math.log10(f) - lx) / (rx - lx)) * width;
    const label = f >= 1000 ? `${f / 1000}k` : String(f);
    ctx.fillText(label, x + 3, 11);
  }
  return result;
}
