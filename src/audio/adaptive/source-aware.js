/**
 * Source-aware mastering adaptation.
 *
 * The preset defines the CHARACTER and the safe boundaries. The AUDIO determines how
 * strongly those processors are applied. A preset dialled for an open, dynamic mix must
 * not hit an already-crushed, already-loud master with the same force — that is how
 * healthy mixes come back distorted "simply by selecting a normal preset".
 *
 * ── What this module does ────────────────────────────────────────────────────────────
 * `adaptParameters` takes the user's parameter snapshot plus a small set of source
 * measurements and returns a *scaled-down-only* parameter set: it can only ever reduce
 * processing intensity, never increase it beyond what the preset (or the user's knobs)
 * asked for. The two exceptions are guardrails, not processing:
 *
 *  · `bassMono` may be *raised* to a floor (never lowered) on bass-heavy sources, so
 *    sub energy stays centred instead of wandering. Skipped when the source is mono
 *    (`stats.channels === 1`): a mono sub is already centred, and raising the corner
 *    would only force a stereo render downstream.
 *  · Nothing else is ever raised. No EQ boost is added, no width is widened, no drive
 *    is increased.
 *
 * ── Where it runs ────────────────────────────────────────────────────────────────────
 * Both the live preview (`app/bootstrap.js`) and the export (`render/render-master.js`)
 * call this same pure function with their own measurement of the *source* (not the
 * processed signal), so preview and export adapt identically. It is deliberately cheap —
 * pure arithmetic, no FFT — because the preview calls it on every control change.
 *
 * Every adaptation is reported as a human-readable string so the render report and the
 * UI can say *why* the preset was softened instead of silently doing less.
 */

import { clamp } from '../dsp/math.js';

/**
 * @typedef {object} SourceStats
 * @property {number} [integrated]   source integrated loudness, LUFS
 * @property {number} [lra]          source loudness range, LU
 * @property {number} [crestDb]      source crest factor, dB (peak-to-RMS)
 * @property {number} [truePeakDb]   source true peak, dBTP
 * @property {{bassDb:number, presenceDb:number, trebleDb:number}|null} [spectral]
 *   mean-removed tonal shape; see `spectralSummary`
 * @property {number} [channels]     source channel count; when 1 the bass-mono
 *   guardrail is skipped (a mono sub is already centred — raising the corner would
 *   only force a stereo render). Absent = unknown = previous behaviour.
 * @property {number} [correlation]  Pearson L/R correlation in [-1, 1]. Low or
 *   negative values mean the source is already wide or phasey — width processors
 *   are scaled down, never up.
 */

/**
 * @typedef {object} AdaptationResult
 * @property {Record<string, any>} parameters  adapted snapshot (scaled down only)
 * @property {string[]} adaptations             what was softened and why
 * @property {string} sourceClass               e.g. 'loud+dense', 'dynamic', 'balanced'
 */

/** Thresholds, kept in one place so they can be reasoned about and tested. */
export const ADAPTATION_THRESHOLDS = Object.freeze({
  /** At or above this integrated loudness the source is treated as already mastered. */
  loudLufs: -11,
  /** Within this distance below the target the source needs little pushing. */
  nearTargetLu: 2,
  /** Below this crest factor the source is already dense/crushed. */
  denseCrestDb: 10,
  crushedCrestDb: 7,
  /** Below this LRA (with a low crest) the source has no dynamics left to preserve. */
  crushedLraLu: 3,
  /** Above this crest/LRA the source is genuinely dynamic and must be left room. */
  dynamicCrestDb: 14,
  dynamicLraLu: 9,
  /** Above this true peak the source is hot — no input drive. */
  hotTruePeakDb: -1.5,
  veryHotTruePeakDb: -0.3,
  /** Spectral deviations (dB from the track's own mean) that count as imbalanced. */
  brightTrebleDb: 3,
  hotPresenceDb: 4,
  heavyBassDb: 4,
  /** Correlation below this: source is already wide — don't add more width. */
  wideCorrelation: 0.35,
  /** Correlation below this: phasey / out of phase — kill widening. */
  phaseyCorrelation: 0.15,
});

const scale100 = (v, f) => Math.round(clamp(v, 0, 100) * f);
const scaleSym100 = (v, f) => Math.round(clamp(v, -100, 100) * f);

/**
 * Classify a source into a short label for the report/UI.
 * @param {SourceStats} stats
 * @returns {string}
 */
