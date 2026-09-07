#!/usr/bin/env node
/**
 * Export interoperability validation runner.
 *
 * ── The principle ────────────────────────────────────────────────────────────────────
 * SIGNAL ROT SHOULD NOT HAVE TO TRUST ITSELF TO PROVE THAT ITS OWN FILES ARE VALID.
 *
 * This runner generates fixtures with the production writers and then attacks them from
 * outside:
 *
 *   · `riff-inspect.js`  — an independent RIFF/RF64/BW64/bext/chna parser written from
 *                          the specifications, sharing no code with `src/audio/encode`.
 *   · `adm-validate.js`  — an independent ADM structural validator with its own XML parser.
 *   · `ffprobe`          — FFmpeg. Not ours. If it disagrees, we are wrong.
 *   · round trip         — decode the file back to PCM and compare against the samples
 *                          the writer was given, within the quantisation tolerance of
 *                          the bit depth.
 *   · channel order      — recover the channel order from the *audio* via the
 *                          identification tones and check it against the layout.
 *
 * Output is machine-readable JSON on `--json`, and a human summary otherwise. Exit code
 * is non-zero if any check fails, which is what makes it usable as a CI gate.
 *
 *   node tools/export-validation/validate-exports.js [--json <path>] [--dir <path>] [--quiet]
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { identifyChannelOrder } from '../../src/audio/encode/channel-identification.js';
import { sha256 } from '../../src/audio/encode/checksum.js';
import { SPEAKERS } from '../../src/audio/immersive/layouts.js';
import { validateAdmXml } from './adm-validate.js';
import { probeFile } from './ffprobe.js';
import { buildFixtures, writeFixtures, DEFAULT_FIXTURE_DIR } from './generate-fixtures.js';
import { decodePcm, inspectRiff } from './riff-inspect.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Peak absolute quantisation error a round trip may legitimately introduce.
 *
 * For an n-bit two's-complement conversion the writer rounds to the nearest step of
 * 2^-(n-1), so the reconstruction error is at most half a step. A hair of slack is added
 * for the float→int→float path's own representation error.
 */
export function quantisationTolerance(bitDepth) {
  if (bitDepth === 32) return 1e-7; // float32 round trip: exact but for denormal handling
  return Math.pow(2, -(bitDepth - 1)) * 0.5 + 1e-9;
}

/** Compare two channel sets sample-for-sample. */
function comparePcm(original, decoded, tolerance) {
  const findings = [];
  if (decoded.channels.length !== original.channels.length) {
    findings.push(
      `Channel count changed in the round trip: wrote ${original.channels.length}, ` +
        `read back ${decoded.channels.length}.`,
    );
    return { ok: false, findings, maxError: null };
  }
  if (decoded.length !== original.length) {
    findings.push(
      `Frame count changed in the round trip: wrote ${original.length}, read back ` +
        `${decoded.length}. ${decoded.length < original.length ? 'The file is TRUNCATED.' : ''}`,
    );
    return { ok: false, findings, maxError: null };
  }
  if (decoded.sampleRate !== original.sampleRate) {
    findings.push(
      `Sample rate changed: wrote ${original.sampleRate}, read back ${decoded.sampleRate}.`,
    );
  }

  let maxError = 0;
  let worstChannel = -1;
  let worstFrame = -1;
  const peaks = { original: [], decoded: [] };
  let polarityFlips = 0;

  for (let c = 0; c < original.channels.length; c++) {
    const a = original.channels[c];
    const b = decoded.channels[c];
    let peakA = 0;
    let peakB = 0;
    let dot = 0;
    let energy = 0;
    for (let i = 0; i < a.length; i++) {
      const e = Math.abs(a[i] - b[i]);
      if (e > maxError) {
        maxError = e;
        worstChannel = c;
        worstFrame = i;
      }
      if (Math.abs(a[i]) > peakA) peakA = Math.abs(a[i]);
      if (Math.abs(b[i]) > peakB) peakB = Math.abs(b[i]);
      dot += a[i] * b[i];
      energy += a[i] * a[i];
    }
    peaks.original.push(peakA);
    peaks.decoded.push(peakB);
    // A negative correlation over a non-silent channel means the decoder read the
    // samples inverted — a sign-extension bug in 24-bit is the classic cause.
    if (energy > 1e-9 && dot < 0) {
      polarityFlips++;
      findings.push(`Channel ${c + 1} came back POLARITY-INVERTED.`);
    }
    if (peakA > 1e-6 && peakB < 1e-6) {
      findings.push(`Channel ${c + 1} was written with signal but read back SILENT.`);
    }
    if (peakA < 1e-6 && peakB > 1e-3) {
      findings.push(`Channel ${c + 1} was written silent but read back with signal.`);
    }
    if (peakA > 1e-6 && Math.abs(peakB - peakA) > tolerance + peakA * 1e-4) {
      findings.push(
        `Channel ${c + 1} peak changed from ${peakA.toFixed(6)} to ${peakB.toFixed(6)} ` +
          `(tolerance ${tolerance.toExponential(2)}).`,
      );
    }
  }

  if (maxError > tolerance) {
    findings.push(
      `Round-trip sample error ${maxError.toExponential(3)} exceeds the ` +
        `${tolerance.toExponential(3)} quantisation tolerance (worst at channel ` +
        `${worstChannel + 1}, frame ${worstFrame}).`,
    );
  }

  return {
    ok: findings.length === 0,
    findings,
    maxError,
    polarityFlips,
    peaks,
  };
}

