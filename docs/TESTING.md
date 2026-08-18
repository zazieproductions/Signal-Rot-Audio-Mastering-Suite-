# Testing

```bash
npm run test           # 544 tests in Node + jsdom, ~100 s
npm run test:watch
npm run test:coverage
npm run test:e2e       # 37 browser tests — npx playwright install chromium first
npm run check          # lint + test + build
```

## Philosophy

**Test the claim, not the implementation.** Signal Rot makes specific, checkable
assertions — "reproduces the BS.1770-4 coefficients", "the crossover sums flat at every mix
position", "the ceiling is respected". Each of those has a test that would fail if the claim
stopped being true. A test that only asserts a function returns the number it currently
returns proves nothing.

Three rules follow:

1. **Every test signal is generated programmatically.** No copyrighted audio in the
   repository, and every result reproducible on any machine.
2. **Verification is independent of production.** The format tests parse files with a
   separate RIFF/IFF reader in `tests/helpers/riff.js`. If the writer and the reader shared
   code, a passing test would prove only that they agree.
3. **Regressions get a test that reproduces the original failure.** The crossover suite
   asserts both the −58.9 dB null the pre-7.0 topology produced _and_ the 0.00000 dB the
   current one does. The bug cannot come back quietly.

## Layout

```
tests/
├── helpers/
│   ├── signals.js              synthetic test signals
│   ├── riff.js                 independent RIFF / IFF / chna / axml parsers
│   ├── fake-audio-context.js   recording Web Audio implementation
│   └── fake-canvas.js          no-op 2D context for jsdom
├── dsp/          179 tests     math · biquad · prng · loudness · true-peak · limiter ·
│                               transient · dither · crossover · correlation · spectral-match
├── format/       135 tests     wav · aiff · adm · layouts · download
├── app/           74 tests     parameters · state · presets-io · presets-catalog
├── integration/  116 tests     graph topology · full post-render pipeline
└── ui/            40 tests     controls · tabs · signal-flow · presets panel · boot
e2e/                37 tests    import · controls · export · responsive · accessibility
```

## Test signals

[`tests/helpers/signals.js`](../tests/helpers/signals.js):

| Generator           | Purpose                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `sine`              | Level and frequency accuracy against analytically known answers       |
| `fadedSine`         | Same, with raised-cosine edges so interpolators do not ring on a step |
| `silence`           | Gate behaviour, division by zero, NaN                                 |
| `whiteNoise`        | Seeded Gaussian; decorrelation and crest factor                       |
| `pinkNoise`         | Voss-McCartney −3 dB/octave; the standard broadband loudness signal   |
| `toneBursts`        | 50 % duty cycle; exercises the absolute and relative gates            |
| `antiPhase`         | Correlation −1; mono cancellation                                     |
| `transientTrain`    | Sharp transients on a quiet bed; the hard case for a limiter          |
| `twoLevelProgramme` | Configurable dynamic range; loudness range and relative gating        |
| `extremeDynamics`   | 60 dB split; the case where correct gating looks like a bug           |
| `toDualMono`        | Mono → stereo, for the 3.01 LU identity                               |

## The fake audio context

[`tests/helpers/fake-audio-context.js`](../tests/helpers/fake-audio-context.js) implements
the Web Audio _node_ API without processing audio. It records topology and parameter
values, which lets 91 tests assert things a browser test could not easily reach:

- Every declared speaker feed exists and is connected to the source, for all six layouts
- Bypass really neutralises a module, and only that module
- Every one of the forty catalogue presets applies without producing a non-finite parameter
- Exactly one monitoring path is unmuted at a time
- Every generator is started once and stopped on dispose — no leaked oscillators
- The saturation make-up gain lives on its own node, separate from the chain output

It throws on unimplemented calls rather than silently doing nothing, so a test cannot pass
because the fake was too forgiving.

## What each suite proves

### `tests/dsp/loudness.test.js` — 32

- K-weighting stage 1 and stage 2 match BS.1770-4 Tables 1 and 2 to **1e-12**
- The RLB numerator stays `[1, −2, 1]` at every rate — its +0.043 dB pass-band gain is part
  of the standard
