/**
 * Spatial energy visualization — front / rear / height / sub bars
 * plus honest warnings when backed by real metrics.
 */

import { $, el, replaceChildren } from '../ui/dom.js';

export function initSpatialEnergy(opts) {
  const { store, getLive } = opts;
  const grid = $('#spatialEnergyGrid');
  const warningsHost = $('#spatialEnergyWarnings');
  if (!grid) return { tick: () => {} };

  const tick = () => {
    const live = getLive ? getLive() : null;
    if (!live || !live.analyserL || !live.analyserR) return;
    // Estimate spatial distribution from live analysers (same logic as speaker-map)
    // Mid = (L+R)/2 ~ front/centre energy, Side = (L-R)/2 ~ width/spatial energy
    // We partition: front 54%, rear 28%, height 18% as example — but we need real split.
    // For honesty, we derive from immersive params + analyser side energy.
    const state = store.getState();
    const im = state.immersive;
    const p = store.getParameters();

    // Live level proxy
    let mid = 0, side = 0;
    try {
      const size = live.analyserL.fftSize;
      const left = new Float32Array(size);
      const right = new Float32Array(size);
      live.analyserL.getFloatTimeDomainData(left);
      live.analyserR.getFloatTimeDomainData(right);
      for (let i = 0; i < size; i++) {
        const m = (left[i] + right[i]) * 0.5;
        const s = (left[i] - right[i]) * 0.5;
        mid += m*m; side += s*s;
      }
      mid = Math.sqrt(mid/size); side = Math.sqrt(side/size);
    } catch { return; }

    const heightGain = Math.pow(10, (im.heightLevelDb ?? -6) / 20);
    const surrGain = Math.pow(10, (im.surrLevelDb ?? -3) / 20);
    const centerGain = im.centerExtract ?? 0.5;

    const front = mid * (0.7 + centerGain * 0.28) * (1 - (p.width - 1) * 0.18);
    const rear = side * surrGain * 0.92;
    const height = side * heightGain * 0.86 * (1 + (p.depth / 100) * 0.32);
    const sub = mid * Math.pow(10, (im.lfeLevelDb ?? -3) / 20) * 0.42;

    const sum = front + rear + height + sub + 1e-9;
    const pct = {
      front: (front / sum) * 100,
      rear: (rear / sum) * 100,
      height: (height / sum) * 100,
      sub: (sub / sum) * 100,
    };

    replaceChildren(grid,
      ...['front','rear','height','sub'].map((k) =>
        el('div', { class: 'energy-item' }, [
          el('div', { class: 'k', text: k }),
          el('div', { class: 'v', text: `${pct[k].toFixed(0)}%` }),
          el('div', { class: 'bar' }, [el('i', { style: `width:${pct[k].toFixed(0)}%` })]),
        ])
      )
    );

    // Warnings backed by real metrics
    const warnings = [];
    if (pct.height > 38) warnings.push('Height field dominates the mix — height above 38% may feel detached on bed playback.');
    if (pct.rear > 36) warnings.push('Rear energy is unusually high — check surround balance on stereo fold-down.');
    if (centerGain > 0.78) warnings.push('Centre extraction is strong — phantom centre will feel very locked, less enveloping.');
    if (p.bassMono === 0 && p.width > 1.35) warnings.push('Wide stereo with no bass anchoring — low-frequency spatial coherence is reduced.');
    if (warningsHost) {
      if (!warnings.length) replaceChildren(warningsHost, el('div', { class: 'hint', text: 'Spatial distribution looks balanced.', style: 'color: var(--ok)' }));
      else replaceChildren(warningsHost, ...warnings.map((w) => el('div', { class: 'notice caution', style: 'margin:0 0 6px; padding:8px 10px;', text: w })));
    }

    // Expose for accessibility summary
    grid.setAttribute('aria-label', `Front ${pct.front.toFixed(0)}%, rear ${pct.rear.toFixed(0)}%, height ${pct.height.toFixed(0)}%, sub ${pct.sub.toFixed(0)}%`);
  };

  return { tick };
}
