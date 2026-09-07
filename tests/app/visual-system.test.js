/**
 * Visual-system guard — docs/COLOR-SYSTEM.md promises that the seven domain colours mean
 * the same thing in `src/styles/tokens.css`, in every README/docs diagram, in the repo map
 * and in `.github/labeler.yml`. A promise is a claim; this file is the test.
 *
 * Nothing here asserts a fixed palette (tokens.css is the source of truth) — it asserts the
 * *relationships*: both themes define all seven, the accents stay readable against their
 * theme's background (computed, not eyeballed), every diagram mirrors the tokens, every
 * directory of the repository is claimed by exactly one domain, and the labeler speaks the
 * same seven names.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const DOMAINS = ['dsp', 'spatial', 'runtime', 'export', 'testing', 'ui', 'app'];

/* ---------------------------------------------------------------- tokens.css ---- */

/** Slice the two theme blocks out of tokens.css by their real structure, not by line numbers. */
function themeBlocks(css) {
  const darkStart = css.indexOf(':root {');
  const lightStart = css.indexOf("\n[data-theme='light'] {");
  if (darkStart < 0 || lightStart < 0) throw new Error('tokens.css: theme blocks not found');
  const dark = css.slice(darkStart, lightStart);
  const light = css.slice(lightStart, css.indexOf('\n}', lightStart));
  return { dark, light };
}

