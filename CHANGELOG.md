# Changelog

All notable changes to Signal Rot // Master.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed — continuity maintenance

- The transport **Match loudness** button had two click listeners that toggled the
  setting twice. The enhanced strip now owns both match controls, with a real-bootstrap
  regression test preventing duplicate wiring.
- Added the general `documentation` matcher while preserving the merged domain Labeler rules.
- Updated preset/schema and DSP docs to the merged transparency/gain-staging contracts;
  clarified that general CI and browser conformance are still templates, not active gates.

### Added — visual organisation

- **Domain colour system.** Seven colours (violet DSP, azure Spatial, chartreuse Runtime,
  fuchsia Export, sky Testing, pink UI, slate App) now code the repository's major areas
  consistently: `--dom-*` design tokens in `src/styles/tokens.css` (both themes, contrast
  ≥ 4.5:1 computed), the palette of every diagram in `docs/` and the README, and the
  `area:*` GitHub labels applied by `.github/labeler.yml`. The two signal accents
  (`--orig`/`--proc`) are untouched and domain hues never appear in meters or controls —
  spec in `docs/COLOR-SYSTEM.md`, sync enforced by `tests/app/visual-system.test.js`.
- **Diagram set.** Colour-coded architecture flow (README + `docs/ARCHITECTURE.md`, with
  measured file/line counts and the runtime island drawn honestly: contracts tested, not
  yet consumed), signal path with stage-ownership table (`docs/DSP-SIGNAL-FLOW.md`),
  module map (`docs/ARCHITECTURE.md`), workstream ownership and the findings loop
  (`docs/WORKSTREAMS.md`), and the four-gate testing pipeline with real suite sizes
  (`docs/TESTING.md`).
- **Stale counts refreshed from the real tree:** 72 presets in 8 groups (was 68/7), and
  1,068 Vitest tests with per-suite counts (was 971 in the README / 544 in `docs/TESTING.md`,
  `ci/README.md`, `docs/BROWSER-COMPATIBILITY.md`).

### Changed — transparency-first mastering engine

- **New flagship preset: `Reference HD`** (`-15 LUFS`, `-1 dBTP`, no saturation, no
  drive, gentle slow-glue multiband), heading a new eighth catalogue group
  (`mastering`) alongside `Balanced Modern`, `Modern Loud` and `Quiet Dynamics`.
- **Source-aware adaptation.** Both preview and export measure the source (integrated
  loudness, LRA, crest factor, true peak, tonal shape) and scale processing down-only:
  already-loud/dense sources get minimal compression, saturation and drive; dynamic
  sources keep their dynamics; bright sources get no HF lift; bass-heavy sources get
  bass control plus a centred sub. Every softening is listed in the render report.
