# Changelog

All notable changes to Signal Rot // Master.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [7.1.0] — 2026-09-01

A sound-quality release: three of the audible-quality caveats in
[`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) are now fixed in the export path, with
measured before/after numbers.

### Changed — audio (exports sound better)

- **Saturation no longer aliases in exports.** The offline render lifts the saturation
  stage out of the Web Audio graph and runs it through a dedicated engine
  (`src/audio/render/saturate-hq.js`): the exact same transfer curve, evaluated
  analytically (no 4096-point lookup error) at **4× the sample rate** through a 257-tap
  Kaiser-windowed polyphase resampler (β = 9, zero net delay). Measured on a 15 kHz sine
  at 44.1 kHz, full drive: the folded third-harmonic alias at 900 Hz fell from
  **−18.8 dB to −126.6 dB** — a **107.8 dB** improvement — with the fundamental level
  unchanged. Because the aliasing is actually gone, the alias-mitigation low-pass
  (22 kHz → 17.5 kHz with drive) is no longer applied to exports: **saturated masters
  keep their top octave**. Exports also stop depending on the browser's undefined
  `WaveShaperNode` oversampling quality — saturation is now bit-identical across
  engines. The live preview still uses the WaveShaper (with its mitigations); the render
  report records which engine ran.
- **`shaped` dither is now psychoacoustically weighted at 44.1/48 kHz.** The plain
  second-order `(1 − z⁻¹)²` shaper is replaced by the 9-coefficient F-weighted
  minimum-audibility error-feedback filter published by Lipshitz, Vanderkooy and
  Wannamaker (JAES 39(11), 1991). Measured 16-bit quantisation-error energy in the ear's
  most sensitive band (2–6 kHz): **−18.4 dB versus flat TPDF and −9.4 dB versus the old
  second-order shaper**, with the displaced energy parked above 15 kHz. At other sample
  rates — where the published coefficients are not valid — the second-order shaper
  remains, and the render report states which filter actually ran.
- **The limiter's gain trajectory is smoother.** The sliding-minimum gain curve is now
  smoothed by a cascade of two full-width Hann kernels (over a correspondingly widened
  minimum window, so the ≤-required-gain guarantee is preserved). The cascade's spectrum
  has ≈ −62 dB sidelobes against a single Hann's −31 dB; measured on a transient notch,
  peak gain slope fell **25 %** and peak curvature **46 %**, so the limiter writes less
  modulation-distortion splatter into the programme for the same reduction depth. The
  only behavioural change is that reduction is anticipated up to one extra look-ahead
  window (2.5 ms at the default) earlier.

### Added

- `tests/dsp/saturate-hq.test.js` — alias suppression (> 40 dB asserted, > 100 dB
  measured), transfer-curve equivalence with the live WaveShaper table, zero-delay
  alignment, top-octave retention, DC-freedom, determinism.
- Dither tests for shaper selection by sample rate, the 2–6 kHz improvement, and
  error-feedback boundedness.
- Limiter tests for the cascaded smoothing's slope/curvature win and its ≤-required
  guarantee.
- The render report now carries a `saturation` block (engine, oversampling factor,
  prototype taps, gain staging) and the dither block a `shaper` field.

### Documentation

- `docs/LIMITATIONS.md`, `docs/DSP-SIGNAL-FLOW.md`, `docs/TRUE-PEAK-LIMITER.md`,
  `docs/BROWSER-COMPATIBILITY.md` and the README updated: the saturation-aliasing and
  noise-shaping caveats now apply to the live preview only or are gone, and the
  roadmap's "oversampled saturation" item is done.

## [7.0.0] — 2026-08-18

A full audit, refactor and DSP-reliability pass. The audit that drove it is preserved at
[`docs/AUDIT.md`](docs/AUDIT.md).

**This release changes what renders sound like.** Every audible change is listed under
"Fixed" with measured before/after numbers.

### Fixed — audio

- **The multiband parallel mix destroyed the crossover regions.** The all-pass band sum was
  mixed against an unfiltered dry wire, producing a comb filter. Measured at the 50 % mix
  the UI called "the audiophile move": **−30.3 dB at 140 Hz and 3.2 kHz, bottoming out at
  −58.9 dB at 137 Hz.** Five shipped presets used partial parallel mix and were all
  producing broken audio. The dry path now runs through `AP2(140) · AP2(3200)` — the exact
  transfer function the band sum collapses to. Reconstruction is now **0.00000 dB at every
  mix position**.
- **True-peak detection under-read by 1.07 dB.** Cubic (Catmull-Rom) interpolation is not
  band-limited. Replaced with a windowed-sinc polyphase interpolator: the fs/4 worst case now
  reads −0.168 dB instead of −1.072 dB. A ceiling of −0.1 dBTP could previously deliver a
  file reaching +0.97 dBTP after reconstruction.
- **The limiter applied a discontinuous gain step on every transient.** The forward minimum
  was used directly as the gain. Now the sliding minimum is convolved with a Hann window of
  the same width, which is provably ≤ the required gain at every sample. Maximum
  sample-to-sample gain change fell from the full reduction in one sample to **< 0.02**.
- **Normalisation missed its target and never checked.** The export now iterates
  normalise → limit → measure with a secant step, converging within **0.25 LU** on −14, −18
  and −23 LUFS. When a target is physically unreachable it says so instead of silently
  missing.
- **The saturation make-up gain was destroyed in the live preview.** `outGain` carried both
  the make-up and the preview normalisation gain, and the second write overwrote the first —
  preview and export differed by up to **1.9 dB** at full saturation. Two responsibilities,
  two nodes.
- **"Match loudness" did not match loudness.** A and B were referenced to different levels,
  so they were equal only when the processed loudness already equalled the target.
- **Loudness range used the wrong specification.** 400 ms blocks with the −10 LU integrated
  gate instead of EBU Tech 3342's 3 s blocks with a −20 LU gate. Readings were systematically
  high.
- **K-weighting was an approximation.** `1500 Hz / +4 dB / Q 0.707` and `38 Hz / Q 0.5`
  instead of the BS.1770-4 filters. Now reproduces the tabulated 48 kHz coefficients to
  **1e-12**.
- **Bass mono was 12 dB/octave, not mono.** A single biquad at Q 0.5 left the side channel
  only −6 dB down at half the corner frequency. Now a 4th-order Linkwitz-Riley: **−24 dB**.
- **The transient shaper's sustain control was level-dependent.** Both terms are now
  envelope ratios. The gain trajectory is identical 20 dB down.
- **The transient detector boosted steady tones.** A 2 kHz sine gained +1.06 dB at
  `attack = 100` because a 1 ms follower tracks the rectified waveform's ripple. Detector
  pre-smoothing reduces this to **+0.09 dB**.
- **The noise-shaped dither shaped the wrong way.** The error-feedback filter's sign was
  inverted, putting _more_ noise in the low band than flat TPDF. Caught by a test.
- **Exports were not reproducible.** Hiss, crackle and rumble used `Math.random()`. All
  noise is now seeded, with a user-visible texture seed and a randomise control.
- **Noise beds were 2-second mono loops**, repeating 120 times across a four-minute master
  and sitting as a hard phantom centre. Now 12 seconds and genuinely stereo.
- **Multichannel limiting was fully linked including the LFE**, so a kick in the sub ducked
  the height channels. LFE channels are now excluded from detection but still gained.
- **Mono sources were silently exported as dual mono.** The channel count now follows the
  source unless a stereo process is engaged, and the report states what happened.

### Fixed — formats and metadata

- **7.1.2 and 7.1.4 channel masks were wrong.** `Rtf` was assigned `TOP_FRONT_CENTER`
  (`0x2000`) instead of `TOP_FRONT_RIGHT` (`0x4000`), and `Rtr` was assigned
  `TOP_BACK_CENTER` (`0x10000`) instead of `TOP_BACK_RIGHT` (`0x20000`). Because
  `WAVE_FORMAT_EXTENSIBLE` orders channels by mask bit, every such file was **mis-ordered as
  well as mis-labelled**.
- **`Lrs`/`Rrs` metadata disagreed with the renderer by 15°** — labelled `M+135`, positioned
  at ±150°. Both now ±135°, per BS.2051.
- **AIFF `SSND` was not word-aligned** for odd-length payloads.
- **`bext` loudness fields were left zero** despite the data being available. Now populated
  from the actual analysis using BS.1770 channel weights.
- **`chna` was written after `data`.** Now before, so a streaming parser sees the routing
  first.
- **No 4 GB guard.** WAV and AIFF now refuse rather than writing a wrapped size field.

### Fixed — security and reliability

- **Stored XSS via filename.** The batch list interpolated `file.name` into `innerHTML`; a
  file called `<img src=x onerror=alert(1)>.wav` executed script on drop. All dynamic text
  now goes through `textContent`.
- **Preset files were applied with no validation.** `Object.assign(P, j.P)` accepted
  `width: 1e9`, `ceiling: +40` and arbitrary keys. Now size-limited, type-checked,
  key-filtered and range-clamped.
- **`lamejs` was loaded from a CDN at page load**, breaking offline MP3 export, requiring a
  relaxed CSP, and letting a third party change executing bytes. Now a pinned local
  dependency, code-split so the WAV path does not pay for it.
- **Object URLs were revoked after a fixed 2 s**, which can truncate a large download. Now
  tracked and revoked on `pagehide` or after 60 s.
- **Filenames were not sanitised.** Path separators, control characters, Windows-forbidden
  characters, reserved device names and length are all handled now.
- **Unhandled rejections were surfaced but not prevented.**

### Fixed — the repository itself

- **The application did not run.** `index.html` referenced `./src/styles.css` and
  `./src/app.js`; both files were at the repository root. The published repository served an
  unstyled page and a 404. `README.md` and `ARCHITECTURE.md` both described the `src/` layout
  as if it existed.
- Duplicated `<!DOCTYPE html>` on lines 1–2 of `index.html`.

### Changed

- **Architecture.** The 1 709-line `app.js` monolith is now ~60 modules under `src/`, with
  every numeric routine a pure function over plain typed arrays so the whole DSP layer is
  testable in Node.
- **Parameter schema.** Every user-facing value is declared once in `app/parameters.js` with
  its type, range, unit, formatter and preview/export support. Controls, labels, badges,
  clamping and documentation are all generated from it.
- **State.** One validated store with change subscriptions, 60-step undo/redo, debounced
  autosave and deterministic reset, replacing a global mutable object.
- **Preset application is deterministic.** Unlisted parameters return to their defaults.
  Previously loudness settings and the match curve were preserved, so the same preset gave
  different results depending on what preceded it. Only the match curve — a measurement of
  your source — still survives.
- **UI labels are generated from the filter definitions.** The interface said "Warmth — low
  shelf 170 Hz" about a shelf at 120 Hz, "Body — peaking 700 Hz" about one at 350 Hz, and
  "Clarity — presence shelf" about a peaking filter. They cannot drift again.
- **"Phase rotation" renamed "Side comb / all-pass blend"**, because that is what it is.
- **Multiband amount now displays its threshold and ratio** instead of an arbitrary 0–100.
- **Four presets moved from −0.5 dBTP to −1.0 dBTP.** Not enough headroom for lossy delivery.
- **Analysis moved to a Web Worker** with latest-wins scheduling. The previous build fired a
  full offline re-render 480 ms after every slider movement with no cancellation.
- **The render loop allocates nothing per frame.** It previously allocated six
  `Float32Array`s per frame (~1.5 MB/s at 60 fps) and reassigned `canvas.width` on the
  waveform every frame. It is now capped at ~40 fps and stops when the tab is hidden.

### Added

- **Verified render reports.** Downloadable JSON with the analysis before and after, the
  normalisation gain, the maximum and average gain reduction, the achieved true peak, mono
  compatibility per band, the texture seed and any warnings. Measured, not predicted.
- **Signal-flow view** with per-module bypass and a visual distinction between live and
  export-only stages.
- **Crossover reconstruction diagnostic** — plots the summed response at the current mix,
  with the pre-7.0 topology available as an overlay.
- **Per-band gain-reduction meters**, plus solo, bypass and optional auto make-up.
- **Mono, side, left and right audition** paths, never applied to an export.
- **Phase-risk warnings** from both the parameter set and the measured per-band mono
  compatibility.
- **Optional dither** — none, TPDF, or 2nd-order noise shaping. Never applied to 32-bit float.
- **Deterministic texture seed** with a randomise control.
- **Loudness history graph** — short-term series against the target.
- **Reference matching rebuilt** — frames spread across the whole track, silence rejection,
  loudness-independent comparison, cross-band smoothing, boundary tapering, broad/balanced/
  precise modes, and a confidence score with warnings.
- **Channel-map export** (`.txt` and `.json`) for every immersive layout.
- **Channel identification export** — tone bursts through each channel in turn.
- **Command palette** (`⌘K` / `Ctrl+K`) covering every preset, tab and action.
- **Undo/redo** and **autosaved session state**.
- **Render history** with re-downloadable reports.
- **Preset comparison** — hold to hear the previous preset.
- **About tab** with live capability probing and the generated live-versus-export matrix.
- **Preset audit notes**, shown in the interface, with enforced safety rules.
- **AIFF 16-bit** alongside 24-bit; **88.2 kHz** export.
- **Accessibility**: ARIA tab pattern with arrow-key navigation, `role="switch"` toggles,
  `aria-valuetext` on every slider, label association throughout, visible focus rings, a
  skip link, live regions, `prefers-reduced-motion` and `prefers-contrast` support.
- **Resource guards** with explicit warnings and refusals.
- **544 automated tests** plus 37 Playwright specs.
- **ESLint, Prettier, CI, issue and PR templates, and ten technical documents.**

### Removed

- The root-level `app.js`, `styles.css` and `ARCHITECTURE.md` monolith.
- The CDN `<script>` tag for `lamejs`.
- Claims not backed by the implementation: "certified", "BS.1770" without qualification,
  "crossfeed-based HRTF", "real tape", and the implication that an ADM export is an Atmos
  master.

### Known issues

See [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md).

---

## [6.0.0] — earlier

The standalone HTML application, moved into a repository structure. Preserved in git
history; audited in [`docs/AUDIT.md`](docs/AUDIT.md).
