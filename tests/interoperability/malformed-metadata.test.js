/**
 * Fuzz / hostile-metadata hardening.
 *
 * ── The contract ─────────────────────────────────────────────────────────────────────
 * For every input, no matter how strange, a writer must do exactly one of two things:
 *
 *   · produce a **valid** file — one an independent parser accepts and an independent
 *     validator finds structurally sound; or
 *   · **refuse clearly** — throw with a message that names the problem.
 *
 * What it must never do is produce a file that parses but means something other than
 * what it claims. An ambiguous file is worse than a rejected one, because the rejection
 * is discovered at export time by the person who can fix it, and the ambiguity is
 * discovered in a venue by someone who cannot.
 *
 * Most of the inputs below are not adversarial in origin. `A & B (Live).wav`, an emoji in
 * a project name, and a title pasted from a word processor with a non-breaking space are
 * ordinary things that arrive from real users; they are just also, incidentally, the
 * inputs that break naive XML and fixed-width ASCII writers.
 */

import { describe, it, expect } from 'vitest';
import { buildChannelIdentification } from '../../src/audio/encode/channel-identification.js';
import { baseNameOf, sanitizeFilename } from '../../src/audio/encode/download.js';
import { writeWav } from '../../src/audio/encode/wav.js';
import {
  ADM_MAX_NAME_LENGTH,
  buildAdmXml,
  clampAdmName,
  writeAdmBwf,
  xmlEscape,
} from '../../src/audio/immersive/adm.js';
import { wavChannelOrder } from '../../src/audio/immersive/layouts.js';
import { validateAdmXml } from '../../tools/export-validation/adm-validate.js';
import { inspectRiff } from '../../tools/export-validation/riff-inspect.js';

const SR = 48000;
const ID = { sampleRate: SR, beepMs: 8, gapMs: 5, pauseMs: 10, toneMs: 30, tailMs: 5 };

/** Strings that break naive metadata writers. */
const HOSTILE_NAMES = [
  ['ampersand', 'Smith & Jones'],
  ['xml tags', '<script>alert(1)</script>'],
  ['closing bracket', 'a]]>b'],
  ['double quotes', 'The "Final" Mix'],
  ['single quotes', "O'Brien's Take"],
  ['all five entities', `& < > " '`],
  ['already escaped', '&amp; &lt; &#65;'],
  ['unicode', 'Ünïcödé — ‘smart’ quotes'],
  ['emoji', 'Master 🎛️🔊 v2'],
  ['rtl', 'مرحبا بالعالم'],
  ['cjk', '母带处理 マスタリング'],
  ['combining marks', 'e\u0301\u0301\u0301\u0301'],
  ['zero width', 'a\u200bb\u200cc\ufeffd'],
  ['nul byte', 'before\u0000after'],
  ['control chars', '\u0001\u0002\u0008\u000b\u000c\u001f'],
  ['tab and newline', 'line one\nline two\ttabbed'],
  ['lone high surrogate', 'broken\ud800end'],
  ['lone low surrogate', 'broken\udc00end'],
  ['non-characters', 'x\ufffey\uffffz'],
  ['very long', 'A'.repeat(10000)],
  ['long emoji', '🎛️'.repeat(2000)],
  ['whitespace only', '     '],
  ['empty', ''],
  ['path traversal', '../../etc/passwd'],
  ['null-ish', 'null'],
  ['numeric', '00000'],
  ['xml declaration', '<?xml version="1.0"?>'],
  ['doctype', '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>&e;'],
];

