/**
 * Shared harness bootstrap: install a real Web Audio engine for headless renders.
 *
 * Engine adaptation (NOT a Signal Rot bug): node-web-audio-api's WaveShaperNode allows
 * `curve` to be assigned exactly once, while the Web Audio IDL allows repeated assignment.
 * Signal Rot legitimately assigns at graph build (identity curve) and again when
 * parameters are applied (and often assigns the *same* identity array back). If we simply
 * forwarded every write the render would die; if we swallow the first we would silently
 * strip the shaper out and the whole saturation stage would sit 12 dB low with no curve.
 *
 * So: record every assignment, and flush the LAST one into the native node immediately
 * before `startRendering()` — which is exactly when the offline graph's static parameter
 * values are final. Rejected/unsynced writes are counted so a render can never quietly lose
 * its saturation, and `assertCurvesFlushed()` makes the harness fail loudly instead.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';

const repoRoot = '/home/user/Signal-Rot-Audio-Mastering-Suite-';
const require = createRequire(join(repoRoot, 'noop.js'));
const waa = require('node-web-audio-api');

const state = { pending: [], stats: { recorded: 0, flushed: 0, noop: 0 } };

function patchContext(ctx) {
  const orig = ctx.createWaveShaper.bind(ctx);
  ctx.createWaveShaper = () => {
    const node = orig();
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'curve');
    if (!d || !d.set) return node;
    const rec = { node, set: d.set, value: undefined, written: false };
    state.pending.push(rec);
    Object.defineProperty(node, 'curve', {
      configurable: true,
      enumerable: true,
      get: () => rec.value,
      set(v) {
        rec.value = v;
        rec.written = true;
        state.stats.recorded++;
      },
    });
    return node;
  };
  const origRender = ctx.startRendering.bind(ctx);
  ctx.startRendering = async () => {
    for (const rec of state.pending) {
      if (!rec.written) continue;
      try {
        rec.set.call(rec.node, rec.value);
        state.stats.flushed++;
      } catch {
        state.stats.noop++;
      }
    }
    state.pending = [];
    return origRender();
  };
  return ctx;
}

export class QaOfflineAudioContext extends waa.OfflineAudioContext {
  constructor(channels, length, sampleRate) {
    super(channels, length, sampleRate);
    patchContext(this);
  }
}

export function installWebAudio() {
  globalThis.window = globalThis;
  globalThis.OfflineAudioContext = QaOfflineAudioContext;
  globalThis.AudioContext = waa.AudioContext;
  globalThis.AudioBuffer = waa.AudioBuffer;
  if (!globalThis.document) {
    globalThis.document = { createElement: () => ({ canPlayType: () => '' }) };
  }
  return { waa, stats: state.stats };
}

/** Every WaveShaper that had a curve assigned must have had it flushed. */
export function assertCurvesFlushed() {
  if (state.stats.noop) {
    throw new Error(
      `harness: ${state.stats.noop} waveshaper curve writes were rejected — results invalid`,
    );
  }
  return { ...state.stats };
}

export async function readWav(path) {
  const { readFileSync } = await import('node:fs');
  const buf = Buffer.from(readFileSync(path));
  let off = 12;
  let fmt = null;
  let dataOff = -1;
  let dataSize = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataOff = body;
      dataSize = Math.min(size, buf.length - body);
    }
    off = body + size + (size % 2);
  }
  if (!fmt || dataOff < 0) throw new Error('unparseable wav: ' + path);
  const per = fmt.bits / 8;
  const frames = Math.floor(dataSize / (per * fmt.channels));
  const chans = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.channels; c++) {
      const p = dataOff + (i * fmt.channels + c) * per;
      let v = 0;
      if (fmt.format === 3 && fmt.bits === 32) v = buf.readFloatLE(p);
      else if (fmt.format === 3 && fmt.bits === 64) v = buf.readDoubleLE(p);
      else if (fmt.bits === 16) v = buf.readInt16LE(p) / 32768;
      else if (fmt.bits === 24) {
        let n = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
        if (n & 0x800000) n |= ~0xffffff;
        v = n / 8388608;
      } else if (fmt.bits === 32) v = buf.readInt32LE(p) / 2147483648;
      else throw new Error('unsupported wav format ' + fmt.format + '/' + fmt.bits);
      chans[c][i] = v;
    }
  }
  return { sampleRate: fmt.sampleRate, channels: chans };
}

export { waa };
