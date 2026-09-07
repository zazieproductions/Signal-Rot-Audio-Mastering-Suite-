/**
 * A/B/C listening strip.
 *
 * Contract (owned by bootstrap `setAbMode` / `cycleAbMode` + `initShortcuts`):
 *   A Original → B Mastered → C Matched (level-matched master) → A
 *
 * This module is the *view*: it paints the enhanced and transport buttons, hosts
 * blind mode and dim, and forwards clicks. It does **not** register A/B/X/M
 * keyboard handlers — those conflicted with the three-way cycle and with mono
 * audition (issue #13). Blind mode intercepts X via `flipBlind`, called from
 * the single shortcut owner.
 *
 * Blind comparison is A vs C (original vs loudness-matched master) so the
 * louder-is-better bias is not part of the test. Falls back to A vs B if C
 * cannot be formed.
 */

import { $ } from './dom.js';

export function initAbEnhanced(opts) {
  const { store, pushParameters, setAbMode, cycleAbMode } = opts;
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
  let dim = false;

  const allModeButtons = () =>
    ['A', 'B', 'C'].flatMap((m) =>
      [`#ab${m}`, `#ab${m}enh`].map((sel) => $(sel)).filter(Boolean),
    );

  const sync = () => {
    const { abMode, matchLoudness } = store.getState().ui;

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
    if (dimChip) dimChip.setAttribute('aria-pressed', String(dim));
    if (hint) {
      if (blind) {
        hint.textContent = `◈ Blind ${blindIndex === 0 ? '1' : '2'} · press X to flip, H to exit`;
      } else {
        const label =
          abMode === 'A' ? 'A · Original' : abMode === 'C' ? 'C · Matched' : 'B · Mastered';
        hint.textContent = `${label}${matchLoudness && abMode !== 'C' ? ' · match-loudness on' : ''}${
          dim ? ' · −12 dB dim' : ''
        }`;
      }
    }
    if (opts.getLiveGraph) {
      const live = opts.getLiveGraph();
      if (live && live.monitor) live.monitor.gain.value = dim ? 0.251 : 1; // -12 dB
    }
  };

  const applyMode = (mode) => {
    if (typeof setAbMode === 'function') setAbMode(mode);
    else {
      store.setUi({ abMode: mode });
      if (pushParameters) pushParameters();
    }
    sync();
  };

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
  // Transport A/B/C are owned by bootstrap's setAbMode listeners. Do not bind them
  // here — a second click handler was the original double-toggle / X-skip bug.

  const flipBlind = () => {
    if (!blind) return;
    blindIndex = 1 - blindIndex;
    const nextHidden = blindChoices[blindIndex];
    store.setUi({ abMode: nextHidden });
    if (pushParameters) pushParameters();
    sync();
  };

  if (blindBtn) {
    blindBtn.addEventListener('click', () => {
      blind = !blind;
      if (blind) {
        // Fair comparison: original vs loudness-matched master.
        const first = Math.random() > 0.5 ? 'A' : 'C';
        blindChoices = [first, first === 'A' ? 'C' : 'A'];
        blindIndex = 0;
        store.setUi({ abMode: blindChoices[0] });
        if (pushParameters) pushParameters();
      }
      sync();
    });
  }

  const toggleMatch = () => {
    // Match-loudness chip is the legacy A/B level match. C is the dedicated matched
    // audition; flipping the chip while on C is a no-op (already matched).
    if (store.getState().ui.abMode === 'C') {
      if (typeof setAbMode === 'function') setAbMode('B');
      store.setUi({ matchLoudness: true });
      if (pushParameters) pushParameters();
      sync();
      return;
    }
    const next = !store.getState().ui.matchLoudness;
    store.setUi({ matchLoudness: next });
    if (pushParameters) pushParameters();
    sync();
  };
  for (const button of new Set([matchChip, $('#matchLoudBtn')])) {
    button?.addEventListener('click', toggleMatch);
  }

  dimChip?.addEventListener('click', () => {
    dim = !dim;
    sync();
  });

  // H is unique to this strip (blind). A/B/C/X live in initShortcuts.
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.metaKey || e.ctrlKey) return;
    if (e.key === 'h' || e.key === 'H') {
      e.preventDefault();
      blindBtn?.click();
    }
  });

  store.subscribe((_s, changed) => {
    if (changed.has('ui')) sync();
  });
  sync();
  return {
    sync,
    toggleMatch,
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
