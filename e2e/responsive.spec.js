import { test, expect } from '@playwright/test';

test.describe('mobile layout', () => {
  test('renders the shell and keeps the tab strip scrollable', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.logo')).toBeVisible();
    await expect(page.locator('#dropzone')).toBeVisible();
    const tabs = page.locator('.tabs');
    await expect(tabs).toBeVisible();
    const overflows = await tabs.evaluate((n) => n.scrollWidth > n.clientWidth);
    expect(overflows).toBe(true);
  });

  test('collapses the two-column grids to one column', async ({ page }) => {
    await page.goto('/');
    await page.locator('.tab[data-tab="export"]').click();
    const columns = await page
      .locator('.tpanel[data-tab="export"] .two')
      .first()
      .evaluate((n) => getComputedStyle(n).gridTemplateColumns.split(' ').length);
    expect(columns).toBe(1);
  });

  test('gives range thumbs a touch-sized target', async ({ page }) => {
    await page.goto('/');
    await page.locator('.tab[data-tab="tone"]').click();
    const height = await page
      .locator('#p-warm')
      .evaluate((n) => Number.parseFloat(getComputedStyle(n).height));
    expect(height).toBeGreaterThanOrEqual(10);
  });

  test('does not scroll horizontally', async ({ page }) => {
    await page.goto('/');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
