/**
 * Analogue character engines — tape, hiss, vinyl.
 *
 * ── Honest taxonomy ──────────────────────────────────────────────────────────────────
 * The brief asks for these to be separated by what they actually are. They are:
 *
 * | Engine        | Category                    | What it really is                        |
 * | ------------- | --------------------------- | ---------------------------------------- |
 * | Wow / flutter | perceptual approximation    | Two sine LFOs modulating a delay line    |
 * | Head bump     | technically modelled        | A peaking filter at 60 Hz                |
 * | HF roll-off   | technically modelled        | A low-pass, moved by the vinyl amount    |
 * | Hiss          | stylised degradation        | Seeded Gaussian noise, high-passed       |
 * | Crackle       | stylised degradation        | Seeded sparse impulses, band-passed      |
 * | Rumble        | stylised degradation        | Seeded low-passed brown noise            |
 *
 * **None of this is a tape-machine model.** A tape model needs hysteresis (Jiles-Atherton
 * or similar), record/playback head gap loss, bias, self-erasure and speed-dependent
 * equalisation. This is a modulated delay line plus a resonant filter plus noise. It
 * sounds like degraded media, which is the point of the aesthetic, but calling it a tape
 * emulation would be a lie.
 *
 * ── Determinism ──────────────────────────────────────────────────────────────────────
 * Every noise bed is generated from a **seeded** PRNG. The same project with the same
 * texture seed produces a byte-identical export, every time. The seed is a first-class
 * parameter with a "randomise" control, not an implementation detail.
 *
 * The LFOs are `OscillatorNode`s, whose phase in an `OfflineAudioContext` starts at zero
 * deterministically, so wow and flutter are reproducible too.
 *
 * ── Noise bed construction ───────────────────────────────────────────────────────────
 * The audited implementation used **2-second mono** loops. Two consequences: the same two
 * seconds of crackle repeated 120 times across a four-minute master, and mono noise
 * up-mixed to stereo by duplication sits as a hard phantom centre rather than the
 * enveloping bed real tape hiss makes. Here the beds are 12 seconds long and genuinely
 * stereo, with independent (uncorrelated) noise per channel.
 */

import { clamp } from '../dsp/math.js';
import { mulberry32, gaussian, deriveSeed } from '../dsp/prng.js';
import { BUTTERWORTH_Q_DB } from '../dsp/biquad.js';

/** Noise bed length in seconds. Long enough that the loop is not a rhythmic event. */
export const NOISE_BED_SECONDS = 12;

/**
 * Nominal tape-transport delay. Needed so wow/flutter can modulate in both directions
 * when tape > 0. When tape is 0 (or the module is bypassed) this must be 0 — a 6 ms
 * delay with nothing modulating it is just unreported latency (issue #23 / SON-5).
 */
export const TAPE_TRANSPORT_DELAY_S = 0.006;

/**
 * Fill a stereo `AudioBuffer` with seeded Gaussian noise (tape hiss).
 * Channels are independent, so the bed is decorrelated and sits *around* the mix.
 */
export function fillHiss(buffer, seed) {
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const rng = mulberry32(deriveSeed(seed, `hiss:${c}`));
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] = gaussian(rng) * 0.2;
  }
}

/**
 * Sparse impulsive crackle. Density is per-sample probability; amplitudes follow a
 * heavy-tailed distribution so most ticks are small and a few are loud, which is what
 * surface noise actually sounds like.
 *
 * @param {AudioBuffer} buffer
 * @param {number} seed
 * @param {number} [density] events per sample, default 4e-4 (≈19/s at 48 kHz)
 */
export function fillCrackle(buffer, seed, density = 4e-4) {
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const rng = mulberry32(deriveSeed(seed, `crackle:${c}`));
    const d = buffer.getChannelData(c);
    d.fill(0);
    for (let i = 0; i < d.length; i++) {
      if (rng() < density) {
        // u^3 gives a heavy tail: most events near 0.3, occasional near 1.0.
        const u = rng();
        d[i] = (rng() < 0.5 ? -1 : 1) * (0.25 + 0.75 * u * u * u);
      }
    }
  }
}

