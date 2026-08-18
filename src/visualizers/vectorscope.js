/**
 * Goniometer / vectorscope, plus a correlation history strip.
 *
 * The display is the classic mid-up / side-right Lissajous: a mono signal draws a vertical
 * line, a fully out-of-phase signal draws a horizontal one, and anything leaning
 * horizontal is losing level in mono.
 */

import { resizeCanvas, cssVar, signalColor, withAlpha, getScratch } from './canvas-util.js';

const TAU = Math.PI * 2;
const HISTORY = 240;
const history = new Float32Array(HISTORY);
let historyIndex = 0;

/** Push a correlation reading into the history ring. */
export function pushCorrelation(value) {
  history[historyIndex] = value;
  historyIndex = (historyIndex + 1) % HISTORY;
}

export function resetCorrelationHistory() {
  history.fill(0);
  historyIndex = 0;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {AnalyserNode} analyserL
 * @param {AnalyserNode} analyserR
 * @param {object} opts
 */
export function drawVectorscope(canvas, analyserL, analyserR, opts) {
  const surface = resizeCanvas(canvas, 190);
  if (!surface) return;
  const { ctx, width, height } = surface;

  ctx.fillStyle = cssVar('--panel');
  ctx.fillRect(0, 0, width, height);

  const cx = width / 2;
  const cy = height / 2;
  const R = Math.min(width, height) * 0.4;

  ctx.strokeStyle = cssVar('--grid');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, TAU);
  ctx.moveTo(cx - R, cy);
  ctx.lineTo(cx + R, cy);
  ctx.moveTo(cx, cy - R);
  ctx.lineTo(cx, cy + R);
  ctx.stroke();

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-Math.PI / 4);
  ctx.strokeStyle = cssVar('--line2');
  ctx.beginPath();
  ctx.moveTo(-R, 0);
  ctx.lineTo(R, 0);
  ctx.moveTo(0, -R);
  ctx.lineTo(0, R);
  ctx.stroke();
  ctx.restore();

  const size = analyserL.fftSize;
  const left = getScratch('gonioL', size);
  const right = getScratch('gonioR', size);
  analyserL.getFloatTimeDomainData(left);
  analyserR.getFloatTimeDomainData(right);

  const color = signalColor(opts.abMode);
  ctx.fillStyle = withAlpha(color, 0.62);
  for (let i = 0; i < size; i += 3) {
    const m = (left[i] + right[i]) * 0.5;
    const s = (left[i] - right[i]) * 0.5;
    ctx.fillRect(cx + s * R * 1.4, cy - m * R * 1.4, 1.4, 1.4);
  }

  // Correlation history strip along the bottom.
  const stripH = 16;
  const y0 = height - stripH;
  ctx.strokeStyle = cssVar('--line2');
  ctx.beginPath();
  ctx.moveTo(0, y0 + stripH / 2);
  ctx.lineTo(width, y0 + stripH / 2);
  ctx.stroke();
  for (let i = 0; i < HISTORY; i++) {
    const idx = (historyIndex + i) % HISTORY;
    const v = history[idx];
    const x = (i / HISTORY) * width;
    const h = (v * stripH) / 2;
    ctx.fillStyle = v < 0 ? cssVar('--hot') : withAlpha(color, 0.7);
    ctx.fillRect(x, y0 + stripH / 2 - Math.max(0, h), Math.max(1, width / HISTORY), Math.abs(h));
  }
  ctx.fillStyle = cssVar('--faint');
  ctx.font = '8px monospace';
  ctx.fillText('correlation', 4, height - 4);
}
