/**
 * Perceptual macro controls — simple surface + advanced depth.
 *
 * Seven macros map onto *safe* parameter combinations defined by the engine.
 * They do NOT introduce new DSP. Each macro's `apply` writes a patch of
 * existing parameters via store.setParameters.
 *
 * Advanced view reveals the actual detailed controls — same engine, clearer language.
 */

import { $, el, replaceChildren } from './dom.js';

const MACROS = [
  {
    id: 'body',
    label: 'Body',
    desc: 'Weight in the low-mids. Warmth 120 Hz + Body 350 Hz + subtle Sub.',
    min: 0, max: 100, def: 50,
    toDisplay: (v) => (v === 50 ? 'flat' : v > 50 ? `+${v - 50}` : `${v - 50}`),
    apply: (v, base) => {
      const t = (v - 50) / 50; // -1..1
      if (Math.abs(t) < 0.05) return { warm: 0, body: 0, sub: 0, tilt: clampTilt(base.tilt, 0.2) };
      const warm = Math.round(t * 3.2 * 10) / 10;
      const body = Math.round(t * 2.2 * 10) / 10;
      const sub = Math.round(t * 1.1 * 10) / 10;
      return { warm: clamp(warm, -6, 6), body: clamp(body, -5, 5), sub: clamp(sub, -3, 3) };
    },
  },
  {
    id: 'clarity',
    label: 'Clarity',
    desc: 'Presence without harshness. Lifts 5 kHz, gently tames 2.8 kHz.',
    min: 0, max: 100, def: 50,
    toDisplay: (v) => (v === 50 ? 'neutral' : v > 50 ? `+${v - 50}` : `${v - 50}`),
    apply: (v) => {
      const t = (v - 50) / 50;
      if (Math.abs(t) < 0.05) return { clarity: 0, harsh: 0 };
      return { clarity: clamp(t * 3.0, -4, 4), harsh: clamp(-t * 1.2, -2, 2) };
    },
  },
  {
    id: 'punch',
    label: 'Punch',
    desc: 'Density & transient control. Multiband glue + gentle shaper.',
    min: 0, max: 100, def: 30,
    toDisplay: (v) => (v < 20 ? 'open' : v < 45 ? 'glue' : v < 75 ? 'firm' : 'dense'),
    apply: (v) => {
      const t = v / 100;
      if (t < 0.12) return { mbLow: 0, mbMid: 0, mbHigh: 0, mbMix: 100, transAttack: 0, transSustain: 0 };
      return {
        mbLow: Math.round(t * 32),
        mbMid: Math.round(t * 26),
        mbHigh: Math.round(t * 18),
        mbMix: Math.round(92 - t * 18),
        transAttack: Math.round(t * 18),
        transSustain: Math.round(t * 10),
      };
    },
  },
  {
    id: 'air',
    label: 'Air',
    desc: 'Top octave openness. High shelf 12 kHz + tilt lift.',
    min: 0, max: 100, def: 50,
    toDisplay: (v) => (v === 50 ? 'flat' : v > 50 ? `+${v - 50}` : `${v - 50}`),
    apply: (v, base) => {
      const t = (v - 50) / 50;
      if (Math.abs(t) < 0.05) return { air: 0 };
      const air = clamp(t * 3.5, -5, 5);
      // tilt nudges subtly with air so the shelf doesn't feel isolated
      const tiltTarget = clamp(t * 0.8, -1.2, 1.2);
      const tilt = Math.abs(base.tilt - tiltTarget) > 0.3 ? tiltTarget : base.tilt;
      return { air: Math.round(air * 10) / 10, tilt: Math.round(tilt * 10) / 10 };
    },
  },
  {
    id: 'width',
    label: 'Width',
    desc: 'Stereo field. Balanced width + per-band shaping + mono bass anchor.',
    min: 0, max: 100, def: 50,
    toDisplay: (v) => (v < 30 ? 'narrow' : v < 55 ? 'natural' : v < 78 ? 'wide' : 'extra-wide'),
    apply: (v) => {
      const t = (v - 50) / 50; // -1..1
      if (Math.abs(t) < 0.08) return { width: 1, widthLow: 1, widthMid: 1, widthHigh: 1, bassMono: 0 };
      const width = clamp(1 + t * 0.45, 0.6, 1.75);
      return {
        width: Math.round(width * 100) / 100,
        widthLow: Math.round(clamp(1 + t * 0.18, 0.7, 1.3) * 100) / 100,
        widthMid: Math.round(clamp(1 + t * 0.32, 0.8, 1.45) * 100) / 100,
        widthHigh: Math.round(clamp(1 + t * 0.5, 0.85, 1.9) * 100) / 100,
        bassMono: v > 58 ? 65 : 0,
      };
    },
  },
  {
    id: 'depth',
    label: 'Depth',
    desc: 'Space in front of the speakers. Early reflections + subtle spread.',
    min: 0, max: 100, def: 0,
    toDisplay: (v) => (v < 8 ? 'dry' : v < 30 ? 'room' : v < 60 ? 'hall' : 'deep'),
    apply: (v) => {
      const t = v / 100;
      if (t < 0.06) return { depth: 0, depthSize: 'med', spread: 0 };
      return {
        depth: Math.round(t * 55),
        depthSize: t > 0.62 ? 'large' : t > 0.32 ? 'med' : 'small',
        spread: Math.round(t * 0.35 * 100) / 100,
      };
    },
  },
  {
    id: 'character',
    label: 'Character',
    desc: 'Stylised degradation. Tape + hysteresis-free saturation.',
    min: 0, max: 100, def: 0,
    toDisplay: (v) => (v < 8 ? 'clean' : v < 30 ? 'warm' : v < 60 ? 'textured' : 'worn'),
    apply: (v) => {
      const t = v / 100;
      if (t < 0.06) return { tape: 0, sat: 0, hiss: 0, vinyl: 0 };
      return {
        tape: Math.round(t * 55),
        sat: Math.round(t * 14),
        hiss: Math.round(t * (t > 0.5 ? 18 : 6)),
        vinyl: Math.round(t > 0.65 ? (t - 0.65) * 55 : 0),
      };
    },
  },
];

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function clampTilt(v, delta) { return Math.abs(v) < delta ? 0 : v; }

