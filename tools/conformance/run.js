#!/usr/bin/env node
/**
 * Run the real-browser Web Audio conformance suite.
 *
 *     node tools/conformance/run.js
 *     node tools/conformance/run.js --project chromium
 *
 * Requires Playwright browsers:
 *
 *     npx playwright install chromium firefox webkit
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const extra = process.argv.slice(2);

const result = spawnSync(
  'npx',
  ['playwright', 'test', '--config', 'tests/browser/playwright.config.js', ...extra],
  { cwd: root, stdio: 'inherit', env: process.env },
);

process.exit(result.status ?? 1);
