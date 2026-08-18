import { describe, it, expect } from 'vitest';
import {
  LAYOUTS,
  LAYOUT_IDS,
  SPEAKERS,
  wavChannelOrder,
  channelCount,
  lfeChannelIndices,
  channelMapText,
  channelMapJson,
} from '../../src/audio/immersive/layouts.js';
import {
  SONIC_LAB_SPEAKERS,
  SONIC_LAB_RINGS,
  sonicLabChannelMapText,
  sonicLabChannelMapJson,
} from '../../src/audio/immersive/sonic-lab.js';
import { SPEAKER_MASK } from '../../src/audio/encode/wav.js';

describe('speaker table', () => {
  it('keeps the two azimuth conventions consistent: HRTF = −ADM', () => {
    for (const sp of Object.values(SPEAKERS)) {
      expect(sp.azimuthHrtf).toBeCloseTo(-sp.azimuthAdm, 6);
    }
  });

  it('keeps every azimuth in (−180, 180]', () => {
    for (const sp of Object.values(SPEAKERS)) {
      expect(sp.azimuthAdm).toBeGreaterThanOrEqual(-180);
      expect(sp.azimuthAdm).toBeLessThanOrEqual(180);
    }
  });

  it('gives every speaker an ADM label and a description', () => {
    for (const sp of Object.values(SPEAKERS)) {
      expect(sp.admSpeakerLabel).toBeTruthy();
      expect(sp.description).toBeTruthy();
    }
  });

  /**
   * BS.2051 places 7.1 rear surrounds at ±135°. The pre-7.0 table carried the label
   * 'M+135' with an azimuth of 150°, so the metadata and the renderer disagreed by 15°.
   */
  it('matches BS.2051 labels to their azimuths', () => {
    expect(SPEAKERS.L.admSpeakerLabel).toBe('M+030');
    expect(SPEAKERS.L.azimuthAdm).toBe(30);
    expect(SPEAKERS.Lrs.admSpeakerLabel).toBe('M+135');
    expect(SPEAKERS.Lrs.azimuthAdm).toBe(135);
    expect(SPEAKERS.Rrs.admSpeakerLabel).toBe('M-135');
    expect(SPEAKERS.Rrs.azimuthAdm).toBe(-135);
    expect(SPEAKERS.Ltf.admSpeakerLabel).toBe('U+045');
    expect(SPEAKERS.Ltf.elevation).toBe(45);
  });

  it('assigns the correct WAVEFORMATEXTENSIBLE bits to the height channels', () => {
    expect(SPEAKERS.Ltf.wavMaskBit).toBe(SPEAKER_MASK.TOP_FRONT_LEFT);
    expect(SPEAKERS.Rtf.wavMaskBit).toBe(SPEAKER_MASK.TOP_FRONT_RIGHT);
    expect(SPEAKERS.Ltr.wavMaskBit).toBe(SPEAKER_MASK.TOP_BACK_LEFT);
    expect(SPEAKERS.Rtr.wavMaskBit).toBe(SPEAKER_MASK.TOP_BACK_RIGHT);
    // The pre-7.0 bug: centre-height bits used for right-height channels.
    expect(SPEAKERS.Rtf.wavMaskBit).not.toBe(SPEAKER_MASK.TOP_FRONT_CENTER);
    expect(SPEAKERS.Rtr.wavMaskBit).not.toBe(SPEAKER_MASK.TOP_BACK_CENTER);
  });
});

describe('layouts', () => {
  it('exposes six layouts with the expected channel counts', () => {
    expect(LAYOUT_IDS).toEqual(['5.1', '7.1', '7.1.2', '7.1.4', '9.1.6', 'soniclab']);
    expect(channelCount('5.1')).toBe(6);
    expect(channelCount('7.1')).toBe(8);
    expect(channelCount('7.1.2')).toBe(10);
    expect(channelCount('7.1.4')).toBe(12);
    expect(channelCount('9.1.6')).toBe(16);
    expect(channelCount('soniclab')).toBe(24);
  });

  it('references only speakers that exist', () => {
    for (const layout of Object.values(LAYOUTS)) {
      for (const key of layout.channels) expect(SPEAKERS[key]).toBeTruthy();
    }
  });

  it('has no duplicate channels within a layout', () => {
    for (const layout of Object.values(LAYOUTS)) {
      expect(new Set(layout.channels).size).toBe(layout.channels.length);
    }
  });

  it('documents every layout', () => {
    for (const layout of Object.values(LAYOUTS)) {
      expect(layout.notes.length).toBeGreaterThan(20);
      expect(layout.name).toBeTruthy();
    }
  });
});

