/**
 * @vitest-environment jsdom
 *
 * Boot smoke test.
 *
 * Loads the real `index.html`, stubs the Web Audio and canvas APIs jsdom does not provide,
 * and runs `bootstrap()`. This is the cheapest possible answer to "does the application
 * actually start?" — the question the audited repository answered with *no*, because
 * `index.html` pointed at `./src/app.js` while the file sat at the repository root.
 *
 * It cannot verify that anything *sounds* right; the Playwright suite in `e2e/` does that
 * in a real browser.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FakeAudioContext } from '../helpers/fake-audio-context.js';
import { installFakeCanvas } from '../helpers/fake-canvas.js';
import { SIGNAL_FLOW } from '../../src/app/constants.js';
import { ALL_PRESETS } from '../../src/presets/index.js';
import { PARAMETER_LIST } from '../../src/app/parameters.js';

// jsdom rewrites `import.meta.url` to an http URL, so resolve from the project root
// instead. Vitest runs with the repository root as the working directory.
const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

/** Extract the `<body>` of the real page so the test runs against the shipped markup. */
function loadShell() {
  const body = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'));
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, '');
  document.documentElement.dataset.theme = 'dark';
}

let errors;
let rafCallbacks;

beforeEach(() => {
  errors = [];
  rafCallbacks = [];
  loadShell();
  installFakeCanvas(window);

  window.AudioContext = FakeAudioContext;
  window.OfflineAudioContext = class extends FakeAudioContext {
    constructor(channels, length, sampleRate) {
      super(sampleRate);
      this.numberOfChannels = channels;
      this.length = length;
    }
    startRendering() {
      return Promise.resolve(
        this.createBuffer(this.numberOfChannels, this.length, this.sampleRate),
      );
    }
  };
  window.requestAnimationFrame = (cb) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  };
  window.cancelAnimationFrame = () => {};
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.join(' ')));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('application boot', () => {
  it('starts without throwing and without logging an error', async () => {
    const { bootstrap } = await import('../../src/app/bootstrap.js');
    const app = bootstrap();
    expect(app.store).toBeTruthy();
    expect(app.transport).toBeTruthy();
    expect(errors).toEqual([]);
  });

  it('renders every control declared in the schema', async () => {
    const { bootstrap } = await import('../../src/app/bootstrap.js');
    bootstrap();
    const missing = [];
    for (const spec of PARAMETER_LIST) {
      if (spec.type === 'array') continue;
      if (!document.querySelector(`#p-${spec.key}`)) missing.push(spec.key);
    }
    expect(missing, `parameters with no control: ${missing.join(', ')}`).toEqual([]);
  });

  it('renders the signal-flow view', async () => {
    const { bootstrap } = await import('../../src/app/bootstrap.js');
    bootstrap();
    const flow = document.querySelector('#signalFlow');
    expect(flow.children.length).toBeGreaterThan(SIGNAL_FLOW.length);
    for (const module of SIGNAL_FLOW) expect(flow.textContent).toContain(module.label);
  });

  it('renders the whole preset catalogue', async () => {
    const { bootstrap } = await import('../../src/app/bootstrap.js');
    bootstrap();
    expect(document.querySelectorAll('.preset')).toHaveLength(ALL_PRESETS.length);
  });

  it('populates the immersive layout menu and its controls', async () => {
    const { bootstrap } = await import('../../src/app/bootstrap.js');
    bootstrap();
    const options = [...document.querySelectorAll('#imLayout option')].map((o) => o.value);
    expect(options).toContain('off');
    expect(options).toContain('soniclab');
    expect(options).toContain('7.1.4');
    expect(document.querySelectorAll('#imControls .ctl').length).toBeGreaterThan(5);
  });

  it('fills in the About panel from live capability probing', async () => {
    const { bootstrap } = await import('../../src/app/bootstrap.js');
    bootstrap();
    expect(document.querySelector('#aboutEngine').textContent).toContain('SIGNAL ROT');
    expect(document.querySelector('#divergenceList').textContent).toContain('export');
    expect(document.querySelector('#capabilityList').textContent).toContain('Web Audio');
    expect(document.querySelector('#engineBadge').textContent).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it('runs an animation frame without throwing', async () => {
    const { bootstrap } = await import('../../src/app/bootstrap.js');
    bootstrap();
    expect(rafCallbacks.length).toBeGreaterThan(0);
    expect(() => rafCallbacks[0](performance.now())).not.toThrow();
    expect(errors).toEqual([]);
  });

  it('applies a preset end to end through the real DOM', async () => {
    const { bootstrap } = await import('../../src/app/bootstrap.js');
    const app = bootstrap();
    const card = [...document.querySelectorAll('.preset')].find(
      (n) => n.dataset.preset === 'Vinyl Séance',
    );
    card.click();
    expect(app.store.getParameters().vinyl).toBe(45);
    expect(app.store.getParameters().bassMono).toBe(100);
    expect(app.store.getState().ui.presetName).toBe('Vinyl Séance');
    expect(document.querySelector('#presetAudit').textContent).toContain('Vinyl Séance');
    expect(errors).toEqual([]);
  });

  it('wires the transport buttons', async () => {
    const { bootstrap } = await import('../../src/app/bootstrap.js');
    bootstrap();
    expect(() => document.querySelector('#playBtn').click()).not.toThrow();
    expect(() => document.querySelector('#stopBtn').click()).not.toThrow();
    expect(() => document.querySelector('#abA').click()).not.toThrow();
    expect(() => document.querySelector('#abB').click()).not.toThrow();
    expect(errors).toEqual([]);
  });

  it('has no duplicate element ids in the shipped markup', () => {
    const ids = [...document.querySelectorAll('[id]')].map((n) => n.id);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(duplicates).toEqual([]);
  });

  it('references only ids that exist from aria-controls and label/for', () => {
    loadShell();
    const missing = [];
    for (const node of document.querySelectorAll('[aria-controls]')) {
      const id = node.getAttribute('aria-controls');
      if (!document.getElementById(id)) missing.push(`aria-controls=${id}`);
    }
    for (const node of document.querySelectorAll('label[for]')) {
      const id = node.getAttribute('for');
      if (!document.getElementById(id)) missing.push(`label for=${id}`);
    }
    expect(missing).toEqual([]);
  });
});
