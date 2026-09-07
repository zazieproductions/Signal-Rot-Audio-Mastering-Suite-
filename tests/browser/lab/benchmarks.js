/**
 * Performance measurements. These do not optimise production code; they report
 * how long OfflineAudioContext renders take as channel count and sample rate grow.
 */

import { wavChannelOrder } from '../../../src/audio/immersive/layouts.js';
import { buildSpeakerFeeds } from '../../../src/audio/immersive/speaker-feeds.js';
import {
  buildMasteringChain,
  applyParameters,
} from '../../../src/audio/graph/build-mastering-chain.js';
import { defaultParameters } from '../../../src/app/parameters.js';
import { defaultImmersive } from '../../../src/app/state.js';
import { renderOffline, makeBuffer, ua } from './util.js';
import { BENCH_RATES } from '../../conformance/thresholds.js';

function memory() {
  const m = performance.memory;
  if (!m) return null;
  return {
    usedJSHeapBytes: m.usedJSHeapSize,
    totalJSHeapBytes: m.totalJSHeapSize,
    jsHeapLimitBytes: m.jsHeapSizeLimit,
  };
}

async function time(fn) {
  const mem0 = memory();
  const t0 = performance.now();
  const result = await fn();
  const ms = performance.now() - t0;
  const mem1 = memory();
  return { ms, mem0, mem1, result };
}

function fill(sr) {
  return (i, c) => {
    const t = i / sr;
    return (
      0.2 * Math.sin(2 * Math.PI * 110 * t) +
      0.12 * Math.sin(2 * Math.PI * (440 + c) * t) +
      0.06 * Math.sin(2 * Math.PI * 4000 * t)
    );
  };
}

async function stereoChain(sampleRate, seconds) {
  const length = Math.round(seconds * sampleRate);
  const parameters = defaultParameters();
  return renderOffline(2, length, sampleRate, (ctx) => {
    const src = ctx.createBufferSource();
    src.buffer = makeBuffer(ctx, 2, length, fill(sampleRate));
    const chain = buildMasteringChain(ctx, { textureSeed: parameters.textureSeed });
    applyParameters(chain, parameters, { audition: 'stereo' });
    src.connect(chain.input);
    chain.output.connect(ctx.destination);
    chain.start(0);
    src.start(0);
  });
}

async function layoutRender(layoutId, sampleRate, seconds) {
  const { order } = wavChannelOrder(layoutId);
  const nCh = order.length;
  const length = Math.round(seconds * sampleRate);
  const params = {
    centerExtract: defaultImmersive().centerExtract,
    surrLevelDb: defaultImmersive().surrLevelDb,
    surrDelayMs: defaultImmersive().surrDelayMs,
    heightLevelDb: defaultImmersive().heightLevelDb,
    heightDecorr: defaultImmersive().heightDecorr,
    lfeFreqHz: defaultImmersive().lfeFreqHz,
    lfeLevelDb: defaultImmersive().lfeLevelDb,
    frontRear: defaultImmersive().frontRear,
  };
  return renderOffline(nCh, length, sampleRate, (ctx) => {
    const src = ctx.createBufferSource();
    src.buffer = makeBuffer(ctx, 2, length, fill(sampleRate));
    const { feeds } = buildSpeakerFeeds(ctx, src, layoutId, params);
    const merger = ctx.createChannelMerger(nCh);
    order.forEach((key, index) => feeds[key].connect(merger, 0, index));
    merger.connect(ctx.destination);
    src.start(0);
  });
}

export async function runBenchmarks() {
  const browser = ua();
  const seconds = 0.4;
  const cases = [];

  for (const sampleRate of BENCH_RATES) {
    try {
      const { ms, mem0, mem1, result } = await time(() => stereoChain(sampleRate, seconds));
      cases.push({
        id: `stereo@${sampleRate}`,
        layout: 'stereo',
        channels: 2,
        sampleRate,
        seconds,
        renderMs: ms,
        realtimeRatio: ms / (seconds * 1000),
        outputFrames: result.length,
        outputBytes: result.length * result.numberOfChannels * 4,
        memory: mem1 && mem0 ? { usedDelta: mem1.usedJSHeapBytes - mem0.usedJSHeapBytes } : null,
        ok: true,
      });
    } catch (error) {
      cases.push({
        id: `stereo@${sampleRate}`,
        layout: 'stereo',
        sampleRate,
        ok: false,
        reason: String(error && error.message ? error.message : error),
      });
    }
  }

  const layouts = ['7.1.4', '9.1.6', 'soniclab'];
  const layoutRates = [48000, 96000];
  for (const layoutId of layouts) {
    for (const sampleRate of layoutRates) {
      try {
        const { ms, result } = await time(() => layoutRender(layoutId, sampleRate, seconds));
        cases.push({
          id: `${layoutId}@${sampleRate}`,
          layout: layoutId,
          channels: result.numberOfChannels,
          sampleRate,
          seconds,
          renderMs: ms,
          realtimeRatio: ms / (seconds * 1000),
          outputFrames: result.length,
          outputBytes: result.length * result.numberOfChannels * 4,
          ok: true,
        });
      } catch (error) {
        cases.push({
          id: `${layoutId}@${sampleRate}`,
          layout: layoutId,
          sampleRate,
          ok: false,
          reason: String(error && error.message ? error.message : error),
        });
      }
    }
  }

  const ok = cases.filter((c) => c.ok);
  const slowest = ok.slice().sort((a, b) => b.renderMs - a.renderMs)[0] ?? null;
  return {
    browser,
    seconds,
    cases,
    slowest,
    bottlenecks: ok
      .filter((c) => c.realtimeRatio > 1)
      .map((c) => `${c.id} ran ${c.realtimeRatio.toFixed(2)}× slower than realtime`),
  };
}