- Both stages are stable (poles inside the unit circle) at 44.1 … 192 kHz
- A 1 kHz stereo sine reads its amplitude in dBFS: 1.0 → 0.0 LUFS, 0.1 → −20.0, 0.01 → −40.0
- Mono reads exactly 3.01 LU below dual mono
- Rate independence to 0.1 LU; exact linearity with level
- Silence → `−Infinity` and `silent`; under 400 ms → `tooShort`; empty buffer → no throw
- Anti-phase measures identically to in-phase
- 400 ms blocks at 75 % overlap produce exactly the expected count
- Absolute gate at −70, relative gate at −10 LU on the gated mean
- Loudness range: 14.6 LU measured on a 15 LU programme; correctly small on a 60 dB split
- Channel weighting: LFE at G = 0 changes nothing; surrounds at 1.41 add 1.49 dB
- No NaN on 30 s of 1e-6 amplitude, or on a full-scale square wave

### `tests/dsp/true-peak.test.js` — 13

- The polyphase bank has `factor` branches of unity DC gain, and is memoised
- fs/4 worst case: **−0.168 dB** versus cubic's **−1.072 dB**
- Never reads below the sample peak, at any frequency
- Reads a low-frequency sine and interior DC exactly
- Detects +1.9 dBTP of overshoot on a clipped square wave that a sample meter calls 0 dBFS
- The real-time estimate stays within 0.5 dB and never under-reads the sample peak

### `tests/dsp/limiter.test.js` — 20

- The sliding minimum is correct, including its window edges, and never exceeds the source
- Hann smoothing preserves a constant and removes a step's discontinuity
- The gain curve never exceeds the required gain at any sample
- Maximum sample-to-sample gain change **< 0.02** — the pre-7.0 curve stepped
- Reduction begins _before_ the transient arrives
- The ceiling holds at −0.1, −0.3, −1.0 and −2.0 dBTP on transients, bass-heavy material and
  already-clipped input
- One gain curve for all channels — the L/R ratio is preserved sample by sample
- LFE channels are excluded from detection but still gained
- Material below the ceiling comes out **bit-identical**

### `tests/dsp/multiband-crossover.test.js` — 14

- The current topology sums to **< 0.001 dB** at nine mix positions, four sample rates and
  four crossover-frequency pairs
- Each band lands where it belongs and is −6.02 dB at its crossover
- The pre-7.0 topology is reproduced and shown to null by 25–59 dB at partial mix
- The amount→threshold/ratio mapping is monotonic and clamps

### `tests/dsp/dither.test.js` — 13

- TPDF adds at most ±1 LSB and has a triangular, not rectangular, density
- Shaped dither puts **less** error energy below 4 kHz than flat TPDF
  (this test caught a sign error in the error-feedback filter)
- Dither is refused for 32-bit float, with a reason
- Channels get independent streams — dither must not sit dead centre
- Deterministic for a seed, different for a different seed
- Quantisation error is measurably less correlated with the signal than without dither

### `tests/dsp/transient-shaper.test.js` — 9

- The gain trajectory is **identical 20 dB down** — the level-independence claim
- One gain for all channels
- Positive attack raises the sample peak, negative lowers it
- A steady 2 kHz tone is left alone to within 0.02
- Bounded to ±12 dB; no NaN on silence

### `tests/format/` — 135

WAV: header fields, `WAVE_FORMAT_IEEE_FLOAT`, 24-bit packing, exact float round-trip,
half-LSB 16-bit round-trip, channel interleave order, extensible fields and GUID tail,
every `SPEAKER_*` mask value, odd-length padding, size guards.

AIFF: the canonical 80-bit extended byte sequences for 44.1 and 48 kHz, round-trip for ten
rates, big-endian samples, two's-complement negatives, odd-length `SSND` padding.

ADM: 64 tests across **all six layouts** — chunk presence and order, `bext` size and
version, `chna` entry widths and uniqueness, full ID cross-reference resolution, well-formed
XML, azimuth convention, LFE `lowPass` elements, `DirectSpeakers` not `Objects`, XML escaping
of hostile input, refusal on channel-count mismatch.

Layouts: `azimuthHrtf === −azimuthAdm` for every speaker, BS.2051 labels matching their
azimuths, the corrected height mask bits, WAV channel ordering by mask bit, Sonic Lab's ring
structure and preserved asymmetry, channel-map export.

