import { test, expect } from '@playwright/test';

test.describe('accessibility basics', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('exposes a skip link as the first focusable element', async ({ page }) => {
    await page.keyboard.press('Tab');
    await expect(page.locator('.skip-link')).toBeFocused();
  });

  test('gives every icon button an accessible name', async ({ page }) => {
    const buttons = page.locator('button');
    const count = await buttons.count();
    for (let i = 0; i < count; i++) {
      const button = buttons.nth(i);
      if (!(await button.isVisible())) continue;
      const name =
        (await button.getAttribute('aria-label')) ??
        (await button.getAttribute('title')) ??
        (await button.textContent());
      expect(name?.trim(), `button ${i} has no accessible name`).toBeTruthy();
    }
  });

  test('associates every visible form control with a label', async ({ page }) => {
    await page.locator('.tab[data-tab="tone"]').click();
    const inputs = page.locator('.tpanel[data-tab="tone"] input, .tpanel[data-tab="tone"] select');
    const count = await inputs.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const id = await inputs.nth(i).getAttribute('id');
      expect(id).toBeTruthy();
      await expect(page.locator(`label[for="${id}"]`)).toHaveCount(1);
    }
  });

  test('shows a visible focus ring on keyboard focus', async ({ page }) => {
    await page.locator('.tab[data-tab="tone"]').click();
    const slider = page.locator('#p-warm');
    await slider.focus();
    const shadow = await slider.evaluate((n) => getComputedStyle(n).boxShadow);
    expect(shadow).not.toBe('none');
  });

  test('marks the toast as a live region', async ({ page }) => {
    await expect(page.locator('#toast')).toHaveAttribute('aria-live', 'polite');
    await expect(page.locator('#live-region')).toHaveAttribute('aria-live', 'polite');
  });

  test('does not swallow Space when a button has focus', async ({ page }) => {
    const themeButton = page.locator('#themeBtn');
    await themeButton.focus();
    await page.keyboard.press('Space');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('honours prefers-reduced-motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    const duration = await page
      .locator('#themeBtn')
      .evaluate((n) => getComputedStyle(n).transitionDuration);
    expect(parseFloat(duration)).toBeLessThan(0.01);
  });
});