/**
 * Validate one fixture.
 * @param {object} fixture from {@link buildFixtures}
 * @param {Uint8Array} bytes
 * @param {string} [filePath] when present, ffprobe is run against it
 */
export async function validateFixture(fixture, bytes, filePath) {
  const errors = [];
  const warnings = [];
  /** @type {any} */
  const checks = {};

  // ── 1. Independent RIFF parse ──
  const riff = inspectRiff(bytes);
  checks.riff = {
    container: riff.container,
    form: riff.form,
    chunks: riff.chunks.map((c) => ({ id: c.id, size: c.size, offset: c.dataOffset })),
    fmt: riff.fmt,
    ds64: riff.ds64,
    bext: riff.bext ? { ...riff.bext, codingHistory: undefined } : null,
    chna: riff.chna ? { numTracks: riff.chna.numTracks, numUIDs: riff.chna.numUIDs } : null,
    frames: riff.frames,
    valid: riff.valid,
  };
  errors.push(...riff.errors.map((e) => `[riff] ${e}`));
  warnings.push(...riff.warnings.map((w) => `[riff] ${w}`));

  // ── 2. Declared vs expected format ──
  const fmt = riff.fmt;
  if (fmt) {
    if (fmt.channels !== fixture.channelCount) {
      errors.push(`[fmt] declares ${fmt.channels} channels, expected ${fixture.channelCount}.`);
    }
    if (fmt.sampleRate !== fixture.sampleRate) {
      errors.push(`[fmt] declares ${fmt.sampleRate} Hz, expected ${fixture.sampleRate}.`);
    }
    if (fmt.bitsPerSample !== fixture.bitDepth) {
      errors.push(`[fmt] declares ${fmt.bitsPerSample}-bit, expected ${fixture.bitDepth}.`);
    }
    if (riff.frames !== fixture.frames) {
      errors.push(`[data] holds ${riff.frames} frames, expected ${fixture.frames}.`);
    }
    const expectedMask = fixture.expectedMask ?? 0;
    const actualMask = fmt.channelMask ?? 0;
    if (actualMask !== expectedMask) {
      errors.push(
        `[fmt] channel mask is 0x${actualMask.toString(16).toUpperCase()}, expected ` +
          `0x${expectedMask.toString(16).toUpperCase()}.`,
      );
    }
    // A non-standard layout MUST advertise mask 0 rather than an approximation: a wrong
    // mask makes a player route confidently to the wrong speakers, which is worse than
    // no mask at all.
    if (fixture.standardMask === false && fixture.layout && actualMask !== 0) {
      errors.push(
        `[fmt] layout "${fixture.layout}" has no standard mask but the file advertises ` +
          `0x${actualMask.toString(16).toUpperCase()}.`,
      );
    }
    if (fixture.standardMask && fixture.layout) {
      // The mask's bits, read in ascending order, must name the same speakers as the
      // delivery order — that is what WAVE_FORMAT_EXTENSIBLE interleaving means.
      const expectedNames = fixture.expectedOrder.map((k) => SPEAKERS[k]?.wavMaskBit ?? 0);
      const sorted = [...expectedNames].sort((a, b) => a - b);
      if (expectedNames.some((v, i) => v !== sorted[i])) {
        errors.push(
          '[order] the fixture\u2019s delivery order is not ascending mask-bit order, which ' +
            'WAVE_FORMAT_EXTENSIBLE requires.',
        );
      }
    }
  }

  // ── 3. Round trip through the independent decoder ──
  const decoded = decodePcm(bytes);
  if (!decoded) {
    errors.push('[roundtrip] the independent decoder could not read the file.');
  } else {
    const tolerance = quantisationTolerance(fixture.bitDepth);
    const cmp = comparePcm(fixture.data, decoded, tolerance);
    checks.roundTrip = {
      ok: cmp.ok,
      maxError: cmp.maxError,
      tolerance,
      polarityFlips: cmp.polarityFlips,
    };
    errors.push(...cmp.findings.map((f) => `[roundtrip] ${f}`));

    // ── 4. Channel order recovered from the audio itself ──
    if (fixture.channelCount > 1) {
      const idOpts = {
        sampleRate: fixture.sampleRate,
        beepMs: 12,
        gapMs: 8,
        pauseMs: 20,
        toneMs: 60,
        tailMs: 10,
      };
      const detected = identifyChannelOrder(decoded, idOpts);
      const expected = decoded.channels.map((_, i) => i + 1);
      const matches = detected.order.every((v, i) => v === expected[i]);
      const minConfidence = Math.min(...detected.confidence);
      checks.channelOrder = {
        detected: detected.order,
        expected,
        matches,
        minConfidence: Number.isFinite(minConfidence) ? Number(minConfidence.toFixed(2)) : null,
        speakerIds: fixture.expectedOrder,
      };
      if (!matches) {
        errors.push(
          `[order] channel identification tones came back in order [${detected.order}] ` +
            `but the file should be [${expected}] — CHANNELS ARE REORDERED. ` +
            `Physical channel N should carry the tone for speaker ` +
            `"${fixture.expectedOrder[detected.order[0] - 1] ?? '?'}".`,
        );
      }
      // A low margin means the tones are bleeding into each other, which would make the
      // whole channel-order check unable to detect a real swap.
      if (Number.isFinite(minConfidence) && minConfidence < 8) {
        warnings.push(
          `[order] the weakest identification margin is ${minConfidence.toFixed(1)}×. ` +
            'Below about 8× this check can no longer reliably distinguish a swap.',
        );
      }
    }
  }

  // ── 5. ADM ──
  if (fixture.kind === 'adm') {
    if (!riff.axml) {
      errors.push('[adm] no axml chunk in an ADM fixture.');
    } else {
      const adm = validateAdmXml(riff.axml, {
        expectedChannels: fixture.channelCount,
        expectedTrackUids: riff.chna?.entries.map((e) => e.uid),
        sampleRate: fixture.sampleRate,
        bitDepth: fixture.bitDepth,
      });
      checks.adm = {
        wellFormed: adm.wellFormed,
        structurallyValidated: adm.valid,
        schemaValidated: false,
        counts: adm.summary.counts,
        typeDefinitions: adm.summary.typeDefinitions,
        namespace: adm.summary.defaultNamespace,
        version: adm.summary.admVersion,
      };
      errors.push(...adm.errors.map((e) => `[adm] ${e}`));
      warnings.push(...adm.warnings.map((w) => `[adm] ${w}`));
    }
    if (!riff.chna) errors.push('[adm] no chna chunk in an ADM fixture.');
    if (!riff.bext) errors.push('[adm] no bext chunk in an ADM BWF.');
    // chna must be ordered to match the delivery order, or the routing claim is wrong.
    if (riff.chna && fixture.expectedOrder) {
      riff.chna.entries.forEach((e, i) => {
        const expectedUid = `ATU_${(i + 1).toString(16).toUpperCase().padStart(8, '0')}`;
        if (e.uid !== expectedUid) {
          errors.push(`[adm] chna track ${i + 1} has UID "${e.uid}", expected "${expectedUid}".`);
        }
      });
    }
  } else if (riff.axml || riff.chna) {
    warnings.push('[adm] a non-ADM fixture carries ADM chunks.');
  }

  // ── 6. Independent third-party decoder ──
  if (filePath) {
    const probe = await probeFile(filePath);
    checks.ffprobe = probe.available
      ? { ...probe.summary, binary: probe.binary, errors: probe.errors }
      : { skipped: true, reason: probe.reason };
    if (probe.available) {
      errors.push(...probe.errors.map((e) => `[ffprobe] ${e}`));
      const s = probe.summary;
      if (s) {
        if (s.channels !== fixture.channelCount) {
          errors.push(
            `[ffprobe] reports ${s.channels} channels, the file should have ` +
              `${fixture.channelCount}. An independent decoder disagrees with our header.`,
          );
        }
        if (s.sampleRate !== fixture.sampleRate) {
          errors.push(`[ffprobe] reports ${s.sampleRate} Hz, expected ${fixture.sampleRate}.`);
        }
        if (s.durationSeconds !== null) {
          const expected = fixture.frames / fixture.sampleRate;
          if (Math.abs(s.durationSeconds - expected) > 0.01) {
            errors.push(
              `[ffprobe] reports ${s.durationSeconds.toFixed(3)} s, expected ` +
                `${expected.toFixed(3)} s.`,
            );
          }
        }
      }
    } else {
      warnings.push(`[ffprobe] ${probe.reason}`);
    }
  }

  return {
    fixture: fixture.name,
    kind: fixture.kind,
    layout: fixture.layout,
    channelCount: fixture.channelCount,
    bitDepth: fixture.bitDepth,
    sampleRate: fixture.sampleRate,
    bytes: bytes.length,
    sha256: await sha256(bytes),
    passed: errors.length === 0,
    errors,
    warnings,
    checks,
  };
}

