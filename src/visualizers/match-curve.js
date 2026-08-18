/**
 * Reference-match curve display.
 *
 * Shows three things at once, which is the whole reason to draw it rather than print
 * numbers: the source's tonal shape, the reference's tonal shape, and the correction that
 * will be applied at the current strength. If the correction is fighting a big shape
 * difference, you can see it.
 */

import { MATCH_FREQS } from '../app/constants.js';
import { resizeCanvas, cssVar, withAlpha } from './canvas-util.js';

const SCALE_DB = 10;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} opts
 * @param {number[]} opts.gainsDb
 * @param {number} opts.strength 0..100
 * @param {number[]} [opts.sourceShapeDb]
 * @param {number[]} [opts.referenceShapeDb]
 */
export function drawMatchCurve(canvas, opts) {
  const surface = resizeCanvas(canvas, 130);
  if (!surface) return;
  const { ctx, width, height } = surface;
  ctx.clearRect(0, 0, width, height);

  const mid = height / 2;
  const proc = cssVar('--proc');
  const orig = cssVar('--orig');
  const faint = cssVar('--faint');

  ctx.strokeStyle = cssVar('--grid');
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const db of [-SCALE_DB / 2, 0, SCALE_DB / 2]) {
    const y = mid - (db / SCALE_DB) * (height - 26);
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  const bandWidth = width / MATCH_FREQS.length;
  const yFor = (db) => mid - (db / SCALE_DB) * (height - 26);

  const polyline = (values, color, dash) => {
    if (!values || !values.length) return;
    ctx.setLineDash(dash ?? []);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = i * bandWidth + bandWidth / 2;
      const y = yFor(Math.max(-SCALE_DB, Math.min(SCALE_DB, v)));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  };

  polyline(opts.sourceShapeDb, withAlpha(faint, 0.9), [2, 3]);
  polyline(opts.referenceShapeDb, withAlpha(orig, 0.9), [5, 3]);

  // Correction bars at the applied strength.
  const strength = (opts.strength ?? 0) / 100;
  ctx.fillStyle = withAlpha(proc, 0.75);
  MATCH_FREQS.forEach((_f, i) => {
    const gain = (opts.gainsDb[i] ?? 0) * strength;
    const y = yFor(gain);
    const h = mid - y;
    ctx.fillRect(i * bandWidth + bandWidth * 0.28, Math.min(mid, y), bandWidth * 0.44, Math.abs(h));
  });

  ctx.fillStyle = faint;
  ctx.font = '9px monospace';
  MATCH_FREQS.forEach((f, i) => {
    const label = f >= 1000 ? `${f / 1000}k` : String(f);
    const x = i * bandWidth + bandWidth / 2 - ctx.measureText(label).width / 2;
    ctx.fillText(label, x, height - 4);
  });
  ctx.fillText(`±${SCALE_DB} dB`, 4, 11);
}
