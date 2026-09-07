# Changelog

All notable changes to Signal Rot // Master.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed — transparency-first mastering engine

- **New flagship preset: `Reference HD`** (`-15 LUFS`, `-1 dBTP`, no saturation, no
  drive, gentle slow-glue multiband), heading a new eighth catalogue group
  (`mastering`) alongside `Balanced Modern`, `Modern Loud` and `Quiet Dynamics`.
- **Source-aware adaptation.** Both preview and export measure the source (integrated
  loudness, LRA, crest factor, true peak, tonal shape) and scale processing down-only:
  already-loud/dense sources get minimal compression, saturation and drive; dynamic
  sources keep their dynamics; bright sources get no HF lift; bass-heavy sources get
  bass control plus a centred sub. Every softening is listed in the render report.
- **Loudness ambition guard.** Refinement passes are scored for loudness *and*
  cleanliness; average limiter reduction beyond 3 dB stops the push and the engine
  delivers a quieter master instead of a crushed one (`ambitionReduced`, reported).
- **Conservative retunes.** Multiband mapping is now −24 dB / 3:1 at full scale with a
  12 dB knee and transient-friendly attacks; saturation drive, asymmetry and make-up
  reduced; limiter defaults widened (3 ms look-ahead, 1.5 dB knee, 25/220 ms release);
  every clean preset rebalanced (less drive/saturation/EQ stacking); loud targets
  (`> −12 LUFS`) carry a caution flag.
- **Mastering vs creative families.** `mastering` presets can never contain tape, hiss,
  vinyl, Haas or side-comb DSP — enforced in the catalogue and scrubbed at apply/load
  time. Degradation presets (`Tape Ghost`, `Vinyl Séance`, `Rust`, …) are explicitly
  `creative` and untouched.
- **Three-way audition: Original / Mastered / Matched (A/B/C).** The new Matched mode
  level-matches the master to the source for honest comparison; X cycles all three.
- **Preview/export consistency.** Input drive now trims to −6 dB for hot sources; the
  monitor safety limiter is gentler; preview and export share the same adaptation
  function and the same adapted parameters.

### Added

- **Twenty-eight new presets, with a seventh `restoration` group.** The catalogue grows
  from 40 to 68 presets across 7 groups. Four new signature presets per existing group
  (Dimension: `Ferric Bloom`, `Ray Field`, `Magnetic Memory`, `Aperture`; Genre: `Modern
  Country`, `Drum & Bass`, `Reggae / Dub`, `Jazz Trio`; Cinematic: `Trailer Impact`,
  `Documentary`, `Game Loop`, `Dialogue Under Score`; Mood: `Bittersweet Glow`, `Uneasy
  Calm`, `Suspended`, `Hiraeth`; Colour: `Amber`, `Slate`, `Iris`, `Chartreuse`; Spatial:
  `Depth Lens`, `Wide Awake`, `Binaural Stage`, `Polar Maze`), plus four corrective
  restoration presets (`Dull Mix Rescue`, `Harsh / Sibilance Tamer`, `Boomy Room
  Corrective`, `Broadcast Mono First`).
- **Catalogue tests tightened.** The gate now expects seven groups, asserts that
  restoration presets stay safe and conservative, anchors high-band width above 150% with
  bass-mono, and requires an explicit spread whenever binaural processing is enabled. The
  new signature presets are registered by name.

### Fixed — gain structure (driven by `docs/GAIN-STRUCTURE-AUDIT.md`)

- **The saturation stage was a hard clipper at 0 dBFS — even at `sat = 0`.** The
  `WaveShaperNode` input clamp to [−1, 1] squared off every transient that reached full
  scale (measured at 0.007–2.7 % of samples, peaks flattened by up to 5.7 dB) before the
  true-peak limiter ever saw the signal. The curve domain is now ±4 (12 dB of structural
  headroom) and the input gain divides by the same factor, so the clamp physically cannot
  engage until +12 dBFS. At `sat = 0` the curve is a straight line across that whole
  domain instead of an identity that clipped at ±1.
- **The saturator added +0.4 … +5.2 dB it was documented not to add.** The curve was
  peak-normalised but its small-signal slope exceeded unity, and the `1 + 0.25a` make-up
  sat on top — a second, uncontrolled upward compressor. The curve is now normalised to
  unity small-signal slope and the make-up node is exactly `1/preGain`: the stage is 0 dB
  for small signals at every drive setting, and `sat` controls harmonics and peak
  rounding only. The generated curve is DC-free and monotonic over the full headroom
  domain.
- **Every multiband band carried the `DynamicsCompressorNode` fixed make-up gain**
  `pow(1/Saturate(1, k), 0.6)` — up to +15.4 dB per band at deep settings, stacked three
  bands deep, mixed against an uncompensated dry path. A new engine-exact analytic model
  (`src/audio/dsp/dynamics-compressor.js`, mirroring the Blink/Gecko knee, `kAtSlope`
  search and full-scale saturation) feeds an exact inverse-gain node after each band's
  compressor, so `mbAutoMakeup` — off by default — is again the only make-up in the path,
  exactly as the code already believed.
- **The multiband parallel mix was a 6 ms comb filter.** `DynamicsCompressorNode` looks
  6 ms ahead but the phase-matched dry path was undelayed, so `mbMix < 100` combed the
  kick and body regions (notches at 83/250/417 Hz…). The dry path now carries the same
  6 ms delay, so wet and dry arrive together as well as in phase.
- **The live preview lied about level.** The monitor's safety compressor
  (−1.2 dB, 20:1) applied its own fixed +0.68 dB make-up, so what was tuned by ear sat
  above the ceiling it was meant to protect. The monitor path now compensates the make-up
  exactly, tracking the threshold when the ceiling control moves it.
- **Hot loudness targets brickwalled the record.** Nine presets target ≥ −11 LUFS; a
  12 dB-crest mix delivered −9 LUFS only via −10 dB peak / −3.1 dB average gain
  reduction. Final exports now carry a crest-aware gain-reduction budget (average ≤ 2 dB,
  peak ≤ 6 dB): when hitting the requested target would exceed it, the loop delivers the
  loudest clean master at or below the target and the render report states the requested
  vs delivered loudness and why (new `loudness.crestAware` block).

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
