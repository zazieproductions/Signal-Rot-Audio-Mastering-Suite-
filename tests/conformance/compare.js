/**
 * Compare two measurement sets (baseline vs candidate) and flag suspicious regressions.
 *
 * The comparer does **not** declare a creative preset wrong because it changed audio.
 * Flags are classified:
 *
 *   defect     — always a problem (NaN, missing channels, true-peak violation, DC)
 *   reference  — a problem only on a REFERENCE / CLEAN path
 *   creative   — informational on a CREATIVE / SIGNAL ROT path; defect on reference
 *   browser    — cross-engine disagreement; recorded, not a DSP "bug"
 *
 * Input shape: `{ measurements: Measurement[] }` or a bare array, or a dict keyed by id.
 */

import { THRESHOLDS, CEILING_DEFAULT_DBTP } from './thresholds.js';
import { classOfMeasurement } from './classify.js';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function asList(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  if (Array.isArray(input.measurements)) return input.measurements;
  if (typeof input === 'object') return Object.values(input).filter((v) => v && v.id);
  return [];
}

function indexById(list) {
  const map = new Map();
  for (const m of list) {
    const key = [m.id, m.browser, m.class, m.engine].filter(Boolean).join('|');
    map.set(m.id ?? key, m);
    map.set(key, m);
  }
  return map;
}

function delta(a, b) {
  if (a == null || b == null) return null;
  return b - a;
}

function absDelta(a, b) {
  const d = delta(a, b);
  return d == null ? null : Math.abs(d);
}

function pickThreshold(spec, cls) {
  if (typeof spec === 'number') return spec;
  return spec[cls] ?? spec.reference ?? spec.creative;
}

function bandMap(measurement) {
  const out = {};
  for (const b of measurement?.spectrum?.bandsDb ?? []) {
    if (b && b.id) out[b.id] = b.db;
  }
  return out;
}

/**
 * @param {object} baseline
 * @param {object} candidate
 * @param {object} [opts]
 * @returns {{flags: object[], summary: object, pairs: object[]}}
 */
