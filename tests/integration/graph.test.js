import { describe, it, expect } from 'vitest';
import { FakeAudioContext, nodesOfType, isConnected } from '../helpers/fake-audio-context.js';
import {
  buildMasteringChain,
  applyParameters,
  readGainReduction,
} from '../../src/audio/graph/build-mastering-chain.js';
import { buildSpeakerFeeds } from '../../src/audio/immersive/speaker-feeds.js';
import { buildBinauralFold, placePanner } from '../../src/audio/immersive/binaural.js';
import { LAYOUTS, LAYOUT_IDS, SPEAKERS } from '../../src/audio/immersive/layouts.js';
import { defaultParameters } from '../../src/app/parameters.js';
import { MATCH_FREQS } from '../../src/app/constants.js';
import { expandCatalogPreset } from '../../src/app/presets-io.js';
import { ALL_PRESETS } from '../../src/presets/index.js';

const params = (patch = {}) => ({ ...defaultParameters(), ...patch });

describe('mastering chain construction', () => {
  it('wires input to output through every stage', () => {
    const ctx = new FakeAudioContext();
    const chain = buildMasteringChain(ctx);
    expect(isConnected(chain.input, chain.output)).toBe(true);
    expect(isConnected(chain.input, chain.tone.input)).toBe(true);
    expect(isConnected(chain.tone.output, chain.multiband.input)).toBe(true);
    expect(isConnected(chain.multiband.output, chain.stereo.input)).toBe(true);
    expect(isConnected(chain.stereo.output, chain.character.input)).toBe(true);
    expect(isConnected(chain.character.output, chain.depth.input)).toBe(true);
    expect(isConnected(chain.depth.output, chain.saturation.input)).toBe(true);
    expect(isConnected(chain.saturation.output, chain.output)).toBe(true);
  });

  it('builds one match band per analysis frequency, in series and flat', () => {
    const ctx = new FakeAudioContext();
    const chain = buildMasteringChain(ctx);
    expect(chain.matchBands).toHaveLength(MATCH_FREQS.length);
    chain.matchBands.forEach((band, i) => {
      expect(band.type).toBe('peaking');
      expect(band.frequency.value).toBe(MATCH_FREQS[i]);
      expect(band.gain.value).toBe(0);
      if (i < chain.matchBands.length - 1) {
        expect(isConnected(band, chain.matchBands[i + 1])).toBe(true);
      }
    });
  });

  it('gives the saturation make-up gain its own node, separate from the chain output', () => {
    // The pre-7.0 bug: `outGain` carried both the saturation make-up and the preview
    // normalisation gain, and the second write destroyed the first — so the preview was
    // up to 1.9 dB quieter than the export at full saturation.
    const ctx = new FakeAudioContext();
    const chain = buildMasteringChain(ctx);
    expect(chain.saturation.makeup).toBeTruthy();
    expect(chain.saturation.makeup).not.toBe(chain.output);
    applyParameters(chain, params({ sat: 100 }));
    expect(chain.saturation.makeup.gain.value).toBeCloseTo(1.25, 6);
    expect(chain.output.gain.value).toBe(1);
  });

  it('starts every generator exactly once and stops them on dispose', () => {
    const ctx = new FakeAudioContext();
    const chain = buildMasteringChain(ctx);
    chain.start(0);
    const oscillators = nodesOfType(ctx, 'oscillator');
    const sources = nodesOfType(ctx, 'buffersource');
    expect(oscillators.length).toBe(3); // wow, flutter, drift
    expect(sources.length).toBe(3); // hiss, crackle, rumble
    for (const node of [...oscillators, ...sources]) expect(node.started).toBe(true);
    chain.dispose();
    for (const node of [...oscillators, ...sources]) expect(node.stopped).toBe(true);
  });

  it('is idempotent when start is called twice', () => {
    const ctx = new FakeAudioContext();
    const chain = buildMasteringChain(ctx);
    chain.start(0);
    expect(() => chain.start(0)).not.toThrow();
  });
});

