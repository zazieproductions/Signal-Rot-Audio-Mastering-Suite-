import { test, expect } from '@playwright/test';
import { importSyntheticAudio, waitForAnalysis } from './fixtures.js';

test.describe('export', () => {
  test('renders and downloads a 24-bit WAV with a valid header', async ({ page }) => {
    await page.goto('/');
    await importSyntheticAudio(page, { name: 'export test.wav', seconds: 3 });
    await waitForAnalysis(page);
    await page.locator('.tab[data-tab="export"]').click();

    const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
    await page.locator('#exportBtn').click();
    const download = await downloadPromise;

    // Unified output naming (docs/INPUT-COMPATIBILITY.md): <base>_master_<quality>_<rate>k
    expect(download.suggestedFilename()).toMatch(/^export test_master_24bit_48k\.wav$/);
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    expect(buffer.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(buffer.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(buffer.readUInt32LE(4)).toBe(buffer.length - 8);
    expect(buffer.readUInt16LE(22)).toBe(2); // channels
    expect(buffer.readUInt32LE(24)).toBe(48000);
    expect(buffer.readUInt16LE(34)).toBe(24); // bit depth
  });

  test('reports the achieved loudness and true peak after export', async ({ page }) => {
    await page.goto('/');
    await importSyntheticAudio(page, { seconds: 4 });
    await waitForAnalysis(page);
    await page.locator('.tab[data-tab="export"]').click();

    const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
    await page.locator('#exportBtn').click();
    await downloadPromise;

    const notice = page.locator('#exportNotice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('LUFS');
    await expect(notice).toContainText('dBTP');
    await expect(page.locator('#renderHistory')).toContainText('LUFS');
  });

  test('honours the true-peak ceiling in the delivered file', async ({ page }) => {
    await page.goto('/');
    await importSyntheticAudio(page, { seconds: 3 });
    await waitForAnalysis(page);
    await page.locator('.tab[data-tab="loudness"]').click();
    await page.locator('#p-targetLUFS').fill('-9');
    await page.locator('#p-ceiling').fill('-1');
    await page.locator('.tab[data-tab="export"]').click();

    const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
    await page.locator('#exportBtn').click();
    await downloadPromise;

    // The engine's own verification pass is reported in the notice; anything over the
    // ceiling would be flagged as a warning containing "exceeds".
    await expect(page.locator('#exportNotice')).not.toContainText('exceeds');
  });

  test('downloads a render report as JSON', async ({ page }) => {
    await page.goto('/');
    await importSyntheticAudio(page, { seconds: 3 });
    await waitForAnalysis(page);
    await page.locator('.tab[data-tab="export"]').click();

    const first = page.waitForEvent('download', { timeout: 60_000 });
    await page.locator('#exportBtn').click();
    await first;

    const reportPromise = page.waitForEvent('download');
    await page.locator('#renderHistory .rh button').first().click();
    const report = await reportPromise;
    expect(report.suggestedFilename()).toMatch(/render-report\.json$/);

    const stream = await report.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    expect(parsed.engine.name).toContain('SIGNAL ROT');
    expect(parsed.analysisBefore).toBeTruthy();
    expect(parsed.analysisAfter).toBeTruthy();
    expect(parsed.limiter.ceilingRespected).toBe(true);
    expect(typeof parsed.loudness.normalizationGainDb).toBe('number');
  });

  test('saves and reloads a preset file', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-preset="Obsidian"]').click();

    const downloadPromise = page.waitForEvent('download');
    await page.locator('#savePresetBtn').click();
    const download = await downloadPromise;
    const path = await download.path();

    await page.locator('#resetParamsBtn').click();
    await page.locator('.tab[data-tab="tone"]').click();
    await expect(page.locator('#p-body-value')).toHaveText('0.0 dB');

    await page.setInputFiles('#presetInput', path);
    await expect(page.locator('#p-body-value')).toHaveText('+3.2 dB');
  });

  test('rejects a malformed preset file with a specific error', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#presetInput', {
      name: 'bad.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{ not json'),
    });
    await expect(page.locator('#toast')).toContainText('Preset rejected');
  });

  test('exports an immersive channel map without rendering audio', async ({ page }) => {
    await page.goto('/');
    await page.locator('.tab[data-tab="immersive"]').click();
    await page.locator('#imLayout').selectOption('soniclab');

    const downloadPromise = page.waitForEvent('download');
    await page.locator('#imMapJsonBtn').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain('SonicLab20.4');

    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const map = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    expect(map.channelCount).toBe(24);
    expect(map.channels).toHaveLength(24);
    expect(map.conventions.azimuthAdm).toContain('left');
  });

  test('renders a 5.1 multichannel WAV', async ({ page }) => {
    test.slow();
    await page.goto('/');
    await importSyntheticAudio(page, { seconds: 2 });
    await waitForAnalysis(page);
    await page.locator('.tab[data-tab="immersive"]').click();
    await page.locator('#imLayout').selectOption('5.1');

    const downloadPromise = page.waitForEvent('download', { timeout: 90_000 });
    await page.locator('#imExportBtn').click();
    const download = await downloadPromise;

    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    expect(buffer.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(buffer.readUInt16LE(20)).toBe(0xfffe); // WAVE_FORMAT_EXTENSIBLE
    expect(buffer.readUInt16LE(22)).toBe(6); // channels
    expect(buffer.readUInt32LE(40)).toBe(0x3f); // 5.1 channel mask
  });
});
