#!/usr/bin/env node
/**
 * Compare two golden / lab-result JSON documents and print a sonic regression report.
 *
 *     node tools/audio-regression/compare.js --baseline a.json --candidate b.json
 *     node tools/audio-regression/compare.js --baseline-ref HEAD --candidate-ref WORKTREE
 *
 * `--baseline-ref` reads a committed file with `git show` so we never check out another
 * branch (Agent A owns the DSP tree). WORKTREE means the files on disk right now.
 *
 * Exit code 1 if any *defect* flag is raised. Creative notes do not fail the process.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { compareMeasurements, compareBrowsers } from '../../tests/conformance/compare.js';
import { renderMarkdown, renderJson } from '../../tests/conformance/report.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

function loadJson(spec, ref) {
  if (ref && ref !== 'WORKTREE') {
    const rel = spec.startsWith('/') ? spec.slice(root.length + 1) : spec;
    const raw = execSync(`git show ${ref}:${rel}`, { cwd: root, encoding: 'utf8' });
    return JSON.parse(raw);
  }
  return JSON.parse(readFileSync(resolve(root, spec), 'utf8'));
}

function extract(doc) {
  if (Array.isArray(doc)) return doc;
  if (Array.isArray(doc.measurements)) {
    // processed.v1.json stores {id, reference, creative}
    if (doc.measurements[0] && doc.measurements[0].reference) {
      return doc.measurements.flatMap((m) => [
        { ...m.reference, id: `${m.id}::reference`, class: 'reference' },
        { ...m.creative, id: `${m.id}::creative`, class: 'creative' },
      ]);
    }
    return doc.measurements;
  }
  return [];
}

const baselinePath = arg('--baseline') ?? 'tests/fixtures/goldens/sources.v1.json';
const candidatePath = arg('--candidate') ?? 'tests/fixtures/goldens/sources.v1.json';
const baselineRef = arg('--baseline-ref', 'WORKTREE');
const candidateRef = arg('--candidate-ref', 'WORKTREE');
const outDir = arg('--out', 'lab-results/regression');
const browsersDir = arg('--browsers', null);

const baseline = extract(loadJson(baselinePath, baselineRef));
const candidate = extract(loadJson(candidatePath, candidateRef));

const comparison = compareMeasurements(baseline, candidate);
comparison.findings = comparison.flags
  .filter((f) => f.severity === 'defect' || f.kind === 'browser-divergence')
  .map((f) => f.message);

if (browsersDir) {
  // Expect lab-results/conformance/<browser>/*.json
  const browsers = {};
  try {
    for (const name of readdirSync(resolve(root, browsersDir))) {
      const files = readdirSync(resolve(root, browsersDir, name)).filter((f) =>
        f.endsWith('.json'),
      );
      browsers[name] = files.flatMap((f) => {
        const doc = JSON.parse(readFileSync(resolve(root, browsersDir, name, f), 'utf8'));
        return extract(doc).length ? extract(doc) : [{ id: f.replace(/\.json$/, ''), ...doc }];
      });
    }
    const b = compareBrowsers(browsers);
    comparison.flags.push(...b.flags);
    comparison.summary.browser = b.summary;
  } catch (error) {
    comparison.findings.push(`Could not read browsers dir: ${error.message}`);
  }
}

const meta = {
  generatedAt: new Date().toISOString(),
  baseline: `${baselineRef}:${baselinePath}`,
  candidate: `${candidateRef}:${candidatePath}`,
};

mkdirSync(resolve(root, outDir), { recursive: true });
const mdPath = join(resolve(root, outDir), 'report.md');
const jsonPath = join(resolve(root, outDir), 'report.json');
writeFileSync(mdPath, renderMarkdown(comparison, meta));
writeFileSync(jsonPath, `${JSON.stringify(renderJson(comparison, meta), null, 2)}\n`);

console.log(renderMarkdown(comparison, meta));
console.log(`Wrote ${mdPath}`);
console.log(`Wrote ${jsonPath}`);
process.exit(comparison.summary.ok ? 0 : 1);