- **Loudness ambition guard.** Refinement passes are scored for loudness _and_
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
  level-matches the master to the source for honest comparison. The enhanced-strip
  keyboard integration remains tracked in [#13](https://github.com/zazieproductions/Signal-Rot-Audio-Mastering-Suite-/issues/13).
- **Preview/export consistency.** Input drive now trims to −6 dB for hot sources; the
  monitor safety limiter is gentler; preview and export share the same adaptation
  function and the same adapted parameters.

### Added — export interoperability and delivery tooling

- **Independent export validation.** New `tools/export-validation/` contains a RIFF /
  RF64 / BW64 / `bext` / `chna` / `axml` parser and an ADM structural validator written
  from the published specifications, sharing no code with Signal Rot's writers, plus an
  FFmpeg adapter. `npm run validate:exports` generates deterministic fixtures with the
  production encoders and validates them with all three, emitting a machine-readable
  report. The guiding principle: Signal Rot should not have to trust itself to prove that
  its own files are valid.
- **ADM structural validation in CI.** Namespaces, element nesting, required attributes,
  BS.2076 ID grammar, `typeLabel` ⇄ `typeDefinition` ⇄ ID-digit agreement, cross-reference
  resolution, DirectSpeakers semantics, coordinate ranges, `speakerLabel` ⇄ azimuth
  agreement, and `chna` ⇄ `axml` ⇄ `fmt` consistency. Schema validation against the
  normative BS.2076 XSD remains opt-in (`npm run validate:adm -- --xsd <path>`) because the
  ITU does not license the schema for redistribution; the report records
  `admSchemaValidated: false` and CI asserts it.
- **Golden multichannel fixtures** for 5.1, 7.1, 7.1.2, 7.1.4, 9.1.6 and Sonic Lab 20.4,
  at 16/24/32-bit plus ADM BWF, carrying channel-identification content: channel _N_ emits
  _N_ beeps then a tone on a chromatic ladder. The channel order is recovered from the
  decoded **audio**, not from the metadata, so a swap, a rotation or a left/right flip
  fails the build.
- **RF64 / BW64 support.** `src/audio/encode/riff-layout.js` plans the container and
  promotes to BW64 (or RF64 on request) when sizes exceed 32 bits, writing a correct
  28-byte `ds64` chunk and the `0xFFFFFFFF` sentinel. Small files stay ordinary RIFF. A
  wrapped 32-bit size is never written. The boundary is tested exhaustively without
  allocating a 4 GiB buffer.
- **Streaming writer lifts the ~2 GiB browser export ceiling.** Direct WAV and
  immersive/ADM exports estimated above 256 MiB now stream straight to a user-chosen
  file via the File System Access API (`showSaveFilePicker`, Chromium-based browsers),
  writing in 4 MiB blocks through new `StreamSink`/`CollectSink` byte sinks. Peak live
  memory is one block plus the header instead of the whole file, the planner's
  ArrayBuffer ceiling is bypassed on disk streams (only RF64/BW64 64-bit limits
  remain), and a failure mid-stream aborts the partial file. Browsers without the API
  keep the instant download. The streaming encoders share their container plan, chunk
  writers and PCM encoders with the in-memory encoders, and the outputs are asserted
  byte-identical for every layout × bit depth (plus forced BW64), then re-validated by
  the independent RIFF/ADM parser and decoder — 56 new tests in
  `tests/format/wav-stream.test.js` and
  `tests/interoperability/stream-round-trip.test.js`.
- **Delivery profiles** (`stereo-distribution`, `film-video`, `high-res-archive`,
  `bed-714`, `sonic-lab-204`, `adm-ingest`) that alter format and metadata only — a test
  asserts no profile carries a DSP field.
- **Delivery packages and manifests.** `buildDeliveryPackage()` assembles the master,
  channel maps, a channel-identification file, a render report, an auditable JSON manifest,
  a plain-language README and `SHA256SUMS.txt`. The manifest discloses up-mix and
  synthetic height, states exactly what validation was and was not performed, and hard-wires
  `atmosCertified: false`.
- **SHA-256 integrity support**, verifiable with `sha256sum -c SHA256SUMS.txt`, documented
  as file-integrity checks and explicitly not audio fingerprints.
- **Hostile-metadata hardening.** 195 tests covering Unicode, emoji, lone surrogates,
  ampersands, XML-breaking characters, control characters, 10 000-character names, invalid
  channel counts, zero-length input and odd chunk sizes. Every writer now produces a valid
  file or refuses clearly.
- **CI interoperability gate** (`.github/workflows/export-interoperability.yml`) using only
  open-source tooling, which fails on a malformed file _and_ on a report that claims more
  than it established.
- **`docs/EXPORT-INTEROPERABILITY.md`** — what is verified, the terminology used precisely,
  reproducible external inspection commands, and 17 explicitly stated remaining limitations.

### Fixed — export formats

- **ADM `typeLabel` was `0003` (Objects) on documents declaring
  `typeDefinition="DirectSpeakers"`.** BS.2076 §5.2 requires the type digits embedded in an
  `AC_`/`AP_`/`AS_`/`AT_` identifier to match the element's `typeLabel`, so the emitted
  documents were internally contradictory. All identifiers now use `0001`
  (DirectSpeakers): `AC_00031001` becomes `AC_00011001`, and so on. Found by the new
  independent validator.
- **`bext` fields corrupted non-ASCII input.** The fixed-width ASCII writer masked every
  code point with `& 0x7f`, silently turning an em-dash into a control character and an
  embedded NUL into a premature terminator. Non-ASCII now becomes `?`, NULs are dropped,
  and over-long input truncates rather than wrapping.
- **ADM XML could be made not well-formed by a hostile programme name.** Characters XML 1.0
  cannot represent (NUL, `\u0001`–`\u001f`, non-characters) were escaped rather than removed
  — but `&#0;` is equally forbidden, so the result was a document no parser would open.
  They are now stripped, lone surrogates become `U+FFFD`, and names are clamped to 256
  code points on a code-point boundary.
- **An empty or all-control-character programme name produced an empty required
  `audioProgrammeName` attribute.** The fallback is now applied after sanitising.
- **`writeWav` accepted a 0 Hz sample rate and 0 channels**, producing a `fmt` chunk with a
  zero `byteRate` and `blockAlign` that a decoder can only guess at. Both are now refused,
  as is a channel array shorter than the declared frame count.

### Added

- **Browser conformance + golden audio regression lab.** Real-`OfflineAudioContext`
  measurements of `DynamicsCompressorNode`, `WaveShaperNode`, the multiband wet/dry
  path, sample-rate support (44.1–192 kHz including 176.4), preview/export graph
  parity, immersive speaker feeds (5.1 through Sonic Lab 20.4) and render-time
  benches, plus a synthesised fixture bank and a baseline-vs-candidate comparer
  that distinguishes REFERENCE / CLEAN behaviour from CREATIVE / SIGNAL ROT.
  Production DSP is not modified. See `docs/CONFORMANCE.md` and
  `docs/AUDIO-REGRESSION.md`.
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