export function compareMeasurements(baseline, candidate, opts = {}) {
  const baseList = asList(baseline);
  const candList = asList(candidate);
  const baseIdx = indexById(baseList);
  const flags = [];
  const pairs = [];

  const flag = (entry) => {
    flags.push(entry);
    return entry;
  };

  for (const cand of candList) {
    const cls = opts.class ?? classOfMeasurement(cand);
    const base = baseIdx.get(cand.id) ?? null;
    const pair = { id: cand.id, class: cls, baseline: base, candidate: cand, deltas: {} };
    pairs.push(pair);

    const finite = cand.finite;
    if (finite && !finite.ok) {
      flag({
        severity: 'defect',
        kind: finite.nan ? 'nan' : 'infinity',
        id: cand.id,
        class: cls,
        message: `${cand.id}: ${finite.nan} NaN and ${finite.inf} non-finite samples`,
      });
    }

    const dc = cand.dc?.maxAbs;
    const baseDc = base?.dc?.maxAbs;
    if (dc != null && dc > THRESHOLDS.dc) {
      flag({
        severity: 'defect',
        kind: 'dc',
        id: cand.id,
        class: cls,
        message: `${cand.id}: unexpected DC ${dc} (threshold ${THRESHOLDS.dc})`,
        value: dc,
      });
    } else if (
      dc != null &&
      baseDc != null &&
      dc - baseDc > THRESHOLDS.dcGrowth &&
      cls === 'reference'
    ) {
      flag({
        severity: 'defect',
        kind: 'dc',
        id: cand.id,
        class: cls,
        message: `${cand.id}: DC grew by ${(dc - baseDc).toFixed(5)} on a reference path`,
        value: dc,
      });
    }

    const ceiling = opts.ceilingDb ?? CEILING_DEFAULT_DBTP;
    const tp = cand.peak?.truePeakDb;
    if (opts.checkCeiling && tp != null && tp > ceiling + THRESHOLDS.truePeakOvershootDb) {
      flag({
        severity: 'defect',
        kind: 'true-peak-violation',
        id: cand.id,
        class: cls,
        message: `${cand.id}: true peak ${tp} dBTP exceeds ceiling ${ceiling} dBTP`,
        value: tp,
        ceiling,
      });
    }

    if (cand.channels != null && opts.expectedChannels != null) {
      if (cand.channels !== opts.expectedChannels) {
        flag({
          severity: 'defect',
          kind: 'missing-immersive-channels',
          id: cand.id,
          class: cls,
          message: `${cand.id}: expected ${opts.expectedChannels} channels, got ${cand.channels}`,
        });
      }
    }

    if (Array.isArray(cand.perChannel)) {
      const silent = cand.perChannel.filter((c) => c.silent);
      if (opts.requireAllChannelsLive && silent.length) {
        flag({
          severity: 'defect',
          kind: 'silent-feed',
          id: cand.id,
          class: cls,
          message: `${cand.id}: silent channels ${silent.map((c) => c.index).join(', ')}`,
        });
      }
    }

    if (!base) continue;

    const dLufs = absDelta(base.loudness?.integrated, cand.loudness?.integrated);
    pair.deltas.loudnessLu = delta(base.loudness?.integrated, cand.loudness?.integrated);
    if (dLufs != null && dLufs > pickThreshold(THRESHOLDS.loudnessDb, cls)) {
      flag({
        severity: cls === 'reference' ? 'defect' : 'info',
        kind: 'loudness-change',
        id: cand.id,
        class: cls,
        message: `${cand.id}: integrated loudness moved ${pair.deltas.loudnessLu.toFixed(2)} LU (${cls})`,
        baseline: base.loudness?.integrated,
        candidate: cand.loudness?.integrated,
      });
    }

    const dCrest = delta(base.crestFactorDb, cand.crestFactorDb);
    pair.deltas.crestDb = dCrest;
    if (dCrest != null && dCrest < -pickThreshold(THRESHOLDS.crestCollapseDb, cls)) {
      flag({
        severity: cls === 'reference' ? 'defect' : 'info',
        kind: 'crest-collapse',
        id: cand.id,
        class: cls,
        message: `${cand.id}: crest factor dropped ${(-dCrest).toFixed(2)} dB (${cls})`,
        baseline: base.crestFactorDb,
        candidate: cand.crestFactorDb,
      });
    }

    const dRms = absDelta(base.rmsDb, cand.rmsDb);
    pair.deltas.rmsDb = delta(base.rmsDb, cand.rmsDb);
    if (dRms != null && dRms > pickThreshold(THRESHOLDS.rmsDb, cls)) {
      flag({
        severity: cls === 'reference' ? 'defect' : 'info',
        kind: 'rms-change',
        id: cand.id,
        class: cls,
        message: `${cand.id}: RMS moved ${pair.deltas.rmsDb.toFixed(2)} dB (${cls})`,
      });
    }

    const dCorr = delta(base.correlation, cand.correlation);
    pair.deltas.correlation = dCorr;
    if (dCorr != null && dCorr < -pickThreshold(THRESHOLDS.correlationDrop, cls)) {
      flag({
        severity: cls === 'reference' ? 'defect' : 'info',
        kind: 'correlation-collapse',
        id: cand.id,
        class: cls,
        message: `${cand.id}: correlation dropped ${(-dCorr).toFixed(3)} (${cls})`,
        baseline: base.correlation,
        candidate: cand.correlation,
      });
    }

    const baseLoss = base.mono?.worstBand?.monoLossDb;
    const candLoss = cand.mono?.worstBand?.monoLossDb;
    const dMono = delta(baseLoss, candLoss);
    pair.deltas.monoLossDb = dMono;
    if (dMono != null && dMono < -pickThreshold(THRESHOLDS.monoLossDb, cls)) {
      flag({
        severity: cls === 'reference' ? 'defect' : 'info',
        kind: 'mono-sum-degradation',
        id: cand.id,
        class: cls,
        message: `${cand.id}: mono fold-down worsened by ${(-dMono).toFixed(2)} dB (${cls})`,
      });
    }

    const dCentroid = absDelta(base.spectrum?.centroidHz, cand.spectrum?.centroidHz);
    pair.deltas.centroidHz = delta(base.spectrum?.centroidHz, cand.spectrum?.centroidHz);
    if (dCentroid != null && dCentroid > pickThreshold(THRESHOLDS.centroidHz, cls)) {
      flag({
        severity: cls === 'reference' ? 'defect' : 'info',
        kind: 'spectral-shift',
        id: cand.id,
        class: cls,
        message: `${cand.id}: spectral centroid moved ${dCentroid.toFixed(0)} Hz (${cls})`,
      });
    }

    const baseBands = bandMap(base);
    const candBands = bandMap(cand);
    let worstBand = null;
    for (const id of Object.keys(baseBands)) {
      const d = absDelta(baseBands[id], candBands[id]);
      if (d == null) continue;
      if (!worstBand || d > worstBand.db) worstBand = { id, db: d };
    }
    pair.deltas.worstBand = worstBand;
    if (worstBand && worstBand.db > pickThreshold(THRESHOLDS.spectralShiftDb, cls)) {
      flag({
        severity: cls === 'reference' ? 'defect' : 'info',
        kind: 'spectral-shift',
        id: cand.id,
        class: cls,
        message: `${cand.id}: ${worstBand.id} band moved ${worstBand.db.toFixed(2)} dB (${cls})`,
        band: worstBand.id,
      });
    }
  }

  for (const base of baseList) {
    if (!candList.some((c) => c.id === base.id)) {
      flag({
        severity: 'defect',
        kind: 'missing-measurement',
        id: base.id,
        class: classOfMeasurement(base),
        message: `${base.id}: present in baseline, missing from candidate`,
      });
    }
  }

  const defects = flags.filter((f) => f.severity === 'defect');
  const infos = flags.filter((f) => f.severity !== 'defect');
  return {
    flags,
    pairs,
    summary: {
      baselineCount: baseList.length,
      candidateCount: candList.length,
      pairCount: pairs.length,
      defectCount: defects.length,
      infoCount: infos.length,
      kinds: [...new Set(flags.map((f) => f.kind))],
      ok: defects.length === 0,
    },
  };
}

