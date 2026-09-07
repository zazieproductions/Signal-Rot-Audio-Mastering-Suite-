#!/usr/bin/env node
/**
 * Immersive bed render (no browser needed): replicates `immersive-controller.js`'s offline
 * path — master stereo buffer → buildSpeakerFeeds → channel merger in the layout's WAV order
 * → true-peak limit — and writes the multichannel file out for measurement.
 *
 *   node qa/scripts/immersive.mjs --in out/refhd__rock.wav --layouts 5.1,7.1.4,7.1.2 --out /home/user/qa/out6
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { installWebAudio, readWav, assertCurvesFlushed } from './engine.mjs';

const repoRoot = '/home/user/Signal-Rot-Audio-Mastering-Suite-';
installWebAudio();

const { buildSpeakerFeeds } = await import(join(repoRoot, 'src/audio/immersive/speaker-feeds.js'));
const { channelCount, lfeChannelIndices, wavChannelOrder, LAYOUTS } = await import(
  join(repoRoot, 'src/audio/immersive/layouts.js')
);
const { limitTruePeak } = await import(join(repoRoot, 'src/audio/render/limiter.js'));
const { writeWav } = await import(join(repoRoot, 'src/audio/encode/wav.js'));
const { defaultImmersive } = await import(join(repoRoot, 'src/app/state.js'));

const argv = process.argv.slice(2);
const arg = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const inFile = arg('--in', '/home/user/qa/out/refhd__rock.wav');
const layouts = arg('--layouts', '5.1,7.1,7.1.2,7.1.4,9.1.6,Sonic Lab 20.4').split(',');
const outDir = arg('--out', '/home/user/qa/out6');
mkdirSync(outDir, { recursive: true });

const params = { ...(defaultImmersive ? defaultImmersive() : {}) };
console.log('upmix parameters used:', JSON.stringify(params));

const wav = await readWav(inFile);
const probe = new globalThis.OfflineAudioContext(1, 1, wav.sampleRate);
const source = probe.createBuffer(wav.channels.length, wav.channels[0].length, wav.sampleRate);
for (let c = 0; c < wav.channels.length; c++) source.copyToChannel(wav.channels[c], c);
if (source.numberOfChannels === 1) {
  // feeds expect a 2-channel source
  const s2 = probe.createBuffer(2, source.length, source.sampleRate);
  s2.copyToChannel(source.getChannelData(0), 0);
  s2.copyToChannel(source.getChannelData(0), 1);
  source.copyFromChannel && 0;
}

const results = [];
for (const layoutId of layouts) {
  const key = LAYOUTS[layoutId]
    ? layoutId
    : Object.keys(LAYOUTS).find((k) => k.toLowerCase().includes(layoutId.toLowerCase()));
  if (!key) {
    console.log(`${layoutId.padEnd(16)} UNKNOWN LAYOUT (have: ${Object.keys(LAYOUTS).join(', ')})`);
    continue;
  }
  const n = channelCount(key);
  const { order, mask, standard } = wavChannelOrder(key);
  const ctx = new globalThis.OfflineAudioContext(n, source.length, source.sampleRate);
  const src = ctx.createBufferSource();
  const feedSource = ctx.createBuffer(2, source.length, source.sampleRate);
  for (let c = 0; c < 2; c++)
    feedSource.copyToChannel(
      c < source.numberOfChannels ? source.getChannelData(c) : source.getChannelData(0),
      c,
    );
  src.buffer = feedSource;
  const { feeds } = buildSpeakerFeeds(ctx, src, key, params);
  const merger = ctx.createChannelMerger(n);
  const missing = [];
  order.forEach((k, index) => {
    if (feeds[k]) feeds[k].connect(merger, 0, index);
    else missing.push(k);
  });
  merger.connect(ctx.destination);
  src.start(0);
  const rendered = await ctx.startRendering();
  const data = {
    sampleRate: rendered.sampleRate,
    length: rendered.length,
    channels: Array.from({ length: n }, (_, c) => rendered.getChannelData(c)),
  };
  limitTruePeak(data, { ceilingDb: -1.5, lfeChannels: lfeChannelIndices(key, order) });
  const blob = writeWav(data, { bitDepth: 24 });
  const outPath = join(outDir, `imm_${key.replace(/[^0-9A-Za-z.]/g, '')}.wav`);
  writeFileSync(outPath, Buffer.from(await blob.arrayBuffer()));
  results.push({ layout: key, order, missing, out: outPath, channels: n });
  console.log(
    `${key.padEnd(14)} ch=${n} std=${standard} mask=0x${mask.toString(16)} order=${order.join(',')} missingFeeds=[${missing.join(',')}] → ${outPath}`,
  );
}
writeFileSync(join(outDir, 'immersive.json'), JSON.stringify(results, null, 1));
console.log('curve writes:', JSON.stringify(assertCurvesFlushed()));
