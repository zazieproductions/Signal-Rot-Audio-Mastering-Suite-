/**
 * A/B listening — central comparison strip.
 *
 * Provides: ORIGINAL / MASTERED / LOUDNESS-MATCHED toggle, blind mode, dim, keyboard
 * hints. This module is the **single owner** of `store.ui.abMode` and
 * `store.ui.matchLoudness`: every A/B/C control (transport buttons, enhanced buttons,
 * keyboard) goes through `setAb` / `cycle` / `toggleMatch` here. The live-graph push and
 * meter repaint happen once, in the bootstrap store subscription, not per-click.
 *
 * Keyboard bindings themselves live in `command-palette.js` `initShortcuts` (one owner for
 * all global keys); the bootstrap wires them to the methods returned here.
 */

import { $ } from './dom.js';

const MODE_LABEL = {
  A: 'A · Original',
  B: 'B · Mastered',
  C: 'C · Level-matched',
};

export function initAbEnhanced(opts) {
  const { store } = opts;
  const abA = $('#abAenh') || $('#abA');
  const abB = $('#abBenh') || $('#abB');
  const abC = $('#abC');
  const blindBtn = $('#abBlindenh');
  const matchChip = $('#abMatchChip') || $('#matchLoudBtn');
  const loudnessBtn = $('#matchLoudBtn');
  const dimChip = $('#abDimChip');
  const hint = $('#abHint');
  const noop = { sync: () => {} };
  if (!abA || !abB) return noop;

  // Fallback pattern: when the enhanced buttons are absent `abA` IS `#abA`, so collect
  // each physical node once (a Set) — registering the same handler twice on one node made
  // blind mode flip twice per click, i.e. not at all.
  const aButtons = new Set([abA, $('#abA')].filter(Boolean));
  const bButtons = new Set([abB, $('#abB')].filter(Boolean));
  const cButtons = new Set([abC, $('#abC')].filter(Boolean));

  let blind = false;
  // Blind protocol: the two hidden slots MUST be the two different signals, or "blind
  // A/B" can hand the listener the same file twice and they will be scoring noise.
  let blindChoices = ['A', 'B'];
  let blindIndex = 0;

  const sync = () => {
    const { abMode, matchLoudness, abDim } = store.getState().ui;
    for (const btn of aButtons) btn.setAttribute('aria-pressed', String(abMode === 'A'));
    for (const btn of bButtons) btn.setAttribute('aria-pressed', String(abMode === 'B'));
    for (const btn of cButtons) btn.setAttribute('aria-pressed', String(abMode === 'C'));
    if (blindBtn) {
      blindBtn.setAttribute('aria-pressed', String(blind));
      blindBtn.textContent = blind ? '● Blind A/B' : 'Blind';
      blindBtn.title = blind
        ? 'Blind mode — labels hide which is which (press H to exit)'
        : 'Blind A/B — hide which is which (H)';
    }
    for (const btn of new Set([matchChip, loudnessBtn])) {
      if (btn) btn.setAttribute('aria-pressed', String(!!matchLoudness));
    }
    if (dimChip) dimChip.setAttribute('aria-pressed', String(!!abDim));
    if (hint) {
      if (blind) {
        hint.textContent = `◈ Blind ${blindIndex === 0 ? blindChoices[0] : blindChoices[1]} · press X to flip, H to exit`;
      } else {
        hint.textContent = `${MODE_LABEL[abMode] || ''}${matchLoudness ? ' · matched' : ''}${
          abDim ? ' · −12 dB dim' : ''
        }`;
      }
    }
  };

  // Dim lives in the store (ui.abDim); the monitor gain itself is applied by bootstrap so
  // the binaural preview and the dim cannot fight over the same node.

  /** Flip inside blind mode; set the mode otherwise. */
  const setAb = (mode) => {
    if (blind) {
      blindIndex = 1 - blindIndex;
      store.setUi({ abMode: blindChoices[blindIndex] });
    } else {
      store.setUi({ abMode: mode });
    }
    sync();
  };

  /** X / palette: Original → Mastered → Matched (flip while blind). */
  const cycle = () => {
    if (blind) {
      blindIndex = 1 - blindIndex;
      store.setUi({ abMode: blindChoices[blindIndex] });
      sync();
      return;
    }
    const cur = store.getState().ui.abMode;
    setAb(cur === 'A' ? 'B' : cur === 'B' ? 'C' : 'A');
  };

  const toggleBlind = () => {
    blind = !blind;
    if (blind) {
      blindChoices = Math.random() > 0.5 ? ['A', 'B'] : ['B', 'A'];
      blindIndex = 0;
      store.setUi({ abMode: blindChoices[blindIndex] });
    } else {
      // Exit blind: reveal which one was which — never silently leave a random mode.
      store.setUi({ abMode: blindChoices[blindIndex] });
    }
    sync();
  };

  const toggleMatch = () => {
    store.setUi({ matchLoudness: !store.getState().ui.matchLoudness });
    sync();
  };

  for (const btn of aButtons) btn.addEventListener('click', () => setAb('A'));
  for (const btn of bButtons) btn.addEventListener('click', () => setAb('B'));
  for (const btn of cButtons) btn.addEventListener('click', () => setAb('C'));
  if (blindBtn) blindBtn.addEventListener('click', toggleBlind);
  for (const btn of new Set([matchChip, loudnessBtn])) {
    btn?.addEventListener('click', toggleMatch);
  }
  dimChip?.addEventListener('click', () => {
    store.setUi({ abDim: !store.getState().ui.abDim });
    sync();
  });

  // No global keydown listener here: `command-palette.js` `initShortcuts` owns all global
  // keys, and duplicate window-level listeners were double-firing A/B/X/M per press.

  store.subscribe((_s, changed) => {
    if (changed.has('ui')) sync();
  });
  sync();
  return {
    sync,
    setAb,
    cycle,
    toggleMatch,
    toggleBlind,
    get blind() {
      return blind;
    },
  };
}