/** Run the whole suite. */
export async function runValidation(opts = {}) {
  const dir = opts.dir ?? DEFAULT_FIXTURE_DIR;
  const startedAt = new Date().toISOString();

  await writeFixtures(dir, opts);
  const fixtures = buildFixtures(opts);

  const results = [];
  for (const f of fixtures) {
    const filePath = path.join(dir, f.name);
    const bytes = new Uint8Array(await readFile(filePath));
    results.push(await validateFixture(f, bytes, filePath));
  }

  const failed = results.filter((r) => !r.passed);
  const ffprobeSkipped = results.some((r) => r.checks.ffprobe?.skipped);

  return {
    schema: 'signal-rot/export-validation/1',
    startedAt,
    finishedAt: new Date().toISOString(),
    fixtureDirectory: dir,
    tooling: {
      independentRiffParser: 'tools/export-validation/riff-inspect.js',
      independentAdmValidator: 'tools/export-validation/adm-validate.js',
      externalDecoder: results[0]?.checks.ffprobe?.binary ?? null,
      externalDecoderAvailable: !ffprobeSkipped,
      note:
        'The RIFF parser and the ADM validator are written from the published ' +
        'specifications and share no code with src/audio/encode or src/audio/immersive. ' +
        'ffprobe is FFmpeg, a third-party implementation.',
    },
    claims: {
      riffStructurallyValidated: failed.length === 0,
      admStructurallyValidated:
        failed.length === 0 && results.some((r) => r.checks.adm?.structurallyValidated),
      admSchemaValidated: false,
      admSchemaValidationNote:
        'The normative ITU-R BS.2076 XSD is not redistributable, so CI cannot obtain one. ' +
        'Run `npm run validate:adm -- --xsd <path>` with a licensed copy locally.',
      interoperabilityTested: !ffprobeSkipped && failed.length === 0,
      dolbyAtmosCertified: false,
    },
    summary: {
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      warnings: results.reduce((n, r) => n + r.warnings.length, 0),
    },
    results,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const arg = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const report = await runValidation({ dir: arg('--dir') });
  const jsonPath = arg('--json') ?? path.resolve(here, '../../export-validation-report.json');
  await writeFile(jsonPath, JSON.stringify(report, null, 2));

  if (!args.includes('--quiet')) {
    const lines = [];
    lines.push('');
    lines.push('EXPORT INTEROPERABILITY VALIDATION');
    lines.push('='.repeat(78));
    for (const r of report.results) {
      const mark = r.passed ? 'PASS' : 'FAIL';
      lines.push(
        `${mark}  ${r.fixture.padEnd(32)} ${String(r.channelCount).padStart(2)} ch  ` +
          `${String(r.bitDepth).padStart(2)}-bit  ${r.checks.riff.container}` +
          (r.checks.channelOrder
            ? `  order ${r.checks.channelOrder.matches ? 'ok' : 'WRONG'}`
            : ''),
      );
      for (const e of r.errors) lines.push(`      ✗ ${e}`);
      for (const w of r.warnings) lines.push(`      · ${w}`);
    }
    lines.push('='.repeat(78));
    lines.push(
      `${report.summary.passed}/${report.summary.total} passed, ` +
        `${report.summary.warnings} warnings.`,
    );
    lines.push(`External decoder: ${report.tooling.externalDecoder ?? 'NOT AVAILABLE (skipped)'}`);
    lines.push(`ADM schema validated: no (${report.claims.admSchemaValidationNote})`);
    lines.push('Dolby Atmos certified: no.');
    lines.push(`Report: ${jsonPath}`);
    lines.push('');
    process.stdout.write(lines.join('\n'));
  }

  process.exit(report.summary.failed > 0 ? 1 : 0);
}
