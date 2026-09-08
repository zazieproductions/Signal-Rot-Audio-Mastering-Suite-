/**
 * A/B/C listening strip.
 *
 * Contract (owned by bootstrap `setAbMode` / `cycleAbMode` + `initShortcuts`):
 *   A Original → B Mastered → C Matched (level-matched master) → A
 *
 * This module is the *view*: it paints the enhanced and transport buttons, hosts blind
 * mode and the dim chip, and forwards clicks to the single mode owner. It registers
 * **no** keyboard handlers of its own — every global key (A/B/C/X/H/M/S/L) binds once in
 * `initShortcuts`, which calls the methods returned here. Per-module window listeners
 * were the original double-toggle / X-skips-C bug (issue #13).
 *
 * Two more single-owner rules this module respects:
 *  - Dim is `store.ui.abDim`; the monitor gain node itself is written only by bootstrap's
 *    `applyMonitorGain`, so the binaural preview and the dim can never un-mute each other.
 *  - It never calls `pushParameters` itself: the graph push + meter repaint happen once,
 *    in bootstrap's audition-signature subscription, whatever changed the mode.
 *
 * Blind comparison is A vs C (original vs loudness-matched master) so the louder-is-better
 * bias is not part of the test. The two hidden slots are always the two *different*
 * signals — a coin flip per slot could hand the listener the same audio twice.
 */

import { $ } from './dom.js';

export function initAbEnhanced(opts) {
  const { store, setAbMode, cycleAbMode } = opts;
  const abAenh = $('#abAenh');
  const abBenh = $('#abBenh');
  const abCenh = $('#abCenh');
  const blindBtn = $('#abBlindenh');
  const matchChip = $('#abMatchChip');
  const dimChip = $('#abDimChip');
  const hint = $('#abHint');

  let blind = false;
  let blindChoices = ['A', 'C'];
  let blindIndex = 0;

  const allModeButtons = () =>
    ['A', 'B', 'C'].flatMap((m) => [`#ab${m}`, `#ab${m}enh`].map((sel) => $(sel)).filter(Boolean));

  const sync = () => {
    const { abMode, matchLoudness, abDim } = store.getState().ui;

    for (const btn of allModeButtons()) {
      const mode = btn.dataset.ab;
      btn.setAttribute('aria-pressed', String(!blind && abMode === mode));
    }
    if (blindBtn) {
      blindBtn.setAttribute('aria-pressed', String(blind));
      blindBtn.textContent = blind ? '● Blind A/C' : 'Blind';
      blindBtn.title = blind
        ? 'Blind mode — original vs loudness-matched master (press H to exit, X to flip)'
        : 'Blind A/C — hide which is which (H)';
    }
    const matchPressed = String(!!matchLoudness || abMode === 'C');
    matchChip?.setAttribute('aria-pressed', matchPressed);
    $('#matchLoudBtn')?.setAttribute('aria-pressed', matchPressed);
    dimChip?.setAttribute('aria-pressed', String(!!abDim));
    if (hint) {
      if (blind) {
        hint.textContent = `◈ Blind ${blindIndex === 0 ? '1' : '2'} · press X to flip, H to exit`;
      } else {
        const label =
          abMode === 'A' ? 'A · Original' : abMode === 'C' ? 'C · Matched' : 'B · Mastered';
        hint.textContent = `${label}${matchLoudness && abMode !== 'C' ? ' · match-loudness on' : ''}${
          abDim ? ' · −12 dB dim' : ''
        }`;
      }
    }
  };

  const applyMode = (mode) => {
    if (typeof setAbMode === 'function') setAbMode(mode);
    else store.setUi({ abMode: mode });
    sync();
  };

  /** Flip the hidden slot while blind (never reveals); otherwise select `mode`. */
  const onModeClick = (mode) => {
    if (blind) {
      flipBlind();
      return;
    }
    applyMode(mode);
  };

  abAenh?.addEventListener('click', () => onModeClick('A'));
  abBenh?.addEventListener('click', () => onModeClick('B'));
  abCenh?.addEventListener('click', () => onModeClick('C'));
  // Transport #abA/#abB/#abC are bound by bootstrap (to `onModeClick`). Not here — a
  // second click handler on the same node was the original double-toggle bug.

  const flipBlind = () => {
    if (!blind) return;
    blindIndex = 1 - blindIndex;
    store.setUi({ abMode: blindChoices[blindIndex] });
    sync();
  };

  const toggleBlind = () => {
    blind = !blind;
    if (blind) {
      // Fair comparison: original vs loudness-matched master, order hidden, always distinct.
      const first = Math.random() > 0.5 ? 'A' : 'C';
      blindChoices = [first, first === 'A' ? 'C' : 'A'];
      blindIndex = 0;
      store.setUi({ abMode: blindChoices[0] });
    }
    // Leaving blind keeps the slot that was playing; sync() now shows its label — that
    // IS the reveal, and it never silently jumps to a different signal.
    sync();
  };
  blindBtn?.addEventListener('click', toggleBlind);

  const toggleMatch = () => {
    // The match chip is the legacy A/B level match. C is the dedicated matched audition;
    // flipping the chip while on C drops back to a level-matched B instead of no-op'ing.
    if (store.getState().ui.abMode === 'C') {
      store.setUi({ matchLoudness: true });
      applyMode('B');
      return;
    }
    store.setUi({ matchLoudness: !store.getState().ui.matchLoudness });
    sync();
  };
  for (const button of new Set([matchChip, $('#matchLoudBtn')])) {
    button?.addEventListener('click', toggleMatch);
  }

  dimChip?.addEventListener('click', () => {
    store.setUi({ abDim: !store.getState().ui.abDim });
    sync();
  });

  store.subscribe((_s, changed) => {
    if (changed.has('ui')) sync();
  });
  sync();
  return {
    sync,
    onModeClick,
    toggleMatch,
    toggleBlind,
    flipBlind,
    get blind() {
      return blind;
    },
    get isBlind() {
      return blind;
    },
    cycleAbMode,
  };
}
