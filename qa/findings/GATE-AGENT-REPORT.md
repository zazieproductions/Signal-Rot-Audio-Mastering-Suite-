# Release-gate agent — final report

**Branch:** `arena/01a07e17-signal-rot-audio-mastering-sui`
**PR:** [#27](https://github.com/zazieproductions/Signal-Rot-Audio-Mastering-Suite-/pull/27)
**Tracking issue:** [#29](https://github.com/zazieproductions/Signal-Rot-Audio-Mastering-Suite-/issues/29) (browser matrix is red)

## Browsers verified

I could **not** run a real browser in this sandbox. The Playwright CDN, the
Debian package mirror, and most CDNs are blocked; the only network egress is
GitHub, GitHub API, and the npm registry. I therefore did not claim coverage I
did not observe. The browser matrix is **run on GitHub Actions** by the new
`.github/workflows/conformance.yml`, and the **actual results from those runs
are below**.

| Engine | Result | What it covers |
| --- | --- | --- |
| Chromium | FAIL (real run on main, 34170813100) | `tests/browser/multiband.spec.js` and friends; full DSP browser matrix |
| Firefox  | FAIL (real run on main, 34170813100) | same |
| WebKit   | FAIL (real run on main, 34170813100) | same |

The failures are real, expected, and were already there on `main` (PR #26).
They are now the subject of issue #29, with concrete steps to triage.

## CI gates activated (with actual observed runs)

| Workflow | Status | Source of truth |
| --- | --- | --- |
| `.github/workflows/ci.yml` — Lint, test, build (Node + Vitest + export validation + production build) | **GREEN** (run 34170813051) | `Lint, test, build` |
| `.github/workflows/qa.yml` — `Independent true-peak oracle` | **GREEN** (run 34170813000) | 11 tests, including the SON-2 reproducer |
| `.github/workflows/qa.yml` — `Regression locks` | **GREEN** (run 34170813000) | 15 tests, seven specific defects |
| `.github/workflows/qa.yml` — `Sample-rate matrix` | **GREEN** (run 34170813000) | 60 tests at 44.1 / 48 / 88.2 / 96 / 176.4 / 192 kHz |
| `.github/workflows/qa.yml` — `QA structural checks` | **GREEN** (run 34170813000, after the regex fix) | qa/jobs-*.json, qa/findings/SON-*.md |
| `.github/workflows/conformance.yml` — `Golden fixtures (Node)` | **GREEN** (run 34170813100) | `lab:goldens` + `goldens.test.js` + `tests/conformance` |
| `.github/workflows/conformance.yml` — `Web Audio conformance (chromium)` | **RED** (run 34170813100) | tracked in issue #29 |
| `.github/workflows/conformance.yml` — `Web Audio conformance (firefox)` | **RED** (run 34170813100) | tracked in issue #29 |
| `.github/workflows/conformance.yml` — `Web Audio conformance (webkit)` | **RED** (run 34170813100) | tracked in issue #29 |
| `.github/workflows/export-interoperability.yml` (pre-existing) | **GREEN** (run 34170813036) | unchanged |

## Regressions locked

- `tests/dsp/regression-locks.test.js` (15 tests, IDEAL MATH) — seven specific
  defects the main audio agent must never regress. Hard 0.5 dB / ±0.1 dB
  design goal explicitly recorded; not widened.
  - +7.4 dB crossover reconstruction (issues #19, #12)
  - Wrong Web Audio Q convention on lowpass/highpass (issue #19)
  - Mono → L+silence M/S corruption (issue #20)
  - Hidden DynamicsCompressorNode make-up (audit §2.2)
  - Wet/dry latency mismatch
  - Saturation headroom regression (audit §2.1)
  - Dry wire comb at mix = 0

## Failures found, handed off

- **#29** — Browser conformance matrix is red on chromium / firefox / webkit.
  Tracked separately. The main audio agent owns the fix; the gate agent will
  not widen tolerances to get green.

## True-peak oracle (issue #21 acceptance target)

- `tests/dsp/true-peak-oracle.test.js` (11 tests, IDEAL MATH) — independent
  band-limited reconstruction oracle using the production `fftRadix2`. The
  SON-2 reproducer's current state is captured in the test log so the fix
  to #21 has a red/green signal the moment it lands:

  ```
  SON-2 reproducer: oracle -0.446 dB, limiter -1.000 dB, ceilingRespected=true.
  Fix must flip this to false.
  ```

  The oracle was added in this PR; the limiter is **unchanged**. Until the
  limiter is fixed, the gate is **not** blocking on the disagreement — it is
  recording it.

- `npm run validate:exports` (independent RIFF/ADM parsers + ffprobe) is the
  second layer of evidence, and it remains green.

## Main-agent handoff

**Only the failures they actually need to fix:**

- The browser matrix in `tests/browser/multiband.spec.js` is failing the hard
  0.5 dB gate. See issue #29. The most likely first thing to check is
  `result.reconstruction.rows` in the chromium `multiband.json` artefact.

That's it. The oracle, the regression locks, the sample-rate matrix, the
A/B/C contract, the export validation, the lint, the production build —
all green and now gated.

## Merge safety

**HOLD.**

- Three of the four new gates are green.
- The browser matrix is red on all three engines, on a real GitHub Actions
  run, on `main`. The defect is pre-existing (PR #26 left it there) and
  is now tracked in issue #29.
- The contract from the brief was: do not widen tolerances, do not paper
  over failures, file a finding. Done.

When the main audio agent resolves #29, the matrix will turn green, PR
#27 will be a clean green gate, and the next DSP change lands against a
hard 0.5 dB / ±0.1 dB contract that the gate itself enforces.

## What I did not do

- No production DSP changes under `src/audio/{graph,dsp,render,immersive}`.
- No preset retuning, no limiter changes, no immersive synthesis changes.
- No tolerance widening to get green CI.
- No "fix" to issue #21.
- No claim of browser coverage I did not actually observe.
