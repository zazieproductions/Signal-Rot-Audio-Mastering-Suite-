#!/usr/bin/env node
/**
 * Generate the golden measurement bank.
 *
 *     node tools/audio-regression/generate.js
 *     SR_UPDATE_GOLDENS=1 npm test -- tests/fixtures/goldens.test.js
 *
 * Writes machine-readable JSON under tests/fixtures/goldens/. Audio itself is never
 * committed — fixtures are synthesised from code.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAll } from '../../tests/fixtures/generate.js';
import { measureAudio } from '../../tests/fixtures/measure.js';
import { allLayoutReports } from '../../tests/conformance/immersive-catalog.js';
import { cloneAudioData } from '../../src/audio/dsp/audio-data.js';
import { shapeTransients } from '../../src/audio/render/transient-shaper.js';
import { normalizeAndLimit } from '../../src/audio/render/normalize.js';
import {
  referenceParameters,
  creativeParameters,
  classifyParameters,
} from '../../tests/conformance/classify.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = join(root, 'tests/fixtures/goldens');

function write(name, payload) {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, name);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
  return path;
}

function processOffline(data, parameters) {
  const copy = cloneAudioData(data);
  shapeTransients(copy, { attack: parameters.transAttack, sustain: parameters.transSustain });
  normalizeAndLimit(copy, {
    normalize: parameters.normalize,
    targetLufs: parameters.targetLUFS,
    ceilingDb: parameters.ceiling,
    refine: true,
  });
  return copy;
}

const generatedAt = new Date().toISOString();
const sources = generateAll();

const sourceMeasurements = sources.map((f) =>
  measureAudio(f.data, { id: f.id, title: f.title, class: 'source', engine: 'node' }),
);

const refParams = referenceParameters();
const creParams = creativeParameters();
const processed = [];
for (const f of sources) {
  if (f.id === 'impulse' || f.id === 'silence') continue; // too short / silent for loudness
  const ref = measureAudio(processOffline(f.data, refParams), {
    id: f.id,
    title: f.title,
    class: 'reference',
    engine: 'node-offline',
  });
  const cre = measureAudio(processOffline(f.data, creParams), {
    id: f.id,
    title: f.title,
    class: 'creative',
    engine: 'node-offline',
  });
  processed.push({ id: f.id, reference: ref, creative: cre });
}

const sourcePath = write('sources.v1.json', {
  version: 1,
  generatedAt,
  engine: 'node',
  measurements: sourceMeasurements,
});

const processedPath = write('processed.v1.json', {
  version: 1,
  generatedAt,
  engine: 'node-offline',
  reference: classifyParameters(refParams),
  creative: classifyParameters(creParams),
  measurements: processed,
});

const immersivePath = write('immersive-layouts.v1.json', {
  version: 1,
  generatedAt,
  layouts: allLayoutReports(),
});

console.log('Wrote', sourcePath);
console.log('Wrote', processedPath);
console.log('Wrote', immersivePath);
console.log(`${sourceMeasurements.length} source fixtures, ${processed.length} processed pairs.`);
