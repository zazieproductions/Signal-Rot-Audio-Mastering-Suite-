import { describe, it, expect } from 'vitest';
import { LAYOUTS, SP, getWavOrder, buildChannelMap } from '../src/lib/layouts.js';

describe('layouts', () => {
  it('defines every expected layout with the right channel count', () => {
    expect(LAYOUTS['5.1']).toHaveLength(6);
    expect(LAYOUTS['7.1']).toHaveLength(8);
    expect(LAYOUTS['7.1.2']).toHaveLength(10);
    expect(LAYOUTS['7.1.4']).toHaveLength(12);
    expect(LAYOUTS['9.1.6']).toHaveLength(16);
    expect(LAYOUTS.soniclab).toHaveLength(24);
  });

  it('keeps L/R/C/LFE in standard order for 5.1', () => {
    const { order, mask } = getWavOrder('5.1');
    expect(order.slice(0, 4)).toEqual(['L', 'R', 'C', 'LFE']);
    expect(mask).toBe(0x3f);
  });

  it('soniclab has no WAVE mask bits (self-described via ADM)', () => {
    const { order, mask } = getWavOrder('soniclab');
    expect(order).toHaveLength(24);
    expect(mask).toBe(0);
  });

  it('builds a machine-readable channel map', () => {
    const map = buildChannelMap('soniclab');
    expect(map.layout).toBe('soniclab');
    expect(map.channelCount).toBe(24);
    expect(map.channels[0]).toMatchObject({ index: 1, label: 'SL1' });
    expect(map.channels.every((c) => typeof c.azimuth === 'number' && typeof c.elevation === 'number')).toBe(true);
    const subs = map.channels.filter((c) => c.lfe);
    expect(subs.map((s) => s.label)).toEqual(['SL21', 'SL22', 'SL23', 'SL24']);
  });

  it('every channel label resolves in SP', () => {
    for (const layout of Object.keys(LAYOUTS)) {
      for (const k of LAYOUTS[layout]) {
        expect(SP[k], `missing SP entry ${k}`).toBeTruthy();
      }
    }
  });
});
