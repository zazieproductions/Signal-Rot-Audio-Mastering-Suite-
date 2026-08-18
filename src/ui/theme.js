/**
 * Theme handling.
 *
 * Two themes, both first-class. The dark laboratory is the default and the identity; the
 * light theme exists because mastering in a bright room is a real thing. The choice
 * respects `prefers-color-scheme` on first visit and is then remembered.
 */

const KEY = 'signal-rot:theme';

/** @param {'dark'|'light'} theme */
export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const button = document.querySelector('#themeBtn');
  if (button) {
    button.setAttribute(
      'aria-label',
      theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
    );
    button.textContent = theme === 'dark' ? '◐' : '◑';
  }
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* storage disabled */
  }
}

export function initialTheme() {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    /* storage disabled */
  }
  if (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
  return 'dark';
}