describe('xmlEscape', () => {
  it.each(HOSTILE_NAMES)('produces parseable content for %s', (_label, input) => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><r a="${xmlEscape(input)}">${xmlEscape(
      input,
    )}</r>`;
    // The whole point: whatever went in, the document still parses.
    const result = validateAdmXml(xml);
    expect(result.wellFormed).toBe(true);
  });

  it('escapes all five predefined entities', () => {
    expect(xmlEscape(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &apos;');
  });

  it('escapes the ampersand first, so entities are not double-broken', () => {
    // `&amp;` must become `&amp;amp;`, not `&amp;` — otherwise round-tripping corrupts.
    expect(xmlEscape('&amp;')).toBe('&amp;amp;');
  });

  it('strips characters XML 1.0 cannot represent at all', () => {
    // These cannot be escaped either: `&#0;` is equally forbidden. Removal is the only
    // way to keep the document well-formed.
    expect(xmlEscape('a\u0000b')).toBe('ab');
    expect(xmlEscape('a\u0008b\u001fc')).toBe('abc');
    expect(xmlEscape('a\ufffeb\uffffc')).toBe('abc');
  });

  it('keeps the whitespace XML 1.0 does allow', () => {
    expect(xmlEscape('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('replaces lone surrogates with U+FFFD rather than emitting invalid UTF-8', () => {
    expect(xmlEscape('a\ud800b')).toBe('a\ufffdb');
    expect(xmlEscape('a\udc00b')).toBe('a\ufffdb');
    // A correctly paired astral character is left alone.
    expect(xmlEscape('a🎛️b')).toBe('a🎛️b');
  });

  it('does not let a hostile name inject a sibling element', () => {
    const escaped = xmlEscape('</audioProgramme><audioProgramme audioProgrammeID="APR_9999"');
    expect(escaped).not.toContain('<');
    expect(escaped).not.toContain('>');
  });

  it('coerces non-strings instead of throwing', () => {
    for (const v of [null, undefined, 42, true, {}, []]) {
      expect(() => xmlEscape(v)).not.toThrow();
    }
  });
});

describe('clampAdmName', () => {
  it('leaves ordinary names alone', () => {
    expect(clampAdmName('Track 1')).toBe('Track 1');
  });

  it('truncates over-long names with an ellipsis', () => {
    const out = clampAdmName('A'.repeat(10000));
    expect(out.length).toBe(ADM_MAX_NAME_LENGTH);
    expect(out.endsWith('\u2026')).toBe(true);
  });

  it('never splits an astral character into a lone surrogate', () => {
    const out = clampAdmName('🎛️'.repeat(2000));
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(out)).toBe(false);
    expect(/(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out)).toBe(false);
  });
});

