/**
 * Elevation / side view for Spatial Lab.
 * Restrained pseudo- elevation showing speaker height rings.
 */

import { resizeCanvas, cssVar } from './canvas-util.js';
import { LAYOUTS, SPEAKERS } from '../audio/immersive/layouts.js';

const TAU = Math.PI * 2;

export function drawElevation(canvas, opts) {
  const surface = resizeCanvas(canvas, 220);
  if (!surface) return;
  const { ctx, width, height } = surface;
  ctx.clearRect(0, 0, width, height);

  const layout = LAYOUTS[opts.layoutId];
  if (!layout) {
    ctx.fillStyle = cssVar('--faint');
    ctx.font = '11px monospace';
    ctx.fillText('No layout', 10, 20);
    return;
  }

  // Background grid: horizontal lines at ear, height
  ctx.strokeStyle = cssVar('--grid');
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const y of [height * 0.75, height * 0.52, height * 0.28]) {
    ctx.moveTo(8, y);
    ctx.lineTo(width - 8, y);
  }
  ctx.stroke();
  ctx.fillStyle = cssVar('--faint');
  ctx.font = '8px monospace';
  ctx.fillText('EAR', 10, height * 0.75 + 10);
  ctx.fillText('HEIGHT 30-45°', 10, height * 0.52 - 6);
  ctx.fillText('TOP', 10, height * 0.28 - 6);

  // Listener at bottom centre
  const cx = width / 2;
  const ly = height * 0.82;
  ctx.fillStyle = cssVar('--faint');
  ctx.beginPath(); ctx.arc(cx, ly, 3, 0, TAU); ctx.fill();
  ctx.fillText('◯', cx - 4, ly + 10);

  const bedColor = cssVar('--proc');
  const heightColor = cssVar('--orig');

  for (const key of layout.channels) {
    const sp = SPEAKERS[key];
    if (!sp) continue;
    // Map azimuth to x (left negative, right positive), elevation to y
    const x = cx + (sp.azimuthHrtf / 160) * (width * 0.42);
    const y = ly - (sp.elevation / 70) * (height * 0.46) - 10;
    const color = sp.elevation > 5 ? heightColor : sp.lfe ? bedColor : bedColor;
    const isHeight = sp.elevation > 5;
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = color;
    if (sp.lfe) {
      ctx.fillRect(x - 5, y - 5, 10, 10);
    } else {
      ctx.beginPath();
      ctx.arc(x, y, isHeight ? 6 : 5, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, isHeight ? 7.5 : 6, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = cssVar('--muted');
    ctx.font = '7px monospace';
    const label = sp.id;
    ctx.fillText(label, x - ctx.measureText(label).width/2, y + (isHeight ? -10 : 12));
  }
}
