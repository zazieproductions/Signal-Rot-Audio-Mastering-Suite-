import { describe, it, expect } from 'vitest';
import {
  buildAdmXml,
  writeAdmBwf,
  admIdsFor,
  admDuration,
  xmlEscape,
  BEXT_SIZE,
  ADM_PACK_FORMAT_ID,
} from '../../src/audio/immersive/adm.js';
import { LAYOUTS, wavChannelOrder, SPEAKERS } from '../../src/audio/immersive/layouts.js';
import { toView, parseChunks, parseFmt, parseChna, readAxml } from '../helpers/riff.js';
import { make } from '../helpers/signals.js';

const SR = 48000;
const LAYOUT_IDS = Object.keys(LAYOUTS);

const buildFor = (layoutId, frames = 480) => {
  const { order } = wavChannelOrder(layoutId);
  return { order, data: make(order.length, frames, SR, (i, c) => (c + 1) * 0.001) };
};

describe('ADM identifiers', () => {
  it('uses the custom ID range (≥ 0x1000), not the ITU common definitions', () => {
    const ids = admIdsFor(1);
    // The `0001` type digits are DirectSpeakers (BS.2076 Table 8). Releases before the
    // export-interoperability work wrote `0003`, which is the *Objects* type label, while
    // simultaneously declaring `typeDefinition="DirectSpeakers"`. BS.2076 §5.2 requires
    // the digits embedded in an identifier to match the element's typeLabel, so the old
    // documents were internally contradictory. The independent validator in
    // `tools/export-validation/adm-validate.js` is what caught it.
    expect(ids.channelFormat).toBe('AC_00011001');
    expect(ids.streamFormat).toBe('AS_00011001');
    expect(ids.trackFormat).toBe('AT_00011001_01');
    expect(ids.trackUid).toBe('ATU_00000001');
    expect(ids.blockFormat).toBe('AB_00011001_00000001');
  });

  it('produces the exact field widths the chna chunk requires', () => {
    for (let i = 1; i <= 24; i++) {
      const ids = admIdsFor(i);
      expect(ids.trackUid).toHaveLength(12);
      expect(ids.trackFormat).toHaveLength(14);
      expect(ADM_PACK_FORMAT_ID).toHaveLength(11);
    }
  });

  it('produces unique identifiers for every channel', () => {
    const seen = new Set();
    for (let i = 1; i <= 24; i++) {
      const ids = admIdsFor(i);
      for (const value of Object.values(ids)) {
        expect(seen.has(value)).toBe(false);
        seen.add(value);
      }
    }
  });
});

describe('admDuration', () => {
  it('formats hh:mm:ss.nnnnnnnnn', () => {
    expect(admDuration(0)).toBe('00:00:00.000000000');
    expect(admDuration(12.345)).toBe('00:00:12.345000000');
    expect(admDuration(3661.5)).toBe('01:01:01.500000000');
  });
});

describe('xmlEscape', () => {
  it('escapes every character that can break a document', () => {
    expect(xmlEscape('a & b < c > d " e \' f')).toBe('a &amp; b &lt; c &gt; d &quot; e &apos; f');
  });
});

