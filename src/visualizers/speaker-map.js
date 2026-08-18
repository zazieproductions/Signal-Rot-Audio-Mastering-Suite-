/**
 * Immersive speaker map.
 *
 * Plan view looking down on the listener, who faces the top of the canvas. Speaker
 * positions come straight from the layout table, so the map cannot disagree with the
 * metadata: both read `azimuthHrtf` (positive = right) for screen placement, and the
 * label shows the ADM azimuth (positive = left) so the two conventions are visible
 * side by side rather than silently conflated.
 *
 * Height speakers are drawn on an inner ring in cyan; bed speakers on the outer ring in
 * orange; subwoofers as squares.
 */

import { LAYOUTS, SPEAKERS } from '../audio/immersive/layouts.js';
import { resizeCanvas, cssVar, withAlpha, getScratch } from './canvas-util.js';

const TAU = Math.PI * 2;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} opts
 * @param {string} opts.layoutId
 * @param {string} opts.target
 * @param {AnalyserNode|null} [opts.analyserL]
 * @param {AnalyserNode|null} [opts.analyserR]
 * @param {object} opts.params immersive parameters, for level estimation
 */
export function drawSpeakerMap(canvas, opts) {
  const surface = resizeCanvas(canvas, 240);
  if (!surface) return;
  const { ctx, width, height } = surface;
  ctx.clearRect(0, 0, width, height);

  const layout = LAYOUTS[opts.layoutId];
  const cx = width / 2;
  const cy = height / 2 - 6;
  const R = Math.min(width, height) * 0.38;

  ctx.strokeStyle = cssVar('--line2');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([3, 4]);
  ctx.strokeStyle = cssVar('--grid');
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.55, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);

  // Listener, facing up.
  ctx.fillStyle = cssVar('--faint');
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, TAU);
  ctx.fill();
  ctx.font = '9px monospace';
  ctx.fillText('▲', cx - 3, cy - 7);

  if (!layout) {
    ctx.fillStyle = cssVar('--faint');
    ctx.fillText('Stereo — no immersive layout selected', 10, height - 8);
    return;
  }

  // Live level proxy from the stereo monitor bus.
  let levelMid = 0;
  let levelSide = 0;
  let levelL = 0;
  let levelR = 0;
  if (opts.analyserL && opts.analyserR) {
    const size = opts.analyserL.fftSize;
    const left = getScratch('mapL', size);
    const right = getScratch('mapR', size);
    opts.analyserL.getFloatTimeDomainData(left);
    opts.analyserR.getFloatTimeDomainData(right);
    for (let i = 0; i < size; i++) {
      const m = (left[i] + right[i]) * 0.5;
      const s = (left[i] - right[i]) * 0.5;
      levelMid += m * m;
      levelSide += s * s;
      levelL += left[i] * left[i];
      levelR += right[i] * right[i];
    }
    levelMid = Math.sqrt(levelMid / size);
    levelSide = Math.sqrt(levelSide / size);
    levelL = Math.sqrt(levelL / size);
    levelR = Math.sqrt(levelR / size);
  }

  const dbToGain = (db) => Math.pow(10, db / 20);
  const levelFor = (sp) => {
    if (sp.lfe) return levelMid * dbToGain(opts.params.lfeLevelDb);
    if (sp.id === 'C') return levelMid * opts.params.centerExtract;
    if (sp.id === 'L' || sp.id === 'SL1') return levelL;
    if (sp.id === 'R' || sp.id === 'SL2') return levelR;
    if (sp.elevation > 0) return levelSide * dbToGain(opts.params.heightLevelDb);
    return levelSide * dbToGain(opts.params.surrLevelDb);
  };

  const bedColor = cssVar('--proc');
  const heightColor = cssVar('--orig');

  for (const key of layout.channels) {
    const sp = SPEAKERS[key];
    if (!sp) continue;
    // Screen placement uses the HRTF convention (positive = right), which matches the
    // canvas x axis. Elevation pulls the marker toward the centre of the plan view.
    const az = (sp.azimuthHrtf * Math.PI) / 180;
    const elFactor = 1 - Math.min(0.45, Math.max(0, sp.elevation) / 90);
    const radius = R * elFactor * (sp.elevation < 0 ? 1.02 : 1);
    const x = cx + Math.sin(az) * radius;
    const y = cy - Math.cos(az) * radius * 0.84;
    const level = Math.min(1, levelFor(sp) * 6);
    const color = sp.elevation > 5 ? heightColor : bedColor;

    ctx.globalAlpha = 0.22 + level * 0.78;
    ctx.fillStyle = color;
    if (sp.lfe) {
      ctx.fillRect(x - 4.5, y - 4.5, 9, 9);
    } else {
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = cssVar('--muted');
    ctx.font = '8px monospace';
    const label = sp.id;
    ctx.fillText(label, x - ctx.measureText(label).width / 2, y + 16);
  }

  ctx.fillStyle = cssVar('--faint');
  ctx.font = '9px monospace';
  const targetLabel =
    opts.target === 'adm'
      ? 'ADM BWF'
      : opts.target === 'binaural'
        ? 'binaural'
        : 'multichannel WAV';
  ctx.fillText(`${layout.name} · ${layout.channels.length} ch · ${targetLabel}`, 8, height - 7);

  ctx.fillStyle = heightColor;
  ctx.fillText('● height', width - 70, 13);
  ctx.fillStyle = bedColor;
  ctx.fillText('● bed', width - 70, 25);
  ctx.fillStyle = withAlpha(bedColor, 0.9);
  ctx.fillText('■ sub', width - 70, 37);
}