describe('ADM XML with hostile metadata', () => {
  it.each(HOSTILE_NAMES)('stays well-formed and valid with a %s programme name', (_l, name) => {
    const xml = buildAdmXml({
      layoutId: '5.1',
      sampleRate: SR,
      bitDepth: 24,
      durationSeconds: 1,
      programmeName: name,
    });
    const result = validateAdmXml(xml, { expectedChannels: 6, sampleRate: SR, bitDepth: 24 });
    expect(result.wellFormed).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('does not allow a name to smuggle in an extra element', () => {
    const xml = buildAdmXml({
      layoutId: '5.1',
      sampleRate: SR,
      bitDepth: 24,
      durationSeconds: 1,
      programmeName: '"><audioProgramme audioProgrammeID="APR_9999" audioProgrammeName="evil',
    });
    const result = validateAdmXml(xml, { expectedChannels: 6 });
    expect(result.wellFormed).toBe(true);
    expect(result.summary.counts.audioProgramme).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('refuses an unknown layout', () => {
    expect(() =>
      buildAdmXml({ layoutId: 'atmos-9.1.6', sampleRate: SR, bitDepth: 24, durationSeconds: 1 }),
    ).toThrow(/unknown layout/);
  });

  it.each([0, -48000, 48000.5, NaN, Infinity, null])(
    'refuses the invalid sample rate %s',
    (sampleRate) => {
      expect(() =>
        buildAdmXml({ layoutId: '5.1', sampleRate, bitDepth: 24, durationSeconds: 1 }),
      ).toThrow(/invalid sample rate/);
    },
  );

  it.each([-1, NaN, Infinity])('refuses the invalid duration %s', (durationSeconds) => {
    expect(() =>
      buildAdmXml({ layoutId: '5.1', sampleRate: SR, bitDepth: 24, durationSeconds }),
    ).toThrow(/invalid duration/);
  });

  it.each([0, -100, 5000, NaN])('refuses the implausible LFE crossover %s Hz', (lfeCrossoverHz) => {
    expect(() =>
      buildAdmXml({
        layoutId: '5.1',
        sampleRate: SR,
        bitDepth: 24,
        durationSeconds: 1,
        lfeCrossoverHz,
      }),
    ).toThrow(/implausible/);
  });

  it('handles a zero-length programme by falling back to a generated name', () => {
    const xml = buildAdmXml({
      layoutId: '5.1',
      sampleRate: SR,
      bitDepth: 24,
      durationSeconds: 0,
      programmeName: '',
    });
    const result = validateAdmXml(xml, { expectedChannels: 6 });
    expect(result.errors).toEqual([]);
  });
});

describe('ADM BWF with hostile metadata', () => {
  const layoutId = '5.1';
  const { order } = wavChannelOrder(layoutId);
  const data = buildChannelIdentification(order.length, ID);

  it.each(HOSTILE_NAMES)('writes a structurally sound file with a %s name', async (_l, name) => {
    const blob = writeAdmBwf(data, {
      layoutId,
      bitDepth: 24,
      order,
      programmeName: name,
      description: name,
      originator: name,
      date: new Date(Date.UTC(2024, 0, 1)),
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const riff = inspectRiff(bytes);
    expect(riff.errors, `RIFF errors for ${_l}`).toEqual([]);

    // bext is fixed-width ASCII: non-ASCII becomes '?', NULs are dropped, nothing wraps.
    expect(riff.bext.description.length).toBeLessThanOrEqual(256);
    expect(riff.bext.originator.length).toBeLessThanOrEqual(32);
    // eslint-disable-next-line no-control-regex
    const NON_ASCII = /[\u0000-\u001f\u0080-\uffff]/;
    expect(NON_ASCII.test(riff.bext.description)).toBe(false);
    expect(NON_ASCII.test(riff.bext.originator)).toBe(false);

    const adm = validateAdmXml(riff.axml, {
      expectedChannels: order.length,
      expectedTrackUids: riff.chna.entries.map((e) => e.uid),
      sampleRate: SR,
      bitDepth: 24,
    });
    expect(adm.errors, `ADM errors for ${_l}`).toEqual([]);
  });

  it('keeps every chunk word-aligned however long the XML is', async () => {
    // An odd-length axml payload is the classic place to forget the pad byte, and the
    // resulting file has every subsequent chunk offset by one.
    for (const suffix of ['', 'a', 'ab', 'abc', 'abcd']) {
      const blob = writeAdmBwf(data, {
        layoutId,
        bitDepth: 24,
        order,
        programmeName: `pad-test-${suffix}`,
      });
      const riff = inspectRiff(new Uint8Array(await blob.arrayBuffer()));
      expect(riff.errors).toEqual([]);
      for (const c of riff.chunks) {
        expect(c.dataOffset % 2, `chunk ${c.id} starts on an odd offset`).toBe(0);
      }
    }
  });

  it('refuses a channel-count mismatch instead of writing a misleading chna', () => {
    const wrong = buildChannelIdentification(2, ID);
    expect(() => writeAdmBwf(wrong, { layoutId: '5.1' })).toThrow(
      /buffer has 2 channels but layout needs 6/,
    );
  });

  it.each([8, 12, 20, 64, 0, -16, 24.5])('refuses the bit depth %s', (bitDepth) => {
    expect(() => writeAdmBwf(data, { layoutId, bitDepth, order })).toThrow(/unsupported bit depth/);
  });

  it.each([0, 100, 1e9, -48000, 44100.5])('refuses the sample rate %s', (sampleRate) => {
    expect(() => writeAdmBwf({ ...data, sampleRate }, { layoutId, bitDepth: 24, order })).toThrow(
      /not a plausible audio rate/,
    );
  });
});

describe('WAV writer refusals', () => {
  const data = buildChannelIdentification(2, ID);

  it.each([8, 12, 20, 64, 0, -16, 24.5, NaN])('refuses the bit depth %s', (bitDepth) => {
    expect(() => writeWav(data, { bitDepth })).toThrow(/unsupported bit depth/);
  });

  it.each([0, 100, 1e9, -48000, 44100.5, NaN])('refuses the sample rate %s', (sampleRate) => {
    expect(() => writeWav({ ...data, sampleRate }, { bitDepth: 24 })).toThrow(
      /not a plausible audio rate/,
    );
  });

  it('refuses zero channels', () => {
    expect(() => writeWav({ sampleRate: SR, length: 10, channels: [] }, { bitDepth: 24 })).toThrow(
      /cannot be described by a fmt chunk/,
    );
  });

  it('refuses a channel shorter than the declared frame count', () => {
    const short = { sampleRate: SR, length: 100, channels: [new Float32Array(50)] };
    expect(() => writeWav(short, { bitDepth: 24 })).toThrow(/shorter than the declared frame/);
  });

  it('accepts a zero-length file and produces a valid, empty WAV', async () => {
    // Zero frames is legitimate — a user can trim to nothing — and must not produce a
    // header claiming samples that are not there.
    const empty = { sampleRate: SR, length: 0, channels: [new Float32Array(0)] };
    const riff = inspectRiff(new Uint8Array(await writeWav(empty, { bitDepth: 24 }).arrayBuffer()));
    expect(riff.errors).toEqual([]);
    expect(riff.frames).toBe(0);
    expect(riff.chunks.find((c) => c.id === 'data').size).toBe(0);
  });

  it('clamps out-of-range and non-finite samples instead of wrapping them', async () => {
    const wild = {
      sampleRate: SR,
      length: 6,
      channels: [Float32Array.from([2, -2, 1, -1, 1e30, -1e30])],
    };
    const bytes = new Uint8Array(await writeWav(wild, { bitDepth: 16 }).arrayBuffer());
    const riff = inspectRiff(bytes);
    expect(riff.errors).toEqual([]);
    const view = new DataView(bytes.buffer);
    const o = riff.chunks.find((c) => c.id === 'data').dataOffset;
    // Every out-of-range value must land on a rail, never wrap to the opposite sign.
    expect(view.getInt16(o, true)).toBe(32767);
    expect(view.getInt16(o + 2, true)).toBe(-32768);
    expect(view.getInt16(o + 4, true)).toBe(32767);
    expect(view.getInt16(o + 6, true)).toBe(-32768);
    expect(view.getInt16(o + 8, true)).toBe(32767);
    expect(view.getInt16(o + 10, true)).toBe(-32768);
  });

  it('writes odd-length data with a pad byte that keeps the file even', async () => {
    // 3 frames × 1 channel × 3 bytes = 9: odd, so a pad byte is required and must not be
    // counted in the chunk size.
    const odd = { sampleRate: SR, length: 3, channels: [Float32Array.from([0.1, 0.2, 0.3])] };
    const bytes = new Uint8Array(await writeWav(odd, { bitDepth: 24 }).arrayBuffer());
    const riff = inspectRiff(bytes);
    expect(riff.errors).toEqual([]);
    expect(riff.chunks.find((c) => c.id === 'data').size).toBe(9);
    expect(bytes.length % 2).toBe(0);
    expect(riff.declaredSize).toBe(bytes.length - 8);
  });
});

describe('filename hygiene under hostile input', () => {
  it.each(HOSTILE_NAMES)('produces a usable filename from a %s name', (_l, name) => {
    const out = sanitizeFilename(`${name}.wav`);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out).not.toMatch(/[/\\]/);
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\u0000-\u001f<>:"|?*]/);
    expect(out.startsWith('.')).toBe(false);
  });

  it('never returns an empty base name', () => {
    for (const n of ['', '   ', '...', '///', '\u0000', 'CON.wav', 'nul']) {
      expect(baseNameOf(n).length).toBeGreaterThan(0);
    }
  });
});

describe('the independent parser diagnoses corruption rather than crashing', () => {
  const goodBytes = async () =>
    new Uint8Array(
      await writeWav(buildChannelIdentification(2, ID), { bitDepth: 24 }).arrayBuffer(),
    );

  it('reports a truncated file', async () => {
    const bytes = (await goodBytes()).slice(0, 5000);
    const riff = inspectRiff(bytes);
    expect(riff.valid).toBe(false);
    expect(riff.errors.join(' ')).toMatch(/truncated|size field/);
  });

  it('reports a wrong RIFF size field', async () => {
    const bytes = await goodBytes();
    new DataView(bytes.buffer).setUint32(4, 999999, true);
    expect(inspectRiff(bytes).errors.join(' ')).toMatch(/RIFF size field/);
  });

  it('reports a blockAlign that contradicts the channel count', async () => {
    const bytes = await goodBytes();
    const riff = inspectRiff(bytes);
    const fmtOffset = riff.chunks.find((c) => c.id === 'fmt ').dataOffset;
    new DataView(bytes.buffer).setUint16(fmtOffset + 12, 99, true);
    expect(inspectRiff(bytes).errors.join(' ')).toMatch(/blockAlign is 99/);
  });

  it('reports a byteRate that contradicts the sample rate', async () => {
    const bytes = await goodBytes();
    const fmtOffset = inspectRiff(bytes).chunks.find((c) => c.id === 'fmt ').dataOffset;
    new DataView(bytes.buffer).setUint32(fmtOffset + 8, 1234, true);
    expect(inspectRiff(bytes).errors.join(' ')).toMatch(/byteRate is 1234/);
  });

  it('reports an empty file instead of throwing', () => {
    expect(() => inspectRiff(new Uint8Array(0))).not.toThrow();
    expect(inspectRiff(new Uint8Array(0)).errors[0]).toMatch(/shorter than a 12-byte/);
  });

  it('reports garbage instead of throwing', () => {
    const junk = new Uint8Array(200);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 7 + 13) & 0xff;
    expect(() => inspectRiff(junk)).not.toThrow();
    expect(inspectRiff(junk).valid).toBe(false);
  });

  it('reports an RF64 file with no ds64 chunk', async () => {
    const bytes = await goodBytes();
    // Rewrite the FourCC only: now the file claims RF64 but has no ds64.
    for (const [i, ch] of [...'RF64'].entries()) bytes[i] = ch.charCodeAt(0);
    expect(inspectRiff(bytes).errors.join(' ')).toMatch(/no ds64 chunk/);
  });
});

describe('malformed ADM XML is diagnosed, not accepted', () => {
  const base = () =>
    buildAdmXml({ layoutId: '5.1', sampleRate: SR, bitDepth: 24, durationSeconds: 1 });

  it('rejects a document that is not well-formed', () => {
    const r = validateAdmXml(base().replace('</audioProgramme>', ''));
    expect(r.wellFormed).toBe(false);
    expect(r.errors[0]).toMatch(/not well-formed/);
  });

  it('rejects mismatched tags', () => {
    expect(validateAdmXml('<a><b></a></b>').wellFormed).toBe(false);
  });

  it('rejects a duplicate attribute', () => {
    expect(validateAdmXml('<a x="1" x="2"/>').wellFormed).toBe(false);
  });

  it('rejects an unquoted attribute value', () => {
    expect(validateAdmXml('<a x=1/>').wellFormed).toBe(false);
  });

  it('rejects a dangling ID reference', () => {
    const r = validateAdmXml(
      base().replace(
        'AC_00011001</audioChannelFormatIDRef>',
        'AC_DEADBEEF</audioChannelFormatIDRef>',
      ),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/not defined in this document/);
  });

  it('rejects a duplicate identifier', () => {
    const r = validateAdmXml(base().replaceAll('AC_00011002"', 'AC_00011001"'));
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/Duplicate identifier/);
  });

  it('rejects an ID that does not match the BS.2076 grammar', () => {
    const r = validateAdmXml(
      base().replace('audioProgrammeID="APR_1001"', 'audioProgrammeID="PROG1"'),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/does not match the BS.2076 pattern/);
  });

  it('rejects a typeLabel that disagrees with its typeDefinition', () => {
    const r = validateAdmXml(base().replaceAll('typeLabel="0001"', 'typeLabel="0003"'));
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/typeLabel="0003" \(Objects\) but typeDefinition/);
  });

  it('rejects an azimuth outside the legal range', () => {
    const r = validateAdmXml(
      base().replace('coordinate="azimuth">30.0<', 'coordinate="azimuth">330.0<'),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/outside \(−180, 180]/);
  });

  it('catches a mirror-imaged delivery: a speakerLabel disagreeing with its azimuth', () => {
    // This is the failure that ruins a surround master, and it is invisible on a stereo
    // check. Flipping one azimuth sign must be caught.
    const r = validateAdmXml(
      base().replace('coordinate="azimuth">30.0<', 'coordinate="azimuth">-30.0<'),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/mirror-images the delivery/);
  });

  it('catches a height channel declared at ear level', () => {
    const xml = buildAdmXml({
      layoutId: '7.1.4',
      sampleRate: SR,
      bitDepth: 24,
      durationSeconds: 1,
    }).replace('coordinate="elevation">45.0<', 'coordinate="elevation">0.0<');
    const r = validateAdmXml(xml);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/upper-layer label but elevation is 0/);
  });

  it('catches a channel count that contradicts the container', () => {
    const r = validateAdmXml(base(), { expectedChannels: 8 });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/6 audioChannelFormats but the WAV has 8 channels/);
  });

  it('catches a chna/axml UID disagreement', () => {
    const r = validateAdmXml(base(), { expectedTrackUids: ['ATU_00000099'] });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/chna declares audioTrackUID "ATU_00000099"/);
  });

  it('catches a sample rate in the XML that contradicts the fmt chunk', () => {
    const r = validateAdmXml(base(), { sampleRate: 96000 });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/declares 48000 Hz but the WAV fmt chunk says 96000/);
  });

  it('rejects a document with no audioFormatExtended at all', () => {
    const r = validateAdmXml(
      '<?xml version="1.0"?><ebuCoreMain xmlns="urn:ebu:metadata-schema:ebuCore_2016"><coreMetadata/></ebuCoreMain>',
    );
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/not an ADM document/);
  });

  it('never claims schema validation', () => {
    const r = validateAdmXml(base());
    expect(r.summary.schemaValidated).toBe(false);
    expect(r.summary.schemaValidationNote).toMatch(/Structural validation only/);
  });
});
