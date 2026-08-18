/**
 * Schema-driven control rendering.
 *
 * Every slider, select and toggle in the application is generated from
 * `app/parameters.js`. The audited build had 42 hand-written lines in `syncControls()`
 * plus ~40 `bindRange()` calls, each repeating the same unit conversion and formatter —
 * which is exactly how the UI came to say "700 Hz" about a 350 Hz filter.
 *
 * A control is declared in the HTML as:
 *
 * ```html
 * <div data-controls="tone"></div>
 * ```
 *
 * and every parameter whose `group` is `tone` appears there, in schema order, with its
 * label, unit, formatter, hint, and an "export only" badge if it is not honoured in the
 * live preview.
 *
 * ── Accessibility ────────────────────────────────────────────────────────────────────
 *  · Each range gets a real `<label for>` association and an `aria-valuetext` carrying the
 *    formatted value with its unit, so a screen reader says "Warmth, 1.6 dB", not
 *    "slider, 1.6".
 *  · Toggles are `role="switch"` with `aria-checked` and are keyboard operable.
 *  · Disabled states are set with the `disabled` attribute, not with opacity alone.
 */

import { PARAMETER_LIST, PARAMETERS, formatParameter } from '../app/parameters.js';
import { el, $$, replaceChildren } from './dom.js';

/**
 * @param {object} opts
 * @param {import('../app/state.js').Store} opts.store
 * @param {(key:string)=>void} [opts.onChange]
 */
export function initControls(opts) {
  const { store } = opts;
  /** @type {Map<string, {update:(value:any, params:any)=>void}>} */
  const bindings = new Map();

  for (const container of $$('[data-controls]')) {
    const group = container.dataset.controls;
    const specs = PARAMETER_LIST.filter((s) => s.group === group && !s.uiHidden);
    const nodes = [];
    for (const spec of specs) {
      if (container.dataset.exclude && container.dataset.exclude.split(',').includes(spec.key)) {
        continue;
      }
      const built = buildControl(spec, store, opts.onChange);
      if (!built) continue;
      bindings.set(spec.key, built.binding);
      nodes.push(built.node);
    }
    replaceChildren(container, ...nodes);
  }

  // Controls declared individually, e.g. `data-control="targetLUFS"`, for panels that
  // need bespoke ordering around them.
  for (const host of $$('[data-control]')) {
    const spec = PARAMETERS[host.dataset.control];
    if (!spec || bindings.has(spec.key)) continue;
    const built = buildControl(spec, store, opts.onChange);
    if (!built) continue;
    bindings.set(spec.key, built.binding);
    replaceChildren(host, built.node);
  }

  const sync = () => {
    const params = store.getParameters();
    for (const [key, binding] of bindings) binding.update(params[key], params);
  };

  store.subscribe((_state, changed) => {
    if (changed.has('parameters')) sync();
  });
  sync();

  return { sync, keys: [...bindings.keys()] };
}

function badgeFor(spec) {
  if (spec.previewSupported) return null;
  const isExportOnly = spec.exportSupported;
  return el('span', {
    class: `badge-note ${isExportOnly ? 'export-only' : 'approx'}`,
    text: isExportOnly ? 'export only' : 'monitor only',
    title: spec.previewNote ?? '',
  });
}

/**
 * @param {import('../app/parameters.js').ParameterSpec} spec
 * @param {import('../app/state.js').Store} store
 * @param {(key:string)=>void} [onChange]
 */
function buildControl(spec, store, onChange) {
  const id = `p-${spec.key}`;
  const valueId = `${id}-value`;
  const hintId = `${id}-hint`;

  const commit = (value) => {
    store.setParameter(spec.key, value);
    if (onChange) onChange(spec.key);
  };

  if (spec.type === 'boolean') {
    const toggle = el('button', {
      type: 'button',
      class: 'tog',
      role: 'switch',
      'aria-checked': 'false',
      id,
      onclick: () => commit(!store.getParameters()[spec.key]),
    });
    const node = el('div', { class: 'togrow' }, [
      el('label', { for: id }, [
        document.createTextNode(spec.label),
        badgeFor(spec),
        spec.hint ? el('div', { class: 'sub', id: hintId, text: spec.hint }) : null,
      ]),
      toggle,
    ]);
    if (spec.hint) toggle.setAttribute('aria-describedby', hintId);
    return {
      node,
      binding: {
        update(value) {
          toggle.setAttribute('aria-checked', String(!!value));
        },
      },
    };
  }

  if (spec.type === 'enum') {
    const select = el(
      'select',
      { id, onchange: (e) => commit(coerceEnum(spec, e.target.value)) },
      spec.values.map((v) =>
        el('option', {
          value: String(v),
          text: spec.enumLabels?.[String(v)] ?? formatEnum(spec, v),
        }),
      ),
    );
    const node = el('div', { class: 'field' }, [
      el('label', { class: 'fl', for: id }, [document.createTextNode(spec.label), badgeFor(spec)]),
      select,
      spec.hint ? el('div', { class: 'sub', id: hintId, text: spec.hint }) : null,
    ]);
    if (spec.hint) select.setAttribute('aria-describedby', hintId);
    return {
      node,
      binding: {
        update(value) {
          select.value = String(value);
        },
      },
    };
  }

  if (spec.type === 'number') {
    const readout = el('span', { class: 'num', id: valueId, 'aria-hidden': 'true' });
    const input = el('input', {
      type: 'range',
      id,
      min: String(spec.min),
      max: String(spec.max),
      step: String(spec.step ?? 0.01),
      'aria-describedby': spec.hint ? hintId : undefined,
      oninput: (e) => commit(Number(e.target.value)),
    });
    const node = el('div', { class: 'ctl' }, [
      el('div', { class: 'row' }, [
        el('label', { for: id }, [document.createTextNode(spec.label), badgeFor(spec)]),
        readout,
      ]),
      input,
      spec.hint ? el('div', { class: 'sub', id: hintId, text: spec.hint }) : null,
    ]);
    return {
      node,
      binding: {
        update(value, params) {
          const formatted = formatParameter(spec.key, value);
          if (document.activeElement !== input) input.value = String(value);
          readout.textContent = formatted;
          // aria-valuetext is what a screen reader reads instead of the raw number.
          input.setAttribute('aria-valuetext', `${formatted}`);
          node.classList.toggle('is-default', value === spec.defaultValue);
          const disabled = isDisabled(spec, params);
          input.disabled = disabled;
          node.style.opacity = disabled ? '0.5' : '';
        },
      },
    };
  }

  // Array parameters (the match curve) are not directly editable; the match-curve
  // visualiser renders them.
  return null;
}

/** Enum values may be numbers (haasSide) — coerce back from the string the DOM gives us. */
function coerceEnum(spec, raw) {
  for (const v of spec.values) if (String(v) === raw) return v;
  return spec.defaultValue;
}

function formatEnum(spec, value) {
  try {
    return spec.displayFormatter(value);
  } catch {
    return String(value);
  }
}

/**
 * Cross-parameter enablement. Kept in one place so the rules are visible rather than
 * scattered through event handlers.
 */
function isDisabled(spec, params) {
  if (spec.key === 'targetLUFS' && !params.normalize) return true;
  if (spec.key === 'spread' && !params.binaural) return true;
  if (spec.key === 'matchStrength' && params.matchGains.every((g) => g === 0)) return true;
  return false;
}