/**
 * Brown-ish noise for turntable rumble. A leaky integrator over white noise gives a
 * −6 dB/octave slope; the DC leak (0.995) keeps it from wandering off, and the explicit
 * DC removal afterwards guarantees the bed cannot push a DC offset into the master.
 */
export function fillRumble(buffer, seed) {
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const rng = mulberry32(deriveSeed(seed, `rumble:${c}`));
    const d = buffer.getChannelData(c);
    let y = 0;
    let sum = 0;
    for (let i = 0; i < d.length; i++) {
      y = y * 0.995 + (rng() * 2 - 1) * 0.05;
      d[i] = y * 3;
      sum += d[i];
    }
    const dc = sum / d.length;
    for (let i = 0; i < d.length; i++) d[i] -= dc;
  }
}

/**
 * @typedef {object} CharacterNodes
 * @property {GainNode} input
 * @property {GainNode} output
 * @property {DelayNode} tapeDelay
 * @property {GainNode} wowDepth
 * @property {GainNode} flutterDepth
 * @property {BiquadFilterNode} headBump
 * @property {BiquadFilterNode} hfRolloff
 * @property {GainNode} hissGain
 * @property {GainNode} crackleGain
 * @property {GainNode} rumbleGain
 * @property {OscillatorNode[]} oscillators
 * @property {AudioBufferSourceNode[]} noiseSources
 */

/**
 * Build the character section.
 *
 * @param {BaseAudioContext} ctx
 * @param {number} seed texture seed
 * @returns {CharacterNodes}
 */