describe('ADM XML', () => {
  for (const layoutId of LAYOUT_IDS) {
    describe(layoutId, () => {
      const { order } = wavChannelOrder(layoutId);
      const xml = buildAdmXml({
        layoutId,
        sampleRate: SR,
        bitDepth: 24,
        durationSeconds: 10,
      });

      it('is well-formed XML with balanced tags', () => {
        expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
        const opens = xml.match(/<([a-zA-Z][\w]*)(?=[\s>])/g) ?? [];
        const closes = xml.match(/<\/([a-zA-Z][\w]*)>/g) ?? [];
        const selfClosing = xml.match(/\/>/g) ?? [];
        // Every non-self-closing open tag has a matching close tag.
        expect(opens.length - selfClosing.length).toBe(closes.length);
        // No stray unescaped ampersands.
        expect(/&(?!(amp|lt|gt|quot|apos);)/.test(xml)).toBe(false);
      });

      it('declares one channel/stream/track/UID set per channel', () => {
        const count = (pattern) => (xml.match(pattern) ?? []).length;
        expect(count(/<audioChannelFormat /g)).toBe(order.length);
        expect(count(/<audioStreamFormat /g)).toBe(order.length);
        expect(count(/<audioTrackFormat /g)).toBe(order.length);
        expect(count(/<audioTrackUID /g)).toBe(order.length);
        expect(count(/<audioBlockFormat /g)).toBe(order.length);
      });

      it('cross-references every ID it declares', () => {
        const declared = new Set();
        for (const match of xml.matchAll(/audio(?:Channel|Stream|Track|Pack)FormatID="([^"]+)"/g)) {
          declared.add(match[1]);
        }
        for (const match of xml.matchAll(/audioTrackUID UID="([^"]+)"/g)) declared.add(match[1]);
        for (const match of xml.matchAll(
          /<audio(?:Channel|Stream|Track|Pack)FormatIDRef>([^<]+)</g,
        )) {
          expect(declared.has(match[1])).toBe(true);
        }
        for (const match of xml.matchAll(/<audioTrackUIDRef>([^<]+)</g)) {
          expect(declared.has(match[1])).toBe(true);
        }
      });

      it('writes the ADM azimuth convention (positive = left)', () => {
        order.forEach((key, index) => {
          const sp = SPEAKERS[key];
          const ids = admIdsFor(index + 1);
          const block = xml.slice(xml.indexOf(ids.blockFormat));
          const azimuth = block.match(/coordinate="azimuth">(-?[\d.]+)</);
          expect(Number(azimuth[1])).toBeCloseTo(sp.azimuthAdm, 1);
          const elevation = block.match(/coordinate="elevation">(-?[\d.]+)</);
          expect(Number(elevation[1])).toBeCloseTo(sp.elevation, 1);
        });
      });

      it('marks LFE channels with a lowPass frequency element', () => {
        const lfeCount = order.filter((k) => SPEAKERS[k].lfe).length;
        const declared = (xml.match(/typeDefinition="lowPass"/g) ?? []).length;
        expect(declared).toBe(lfeCount);
      });

      it('declares DirectSpeakers, not objects — this is a channel bed', () => {
        expect(xml).toContain('typeDefinition="DirectSpeakers"');
        expect(xml).not.toContain('typeDefinition="Objects"');
      });
    });
  }
});

