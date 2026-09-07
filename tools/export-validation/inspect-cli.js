#!/usr/bin/env node
/**
 * Inspect any WAV / BWF / RF64 / BW64 file with the independent parser.
 *
 *   npm run inspect:export -- path/to/master.wav
 *   npm run inspect:export -- path/to/master.adm.wav --json
 *   npm run inspect:export -- path/to/master.adm.wav --xml > extracted.xml
 *
 * This is the tool to reach for when a delivery is questioned. It reads the file with a
 * parser that shares no code with Signal Rot's writers, so its verdict is independent of
 * whatever produced the file — including files Signal Rot did not produce.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { sha256 } from '../../src/audio/encode/checksum.js';
import { validateAdmXml } from './adm-validate.js';
import { probeFile } from './ffprobe.js';
import { inspectRiff } from './riff-inspect.js';

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
const asJson = args.includes('--json');
const dumpXml = args.includes('--xml');

if (files.length === 0) {
  process.stderr.write(
    'usage: inspect-cli.js <file.wav> [more files…] [--json] [--xml]\n' +
      '  --json  emit a machine-readable report\n' +
      '  --xml   print the extracted ADM XML to stdout and nothing else\n',
  );
  process.exit(2);
}

const reports = [];
for (const file of files) {
  const resolved = path.resolve(file);
  const bytes = new Uint8Array(await readFile(resolved));
  const riff = inspectRiff(bytes);

  if (dumpXml) {
    if (riff.axml) process.stdout.write(riff.axml);
    else process.stderr.write(`${file}: no axml chunk\n`);
    continue;
  }

  const adm = riff.axml
    ? validateAdmXml(riff.axml, {
        expectedChannels: riff.fmt?.channels,
        expectedTrackUids: riff.chna?.entries.map((e) => e.uid),
        sampleRate: riff.fmt?.sampleRate,
        bitDepth: riff.fmt?.bitsPerSample,
      })
    : null;
  const probe = await probeFile(resolved);

  reports.push({
    file,
    bytes: bytes.length,
    sha256: await sha256(bytes),
    riff: { ...riff, axml: riff.axml ? `${riff.axml.length} bytes` : null },
    adm: adm && {
      valid: adm.valid,
      errors: adm.errors,
      warnings: adm.warnings,
      summary: adm.summary,
    },
    ffprobe: probe.available ? probe.summary : { skipped: true, reason: probe.reason },
    valid: riff.valid && (!adm || adm.valid) && (!probe.available || probe.errors.length === 0),
  });

  if (asJson) continue;

  const f = riff.fmt;
  const out = [];
  out.push('');
  out.push(`${file}`);
  out.push('─'.repeat(Math.min(78, Math.max(20, file.length))));
  out.push(`container     ${riff.container} / ${riff.form}`);
  out.push(`size          ${bytes.length} bytes`);
  out.push(`sha256        ${reports[reports.length - 1].sha256}`);
  if (riff.ds64) {
    out.push(
      `ds64          riffSize=${riff.ds64.riffSize} dataSize=${riff.ds64.dataSize} ` +
        `sampleCount=${riff.ds64.sampleCount} tableLength=${riff.ds64.tableLength}`,
    );
  }
  out.push(`chunks        ${riff.chunks.map((c) => `${c.id}(${c.size})`).join(' ')}`);
  if (f) {
    out.push(
      `format        ${f.channels} ch · ${f.sampleRate} Hz · ${f.bitsPerSample}-bit ` +
        `${f.isFloat ? 'float' : 'PCM'} · blockAlign ${f.blockAlign} · byteRate ${f.byteRate}`,
    );
    out.push(
      `formatTag     0x${f.formatTag.toString(16).toUpperCase()}` +
        (f.channelMask !== undefined
          ? ` · mask 0x${f.channelMask.toString(16).toUpperCase()}` +
            (f.channelMask
              ? ` (${f.channelMaskNames.join(' ')})`
              : riff.chna
                ? ' — routing is defined by chna/axml, which is correct for ADM'
                : ' — the header does not describe the routing; a channel map is required')
          : ''),
    );
    out.push(`frames        ${riff.frames} (${riff.durationSeconds?.toFixed(3)} s)`);
  }
  if (riff.bext) {
    out.push(
      `bext v${riff.bext.version}      "${riff.bext.description}" / "${riff.bext.originator}"`,
    );
    if (riff.bext.loudness) {
      const L = riff.bext.loudness;
      out.push(
        `bext loudness ${L.integratedLufs} LUFS · LRA ${L.loudnessRangeLu} LU · ` +
          `peak ${L.maxTruePeakDbtp} dBTP`,
      );
    }
  }
  if (riff.chna) {
    out.push(`chna          ${riff.chna.numTracks} tracks, ${riff.chna.numUIDs} UIDs`);
    for (const e of riff.chna.entries) {
      out.push(
        `              ${String(e.trackIndex).padStart(3)}  ${e.uid}  ${e.trackFormatIdRef}  ${e.packFormatIdRef}`,
      );
    }
  }
  if (adm) {
    out.push(
      `adm           ${adm.summary.rootElement} · ${adm.summary.admVersion ?? 'no version'}`,
    );
    out.push(`              types: ${adm.summary.typeDefinitions.join(', ') || 'none'}`);
    out.push(
      `              well-formed: yes · structurally validated: ${adm.valid ? 'yes' : 'NO'} · ` +
        'schema validated: no',
    );
  }
  if (probe.available && probe.summary) {
    out.push(
      `ffprobe       ${probe.summary.channels} ch · ${probe.summary.sampleRate} Hz · ` +
        `${probe.summary.sampleFormat} · ${probe.summary.channelLayout ?? 'no layout'}`,
    );
  } else {
    out.push(`ffprobe       skipped (${probe.reason})`);
  }
  out.push('');
  for (const e of [...riff.errors, ...(adm?.errors ?? []), ...probe.errors]) out.push(`  ✗ ${e}`);
  for (const w of [...riff.warnings, ...(adm?.warnings ?? [])]) out.push(`  · ${w}`);
  out.push(reports[reports.length - 1].valid ? '  VALID' : '  INVALID');
  out.push('');
  process.stdout.write(out.join('\n'));
}

if (asJson) process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
process.exit(reports.some((r) => !r.valid) ? 1 : 0);
