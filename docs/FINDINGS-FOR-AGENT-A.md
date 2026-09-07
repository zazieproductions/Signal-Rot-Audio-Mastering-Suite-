# Findings for Agent A

This file is the conformance lab's inbox. Agent B does **not** fix production
DSP. When a real-browser measurement disagrees with a documented claim, it lands
here as a test failure / note.

Status key: `open` (needs Agent A) · `recorded` (measured, not a defect) ·
`platform` (browser limitation).

Captures cited below are from Chromium 149.0.7827.0,
`lab-results/conformance/chromium/*.json` (gitignored; regenerate with
`npm run test:conformance`). Firefox and WebKit are in the CI matrix
(`ci/conformance.yml`) but were not captured in this worktree — the Playwright
CDN (`cdn.playwright.dev`) was unreachable here. Re-run on a machine that can
`npx playwright install firefox webkit`.

## Already visible without a browser

| id  | status   | Finding                                                                                                                                                                                                   |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-1 | recorded | `EXPORT_SAMPLE_RATES` is `[0, 44100, 48000, 88200, 96000, 192000]`. **176.4 kHz is not offered.** The lab still probes it and records whatever the engine does.                                           |
| A-2 | recorded | `MB_COMPRESSOR_LOOKAHEAD_S = 0.006` is a Chromium/WebKit source constant. The lab _measures_ the delay per engine and flags residuals > 1.5 ms. Do not treat 6.000 ms as exact until the capture says so. |
| A-3 | recorded | The analytic make-up model is engine-shaped, not measured. Residual vs the live node is a finding when \|Δ\| > 0.75 dB.                                                                                   |
| A-4 | platform | `WaveShaperNode.oversample` quality is unspecified. Alias energy at 4× vs none is recorded per browser; a large Chromium/Firefox split is expected.                                                       |
| A-5 | platform | Preview ≠ export by construction (safety compressor vs true-peak limiter; transient / dither export-only). The lab quantifies the _graph_ difference, not a live AudioContext capture.                    |

## Measured in a real browser

| id  | browser  | status   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-1 | chromium | recorded | Engine **accepted and rendered** 44.1 / 48 / 88.2 / 96 / **176.4** / 192 kHz (`sample-rates.json`). The UI still omits 176.4.                                                                                                                                                                                                                                                                                                                                                                                                                |
| A-2 | chromium | recorded | Look-ahead measured **6.000 ms**, Δ vs documented 0.000 ms, impulse peak 1.063 (`compressor.json`). Matches `MB_COMPRESSOR_LOOKAHEAD_S` on this engine.                                                                                                                                                                                                                                                                                                                                                                                      |
| A-3 | chromium | recorded | Analytic make-up vs live node: worst Δ **−0.046 dB** (amount 80). Amount 0 measured −0.045 dB. Well under the 0.75 dB flag. Model is trustworthy on Chromium.                                                                                                                                                                                                                                                                                                                                                                                |
| A-4 | chromium | recorded | WaveShaper clamp ±1 holds; sat=0 unity +0.0005 dB; +6 dBFS input at sat=0 peaks at 2.008 (not clipped). Alias @ 23 kHz relative to H1: **none −17.5 dB, 2× −87.3 dB, 4× −87.3 dB**. 4× anti-aliases on this engine. H3 at amount 1 = −11.0 dB; folds = 0 (`waveshaper.json`).                                                                                                                                                                                                                                                                |
| A-5 | chromium | recorded | Preview vs export, 48 kHz pink. **Reference:** ΔRMS −0.15 dB, Δpeak −0.000 dB, Δcorr ≈ 0. Spectral (preview−export): 1 kHz **−5.33 dB**, 3.2 kHz −4.47 dB, 8 kHz −3.84 dB. **Creative:** ΔRMS −0.11 dB, Δpeak −0.90 dB; 1 kHz −5.05 dB, 8 kHz **+2.45 dB**. Not bit-identical; RMS still inside 1 dB on the reference path (`preview-export.json`).                                                                                                                                                                                          |
| A-6 | chromium | **open** | Multiband reconstruction with **inactive compressors** is not 0 dB on the wet path. Mix 0 (dry) is unity (≤ 0.00001 dB). Mix 1 at the crossover frequencies: **+7.38 dB @ 140 Hz, +7.39 dB @ 3.2 kHz**. Mix 0.5: +4.45 / +4.46 dB at those same bins. Dry/wet impulse alignment is **−0.021 ms** (lookahead comb is gone). 7.0.0 claimed “0.00000 dB at every mix position”; Chromium disagrees on the wet sum. `tests/browser/multiband.spec.js` keeps the 1.5 dB contract and fails. Do **not** retune from this PR. See `multiband.json`. |
| A-7 | chromium | recorded | Stereo 192 kHz / 0.4 s offline render took **514 ms (1.28× realtime)** on this CPU. Stereo 48 kHz 123 ms (0.31×). Immersive layouts at 48 kHz were 11–18 ms (feed builder only, not the full master). Bottleneck is high-rate stereo graph render, not 24-ch feed assembly (`benchmarks.json`). Do not optimise production in this PR.                                                                                                                                                                                                       |
| A-8 | chromium | recorded | Immersive feeds 5.1 / 7.1 / 7.1.2 / 7.1.4 / 9.1.6 / Sonic Lab 20.4: every channel finite, L/R energy follows the source, every LFE live on a bass tone, height rings live on a side source, 24-ch Sonic Lab with four trailing subs (`immersive.json`). No routing defect on this engine.                                                                                                                                                                                                                                                    |

## How to consume a finding

1. The regression test that produced it stays. Do not delete it to go green.
2. If the behaviour is intended, tighten the threshold and move the row to
   `recorded` with a one-line reason.
3. If it is a defect, fix it on the DSP side (Agent A) against that test.