export function buildCharacter(ctx, seed) {
  const input = ctx.createGain();
  const output = ctx.createGain();

  // ── Tape transport: a delay line whose length is modulated by two LFOs ──
  // Built at 0 ms; `applyCharacter` raises it to TAPE_TRANSPORT_DELAY_S only when
  // tape > 0, so a bypassed/neutral chain does not carry 6 ms of dead delay.
  const tapeDelay = ctx.createDelay(0.05);
  tapeDelay.delayTime.value = 0;

  // Wow: slow speed variation, ~0.4 Hz (once per rotation of a 33⅓ rpm capstan-ish rate).
  const wowLfo = ctx.createOscillator();
  wowLfo.type = 'sine';
  wowLfo.frequency.value = 0.4;
  const wowDepth = ctx.createGain();
  wowDepth.gain.value = 0;

  // Flutter: fast scrape/roller variation, ~6.7 Hz.
  const flutterLfo = ctx.createOscillator();
  flutterLfo.type = 'sine';
  flutterLfo.frequency.value = 6.7;
  const flutterDepth = ctx.createGain();
  flutterDepth.gain.value = 0;

  // A third, very slow LFO detuned from the first breaks the perfectly periodic wow that
  // a single sine produces — real transports drift, they do not oscillate cleanly.
  const driftLfo = ctx.createOscillator();
  driftLfo.type = 'sine';
  driftLfo.frequency.value = 0.13;
  const driftDepth = ctx.createGain();
  driftDepth.gain.value = 0;

  wowLfo.connect(wowDepth).connect(tapeDelay.delayTime);
  flutterLfo.connect(flutterDepth).connect(tapeDelay.delayTime);
  driftLfo.connect(driftDepth).connect(tapeDelay.delayTime);

  const headBump = ctx.createBiquadFilter();
  headBump.type = 'peaking';
  headBump.frequency.value = 60;
  headBump.Q.value = 0.9;
  headBump.gain.value = 0;

  const hfRolloff = ctx.createBiquadFilter();
  hfRolloff.type = 'lowpass';
  hfRolloff.frequency.value = 22000;
  hfRolloff.Q.value = BUTTERWORTH_Q_DB; // node Q in dB — a roll-off, not a peak at 15 kHz

  input.connect(tapeDelay);
  tapeDelay.connect(headBump);
  headBump.connect(hfRolloff);
  hfRolloff.connect(output);

  // ── Noise beds ──
  const bedLength = Math.max(1, Math.floor(ctx.sampleRate * NOISE_BED_SECONDS));
  const makeBed = (fill, tag) => {
    const buf = ctx.createBuffer(2, bedLength, ctx.sampleRate);
    fill(buf, deriveSeed(seed, tag));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    return src;
  };

  const hissSrc = makeBed(fillHiss, 'bed:hiss');
  const hissHp = ctx.createBiquadFilter();
  hissHp.type = 'highpass';
  hissHp.frequency.value = 2500;
  hissHp.Q.value = BUTTERWORTH_Q_DB;
  const hissGain = ctx.createGain();
  hissGain.gain.value = 0;
  hissSrc.connect(hissHp).connect(hissGain).connect(output);

  const crackleSrc = makeBed(fillCrackle, 'bed:crackle');
  const crackleBp = ctx.createBiquadFilter();
  crackleBp.type = 'bandpass';
  crackleBp.frequency.value = 3200;
  crackleBp.Q.value = 0.6;
  const crackleGain = ctx.createGain();
  crackleGain.gain.value = 0;
  crackleSrc.connect(crackleBp).connect(crackleGain).connect(output);

  const rumbleSrc = makeBed(fillRumble, 'bed:rumble');
  const rumbleLp = ctx.createBiquadFilter();
  rumbleLp.type = 'lowpass';
  rumbleLp.frequency.value = 45;
  rumbleLp.Q.value = BUTTERWORTH_Q_DB;
  const rumbleHp = ctx.createBiquadFilter();
  // Keep rumble above the DC region: below ~15 Hz it is inaudible and only eats headroom.
  rumbleHp.type = 'highpass';
  rumbleHp.frequency.value = 15;
  rumbleHp.Q.value = BUTTERWORTH_Q_DB;
  const rumbleGain = ctx.createGain();
  rumbleGain.gain.value = 0;
  rumbleSrc.connect(rumbleLp).connect(rumbleHp).connect(rumbleGain).connect(output);

  const oscillators = [wowLfo, flutterLfo, driftLfo];
  const noiseSources = [hissSrc, crackleSrc, rumbleSrc];

  return {
    input,
    output,
    tapeDelay,
    wowDepth,
    flutterDepth,
    driftDepth,
    headBump,
    hfRolloff,
    hissGain,
    crackleGain,
    rumbleGain,
    oscillators,
    noiseSources,
    /** Start every generator. Must be called exactly once, after the graph is wired. */
    start(when = 0) {
      for (const n of [...oscillators, ...noiseSources]) {
        try {
          n.start(when);
        } catch {
          /* already started */
        }
      }
    },
    /** Stop and release every generator — required to avoid leaking oscillators. */
    stop() {
      for (const n of [...oscillators, ...noiseSources]) {
        try {
          n.stop();
        } catch {
          /* not started */
        }
        try {
          n.disconnect();
        } catch {
          /* already disconnected */
        }
      }
    },
  };
}

/**
 * Push character parameters onto a built section.
 *
 * @param {CharacterNodes} n
 * @param {object} p
 * @param {number} p.tape 0..100
 * @param {number} p.hiss 0..100
 * @param {number} p.vinyl 0..100
 * @param {boolean} [p.bypass]
 */
export function applyCharacter(n, p) {
  const tape = p.bypass ? 0 : clamp(p.tape, 0, 100) / 100;
  const hiss = p.bypass ? 0 : clamp(p.hiss, 0, 100) / 100;
  const vinyl = p.bypass ? 0 : clamp(p.vinyl, 0, 100) / 100;

  // Depths in seconds of delay-time deviation. ±1.2 ms of wow at 0.4 Hz is roughly
  // 0.3 % speed variation — heavy, but this is a rot laboratory, not a Studer.
  n.wowDepth.gain.value = tape * 0.0012;
  n.flutterDepth.gain.value = tape * 0.00018;
  n.driftDepth.gain.value = tape * 0.0006;
  n.headBump.gain.value = tape * 3.5;
  n.tapeDelay.delayTime.value = tape > 0 ? TAPE_TRANSPORT_DELAY_S : 0;

  n.hfRolloff.frequency.value = 22000 - vinyl * 7000; // → 15 kHz at full vinyl
  n.crackleGain.gain.value = vinyl * 0.12;
  n.rumbleGain.gain.value = vinyl * 0.05;
  n.hissGain.gain.value = hiss * 0.02;
}
