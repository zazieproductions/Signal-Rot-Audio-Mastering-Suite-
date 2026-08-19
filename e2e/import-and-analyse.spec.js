import { test, expect } from '@playwright/test';
import { importSyntheticAudio, waitForAnalysis } from './fixtures.js';

test.describe('import, analysis and transport', () => {
  test('starts with an empty transport and no console errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto('/');
    await expect(page.locator('#dropzone')).toBeVisible();
    await expect(page.locator('#waveCard')).toBeHidden();
    await expect(page.locator('#metersRow')).toBeHidden();
    await expect(page.locator('.logo')).toHaveText('SIGNAL ROT // MASTER');
    expect(errors).toEqual([]);
  });

  test('imports audio, shows the file summary and analyses loudness', async ({ page }) => {
    await page.goto('/');
    await importSyntheticAudio(page, { name: 'my track.wav', seconds: 4 });

    await expect(page.locator('#transportFull')).toBeVisible();
    await expect(page.locator('#waveCard')).toBeVisible();
    await expect(page.locator('#metersRow')).toBeVisible();
    await expect(page.locator('#fileName')).toContainText('my track.wav');
    await expect(page.locator('#fileName')).toContainText('2 ch');
    await expect(page.locator('#fileName')).toContainText('48.0 kHz');

    await waitForAnalysis(page);
    const lufs = Number(await page.locator('#mLUFS').textContent());
    expect(Number.isFinite(lufs)).toBe(true);
    expect(lufs).toBeLessThan(0);
    expect(lufs).toBeGreaterThan(-60);
  });

  test('plays and pauses', async ({ page }) => {
    await page.goto('/');
    await importSyntheticAudio(page);
    await waitForAnalysis(page);

    const play = page.locator('#playBtn');
    await expect(play).toHaveAttribute('aria-pressed', 'false');
    await play.click();
    await expect(play).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(600);
    await expect(page.locator('#timeLabel')).not.toHaveText('0:00 / 0:04');
    await play.click();
    await expect(play).toHaveAttribute('aria-pressed', 'false');
  });

  test('rejects an undecodable file with a clear message', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#fileInput', {
      name: 'broken.wav',
      mimeType: 'audio/wav',
      buffer: Buffer.from('this is not audio'),
    });
    await expect(page.locator('#toast')).toContainText('Could not decode');
    await expect(page.locator('#transportFull')).toBeHidden();
  });

  test('sanitises a hostile filename instead of executing it', async ({ page }) => {
    await page.goto('/');
    let dialogShown = false;
    page.on('dialog', async (d) => {
      dialogShown = true;
      await d.dismiss();
    });
    await importSyntheticAudio(page, { name: '<img src=x onerror=alert(1)>.wav' });
    await waitForAnalysis(page);
    expect(dialogShown).toBe(false);
    expect(await page.locator('#fileName img').count()).toBe(0);
  });
});
