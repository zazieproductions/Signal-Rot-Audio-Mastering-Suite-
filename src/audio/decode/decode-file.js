/**
 * Browser decode at the file's native sample rate (§2.8).
 *
 * `decodeAudioData` on a *live* context resamples to the device rate (commonly 48 kHz),
 * so a 44.1 kHz WAV becomes 48 kHz in memory and any 44.1 kHz export later runs a
 * second hidden conversion. This helper decodes against a throwaway `OfflineAudioContext`
 * whose rate is the container's native rate (sniffed from the header), so 44.1 kHz
 * sources stay 44.1 kHz end to end. Rates the browser refuses (or containers we cannot
 * sniff) fall back to 48 kHz, then to the live-context decode.
 */

import { sniffSampleRate } from './sniff-rate.js';
import { probeOfflineSampleRate, getAudioContext } from '../context.js';

/** 48 kHz fallback when the container rate is unknown or unsupported. */
export const DECODE_FALLBACK_RATE = 48000;

/**
 * Decode encoded audio bytes at the most native sample rate available.
 *
 * @param {ArrayBuffer} bytes
 * @param {object} [opts]
 * @param {number} [opts.liveCtxRate] rate of the live context, as last-resort fallback
 * @returns {Promise<{buffer: AudioBuffer, requestedRate: number, decodedRate: number, sniffedRate: number|null}>}
 */
export async function decodeAtNativeRate(bytes, opts = {}) {
  const sniffed = sniffSampleRate(bytes);
  const candidates = [
    sniffed && Number.isFinite(sniffed) ? sniffed : null,
    DECODE_FALLBACK_RATE,
    opts.liveCtxRate ?? null,
  ].filter((r) => r !== null && r > 0);

  let lastError = null;
  for (const rate of candidates) {
    if (!probeOfflineSampleRate(rate)) continue;
    try {
      const ctx = new OfflineAudioContext(2, 1, rate);
      const buffer = await ctx.decodeAudioData(bytes);
      if (buffer && buffer.length > 0) {
        return { buffer, requestedRate: rate, decodedRate: buffer.sampleRate, sniffedRate: sniffed ?? null };
      }
    } catch (error) {
      lastError = error;
    }
  }
  // Last resort: the shared live context (device rate).
  try {
    const ctx = await getAudioContext();
    const buffer = await ctx.decodeAudioData(bytes);
    return {
      buffer,
      requestedRate: ctx.sampleRate,
      decodedRate: buffer.sampleRate,
      sniffedRate: sniffed ?? null,
    };
  } catch (error) {
    throw lastError ?? error;
  }
}
