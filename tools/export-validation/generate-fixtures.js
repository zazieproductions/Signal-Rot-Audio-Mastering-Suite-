#!/usr/bin/env node
/**
 * Generate deterministic export fixtures.
 *
 * Every fixture is produced by the *production* writers — `writeWav` and `writeAdmBwf`,
 * imported from `src/` — so the files under validation are the files a user would get.
 * The content is the channel-identification signal, which means each fixture carries, in
 * its audio, a statement of what order its channels are in; the validator then recovers
 * that order from the decoded PCM and checks it against the layout. Nothing in that loop
 * asks the writer to confirm its own work.
 *
 * Determinism: pure arithmetic content, and a pinned `bext` origination timestamp, so a
 * fixture's SHA-256 is stable and a change to it is a real change.
 *
 *   node tools/export-validation/generate-fixtures.js [--out <dir>] [--seconds <n>]
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildChannelIdentification } from '../../src/audio/encode/channel-identification.js';
import { sha256 } from '../../src/audio/encode/checksum.js';
import { writeWav } from '../../src/audio/encode/wav.js';
import { buildAdmXml, writeAdmBwf } from '../../src/audio/immersive/adm.js';
import { LAYOUTS, wavChannelOrder } from '../../src/audio/immersive/layouts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FIXTURE_DIR = path.resolve(here, '../../.fixtures/export');

/** A fixed instant, so `bext` and the ADM timecodes never make a fixture non-reproducible. */
export const FIXTURE_DATE = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));

/** The layouts the golden multichannel fixtures cover, plus stereo and mono. */
export const FIXTURE_LAYOUTS = Object.freeze(['5.1', '7.1', '7.1.2', '7.1.4', '9.1.6', 'soniclab']);

/** Bit depths every fixture layout is rendered at, for the round-trip matrix. */
export const FIXTURE_BIT_DEPTHS = Object.freeze([16, 24, 32]);

/**
 * Build the in-memory fixture set. Used by the CLI and directly by the test suite, so the
 * tests and the CI artefacts are the same bytes.
 *
 * @param {{sampleRate?: number, seconds?: number}} [opts]
 * @returns {Array<{name: string, kind: string, layout: string|null, bitDepth: number, channelCount: number, sampleRate: number, frames: number, blob: Blob, expectedOrder: string[], expectedMask: number, standardMask: boolean, admXml?: string}>}
 */
