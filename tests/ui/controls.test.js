/**
 * @vitest-environment jsdom
 *
 * jsdom tests for the schema-driven control layer and the DOM-safety helpers.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { initControls } from '../../src/ui/controls.js';
import { initTabs } from '../../src/ui/tabs.js';
import { initSignalFlow } from '../../src/ui/signal-flow.js';
import { initPresetPanel } from '../../src/ui/presets-panel.js';
import { el, formatTime, formatBytes } from '../../src/ui/dom.js';
import { fuzzyMatch } from '../../src/ui/command-palette.js';
import { createStore } from '../../src/app/state.js';
import { PARAMETER_LIST } from '../../src/app/parameters.js';
import { SIGNAL_FLOW } from '../../src/app/constants.js';
import { ALL_PRESETS } from '../../src/presets/index.js';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('el()', () => {
  it('sets text content, never HTML, for the `text` attribute', () => {
    const node = el('div', { text: '<img src=x onerror=alert(1)>' });
    expect(node.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(node.querySelector('img')).toBeNull();
    expect(node.children).toHaveLength(0);
  });

  it('appends string children as text nodes', () => {
    const node = el('div', {}, ['<b>bold</b>']);
    expect(node.querySelector('b')).toBeNull();
    expect(node.textContent).toBe('<b>bold</b>');
  });

  it('applies classes, attributes, datasets and listeners', () => {
    let clicked = false;
    const node = el('button', {
      class: 'x',
      'aria-pressed': 'false',
      dataset: { module: 'tone' },
      onclick: () => {
        clicked = true;
      },
    });
    expect(node.className).toBe('x');
    expect(node.getAttribute('aria-pressed')).toBe('false');
    expect(node.dataset.module).toBe('tone');
    node.click();
    expect(clicked).toBe(true);
  });

  it('skips null, undefined and false values', () => {
    const node = el('div', { title: null, hidden: false, id: undefined }, [null, false, undefined]);
    expect(node.hasAttribute('title')).toBe(false);
    expect(node.hasAttribute('hidden')).toBe(false);
    expect(node.childNodes).toHaveLength(0);
  });
});

describe('formatters', () => {
  it('formats time as m:ss', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(65)).toBe('1:05');
    expect(formatTime(3599)).toBe('59:59');
    expect(formatTime(-5)).toBe('0:00');
    expect(formatTime(NaN)).toBe('0:00');
  });

  it('formats byte counts', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 kB');
    expect(formatBytes(5 * 1024 ** 2)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.00 GB');
  });
});

describe('fuzzyMatch', () => {
  it('matches subsequences case-insensitively', () => {
    expect(fuzzyMatch('tg', 'Tape Ghost')).toBe(true);
    expect(fuzzyMatch('tape', 'Tape Ghost')).toBe(true);
    expect(fuzzyMatch('', 'anything')).toBe(true);
    expect(fuzzyMatch('zzz', 'Tape Ghost')).toBe(false);
  });
});

describe('schema-driven controls', () => {
  const setup = (group) => {
    document.body.innerHTML = `<div data-controls="${group}"></div>`;
    const store = createStore();
    const controls = initControls({ store });
    return { store, controls, host: document.querySelector(`[data-controls="${group}"]`) };
  };

  it('renders one control per parameter in the group', () => {
    const { host } = setup('tone');
    const expected = PARAMETER_LIST.filter((s) => s.group === 'tone').length;
    expect(host.children).toHaveLength(expected);
  });

  it('associates every label with its input', () => {
    const { host } = setup('tone');
    for (const label of host.querySelectorAll('label')) {
      const target = document.getElementById(label.getAttribute('for'));
      expect(target, `no input for label "${label.textContent}"`).toBeTruthy();
    }
  });

  it('gives every range an aria-valuetext carrying the formatted value and unit', () => {
    const { host } = setup('tone');
    const range = host.querySelector('#p-warm');
    expect(range.getAttribute('aria-valuetext')).toBe('0.0 dB');
    expect(range.min).toBe('-12');
    expect(range.max).toBe('12');
  });

  it('writes changes into the store, clamped', () => {
    const { store, host } = setup('tone');
    const range = host.querySelector('#p-warm');
    range.value = '3.5';
    range.dispatchEvent(new Event('input'));
    expect(store.getParameters().warm).toBe(3.5);
  });

  it('reflects store changes back into the DOM', () => {
    const { store, host } = setup('tone');
    store.setParameter('warm', -4.2);
    const range = host.querySelector('#p-warm');
    expect(Number(range.value)).toBeCloseTo(-4.2, 6);
    expect(range.getAttribute('aria-valuetext')).toBe('-4.2 dB');
  });

  it('supports fine tuning with Shift and resets to the schema default on double-click', () => {
    const { store, host } = setup('tone');
    const range = host.querySelector('#p-warm');
    range.value = '1.23';
    const input = new Event('input');
    Object.defineProperty(input, 'shiftKey', { value: true });
    range.dispatchEvent(input);
    expect(store.getParameters().warm).toBeCloseTo(1.23, 6);
    range.dispatchEvent(new Event('dblclick'));
    expect(store.getParameters().warm).toBe(0);
  });

  it('badges parameters the live monitor cannot honour', () => {
    document.body.innerHTML = '<div data-controls="loudness"></div>';
    initControls({ store: createStore() });
    const ceilingRow = document.querySelector('#p-ceiling').closest('.ctl');
    expect(ceilingRow.querySelector('.badge-note')).toBeTruthy();
    const targetRow = document.querySelector('#p-targetLUFS').closest('.ctl');
    expect(targetRow.querySelector('.badge-note')).toBeNull();
  });

  it('renders booleans as role="switch" with aria-checked', () => {
    document.body.innerHTML = '<div data-controls="loudness"></div>';
    const store = createStore();
    initControls({ store });
    const toggle = document.querySelector('#p-normalize');
    expect(toggle.getAttribute('role')).toBe('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    toggle.click();
    expect(store.getParameters().normalize).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('renders enums as selects containing exactly the allowed values', () => {
    document.body.innerHTML = '<div data-controls="dynamics"></div>';
    const store = createStore();
    initControls({ store });
    const select = document.querySelector('#p-mbSpeed');
    expect([...select.options].map((o) => o.value)).toEqual(['fast', 'med', 'slow']);
    select.value = 'slow';
    select.dispatchEvent(new Event('change'));
    expect(store.getParameters().mbSpeed).toBe('slow');
  });

  it('disables the loudness target when normalisation is off', () => {
    document.body.innerHTML = '<div data-controls="loudness"></div>';
    const store = createStore();
    initControls({ store });
    const target = document.querySelector('#p-targetLUFS');
    expect(target.disabled).toBe(false);
    store.setParameter('normalize', false);
    expect(target.disabled).toBe(true);
  });

  it('honours a data-exclude list and a single data-control host', () => {
    document.body.innerHTML =
      '<div data-controls="character" data-exclude="textureSeed"></div>' +
      '<div data-control="textureSeed"></div>';
    initControls({ store: createStore() });
    const group = document.querySelector('[data-controls="character"]');
    expect(group.querySelector('#p-textureSeed')).toBeNull();
    expect(document.querySelector('[data-control="textureSeed"] #p-textureSeed')).toBeTruthy();
  });
});

describe('tabs', () => {
  const setup = () => {
    document.body.innerHTML = `
      <div class="tabs" role="tablist">
        <button class="tab" data-tab="a" aria-selected="true">A</button>
        <button class="tab" data-tab="b" aria-selected="false">B</button>
        <button class="tab" data-tab="c" aria-selected="false">C</button>
      </div>
      <div class="tpanel" data-tab="a"></div>
      <div class="tpanel" data-tab="b"></div>
      <div class="tpanel" data-tab="c"></div>`;
    return initTabs({});
  };

  it('applies the ARIA tab pattern', () => {
    setup();
    const tabs = [...document.querySelectorAll('.tab')];
    for (const tab of tabs) {
      expect(tab.getAttribute('role')).toBe('tab');
      expect(tab.getAttribute('aria-controls')).toBe(`panel-${tab.dataset.tab}`);
    }
    for (const panel of document.querySelectorAll('.tpanel')) {
      expect(panel.getAttribute('role')).toBe('tabpanel');
      expect(panel.getAttribute('aria-labelledby')).toBe(`tab-${panel.dataset.tab}`);
    }
  });

  it('keeps only the active tab in the tab order', () => {
    setup();
    const tabs = [...document.querySelectorAll('.tab')];
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    tabs[1].click();
    expect(tabs.map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
  });

  it('shows exactly one panel', () => {
    setup();
    document.querySelectorAll('.tab')[2].click();
    const visible = [...document.querySelectorAll('.tpanel')].filter((p) => !p.hidden);
    expect(visible).toHaveLength(1);
    expect(visible[0].dataset.tab).toBe('c');
  });

  it('moves between tabs with the arrow keys and wraps', () => {
    setup();
    const tabs = [...document.querySelectorAll('.tab')];
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(tabs[2].getAttribute('aria-selected')).toBe('true');
    tabs[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(tabs[2].getAttribute('aria-selected')).toBe('true');
  });

  it('reports the selected tab to the caller', () => {
    document.body.innerHTML = `
      <div class="tabs"><button class="tab" data-tab="a" aria-selected="true">A</button>
      <button class="tab" data-tab="b" aria-selected="false">B</button></div>
      <div class="tpanel" data-tab="a"></div><div class="tpanel" data-tab="b"></div>`;
    const seen = [];
    const tabs = initTabs({ onChange: (id) => seen.push(id) });
    tabs.select('b');
    expect(seen).toEqual(['a', 'b']);
  });
});

describe('signal flow', () => {
  it('renders a node for every stage plus the terminals', () => {
    document.body.innerHTML = '<div id="signalFlow"></div>';
    const store = createStore();
    initSignalFlow({ store });
    const host = document.querySelector('#signalFlow');
    expect(host.textContent).toContain('INPUT');
    expect(host.textContent).toContain('EXPORT');
    for (const module of SIGNAL_FLOW) expect(host.textContent).toContain(module.label);
  });

  it('makes export-only stages non-interactive and marks them', () => {
    document.body.innerHTML = '<div id="signalFlow"></div>';
    initSignalFlow({ store: createStore() });
    const buttons = [...document.querySelectorAll('button.flow-node')];
    const bypassable = SIGNAL_FLOW.filter((m) => !m.exportOnly);
    expect(buttons).toHaveLength(bypassable.length);
    expect(document.querySelectorAll('.flow-node.export-only').length).toBe(
      SIGNAL_FLOW.length - bypassable.length,
    );
  });

  it('toggles bypass and reflects it in aria-pressed', () => {
    document.body.innerHTML = '<div id="signalFlow"></div>';
    const store = createStore();
    initSignalFlow({ store });
    const toneNode = document.querySelector('[data-module="tone"]');
    expect(toneNode.getAttribute('aria-pressed')).toBe('false');
    toneNode.click();
    expect(store.getState().ui.moduleBypass.tone).toBe(true);
    expect(toneNode.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('preset panel', () => {
  it('renders every preset as a button with its description', () => {
    document.body.innerHTML = '<div id="presetGroups"></div><div id="presetAudit"></div>';
    initPresetPanel({ onApply: () => {}, getActiveName: () => 'Transparent' });
    const cards = [...document.querySelectorAll('.preset')];
    expect(cards).toHaveLength(ALL_PRESETS.length);
    for (const preset of ALL_PRESETS) {
      const card = [...document.querySelectorAll('.preset')].find(
        (n) => n.dataset.preset === preset.name,
      );
      expect(card, `${preset.name} card missing`).toBeTruthy();
      expect(card.textContent).toContain(preset.description);
    }
  });

  it('marks the active preset with aria-pressed', () => {
    document.body.innerHTML = '<div id="presetGroups"></div><div id="presetAudit"></div>';
    const panel = initPresetPanel({ onApply: () => {}, getActiveName: () => 'Tape Ghost' });
    panel.sync();
    const pressed = [...document.querySelectorAll('.preset[aria-pressed="true"]')];
    expect(pressed).toHaveLength(1);
    expect(pressed[0].dataset.preset).toBe('Tape Ghost');
  });

  it('shows the audit note when a preset is applied', () => {
    document.body.innerHTML = '<div id="presetGroups"></div><div id="presetAudit"></div>';
    let applied = null;
    const panel = initPresetPanel({
      onApply: (p) => {
        applied = p;
      },
      getActiveName: () => 'Transparent',
    });
    document.querySelector('[data-preset="Rust"]').click();
    expect(applied.name).toBe('Rust');
    panel.showAudit(applied);
    const audit = document.querySelector('#presetAudit');
    expect(audit.hidden).toBe(false);
    expect(audit.textContent).toContain('Rust');
  });

  it('flags risky presets visibly', () => {
    document.body.innerHTML = '<div id="presetGroups"></div><div id="presetAudit"></div>';
    initPresetPanel({ onApply: () => {}, getActiveName: () => '' });
    const panoramic = document.querySelector('[data-preset="Panoramic"]');
    expect(panoramic.querySelector('.risk.destructive')).toBeTruthy();
    const transparent = document.querySelector('[data-preset="Transparent"]');
    expect(transparent.querySelector('.risk')).toBeNull();
  });
});
