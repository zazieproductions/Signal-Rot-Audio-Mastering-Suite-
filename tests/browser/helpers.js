/**
 * Playwright helpers for the conformance lab.
 */

import { expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');

export const LAB_URL = '/tests/browser/harness.html';

export async function openLab(page) {
  await page.goto(LAB_URL);
  await page.waitForFunction(() => window.__SR_LAB__ && window.__SR_LAB__.ready);
}

export async function callLab(page, method, ...args) {
  return page.evaluate(
    async ({ method: m, args: a }) => {
      const lab = window.__SR_LAB__;
      const fn = lab[m];
      if (typeof fn !== 'function') throw new Error(`__SR_LAB__.${m} is not a function`);
      return fn(...a);
    },
    { method, args },
  );
}

export async function writeResult(testInfo, name, data) {
  const dir = join(REPO_ROOT, 'lab-results', 'conformance', testInfo.project.name);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${name}.json`);
  const body = `${JSON.stringify(data, null, 2)}\n`;
  writeFileSync(filePath, body);
  await testInfo.attach(`${name}.json`, { body, contentType: 'application/json' });
  return filePath;
}

export function browserNameOf(testInfo) {
  return testInfo.project.name.replace(/-desktop$/, '');
}

export { expect };
