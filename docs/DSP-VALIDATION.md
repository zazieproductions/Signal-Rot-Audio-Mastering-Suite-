# DSP validation

Every number here was produced by running the code in this repository against
the original implementation at commit `5c0621e`. The measurement scripts are
the tests in `tests/`; where a figure came from an ad-hoc comparison the method
is described so it can be reproduced.

The point of this document is to be honest about what actually improved, by how
much, and what it cost. Several things I expected to be broken turned out to be
fine, and one change is a deliberate performance regression.

---

## 1. Loudness — ITU-R BS.1770-4 / EBU R 128

### Integrated loudness: was already accurate

The original K-weighting used a 1500 Hz / +4 dB / Q 0.707 shelf and a 38 Hz
Q 0.5 high-pass, hand-approximating the filters that BS.1770-4 specifies as
48 kHz coefficient tables. I expected this to drift on spectrally-tilted
material. It does not.

| Signal | Original | This repo | Difference |
| --- | ---: | ---: | ---: |
| 1 kHz tone, −23 dBFS | −23.03 | −22.99 | 0.04 LU |
| 1 kHz tone, −33 dBFS | −33.03 | −32.99 | 0.04 LU |
| White noise | −18.66 | −18.62 | 0.04 LU |
| Low-passed noise | −33.68 | −33.64 | 0.04 LU |
| High-passed noise | −5.90 | −5.86 | 0.04 LU |
| 10 kHz tone | −19.69 | −19.65 | 0.04 LU |
| 100 Hz tone | −24.86 | −24.82 | 0.04 LU |

The error is a constant 0.04 LU offset, not a spectral tilt — the approximated
shelf happened to be very close in shape. Replacing it with the standard's
filter is a conformance fix, not an audible one.

The filter is now derived analytically from the analogue prototype and
bilinear-transformed at the session rate. At 48 kHz it reproduces the
BS.1770-4 Table 1 and Table 2 coefficients to six decimal places
(asserted in `tests/loudness.test.js`), and it stays correctly warped at
44.1 / 88.2 / 96 / 192 kHz rather than reusing 48 kHz coefficients.

### Loudness Range: was badly broken

EBU Tech 3342 requires 3 s short-term blocks with a 1 s hop and a −20 LU
relative gate. The original used 400 ms momentary blocks and a −10 LU gate.

| Tech 3342 case | Expected | Original | This repo |
| --- | ---: | ---: | ---: |
| 1: −20 / −30 dBFS | 10 ±1 LU | 10.00 | 10.00 |
| 2: −20 / −15 dBFS | 5 ±1 LU | — | 5.00 |
| 3: −40 / −20 dBFS | 20 ±1 LU | **0.00** | 20.00 |
| 4: −50 / −35 dBFS | 15 ±1 LU | **0.00** | 15.00 |

Cases 3 and 4 returned zero. With a −10 LU gate instead of −20 LU, the quiet
half of the programme falls below the relative threshold and is discarded, so
the meter sees a single loudness and reports no range at all. Case 1 passed by
coincidence — a 10 LU spread is exactly at the boundary where the wrong gate
still keeps both halves.

Any material with more than ~10 LU of genuine range was reported as having
none, which makes the LRA readout actively misleading for the dynamic
classical and ambient content several of the presets target.

### Multichannel

The original hard-coded `min(2, numberOfChannels)`, so a 5.1 or 7.1.4 render
was metered from L/R alone. This repo applies the BS.1770 `G` weights (1.0
front, 1.41 surround) and excludes the LFE, as the standard requires.

### Compliance status

`tests/loudness.test.js` asserts EBU Tech 3341 cases 1–5 and Tech 3342
cases 1–4, plus sample-rate independence and LFE exclusion. All pass.

---

## 2. True peak — BS.1770-4 Annex 2

### Measurement

The original estimated inter-sample peaks with 4x Catmull-Rom interpolation.
Ground truth for a sine is its amplitude, so the error is directly measurable.
Signals were fade-windowed first, because zero-padding at a hard file boundary
produces a real step discontinuity whose overshoot would otherwise dominate.

| | Worst error, 1–20 kHz |
| --- | ---: |
| Catmull-Rom (original) | **−1.25 dB** (at 16 kHz) |
| Polyphase FIR (this repo) | −0.52 dB, within ±0.35 dB below 20 kHz |

Catmull-Rom is exact for most frequencies but collapses where sampling is
degenerate: 16 kHz at 48 kHz is three samples per cycle, and it reads
−2.25 dBTP for a signal whose true peak is −1.00 dBTP. Under-reading is the
dangerous direction — it certifies a master as safe when it is not.

The coefficient table was verified as a filter, not just transcribed: the four
phases interleaved into a 48-tap prototype give a flat passband
(11.93–12.12 dB, i.e. the 4x interpolation gain ±0.1 dB) from DC to 20 kHz and
−32 dB by 30 kHz. Above 20 kHz the filter rolls off, so measurement there reads
low; this is a property of the filter the standard specifies.

