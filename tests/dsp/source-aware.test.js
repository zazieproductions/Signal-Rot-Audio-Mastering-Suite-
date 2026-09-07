import { describe, it, expect } from 'vitest';
import {
  adaptParameters,
  classifySource,
  spectralSummary,
} from '../../src/audio/adaptive/source-aware.js';
import { defaultParameters } from '../../src/app/parameters.js';
import { spectralFingerprint } from '../../src/audio/analysis/spectral-match.js';
import { pinkNoise } from '../helpers/signals.js';

const params = (patch = {}) => ({ ...defaultParameters(), ...patch });

describe('classifySource', () => {
  it('reports unmeasured when there is nothing to go on', () => {
    expect(classifySource({})).toBe('unmeasured');
    expect(classifySource()).toBe('unmeasured');
  });

  it('recognises loud, dense, dynamic and quiet sources', () => {
    expect(classifySource({ integrated: -9, crestDb: 6, lra: 2 })).toContain('loud');
    expect(classifySource({ integrated: -9, crestDb: 6, lra: 2 })).toContain('dense');
    expect(classifySource({ integrated: -18, crestDb: 16, lra: 10 })).toContain('dynamic');
    expect(classifySource({ integrated: -24, crestDb: 12 })).toContain('quiet');
  });

  it('flags hot peaks and spectral imbalances', () => {
    expect(classifySource({ integrated: -14, truePeakDb: -0.5 })).toContain('hot');
    expect(
      classifySource({ integrated: -14, spectral: { bassDb: 0, presenceDb: 0, trebleDb: 5 } }),
    ).toContain('bright');
    expect(
      classifySource({ integrated: -14, spectral: { bassDb: 5, presenceDb: 0, trebleDb: 0 } }),
    ).toContain('bass-heavy');
  });

  it('calls a sane source balanced', () => {
    expect(classifySource({ integrated: -16, crestDb: 12, lra: 6, truePeakDb: -3 })).toBe(
      'balanced',
    );
  });
});

describe('spectralSummary', () => {
  it('returns null for a missing fingerprint', () => {
    expect(spectralSummary(null)).toBeNull();
    expect(spectralSummary({ bandsDb: [1, 2] })).toBeNull();
  });

  it('reduces a real fingerprint to three regions', () => {
    const fp = spectralFingerprint(pinkNoise({ seconds: 8, seed: 9 }));
    const s = spectralSummary(fp);
    expect(s).toBeTruthy();
    expect(Number.isFinite(s.bassDb)).toBe(true);
    expect(Number.isFinite(s.presenceDb)).toBe(true);
    expect(Number.isFinite(s.trebleDb)).toBe(true);
  });
});

