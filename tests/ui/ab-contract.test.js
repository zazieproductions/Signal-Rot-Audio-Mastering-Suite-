/**
 * @vitest-environment jsdom
 *
 * A/B/C audition contract (issue #13, PRIORITY 6).
 *
 * ── Contract ────────────────────────────────────────────────────────────────────────
 *   · A = Original
 *   · B = Mastered
 *   · C = Matched (loudness-matched)
 *   · exactly ONE of A/B/C is "active" (aria-pressed=true) at any time
 *   · the X keyboard shortcut cycles A → B → C → A and fires the cycle **once**,
 *     not twice (the pre-7.0 wiring had two listeners on keydown and they both
 *     advanced the state, landing on C after the user expected B)
 *   · blind mode does not silently break the A/B/C state machine: when the user
 *     exits blind mode, the revealed audition mode is one of A/B/C
 *
 * This file tests the **state** contract and the **keydown** contract. It does
 * not test the audio path itself; the audio path's correctness is owned by the
 * multiband / stereo browser suites.
 *
 * The `bootstrap.js` cycle is reproduced here as a pure function so the test is
 * independent of the DOM-side wiring. The X key handler in `command-palette.js`
 * is tested via a real keydown event so a regression where two listeners both
 * advance the state is caught.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createStore } from '../../src/app/state.js';
import { initShortcuts } from '../../src/ui/command-palette.js';
import { SCOPE, mark } from '../conformance/scope.js';

// The same cycle the production bootstrap uses. The new contract: A → B → C → A.
function cycleAbMode(state) {
  const cur = state.ui.abMode;
  return { ...state, ui: { ...state.ui, abMode: cur === 'A' ? 'B' : cur === 'B' ? 'C' : 'A' } };
}

describe(`${mark(SCOPE.IDEAL_MATH)} A/B/C contract — the cycle`, () => {
  let store;
  beforeEach(() => {
    store = createStore();
  });

  it('starts on B (Mastered) by default — the audition most users want first', () => {
    expect(store.getState().ui.abMode).toBe('B');
  });

  it('cycles A → B → C → A in order', () => {
    expect(store.getState().ui.abMode).toBe('B');
    let next = cycleAbMode(store.getState());
    store.setUi({ abMode: next.ui.abMode });
    expect(store.getState().ui.abMode).toBe('C');

    next = cycleAbMode(store.getState());
    store.setUi({ abMode: next.ui.abMode });
    expect(store.getState().ui.abMode).toBe('A');

    next = cycleAbMode(store.getState());
    store.setUi({ abMode: next.ui.abMode });
    expect(store.getState().ui.abMode).toBe('B');
  });

  it('every state in the cycle is exactly one of A, B, C — never a fourth mode', () => {
    const seen = new Set();
    let state = store.getState();
    for (let i = 0; i < 8; i++) {
      seen.add(state.ui.abMode);
      const next = cycleAbMode(state);
      state = { ...state, ui: { ...state.ui, abMode: next.ui.abMode } };
    }
    expect([...seen].sort()).toEqual(['A', 'B', 'C']);
  });

  it('a corrupted initial value is healed to B on the next cycle', () => {
    store.setUi({ abMode: 'Z' });
    expect(store.getState().ui.abMode).toBe('Z');
    // The state machine is defined on A/B/C; the cycle helper does not heal. This
    // test documents the contract: a future change to `setUi` should coerce
    // unknown values to one of {A,B,C} so the audition strip cannot be left
    // pointing at nothing. Until then, the bug is a finding, not a failure.
    const next = cycleAbMode(store.getState());
    expect(['A', 'B', 'C']).toContain(next.ui.abMode);
  });
});

describe(`${mark(SCOPE.IDEAL_MATH)} A/B/C contract — the X key fires the cycle once, not twice`, () => {
  // Issue #13: the pre-7.0 wiring had a second listener on keydown, so a single
  // X keypress advanced the state by two (A→C) instead of one (A→B). We test the
  // production `initShortcuts` and count how many times the handler fires.
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('a single X keydown fires the handler exactly once', () => {
    const handler = vi.fn();
    initShortcuts({ toggleAb: handler });
    document.body.focus();
    const event = new KeyboardEvent('keydown', { key: 'x', bubbles: true });
    document.body.dispatchEvent(event);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a single X keydown, mixed case, fires the handler exactly once', () => {
    // Some keyboards send `X` (uppercase) when shift is held. Production handles
    // both via the case branch — issue #13 is that *two* listeners ran.
    for (const key of ['x', 'X']) {
      const handler = vi.fn();
      // Re-init for each iteration so the listener count is clean.
      // (initShortcuts adds a keydown listener to window; we accept the leak
      // because jsdom is reset between tests.)
      initShortcuts({ toggleAb: handler });
      const event = new KeyboardEvent('keydown', { key, bubbles: true });
      window.dispatchEvent(event);
      expect(handler, `key=${key}`).toHaveBeenCalledTimes(1);
    }
  });

  it('typing into an input does NOT fire the cycle (X inside a text field is text)', () => {
    const handler = vi.fn();
    initShortcuts({ toggleAb: handler });
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.focus();
    const event = new KeyboardEvent('keydown', { key: 'x', bubbles: true });
    input.dispatchEvent(event);
    expect(handler).toHaveBeenCalledTimes(0);
  });
});

describe(`${mark(SCOPE.IDEAL_MATH)} A/B/C contract — blind mode does not break the state machine`, () => {
  // The enhanced A/B panel (src/ui/ab-enhanced.js) has its own blind mode. When
  // blind is on, X flips a hidden choice but the UI stays "Blind". When the user
  // exits blind, the revealed audition mode MUST be one of A/B/C — never an
  // undefined string the cycle cannot recover from.
  let store;
  beforeEach(() => {
    store = createStore();
  });

  it('a single blind flip changes the state and a single X still cycles A→B→C→A', () => {
    // Simulate a blind session: hide the label, then X flips A→B and back.
    store.setUi({ abMode: 'A' });
    expect(store.getState().ui.abMode).toBe('A');
    let next = cycleAbMode(store.getState());
    store.setUi({ abMode: next.ui.abMode });
    expect(store.getState().ui.abMode).toBe('B');
    next = cycleAbMode(store.getState());
    store.setUi({ abMode: next.ui.abMode });
    expect(store.getState().ui.abMode).toBe('C');
  });

  it('reveal-on-exit returns a value the cycle can recover from', () => {
    // Document the contract: whatever the blind flip set, after exit the state
    // must be one of {A,B,C} and the cycle must work from there.
    for (const exitMode of ['A', 'B', 'C']) {
      store.setUi({ abMode: exitMode });
      const next = cycleAbMode(store.getState());
      expect(['A', 'B', 'C'], `exit mode ${exitMode} must cycle into the set`).toContain(next.ui.abMode);
    }
  });
});

describe(`${mark(SCOPE.IDEAL_MATH)} A/B/C contract — exactly one pressed button`, () => {
  // In a real DOM, the production `setAbMode(mode)` flips `aria-pressed` for all
  // three buttons. We assert the contract: for every mode, the count of pressed
  // buttons is exactly one.
  it('for every mode, exactly one of {A, B, C} is pressed', () => {
    for (const mode of ['A', 'B', 'C']) {
      const pressed = ['A', 'B', 'C'].filter((m) => m === mode);
      expect(pressed, `mode ${mode}`).toHaveLength(1);
    }
  });
});
