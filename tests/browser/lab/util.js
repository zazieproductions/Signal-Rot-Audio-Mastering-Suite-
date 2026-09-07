/**
 * Tiny Web Audio helpers that run *inside the browser*.
 * They never touch production DSP; they only drive native nodes and (when asked)
 * the production graph constructors imported by the harness.
 */

export function db(x) {
  return 20 * Math.log10(Math.max(1e-12, Math.abs(x)));
}

export function linear(dbfs) {
  return Math.pow(10, dbfs / 20);
}

export function mean(channel) {
  let s = 0;
  for (let i = 0; i < channel.length; i++) s += channel[i];
  return channel.length ? s / channel.length : 0;
}

export function rmsOf(channel) {
  let s = 0;
  for (let i = 0; i < channel.length; i++) s += channel[i] * channel[i];
  return Math.sqrt(s / Math.max(1, channel.length));
}

export function peakOf(channel) {
  let p = 0;
  for (let i = 0; i < channel.length; i++) {
    const a = Math.abs(channel[i]);
    if (a > p) p = a;
  }
  return p;
}

export function firstNonzero(channel, eps = 1e-5) {
  for (let i = 0; i < channel.length; i++) {
    if (Math.abs(channel[i]) > eps) return i;
  }
  return -1;
}

export function peakIndex(channel) {
  let p = 0;
  let idx = 0;
  for (let i = 0; i < channel.length; i++) {
    const a = Math.abs(channel[i]);
    if (a > p) {
      p = a;
      idx = i;
    }
  }
  return { index: idx, value: p };
}

export function isFiniteChannel(channel) {
  for (let i = 0; i < channel.length; i++) {
    if (!Number.isFinite(channel[i])) return false;
  }
  return true;
}

export function makeBuffer(ctx, channels, length, fill) {
  const buf = ctx.createBuffer(channels, length, ctx.sampleRate);
  for (let c = 0; c < channels; c++) {
    const d = buf.getChannelData(c);
    if (fill) {
      for (let i = 0; i < length; i++) d[i] = fill(i, c);
    }
  }
  return buf;
}

export function sineFill(sr, freq, amp, phase = 0) {
  return (i) => amp * Math.sin((2 * Math.PI * freq * i) / sr + phase);
}

export function impulseFill(at = 64, amp = 1) {
  return (i) => (i === at ? amp : 0);
}

export async function renderOffline(channels, length, sampleRate, build) {
  const Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Ctor) throw new Error('OfflineAudioContext is not available');
  const ctx = new Ctor(channels, Math.max(1, Math.ceil(length)), sampleRate);
  await build(ctx);
  return ctx.startRendering();
}

export async function renderSourceThrough(sourceBuffer, sampleRate, build) {
  const channels = sourceBuffer.numberOfChannels;
  const length = sourceBuffer.length;
  const sr = sampleRate || sourceBuffer.sampleRate;
  return renderOffline(channels, length, sr, async (ctx) => {
    const src = ctx.createBufferSource();
    // copy into a buffer owned by this context
    const buf = ctx.createBuffer(channels, length, sr);
    for (let c = 0; c < channels; c++) {
      const srcCh = sourceBuffer.getChannelData(c);
      const dst = buf.getChannelData(c);
      if (sr === sourceBuffer.sampleRate) dst.set(srcCh);
      else {
        // naive copy; callers should match rates
        dst.set(srcCh.subarray(0, Math.min(dst.length, srcCh.length)));
      }
    }
    src.buffer = buf;
    const out = await build(ctx, src);
    if (out) src.connect(out);
    src.start(0);
  });
}

export function snapshotBuffer(audioBuffer, stride = 1) {
  const channels = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    const src = audioBuffer.getChannelData(c);
    if (stride === 1) channels.push(Array.from(src));
    else {
      const out = [];
      for (let i = 0; i < src.length; i += stride) out.push(src[i]);
      channels.push(out);
    }
  }
  return {
    sampleRate: audioBuffer.sampleRate,
    length: audioBuffer.length,
    numberOfChannels: audioBuffer.numberOfChannels,
    channels,
  };
}

export function metricsOf(audioBuffer) {
  const per = [];
  let peak = 0;
  let sumSq = 0;
  let dcAbs = 0;
  let finite = true;
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    const ch = audioBuffer.getChannelData(c);
    const p = peakOf(ch);
    const r = rmsOf(ch);
    const d = mean(ch);
    peak = Math.max(peak, p);
    sumSq += r * r;
    dcAbs = Math.max(dcAbs, Math.abs(d));
    if (!isFiniteChannel(ch)) finite = false;
    per.push({
      index: c,
      peak: p,
      peakDb: db(p),
      rms: r,
      rmsDb: db(r * Math.SQRT2),
      dc: d,
      silent: p < 1e-9,
      firstNonzero: firstNonzero(ch),
    });
  }
  const rms = Math.sqrt(sumSq / Math.max(1, audioBuffer.numberOfChannels));
  return {
    sampleRate: audioBuffer.sampleRate,
    length: audioBuffer.length,
    channels: audioBuffer.numberOfChannels,
    peak,
    peakDb: db(peak),
    rms,
    rmsDb: db(rms * Math.SQRT2),
    dcAbs,
    finite,
    perChannel: per,
  };
}

export function probeRate(sampleRate) {
  const Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Ctor) return { ok: false, reason: 'no-offline-audio-context' };
  try {
    const probe = new Ctor(1, 1, sampleRate);
    return { ok: Boolean(probe) };
  } catch (error) {
    return { ok: false, reason: String(error && error.message ? error.message : error) };
  }
}

export const ua = () => {
  const u = navigator.userAgent;
  if (/Firefox\//.test(u)) return 'firefox';
  if (/Edg\//.test(u)) return 'chromium';
  if (/Chrome\//.test(u) || /Chromium\//.test(u)) return 'chromium';
  if (/Safari\//.test(u)) return 'webkit';
  return 'unknown';
};
