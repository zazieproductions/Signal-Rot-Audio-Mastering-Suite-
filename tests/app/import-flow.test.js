/**
 * @vitest-environment jsdom
 *
 * Bootstrap-level import flow: the real `bootstrap()`, the real `loadFile`,
 * the real drop-of-state wiring — with a fake decoder. This is the
 * "a bad file must refuse cleanly and a good file must load cleanly"
 * contract, exercised through the whole app rather than the isolated module.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FakeAudioContext } from '../helpers/fake-audio-context.js';
import { installFakeCanvas } from '../helpers/fake-canvas.js';

const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

function loadShell() {
  const body = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'));
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, '');
  document.documentElement.dataset.theme = 'dark';
}

/** Build a decodable "file" whose bytes carry the scenario markers. */
function audioFile(name, marker = 'ok') {
  const bytes = new TextEncoder().encode(marker);
  const file = new File([bytes], name, { type: 'audio/wav' });
  file.arrayBuffer = () => Promise.resolve(bytes.buffer.slice(0, bytes.byteLength));
  return file;
}

/** Fill a fake context's buffer with a 100 ms 440 Hz tone (mono on request). */
function fakeDecodedBuffer(ctx, bytes) {
  const text = new TextDecoder().decode(bytes);
  const mono = /mono/.test(text);
  const channels = mono ? 1 : 2;
  const length = 4800;
  const buf = ctx.createBuffer(channels, length, 48000);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < length; i++) ch[i] = 0.2 * Math.sin((2 * Math.PI * 440 * i) / 48000);
  return buf;
}

let boot;

beforeEach(async () => {
  vi.resetModules();
  loadShell();
  installFakeCanvas(window);

  const DecodeContext = class extends FakeAudioContext {
    decodeAudioData(bytes) {
      const text = new TextDecoder().decode(bytes);
      if (text.includes('BROKEN')) {
        return Promise.reject(new DOMException('bad data', 'EncodingError'));
      }
      if (text.includes('NOTSUPPORTED')) {
        return Promise.reject(new DOMException('no codec', 'NotSupportedError'));
      }
      return Promise.resolve(fakeDecodedBuffer(this, bytes));
    }
  };
  window.AudioContext = DecodeContext;
  window.OfflineAudioContext = class extends DecodeContext {
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
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  // Fresh module registry per test → fresh shared AudioContext singleton.
  boot = await import('../../src/app/bootstrap.js');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bootstrap import flow', () => {
  it('refuses a corrupted file with a specific message and leaves no source behind', async () => {
    const app = boot.bootstrap();
    const buffer = await app.loadFile(audioFile('broken.wav', 'BROKEN'));
    expect(buffer).toBeNull();
    expect(app.store.getState().source.buffer).toBeNull();
    const toast = document.querySelector('#toast').textContent;
    expect(toast).toMatch(/Could not decode/);
    expect(toast).toMatch(/truncated or corrupted/i);
    expect(document.querySelector('#transportFull').hidden).toBe(true);
  });

  it('refuses an unsupported codec with codec language, not a generic error', async () => {
    const app = boot.bootstrap();
    await app.loadFile(audioFile('weird.m4a', 'NOTSUPPORTED'));
    const toast = document.querySelector('#toast').textContent;
    expect(toast).toMatch(/not supported by this browser/i);
    expect(app.store.getState().source.buffer).toBeNull();
  });

  it('refuses an empty file before decoding', async () => {
    const app = boot.bootstrap();
    await app.loadFile(audioFile('empty.wav', ''));
    const toast = document.querySelector('#toast').textContent;
    expect(toast).toMatch(/empty \(0 bytes\)/);
    expect(app.store.getState().source.buffer).toBeNull();
  });

  it('loads a good file, labels it, and survives a later bad drop', async () => {
    const app = boot.bootstrap();
    const buffer = await app.loadFile(audioFile('good.wav'));
    expect(buffer).toBeTruthy();
    expect(app.store.getState().source.buffer).toBe(buffer);
    expect(document.querySelector('#transportFull').hidden).toBe(false);
    expect(document.querySelector('#fileName').textContent).toContain('good.wav');
    expect(document.querySelector('#fileName').textContent).toContain('2 ch');

    // A bad drop after a good load must not clobber the loaded source.
    await app.loadFile(audioFile('broken2.wav', 'BROKEN'));
    expect(app.store.getState().source.buffer).toBe(buffer);
    expect(document.querySelector('#transportFull').hidden).toBe(false);
  });

  it('shows explicit notes for mono input', async () => {
    const app = boot.bootstrap();
    await app.loadFile(audioFile('solo.wav', 'mono'));
    expect(app.store.getState().source.channels).toBe(1);
    const notes = document.querySelector('#sourceNotes');
    expect(notes.hidden).toBe(false);
    expect(notes.textContent).toMatch(/dual-mono routing/i);
  });

  it('clears notes when switching from mono to stereo', async () => {
    const app = boot.bootstrap();
    await app.loadFile(audioFile('solo.wav', 'mono'));
    expect(document.querySelector('#sourceNotes').hidden).toBe(false);
    await app.loadFile(audioFile('pair.wav'));
    expect(document.querySelector('#sourceNotes').hidden).toBe(true);
  });
});
