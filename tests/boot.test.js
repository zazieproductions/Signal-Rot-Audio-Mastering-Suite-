import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { state, canUndo } from '../src/app/state.js';

/**
 * Boot smoke test: verifies the application initializes against the real index.html
 * without throwing, in a DOM environment. Web Audio is stubbed — this test covers the
 * UI wiring and state bootstrapping, not the audio graph (which needs a real browser).
 */

let window;
let document;

beforeAll(async () => {
  const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  window = dom.window;
  document = dom.window.document;

  // Expose DOM globals used by the modules.
  globalThis.window = window;
  globalThis.document = document;
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: window.localStorage, configurable: true });
  globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  globalThis.devicePixelRatio = 1;
  // Worker + Web Audio stubs (the boot path must not require a real context).
  globalThis.Worker = class WorkerStub {
    constructor() {
      this.onmessage = null;
    }
    postMessage() {
      /* no-op */
    }
  };
  globalThis.AudioContext = class AudioContextStub {};
  globalThis.OfflineAudioContext = class OfflineAudioContextStub {};

  await import('../src/main.js');
  // Give the rAF-driven boot a tick.
  await new Promise((r) => setTimeout(r, 20));
});

describe('application boot', () => {
  it('renders the preset catalog', () => {
    const cards = document.querySelectorAll('.preset');
    expect(cards.length).toBeGreaterThan(30);
  });

  it('renders the signal-flow module list with bypass toggles', () => {
    const flowRows = document.querySelectorAll('#flowModules .flowrow');
    expect(flowRows.length).toBe(8);
    expect(document.querySelectorAll('#flowModules .tog[data-bind]').length).toBe(8);
  });

  it('initializes the transport and controls', () => {
    expect(document.querySelector('#playBtn')).toBeTruthy();
    expect(document.querySelector('#rTarget').value).toBe('-14');
    expect(document.querySelector('#ceiling').value).toBe('-0.1');
  });

  it('marks no preset as active on a flat default state', () => {
    const active = document.querySelectorAll('.preset.on');
    expect(active.length).toBe(0);
  });

  it('applies a preset on click and marks it active', () => {
    const btn = document.querySelector('.preset[data-name="Analog Womb"]');
    btn.click();
    expect(state.preset).toBe('Analog Womb');
    expect(state.P.tape).toBeGreaterThan(0);
    expect(document.querySelector('.preset.on')?.dataset.name).toBe('Analog Womb');
  });

  it('toggles a module bypass and records undo history', () => {
    const before = state.P.bypassEq;
    document.querySelector('#flowModules .tog[data-bind="bypassEq"]').click();
    expect(state.P.bypassEq).toBe(!before);
    expect(canUndo()).toBe(true);
  });

  it('toggles the light theme', () => {
    document.querySelector('#theme').click();
    expect(document.documentElement.dataset.theme).toBe('light');
    document.querySelector('#theme').click();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('switches monitor matrix buttons', () => {
    document.querySelector('#monMono').click();
    expect(state.P.monitorMode).toBe('mono');
    document.querySelector('#monStereo').click();
    expect(state.P.monitorMode).toBe('stereo');
  });
});
