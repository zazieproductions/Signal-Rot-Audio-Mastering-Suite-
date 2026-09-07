import { describe, it, expect } from 'vitest';
import {
  LAYOUTS,
  LAYOUT_IDS,
  SPEAKERS,
  channelCount,
  channelMapJson,
} from '../../src/audio/immersive/layouts.js';
import { SONIC_LAB_SPEAKERS, SONIC_LAB_RINGS } from '../../src/audio/immersive/sonic-lab.js';
import { defaultImmersive } from '../../src/app/state.js';
import { allLayoutReports } from './immersive-catalog.js';

const REPORTS = allLayoutReports();

describe('immersive layout fixtures (verification, no DSP changes)', () => {
  it('covers every layout the brief named', () => {
    expect(LAYOUT_IDS).toEqual(['5.1', '7.1', '7.1.2', '7.1.4', '9.1.6', 'soniclab']);
    expect(channelCount('5.1')).toBe(6);
    expect(channelCount('7.1')).toBe(8);
    expect(channelCount('7.1.2')).toBe(10);
    expect(channelCount('7.1.4')).toBe(12);
    expect(channelCount('9.1.6')).toBe(16);
    expect(channelCount('soniclab')).toBe(24);
  });

  it('declares a feed for every channel and never duplicates one', () => {
    for (const id of LAYOUT_IDS) {
      const r = REPORTS[id];
      expect(r.expectedFeeds).toHaveLength(r.channelCount);
      expect(new Set(r.expectedFeeds).size).toBe(r.channelCount);
      for (const key of r.expectedFeeds) expect(SPEAKERS[key]).toBeTruthy();
    }
  });

  it('places left speakers at positive ADM azimuth and right at negative', () => {
    for (const id of LAYOUT_IDS) {
      for (const ch of REPORTS[id].channels) {
        if (ch.lfe || ch.roles.includes('center') || ch.roles.includes('front-center')) continue;
        if (ch.roles.includes('left')) expect(ch.azimuthAdm, ch.id).toBeGreaterThan(0);
        if (ch.roles.includes('right')) expect(ch.azimuthAdm, ch.id).toBeLessThan(0);
      }
    }
  });

  it('keeps HRTF azimuth as the negation of ADM azimuth', () => {
    for (const id of LAYOUT_IDS) {
      for (const ch of REPORTS[id].channels) {
        expect(ch.azimuthHrtf).toBeCloseTo(-ch.azimuthAdm, 6);
      }
    }
  });

  it('routes height channels above the ear plane and subs as LFE', () => {
    const heights714 = REPORTS['7.1.4'].channels.filter((c) =>
      ['Ltf', 'Rtf', 'Ltr', 'Rtr'].includes(c.id),
    );
    expect(heights714).toHaveLength(4);
    for (const ch of heights714) {
      expect(ch.elevation).toBeGreaterThanOrEqual(40);
      expect(ch.roles).toContain('height');
      expect(ch.lfe).toBe(false);
    }
    expect(REPORTS['5.1'].lfeIndices).toEqual([3]);
    expect(REPORTS.soniclab.lfeIndices).toEqual([20, 21, 22, 23]);
    for (const idx of REPORTS.soniclab.lfeIndices) {
      expect(REPORTS.soniclab.channels[idx].lfe).toBe(true);
      expect(REPORTS.soniclab.channels[idx].roles).toContain('sub');
    }
  });

  it('front/rear placement matches the layout contract', () => {
    const five = Object.fromEntries(REPORTS['5.1'].channels.map((c) => [c.id, c]));
    expect(five.L.roles).toContain('front-left');
    expect(five.R.roles).toContain('front-right');
    expect(five.Ls.roles).toContain('rear-left');
    expect(five.Rs.roles).toContain('rear-right');
    expect(five.C.roles).toContain('front-center');

    const seven = Object.fromEntries(REPORTS['7.1'].channels.map((c) => [c.id, c]));
    expect(seven.Lss.roles).toContain('side-left');
    expect(seven.Lrs.roles).toContain('rear-left');
  });

  it('Sonic Lab 20.4 has 24 channels across five rings with preserved asymmetry', () => {
    expect(SONIC_LAB_SPEAKERS).toHaveLength(24);
    expect(SONIC_LAB_RINGS).toHaveLength(5);
    const byId = Object.fromEntries(SONIC_LAB_SPEAKERS.map((s) => [s.id, s]));
    expect(byId.SL1.azimuthAdm).toBe(30);
    expect(byId.SL2.azimuthAdm).toBe(-27);
    expect(byId.SL1.azimuthAdm).not.toBe(-byId.SL2.azimuthAdm);
    expect(REPORTS.soniclab.channelCount).toBe(24);
  });

  it('default immersive parameters are in range', () => {
    const d = defaultImmersive();
    expect(d.centerExtract).toBeGreaterThanOrEqual(0);
    expect(d.centerExtract).toBeLessThanOrEqual(1);
    expect(d.lfeFreqHz).toBeGreaterThanOrEqual(40);
    expect(d.lfeFreqHz).toBeLessThanOrEqual(200);
    expect(d.surrDelayMs).toBeGreaterThan(0);
  });

  it('channel maps are JSON-serialisable and 1-based', () => {
    for (const id of LAYOUT_IDS) {
      const json = channelMapJson(id, { sampleRate: 48000 });
      expect(json.channels[0].channel).toBe(1);
      expect(json.channels[json.channels.length - 1].channel).toBe(json.channelCount);
      expect(JSON.parse(JSON.stringify(json))).toEqual(json);
      expect(LAYOUTS[id]).toBeTruthy();
    }
  });

  it('exposes a machine-readable layout catalog the generator can snapshot', () => {
    expect(Object.keys(REPORTS)).toHaveLength(6);
    expect(REPORTS['7.1.4'].channels.some((c) => c.roles.includes('height'))).toBe(true);
    expect(REPORTS.soniclab.channels.filter((c) => c.lfe)).toHaveLength(4);
  });
});