describe('parameter application', () => {
  it('sets the tone filters from the schema-declared frequencies', () => {
    const ctx = new FakeAudioContext();
    const chain = buildMasteringChain(ctx);
    applyParameters(chain, params({ warm: 3, body: -2, air: 1.5 }));
    expect(chain.tone.bands.warm.frequency.value).toBe(120);
    expect(chain.tone.bands.warm.gain.value).toBe(3);
    expect(chain.tone.bands.body.frequency.value).toBe(350);
    expect(chain.tone.bands.body.gain.value).toBe(-2);
    expect(chain.tone.bands.air.frequency.value).toBe(12000);
    expect(chain.tone.bands.air.gain.value).toBe(1.5);
  });

  it('hinges the tilt shelves in opposite directions', () => {
    const ctx = new FakeAudioContext();
    const chain = buildMasteringChain(ctx);
    applyParameters(chain, params({ tilt: 2 }));
    expect(chain.tone.tiltLow.gain.value).toBe(-2);
    expect(chain.tone.tiltHigh.gain.value).toBe(2);
    expect(chain.tone.tiltLow.frequency.value).toBe(1000);
  });

  it('maps multiband amount onto threshold and ratio', () => {
    const ctx = new FakeAudioContext();
    const chain = buildMasteringChain(ctx);
    applyParameters(chain, params({ mbLow: 50, mbMid: 0, mbHigh: 100 }));
    expect(chain.multiband.compLow.threshold.value).toBeCloseTo(-18, 6);
    expect(chain.multiband.compLow.ratio.value).toBeCloseTo(3, 6);
    expect(chain.multiband.compMid.ratio.value).toBe(1);
    expect(chain.multiband.compHigh.threshold.value).toBeCloseTo(-36, 6);
  });

  it('engages the wet path only when a band is active', () => {
    const ctx = new FakeAudioContext();
    const chain = buildMasteringChain(ctx);
    applyParameters(chain, params({ mbLow: 0, mbMid: 0, mbHigh: 0, mbMix: 100 }));
    expect(chain.multiband.wet.gain.value).toBe(0);
    expect(chain.multiband.dry.gain.value).toBe(1);
    applyParameters(chain, params({ mbLow: 40, mbMix: 60 }));
    expect(chain.multiband.wet.gain.value).toBeCloseTo(0.6, 6);
    expect(chain.multiband.dry.gain.value).toBeCloseTo(0.4, 6);
  });

  it('mutes the dry path and the other bands when a band is soloed', () => {
    const ctx = new FakeAudioContext();
    const chain = buildMasteringChain(ctx);
    applyParameters(chain, params({ mbLow: 40, mbSolo: 'low' }));
    expect(chain.multiband.lowSolo.gain.value).toBe(1);
    expect(chain.multiband.midSolo.gain.value).toBe(0);
    expect(chain.multiband.highSolo.gain.value).toBe(0);
    expect(chain.multiband.dry.gain.value).toBe(0);
    expect(chain.multiband.wet.gain.value).toBe(1);
  });

  it('bypasses a single band without touching the others', () => {
    const ctx = new FakeAudioContext();
    const chain = buildMasteringChain(ctx);
    applyParameters(chain, params({ mbLow: 60, mbMid: 60, mbBypassLow: true }));
    expect(chain.multiband.compLow.ratio.value).toBe(1);
    expect(chain.multiband.compMid.ratio.value).toBeGreaterThan(1);
  });

  it('applies auto make-up only when enabled', () => {
    const ctx = new FakeAudioContext();
    const chain = buildMasteringChain(ctx);
    applyParameters(chain, params({ mbLow: 80, mbAutoMakeup: false }));
    expect(chain.multiband.lowMakeup.gain.value).toBe(1);
    applyParameters(chain, params({ mbLow: 80, mbAutoMakeup: true }));
    expect(chain.multiband.lowMakeup.gain.value).toBeGreaterThan(1);
  });

  it('uses a 4th-order Linkwitz-Riley high-pass for bass mono', () => {
    const ctx = new FakeAudioContext();
    const chain = buildMasteringChain(ctx);
    applyParameters(chain, params({ bassMono: 120 }));
    expect(chain.stereo.bassHp.in.frequency.value).toBe(120);
    expect(chain.stereo.bassHp.out.frequency.value).toBe(120);
    expect(chain.stereo.bassHp.in.Q.value).toBeCloseTo(Math.SQRT1_2, 6);
    // "Off" parks the corner at 8 Hz rather than rewiring the graph.
    applyParameters(chain, params({ bassMono: 0 }));
    expect(chain.stereo.bassHp.in.frequency.value).toBe(8);
  });

  it('delays the correct channel for each Haas side', () => {
    const ctx = new FakeAudioContext();
    const chain = buildMasteringChain(ctx);
    applyParameters(chain, params({ haas: 10, haasSide: 1 }));
    expect(chain.stereo.haasR.delayTime.value).toBeCloseTo(0.01, 9);
    expect(chain.stereo.haasL.delayTime.value).toBe(0);
    applyParameters(chain, params({ haas: 10, haasSide: -1 }));
    expect(chain.stereo.haasL.delayTime.value).toBeCloseTo(0.01, 9);
    expect(chain.stereo.haasR.delayTime.value).toBe(0);
  });

  it('forces a minimum crossfeed in binaural mode', () => {
    const ctx = new FakeAudioContext();
    const chain = buildMasteringChain(ctx);
    applyParameters(chain, params({ binaural: true, crossfeed: 0 }));
    expect(chain.stereo.crossfeedLR.gain.value).toBeCloseTo(0.35 * 0.45, 6);
    expect(chain.stereo.crossfeedRL.gain.value).toBeCloseTo(0.35 * 0.45, 6);
  });

  it('routes exactly one monitoring path at a time', () => {
    const ctx = new FakeAudioContext();
    const chain = buildMasteringChain(ctx);
    for (const mode of ['stereo', 'mono', 'side', 'left', 'right']) {
      applyParameters(chain, params(), { audition: mode });
      const a = chain.stereo.audition;
      const active = [a.stereoPath, a.monoPath, a.sidePath, a.leftPath, a.rightPath].filter(
        (n) => n.gain.value > 0,
      );
      expect(active).toHaveLength(1);
    }
  });

  it('regenerates the saturation curve only when the amount changes', () => {
    const ctx = new FakeAudioContext();
    const chain = buildMasteringChain(ctx);
    applyParameters(chain, params({ sat: 30 }));
    const curve = chain.saturation.shaper.curve;
    applyParameters(chain, params({ sat: 30, warm: 3 }));
    expect(chain.saturation.shaper.curve).toBe(curve);
    applyParameters(chain, params({ sat: 31 }));
    expect(chain.saturation.shaper.curve).not.toBe(curve);
  });

  it('tightens the post-shaper low-pass as saturation rises', () => {
    const ctx = new FakeAudioContext();
    const chain = buildMasteringChain(ctx);
    applyParameters(chain, params({ sat: 0 }));
    expect(chain.saturation.postLowpass.frequency.value).toBe(22000);
    applyParameters(chain, params({ sat: 100 }));
    expect(chain.saturation.postLowpass.frequency.value).toBeCloseTo(17500, 6);
  });

  it('reads per-band gain reduction for the meters', () => {
    const ctx = new FakeAudioContext();
    const chain = buildMasteringChain(ctx);
    chain.multiband.compLow.reduction = -4.2;
    expect(readGainReduction(chain)).toEqual({ low: -4.2, mid: 0, high: 0 });
  });
});