describe('WAV channel ordering', () => {
  it('orders 5.1 as L R C LFE BL BR', () => {
    const { order, mask, standard } = wavChannelOrder('5.1');
    expect(standard).toBe(true);
    expect(order).toEqual(['L', 'R', 'C', 'LFE', 'Ls', 'Rs']);
    expect(mask).toBe(0x3f);
  });

  it('orders 7.1 as L R C LFE BL BR SL SR — mask-bit order, not layout order', () => {
    const { order, mask, standard } = wavChannelOrder('7.1');
    expect(standard).toBe(true);
    expect(order).toEqual(['L', 'R', 'C', 'LFE', 'Lrs', 'Rrs', 'Lss', 'Rss']);
    expect(mask).toBe(0x63f);
  });

  it('orders 7.1.4 with the heights in ascending mask-bit order', () => {
    const { order, mask, standard } = wavChannelOrder('7.1.4');
    expect(standard).toBe(true);
    expect(order).toEqual([
      'L',
      'R',
      'C',
      'LFE',
      'Lrs',
      'Rrs',
      'Lss',
      'Rss',
      'Ltf',
      'Rtf',
      'Ltr',
      'Rtr',
    ]);
    expect(mask).toBe(
      SPEAKER_MASK.FRONT_LEFT |
        SPEAKER_MASK.FRONT_RIGHT |
        SPEAKER_MASK.FRONT_CENTER |
        SPEAKER_MASK.LOW_FREQUENCY |
        SPEAKER_MASK.BACK_LEFT |
        SPEAKER_MASK.BACK_RIGHT |
        SPEAKER_MASK.SIDE_LEFT |
        SPEAKER_MASK.SIDE_RIGHT |
        SPEAKER_MASK.TOP_FRONT_LEFT |
        SPEAKER_MASK.TOP_FRONT_RIGHT |
        SPEAKER_MASK.TOP_BACK_LEFT |
        SPEAKER_MASK.TOP_BACK_RIGHT,
    );
  });

  it('never produces a mask with a duplicated bit', () => {
    for (const id of LAYOUT_IDS) {
      const { order, standard } = wavChannelOrder(id);
      if (!standard) continue;
      const bits = order.map((k) => SPEAKERS[k].wavMaskBit);
      expect(new Set(bits).size).toBe(bits.length);
    }
  });

  it('falls back to layout order with mask 0 where no standard mask exists', () => {
    for (const id of ['9.1.6', 'soniclab']) {
      const { order, mask, standard } = wavChannelOrder(id);
      expect(standard).toBe(false);
      expect(mask).toBe(0);
      expect(order).toEqual(LAYOUTS[id].channels);
    }
  });

  it('returns an empty result for an unknown layout instead of throwing', () => {
    expect(wavChannelOrder('atmos-7.1.4.2')).toEqual({ order: [], mask: 0, standard: false });
  });

  it('identifies LFE channel indices in delivery order', () => {
    expect(lfeChannelIndices('5.1')).toEqual([3]);
    const { order } = wavChannelOrder('7.1.4');
    expect(lfeChannelIndices('7.1.4', order)).toEqual([3]);
    // Sonic Lab has four subwoofers at the end.
    expect(lfeChannelIndices('soniclab')).toEqual([20, 21, 22, 23]);
  });
});

describe('Sonic Lab 20.4', () => {
  it('declares 24 channels across five rings', () => {
    expect(SONIC_LAB_SPEAKERS).toHaveLength(24);
    const total = SONIC_LAB_RINGS.reduce((sum, ring) => sum + ring.channels.length, 0);
    expect(total).toBe(24);
  });

  it('assigns every channel to exactly one ring', () => {
    const seen = new Set();
    for (const ring of SONIC_LAB_RINGS) {
      for (const channel of ring.channels) {
        expect(seen.has(channel)).toBe(false);
        seen.add(channel);
      }
    }
    expect(seen.size).toBe(24);
  });

  it('places the rings at the surveyed elevations', () => {
    const byId = Object.fromEntries(SONIC_LAB_SPEAKERS.map((s) => [s.id, s]));
    expect(byId.SL1.elevation).toBe(0);
    expect(byId.SL9.elevation).toBe(-8);
    expect(byId.SL13.elevation).toBe(13);
    expect(byId.SL17.elevation).toBe(33);
    expect(byId.SL18.elevation).toBe(35);
    expect(byId.SL21.lfe).toBe(true);
  });

  it('preserves the room\u2019s deliberate asymmetry', () => {
    const byId = Object.fromEntries(SONIC_LAB_SPEAKERS.map((s) => [s.id, s]));
    // The physical room is not mirror-symmetric and the table must not "tidy" that away.
    expect(byId.SL1.azimuthAdm).toBe(30);
    expect(byId.SL2.azimuthAdm).toBe(-27);
    expect(byId.SL3.azimuthAdm).toBe(67);
    expect(byId.SL4.azimuthAdm).toBe(-61);
  });

  it('namespaces its speaker labels so they cannot be mistaken for ITU labels', () => {
    for (const sp of SONIC_LAB_SPEAKERS) {
      expect(sp.admSpeakerLabel.startsWith('SIGNALROT_SL_')).toBe(true);
      expect(sp.admSpeakerLabel).not.toMatch(/^[MUB][+-]\d{3}$/);
    }
  });

  it('exports a text channel map documenting both conventions', () => {
    const text = sonicLabChannelMapText({ sampleRate: 48000, engineVersion: '7.0.0' });
    expect(text).toContain('POSITIVE = LEFT');
    expect(text).toContain('POSITIVE = RIGHT');
    for (const sp of SONIC_LAB_SPEAKERS) expect(text).toContain(sp.id);
    expect(text.split('\n').length).toBeGreaterThan(30);
  });

  it('exports a JSON channel map with 24 entries', () => {
    const json = sonicLabChannelMapJson();
    expect(json.channelCount).toBe(24);
    expect(json.channels).toHaveLength(24);
    expect(json.channels[0].channel).toBe(1);
    expect(json.channels[23].channel).toBe(24);
    expect(json.conventions.azimuthAdm).toMatch(/left/);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});

describe('generic channel maps', () => {
  for (const id of LAYOUT_IDS) {
    it(`produces a text and JSON map for ${id}`, () => {
      const text = channelMapText(id, { sampleRate: 48000 });
      const json = channelMapJson(id, { sampleRate: 48000 });
      const { order } = wavChannelOrder(id);
      expect(json.channelCount).toBe(order.length);
      expect(json.channels).toHaveLength(order.length);
      order.forEach((key, index) => {
        expect(json.channels[index].id).toBe(key);
        expect(text).toContain(key);
      });
      expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    });
  }

  it('returns null for an unknown layout', () => {
    expect(channelMapJson('nope')).toBeNull();
    expect(channelMapText('nope')).toBe('');
  });
});