### Limiting — the significant fix

Applying a time-varying gain reshapes the waveform, so the reconstruction
filter sees inter-sample peaks that were not in the input. A single gain pass
therefore does not deliver the ceiling it was asked for. The original never
re-checked.

Measured on 60 s of white noise at 0.9 amplitude, ceiling −1.0 dBTP:

| | Result | Time |
| --- | ---: | ---: |
| Original | **+2.80 dBTP** | 733 ms |
| This repo | −0.99 dBTP | 2356 ms (2 passes) |

The original overshot its target by 3.8 dB and delivered a master that clips.

**This change is a 3x performance regression, deliberately.** The polyphase
filter does 48 multiply-accumulates per sample where cubic did 16, and the
limiter runs more than one pass. The trade is compute for a ceiling that
actually holds. Mitigations already applied:

- The oversampling loop was split into a bounds-checked edge path and an
  unchecked interior path reading a flat `Float64Array` of coefficients.
  Measurement of 60 s of mono went from ~5 s to 330 ms.
- Corrective passes stop within 0.01 dB of the ceiling and aim marginally
  under it. Without that tolerance the limiter chased vanishing overshoots and
  always ran to the 6-pass cap; it now converges in 2.

A 5-minute stereo export costs roughly 12 s of limiting. That runs behind the
existing progress bar. Moving it off the main thread is tracked in
`docs/ARCHITECTURE.md`.

### Look-ahead

The forward minimum is now a monotonic deque, O(n) regardless of window
length, replacing a rescan of the whole window at every sample. At the default
2.5 ms look-ahead this is **not** where the time goes — my initial assumption
that it cost "minutes" was wrong, and V8 optimises the naive scan well. The
deque costs nothing and keeps longer look-ahead settings affordable.

---

## 3. Fixed-point export

- **No dither existed.** 32-bit float was rounded straight to 16- or 24-bit
  integers. Undithered truncation correlates quantisation error with the
  signal, which is audible on fades and tails as granular distortion. TPDF
  dither is now the default at 16-bit, with optional second-order noise
  shaping; 24-bit defaults to none and 32-bit float is never dithered.
  `tests/export.test.js` asserts that dithering measurably decorrelates the
  error from the signal on a signal spanning only a few LSBs.
- **Asymmetric quantisation.** Negative samples were scaled by 0x8000 and
  positive by 0x7FFF, applying a different gain to each half of the waveform.
  A single scale with clamping is now used.
- **Odd-length chunks were not padded.** RIFF and AIFF both require chunks to
  begin on even boundaries. 24-bit mono with an odd frame count produced a
  malformed file. Both encoders now pad, and the tests parse the output with a
  chunk walker that enforces alignment.

---

## 4. Immersive channel routing

`dwChannelMask` bit assignments are fixed by WAVEFORMATEXTENSIBLE. Three
entries were mapped to the wrong bit:

| Channel | Was | Meaning of the old bit | Now |
| --- | --- | --- | --- |
| `Rtf` top front right | `0x2000` | TOP_FRONT_**CENTER** | `0x4000` |
| `Rtr` top rear right | `0x10000` | TOP_BACK_**CENTER** | `0x20000` |
| `Lw` / `Rw` front wides | `0` | (none) | `0x40` / `0x80` |

A 7.1.4 export therefore declared its right-hand height channels as centre
channels, and a conforming renderer placed that content in the middle of the
room.

Separately, the rear surrounds were rendered at ±150° while their ADM labels
declared `M+135` / `M-135`. ITU-R BS.2051 systems C/D specify ±135°, so the
binaural preview and the exported metadata described rooms 15° apart. The
renderer now matches the label. This was caught by a test asserting that every
speaker's ADM azimuth is the exact mirror of its renderer azimuth.

---

## 5. Behavioural fixes in the application layer

- **Saturation make-up gain was dropped from the live preview.**
  `setChainParams` parked the make-up gain on `outGain`; `applyParamsToGraph`
  then overwrote it. Up to ~2 dB of make-up applied on export was missing while
  auditioning, so the preview was quieter than the render.
- **Batch export skipped transient shaping.** The batch path inlined its own
  render sequence that omitted the transient shaper, so batching a preset with
  attack or sustain produced different audio than exporting the same track
  individually. Both paths now call `renderMaster`.
- **The analysis window cap was commented but never implemented.** The code
  said "cap analysis length for speed (first 90s)" and then rendered the entire
  file on every parameter change. The cap is now real, and the A/B sides are
  measured over the same span so their loudness figures are comparable.

---

## Reproducing

```bash
npm ci
npm test          # 101 assertions across DSP, encoders, layouts and app boot
npm run coverage  # skips the timing test; v8 instrumentation distorts it
npm run lint
```