describe('bypass', () => {
  const loud = params({
    drive: 6,
    warm: 6,
    body: 4,
    air: 5,
    tilt: 3,
    sat: 80,
    mbLow: 70,
    mbMid: 70,
    mbHigh: 70,
    mbMix: 50,
    width: 2,
    ms: 0.5,
    bassMono: 200,
    haas: 20,
    crossfeed: 0.8,
    phaseRot: 0.9,
    widthLow: 0.4,
    widthMid: 1.8,
    widthHigh: 2,
    tape: 90,
    hiss: 60,
    vinyl: 70,
    depth: 80,
    matchStrength: 100,
    matchGains: [3, -3, 2, -2, 1, -1, 4, -4],
  });

  it('bypassAll returns every stage to neutral', () => {
    const ctx = new FakeAudioContext();
    const chain = buildMasteringChain(ctx);
    applyParameters(chain, loud, { bypassAll: true });

    expect(chain.trim.gain.value).toBe(1);
    for (const band of chain.matchBands) expect(band.gain.value).toBe(0);
    for (const band of Object.values(chain.tone.bands)) expect(band.gain.value).toBe(0);
    expect(chain.tone.tiltLow.gain.value).toBe(0);
    expect(chain.multiband.wet.gain.value).toBe(0);
    expect(chain.multiband.dry.gain.value).toBe(1);
    expect(chain.stereo.sideWidth.gain.value).toBe(1);
    expect(chain.stereo.midGain.gain.value).toBe(1);
    expect(chain.stereo.haasL.delayTime.value).toBe(0);
    expect(chain.stereo.haasR.delayTime.value).toBe(0);
    expect(chain.stereo.crossfeedLR.gain.value).toBe(0);
    expect(chain.character.hissGain.gain.value).toBe(0);
    expect(chain.character.crackleGain.gain.value).toBe(0);
    expect(chain.character.rumbleGain.gain.value).toBe(0);
    expect(chain.character.wowDepth.gain.value).toBe(0);
    expect(chain.character.headBump.gain.value).toBe(0);
    expect(chain.depth.tap1.gain.gain.value).toBe(0);
    expect(chain.depth.tap2.gain.gain.value).toBe(0);
    expect(chain.saturation.shaper.curve).toHaveLength(1024); // identity curve
    expect(chain.saturation.makeup.gain.value).toBe(1);
  });

  for (const moduleId of [
    'match',
    'tone',
    'multiband',
    'stereo',
    'character',
    'depth',
    'saturation',
  ]) {
    it(`bypasses "${moduleId}" without disturbing the others`, () => {
      const ctx = new FakeAudioContext();
      const chain = buildMasteringChain(ctx);
      applyParameters(chain, loud, { moduleBypass: { [moduleId]: true } });

      const checks = {
        match: () => chain.matchBands.every((b) => b.gain.value === 0),
        tone: () => Object.values(chain.tone.bands).every((b) => b.gain.value === 0),
        multiband: () => chain.multiband.wet.gain.value === 0,
        stereo: () => chain.stereo.sideWidth.gain.value === 1,
        character: () => chain.character.hissGain.gain.value === 0,
        depth: () => chain.depth.tap1.gain.gain.value === 0,
        saturation: () => chain.saturation.shaper.curve.length === 1024,
      };
      expect(checks[moduleId](), `${moduleId} was not neutralised`).toBe(true);

      // At least one other module must still be doing something.
      const othersActive = Object.entries(checks).filter(
        ([id, check]) => id !== moduleId && !check(),
      ).length;
      expect(othersActive).toBeGreaterThan(0);
    });
  }
});

