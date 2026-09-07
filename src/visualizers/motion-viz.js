/**
 * Motion trajectory preview — subtle, corresponds to actual spatial state.
 * Respects prefers-reduced-motion.
 */

import { resizeCanvas, cssVar, withAlpha } from './canvas-util.js';

export function drawMotion(canvas, mode) {
  const surface = resizeCanvas(canvas, 88);
  if (!surface) return;
  const { ctx, width, height } = surface;
  ctx.clearRect(0, 0, width, height);

  const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Grid
  ctx.strokeStyle = cssVar('--grid');
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
  ctx.beginPath();
  ctx.moveTo(width/2, 0);
  ctx.lineTo(width/2, height);
  ctx.moveTo(0, height/2);
  ctx.lineTo(width, height/2);
  ctx.stroke();

  const cx = width/2, cy = height/2;

  ctx.strokeStyle = withAlpha(cssVar('--orig'), 0.45);
  ctx.fillStyle = withAlpha(cssVar('--orig'), prefersReduced ? 0.35 : 0.22);
  ctx.lineWidth = 1.2;

  const t = Date.now() * 0.001;
  const draw = (path) => {
    ctx.beginPath();
    for (let i = 0; i <= 120; i++) {
      const p = i / 120;
      const pt = path(p, t);
      if (i === 0) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    }
    ctx.stroke();
    // head
    const h = path(prefersReduced ? 0.25 : (t * 0.18) % 1, t);
    ctx.beginPath();
    ctx.arc(h.x, h.y, 4, 0, Math.PI*2);
    ctx.fill();
    ctx.stroke();
  };

  const R = Math.min(width, height) * 0.34;

  if (mode === 'orbit') {
    draw((p) => ({ x: cx + Math.cos(p*Math.PI*2)*R, y: cy + Math.sin(p*Math.PI*2)*R*0.62 }));
  } else if (mode === 'front-rear') {
    draw((p) => ({ x: cx, y: cy - (p - 0.5)*R*1.6 }));
  } else if (mode === 'rise') {
    draw((p) => ({ x: cx + Math.sin(p*Math.PI)*R*0.35, y: cy + (0.5 - p)*R*1.4 }));
  } else if (mode === 'fall') {
    draw((p) => ({ x: cx + Math.sin(p*Math.PI)*R*0.35, y: cy - (0.5 - p)*R*1.4 }));
  } else if (mode === 'breathing') {
    draw((p, tm) => {
      const s = prefersReduced ? 1 : 1 + Math.sin(tm*0.9)*0.18;
      return { x: cx + Math.cos(p*Math.PI*2)*R*s, y: cy + Math.sin(p*Math.PI*2)*R*0.62*s };
    });
  } else {
    // static — dot at front
    ctx.fillStyle = withAlpha(cssVar('--proc'), 0.9);
    ctx.beginPath(); ctx.arc(cx, cy - R*0.62, 4, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = cssVar('--faint');
    ctx.font = '9px monospace';
    ctx.fillText('static — no motion', 8, height - 6);
    return;
  }
  if (!prefersReduced) {
    // subtle trail opacity handled by fill alpha
  }
}
