# Web Audio conformance lab

The Node fake `AudioContext` in `tests/helpers/fake-audio-context.js` can assert
**topology**. It cannot process a sample. This lab is the missing half: real
`OfflineAudioContext` renders, in real browsers, with numbers.

It does not redesign Signal Rot and it does not retune DSP. It measures what the
running engine actually does.

```bash
npx playwright install chromium firefox webkit
npm run test:conformance          # Chromium + Firefox + WebKit
npm run lab:conformance -- --project chromium
```

If the Playwright CDN is unreachable, point Chromium at a local binary:

```bash
export SR_CHROMIUM_PATH=/path/to/chrome   # or chrome-headless-shell
npx playwright test --config tests/browser/playwright.config.js --project chromium
```

Results land in `lab-results/conformance/<browser>/*.json`.

## What is under test

| Surface                  | How it is measured                                                                | Hard fail if                                      |
| ------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------- |
| `DynamicsCompressorNode` | Impulse latency, quiet-sine make-up, static curve, attack/release envelope        | No delay, no make-up at 5:1, NaN                  |
| `WaveShaperNode`         | Spec clamp, sat=0 unity, +12 dB headroom path, oversampling, DC, monotonicity, Hn | Clamp missing, sat=0 clips at 0 dBFS, curve folds |
| Multiband (production)   | Wet/dry impulse alignment, reconstruction at every mix, partial mix with glue     | Several-ms delay comb, reconstruction > 1.5 dB    |
| Sample rates             | Construct + render a sine at 44.1 / 48 / 88.2 / 96 / 176.4 / 192 kHz              | 44.1 or 48 kHz refused                            |
| Preview vs export graphs | Same chain, with and without the live safety compressor                           | NaN, DC, silence; reference RMS drift ≫ 1 dB      |
| Immersive feeds          | `buildSpeakerFeeds` through every layout                                          | Missing channel, silent sub, L/R swap, non-finite |
| Performance              | Render time, output bytes, realtime ratio, heap delta where Chromium reports it   | Stereo 48 kHz render fails to complete            |

Unsupported sample-rate combinations are **recorded, not failed**. Safari
historically refuses 192 kHz; that is a platform fact, not a Signal Rot defect.

## Browsers

The suite targets three engines:

- **Chromium** (Playwright `chromium`)
- **Firefox** (Playwright `firefox`)
- **WebKit** (Playwright `webkit` — the Safari-compatible engine)

A missing browser binary skips that project only if you pass `--project`. CI
installs all three. Cross-browser deltas are **notes**, not defects, except for
NaN / Infinity: native compressor, shaper and HRTF internals are
implementation-defined (`docs/BROWSER-COMPATIBILITY.md`).

## What this lab will not claim

- Bit-identical preview and export. The live path has a safety
  `DynamicsCompressorNode`; export has a look-ahead true-peak limiter. The lab
  _quantifies_ the graph-level divergence.
- That the analytic make-up model in `src/audio/dsp/dynamics-compressor.js` is
  exact on every engine. The lab measures the residual and files it as a finding
  for Agent A when it exceeds 0.75 dB.
- That 4× `WaveShaperNode` oversampling is a specified anti-aliaser. Quality is
  unspecified. Harmonic and alias bins are recorded per engine.

## Ownership

This tree is orthogonal to Agent A's DSP work:

```
tests/browser/          Playwright specs + harness
tests/fixtures/         synthesised sources + measurements
tests/conformance/      compare / classify / thresholds
tools/conformance/
tools/audio-regression/
tools/benchmarks/
docs/CONFORMANCE.md
docs/AUDIO-REGRESSION.md
```

Production modules are **imported, never modified**. A DSP bug is a failing
measurement and a note in `docs/FINDINGS-FOR-AGENT-A.md`, not a silent fix.

## Adding a measurement

1. Put the experiment in `tests/browser/lab/` so it runs inside the page.
2. Expose it on `window.__SR_LAB__` via `tests/browser/harness.js`.
3. Call it from a `*.spec.js` next to the harness. Write JSON with `writeResult`.
4. If the number is a mastering regression, add a threshold in
   `tests/conformance/thresholds.js` and a comparer case.