export function initMacroControls(opts) {
  const { store, pushParameters } = opts;
  const grid = $('#macroGrid');
  const advancedHost = $('#macroAdvancedCards');
  const toggle = $('#macroAdvancedToggle');
  const advancedPanel = $('#macroAdvanced');
  if (!grid) return { sync: () => {} };

  // Build macro sliders
  const controls = new Map();

  for (const m of MACROS) {
    const readout = el('span', { class: 'macro-val', text: m.toDisplay(m.def) });
    const desc = el('div', { class: 'macro-desc', text: m.desc });
    const input = el('input', {
      type: 'range',
      min: String(m.min),
      max: String(m.max),
      step: '1',
      value: String(m.def),
      'aria-label': m.label,
      'aria-valuetext': m.toDisplay(m.def),
      oninput: (e) => {
        const v = Number(e.target.value);
        readout.textContent = m.toDisplay(v);
        e.target.setAttribute('aria-valuetext', m.toDisplay(v));
        e.target.parentElement?.classList.toggle('active', Math.abs(v - m.def) > 3);
        // Apply to engine
        const patch = m.apply(v, store.getParameters());
        store.setParameters(patch, { history: false });
        // Use pushParameters if provided, else rely on store subscription
        if (pushParameters) pushParameters();
        else store.setUi({ presetName: 'Custom' });
      },
      onchange: (e) => {
        // Commit to history on release
        const v = Number(e.target.value);
        const patch = m.apply(v, store.getParameters());
        store.setParameters(patch, { history: true });
        if (pushParameters) pushParameters();
        store.setUi({ presetName: 'Custom' });
      },
      ondblclick: (e) => {
        e.target.value = String(m.def);
        e.target.dispatchEvent(new Event('input', { bubbles: true }));
        e.target.dispatchEvent(new Event('change', { bubbles: true }));
      },
    });
    const card = el('div', { class: 'macro', dataset: { macro: m.id } }, [
      el('div', { class: 'macro-hd' }, [el('span', { class: 'macro-label', text: m.label }), readout]),
      desc,
      input,
    ]);
    // Fine-adjust with shift
    input.addEventListener('wheel', (e) => {
      if (!e.shiftKey) return;
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      input.value = String(clamp(Number(input.value) + dir, m.min, m.max));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, { passive: false });
    controls.set(m.id, { input, readout, card, spec: m });
    grid.append(card);
  }

  // Sync from parameters (when preset applied externally)
  const sync = () => {
    const p = store.getParameters();
    // Heuristic reverse mapping for display — derive macro position from current params
    // This is approximate; the defining truth is the macro's forward apply.
    const estimates = new Map();
    // body ~ warm
    estimates.set('body', 50 + clamp(p.warm, -6, 6) / 6 * 50);
    estimates.set('clarity', 50 + clamp(p.clarity, -4, 4) / 4 * 50);
    estimates.set('punch', Math.min(100, Math.max(0, (p.mbLow + p.mbMid + p.mbHigh) / 76 * 100)));
    estimates.set('air', 50 + clamp(p.air, -5, 5) / 5 * 50);
    estimates.set('width', 50 + (p.width - 1) / 0.6 * 50);
    estimates.set('depth', p.depth);
    estimates.set('character', Math.min(100, p.tape * 1.1 + p.sat * 1.2));

    for (const [id, ctrl] of controls) {
      const est = estimates.get(id);
      if (est == null || !Number.isFinite(est)) continue;
      const v = Math.round(clamp(est, ctrl.spec.min, ctrl.spec.max));
      // Avoid fighting the user while dragging
      if (document.activeElement === ctrl.input) continue;
      ctrl.input.value = String(v);
      ctrl.readout.textContent = ctrl.spec.toDisplay(v);
      ctrl.input.setAttribute('aria-valuetext', ctrl.spec.toDisplay(v));
      ctrl.card.classList.toggle('active', Math.abs(v - ctrl.spec.def) > 3);
    }

    // Advanced cards — show current values of underlying params
    if (advancedHost) {
      const vals = [
        { k: 'warm', label: 'Warmth' }, { k: 'clarity', label: 'Clarity' }, { k: 'air', label: 'Air' },
        { k: 'mbLow', label: 'MB Low' }, { k: 'width', label: 'Width' }, { k: 'depth', label: 'Depth' },
        { k: 'tape', label: 'Tape' }, { k: 'sat', label: 'Sat' },
      ];
      replaceChildren(
        advancedHost,
        ...vals.map(({ k, label }) => {
          const spec = p[k];
          const display = typeof spec === 'number' ? (Number.isInteger(spec) ? String(spec) : spec.toFixed(1)) : String(spec);
          return el('div', { class: `module-card${  Math.abs(spec) < 0.01 ? ' bypassed' : ''}`, style: 'padding:10px;' }, [
            el('div', { class: 'mc-name', text: label, style: 'font:700 10px var(--mono); letter-spacing:0.08em; text-transform:uppercase;' }),
            el('div', { class: 'mc-values', text: display, style: 'margin-top:4px; color:var(--text);' }),
          ]);
        }),
      );
    }
  };

  // Toggle advanced
  if (toggle && advancedPanel) {
    toggle.addEventListener('click', () => {
      const open = advancedPanel.hidden;
      advancedPanel.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = open ? 'Advanced ▴' : 'Advanced ▾';
    });
  }

  store.subscribe((_s, changed) => {
    if (changed.has('parameters')) sync();
  });
  sync();
  return { sync, macros: MACROS };
}

export { MACROS };