export function classifySource(stats = {}) {
  const T = ADAPTATION_THRESHOLDS;
  const tags = [];
  const { integrated, lra, crestDb, truePeakDb, spectral, correlation: corr } = stats;
  const hasCore =
    Number.isFinite(integrated) || Number.isFinite(crestDb) || Number.isFinite(lra);
  if (!hasCore && !spectral && !Number.isFinite(corr)) return 'unmeasured';

  if (Number.isFinite(integrated) && integrated >= T.loudLufs) tags.push('loud');
  else if (Number.isFinite(integrated) && integrated <= -20) tags.push('quiet');

  const dense =
    (Number.isFinite(crestDb) && crestDb < T.crushedCrestDb) ||
    (Number.isFinite(lra) &&
      Number.isFinite(crestDb) &&
      lra < T.crushedLraLu &&
      crestDb < T.denseCrestDb);
  const dynamic =
    !dense &&
    ((Number.isFinite(crestDb) && crestDb > T.dynamicCrestDb) ||
      (Number.isFinite(lra) && lra > T.dynamicLraLu));
  if (dense) tags.push('dense');
  else if (dynamic) tags.push('dynamic');

  if (Number.isFinite(truePeakDb) && truePeakDb > T.hotTruePeakDb) tags.push('hot');
  if (Number.isFinite(corr)) {
    if (corr < T.phaseyCorrelation) tags.push('phasey');
    else if (corr < T.wideCorrelation) tags.push('wide');
  }
  if (spectral) {
    if (spectral.trebleDb > T.brightTrebleDb) tags.push('bright');
    if (spectral.bassDb > T.heavyBassDb) tags.push('bass-heavy');
    if (
      spectral.presenceDb > T.hotPresenceDb &&
      !tags.includes('bright')
    ) {
      tags.push('forward');
    }
  }
  if (!tags.length) tags.push('balanced');
  return tags.join('+');
}

/**
 * Reduce a fingerprint (`analysis/spectral-match.js`) to the three tonal regions the
 * adapter cares about. The fingerprint bands are already mean-removed, so these are
 * deviations from the track's own average level — loudness independent.
 *
 * @param {{bandsDb:number[]}|null} fingerprint 8 bands at MATCH_FREQS
 * @returns {{bassDb:number, presenceDb:number, trebleDb:number}|null}
 */
export function spectralSummary(fingerprint) {
  if (!fingerprint || !Array.isArray(fingerprint.bandsDb) || fingerprint.bandsDb.length < 8) {
    return null;
  }
  const b = fingerprint.bandsDb;
  // MATCH_FREQS = [60, 150, 400, 1000, 2500, 5000, 8000, 12000]
  const mean = (xs) => xs.reduce((a, v) => a + v, 0) / xs.length;
  return {
    bassDb: mean([b[0], b[1]]),
    presenceDb: mean([b[3], b[4]]),
    trebleDb: mean([b[6], b[7]]),
  };
}

/**
 * Adapt a parameter snapshot to the measured source. Only ever reduces processing.
 *
 * @param {Record<string, any>} parameters  validated snapshot (preset or user state)
 * @param {SourceStats} stats               measurements of the SOURCE
 * @returns {AdaptationResult}
 */
