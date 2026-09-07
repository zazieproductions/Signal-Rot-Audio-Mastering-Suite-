/**
 * Channel-identification signal generator.
 *
 * ── The problem this solves ──────────────────────────────────────────────────────────
 * The single most expensive mistake in multichannel delivery is a silent channel swap.
 * Nothing about a 12-channel WAV tells you by ear whether track 9 is `Ltf` or `Ltr`, and
 * a mask, a channel map and an ADM document can all agree with each other while all three
 * disagree with the audio. The only way to close that loop is to put content in the file
 * that names its own channel.
 *
 * ── The signal ───────────────────────────────────────────────────────────────────────
 * Each channel gets, in strict sequence and with every other channel silent:
 *
 *   1. `n` short 1 kHz beeps, where `n` is the 1-based channel number. Countable by ear,
 *      countable by a peak detector, and unambiguous under any monitoring.
 *   2. A brief pause.
 *   3. One tone burst at a per-channel identification frequency, `baseHz × 2^(index/12)`
 *      — a chromatic ladder. Two adjacent channels are a semitone apart, which an FFT
 *      resolves trivially and which makes a swap audible as a wrong interval.
 *
 * The tone is the machine-readable part: `identifyChannelOrder` below recovers the index
 * of every channel from the audio alone, with no reference to the writer's assumptions.
 * That is what makes the round-trip test meaningful — the decoded file is asked what
 * order its channels are in, rather than being told.
 *
 * ── Determinism ──────────────────────────────────────────────────────────────────────
 * Pure arithmetic, no randomness, no dither, no filtering. Byte-identical across runs and
 * platforms, so a fixture's SHA-256 is a stable regression signal.
 *
 * Amplitude is −6 dBFS so that a 16-bit render, a 24-bit render and a float render all
 * carry the same nominal level and nothing clips at any stage.
 */

/** Default identification amplitude, −6 dBFS. */
export const ID_AMPLITUDE = 0.5011872336272722;

/** Default beep frequency, in Hz. */
export const ID_BEEP_HZ = 1000;

/** Default base frequency of the chromatic identification ladder, in Hz. */
export const ID_BASE_HZ = 220;

/**
 * @typedef {object} IdentificationOptions
 * @property {number} [sampleRate]    default 48000
 * @property {number} [beepMs]        default 120
 * @property {number} [gapMs]         default 80
 * @property {number} [pauseMs]       default 300, between the beeps and the tone
 * @property {number} [toneMs]        default 600
 * @property {number} [tailMs]        default 200, silence after each channel's slot
 * @property {number} [amplitude]     default {@link ID_AMPLITUDE}
 * @property {number} [baseHz]        default {@link ID_BASE_HZ}
 * @property {number} [beepHz]        default {@link ID_BEEP_HZ}
 */

const defaults = {
  sampleRate: 48000,
  beepMs: 120,
  gapMs: 80,
  pauseMs: 300,
  toneMs: 600,
  tailMs: 200,
  amplitude: ID_AMPLITUDE,
  baseHz: ID_BASE_HZ,
  beepHz: ID_BEEP_HZ,
};

/** Identification frequency for a 0-based channel index. */
export function identificationFrequency(index, baseHz = ID_BASE_HZ) {
  return baseHz * Math.pow(2, index / 12);
}

/**
 * A short raised-cosine fade, applied to both ends of every burst. Without it each burst
 * begins and ends with a step discontinuity, which spreads energy across the whole
 * spectrum and defeats the FFT-free frequency estimator used by `identifyChannelOrder`.
 */
function envelope(i, length, fadeSamples) {
  if (i < fadeSamples) return 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeSamples);
  if (i >= length - fadeSamples) {
    return 0.5 - 0.5 * Math.cos((Math.PI * (length - 1 - i)) / fadeSamples);
  }
  return 1;
}

/**
 * Duration in seconds of a full identification sweep for `channelCount` channels.
 * @param {number} channelCount
 * @param {IdentificationOptions} [opts]
 */
export function identificationDuration(channelCount, opts = {}) {
  const o = { ...defaults, ...opts };
  const ms = (v) => v / 1000;
  let total = 0;
  for (let c = 0; c < channelCount; c++) {
    total += (c + 1) * (ms(o.beepMs) + ms(o.gapMs)) + ms(o.pauseMs) + ms(o.toneMs) + ms(o.tailMs);
  }
  return total;
}

/**
 * Generate a channel-identification `AudioData`.
 *
 * @param {number} channelCount
 * @param {IdentificationOptions} [opts]
 * @returns {import('../dsp/audio-data.js').AudioData}
 */
