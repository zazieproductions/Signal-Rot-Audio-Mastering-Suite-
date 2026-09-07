/**
 * Mastering-chain assembly.
 *
 * ── Signal-chain order and why ───────────────────────────────────────────────────────
 *
 *   INPUT
 *    → TRIM            input gain, the one place level enters the chain
 *    → MATCH EQ        corrective, broad, derived from a reference
 *    → TONE            tonal shaping (shelves, bells, tilt)
 *    → MULTIBAND       dynamics
 *    → STEREO          M/S width, per-band width, bass mono, Haas, crossfeed
 *    → CHARACTER       tape / vinyl / hiss
 *    → DEPTH           early reflections
 *    → SATURATION      harmonic colour
 *    → [offline only] TRANSIENT → NORMALIZATION → LIMITER
 *    → OUTPUT
 *
 * The audited chain was: match → tone → multiband → stereo → character → depth →
 * saturation. That order is broadly right and has been kept, with the reasoning made
 * explicit and two changes:
 *
 *  1. **Corrective before tonal.** Match EQ is derived from a measurement of the *source*,
 *     so it must act on something close to the source. Running it after tonal EQ would
 *     mean correcting a signal that no longer matches what was measured.
 *
 *  2. **Dynamics before stereo.** A multiband compressor working on an already-widened
 *     signal reacts to side energy that did not exist when the mix was made, and its
 *     stereo-linked detector will pull the image around. Compress the mix, then image it.
 *
 *  3. **Stereo before character and depth.** Tape modulation and early reflections should
 *     apply to the finished image, not be re-imaged afterwards — widening a delayed
 *     reflection produces a smeared, unstable rear image.
 *
 *  4. **Saturation last of the colour stages.** It is the only genuinely non-linear stage
 *     (the multiband is dynamic but not harmonic), so it should see the final spectrum.
 *     Putting it before EQ means EQ'ing harmonics you generated rather than generating
 *     harmonics from the sound you want.
 *
 *  5. **Transient shaping after all colour, before normalisation.** It changes crest
 *     factor, so normalisation must see the result; and it should act on the finished
 *     tone, not on a signal that is about to be saturated.
 *
 *  6. **Normalisation then limiting, iterated.** See `render/normalize.js`.
 *
 * The one change from the audited chain worth calling out: **the make-up gain of the
 * saturation stage is now its own node** (`saturation.makeup`), separate from the chain
 * output. In the audited code both were `outGain`, and the live preview's normalisation
 * write silently destroyed the saturation make-up — so preview and export differed by up
 * to 1.9 dB. Two responsibilities, two nodes.
 *
 * ── Bypass ───────────────────────────────────────────────────────────────────────────
 * Every module can be bypassed independently from the signal-flow view. Bypass is
 * implemented by neutralising the module's parameters rather than rewiring the graph:
 * rewiring during playback produces clicks, and a neutral module is bit-transparent
 * except for the multiband and stereo sections, whose all-pass paths are documented.
 */

import { buildTone, buildSaturation, applyTone, applySaturation } from './tone.js';
import { buildMultiband, bandAmountToSettings, MB_BALLISTICS } from './multiband.js';
import { buildStereo, applyStereo, setAudition } from './stereo.js';
import { buildCharacter, applyCharacter } from './character.js';
import { buildDepth, applyDepth } from './depth.js';
import { MATCH_FREQS } from '../../app/constants.js';
import { dbToGain } from '../dsp/math.js';
import { dynamicsCompressorMakeupCompensation } from '../dsp/dynamics-compressor.js';

/**
 * @typedef {object} MasteringChain
 * @property {GainNode} input
 * @property {GainNode} output
 * @property {GainNode} trim
 * @property {BiquadFilterNode[]} matchBands
 * @property {ReturnType<typeof buildTone>} tone
 * @property {ReturnType<typeof buildMultiband>} multiband
 * @property {ReturnType<typeof buildStereo>} stereo
 * @property {ReturnType<typeof buildCharacter>} character
 * @property {ReturnType<typeof buildDepth>} depth
 * @property {ReturnType<typeof buildSaturation>} saturation
 * @property {() => void} start
 * @property {() => void} dispose
 */

/**
 * Build the complete mastering chain in `ctx`.
 *
 * The same function builds the live graph and every offline render graph. That is
 * deliberate and is the main structural guarantee that preview and export agree: there is
 * exactly one chain constructor and exactly one parameter application function.
 *
 * @param {BaseAudioContext} ctx
 * @param {object} [opts]
 * @param {number} [opts.textureSeed] seed for the character engines' noise beds
 * @param {number} [opts.dryDelaySeconds] multiband dry-path delay; production renders
 *   pass the engine-measured value (`resolveDryDelaySeconds`), default is 6 ms
 * @returns {MasteringChain}
 */