Download: path traversal, Windows-forbidden characters, control characters, reserved device
names, HTML-injection filenames, truncation preserving the extension, unicode preservation.

### `tests/app/` — 74

Schema integrity (every parameter complete, defaults in range, divergences explained),
clamping, hostile input, prototype pollution, preset round-trip, migration from a realistic
pre-7.0 file, the nine enforced catalogue safety rules, store subscriptions, undo/redo
bounds, deterministic reset.

### `tests/integration/` — 116

`graph.test.js` (91) — topology, parameter application, bypass semantics, every catalogue
preset against a real graph, immersive feeds and binaural placement.

`render-pipeline.test.js` (25) — the whole post-render pipeline: convergence to −14, −18 and
−23 LUFS within 0.25 LU; honest reporting of the unreachable −9 LUFS target; the ceiling
held at four values × two targets, re-verified independently; **bit-identical output for the
same seed**; duration, rate and channel count preserved through WAV and AIFF; the ceiling
surviving 16-bit quantisation; the render report's completeness and JSON-safety.

### `tests/ui/` — 40

`controls.test.js` (29) — `el()` never produces HTML from dynamic values; the ARIA tab
pattern including arrow/Home/End and roving tabindex; schema-driven control rendering,
label association, `aria-valuetext`, badges, cross-parameter disabling; the signal-flow view;
the preset panel.

`boot.test.js` (11) — **loads the real `index.html`**, stubs Web Audio and canvas, runs
`bootstrap()`, and asserts: no console errors, every schema parameter has a control, the
signal-flow view renders, all forty presets render, the immersive menu populates, the About
panel fills from live probing, an animation frame runs without throwing, a preset applies end
to end through the real DOM, the transport buttons are wired, no duplicate element ids, and
every `aria-controls` and `label[for]` resolves.

That last suite is the cheapest possible answer to "does the application actually start?" —
the question the audited repository answered with **no**, because `index.html` pointed at
`./src/app.js` while the file sat at the repository root.

### `e2e/` — 37

Real Chromium, real Web Audio, real downloads.

- Import a synthesised WAV, decode it, analyse it, read the LUFS off the meter
- Play, pause, seek
- Reject an undecodable file with a specific message
- A hostile filename does not execute
- Keyboard tab navigation; slider readouts; export-only badges
- Apply a preset and verify the resulting control values
- Undo/redo; theme persistence across reload; A/B and monitor switching
- Module bypass from the signal-flow view; the command palette
- Phase warnings appear for a destructive preset
- **Export a WAV and parse the downloaded bytes**: RIFF magic, declared size, channel count,
  sample rate, bit depth
- Export reports achieved LUFS and dBTP; download and parse the JSON render report
- Save a preset, reset, reload it, verify the value came back
- Export a 5.1 file and check `WAVE_FORMAT_EXTENSIBLE` and the `0x3F` mask
- Mobile layout: single-column grids, scrollable tabs, no horizontal overflow, touch targets
- Accessibility: skip link first in the tab order, every button named, every control
  labelled, visible focus rings, live regions, `Space` not swallowed, reduced-motion honoured

> **Not executed during the 7.0 refactor.** The development sandbox had no network access to
> the Playwright browser CDN. The specs are written and configured; CI runs them on every
> push. This document does not claim they passed.

## Coverage

```bash
npm run test:coverage
```

`src/main.js`, `src/app/bootstrap.js` and the worker entry point are excluded — they are
wiring, covered by the boot smoke test and the e2e suite rather than by unit tests.

## Adding a test

1. Put pure DSP in `tests/dsp/` and assert against an **analytically known** value where
   one exists. `expect(x).toBe(whatItCurrentlyReturns)` is not a test.
2. Put format work in `tests/format/` and parse the output with `tests/helpers/riff.js`,
   not with the writer's own code.
3. If you are fixing a bug, add the test that reproduces it **first**, and keep the
   reproduction of the old behaviour if it is cheap to express.
4. If you are changing what a render sounds like, add a measurement to
   `tests/integration/render-pipeline.test.js` and put the before/after numbers in the PR.