/**
 * Compare the same measurement id across browsers. Large divergence is recorded as a
 * `browser` finding, not a DSP defect — native nodes are implementation-defined.
 */
export function compareBrowsers(measurementsByBrowser, opts = {}) {
  const browsers = Object.keys(measurementsByBrowser);
  if (browsers.length < 2) {
    return { flags: [], summary: { browserCount: browsers.length, ok: true, skipped: true } };
  }
  const flags = [];
  const refName = browsers.includes('chromium') ? 'chromium' : browsers[0];
  const refList = asList(measurementsByBrowser[refName]);
  for (const other of browsers.filter((b) => b !== refName)) {
    const result = compareMeasurements(refList, asList(measurementsByBrowser[other]), {
      ...opts,
      class: 'reference',
    });
    for (const f of result.flags) {
      flags.push({
        ...f,
        severity:
          f.severity === 'defect' && f.kind !== 'nan' && f.kind !== 'infinity'
            ? 'browser'
            : f.severity,
        kind: f.kind === 'loudness-change' ? 'browser-divergence' : f.kind,
        browser: other,
        against: refName,
        message: `[${other} vs ${refName}] ${f.message}`,
      });
    }
  }
  return {
    flags,
    summary: {
      browserCount: browsers.length,
      browsers,
      flagCount: flags.length,
      ok: flags.filter((f) => f.severity === 'defect').length === 0,
    },
  };
}

export { num, asList };
