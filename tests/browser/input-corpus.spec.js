/**
 * Real-world input compatibility, in a real browser.
 *
 * The deterministic corpus (`tools/corpus/cases.js`) is fed through the app's
 * own import path — the actual file input, the actual decoder, the actual
 * state — and every case asserts one of exactly three things:
 *
 *   · LOADED: the buffer in the store matches a fresh in-page decode of the
 *     same bytes (same shape, same samples) → the import did not normalise,
 *     flip polarity, drop, swap or reorder anything;
 *   · REFUSED: a specific, human-readable message naming the file and the
 *     reason, and the transport untouched;
 *   · EITHER (decoder-dependent): loaded *or* refused with a specific message
 *     — never a crash, never silence, never a stale result.
 *
 * This suite records per-browser behaviour; a codec a browser cannot decode
 * must still produce a clear refusal (that is the product's contract, not the
 * codec's). Cross-browser conformance gates live with the validation agent —
 * this spec is the evidence generator.
 */
import { test, expect } from '@playwright/test';
import { caseById } from '../../tools/corpus/cases.js';

/* ─────────────────────────────── helpers ─────────────────────────────── */

/** Fingerprint a decoded buffer inside the page. */
function fingerprintScript() {
  return (buffer) => {
    const fp = {
      channels: buffer.numberOfChannels,
      sampleRate: buffer.sampleRate,
      length: buffer.length,
      means: [],
      heads: [],
    };
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      const n = Math.min(d.length, 200000);
      let sum = 0;
      for (let i = 0; i < n; i++) sum += d[i];
      fp.means.push(n ? sum / n : NaN);
      fp.heads.push(Array.from(d.subarray(0, Math.min(d.length, 256))));
    }
    return fp;
  };
}

async function importCase(page, c) {
  await page.setInputFiles('#fileInput', {
    name: c.file.name,
    mimeType: c.file.mime,
    buffer: Buffer.from(c.file.bytes),
  });
}

/** Wait until the store holds a decoded buffer (a successful load). */
async function waitForLoaded(page, timeout = 120_000) {
  await page.waitForFunction(
    () => window.__signalRot?.store?.getState()?.source?.buffer !== null,
    undefined,
    { timeout },
  );
}

/** Wait for the error toast to show (its text stays put for several seconds). */
async function waitForToast(page, pattern, timeout = 30_000) {
  await page.waitForFunction(
    (re) => {
      const t = document.querySelector('#toast');
      return t && t.classList.contains('show') && new RegExp(re, 'i').test(t.textContent);
    },
    pattern,
    { timeout, polling: 100 },
  );
}

function rateLabel(sampleRate) {
  return (sampleRate / 1000).toFixed(1);
}