describe('every catalogue preset applies to a real graph', () => {
  for (const preset of ALL_PRESETS) {
    it(`applies "${preset.name}" without producing a non-finite parameter`, () => {
      const ctx = new FakeAudioContext();
      const chain = buildMasteringChain(ctx);
      applyParameters(chain, expandCatalogPreset(preset.parameters));
      for (const node of ctx.nodes) {
        for (const [key, value] of Object.entries(node)) {
          if (
            value &&
            typeof value === 'object' &&
            'value' in value &&
            typeof value.value === 'number'
          ) {
            expect(
              Number.isFinite(value.value),
              `${preset.name}: ${node.nodeType}.${key} is ${value.value}`,
            ).toBe(true);
          }
        }
      }
    });
  }
});

describe('immersive speaker feeds', () => {
  const upmix = {
    centerExtract: 0.5,
    surrLevelDb: -3,
    surrDelayMs: 12,
    heightLevelDb: -6,
    heightDecorr: 0.5,
    lfeFreqHz: 120,
    lfeLevelDb: -3,
    frontRear: 0.5,
  };

  for (const layoutId of LAYOUT_IDS) {
    it(`produces a feed for every channel of ${layoutId}`, () => {
      const ctx = new FakeAudioContext();
      const source = ctx.createGain();
      const { feeds } = buildSpeakerFeeds(ctx, source, layoutId, upmix);
      for (const key of LAYOUTS[layoutId].channels) {
        expect(feeds[key], `${layoutId} is missing a feed for ${key}`).toBeTruthy();
        expect(Number.isFinite(feeds[key].gain.value)).toBe(true);
      }
      expect(Object.keys(feeds).length).toBe(LAYOUTS[layoutId].channels.length);
    });

    it(`connects the source to every feed of ${layoutId}`, () => {
      const ctx = new FakeAudioContext();
      const source = ctx.createGain();
      const { feeds } = buildSpeakerFeeds(ctx, source, layoutId, upmix);
      for (const [key, feed] of Object.entries(feeds)) {
        expect(isConnected(source, feed), `${layoutId}: ${key} is not fed`).toBe(true);
      }
    });

    it(`low-passes every LFE feed of ${layoutId} at the crossover`, () => {
      const ctx = new FakeAudioContext();
      const source = ctx.createGain();
      buildSpeakerFeeds(ctx, source, layoutId, { ...upmix, lfeFreqHz: 95 });
      const lfeCount = LAYOUTS[layoutId].channels.filter((k) => SPEAKERS[k].lfe).length;
      if (lfeCount === 0) return;
      const lowpasses = ctx.nodes.filter(
        (n) => n.nodeType === 'biquad' && n.type === 'lowpass' && n.frequency.value === 95,
      );
      // Two cascaded sections per LR4 low-pass; Sonic Lab shares one for two subs.
      expect(lowpasses.length).toBeGreaterThanOrEqual(2);
    });
  }

  it('rejects an unknown layout', () => {
    const ctx = new FakeAudioContext();
    expect(() => buildSpeakerFeeds(ctx, ctx.createGain(), 'quad', upmix)).toThrow(/unknown layout/);
  });

  it('scales surround and height feeds by their level controls', () => {
    const ctx = new FakeAudioContext();
    const { feeds } = buildSpeakerFeeds(ctx, ctx.createGain(), '7.1.4', {
      ...upmix,
      surrLevelDb: -12,
      heightLevelDb: -18,
    });
    expect(feeds.Lss.gain.value).toBeCloseTo(Math.pow(10, -12 / 20), 5);
    expect(feeds.Ltf.gain.value).toBeCloseTo(Math.pow(10, -18 / 20), 5);
  });

  it('scales the centre feed by the extraction control', () => {
    const ctx = new FakeAudioContext();
    const { feeds } = buildSpeakerFeeds(ctx, ctx.createGain(), '5.1', {
      ...upmix,
      centerExtract: 0.8,
    });
    expect(feeds.C.gain.value).toBeCloseTo(0.8, 6);
  });
});

