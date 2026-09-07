/**
 * Command palette and keyboard workflow.
 *
 * `Ctrl/Cmd+K` opens a fuzzy command list covering every preset, every tab and the main
 * actions. Mastering is a keyboard job; reaching for a mouse to switch between Tone and
 * Dynamics forty times an hour is not.
 *
 * Global shortcuts are deliberately conservative and never fire while a text field, select
 * or slider has focus — the audited build swallowed `Space` globally, which broke button
 * activation for keyboard users.
 */

import { el, replaceChildren, $, $$ } from './dom.js';

const isTypingTarget = (target) => {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable ||
    target.getAttribute('role') === 'slider'
  );
};

/** Cheap subsequence fuzzy match, case-insensitive. */
export function fuzzyMatch(query, text) {
  if (!query) return true;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let i = 0;
  for (const ch of t) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return false;
}

/**
 * @param {object} opts
 * @param {() => {id:string, label:string, hint?:string, run:()=>void}[]} opts.getCommands
 */
export function initCommandPalette(opts) {
  const overlay = $('#palette');
  const input = /** @type {HTMLInputElement|null} */ ($('#paletteInput'));
  const list = $('#paletteList');
  if (!overlay || !input || !list) return { open: () => {}, close: () => {} };

  let items = [];
  let selected = 0;

  const render = () => {
    const query = input.value.trim();
    items = opts.getCommands().filter((c) => fuzzyMatch(query, `${c.label} ${c.hint ?? ''}`));
    selected = Math.min(selected, Math.max(0, items.length - 1));
    replaceChildren(
      list,
      ...items.slice(0, 60).map((command, index) =>
        el(
          'button',
          {
            type: 'button',
            class: 'palette-item',
            role: 'option',
            'aria-selected': String(index === selected),
            onclick: () => {
              close();
              command.run();
            },
            onmouseenter: () => {
              selected = index;
              updateSelection();
            },
          },
          [
            el('span', { text: command.label }),
            command.hint ? el('span', { class: 'kbd', text: command.hint }) : null,
          ],
        ),
      ),
    );
  };

  const updateSelection = () => {
    $$('.palette-item', list).forEach((node, index) => {
      node.setAttribute('aria-selected', String(index === selected));
      if (index === selected) node.scrollIntoView({ block: 'nearest' });
    });
  };

  const open = () => {
    overlay.classList.add('on');
    input.value = '';
    selected = 0;
    render();
    input.focus();
  };

  const close = () => {
    overlay.classList.remove('on');
  };

  input.addEventListener('input', () => {
    selected = 0;
    render();
  });

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      selected = Math.min(selected + 1, items.length - 1);
      updateSelection();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      selected = Math.max(selected - 1, 0);
      updateSelection();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const command = items[selected];
      if (command) {
        close();
        command.run();
      }
    }
  });

  return { open, close, isOpen: () => overlay.classList.contains('on') };
}

/**
 * Global keyboard shortcuts.
 * @param {Record<string, (event: KeyboardEvent) => void>} handlers
 */
export function initShortcuts(handlers) {
  window.addEventListener('keydown', (event) => {
    const mod = event.metaKey || event.ctrlKey;

    // The palette shortcut works even from a text field.
    if (mod && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      handlers.palette?.(event);
      return;
    }
    if (mod && event.key.toLowerCase() === 'z') {
      if (isTypingTarget(event.target) && event.target instanceof HTMLInputElement) {
        if (event.target.type === 'text') return;
      }
      event.preventDefault();
      if (event.shiftKey) handlers.redo?.(event);
      else handlers.undo?.(event);
      return;
    }
    if (mod && event.key.toLowerCase() === 'e') {
      event.preventDefault();
      handlers.export?.(event);
      return;
    }

    if (isTypingTarget(event.target)) return;

    switch (event.key) {
      case ' ':
        event.preventDefault();
        handlers.playPause?.(event);
        break;
      case 'x':
      case 'X':
        event.preventDefault();
        handlers.toggleAb?.(event);
        break;
      case 'a':
      case 'A':
        event.preventDefault();
        handlers.auditionOriginal?.(event);
        break;
      case 'b':
      case 'B':
        event.preventDefault();
        handlers.auditionMastered?.(event);
        break;
      case 'c':
      case 'C':
        event.preventDefault();
        handlers.auditionMatched?.(event);
        break;
      case 'h':
      case 'H':
        event.preventDefault();
        handlers.toggleBlind?.(event);
        break;
      case 'm':
      case 'M':
        event.preventDefault();
        handlers.toggleMatch?.(event);
        break;
      case 's':
      case 'S':
        event.preventDefault();
        handlers.sideAudition?.(event);
        break;
      case 'l':
      case 'L':
        event.preventDefault();
        handlers.toggleWorkspace?.(event);
        break;
      case '?':
        handlers.help?.(event);
        break;
      default:
        break;
    }
  });
}