function durationLabel(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Assert the transport label shows the right shape for this case. */
async function expectLoadedShape(page, c) {
  const { channels, sampleRate, frames } = c.shape;
  await expect(page.locator('#transportFull')).toBeVisible();
  const label = page.locator('#fileName');
  await expect(label).toContainText(`${channels} ch`);
  await expect(label).toContainText(`${rateLabel(sampleRate)} kHz`);
  // Lossy cases (MP3) do not declare exact frame counts; skip the duration then.
  if (Number.isFinite(frames)) {
    await expect(label).toContainText(durationLabel(frames / sampleRate));
  }
}

/* ─────────────────────────────── groups ──────────────────────────────── */

// Small, universally-decodable cases: full fidelity check (app buffer vs a
// fresh in-page decode of the same bytes).
const FIDELITY_IDS = [
  'mono-1s-48k-16',
  'one-sample-441k-16',
  'ten-ms-48k-24',
  'stereo-1s-441k-16',
  'stereo-1s-48k-32f',
  'dual-mono-48k-16',
  'hard-lr-48k-16',
  'opposite-polarity-48k-16',
  'silence-1s-48k-16',
  'near-silence-48k-16',
  'dc-offset-48k-16',
  'clipped-48k-16',
  'sub-heavy-48k-16',
  'bright-48k-16',
  'loud-mastered-48k-16',
  'very-dynamic-48k-16',
  'float-above-one-48k-32f',
  'rate-8k-1s-16-mono',
  'rate-22050-1s-16',
  'rate-88200-1s-16',
  'rate-96k-1s-24',
  'info-unicode-48k-16',
  'mp3-1s-441k-128k',
  'aiff-1s-48k-16',
];

// Decoder-dependent cases (176.4/192 kHz, 5.1–32 channel, truncated data,
// odd chunk order, zero-length data) are exercised individually below — each
// must either load or be refused with a specific message, never crash.

test.describe('input corpus — fidelity (app buffer == fresh decode)', () => {
  for (const id of FIDELITY_IDS) {
    test(`loads ${id} without altering it`, async ({ page }) => {
      const c = caseById(id);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto('/');
      await importCase(page, c);
      await waitForLoaded(page);
      await expectLoadedShape(page, c);

      // App buffer vs a fresh in-page decode of the identical bytes.
      const [appFp, freshFp] = await Promise.all([
        page.evaluate(
          (fp) => fp(window.__signalRot.store.getState().source.buffer),
          fingerprintScript(),
        ),
        page.evaluate(
          async (bytes, fp) => {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            const ctx = new Ctor();
            try {
              return fp(await ctx.decodeAudioData(bytes));
            } finally {
              ctx.close().catch(() => {});
            }
          },
          c.file.bytes,
          fingerprintScript(),
        ),
      ]);

      expect(appFp.channels).toBe(c.shape.channels);
      expect(appFp.sampleRate).toBe(c.shape.sampleRate);
      expect(appFp.length).toBe(c.shape.frames);
      expect(appFp.channels).toBe(freshFp.channels);
      expect(appFp.sampleRate).toBe(freshFp.sampleRate);
      expect(appFp.length).toBe(freshFp.length);
      for (let cix = 0; cix < appFp.channels; cix++) {
        // 16-bit grid ≈ 3e-5; allow 1e-4 for headroom
        expect(Math.abs(appFp.means[cix] - freshFp.means[cix])).toBeLessThan(1e-4);
        const head = appFp.heads[cix];
        for (let i = 0; i < head.length; i++) {
          expect(Math.abs(head[i] - freshFp.heads[cix][i])).toBeLessThan(1e-6);
        }
      }
      expect(errors).toEqual([]);
    });
  }
});

test.describe('input corpus — content invariants', () => {
  test('keeps L/R identity on a dual-mono source', async ({ page }) => {
    await page.goto('/');
    await importCase(page, caseById('dual-mono-48k-16'));
    await waitForLoaded(page);
    const fp = await page.evaluate(
      (s) => s(window.__signalRot.store.getState().source.buffer),
      fingerprintScript(),
    );
    expect(fp.heads[0]).toEqual(fp.heads[1]);
  });

  test('keeps a hard L/R source hard (right channel silent)', async ({ page }) => {
    await page.goto('/');
    await importCase(page, caseById('hard-lr-48k-16'));
    await waitForLoaded(page);
    const fp = await page.evaluate(
      (s) => s(window.__signalRot.store.getState().source.buffer),
      fingerprintScript(),
    );
    expect(Math.max(...fp.heads[1].map(Math.abs))).toBe(0);
    expect(Math.max(...fp.heads[0].map(Math.abs))).toBeGreaterThan(0);
  });

  test('does not remove the DC offset', async ({ page }) => {
    await page.goto('/');
    await importCase(page, caseById('dc-offset-48k-16'));
    await waitForLoaded(page);
    const fp = await page.evaluate(
      (s) => s(window.__signalRot.store.getState().source.buffer),
      fingerprintScript(),
    );
    expect(fp.means[0]).toBeCloseTo(0.25, 4);
  });

  test('does not clip 32-bit float values above 1.0', async ({ page }) => {
    await page.goto('/');
    await importCase(page, caseById('float-above-one-48k-32f'));
    await waitForLoaded(page);
    const peak = await page.evaluate(() => {
      const b = window.__signalRot.store.getState().source.buffer;
      let p = 0;
      for (let c = 0; c < b.numberOfChannels; c++) {
        const d = b.getChannelData(c);
        for (let i = 0; i < d.length; i++) p = Math.max(p, Math.abs(d[i]));
      }
      return p;
    });
    expect(peak).toBeGreaterThan(1.4);
  });

  test('silence stays silence and loudness analysis survives it', async ({ page }) => {
    await page.goto('/');
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await importCase(page, caseById('silence-1s-48k-16'));
    await waitForLoaded(page);
    // Analysis completes without crashing; the meter shows a number or an
    // honest dash, never NaN leaking into the DOM.
    await page.waitForTimeout(2500);
    const lufs = await page.locator('#mLUFS').textContent();
    expect(lufs).not.toMatch(/NaN/);
    expect(errors).toEqual([]);
  });

  test('notes mono routing explicitly', async ({ page }) => {
    await page.goto('/');
    await importCase(page, caseById('mono-1s-48k-16'));
    await waitForLoaded(page);
    await expect(page.locator('#sourceNotes')).toBeVisible();
    await expect(page.locator('#sourceNotes')).toContainText('dual-mono routing');
  });
});

test.describe('input corpus — multichannel and exotic rates', () => {
  for (const id of ['5-1-1s-48k-16', '7-1-1s-48k-16', '24ch-1s-48k-16']) {
    test(`${id}: loaded with an explicit fold-down note, or refused specifically`, async ({
      page,
    }) => {
      const c = caseById(id);
      await page.goto('/');
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await importCase(page, c);
      const loaded = await page
        .waitForFunction(
          () => window.__signalRot?.store?.getState()?.source?.buffer !== null,
          undefined,
          { timeout: 30_000 },
        )
        .then(() => true)
        .catch(() => false);
      if (loaded) {
        await expectLoadedShape(page, c);
        const notes = await page.locator('#sourceNotes').textContent();
        expect(notes).toMatch(/folds|channels/i);
      } else {
        await expect(page.locator('#toast')).toContainText(/channels|decode|not supported/i);
        await expect(page.locator('#transportFull')).toBeHidden();
      }
      expect(errors).toEqual([]);
    });
  }

  test('32 channels: refused with a specific channel-count message (or by the decoder)', async ({
    page,
  }) => {
    await page.goto('/');
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await importCase(page, caseById('32ch-1s-48k-16'));
    const loaded = await page
      .waitForFunction(
        () => window.__signalRot?.store?.getState()?.source?.buffer !== null,
        undefined,
        {
          timeout: 30_000,
        },
      )
      .then(() => true)
      .catch(() => false);
    if (loaded) {
      // The app's own ceiling should have refused it; if the decoder refused
      // first, the toast says so. Either way: specific words.
      await expect(page.locator('#toast')).toContainText(/channels/i);
    } else {
      await expect(page.locator('#toast')).toContainText(/decode|channel/i);
    }
    expect(errors).toEqual([]);
  });

  for (const id of ['rate-176400-half-16', 'rate-192k-half-24', 'rate-192k-half-32f']) {
    test(`${id}: decodes or is refused with a specific message (per-browser behaviour)`, async ({
      page,
    }) => {
      const c = caseById(id);
      await page.goto('/');
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await importCase(page, c);
      const loaded = await page
        .waitForFunction(
          () => window.__signalRot?.store?.getState()?.source?.buffer !== null,
          undefined,
          {
            timeout: 45_000,
          },
        )
        .then(() => true)
        .catch(() => false);
      if (loaded) {
        await expectLoadedShape(page, c);
      } else {
        await expect(page.locator('#toast')).toContainText(/decode|supported|samples/i);
      }
      expect(errors).toEqual([]);
      console.log(`[corpus] ${test.info().project.name} ${id} → ${loaded ? 'DECODED' : 'refused'}`);
    });
  }
});

test.describe('input corpus — refusals', () => {
  test('empty file: refused before any decode, transport untouched', async ({ page }) => {
    await page.goto('/');
    await importCase(page, caseById('empty-file'));
    await waitForToast(page, /empty \(0 bytes\)/);
    await expect(page.locator('#transportFull')).toBeHidden();
  });

  test('non-audio bytes: refused with codec language', async ({ page }) => {
    await page.goto('/');
    await importCase(page, caseById('not-audio-bytes'));
    await waitForToast(page, /Could not decode/i);
    await expect(page.locator('#transportFull')).toBeHidden();
  });

  test('corrupted header: refused with corruption language', async ({ page }) => {
    await page.goto('/');
    await importCase(page, caseById('bad-header-48k-16'));
    await waitForToast(page, /Could not decode|truncated or corrupted/i);
    await expect(page.locator('#transportFull')).toBeHidden();
  });

  test('NaN sample: decoded by the browser, refused by the app with a specific message', async ({
    page,
  }) => {
    await page.goto('/');
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await importCase(page, caseById('float-nan-48k-32f'));
    await waitForToast(page, /non-finite|Could not decode/i);
    await expect(page.locator('#transportFull')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('Infinity sample: refused with a specific message', async ({ page }) => {
    await page.goto('/');
    await importCase(page, caseById('float-inf-48k-32f'));
    await waitForToast(page, /non-finite|Could not decode/i);
    await expect(page.locator('#transportFull')).toBeHidden();
  });

  test('a good file still loads after a refusal (no corrupted state)', async ({ page }) => {
    await page.goto('/');
    await importCase(page, caseById('bad-header-48k-16'));
    await waitForToast(page, /Could not decode/i);
    await importCase(page, caseById('mono-1s-48k-16'));
    await waitForLoaded(page);
    await expect(page.locator('#fileName')).toContainText('mono-1s-48k-16');
  });

  test('61-minute file: decoded, then refused with the duration ceiling', async ({ page }) => {
    test.slow();
    await page.goto('/');
    await importCase(page, caseById('too-long-61min-8k-16-mono'));
    await waitForToast(page, /limit is 1:00:00/);
    await expect(page.locator('#transportFull')).toBeHidden();
  });
});

test.describe('input corpus — long-form', () => {
  test('3-minute file loads, labels correctly and analyses', async ({ page }) => {
    test.slow();
    await page.goto('/');
    await importCase(page, caseById('long-3min-441k-16-stereo'));
    await waitForLoaded(page, 180_000);
    await expect(page.locator('#fileName')).toContainText('44.1 kHz');
    await expect(page.locator('#fileName')).toContainText('3:00');
    await page.waitForFunction(
      () => {
        const n = document.querySelector('#mLUFS');
        return n && n.textContent !== '—' && !Number.isNaN(Number(n.textContent));
      },
      undefined,
      { timeout: 180_000 },
    );
  });

  test('16-minute file loads with a duration warning', async ({ page }) => {
    test.slow();
    await page.goto('/');
    await importCase(page, caseById('long-16min-8k-16-mono'));
    await waitForLoaded(page, 120_000);
    await expect(page.locator('#fileName')).toContainText('16:00');
    await expect(page.locator('#toast')).toContainText(/slow and memory-hungry|heavy/i);
  });
});

test.describe('input corpus — filenames', () => {
  test('Unicode + emoji + quotes + apostrophes load and stay recognisable', async ({ page }) => {
    const c = caseById('name-unicode-emoji');
    await page.goto('/');
    await importCase(page, c);
    await waitForLoaded(page);
    await expect(page.locator('#fileName')).toContainText('Café');
    await expect(page.locator('#fileName')).toContainText('🎚');
  });

  test('a 300-character filename loads and the display does not break', async ({ page }) => {
    await page.goto('/');
    await importCase(page, caseById('name-very-long'));
    await waitForLoaded(page);
    await expect(page.locator('#fileName')).toContainText('ch');
  });

  test('an HTML-injection filename executes nothing', async ({ page }) => {
    let dialogShown = false;
    page.on('dialog', async (d) => {
      dialogShown = true;
      await d.dismiss();
    });
    await page.goto('/');
    await importCase(page, caseById('name-html-injection'));
    await waitForLoaded(page);
    expect(dialogShown).toBe(false);
    expect(await page.locator('#fileName img').count()).toBe(0);
  });
});

test.describe('batch workflow in the browser', () => {
  test('dropping several files loads the first and queues the rest', async ({ page }) => {
    const a = caseById('stereo-1s-441k-16');
    const b = caseById('dual-mono-48k-16');
    const c = caseById('bright-48k-16');
    const junk = { name: 'readme.txt', mime: 'text/plain', bytes: Buffer.from('not audio') };
    await page.goto('/');
    // The DataTransfer *constructor* is not available in every engine; the
    // behaviour under test (multi-file drop → queue) is engine-independent, so
    // a missing constructor is an environment gap, not a product failure.
    const supported = await page.evaluate(() => {
      try {
        new DataTransfer();
        return true;
      } catch {
        return false;
      }
    });
    test.skip(!supported, 'DataTransfer constructor unavailable in this engine');
    if (!supported) return;
    await page.evaluate(
      (payloads) => {
        const dt = new DataTransfer();
        for (const p of payloads) dt.items.add(new File([p.bytes], p.name, { type: p.mime }));
        document
          .getElementById('dropzone')
          .dispatchEvent(
            new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
          );
      },
      [
        { name: a.file.name, mime: a.file.mime, bytes: a.file.bytes },
        { name: b.file.name, mime: b.file.mime, bytes: b.file.bytes },
        { name: c.file.name, mime: c.file.mime, bytes: c.file.bytes },
        junk,
      ],
    );
    await waitForLoaded(page);
    await expect(page.locator('#fileName')).toContainText(a.file.name);
    const rows = page.locator('#batchList .brow');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(b.file.name);
    await expect(rows.nth(1)).toContainText(c.file.name);
  });

  test('batch run: per-file status, predictable names, a bad file fails its own row', async ({
    page,
  }) => {
    test.slow();
    await page.goto('/');
    await page.click('.tab[data-tab="batch"]');
    const good1 = caseById('stereo-1s-441k-16');
    const good2 = caseById('dual-mono-48k-16');
    const broken = {
      name: 'broken-in-batch.wav',
      mime: 'audio/wav',
      bytes: Buffer.from('CORRUPT WAV BYTES'),
    };

    const downloads = [];
    page.on('download', (d) => downloads.push(d));

    await page.setInputFiles('#batchInput', [
      { name: good1.file.name, mimeType: good1.file.mime, buffer: Buffer.from(good1.file.bytes) },
      { name: good2.file.name, mimeType: good2.file.mime, buffer: Buffer.from(good2.file.bytes) },
      broken,
    ]);

    const rows = page.locator('#batchList .brow');
    await expect(rows).toHaveCount(3);
    await expect(page.locator('#batchList')).toContainText(/truncated or corrupted/i);
    await expect(page.locator('#batchRunBtn')).toBeEnabled();

    await page.locator('#batchRunBtn').click();
    // Two renders + downloads; give the loop room.
    await expect(page.locator('#batchProgText')).toContainText(/2 exported/i, { timeout: 180_000 });

    // Row states
    await expect(rows.nth(0)).toContainText(/done →/i);
    await expect(rows.nth(1)).toContainText(/done →/i);
    await expect(rows.nth(2)).toContainText(/failed/i);

    // Output names follow the scheme, deduplicated per session
    expect(downloads.length).toBe(2);
    const names = downloads.map((d) => d.suggestedFilename()).sort();
    expect(names[0]).toMatch(/_master_24bit_48k\.wav$/);
    expect(names[1]).toMatch(/_master_24bit_48k\.wav$/);
    expect(new Set(names).size).toBe(2);

    // Per-item report button exists on done rows
    expect(await page.locator('#batchList .brow button:has-text("report")').count()).toBe(2);
  });

  test('cancellation stops the batch; skipped rows say so', async ({ page }) => {
    test.slow();
    await page.goto('/');
    await page.click('.tab[data-tab="batch"]');
    // The 3-minute file guarantees the batch is still running when the stop
    // is pressed, so at least one row must end up skipped.
    const files = ['stereo-1s-441k-16', 'long-3min-441k-16-stereo', 'bright-48k-16'].map(caseById);
    await page.setInputFiles(
      '#batchInput',
      files.map((c) => ({
        name: c.file.name,
        mimeType: c.file.mime,
        buffer: Buffer.from(c.file.bytes),
      })),
    );
    await expect(page.locator('#batchList .brow')).toHaveCount(3);

    await page.locator('#batchRunBtn').click();
    // Let the first render get under way, then stop.
    await page.waitForTimeout(1500);
    await page.locator('#batchCancelBtn').click();
    await expect(page.locator('#batchProgText')).toContainText(/complete/i, { timeout: 180_000 });
    const states = await page.locator('#batchList .brow .st').allTextContents();
    expect(states.filter((s) => /skipped/i.test(s)).length).toBeGreaterThanOrEqual(1);
    expect(states.filter((s) => /done/i.test(s)).length).toBeLessThanOrEqual(1);
  });
});