describe('ADM BWF container', () => {
  for (const layoutId of LAYOUT_IDS) {
    it(`writes a structurally valid file for ${layoutId}`, async () => {
      const { order, data } = buildFor(layoutId);
      const view = await toView(writeAdmBwf(data, { layoutId, bitDepth: 24, order }));
      const { container, form, chunks, declaredSize, totalBytes } = parseChunks(view);

      expect(container).toBe('RIFF');
      expect(form).toBe('WAVE');
      expect(declaredSize).toBe(totalBytes - 8);

      const ids = chunks.map((c) => c.id);
      expect(ids).toContain('bext');
      expect(ids).toContain('fmt ');
      expect(ids).toContain('chna');
      expect(ids).toContain('data');
      expect(ids).toContain('axml');

      // chna must come before data so a streaming parser sees the routing first.
      expect(ids.indexOf('chna')).toBeLessThan(ids.indexOf('data'));

      const bext = chunks.find((c) => c.id === 'bext');
      expect(bext.size).toBe(BEXT_SIZE);
      // bext Version field lives at offset 346 and must be 2 for the loudness fields.
      expect(view.getUint16(bext.dataOffset + 346, true)).toBe(2);

      const fmt = parseFmt(
        view,
        chunks.find((c) => c.id === 'fmt '),
      );
      expect(fmt.audioFormat).toBe(0xfffe);
      expect(fmt.channels).toBe(order.length);
      expect(fmt.sampleRate).toBe(SR);
      expect(fmt.bitsPerSample).toBe(24);
      expect(fmt.blockAlign).toBe(order.length * 3);

      const dataChunk = chunks.find((c) => c.id === 'data');
      expect(dataChunk.size).toBe(data.length * order.length * 3);
    });

    it(`writes a chna chunk with one 40-byte entry per channel for ${layoutId}`, async () => {
      const { order, data } = buildFor(layoutId, 96);
      const view = await toView(writeAdmBwf(data, { layoutId, bitDepth: 24, order }));
      const { chunks } = parseChunks(view);
      const chnaChunk = chunks.find((c) => c.id === 'chna');
      expect(chnaChunk.size).toBe(4 + 40 * order.length);

      const chna = parseChna(view, chnaChunk);
      expect(chna.numTracks).toBe(order.length);
      expect(chna.numUIDs).toBe(order.length);
      expect(chna.entries).toHaveLength(order.length);

      const uids = new Set();
      chna.entries.forEach((entry, index) => {
        expect(entry.trackIndex).toBe(index + 1);
        expect(entry.uid).toBe(admIdsFor(index + 1).trackUid);
        expect(entry.trackFormatIdRef).toBe(admIdsFor(index + 1).trackFormat);
        expect(entry.packFormatIdRef).toBe(ADM_PACK_FORMAT_ID);
        expect(uids.has(entry.uid)).toBe(false);
        uids.add(entry.uid);
      });
    });

    it(`embeds an axml payload that references every chna UID for ${layoutId}`, async () => {
      const { order, data } = buildFor(layoutId, 96);
      const view = await toView(writeAdmBwf(data, { layoutId, bitDepth: 24, order }));
      const { chunks } = parseChunks(view);
      const xml = readAxml(
        view,
        chunks.find((c) => c.id === 'axml'),
      );
      const chna = parseChna(
        view,
        chunks.find((c) => c.id === 'chna'),
      );
      for (const entry of chna.entries) {
        expect(xml).toContain(`UID="${entry.uid}"`);
        expect(xml).toContain(`<audioTrackUIDRef>${entry.uid}</audioTrackUIDRef>`);
      }
    });
  }

  it('pads an odd-length axml chunk without inflating its declared size', async () => {
    const { order, data } = buildFor('5.1', 97);
    const view = await toView(writeAdmBwf(data, { layoutId: '5.1', bitDepth: 24, order }));
    const { chunks, totalBytes, declaredSize } = parseChunks(view);
    const axml = chunks.find((c) => c.id === 'axml');
    const xml = readAxml(view, axml);
    expect(axml.size).toBe(new TextEncoder().encode(xml).length);
    expect(totalBytes % 2).toBe(0);
    expect(declaredSize).toBe(totalBytes - 8);
  });

  it('populates the bext loudness fields from real analysis values', async () => {
    const { order, data } = buildFor('5.1', 96);
    const view = await toView(
      writeAdmBwf(data, {
        layoutId: '5.1',
        bitDepth: 24,
        order,
        loudness: {
          integrated: -23.5,
          range: 7.25,
          truePeak: -1.5,
          maxMomentary: -18,
          maxShortTerm: -20,
        },
      }),
    );
    const { chunks } = parseChunks(view);
    const o = chunks.find((c) => c.id === 'bext').dataOffset + 412;
    expect(view.getInt16(o, true)).toBe(-2350); // 0.01 LU units
    expect(view.getInt16(o + 2, true)).toBe(725);
    expect(view.getInt16(o + 4, true)).toBe(-150);
    expect(view.getInt16(o + 6, true)).toBe(-1800);
    expect(view.getInt16(o + 8, true)).toBe(-2000);
  });

  it('rejects a channel-count mismatch rather than writing a corrupt file', () => {
    const data = make(2, 100, SR);
    expect(() => writeAdmBwf(data, { layoutId: '5.1' })).toThrow(/channels but layout needs/);
  });

  it('rejects an unknown layout', () => {
    expect(() => writeAdmBwf(make(2, 10, SR), { layoutId: 'quad' })).toThrow(/unknown layout/);
  });

  it('escapes a hostile programme name instead of breaking the XML', () => {
    const xml = buildAdmXml({
      layoutId: '5.1',
      sampleRate: SR,
      bitDepth: 24,
      durationSeconds: 1,
      programmeName: '</audioProgramme><evil a="1">',
    });
    expect(xml).not.toContain('<evil');
    expect(xml).toContain('&lt;/audioProgramme&gt;');
  });
});