export function buildMasteringChain(ctx, opts = {}) {
  const seed = opts.textureSeed ?? 0x5164a17;
  const dryDelaySeconds = opts.dryDelaySeconds;

  const input = ctx.createGain();
  const trim = ctx.createGain();
  input.connect(trim);

  // ── Match EQ: eight peaking bands in series, flat by default ──
  const matchBands = MATCH_FREQS.map((f) => {
    const b = ctx.createBiquadFilter();
    b.type = 'peaking';
    b.frequency.value = f;
    // Q = 1.0 gives roughly a ⅔-octave bell, which overlaps neighbouring bands enough
    // that a smooth target curve produces a smooth response rather than eight bumps.
    b.Q.value = 1.0;
    b.gain.value = 0;
    return b;
  });
  for (let i = 0; i < matchBands.length - 1; i++) matchBands[i].connect(matchBands[i + 1]);
  trim.connect(matchBands[0]);

  const tone = buildTone(ctx);
  const multiband = buildMultiband(
    ctx,
    dryDelaySeconds == null ? undefined : { dryDelaySeconds },
  );
  const stereo = buildStereo(ctx);
  const character = buildCharacter(ctx, seed);
  const depth = buildDepth(ctx);
  const saturation = buildSaturation(ctx);
  const output = ctx.createGain();

  matchBands[matchBands.length - 1].connect(tone.input);
  tone.output.connect(multiband.input);
  multiband.output.connect(stereo.input);
  stereo.output.connect(character.input);
  character.output.connect(depth.input);
  depth.output.connect(saturation.input);
  saturation.output.connect(output);

  return {
    input,
    output,
    trim,
    matchBands,
    tone,
    multiband,
    stereo,
    character,
    depth,
    saturation,
    start(when = 0) {
      character.start(when);
    },
    dispose() {
      character.stop();
      try {
        output.disconnect();
      } catch {
        /* already disconnected */
      }
    },
  };
}

/**
 * Return the node to connect to a stereo chain input for a buffer source: the source
 * itself for stereo buffers, or an explicit dual-mono up-mix for mono buffers.
 *
 * A 1-channel signal connected straight into the graph reaches the M/S
 * `ChannelSplitterNode` as L + *silence* (missing splitter outputs are zero, not
 * duplicates — the 1-channel-ness propagates through every gain/filter/delay node
 * under `channelCountMode: 'max'`), so the matrix computes mid = side = 0.5·L. The
 * side path's group delay then decorrelates the pair into half-energy pseudo-stereo
 * with a −6 dB mono fold-down (issue #20). Duplicating channel 0 into both inputs of
 * a `ChannelMergerNode` before the graph makes mono pass through at unity with
 * side = 0, regardless of engine up-mix rules. Callers rendering mono (not stereo)
 * from a mono source should connect the source directly instead.
 *
 * @param {AudioBufferSourceNode} src with `.buffer` already assigned
 * @returns {AudioNode} `src`, or a merger fed twice by `src`
 */
export function monoSafeSource(src) {
  const buffer = src.buffer;
  if (buffer && buffer.numberOfChannels === 1) {
    const merger = src.context.createChannelMerger(2);
    src.connect(merger, 0, 0);
    src.connect(merger, 0, 1);
    return merger;
  }
  return src;
}

/**
 * Push a parameter snapshot onto a chain.
 *
 * @param {MasteringChain} chain
 * @param {object} p validated parameter snapshot (see `app/parameters.js`)
 * @param {object} [opts]
 * @param {boolean} [opts.bypassAll]  audition the unprocessed source
 * @param {Record<string, boolean>} [opts.moduleBypass] per-module bypass from the flow view
 * @param {import('./stereo.js').AuditionMode} [opts.audition]
 */