function domAccents(block) {
  const out = {};
  for (const m of block.matchAll(/--dom-([a-z]+):\s*(#[0-9a-f]{6});/g)) out[m[1]] = m[2];
  return out;
}

function bgOf(block) {
  const m = block.match(/--bg:\s*(#[0-9a-f]{6});/);
  if (!m) throw new Error('tokens.css: --bg not found');
  return m[1];
}

/** WCAG 2.1 relative luminance + contrast ratio, from first principles. */
function contrast(h1, h2) {
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = (h) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const [a, b] = [lum(h1), lum(h2)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

describe('domain colour system (docs/COLOR-SYSTEM.md)', () => {
  const css = read('src/styles/tokens.css');
  const { dark, light } = themeBlocks(css);
  const darkAccents = domAccents(dark);
  const lightAccents = domAccents(light);

  it('defines all seven domain tokens in both themes, with distinct inks', () => {
    for (const d of DOMAINS) {
      expect(darkAccents[d], `dark --dom-${d}`).toBeTruthy();
      expect(lightAccents[d], `light --dom-${d}`).toBeTruthy();
      expect(
        lightAccents[d],
        `--dom-${d} may not copy its dark value into the light theme`,
      ).not.toBe(darkAccents[d]);
      // every domain also gets the soft fill + line pair the chips and diagrams use
      expect(dark, `dark soft ${d}`).toContain(`--dom-${d}-soft:`);
      expect(light, `light line ${d}`).toContain(`--dom-${d}-line:`);
    }
    expect(Object.keys(darkAccents).sort()).toEqual([...DOMAINS].sort());
  });

  it('keeps every accent legible on its theme background (>= 4.5:1, computed)', () => {
    for (const [accents, bg] of [
      [darkAccents, bgOf(dark)],
      [lightAccents, bgOf(light)],
    ]) {
      for (const d of DOMAINS) {
        const ratio = contrast(accents[d], bg);
        expect(ratio, `--dom-${d} ${accents[d]} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  /* ------------------------------------------------------- diagrams mirror code ---- */

  it('mirrors the tokens in every README and docs classDef, exactly', () => {
    const files = ['README.md']
      .concat(
        readdirSync(path.join(ROOT, 'docs'))
          .filter((f) => f.endsWith('.md'))
          .map((f) => `docs/${f}`),
      )
      .filter(existsSync);
    let seen = 0;
    for (const rel of files) {
      for (const m of read(rel).matchAll(/classDef\s+dom-([a-z]+)\s+([^\n]+)/g)) {
        const [, dom, decl] = m;
        seen += 1;
        expect(DOMAINS, `${rel}: rogue classDef dom-${dom}`).toContain(dom);
        const stroke = decl.match(/stroke:(#[0-9a-f]{6})/);
        const color = decl.match(/color:(#[0-9a-f]{6})/);
        const fill = decl.match(/fill:(#[0-9a-f]{6})/);
        expect(stroke, `${rel}: dom-${dom} needs an explicit stroke`).toBeTruthy();
        expect(fill, `${rel}: dom-${dom} needs an explicit 6-digit fill`).toBeTruthy();
        expect(stroke[1], `${rel}: dom-${dom} stroke must equal --dom-${dom}`).toBe(
          darkAccents[dom],
        );
        expect(color[1], `${rel}: dom-${dom} label ink must equal the accent`).toBe(stroke[1]);
      }
    }
    // guard against a silent pass-through: the swatch board alone uses all seven
    expect(seen, 'docs contain no domain classDefs — did the fences move?').toBeGreaterThanOrEqual(
      7,
    );
  });

  /* ------------------------------------------------ the machine-readable map ---- */

  it('claims every repository directory exactly once in domain-map.v1', () => {
    const fence = read('docs/COLOR-SYSTEM.md');
    const m = fence.match(/```json domain-map\.v1\n([\s\S]*?)```/);
    expect(m, 'domain-map.v1 fence missing from COLOR-SYSTEM.md').toBeTruthy();
    const map = JSON.parse(m[1]);
    expect(map.version, 'map version bumped without bumping this test').toBe(1);

    // every claimed prefix must name a real path — no phantom entries in the map
    for (const [dom, list] of Object.entries(map.domains)) {
      expect(DOMAINS, `rogue domain ${dom} in the map`).toContain(dom);
      for (const p of list) {
        expect(existsSync(path.join(ROOT, p)), `${dom}: '${p}' does not exist`).toBe(true);
      }
    }

    const dirsOf = (rel) =>
      !existsSync(path.join(ROOT, rel))
        ? []
        : readdirSync(path.join(ROOT, rel)).filter((n) =>
            statSync(path.join(ROOT, rel, n)).isDirectory(),
          );
    const required = [
      ...dirsOf('src').map((d) => `src/${d}`),
      ...dirsOf('src/audio').map((d) => `src/audio/${d}`),
      ...dirsOf('tests').map((d) => `tests/${d}`),
      ...dirsOf('tools').map((d) => `tools/${d}`),
      'ci',
      'e2e',
      '.github',
    ];
    expect(required.length, 'repo walked nothing — wrong root?').toBeGreaterThan(20);

    const claimOf = (dir) => {
      const hits = [];
      for (const [dom, list] of Object.entries(map.domains)) {
        for (const raw of list) {
          const p = raw.replace(/\/$/, '');
          if (dir === p) hits.push({ dom, len: p.length });
        }
      }
      if (!hits.length) return null;
      const best = Math.max(...hits.map((h) => h.len));
      const winners = [...new Set(hits.filter((h) => h.len === best).map((h) => h.dom))];
      return { winners };
    };

    for (const dir of required) {
      const claim = claimOf(dir);
      expect(claim, `${dir} is claimed by no domain`).not.toBeNull();
      expect(
        claim.winners,
        `${dir} is claimed by ${claim.winners.join(' + ')} — exactly one owner required`,
      ).toHaveLength(1);
    }
  });

  /* ------------------------------------------------------------ labeler parity ---- */

  it('ships GitHub area labels for all seven domains with real globs', () => {
    const yml = read('.github/labeler.yml');
    const entries = [...yml.matchAll(/^(area:([a-z]+)):\n((?:[ \t]+- .+\n?)+)/gm)];
    const labels = entries.map((e) => e[2]);
    expect(labels.sort()).toEqual([...DOMAINS].sort());
    for (const e of entries) {
      const globs = e[3]
        .trim()
        .split('\n')
        .map((l) => l.trim());
      expect(globs.length, `area:${e[2]} needs at least one glob`).toBeGreaterThan(0);
      for (const g of globs) {
        expect(g, `malformed glob line in area:${e[2]}`).toMatch(/^- '.*'$/);
      }
    }
  });
});
