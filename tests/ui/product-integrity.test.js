/**
 * @vitest-environment jsdom
 *
 * Product-integrity contracts — the seams between subsystems.
 *
 * These tests pin the behaviour that each module can get "individually right" but the
 * product can still get wrong: stale analysis bleeding into a new file, the export
 * summary describing a different file than the exporter writes, duplicate keyboard
 * listeners double-firing or fighting over one control, and render state surviving a
 * file swap. If one of these fails, two agents' work is contradicting the other's.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FakeAudioContext } from '../helpers/fake-audio-context.js';
import { installFakeCanvas } from '../helpers/fake-canvas.js';

const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

function makeFakeBuffer() {
  const length = 24000; // 0.5 s @ 48 kHz
  const data = [new Float32Array(length), new Float32Array(length)];
  return {
    numberOfChannels: 2,
    length,
    sampleRate: 48000,
    duration: 0.5,
    getChannelData: (c) => data[c],
    copyToChannel: (src, c) => data[c].set(src),
  };
}

function loadShell() {
  const body = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'));
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, '');
  document.documentElement.dataset.theme = 'dark';
}

function keyEvent(key) {
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));
}

const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms));

let bootCount = 0;

beforeEach(() => {
  loadShell();
  installFakeCanvas(window);
  window.localStorage.clear();
  // Unique-ish module import per test is not possible with vitest's registry cache, so
  // each test shares this stub; decode always yields a fresh silent stereo buffer.
  class StubAudioContext extends FakeAudioContext {
    decodeAudioData() {
      return Promise.resolve(makeFakeBuffer());
    }
  }
  window.AudioContext = StubAudioContext;
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
  window.URL.createObjectURL = () => `blob:fake-${++bootCount}`;
  window.URL.revokeObjectURL = () => {};
  window.requestAnimationFrame = () => 1;
  window.cancelAnimationFrame = () => {};
  window.matchMedia = (q) => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    media: q,
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

async function bootApp() {
  const { bootstrap } = await import('../../src/app/bootstrap.js');
  return bootstrap();
}

describe('staleness: old work must never mutate new user state', () => {
  it('replacing the file wipes analysis, match result and match strength', async () => {
    const app = await bootApp();
    const { store } = app;
    // Seed "previous file" measurements and a loudness-matched monitor state.
    store.setAnalysis({
      original: { integrated: -12, lra: 5 },
      processed: { integrated: -9.1, lra: 5, peaks: { truePeakDb: -0.5 } },
      match: { confidence: 0.9, gainsDb: new Array(24).fill(1) },
    });
    store.setParameter('matchStrength', 65, { history: false });
    store.setUi({ abMode: 'C' });
    document.querySelector('#mLUFS').textContent = '-9.1';

    await app.loadFile({
      name: 'next-take.wav',
      size: 4096,
      arrayBuffer: async () => new ArrayBuffer(16),
    });
    await flush();

    const s = store.getState();
    // The previous file's numbers are gone. A FRESH pass for the new file may have
    // landed already (that's fine); nothing on screen may still belong to the old file.
    if (s.analysis.original) expect(s.analysis.original.integrated).not.toBe(-12);
    if (s.analysis.processed) expect(s.analysis.processed.integrated).not.toBe(-9.1);
    expect(s.analysis.match).toBeNull(); // match only ever comes from an explicit Match
    // A curve measured on the previous source is not a correction for this one: strength
    // must not silently keep applying it.
    expect(store.getParameters().matchStrength).toBe(0);
    // And the meters must not keep showing the previous file's numbers as current truth.
    expect(document.querySelector('#mLUFS').textContent).toBe('—');
  });

  it('a file swap mid-analysis leaves coherent state and no zombie running flag', async () => {
    const app = await bootApp();
    const { store } = app;
    await app.loadFile({ name: 'a.wav', size: 4096, arrayBuffer: async () => new ArrayBuffer(16) });
    expect(store.getState().source.name).toBe('a.wav');
    // Immediately swap; the scheduler generation + staleness barrier own the in-flight work.
    await app.loadFile({ name: 'b.wav', size: 4096, arrayBuffer: async () => new ArrayBuffer(16) });
    await flush(150);
    expect(store.getState().source.name).toBe('b.wav');
    // Whatever happened to the two passes, the UI must not be stuck claiming work that
    // is no longer in flight, and there must be no half-applied crash state.
    expect(['boolean']).toContain(typeof store.getState().analysis.running);
    expect(store.getState().analysis.running).toBe(false);
  });
});

describe('export settings have one source of truth', () => {
  it('the format dropdown writes the store and the summary follows it', async () => {
    const app = await bootApp();
    const { store } = app;
    store.setSource({
      buffer: makeFakeBuffer(),
      name: 'track.wav',
      durationSeconds: 0.5,
      sampleRate: 48000,
      channels: 2,
    });
    const fmt = document.querySelector('#fmtSelect');
    fmt.value = 'mp3';
    fmt.dispatchEvent(new window.Event('change', { bubbles: true }));
    await flush(10);
    expect(store.getState().ui.exportFormat).toBe('mp3');
    const summary = document.querySelector('#exportSummary').textContent;
    expect(summary).toContain('MP3');
    expect(summary).not.toContain('24-bit');
  });

  it('quick-export buttons leave the store, the selects and the summary agreed', async () => {
    const app = await bootApp();
    const { store } = app;
    store.setSource({
      buffer: makeFakeBuffer(),
      name: 'track.wav',
      durationSeconds: 0.5,
      sampleRate: 48000,
      channels: 2,
    });
    const btn = document.querySelector('.expbtn[data-fmt="wav16"]');
    btn.click();
    await flush(10);
    expect(store.getState().ui.exportFormat).toBe('wav16');
    expect(store.getState().ui.exportSampleRate).toBe(44100);
    expect(document.querySelector('#fmtSelect').value).toBe('wav16');
    expect(document.querySelector('#srSelect').value).toBe('44100');
    expect(document.querySelector('#exportSummary').textContent).toContain('WAV 16-bit');
  });

  it('the summary never claims the stereo button exports an immersive bed', async () => {
    const app = await bootApp();
    const { store } = app;
    store.setSource({
      buffer: makeFakeBuffer(),
      name: 'track.wav',
      durationSeconds: 0.5,
      sampleRate: 48000,
      channels: 2,
    });
    store.setImmersive({ layout: '7.1.4', target: 'adm' });
    await flush(10);
    const text = document.querySelector('#exportSummary').textContent;
    expect(text).toContain('stereo master');
    expect(text).toContain('7.1.4');
    expect(text).toContain('Immersive tab');
    // The headline of the card — the one users read as "what happens when I click
    // Export" — must never name an immersive deliverable.
    const title = document.querySelector('#exportSummary .export-summary-hd .title').textContent;
    expect(title).toContain('stereo master');
    expect(title).not.toMatch(/ADM|multichannel|binaural/i);
  });

  it('an autosaved session restores BOTH export selects from the store', async () => {
    // Simulate a prior session that chose AIFF 24-bit @ 96 kHz.
    window.localStorage.setItem(
      'signal-rot:session:v3',
      JSON.stringify({
        schemaVersion: 3,
        savedAt: new Date().toISOString(),
        parameters: null,
        immersive: null,
        ui: { exportFormat: 'aif24', exportSampleRate: 96000 },
      }),
    );
    const app = await bootApp();
    expect(document.querySelector('#fmtSelect').value).toBe('aif24');
    expect(document.querySelector('#srSelect').value).toBe('96000');
    expect(app.store.getState().ui.exportFormat).toBe('aif24');
    // And the summary agrees with what the exporter will do.
    expect(document.querySelector('#exportSummary').hidden).toBe(true); // no file yet — honest
  });
});

describe('keyboard: one key, one owner, one action per press', () => {
  it('X advances A/B/C exactly one step per press', async () => {
    const app = await bootApp();
    const { store } = app;
    store.setUi({ abMode: 'A' });
    keyEvent('x');
    expect(store.getState().ui.abMode).toBe('B');
    keyEvent('x');
    expect(store.getState().ui.abMode).toBe('C');
    keyEvent('x');
    expect(store.getState().ui.abMode).toBe('A');
  });

  it('A / B / C keys select the audition mode directly', async () => {
    const app = await bootApp();
    const { store } = app;
    keyEvent('c');
    expect(store.getState().ui.abMode).toBe('C');
    keyEvent('a');
    expect(store.getState().ui.abMode).toBe('A');
    keyEvent('b');
    expect(store.getState().ui.abMode).toBe('B');
  });

  it('M toggles loudness-match and does NOT hijack the workspace or the audition', async () => {
    const app = await bootApp();
    const { store } = app;
    store.setUi({ workspace: 'spatial', audition: 'side', abMode: 'B' });
    keyEvent('m');
    expect(store.getState().ui.matchLoudness).toBe(true);
    keyEvent('m');
    expect(store.getState().ui.matchLoudness).toBe(false);
    expect(store.getState().ui.workspace).toBe('spatial');
    expect(store.getState().ui.audition).toBe('side');
  });

  it('L toggles the workspace once per press', async () => {
    const app = await bootApp();
    const { store } = app;
    expect(store.getState().ui.workspace).toBe('master');
    keyEvent('l');
    expect(store.getState().ui.workspace).toBe('spatial');
    keyEvent('l');
    expect(store.getState().ui.workspace).toBe('master');
  });

  it('blind mode alternates between two DIFFERENT hidden signals', async () => {
    const app = await bootApp();
    const { store } = app;
    document.querySelector('#abBlindenh').click();
    const seen = new Set([store.getState().ui.abMode]);
    keyEvent('x');
    seen.add(store.getState().ui.abMode);
    keyEvent('x');
    seen.add(store.getState().ui.abMode);
    expect([...seen].every((m) => m === 'A' || m === 'B')).toBe(true);
    expect(seen.size).toBe(2);
  });

  it('keyboard A/B/C do not fire while typing in the palette or a text field', async () => {
    const app = await bootApp();
    const { store } = app;
    store.setUi({ abMode: 'A' });
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.focus();
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'b', bubbles: true }));
    expect(store.getState().ui.abMode).toBe('A');
  });
});

describe('render coordination', () => {
  it('one render lock is shared, and the `rendering` store flag mirrors it exactly', async () => {
    const { createExportController } = await import('../../src/app/export-controller.js');
    const { createStore } = await import('../../src/app/state.js');
    const store = createStore();
    // A single controller instance is the lock — exactly how bootstrap wires the stereo
    // exporter and the immersive workspace. A second acquisition must be refused, not
    // queued, and must not start a second render.
    const controller = createExportController({ store, toast: () => {}, announce: () => {} });
    expect(controller.tryLock('stereo render')).toBe(true);
    expect(store.getState().ui.rendering).toBe(true);
    expect(controller.tryLock('immersive render')).toBe(false);
    controller.unlock();
    expect(store.getState().ui.rendering).toBe(false);
    expect(controller.tryLock('immersive render')).toBe(true);
    controller.unlock();
  });

  it('the immersive workspace respects the lock and says so instead of rendering', async () => {
    const { createImmersiveController } = await import('../../src/app/immersive-controller.js');
    const { createStore } = await import('../../src/app/state.js');
    const store = createStore();
    store.setSource({
      buffer: makeFakeBuffer(),
      name: 'track.wav',
      durationSeconds: 0.5,
      sampleRate: 48000,
      channels: 2,
    });
    store.setImmersive({ layout: '7.1.4' });
    const toasts = [];
    const im = createImmersiveController({
      store,
      toast: (m) => toasts.push(m),
      getLiveGraph: () => null,
      lock: () => false, // someone else is rendering
      unlock: () => {},
    });
    await im.renderImmersive();
    expect(toasts.some((t) => /Another render is in progress/.test(t))).toBe(true);
    expect(store.getState().ui.rendering).toBe(false); // refused cleanly, not half-started
  });
});

describe('honest capabilities: spatial lab', () => {
  it('map highlight copy no longer promises audible solo', async () => {
    await bootApp();
    expect(document.querySelector('#spatialMapHint').textContent).toContain('not available yet');
    expect(document.querySelector('#spatialGroupStrip').getAttribute('aria-label')).toContain(
      'highlight',
    );
    const motionCard = document.querySelector('#spatialMotionViz');
    expect(motionCard.closest('.card').textContent).toContain('static bed');
  });

  it('listener orientation dial reaches the shared store state', async () => {
    const app = await bootApp();
    const btn = document.querySelector('.orient-btn[data-yaw="90"]');
    btn.click();
    expect(app.store.getState().ui.listenerYaw).toBe(90);
  });
});
