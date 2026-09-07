#!/usr/bin/env node
/**
 * ADM validation CLI.
 *
 *   npm run validate:adm                       validate the generated fixtures
 *   npm run validate:adm -- <file.xml|.wav>    validate a specific document or BWF
 *   npm run validate:adm -- --xsd <schema.xsd> additionally schema-validate with xmllint
 *
 * ── About `--xsd` ────────────────────────────────────────────────────────────────────
 * The normative ITU-R BS.2076 XSD is published by the ITU and is not licensed for
 * redistribution, so this repository does not vendor one and CI cannot download one. If
 * you hold a copy, point `--xsd` at it and this command will additionally run `xmllint
 * --schema`, giving genuine schema validation locally. Until then the project says
 * "structurally validated", never "schema validated".
 */

import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { buildAdmXml } from '../../src/audio/immersive/adm.js';
import { LAYOUT_IDS, wavChannelOrder } from '../../src/audio/immersive/layouts.js';
import { validateAdmXml } from './adm-validate.js';
import { inspectRiff } from './riff-inspect.js';

const execFileAsync = promisify(execFile);

/** Run `xmllint --schema`, if both the tool and a schema are available. */
async function schemaValidate(xml, xsdPath) {
  if (!xsdPath) {
    return {
      attempted: false,
      passed: false,
      reason:
        'No --xsd supplied. The normative BS.2076 schema is not redistributable, so ' +
        'schema validation is opt-in with your own licensed copy.',
    };
  }
  const bin = process.env.XMLLINT_PATH ?? 'xmllint';
  try {
    await execFileAsync(bin, ['--version'], { timeout: 10000 });
  } catch {
    return {
      attempted: false,
      passed: false,
      reason: `--xsd was supplied but "${bin}" is not available. Install libxml2-utils.`,
    };
  }
  const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(path.join(tmpdir(), 'adm-'));
  const tmp = path.join(dir, 'doc.xml');
  try {
    await writeFile(tmp, xml, 'utf8');
    await execFileAsync(bin, ['--noout', '--schema', xsdPath, tmp], { timeout: 120000 });
    return { attempted: true, passed: true, schema: xsdPath };
  } catch (e) {
    return {
      attempted: true,
      passed: false,
      schema: xsdPath,
      output: (e.stderr || e.stdout || e.message || '').trim(),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Extract an ADM XML document from a path (a .xml file, or the axml chunk of a BWF). */
async function loadXml(file) {
  const bytes = new Uint8Array(await readFile(file));
  if (/\.(wav|bwf|bw64|rf64)$/i.test(file)) {
    const riff = inspectRiff(bytes);
    if (!riff.axml) throw new Error(`${file} contains no axml chunk.`);
    return {
      xml: riff.axml,
      context: {
        expectedChannels: riff.fmt?.channels,
        expectedTrackUids: riff.chna?.entries.map((e) => e.uid),
        sampleRate: riff.fmt?.sampleRate,
        bitDepth: riff.fmt?.bitsPerSample,
      },
    };
  }
  return { xml: new TextDecoder().decode(bytes), context: {} };
}

const args = process.argv.slice(2);
const xsdIndex = args.indexOf('--xsd');
const xsd = xsdIndex >= 0 ? path.resolve(args[xsdIndex + 1]) : undefined;
const targets = args.filter((a, i) => !a.startsWith('--') && i !== xsdIndex + 1);

/** @type {Array<{label: string, xml: string, context: object}>} */
const documents = [];

if (targets.length) {
  for (const t of targets) {
    const resolved = path.resolve(t);
    const stat = await import('node:fs/promises').then((m) => m.stat(resolved));
    if (stat.isDirectory()) {
      for (const name of await readdir(resolved)) {
        if (!/\.(xml|wav)$/i.test(name)) continue;
        const { xml, context } = await loadXml(path.join(resolved, name)).catch(() => ({}));
        if (xml) documents.push({ label: name, xml, context });
      }
    } else {
      const { xml, context } = await loadXml(resolved);
      documents.push({ label: path.basename(resolved), xml, context });
    }
  }
} else {
  // No target: validate a freshly generated document for every layout the engine knows.
  for (const layoutId of LAYOUT_IDS) {
    const order = wavChannelOrder(layoutId).order;
    documents.push({
      label: `generated:${layoutId}`,
      xml: buildAdmXml({
        layoutId,
        sampleRate: 48000,
        bitDepth: 24,
        durationSeconds: 10,
        order,
      }),
      context: { expectedChannels: order.length, sampleRate: 48000, bitDepth: 24 },
    });
  }
}

let failures = 0;
const results = [];
for (const doc of documents) {
  const r = validateAdmXml(doc.xml, doc.context);
  const schema = await schemaValidate(doc.xml, xsd);
  const passed = r.valid && (!schema.attempted || schema.passed);
  if (!passed) failures++;
  results.push({ document: doc.label, ...r, schema });

  process.stdout.write(`${passed ? 'PASS' : 'FAIL'}  ${doc.label}\n`);
  process.stdout.write(
    `      well-formed: yes   structurally validated: ${r.valid ? 'yes' : 'NO'}   ` +
      `schema validated: ${schema.attempted ? (schema.passed ? 'yes' : 'NO') : 'not attempted'}\n`,
  );
  if (!schema.attempted && schema.reason) process.stdout.write(`      ${schema.reason}\n`);
  if (schema.attempted && !schema.passed) process.stdout.write(`      ${schema.output}\n`);
  for (const e of r.errors) process.stdout.write(`      ✗ ${e}\n`);
  for (const w of r.warnings) process.stdout.write(`      · ${w}\n`);
}

process.stdout.write(`\n${documents.length - failures}/${documents.length} documents valid.\n`);
process.stdout.write('Dolby Atmos certified: no. This is a DirectSpeakers channel bed.\n');
process.exit(failures > 0 ? 1 : 0);