export function applyParameters(chain, p, opts = {}) {
  const all = !!opts.bypassAll;
  const off = (id) => all || !!(opts.moduleBypass && opts.moduleBypass[id]);

  chain.trim.gain.value = all ? 1 : dbToGain(p.drive);

  // ── Match EQ ──
  const matchStrength = off('match') ? 0 : p.matchStrength / 100;
  chain.matchBands.forEach((band, i) => {
    // `|| 0` normalises negative zero (a negative correction × zero strength).
    band.gain.value = (p.matchGains[i] ?? 0) * matchStrength || 0;
  });

  // ── Tone ──
  applyTone(chain.tone, { ...p, bypass: off('tone') });

  // ── Multiband ──
  applyMultiband(chain.multiband, p, off('multiband'));

  // ── Stereo ──
  applyStereo(chain.stereo, { ...p, bypass: off('stereo') });
  setAudition(chain.stereo, opts.audition ?? 'stereo');

  // ── Character / depth / saturation ──
  applyCharacter(chain.character, { ...p, bypass: off('character') });
  applyDepth(chain.depth, { ...p, bypass: off('depth') });
  applySaturation(chain.saturation, { ...p, bypass: off('saturation') });
}

/**
 * @param {ReturnType<typeof buildMultiband>} n
 * @param {object} p
 * @param {boolean} bypass
 */
function applyMultiband(n, p, bypass) {
  const ballistics = MB_BALLISTICS[p.mbSpeed] ?? MB_BALLISTICS.med;

  const setBand = (comp, specMakeup, makeup, solo, amount, soloState, bandBypass) => {
    const active = !bypass && !bandBypass;
    const s = bandAmountToSettings(active ? amount : 0);
    comp.threshold.value = s.thresholdDb;
    comp.ratio.value = s.ratio;
    comp.knee.value = s.kneeDb;
    comp.attack.value = ballistics.attack;
    comp.release.value = ballistics.release;
    // Cancel the compressor's *fixed* spec make-up exactly. `DynamicsCompressorNode`
    // applies `pow(1 / Saturate(1, k), 0.6)` — a pure function of (threshold, knee,
    // ratio) worth up to +15 dB per band at deep settings — so without this node the
    // band's output level and tone do not belong to the user's settings at all. With
    // ratio 1:1 (inactive or bypassed band) the compensation is exactly 1.
    specMakeup.gain.value = dynamicsCompressorMakeupCompensation(
      s.thresholdDb,
      s.kneeDb,
      s.ratio,
    );
    // Optional auto make-up: a compressor with ratio R and threshold T applied to
    // programme sitting ~6 dB above threshold loses roughly (1 − 1/R) · 6 dB. This is a
    // rule of thumb, deliberately conservative, and off by default. With the spec
    // make-up compensated above, this is the *only* make-up the band can have.
    const autoDb = p.mbAutoMakeup && active ? (1 - 1 / s.ratio) * 6 * 0.5 : 0;
    makeup.gain.value = dbToGain(autoDb);
    solo.gain.value = soloState;
  };

  const anySolo = p.mbSolo && p.mbSolo !== 'none';
  const soloFor = (band) => (anySolo ? (p.mbSolo === band ? 1 : 0) : 1);

  setBand(
    n.compLow,
    n.specMakeupLow,
    n.lowMakeup,
    n.lowSolo,
    p.mbLow,
    soloFor('low'),
    p.mbBypassLow,
  );
  setBand(
    n.compMid,
    n.specMakeupMid,
    n.midMakeup,
    n.midSolo,
    p.mbMid,
    soloFor('mid'),
    p.mbBypassMid,
  );
  setBand(
    n.compHigh,
    n.specMakeupHigh,
    n.highMakeup,
    n.highSolo,
    p.mbHigh,
    soloFor('high'),
    p.mbBypassHigh,
  );

  // Soloing a band means hearing only that band, so the dry path must be muted too.
  const engaged = !bypass && (p.mbLow > 0 || p.mbMid > 0 || p.mbHigh > 0);
  const mix = anySolo ? 1 : engaged ? p.mbMix / 100 : 0;
  n.wet.gain.value = mix;
  n.dry.gain.value = anySolo ? 0 : 1 - mix;
  // When the wet path is silent the compressor look-ahead is not in circuit, so the
  // dry delay is pure unreported latency (issue #23). Restore it whenever mix > 0
  // so a parallel mix stays delay-matched.
  const nominal = n.dryDelaySeconds ?? n.dryDelay.delayTime.value;
  n.dryDelay.delayTime.value = mix > 0 ? nominal : 0;
}

/**
 * Read the per-band gain reduction from the compressor nodes, for the meters.
 * `DynamicsCompressorNode.reduction` is a read-only float in dB (≤ 0).
 * @param {MasteringChain} chain
 */
export function readGainReduction(chain) {
  const read = (c) => (typeof c.reduction === 'number' ? c.reduction : 0);
  return {
    low: read(chain.multiband.compLow),
    mid: read(chain.multiband.compMid),
    high: read(chain.multiband.compHigh),
  };
}
