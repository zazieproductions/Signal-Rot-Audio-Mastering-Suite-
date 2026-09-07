/**
 * Delivery profiles, manifest, packaging and checksums.
 *
 * The delivery layer's job is to make a folder of files self-explanatory to someone who
 * has never used Signal Rot. These tests hold it to that, and — more importantly — hold
 * it to the honesty obligations: a manifest that overstates what was verified is worse
 * than no manifest, so the claims are asserted as hard as the contents.
 */

import { describe, it, expect } from 'vitest';
import { buildChannelIdentification } from '../../src/audio/encode/channel-identification.js';
import { formatChecksumFile, sha256, sha256Hex, toHex } from '../../src/audio/encode/checksum.js';
import {
  MANIFEST_SCHEMA_VERSION,
  buildDeliveryManifest,
  buildDeliveryReadme,
  channelOrderBlock,
  upmixDisclosure,
} from '../../src/audio/encode/delivery-manifest.js';
import { buildDeliveryPackage } from '../../src/audio/encode/delivery-package.js';
import {
  DELIVERY_PROFILES,
  DELIVERY_PROFILE_IDS,
  checkProfileConformance,
  getDeliveryProfile,
  sidecarsFor,
} from '../../src/audio/encode/delivery-profiles.js';
import { SPEAKERS, wavChannelOrder } from '../../src/audio/immersive/layouts.js';
import { validateAdmXml } from '../../tools/export-validation/adm-validate.js';
import { inspectRiff } from '../../tools/export-validation/riff-inspect.js';

const SR = 48000;
const ID = { sampleRate: SR, beepMs: 8, gapMs: 5, pauseMs: 10, toneMs: 25, tailMs: 5 };

describe('SHA-256', () => {
  // Test vectors from FIPS 180-4 / RFC 6234.
  const VECTORS = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
  ];

  it.each(VECTORS)('matches the published digest for %s', (input, expected) => {
    expect(sha256Hex(new TextEncoder().encode(input))).toBe(expected);
  });

  it('matches for a million-character input (multi-block padding)', () => {
    expect(sha256Hex(new TextEncoder().encode('a'.repeat(1000000)))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('agrees with itself across every length around a block boundary', async () => {
    // 55/56 and 63/64 are where the padding logic changes; an off-by-one here is silent.
    for (const n of [54, 55, 56, 57, 62, 63, 64, 65, 119, 120, 127, 128]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 31) & 0xff);
      expect(await sha256(bytes)).toBe(sha256Hex(bytes));
    }
  });

  it('hashes Blobs, ArrayBuffers, typed arrays and strings identically', async () => {
    const text = 'signal rot';
    const bytes = new TextEncoder().encode(text);
    const expected = sha256Hex(bytes);
    expect(await sha256(text)).toBe(expected);
    expect(await sha256(bytes)).toBe(expected);
    expect(await sha256(bytes.buffer)).toBe(expected);
    expect(await sha256(new Blob([bytes]))).toBe(expected);
  });

  it('rejects an input it cannot hash rather than hashing something else', async () => {
    await expect(sha256(42)).rejects.toThrow(/expected a Blob/);
  });

  it('formats a file coreutils can verify', () => {
    const out = formatChecksumFile([
      { filename: 'a.wav', sha256: 'aa' },
      { filename: 'b.wav', sha256: 'bb' },
      { filename: 'skipped.txt' },
    ]);
    // Two spaces is what `sha256sum -c` expects.
    expect(out).toBe('aa  a.wav\nbb  b.wav\n');
  });

  it('renders hex in lower case with leading zeros intact', () => {
    expect(toHex(new Uint8Array([0, 1, 15, 16, 255]))).toBe('00010f10ff');
  });
});

