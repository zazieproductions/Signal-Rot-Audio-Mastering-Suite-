import { test, expect } from '@playwright/test';
import { importSyntheticAudio, waitForAnalysis } from './fixtures.js';

test.describe('controls, tabs and presets', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('navigates tabs with the keyboard', async ({ page }) => {
    const presets = page.locator('.tab[data-tab="presets"]');
    await presets.focus();
    await expect(presets).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.tab[data-tab="loudness"]')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.locator('.tpanel[data-tab="loudness"]')).toBeVisible();
    await page.keyboard.press('End');
    await expect(page.locator('.tab[data-tab="about"]')).toHaveAttribute('aria-selected', 'true');
  });

  test('renders schema-driven controls with correct labels', async ({ page }) => {
    await page.locator('.tab[data-tab="tone"]').click();
    // The label must state the frequency the filter actually uses.
    await expect(page.locator('label[for="p-warm"]')).toContainText('Warmth');
    await expect(page.locator('#p-warm-hint')).toHaveText('low shelf 120 Hz');
    await expect(page.locator('#p-body-hint')).toContainText('350 Hz');
  });

  test('moves a slider and updates the readout', async ({ page }) => {
    await page.locator('.tab[data-tab="tone"]').click();
    const slider = page.locator('#p-warm');
    await slider.fill('4.5');
    await expect(page.locator('#p-warm-value')).toHaveText('+4.5 dB');
    await expect(slider).toHaveAttribute('aria-valuetext', '+4.5 dB');
  });

  test('badges export-only parameters', async ({ page }) => {
    await page.locator('.tab[data-tab="dynamics"]').click();
    const attackRow = page.locator('#p-transAttack').locator('xpath=ancestor::div[@class="ctl"]');
    await expect(attackRow.locator('.badge-note')).toHaveText('export only');
  });

  test('applies a preset and shows its audit note', async ({ page }) => {
    const card = page.locator('[data-preset="Tape Ghost"]');
    await card.click();
    await expect(card).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#presetAudit')).toContainText('Tape Ghost');

    await page.locator('.tab[data-tab="character"]').click();
    await expect(page.locator('#p-tape-value')).toHaveText('70 %');
    await expect(page.locator('#p-hiss-value')).toHaveText('25 %');
  });

  test('resets to defaults', async ({ page }) => {
    await page.locator('[data-preset="Rust"]').click();
    await page.locator('#resetParamsBtn').click();
    await page.locator('.tab[data-tab="tone"]').click();
    await expect(page.locator('#p-sat-value')).toHaveText('0 %');
  });

  test('undoes and redoes a parameter change', async ({ page }) => {
    await page.locator('.tab[data-tab="tone"]').click();
    await page.locator('#p-warm').fill('6');
    await expect(page.locator('#p-warm-value')).toHaveText('+6.0 dB');
    await page.locator('#undoBtn').click();
    await expect(page.locator('#p-warm-value')).toHaveText('0.0 dB');
    await page.locator('#redoBtn').click();
    await expect(page.locator('#p-warm-value')).toHaveText('+6.0 dB');
  });

  test('switches theme and remembers it', async ({ page }) => {
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.locator('#themeBtn').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('toggles A/B and the monitor path', async ({ page }) => {
    await importSyntheticAudio(page);
    await waitForAnalysis(page);
    await expect(page.locator('#abB')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#abA').click();
    await expect(page.locator('#abA')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#abB')).toHaveAttribute('aria-pressed', 'false');
    await page.locator('#auditionSelect').selectOption('mono');
    await expect(page.locator('#auditionSelect')).toHaveValue('mono');
  });

  test('bypasses a module from the signal-flow view', async ({ page }) => {
    const tone = page.locator('.flow-node[data-module="tone"]');
    await expect(tone).toHaveAttribute('aria-pressed', 'false');
    await tone.click();
    await expect(tone).toHaveAttribute('aria-pressed', 'true');
  });

  test('opens the command palette and jumps to a tab', async ({ page }) => {
    await page.keyboard.press('Control+k');
    await expect(page.locator('#palette')).toBeVisible();
    await page.locator('#paletteInput').fill('immersive');
    await page.keyboard.press('Enter');
    await expect(page.locator('#palette')).toBeHidden();
    await expect(page.locator('.tab[data-tab="immersive"]')).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('shows a phase warning for a destructive preset', async ({ page }) => {
    await importSyntheticAudio(page);
    await waitForAnalysis(page);
    await page.locator('[data-preset="Panoramic"]').click();
    await expect(page.locator('#phaseNotice')).toBeVisible();
    await expect(page.locator('#phaseNotice')).toContainText(/phase/i);
  });

  test('randomises the texture seed', async ({ page }) => {
    await page.locator('.tab[data-tab="character"]').click();
    const before = await page.locator('#p-textureSeed-value').textContent();
    await page.locator('#randomiseSeedBtn').click();
    await expect(page.locator('#p-textureSeed-value')).not.toHaveText(before);
  });
});