export function adaptParameters(parameters, stats = {}) {
  const T = ADAPTATION_THRESHOLDS;
  const p = { ...parameters };
  const notes = [];

  const { integrated, lra, crestDb, truePeakDb, spectral } = stats;
  const hasCore =
    Number.isFinite(integrated) || Number.isFinite(crestDb) || Number.isFinite(lra);
  if (!hasCore && !spectral && !Number.isFinite(stats.correlation)) {
    return { parameters: p, adaptations: [], sourceClass: 'unmeasured' };
  }

  const dense =
    (Number.isFinite(crestDb) && crestDb < T.crushedCrestDb) ||
    (Number.isFinite(lra) &&
      Number.isFinite(crestDb) &&
      lra < T.crushedLraLu &&
      crestDb < T.denseCrestDb);
  const alreadyLoud = Number.isFinite(integrated) && integrated >= T.loudLufs;
  const dynamic =
    !dense &&
    ((Number.isFinite(crestDb) && crestDb > T.dynamicCrestDb) ||
      (Number.isFinite(lra) && lra > T.dynamicLraLu));

  // ── 1. Already loud / already mastered: back everything off hard ──
  if (alreadyLoud || dense) {
    const why = alreadyLoud && dense
      ? 'already loud and dense'
      : alreadyLoud
        ? 'already at mastering loudness'
        : 'already dense/crushed';
    if (p.drive > 0) {
      notes.push(`input drive ${p.drive} → 0 dB (${why})`);
      p.drive = 0;
    }
    if (p.sat > 0) {
      const next = scale100(p.sat, 0.25);
      notes.push(`saturation ${p.sat} → ${next} (${why})`);
      p.sat = next;
    }
    for (const key of ['mbLow', 'mbMid', 'mbHigh']) {
      if (p[key] > 0) {
        const next = scale100(p[key], dense ? 0.3 : 0.45);
        notes.push(`${key} ${p[key]} → ${next} (${why})`);
        p[key] = next;
      }
    }
    for (const key of ['transAttack', 'transSustain']) {
      if (p[key] !== 0) {
        const next = scaleSym100(p[key], 0.4);
        notes.push(`${key} ${p[key]} → ${next} (${why})`);
        p[key] = next;
      }
    }
    // Already-mastered: don't add HF polish or extra width on top of a finished record.
    if (alreadyLoud) {
      if (p.air > 0.5) {
        notes.push(`air +${p.air} → +0.5 dB (${why})`);
        p.air = 0.5;
      }
      if (p.clarity > 0.5) {
        notes.push(`clarity +${p.clarity} → +0.5 dB (${why})`);
        p.clarity = 0.5;
      }
      if (p.tilt > 0) {
        notes.push(`tilt +${p.tilt} → +0 dB (${why})`);
        p.tilt = 0;
      }
      if (p.width > 1) {
        const next = 1 + (p.width - 1) * 0.25;
        notes.push(`width ${p.width.toFixed(2)} → ${next.toFixed(2)} (${why})`);
        p.width = next;
      }
    }
  } else if (Number.isFinite(crestDb) && crestDb < T.denseCrestDb) {
    // Moderately dense: ease off, don't hammer.
    for (const key of ['mbLow', 'mbMid', 'mbHigh']) {
      if (p[key] > 0) {
        const next = scale100(p[key], 0.6);
        notes.push(`${key} ${p[key]} → ${next} (moderately dense source)`);
        p[key] = next;
      }
    }
    if (p.sat > 0) {
      const next = scale100(p.sat, 0.6);
      notes.push(`saturation ${p.sat} → ${next} (moderately dense source)`);
      p.sat = next;
    }
    if (p.transAttack !== 0) {
      const next = scaleSym100(p.transAttack, 0.6);
      notes.push(`transAttack ${p.transAttack} → ${next} (moderately dense source)`);
      p.transAttack = next;
    }
    if (p.drive > 0.5) {
      notes.push(`input drive ${p.drive} → 0.5 dB (moderately dense source)`);
      p.drive = 0.5;
    }
  } else if (dynamic) {
    // Dynamic source: preserve its dynamics — light glue at most.
    for (const key of ['mbLow', 'mbMid', 'mbHigh']) {
      if (p[key] > 0) {
        const next = scale100(p[key], 0.7);
        notes.push(`${key} ${p[key]} → ${next} (preserving source dynamics)`);
        p[key] = next;
      }
    }
    if (p.mbMix > 70 && (p.mbLow > 0 || p.mbMid > 0 || p.mbHigh > 0)) {
      notes.push(`parallel mix ${p.mbMix} → 70 % (preserving source dynamics)`);
      p.mbMix = 70;
    }
  } else if (
    Number.isFinite(integrated) &&
    p.normalize &&
    integrated >= p.targetLUFS - T.nearTargetLu
  ) {
    // Near the target already: gentle ease so a balanced source gets minimal intervention.
    for (const key of ['mbLow', 'mbMid', 'mbHigh']) {
      if (p[key] > 0) {
        const next = scale100(p[key], 0.7);
        notes.push(`${key} ${p[key]} → ${next} (source already near the target)`);
        p[key] = next;
      }
    }
    if (p.sat > 0) {
      const next = scale100(p.sat, 0.6);
      notes.push(`saturation ${p.sat} → ${next} (source already near the target)`);
      p.sat = next;
    }
    if (p.drive > 0.5) {
      notes.push(`input drive ${p.drive} → 0.5 dB (source already near the target)`);
      p.drive = 0.5;
    }
  }

  // ── 2. Hot peaks: never add level into a hot source ──
  if (Number.isFinite(truePeakDb)) {
    if (truePeakDb > T.hotTruePeakDb && p.drive > 0) {
      notes.push(`input drive ${p.drive} → 0 dB (hot source peaks at ${truePeakDb.toFixed(1)} dBTP)`);
      p.drive = 0;
    }
    if (truePeakDb > T.veryHotTruePeakDb && p.sat > 0) {
      const next = scale100(p.sat, 0.5);
      notes.push(`saturation ${p.sat} → ${next} (very hot source peaks)`);
      p.sat = next;
    }
  }

  // ── 3. Spectral imbalances: don't brighten the bright or fatten the fat ──
  if (spectral) {
    if (spectral.trebleDb > T.brightTrebleDb) {
      if (p.clarity > 0) {
        notes.push(`clarity +${p.clarity} → +0 dB (source already bright)`);
        p.clarity = 0;
      }
      if (p.air > 0.5) {
        notes.push(`air +${p.air} → +0.5 dB (source already bright)`);
        p.air = 0.5;
      }
      if (p.tilt > 0) {
        notes.push(`tilt +${p.tilt} → +0 dB (source already bright)`);
        p.tilt = 0;
      }
      if (p.harsh > 0) {
        notes.push(`harshness +${p.harsh} → +0 dB (source already bright)`);
        p.harsh = 0;
      }
    } else if (spectral.presenceDb > T.hotPresenceDb && p.clarity > 0.5) {
      notes.push(`clarity +${p.clarity} → +0.5 dB (hot presence region)`);
      p.clarity = 0.5;
    }
    if (spectral.bassDb > T.heavyBassDb) {
      if (p.sub > 0.8) {
        notes.push(`sub +${p.sub} → +0.8 dB (bass-heavy source)`);
        p.sub = 0.8;
      }
      if (p.warm > 1.0) {
        notes.push(`warm +${p.warm} → +1.0 dB (bass-heavy source)`);
        p.warm = 1.0;
      }
      // Bass control without crushing the mix: keep the low band working, anchor the sub.
      if (p.mbLow > 0 && dense) {
        const restored = Math.max(p.mbLow, scale100(parameters.mbLow, 0.6));
        if (restored !== p.mbLow) {
          notes.push(`low band held at ${restored} (bass control on a bass-heavy source)`);
          p.mbLow = restored;
        }
      }
      if (p.bassMono < 90) {
        if (stats.channels === 1) {
          // Mono sub is already centred: nothing to fix, and raising the corner
          // would only force a stereo render downstream (issue #20).
          notes.push(`mono-below stays ${p.bassMono} Hz (mono source — nothing to centre)`);
        } else {
          notes.push(`mono-below ${p.bassMono} → 90 Hz (bass-heavy source)`);
          p.bassMono = 90;
        }
      }
    }
  }

  // ── 4. Already-wide / phasey: don't invent more width ──
  // Scale the deviation of width-like controls toward their neutral, never away.
  // bassMono is *not* raised here: a phasey source is a stereo problem, not a
  // loose-sub problem, and raising the corner would be an increase.
  const corr = stats.correlation;
  if (Number.isFinite(corr) && (corr < T.wideCorrelation || corr < T.phaseyCorrelation)) {
    const phasey = corr < T.phaseyCorrelation;
    const why = phasey
      ? `source correlation ${corr.toFixed(2)} (phasey)`
      : `source already wide (ρ=${corr.toFixed(2)})`;
    const widthFactor = phasey ? 0 : 0.35;
    const mbFactor = phasey ? 0 : 0.4;
    if (p.width !== 1) {
      const next = 1 + (p.width - 1) * widthFactor;
      notes.push(`width ${p.width.toFixed(2)} → ${next.toFixed(2)} (${why})`);
      p.width = next;
    }
    if (p.haas > 0) {
      const next = p.haas * widthFactor;
      notes.push(`haas ${p.haas} → ${next} (${why})`);
      p.haas = next;
    }
    if (p.spread > 0) {
      const next = p.spread * widthFactor;
      notes.push(`spread ${p.spread} → ${next} (${why})`);
      p.spread = next;
    }
    if (p.phaseRot > 0) {
      const next = p.phaseRot * widthFactor;
      notes.push(`phaseRot ${p.phaseRot} → ${next} (${why})`);
      p.phaseRot = next;
    }
    for (const key of ['widthLow', 'widthMid', 'widthHigh']) {
      if (p[key] !== 1) {
        const next = 1 + (p[key] - 1) * mbFactor;
        notes.push(`${key} ${p[key].toFixed(2)} → ${next.toFixed(2)} (${why})`);
        p[key] = next;
      }
    }
  }

  return { parameters: p, adaptations: notes, sourceClass: classifySource(stats) };
}
