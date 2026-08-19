/**
 * Shared helpers for the browser suite.
 *
 * `makeWavFixture` synthesises a WAV in the page and hands it to the file input, so the
 * tests exercise the real decode → analyse → render path without shipping an audio file
 * (and without any copyright question).
 */

/**
 * Build a WAV file as a base64 string inside the browser and drop it on the file input.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} [opts]
 * @param {string} [opts.name]
 * @param {number} [opts.seconds]
 * @param {number} [opts.sampleRate]
 */
export async function importSyntheticAudio(page, opts = {}) {
  const name = opts.name ?? 'fixture.wav';
  const seconds = opts.seconds ?? 4;
  const sampleRate = opts.sampleRate ?? 48000;

  const buffer = await page.evaluate(
    ({ seconds: s, sampleRate: sr }) => {
      const n = Math.round(s * sr);
      const channels = 2;
      const bytes = 44 + n * channels * 2;
      const ab = new ArrayBuffer(bytes);
      const v = new DataView(ab);
      const ascii = (o, str) => {
        for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i));
      };
      ascii(0, 'RIFF');
      v.setUint32(4, bytes - 8, true);
      ascii(8, 'WAVE');
      ascii(12, 'fmt ');
      v.setUint32(16, 16, true);
      v.setUint16(20, 1, true);
      v.setUint16(22, channels, true);
      v.setUint32(24, sr, true);
      v.setUint32(28, sr * channels * 2, true);
      v.setUint16(32, channels * 2, true);
      v.setUint16(34, 16, true);
      ascii(36, 'data');
      v.setUint32(40, n * channels * 2, true);
      let o = 44;
      // A chord plus periodic transients: enough spectral and dynamic content that the
      // meters and the limiter both have something to do.
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        let x =
          0.22 * Math.sin(2 * Math.PI * 110 * t) +
          0.16 * Math.sin(2 * Math.PI * 220 * t) +
          0.11 * Math.sin(2 * Math.PI * 660 * t) +
          0.07 * Math.sin(2 * Math.PI * 3300 * t);
        const beat = i % Math.round(sr / 2);
        if (beat < 400)
          x += 0.55 * Math.exp(-beat / 60) * Math.sin((2 * Math.PI * 2500 * beat) / sr);
        const value = Math.max(-1, Math.min(1, x));
        const int = Math.round(value * 32767);
        v.setInt16(o, int, true);
        v.setInt16(o + 2, Math.round(value * 0.86 * 32767), true);
        o += 4;
      }
      let binary = '';
      const view = new Uint8Array(ab);
      for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
      return btoa(binary);
    },
    { seconds, sampleRate },
  );

  await page.setInputFiles('#fileInput', {
    name,
    mimeType: 'audio/wav',
    buffer: Buffer.from(buffer, 'base64'),
  });
}

/** Wait for the offline analysis pass to produce a number. */
export async function waitForAnalysis(page) {
  await page.waitForFunction(
    () => {
      const node = document.querySelector('#mLUFS');
      return node && node.textContent !== '—';
    },
    undefined,
    { timeout: 30_000 },
  );
}