describe('adaptParameters', () => {
  it('leaves parameters untouched when the source is unmeasured', () => {
    const p = params({ drive: 2, sat: 10, mbLow: 30 });
    const { parameters, adaptations, sourceClass } = adaptParameters(p, {});
    expect(parameters).toEqual(p);
    expect(adaptations).toEqual([]);
    expect(sourceClass).toBe('unmeasured');
  });

  it('backs off hard on an already loud, already dense source', () => {
    const p = params({
      drive: 2,
      sat: 12,
      mbLow: 30,
      mbMid: 25,
      mbHigh: 20,
      transAttack: 20,
      targetLUFS: -14,
    });
    const { parameters, adaptations } = adaptParameters(p, {
      integrated: -9.5,
      crestDb: 6,
      lra: 2.5,
      truePeakDb: -0.8,
    });
    expect(parameters.drive).toBe(0);
    expect(parameters.sat).toBeLessThan(p.sat);
    expect(parameters.mbLow).toBeLessThan(p.mbLow);
    expect(parameters.mbMid).toBeLessThan(p.mbMid);
    expect(parameters.transAttack).toBeLessThan(p.transAttack);
    expect(adaptations.length).toBeGreaterThan(0);
  });

  it('preserves the dynamics of a dynamic source', () => {
    const p = params({ mbLow: 30, mbMid: 25, mbHigh: 20, mbMix: 100 });
    const { parameters } = adaptParameters(p, {
      integrated: -20,
      crestDb: 17,
      lra: 11,
      truePeakDb: -3,
    });
    expect(parameters.mbLow).toBeLessThan(p.mbLow);
    expect(parameters.mbMix).toBeLessThanOrEqual(70);
  });

  it('removes HF excitement on a bright source', () => {
    const p = params({ clarity: 1.5, air: 2, tilt: 1, harsh: 0.8 });
    const { parameters, adaptations } = adaptParameters(p, {
      integrated: -15,
      crestDb: 12,
      spectral: { bassDb: 0, presenceDb: 1, trebleDb: 5 },
    });
    expect(parameters.clarity).toBe(0);
    expect(parameters.air).toBeLessThanOrEqual(0.5);
    expect(parameters.tilt).toBe(0);
    expect(parameters.harsh).toBe(0);
    expect(adaptations.some((n) => /bright/.test(n))).toBe(true);
  });

  it('controls bass without crushing the mix on a bass-heavy source', () => {
    const p = params({ sub: 2.5, warm: 2, bassMono: 0, mbLow: 30 });
    const { parameters } = adaptParameters(p, {
      integrated: -15,
      crestDb: 12,
      spectral: { bassDb: 5, presenceDb: 0, trebleDb: -1 },
    });
    expect(parameters.sub).toBeLessThanOrEqual(0.8);
    expect(parameters.warm).toBeLessThanOrEqual(1.0);
    expect(parameters.bassMono).toBeGreaterThanOrEqual(90);
  });

  it('skips the mono-below raise for a mono source (issue #20)', () => {
    const p = params({ sub: 2.5, warm: 2, bassMono: 0, mbLow: 30 });
    const { parameters, adaptations, sourceClass } = adaptParameters(p, {
      integrated: -15,
      crestDb: 12,
      spectral: { bassDb: 5, presenceDb: 0, trebleDb: -1 },
      channels: 1,
    });
    // A mono sub is already centred: the corner stays where the user put it, and the
    // report says why instead of silently forcing a stereo render downstream.
    expect(parameters.bassMono).toBe(0);
    expect(adaptations.some((n) => /mono-below stays 0 Hz/.test(n))).toBe(true);
    // The rest of the bass-heavy guardrail still applies.
    expect(parameters.sub).toBeLessThanOrEqual(0.8);
    expect(parameters.warm).toBeLessThanOrEqual(1.0);
    expect(sourceClass).toContain('bass-heavy');
  });

  it('still raises mono-below for stereo bass-heavy sources', () => {
    const p = params({ sub: 2.5, warm: 2, bassMono: 0, mbLow: 30 });
    const { parameters, adaptations } = adaptParameters(p, {
      integrated: -15,
      crestDb: 12,
      spectral: { bassDb: 5, presenceDb: 0, trebleDb: -1 },
      channels: 2,
    });
    expect(parameters.bassMono).toBe(90);
    expect(adaptations.some((n) => /mono-below 0 → 90 Hz/.test(n))).toBe(true);
  });

  it('raises mono-below when the channel count is unknown (back-compat)', () => {
    const p = params({ sub: 2.5, warm: 2, bassMono: 0, mbLow: 30 });
    const { parameters } = adaptParameters(p, {
      integrated: -15,
      crestDb: 12,
      spectral: { bassDb: 5, presenceDb: 0, trebleDb: -1 },
    });
    expect(parameters.bassMono).toBe(90);
  });

  it('kills input drive on hot sources', () => {
    const p = params({ drive: 2, sat: 10 });
    const { parameters } = adaptParameters(p, {
      integrated: -13,
      crestDb: 11,
      truePeakDb: -0.2,
    });
    expect(parameters.drive).toBe(0);
    expect(parameters.sat).toBeLessThan(p.sat);
  });

  it('eases off gently when the source is already near the target', () => {
    const p = params({ drive: 1.5, sat: 10, mbMid: 20, targetLUFS: -14, normalize: true });
    const { parameters, adaptations } = adaptParameters(p, {
      integrated: -14.5,
      crestDb: 12,
      lra: 6,
      truePeakDb: -2,
    });
    expect(parameters.mbMid).toBeLessThan(p.mbMid);
    expect(parameters.sat).toBeLessThan(p.sat);
    expect(adaptations.length).toBeGreaterThan(0);
  });

  it('never increases processing beyond what was asked', () => {
    // Scale-down-only is a hard contract: fuzz it across sources and snapshots.
    const cases = [
      [{ integrated: -8, crestDb: 5, lra: 2, truePeakDb: -0.2 }],
      [{ integrated: -22, crestDb: 18, lra: 12, truePeakDb: -4 }],
      [{ integrated: -14, crestDb: 11, spectral: { bassDb: 5, presenceDb: 5, trebleDb: 5 } }],
      [{ integrated: -14, crestDb: 11, spectral: { bassDb: -4, presenceDb: -4, trebleDb: -4 } }],
      [{ integrated: -14.2, crestDb: 12, lra: 6, truePeakDb: -2 }],
    ];
    const downs = ['drive', 'sat', 'mbLow', 'mbMid', 'mbHigh', 'mbMix'];
    for (const [stats] of cases) {
      const p = params({
        drive: 2,
        sat: 15,
        mbLow: 30,
        mbMid: 25,
        mbHigh: 20,
        mbMix: 90,
        transAttack: 20,
        transSustain: -15,
        clarity: 1.5,
        air: 1.5,
        tilt: 1,
        harsh: 1,
        sub: 2,
        warm: 2,
        bassMono: 60,
      });
      const { parameters: q } = adaptParameters(p, stats);
      for (const key of downs) {
        expect(q[key], `${key} increased`).toBeLessThanOrEqual(p[key]);
      }
      expect(Math.abs(q.transAttack)).toBeLessThanOrEqual(Math.abs(p.transAttack));
      expect(Math.abs(q.transSustain)).toBeLessThanOrEqual(Math.abs(p.transSustain));
      // Positive EQ boosts may only shrink (cuts are corrective and untouched).
      for (const key of ['clarity', 'air', 'tilt', 'harsh', 'sub', 'warm']) {
        if (p[key] > 0) expect(q[key], key).toBeLessThanOrEqual(p[key]);
      }
      // bassMono is the one guardrail allowed to rise — and only to centre loose sub.
      expect(q.bassMono).toBeGreaterThanOrEqual(0);
    }
  });

  it('does not mutate its input', () => {
    const p = params({ drive: 2, sat: 12, mbLow: 30 });
    const before = { ...p };
    adaptParameters(p, { integrated: -9, crestDb: 6, lra: 2, truePeakDb: -0.5 });
    expect(p).toEqual(before);
  });
});