export function buildFixtures(opts = {}) {
  const sampleRate = opts.sampleRate ?? 48000;
  // A short identification signal keeps CI fast and the fixture directory small. The
  // total duration grows with the *square* of the channel count (channel N carries N
  // beeps), so at broadcast-length beeps the 24-channel fixture alone would be 124 MB. These
  // slots are the shortest that still let the Goertzel estimator separate adjacent
  // semitones cleanly: a 60 ms tone at 220 Hz spans ~13 cycles, and the semitone spacing
  // at the bottom of the ladder is 13 Hz against a ~17 Hz analysis bandwidth. The
  // round-trip tests assert the resulting confidence margin, so if this is shortened too
  // far the tests say so rather than quietly becoming meaningless.
  const idOpts = { sampleRate, beepMs: 12, gapMs: 8, pauseMs: 20, toneMs: 60, tailMs: 10 };
  const out = [];

  // ── Plain stereo and mono, one per bit depth ──
  for (const bitDepth of FIXTURE_BIT_DEPTHS) {
    for (const ch of [1, 2]) {
      const data = buildChannelIdentification(ch, idOpts);
      out.push({
        name: `${ch === 1 ? 'mono' : 'stereo'}_${bitDepth}bit.wav`,
        kind: 'wav',
        layout: null,
        bitDepth,
        channelCount: ch,
        sampleRate,
        frames: data.length,
        data,
        blob: writeWav(data, { bitDepth }),
        expectedOrder: ch === 1 ? ['M'] : ['L', 'R'],
        expectedMask: 0,
        standardMask: false,
      });
    }
  }

  // A stereo file forced into WAVE_FORMAT_EXTENSIBLE, because that path is otherwise only
  // exercised by multichannel and it has its own 40-byte fmt chunk to get wrong.
  {
    const data = buildChannelIdentification(2, idOpts);
    out.push({
      name: 'stereo_24bit_extensible.wav',
      kind: 'wav',
      layout: null,
      bitDepth: 24,
      channelCount: 2,
      sampleRate,
      frames: data.length,
      data,
      blob: writeWav(data, { bitDepth: 24, channelMask: 0x3, forceExtensible: true }),
      expectedOrder: ['L', 'R'],
      expectedMask: 0x3,
      standardMask: true,
    });
  }

  // An odd-length data chunk, to exercise word-alignment padding.
  {
    const base = buildChannelIdentification(1, idOpts);
    const frames = base.length - (base.length % 2 === 0 ? 1 : 0);
    const data = {
      sampleRate,
      length: frames,
      channels: [base.channels[0].subarray(0, frames)],
    };
    out.push({
      name: 'mono_24bit_odd-length.wav',
      kind: 'wav',
      layout: null,
      bitDepth: 24,
      channelCount: 1,
      sampleRate,
      frames,
      data,
      blob: writeWav(data, { bitDepth: 24 }),
      expectedOrder: ['M'],
      expectedMask: 0,
      standardMask: false,
      note: 'Odd data-chunk length — exercises the RIFF word-alignment pad byte.',
    });
  }

  // ── Golden multichannel ──
  for (const layoutId of FIXTURE_LAYOUTS) {
    const { order, mask, standard } = wavChannelOrder(layoutId);
    const data = buildChannelIdentification(order.length, idOpts);
    const safe = layoutId.replace(/[^\w]/g, '');

    // Every layout gets 16- and 24-bit. 32-bit float doubles the size of the largest
    // fixtures for little extra coverage — the float write path is channel-count
    // agnostic — so it is generated only up to 12 channels, which still spans mono,
    // stereo, 5.1, 7.1, 7.1.2 and 7.1.4.
    const depths = FIXTURE_BIT_DEPTHS.filter((b) => b !== 32 || order.length <= 12);
    for (const bitDepth of depths) {
      out.push({
        name: `${safe}_${bitDepth}bit.wav`,
        kind: 'wav',
        layout: layoutId,
        bitDepth,
        channelCount: order.length,
        sampleRate,
        frames: data.length,
        data,
        blob: writeWav(data, { bitDepth, channelMask: mask, forceExtensible: true }),
        expectedOrder: order,
        expectedMask: standard ? mask : 0,
        standardMask: standard,
      });
    }

    const admXml = buildAdmXml({
      layoutId,
      sampleRate,
      bitDepth: 24,
      durationSeconds: data.length / sampleRate,
      order,
    });
    out.push({
      name: `${safe}_24bit.adm.wav`,
      kind: 'adm',
      layout: layoutId,
      bitDepth: 24,
      channelCount: order.length,
      sampleRate,
      frames: data.length,
      data,
      blob: writeAdmBwf(data, {
        layoutId,
        bitDepth: 24,
        order,
        date: FIXTURE_DATE,
        loudness: { integrated: -23.0, range: 7.5, truePeak: -1.0 },
      }),
      admXml,
      expectedOrder: order,
      // ADM files deliberately carry mask 0: chna/axml define the routing and a competing
      // mask would be a second source of truth.
      expectedMask: 0,
      standardMask: false,
    });
  }

  return out;
}

/** Write the fixture set to disk and return an index. */
export async function writeFixtures(dir = DEFAULT_FIXTURE_DIR, opts = {}) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const fixtures = buildFixtures(opts);
  const index = [];
  for (const f of fixtures) {
    const bytes = new Uint8Array(await f.blob.arrayBuffer());
    const file = path.join(dir, f.name);
    await writeFile(file, bytes);
    index.push({
      name: f.name,
      kind: f.kind,
      layout: f.layout,
      bitDepth: f.bitDepth,
      channelCount: f.channelCount,
      sampleRate: f.sampleRate,
      frames: f.frames,
      bytes: bytes.length,
      container: f.blob.riffContainer ?? 'RIFF',
      expectedOrder: f.expectedOrder,
      expectedMask: f.expectedMask,
      standardMask: f.standardMask,
      note: f.note ?? null,
      sha256: await sha256(bytes),
    });
    if (f.admXml) {
      const xmlName = f.name.replace(/\.adm\.wav$/, '.adm.xml');
      await writeFile(path.join(dir, xmlName), f.admXml, 'utf8');
    }
  }

  const manifest = {
    generatedBy: 'tools/export-validation/generate-fixtures.js',
    note:
      'Deterministic export fixtures produced by the production writers. Content is the ' +
      'channel-identification signal: channel N emits N beeps then a tone at ' +
      '220 × 2^((N−1)/12) Hz, so the channel order can be recovered from the audio alone.',
    layouts: FIXTURE_LAYOUTS.map((id) => ({
      id,
      name: LAYOUTS[id].name,
      channels: LAYOUTS[id].channels,
      standardMask: LAYOUTS[id].standardMask,
    })),
    fixtures: index,
  };
  await writeFile(path.join(dir, 'fixtures.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const dirArg = args.indexOf('--out');
  const dir = dirArg >= 0 ? path.resolve(args[dirArg + 1]) : DEFAULT_FIXTURE_DIR;
  const manifest = await writeFixtures(dir);
  process.stdout.write(
    `Wrote ${manifest.fixtures.length} fixtures to ${dir}\n` +
      manifest.fixtures
        .map(
          (f) =>
            `  ${f.name.padEnd(34)} ${String(f.channelCount).padStart(2)} ch  ${f.container}  ${f.bytes} B`,
        )
        .join('\n') +
      '\n',
  );
}