describe('delivery profiles', () => {
  it('exposes every profile the documentation promises', () => {
    expect(DELIVERY_PROFILE_IDS).toEqual([
      'stereo-distribution',
      'film-video',
      'high-res-archive',
      'bed-714',
      'sonic-lab-204',
      'adm-ingest',
    ]);
  });

  it.each(DELIVERY_PROFILE_IDS)('%s is internally coherent', (id) => {
    const p = DELIVERY_PROFILES[id];
    expect([16, 24, 32]).toContain(p.bitDepth);
    expect(p.sampleRates.length).toBeGreaterThan(0);
    expect(['wav', 'adm-bwf']).toContain(p.container);
    if (p.preferredSampleRate !== null) {
      expect(p.sampleRates).toContain(p.preferredSampleRate);
    }
    expect(p.notes.length).toBeGreaterThan(0);
    // Every profile must restate that it does not touch the DSP — a user picking from a
    // menu should never have to wonder whether their master just changed.
    expect(p.notes.join(' ')).toMatch(/does not change any mastering processing/i);
  });

  it('never encodes a processing decision', () => {
    for (const p of Object.values(DELIVERY_PROFILES)) {
      // The profile object must contain no gain, no ceiling *enforcement*, no dither
      // choice — only container/metadata/documentation fields.
      // Whole-word match: `requiredSidecars` innocently contains "eq".
      const keys = Object.keys(p).map((k) => k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
      for (const forbidden of ['gain', 'limiter', 'dither', 'normalize', 'eq', 'compression']) {
        expect(
          keys.some((k) => k.split(/\s+/).includes(forbidden)),
          `profile "${p.id}" has a "${forbidden}" field — profiles must not carry DSP settings`,
        ).toBe(false);
      }
    }
  });

  it('marks the ADM profile as an ingest asset and not an Atmos master', () => {
    const p = DELIVERY_PROFILES['adm-ingest'];
    expect(p.summary).toMatch(/not a certified Atmos master/i);
    expect(p.disclaimers.join(' ')).toMatch(
      /NOT A DOLBY ATMOS MASTER AND IS NOT DOLBY ATMOS CERTIFIED/,
    );
  });

  it('makes the Sonic Lab mask-0 decision explicit and mandatory', () => {
    const p = DELIVERY_PROFILES['sonic-lab-204'];
    expect(p.notes.join(' ')).toMatch(/THE CHANNEL MASK IS 0/);
    expect(p.requiredSidecars).toContain('{base}_channel-map.txt');
    expect(p.requiredSidecars).toContain('{base}_channel-identification.wav');
    expect(p.requiredSidecars).toContain('README-delivery.txt');
  });

  it('discloses synthetic height wherever height channels exist', () => {
    for (const id of ['bed-714', 'sonic-lab-204', 'adm-ingest']) {
      expect(DELIVERY_PROFILES[id].disclaimers.join(' ')).toMatch(/SYNTHESISED/);
    }
  });

  it('returns null for an unknown profile rather than a default', () => {
    expect(getDeliveryProfile('atmos-master')).toBeNull();
  });

  it('expands sidecar templates against a base name', () => {
    expect(sidecarsFor('bed-714', 'song')).toContain('song_channel-map.json');
  });
});

describe('profile conformance', () => {
  it('accepts a matching render', () => {
    const r = checkProfileConformance('film-video', {
      sampleRate: 48000,
      bitDepth: 24,
      layout: 'stereo',
      truePeakDbtp: -2.5,
      integratedLufs: -23,
    });
    expect(r.conforms).toBe(true);
    expect(r.deviations).toEqual([]);
  });

  it('reports a sample rate the profile does not accept', () => {
    const r = checkProfileConformance('film-video', { sampleRate: 44100, bitDepth: 24 });
    expect(r.conforms).toBe(false);
    expect(r.deviations.join(' ')).toMatch(/44100 Hz is not accepted/);
  });

  it('treats an exceeded ceiling as an advisory, not a deviation', () => {
    // The file is still valid; the delivery spec just wanted more headroom. Conflating
    // "invalid" with "not to spec" would make the tool cry wolf.
    const r = checkProfileConformance('stereo-distribution', {
      sampleRate: 48000,
      bitDepth: 24,
      layout: 'stereo',
      truePeakDbtp: -0.2,
    });
    expect(r.conforms).toBe(true);
    expect(r.advisories.join(' ')).toMatch(/exceeds the profile's recommended -1.0 dBTP/);
  });

  it('refuses an unknown profile', () => {
    expect(() => checkProfileConformance('nope', {})).toThrow(/unknown profile/);
  });
});

describe('channel order block', () => {
  it.each(['5.1', '7.1', '7.1.2', '7.1.4', '9.1.6', 'soniclab'])('%s is self-consistent', (id) => {
    const block = channelOrderBlock(id);
    const { order, mask, standard } = wavChannelOrder(id);
    expect(block.channelCount).toBe(order.length);
    expect(block.channels.map((c) => c.id)).toEqual(order);
    expect(block.channels.map((c) => c.channel)).toEqual(order.map((_, i) => i + 1));
    expect(block.channelMask).toBe(standard ? mask : 0);
    expect(block.standardMask).toBe(standard);
    expect(block.lfeChannels).toEqual(
      order.map((k, i) => (SPEAKERS[k].lfe ? i + 1 : 0)).filter(Boolean),
    );
  });

  it('shouts about mask 0 for non-standard layouts', () => {
    for (const id of ['9.1.6', 'soniclab']) {
      expect(channelOrderBlock(id).routingNote).toMatch(/CHANNEL MASK IS 0 BY DESIGN/);
    }
  });

  it('warns that extensible interleave order is not layout order', () => {
    expect(channelOrderBlock('7.1.4').interleaveOrder).toMatch(/NOT layout order/);
  });

  it('handles stereo without a layout definition', () => {
    const block = channelOrderBlock('stereo');
    expect(block.channelCount).toBe(2);
    expect(block.channelMask).toBe(0x3);
  });

  it('refuses an unknown layout', () => {
    expect(() => channelOrderBlock('22.2')).toThrow(/unknown layout/);
  });
});

describe('up-mix disclosure', () => {
  it('says nothing was up-mixed for stereo', () => {
    const d = upmixDisclosure('stereo');
    expect(d.upmixed).toBe(false);
    expect(d.syntheticHeight).toBe(false);
  });

  it('discloses synthesised height for every immersive layout with height channels', () => {
    for (const id of ['7.1.2', '7.1.4', '9.1.6', 'soniclab']) {
      const d = upmixDisclosure(id);
      expect(d.upmixed).toBe(true);
      expect(d.syntheticHeight).toBe(true);
      expect(d.statement).toMatch(/SYNTHESISED/);
      expect(d.statement).toMatch(/not a recovered height layer/);
      expect(d.heightChannels.length).toBeGreaterThan(0);
    }
  });

  it('discloses up-mix even for a layout with no height, such as 5.1', () => {
    const d = upmixDisclosure('5.1');
    expect(d.upmixed).toBe(true);
    expect(d.syntheticHeight).toBe(false);
    expect(d.statement).toMatch(/up-mixed from a two-channel source/);
  });

  it('states that ADM cannot express the disclosure', () => {
    expect(upmixDisclosure('7.1.4').statement).toMatch(/ADM has no up-mix vocabulary/);
  });
});

describe('delivery manifest', () => {
  const base = {
    sourceFilename: 'take-03.wav',
    layoutId: '7.1.4',
    profileId: 'bed-714',
    sampleRate: SR,
    bitDepth: 24,
    channelCount: 12,
    frames: 48000,
    container: 'RIFF',
    renderedAt: new Date(Date.UTC(2024, 5, 1, 12)),
    loudness: { integratedLufs: -18.2, truePeakDbtp: -1.02, loudnessRangeLu: 6.4 },
  };

  it('records everything the brief asks for', () => {
    const m = buildDeliveryManifest(base);
    expect(m.manifestSchemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
    expect(m.generator.engineVersion).toBeTruthy();
    expect(m.generator.renderedAt).toBe('2024-06-01T12:00:00.000Z');
    expect(m.source.filename).toBe('take-03.wav');
    expect(m.channelOrder.layout).toBe('7.1.4');
    expect(m.channelOrder.channelCount).toBe(12);
    expect(m.channelOrder.channels).toHaveLength(12);
    expect(m.audio.sampleRate).toBe(SR);
    expect(m.audio.bitDepth).toBe(24);
    expect(m.audio.durationSeconds).toBe(1);
    expect(m.loudness.integratedLufs).toBe(-18.2);
    expect(m.loudness.truePeakDbtp).toBe(-1.02);
    expect(m.loudness.loudnessRangeLu).toBe(6.4);
    expect(m.upmix.syntheticHeight).toBe(true);
  });

  it('is JSON-serialisable without loss', () => {
    const m = buildDeliveryManifest(base);
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });

  it('never claims schema validation or Atmos certification', () => {
    const m = buildDeliveryManifest({ ...base, validation: { admSchemaValidated: true } });
    // Even when a caller tries to assert it, the manifest reports what the tooling can
    // actually establish. `admSchemaValidated` is honoured only because a caller with a
    // licensed XSD may legitimately set it — but `atmosCertified` is never settable.
    expect(m.validation.atmosCertified).toBe(false);
    expect(m.validation.atmosNote).toMatch(/NOT DOLBY ATMOS CERTIFIED/);
  });

  it('defaults schema validation to false', () => {
    expect(buildDeliveryManifest(base).validation.admSchemaValidated).toBe(false);
  });

  it('defines the validation terminology it uses', () => {
    const t = buildDeliveryManifest(base).validation.terminology;
    expect(t['schema validated']).toMatch(/NOT performed/);
    expect(t['structurally validated']).toMatch(/shares no code with the writer/);
  });

  it('discloses that the loudness meter is not certified', () => {
    const m = buildDeliveryManifest(base);
    expect(m.loudness.measurement.certified).toBe(false);
    expect(m.loudness.measurement.truePeakMethod).toMatch(/not the/);
  });

  it('discloses the height-weighting assumption only for immersive layouts', () => {
    expect(buildDeliveryManifest(base).loudness.measurement.heightWeighting).toMatch(/G = 1.0/);
    expect(
      buildDeliveryManifest({
        ...base,
        layoutId: 'stereo',
        channelCount: 2,
        profileId: 'stereo-distribution',
      }).loudness.measurement.heightWeighting,
    ).toBeNull();
  });

  it('explains a 64-bit container when one is used', () => {
    const m = buildDeliveryManifest({ ...base, container: 'BW64' });
    expect(m.audio.containerNote).toMatch(/ds64/);
    expect(m.audio.containerNote).toMatch(/predate EBU Tech 3306/);
  });

  it('refuses to describe audio it contradicts', () => {
    expect(() => buildDeliveryManifest({ ...base, channelCount: 8 })).toThrow(
      /Refusing to write a manifest that contradicts the audio/,
    );
  });

  it('refuses an unknown profile', () => {
    expect(() => buildDeliveryManifest({ ...base, profileId: 'imax' })).toThrow(
      /unknown delivery profile/,
    );
  });

  it('lists the software limitations so they travel with the file', () => {
    const l = buildDeliveryManifest(base).limitations.join(' ');
    expect(l).toMatch(/not EBU Tech 3341 certified/);
    expect(l).toMatch(/height content is synthesised/);
    expect(l).toMatch(/not schema validated/);
  });
});

describe('delivery README', () => {
  const manifest = buildDeliveryManifest({
    layoutId: 'soniclab',
    profileId: 'sonic-lab-204',
    sampleRate: SR,
    bitDepth: 24,
    channelCount: 24,
    frames: 48000,
    files: [{ filename: 'x_master.wav', role: 'master', description: 'THE MASTER.' }],
  });

  it('names every file it was given', () => {
    expect(buildDeliveryReadme(manifest)).toContain('x_master.wav');
  });

  it('lists all 24 channels with their positions', () => {
    const text = buildDeliveryReadme(manifest);
    const { order } = wavChannelOrder('soniclab');
    order.forEach((id, i) => {
      // Channel number, speaker id, azimuth and elevation must all appear on one line —
      // a receiving engineer patching a 24-channel rig reads this table and nothing else.
      const speaker = SPEAKERS[id];
      const row = new RegExp(
        `^\\s*${i + 1} +${id} +${speaker.azimuthAdm.toFixed(1).replace('.', '\\.')} +` +
          `${speaker.elevation.toFixed(0)} `,
        'm',
      );
      expect(text, `row for channel ${i + 1} (${id})`).toMatch(row);
    });
  });

  it('flags the zero mask in terms nobody can miss', () => {
    expect(buildDeliveryReadme(manifest)).toMatch(/ZERO, BY DESIGN/);
  });

  it('marks the subwoofer channels as un-summable', () => {
    expect(buildDeliveryReadme(manifest)).toMatch(/do not sum with others/);
  });

  it('states plainly that it is not Atmos certified', () => {
    expect(buildDeliveryReadme(manifest)).toMatch(/Dolby Atmos certified: NO/);
    expect(buildDeliveryReadme(manifest)).toMatch(/ADM schema validated : NO/);
  });

  it('gives reproducible verification commands', () => {
    const text = buildDeliveryReadme(manifest);
    expect(text).toMatch(/ffprobe -v error -show_entries/);
    expect(text).toMatch(/sha256sum -c SHA256SUMS\.txt/);
  });

  it('tells the recipient to verify routing before mixing', () => {
    expect(buildDeliveryReadme(manifest)).toMatch(/channel-identification\.wav/);
  });
});

describe('delivery package', () => {
  it('assembles a complete 7.1.4 package', async () => {
    const { order } = wavChannelOrder('7.1.4');
    const master = buildChannelIdentification(order.length, ID);
    const pkg = await buildDeliveryPackage({
      master,
      profileId: 'bed-714',
      baseName: 'song',
      sourceFilename: 'song.wav',
      loudness: { integratedLufs: -18, truePeakDbtp: -1 },
    });

    const names = pkg.files.map((f) => f.filename);
    expect(names).toEqual([
      'song_master.wav',
      'song_channel-identification.wav',
      'song_channel-map.txt',
      'song_channel-map.json',
      'song_delivery-manifest.json',
      'README-delivery.txt',
      'SHA256SUMS.txt',
    ]);
    expect(pkg.folderName).toBe('song_7.1.4_delivery');
  });

  it('produces a master an independent parser accepts', async () => {
    const { order, mask } = wavChannelOrder('7.1.4');
    const pkg = await buildDeliveryPackage({
      master: buildChannelIdentification(order.length, ID),
      profileId: 'bed-714',
      baseName: 'song',
    });
    const wav = pkg.files.find((f) => f.filename === 'song_master.wav');
    const riff = inspectRiff(new Uint8Array(await wav.blob.arrayBuffer()));
    expect(riff.errors).toEqual([]);
    expect(riff.fmt.channels).toBe(12);
    expect(riff.fmt.channelMask).toBe(mask);
    expect(riff.fmt.bitsPerSample).toBe(24);
  });

  it('hashes every file and lists the hashes in a verifiable format', async () => {
    const pkg = await buildDeliveryPackage({
      master: buildChannelIdentification(2, ID),
      profileId: 'stereo-distribution',
      baseName: 'song',
    });
    const sums = await pkg.files.find((f) => f.filename === 'SHA256SUMS.txt').blob.text();
    for (const line of sums.trim().split('\n')) {
      expect(line).toMatch(/^[0-9a-f]{64} {2}\S+$/);
    }
    // Each listed hash must actually be the hash of that file.
    for (const f of pkg.files.filter((x) => x.sha256)) {
      expect(await sha256(f.blob)).toBe(f.sha256);
      expect(sums).toContain(`${f.sha256}  ${f.filename}`);
    }
  });

  it('does not claim a hash for the checksum file itself', async () => {
    const pkg = await buildDeliveryPackage({
      master: buildChannelIdentification(2, ID),
      profileId: 'stereo-distribution',
      baseName: 'song',
    });
    const sums = await pkg.files.find((f) => f.filename === 'SHA256SUMS.txt').blob.text();
    expect(sums).not.toContain('SHA256SUMS.txt');
    // A document cannot contain its own hash; the manifest lists it without one.
    const entry = pkg.manifest.files.find((f) => f.filename === 'SHA256SUMS.txt');
    expect(entry.sha256).toBeNull();
  });

  it('carries the identification signal at the same channel count as the master', async () => {
    const { order } = wavChannelOrder('soniclab');
    const pkg = await buildDeliveryPackage({
      master: buildChannelIdentification(order.length, ID),
      profileId: 'sonic-lab-204',
      baseName: 'venue',
    });
    const id = pkg.files.find((f) => f.filename.includes('channel-identification'));
    const riff = inspectRiff(new Uint8Array(await id.blob.arrayBuffer()));
    expect(riff.errors).toEqual([]);
    expect(riff.fmt.channels).toBe(24);
    // Mask 0 on the identification file too: the layout is still non-standard.
    expect(riff.fmt.channelMask).toBe(0);
  });

  it('includes and validates the ADM XML when one is supplied', async () => {
    const { order } = wavChannelOrder('7.1.4');
    const master = buildChannelIdentification(order.length, ID);
    const { buildAdmXml, writeAdmBwf } = await import('../../src/audio/immersive/adm.js');
    const admXml = buildAdmXml({
      layoutId: '7.1.4',
      sampleRate: SR,
      bitDepth: 24,
      durationSeconds: master.length / SR,
      order,
    });
    const pkg = await buildDeliveryPackage({
      master,
      profileId: 'adm-ingest',
      baseName: 'ingest',
      admXml,
      admBlob: writeAdmBwf(master, { layoutId: '7.1.4', bitDepth: 24, order }),
    });

    expect(pkg.files.map((f) => f.filename)).toContain('ingest_master.adm.wav');
    expect(pkg.files.map((f) => f.filename)).toContain('ingest_adm.xml');
    expect(pkg.manifest.adm.type).toBe('DirectSpeakers');

    const xml = await pkg.files.find((f) => f.filename === 'ingest_adm.xml').blob.text();
    const r = validateAdmXml(xml, { expectedChannels: 12, sampleRate: SR, bitDepth: 24 });
    expect(r.errors).toEqual([]);
  });

  it('refuses to package audio that contradicts the layout', async () => {
    await expect(
      buildDeliveryPackage({
        master: buildChannelIdentification(6, ID),
        profileId: 'bed-714',
      }),
    ).rejects.toThrow(/Refusing to build a package whose documentation contradicts its audio/);
  });

  it('refuses an unknown profile', async () => {
    await expect(
      buildDeliveryPackage({ master: buildChannelIdentification(2, ID), profileId: 'imax' }),
    ).rejects.toThrow(/unknown delivery profile/);
  });

  it('refuses an empty master', async () => {
    await expect(
      buildDeliveryPackage({
        master: { sampleRate: SR, length: 0, channels: [] },
        profileId: 'stereo-distribution',
      }),
    ).rejects.toThrow(/no master audio/);
  });

  it('sanitises a hostile base name into safe filenames', async () => {
    const pkg = await buildDeliveryPackage({
      master: buildChannelIdentification(2, ID),
      profileId: 'stereo-distribution',
      baseName: '../../etc/pa<>ss:wd.wav',
    });
    for (const f of pkg.files) {
      expect(f.filename).not.toMatch(/[/\\<>:]/);
      expect(f.filename.startsWith('.')).toBe(false);
    }
  });

  it('can omit checksums when the caller does not want them', async () => {
    const pkg = await buildDeliveryPackage({
      master: buildChannelIdentification(2, ID),
      profileId: 'stereo-distribution',
      includeChecksums: false,
    });
    expect(pkg.files.map((f) => f.filename)).not.toContain('SHA256SUMS.txt');
    expect(pkg.files.every((f) => f.sha256 === undefined)).toBe(true);
  });

  it('produces a README that names every file in the package', async () => {
    const pkg = await buildDeliveryPackage({
      master: buildChannelIdentification(2, ID),
      profileId: 'stereo-distribution',
      baseName: 'song',
    });
    const readme = await pkg.files.find((f) => f.filename === 'README-delivery.txt').blob.text();
    for (const f of pkg.files) expect(readme).toContain(f.filename);
  });
});