describe('binaural fold-down', () => {
  it('pans every non-LFE feed and sums LFE without panning', () => {
    const ctx = new FakeAudioContext();
    const { output } = buildBinauralFold(ctx, ctx.createGain(), '7.1.4', {
      centerExtract: 0.5,
      surrLevelDb: -3,
      surrDelayMs: 12,
      heightLevelDb: -6,
      heightDecorr: 0.5,
      lfeFreqHz: 120,
      lfeLevelDb: -3,
      frontRear: 0.5,
    });
    const panners = nodesOfType(ctx, 'panner');
    // 12 channels, one of which is the LFE → 11 panners.
    expect(panners).toHaveLength(11);
    for (const panner of panners) {
      expect(panner.panningModel).toBe('HRTF');
      expect(isConnected(panner, output)).toBe(true);
      const magnitude = Math.hypot(
        panner.positionX.value,
        panner.positionY.value,
        panner.positionZ.value,
      );
      expect(magnitude).toBeCloseTo(1, 6);
    }
  });

  it('places speakers using the Web Audio convention: +X right, +Y up, −Z forward', () => {
    const ctx = new FakeAudioContext();
    // Front centre.
    const centre = placePanner(ctx, SPEAKERS.C);
    expect(centre.positionX.value).toBeCloseTo(0, 6);
    expect(centre.positionZ.value).toBeCloseTo(-1, 6);

    // L is at ADM +30° (left), so HRTF −30° → negative X.
    const left = placePanner(ctx, SPEAKERS.L);
    expect(left.positionX.value).toBeLessThan(0);
    const right = placePanner(ctx, SPEAKERS.R);
    expect(right.positionX.value).toBeGreaterThan(0);
    expect(right.positionX.value).toBeCloseTo(-left.positionX.value, 6);

    // Height channels are above the listener.
    expect(placePanner(ctx, SPEAKERS.Ltf).positionY.value).toBeGreaterThan(0.5);
  });

  it('rejects an unknown layout', () => {
    const ctx = new FakeAudioContext();
    expect(() => buildBinauralFold(ctx, ctx.createGain(), 'nope', {})).toThrow(/unknown layout/);
  });
});
