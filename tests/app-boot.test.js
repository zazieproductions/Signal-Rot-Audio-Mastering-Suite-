/**
 * Application smoke test.
 *
 * Loads the real index.html into jsdom and executes the built bundle against
 * it. This is deliberately not a DSP test — it exists to catch the class of
 * regression that unit tests cannot see: a selector that no longer matches, an
 * element renamed in the markup, a module import that fails, or a top-level
 * statement that throws and leaves the whole UI dead.
 *
 * The suite builds the app first (via Vite) so the test exercises the same
 * bundle users load.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal Web Audio stand-in: enough for the app to construct its graph. */
function installWebAudioStubs(window) {
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} });
  const makeNode = () => ({
    connect() {
      return makeNode();
    },
    disconnect() {},
    start() {},
    stop() {},
    gain: param(),
    frequency: param(),
    Q: param(),
    delayTime: param(),
    threshold: param(),
    knee: param(),
    ratio: param(),
    attack: param(),
    release: param(),
    positionX: param(),
    positionY: param(),
    positionZ: param(),
    pan: param(),
    curve: null,
    type: '',
    oversample: '',
    fftSize: 2048,
    smoothingTimeConstant: 0,
    frequencyBinCount: 1024,
    panningModel: '',
    distanceModel: '',
    maxDistance: 1,
    buffer: null,
    loop: false,
    getFloatTimeDomainData() {},
    getByteFrequencyData() {},
    getFloatFrequencyData() {},
  });

  class FakeAudioContext {
    constructor() {
      this.sampleRate = 48000;
      this.currentTime = 0;
      this.state = 'running';
      this.destination = makeNode();
    }
    resume() {
      return Promise.resolve();
    }
    createBuffer(ch, len, sr) {
      const data = Array.from({ length: ch }, () => new Float32Array(len));
      return {
        numberOfChannels: ch,
        length: len,
        sampleRate: sr,
        duration: len / sr,
        getChannelData: (i) => data[i],
      };
    }
  }
  for (const name of [
    'createGain', 'createBiquadFilter', 'createChannelSplitter', 'createChannelMerger',
    'createDelay', 'createOscillator', 'createWaveShaper', 'createDynamicsCompressor',
    'createAnalyser', 'createBufferSource', 'createPanner', 'createStereoPanner',
    'createConvolver',
  ]) {
    FakeAudioContext.prototype[name] = makeNode;
  }

  window.AudioContext = FakeAudioContext;
  window.OfflineAudioContext = FakeAudioContext;
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
  window.HTMLCanvasElement.prototype.getContext = () => ({
    scale() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    fill() {}, fillRect() {}, arc() {}, closePath() {}, fillText() {}, save() {},
    restore() {}, setTransform() {}, translate() {}, rotate() {}, createLinearGradient: () => ({
      addColorStop() {},
    }),
    set fillStyle(_v) {}, get fillStyle() { return '#000'; },
    set strokeStyle(_v) {}, get strokeStyle() { return '#000'; },
    set lineWidth(_v) {}, get lineWidth() { return 1; },
    set globalAlpha(_v) {}, get globalAlpha() { return 1; },
    set font(_v) {}, get font() { return ''; },
  });
}

let dom;
let errors;

beforeAll(() => {
  const distIndex = resolve(root, 'dist/index.html');
  if (!existsSync(distIndex)) {
    execSync('npx vite build', { cwd: root, stdio: 'pipe' });
  }

  const html = readFileSync(distIndex, 'utf8');
  // Resolve the hashed bundle names Vite emitted.
  const jsMatch = html.match(/src="\/(assets\/[^"]+\.js)"/);
  const bundle = readFileSync(resolve(root, 'dist', jsMatch[1]), 'utf8');

  errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));

  dom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'http://localhost/',
    virtualConsole,
  });

  installWebAudioStubs(dom.window);
  dom.window.addEventListener('error', (e) => errors.push(e.error || e.message));

  // Execute the bundle as a classic script; the module bundle is self-contained.
  dom.window.eval(bundle);
});

describe('application boot', () => {
  it('executes the bundle without throwing', () => {
    expect(errors).toEqual([]);
  });

  it('renders the preset catalogue into the DOM', () => {
    const presets = dom.window.document.querySelectorAll('.preset');
    expect(presets.length).toBeGreaterThan(30);
    // Every preset card should carry the name the click handler dispatches on.
    for (const p of presets) expect(p.dataset.name).toBeTruthy();
  });

  it('wires up the tab strip', () => {
    const { document } = dom.window;
    const tabs = [...document.querySelectorAll('.tab')];
    expect(tabs.length).toBeGreaterThan(1);
    const target = tabs.find((t) => !t.classList.contains('on'));
    target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(target.classList.contains('on')).toBe(true);
    const panel = document.querySelector(`.tpanel[data-tab="${target.dataset.tab}"]`);
    expect(panel.classList.contains('on')).toBe(true);
  });

  it('exposes every control the script binds to', () => {
    // A missing element here means a silent TypeError at boot in a real browser.
    const required = [
      '#toast', '#playBtn', '#stopBtn', '#fileInput', '#dropzone', '#importBtn',
      '#fmt', '#srOut', '#dither', '#exportBtn', '#batchAdd', '#batchRun',
      '#savePreset', '#loadPreset', '#theme', '#imLayout', '#imTarget', '#imExport',
      '#mLUFS', '#mLRA', '#mTP', '#mCorr', '#wave', '#dlAnchor',
    ];
    for (const sel of required) {
      expect(dom.window.document.querySelector(sel), `missing ${sel}`).not.toBeNull();
    }
  });

  it('offers the dither modes the encoder understands', () => {
    const opts = [...dom.window.document.querySelectorAll('#dither option')].map((o) => o.value);
    expect(opts.sort()).toEqual(['none', 'shaped', 'tpdf']);
  });

  it('applies a preset without error and marks it active', () => {
    const { document } = dom.window;
    const card = document.querySelector('.preset[data-name="Cobalt"]');
    expect(card).not.toBeNull();
    card.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(card.classList.contains('on')).toBe(true);
    expect(errors).toEqual([]);
  });

  it('toggles the theme', () => {
    const { document } = dom.window;
    const before = document.documentElement.dataset.theme;
    document.querySelector('#theme').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(document.documentElement.dataset.theme).not.toBe(before);
  });

  it('lists every immersive layout the renderer supports', () => {
    const opts = [...dom.window.document.querySelectorAll('#imLayout option')].map((o) => o.value);
    for (const layout of ['5.1', '7.1', '7.1.2', '7.1.4', '9.1.6', 'soniclab']) {
      expect(opts, `layout ${layout} missing from the UI`).toContain(layout);
    }
  });
});
