# Architecture

## Runtime flow

1. `index.html` defines the shell, controls, canvases, and file inputs.
2. `src/main.js` boots `src/app/ui.js`.
3. `ui.js` wires the DOM to `engine.js` and the canonical state in `state.js`.
4. Imported audio is decoded into an `AudioBuffer` by the browser.
5. A live graph (built once per session) auditions and feeds the meters/scopes.
6. Offline graphs render analysis passes and the final mastering export.
7. Immersive rendering derives multichannel beds, ADM BWF, or binaural fold-downs from the
   processed stereo master.

## State model

`src/lib/params.js` is the single source of truth for every parameter: key, default,
range/enum, and (for a few) a catalog-form conversion. All mutations flow through
`src/app/state.js`, which:

- coerces and clamps every value (`clampState` / `catalogToState`),
- records undo/redo history (drag gestures coalesce into one step),
- autosaves a versioned session to `localStorage` and restores it on load,
- validates imported session/preset JSON and supports older preset files.

## Live signal flow

```
source ─▶ inGain(drive)
        ─▶ reference-match EQ (8 peaking bands)
        ─▶ mastering EQ (sub/warm/body/harsh/clarity/air/tilt)
        ─▶ 3-band multiband compressor (LR4 @ 140 Hz / 3.2 kHz, parallel mix)
        ─▶ M/S matrix:
              mid = 0.5L+0.5R   side = 0.5L−0.5R
              side: bass-mono HP → per-band width (LR4 @ 250 Hz / 4 kHz) → width
                    → phase-rotation (direct/allpass crossfade)
              reconstruct L/R → Haas delay → crossfeed
        ─▶ analog character (tape delay + head bump + vinyl LP, plus seeded noise beds)
        ─▶ depth engine (two filtered early-reflection taps)
        ─▶ DC block (5 Hz) → saturation (pre-backoff → WaveShaper 4× → post-makeup → lowpass)
        ─▶ outGain → live safety limiter → audition matrix (stereo/mono/side) → monitor
```

Every module has a bypass flag; the **Flow** tab shows the chain and lets each module be
auditioned in isolation. Bypasses affect preview and export identically.

## Export flow (offline)

1. Render the full chain through an `OfflineAudioContext` (seeded noise = live noise).
2. Transient shaping (sample-accurate, export-only — the live native graph cannot do it).
3. Loudness normalization to target LUFS (measured on the rendered buffer).
4. Look-ahead true-peak limiting to the chosen ceiling (skipped if the limiter is bypassed).
5. Post-render true-peak **verification** (warns if the ceiling was exceeded).
6. Encode (WAV/AIFF/MP3/multichannel/ADM) with optional seeded TPDF dither on integer
   formats (never on float), and emit a JSON render report.

Preview and export differ by design and are marked as such:
**preview-only** = soft safety limiter, first-90 s loudness;
**export-only** = transient shaping, normalization, look-ahead limiting, dither, report.

## DSP details

| System | Implementation | Status |
| ------ | -------------- | ------ |
| Loudness | BS.1770-style K-weighting (biquad shelf + highpass), 400 ms blocks 75 % overlap, absolute + relative gates | approximate, gated |
| True peak | 4× polyphase oversampling, 100-tap Kaiser (β=10) sinc | verified in tests |
| Limiter | stereo-linked, 2.5 ms lookahead, soft knee, program-dependent release | verified |
| Multiband | LR4 via cascaded Butterworth biquads (Q=0.7071) + DynamicsCompressor per band | crossovers sum flat (design) |
| Saturation | DC-free asymmetric tanh blend, unity-normalized, pre-backoff/post-makeup | stylized |
| Character | delay-line wow/flutter, seeded hiss/crackle/rumble, head bump, vinyl LP | stylized |
| Reference match | FFT fingerprint, 8 bands, net-gain removed, ±8 dB clamp | tonal match, not cloning |
| Immersive | matrix center, decorrelated surrounds, synthesized height, HRTF panners | synthetic upmix |

## Immersive layouts

`src/lib/layouts.js` owns the speaker table (azimuth/elevation/ADM labels) and channel
orders. Multichannel WAV uses WAVE_FORMAT_EXTENSIBLE with the Microsoft channel-mask order
(document in the channel-map JSON); ADM BWF self-describes routing via `chna`/`axml`.
The **Sonic Lab 20.4** map (24 channels: ear/ground/high/roof rings + 4 subs) is exported
as machine-readable JSON with per-channel azimuth/elevation/label.

## Testing

- `npm run test` — Vitest. Pure-DSP tests use generated signals only.
- `tests/boot.test.js` — jsdom smoke test that boots the real `index.html` and exercises
  preset selection, module bypass, theme, and monitor-matrix switching.
- `npm run check` — lint + test + build (use as the CI gate).

## Known limitations

- LUFS/LRA are not certified; the live meter uses a 90 s window.
- True-peak reconstruction droops near Nyquist (−0.55 dB @ 20 kHz) — an inherent property
  of a finite 4× reconstruction filter; it never over-estimates steady-state level.
- Multiband uses native `DynamicsCompressor` nodes (no lookahead control); the parallel
  dry/wet blend is a linear crossfade.
- HRTF binaural monitoring uses the browser's built-in HRTF panner (not measured IRs).
- Immersive output is a synthesized bed, not object-based audio; ADM is not certified Dolby.
- Playwright browser tests are not wired in this environment (no browser available to
  download); see the roadmap.

## Roadmap

- Playwright end-to-end tests (import → preset → slider → A/B → export) once a browser is available.
- Optional 192 kHz-only render paths behind an explicit toggle to avoid needless CPU cost.
- A proper half-band polyphase bank for sample-rate conversion above 2×.
- WavPack/FLAC encode via a WASM codec for lossless delivery.
- Grid-snappable EQ curves and per-band match-EQ editing.
