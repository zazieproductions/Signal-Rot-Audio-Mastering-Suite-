# Changelog

All notable changes to this project are documented here. Measurements
supporting the audio claims are in [docs/DSP-VALIDATION.md](docs/DSP-VALIDATION.md).

## [Unreleased]

### Fixed — audio correctness

- **Loudness Range was returning 0 LU for most dynamic material.** LRA used
  400 ms momentary blocks and a −10 LU relative gate; EBU Tech 3342 requires 3 s
  short-term blocks and a −20 LU gate. Compliance cases 3 and 4 returned 0.00 LU
  where the answers are 20 LU and 15 LU.
- **True-peak limiting overshot its ceiling by up to 3.8 dB.** Asked for
  −1.0 dBTP on dense material the limiter delivered +2.8 dBTP, because applying
  a time-varying gain creates inter-sample peaks a single pass cannot see. The
  limiter now iterates until the ceiling is actually met.
- **True-peak measurement had blind spots.** Cubic interpolation under-read by
  1.25 dB at frequencies where sampling is degenerate. Replaced with the
  BS.1770-4 Annex 2 4x polyphase FIR.
- **Multichannel loudness ignored all but L/R.** Now applies BS.1770 `G`
  weighting and excludes the LFE.
- **7.1.4 exports declared their right-hand height channels as centre
  channels.** `Rtf` and `Rtr` used the TOP_FRONT_CENTER and TOP_BACK_CENTER
  mask bits. Front wides had no mask bit at all.
- **Rear surrounds were rendered 15° away from where their ADM metadata said
  they were** (±150° vs the declared ±135°). Now matches ITU-R BS.2051 C/D.
- **Fixed-point exports were undithered.** TPDF dither is now applied by
  default at 16-bit, with optional noise shaping.
- **Quantisation was asymmetric**, scaling negative samples by 0x8000 and
  positive by 0x7FFF.
- **Odd-length RIFF and AIFF chunks were not padded**, producing malformed
  files for 24-bit mono with an odd frame count.

### Fixed — application behaviour

- Saturation make-up gain was dropped from the live preview but applied on
  export, so what you auditioned was quieter than what you rendered.
- Batch export skipped transient shaping, producing different audio than
  exporting the same track individually.
- The interactive analyser re-rendered and re-measured the entire file on every
  parameter change; the 90 s cap the code claimed in a comment was never
  implemented.
- `index.html` referenced `./src/app.js` and `./src/styles.css`, but both files
  were at the repository root — **the application did not load at all** as
  committed.

### Added

- Test suite: 101 assertions across loudness, true peak, encoders, layouts,
  DSP utilities and application boot, including the EBU Tech 3341 and 3342
  compliance signals.
- Dither controls in the export panel (TPDF / noise-shaped / none).
- Rendered true-peak readout next to the ceiling setting.
- `docs/DSP-VALIDATION.md` recording measured before/after behaviour.
- ESLint configuration, `vite.config.js`, `.gitignore` and an MIT `LICENSE`,
  none of which were present.

### Changed

- Pure DSP, encoding and layout logic extracted from the 1,709-line
  `app.js` monolith into tested modules under `src/dsp`, `src/export` and
  `src/immersive`.
- Reference-match analysis no longer calls `getChannelData()` once per sample,
  and the FFT uses a twiddle table instead of an error-accumulating recurrence.
- The transient shaper's sustain control is now level-independent; it
  previously keyed off absolute amplitude, so the same setting behaved
  differently on quiet and loud mixes.
- True-peak measurement is ~15x faster via a bounds-check-free interior path.

### Performance

- **Limiting is ~3x slower than before** (2.4 s vs 0.7 s for 60 s of stereo).
  This is a deliberate trade: the polyphase filter costs 48 multiply-accumulates
  per sample against cubic's 16, and the limiter runs a second convergence pass.
  The previous implementation was faster because it stopped before the job was
  done. Moving this off the main thread is tracked in `docs/ARCHITECTURE.md`.
