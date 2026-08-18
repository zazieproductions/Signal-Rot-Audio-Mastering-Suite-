import { describe, it, expect } from 'vitest';
import {
  SPEAKERS,
  SPEAKER,
  LAYOUTS,
  getWavOrder,
  channelCount,
  wavChannelPermutation,
} from '../src/immersive/layouts.js';

describe('speaker table', () => {
  it('maps every height channel to the correct WAVE mask bit', () => {
    // These four were wrong in the original table: the right-hand height
    // channels claimed the TOP_*_CENTER bits.
    expect(SPEAKERS.Ltf.bit).toBe(SPEAKER.TOP_FRONT_LEFT);
    expect(SPEAKERS.Rtf.bit).toBe(SPEAKER.TOP_FRONT_RIGHT);
    expect(SPEAKERS.Ltr.bit).toBe(SPEAKER.TOP_BACK_LEFT);
    expect(SPEAKERS.Rtr.bit).toBe(SPEAKER.TOP_BACK_RIGHT);
    // ...and specifically not the centre bits.
    expect(SPEAKERS.Rtf.bit).not.toBe(SPEAKER.TOP_FRONT_CENTER);
    expect(SPEAKERS.Rtr.bit).not.toBe(SPEAKER.TOP_BACK_CENTER);
  });

  it('gives the front wide channels a mask bit', () => {
    expect(SPEAKERS.Lw.bit).toBe(SPEAKER.FRONT_LEFT_OF_CENTER);
    expect(SPEAKERS.Rw.bit).toBe(SPEAKER.FRONT_RIGHT_OF_CENTER);
  });

  it('keeps ADM azimuth as the exact mirror of the renderer azimuth', () => {
    // The two conventions differ only in sign. Any other discrepancy means the
    // binaural preview and the exported ADM metadata describe different rooms
    // — the original table had the rear surrounds 15 deg apart this way.
    // +180 and -180 denote the same point directly behind the listener, so
    // compare as angles rather than as raw numbers.
    const wrap = (deg) => {
      let d = ((deg + 180) % 360 + 360) % 360 - 180;
      if (Math.abs(d + 180) < 1e-9) d = 180;
      return d;
    };
    for (const [name, sp] of Object.entries(SPEAKERS)) {
      expect(wrap(sp.aAz), `${name} azimuth convention`).toBeCloseTo(wrap(-sp.az), 5);
    }
  });

  it('places the rear surrounds where BS.2051 systems C/D specify', () => {
    expect(SPEAKERS.Lrs.az).toBe(-135);
    expect(SPEAKERS.Rrs.az).toBe(135);
    expect(SPEAKERS.Lrs.adm).toBe('M+135');
  });

  it('gives every speaker a unique ADM label', () => {
    const labels = Object.values(SPEAKERS).map((s) => s.adm);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('keeps elevations physically plausible', () => {
    for (const [name, sp] of Object.entries(SPEAKERS)) {
      expect(sp.el, name).toBeGreaterThanOrEqual(-90);
      expect(sp.el, name).toBeLessThanOrEqual(90);
      expect(Math.abs(sp.az), name).toBeLessThanOrEqual(180);
    }
  });
});

describe('layouts', () => {
  it('has the channel count its name implies', () => {
    expect(channelCount('5.1')).toBe(6);
    expect(channelCount('7.1')).toBe(8);
    expect(channelCount('7.1.2')).toBe(10);
    expect(channelCount('7.1.4')).toBe(12);
    expect(channelCount('9.1.6')).toBe(16);
    expect(channelCount('soniclab')).toBe(24);
  });

  it('references only speakers that exist', () => {
    for (const [layout, keys] of Object.entries(LAYOUTS)) {
      for (const k of keys) expect(SPEAKERS[k], `${layout}/${k}`).toBeDefined();
    }
  });

  it('never repeats a channel within a layout', () => {
    for (const [layout, keys] of Object.entries(LAYOUTS)) {
      expect(new Set(keys).size, layout).toBe(keys.length);
    }
  });
});

describe('getWavOrder', () => {
  it('produces the canonical 5.1 mask', () => {
    const { mask, maskable } = getWavOrder('5.1');
    expect(maskable).toBe(true);
    // FL|FR|FC|LFE|BL|BR
    expect(mask).toBe(0x3f);
  });

  it('produces the canonical 7.1 mask', () => {
    const { mask } = getWavOrder('7.1');
    // FL|FR|FC|LFE|BL|BR|SL|SR
    expect(mask).toBe(0x63f);
  });

  it('produces a 7.1.4 mask with distinct, correct height bits', () => {
    const { mask, maskable } = getWavOrder('7.1.4');
    expect(maskable).toBe(true);
    const expected =
      SPEAKER.FRONT_LEFT | SPEAKER.FRONT_RIGHT | SPEAKER.FRONT_CENTER | SPEAKER.LOW_FREQUENCY |
      SPEAKER.SIDE_LEFT | SPEAKER.SIDE_RIGHT | SPEAKER.BACK_LEFT | SPEAKER.BACK_RIGHT |
      SPEAKER.TOP_FRONT_LEFT | SPEAKER.TOP_FRONT_RIGHT |
      SPEAKER.TOP_BACK_LEFT | SPEAKER.TOP_BACK_RIGHT;
    expect(mask).toBe(expected);
    // The old table produced a mask containing TOP_FRONT_CENTER instead.
    expect(mask & SPEAKER.TOP_FRONT_CENTER).toBe(0);
    expect(mask & SPEAKER.TOP_BACK_CENTER).toBe(0);
  });

  it('sets exactly as many mask bits as there are channels', () => {
    for (const layout of ['5.1', '7.1', '7.1.2', '7.1.4']) {
      const { mask } = getWavOrder(layout);
      let bits = 0;
      for (let m = mask; m; m >>>= 1) bits += m & 1;
      expect(bits, layout).toBe(channelCount(layout));
    }
  });

  it('orders channels by ascending mask bit, as the spec requires', () => {
    for (const layout of ['5.1', '7.1', '7.1.2', '7.1.4']) {
      const { order } = getWavOrder(layout);
      const bits = order.map((k) => SPEAKERS[k].bit);
      expect([...bits].sort((a, b) => a - b), layout).toEqual(bits);
    }
  });

  it('falls back to mask 0 for layouts with no standard bit assignment', () => {
    // 9.1.6 has top-middle speakers and Sonic Lab is a bespoke rig; both rely
    // on ADM metadata for routing instead.
    for (const layout of ['9.1.6', 'soniclab']) {
      const { mask, maskable, order } = getWavOrder(layout);
      expect(maskable, layout).toBe(false);
      expect(mask, layout).toBe(0);
      expect(order, layout).toEqual(LAYOUTS[layout]);
    }
  });

  it('rejects an unknown layout', () => {
    expect(() => getWavOrder('22.2')).toThrow(RangeError);
  });
});

describe('wavChannelPermutation', () => {
  it('is a genuine permutation of the layout indices', () => {
    for (const layout of Object.keys(LAYOUTS)) {
      const perm = wavChannelPermutation(layout);
      expect(perm.length).toBe(channelCount(layout));
      expect([...perm].sort((a, b) => a - b)).toEqual(
        Array.from({ length: channelCount(layout) }, (_, i) => i),
      );
    }
  });

  it('is the identity where the layout is already in mask order', () => {
    expect(wavChannelPermutation('5.1')).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('reorders 7.1 so side surrounds follow the back pair', () => {
    // Natural order is L R C LFE Lss Rss Lrs Rrs, but SIDE_* bits (0x200/0x400)
    // sort after BACK_* (0x10/0x20).
    const { order } = getWavOrder('7.1');
    expect(order).toEqual(['L', 'R', 'C', 'LFE', 'Lrs', 'Rrs', 'Lss', 'Rss']);
  });
});