export function buildChannelIdentification(channelCount, opts = {}) {
  if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > 64) {
    throw new Error(
      `buildChannelIdentification: channelCount must be an integer in 1…64, got ${channelCount}`,
    );
  }
  const o = { ...defaults, ...opts };
  const sr = o.sampleRate;
  if (!Number.isFinite(sr) || sr < 8000) {
    throw new Error(`buildChannelIdentification: implausible sample rate ${sr}`);
  }
  const samples = (msValue) => Math.max(1, Math.round((msValue / 1000) * sr));
  const beepN = samples(o.beepMs);
  const gapN = samples(o.gapMs);
  const pauseN = samples(o.pauseMs);
  const toneN = samples(o.toneMs);
  const tailN = samples(o.tailMs);

  let total = 0;
  for (let c = 0; c < channelCount; c++) {
    total += (c + 1) * (beepN + gapN) + pauseN + toneN + tailN;
  }

  const channels = [];
  for (let c = 0; c < channelCount; c++) channels.push(new Float32Array(total));

  const fade = Math.max(2, Math.round(sr * 0.003));
  let cursor = 0;
  /** @type {Array<{channel: number, toneStart: number, toneEnd: number, frequency: number}>} */
  const slots = [];

  for (let c = 0; c < channelCount; c++) {
    const buf = channels[c];
    for (let b = 0; b <= c; b++) {
      const start = cursor + b * (beepN + gapN);
      for (let i = 0; i < beepN; i++) {
        buf[start + i] =
          o.amplitude * envelope(i, beepN, fade) * Math.sin((2 * Math.PI * o.beepHz * i) / sr);
      }
    }
    cursor += (c + 1) * (beepN + gapN) + pauseN;

    const freq = identificationFrequency(c, o.baseHz);
    const toneStart = cursor;
    for (let i = 0; i < toneN; i++) {
      buf[toneStart + i] =
        o.amplitude * envelope(i, toneN, fade) * Math.sin((2 * Math.PI * freq * i) / sr);
    }
    slots.push({ channel: c + 1, toneStart, toneEnd: toneStart + toneN, frequency: freq });
    cursor += toneN + tailN;
  }

  return { sampleRate: sr, length: total, channels, identificationSlots: slots };
}

/**
 * Goertzel magnitude of one frequency over one window — a single-bin DFT. Cheaper and
 * more precise for this job than a full FFT, and short enough to be obviously correct.
 */
function goertzel(signal, start, end, freq, sampleRate) {
  const n = end - start;
  if (n <= 0) return 0;
  const k = (2 * Math.PI * freq) / sampleRate;
  const coeff = 2 * Math.cos(k);
  let s1 = 0;
  let s2 = 0;
  for (let i = start; i < end; i++) {
    const s0 = signal[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / (n / 2);
}

/**
 * Recover, from decoded audio alone, which identification tone each physical channel
 * carries. This is the independent half of the channel-order round trip: it never looks
 * at the layout, the mask, or the ADM document.
 *
 * @param {{sampleRate: number, length: number, channels: Float32Array[]}} decoded
 * @param {IdentificationOptions} [opts]
 * @returns {{order: number[], confidence: number[], detail: object[]}}
 *   `order[i]` is the 1-based identification index detected on physical channel `i`.
 *   For a correctly ordered file `order` is `[1, 2, 3, …]`.
 */
export function identifyChannelOrder(decoded, opts = {}) {
  const ch = decoded.channels.length;
  const reference = buildChannelIdentification(ch, opts);
  const slots = reference.identificationSlots;
  if (decoded.length !== reference.length) {
    throw new Error(
      `identifyChannelOrder: decoded file is ${decoded.length} frames but the reference ` +
        `identification signal is ${reference.length} — they are not the same fixture.`,
    );
  }

  const order = [];
  const confidence = [];
  const detail = [];

  for (let c = 0; c < ch; c++) {
    const signal = decoded.channels[c];
    let best = -1;
    let bestMag = 0;
    let runnerUp = 0;
    const magnitudes = [];
    for (const slot of slots) {
      // Analyse the steady middle of the slot, away from the fades.
      const pad = Math.round((slot.toneEnd - slot.toneStart) * 0.15);
      const mag = goertzel(
        signal,
        slot.toneStart + pad,
        slot.toneEnd - pad,
        slot.frequency,
        decoded.sampleRate,
      );
      magnitudes.push(mag);
      if (mag > bestMag) {
        runnerUp = bestMag;
        bestMag = mag;
        best = slot.channel;
      } else if (mag > runnerUp) runnerUp = mag;
    }
    order.push(best);
    // Ratio of the winning bin to the loudest competing bin. A correctly routed channel
    // scores in the hundreds; a swap or a bleed collapses towards 1.
    confidence.push(runnerUp > 0 ? bestMag / runnerUp : Infinity);
    detail.push({ channel: c + 1, detected: best, magnitude: bestMag, magnitudes });
  }

  return { order, confidence, detail };
}

/**
 * Count the beeps in a channel — the human-audible identification, verified numerically.
 *
 * Bursts are segmented on an amplitude threshold and then classified by length: the
 * long identification tone is excluded, so the returned count is the number of short
 * beeps, which for a correctly ordered file equals the channel number.
 *
 * @param {Float32Array} signal
 * @param {number} sampleRate
 * @param {IdentificationOptions} [opts]
 * @returns {{beeps: number, toneBursts: number, bursts: Array<{start: number, length: number}>}}
 */
export function countIdentificationBeeps(signal, sampleRate, opts = {}) {
  const o = { ...defaults, ...opts };
  const threshold = o.amplitude * 0.35;
  // A gap shorter than half the nominal inter-beep gap is envelope ripple, not a new burst.
  const minGap = Math.max(1, Math.round((o.gapMs / 1000) * sampleRate * 0.5));
  const bursts = [];
  let start = -1;
  let quietFor = minGap;
  for (let i = 0; i <= signal.length; i++) {
    const loud = i < signal.length && Math.abs(signal[i]) > threshold;
    if (loud) {
      if (start < 0) start = i;
      quietFor = 0;
    } else {
      quietFor++;
      if (start >= 0 && quietFor >= minGap) {
        bursts.push({ start, length: i - quietFor - start });
        start = -1;
      }
    }
  }
  // Anything longer than 1.5 × the beep is the identification tone.
  const beepLimit = (o.beepMs / 1000) * sampleRate * 1.5;
  return {
    beeps: bursts.filter((b) => b.length <= beepLimit).length,
    toneBursts: bursts.filter((b) => b.length > beepLimit).length,
    bursts,
  };
}
