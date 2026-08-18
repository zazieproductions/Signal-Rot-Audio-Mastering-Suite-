# Signal Rot Mastering Suite

A browser-native audiophile mastering and immersive-audio laboratory built on the Web Audio API.
Signal Rot is a serious mastering tool and an experimental sonic laboratory: loudness,
true-peak limiting, mastering EQ, multiband dynamics, transient shaping, reference matching,
mid/side and width processing, analog character, depth, and immersive upmixing — with an
honest, instrument-like industrial interface.

## Quick start

```bash
npm install
npm run dev        # Vite dev server (open the printed URL)
npm run build      # production build → dist/
npm run preview    # serve the production build
npm run test       # Vitest unit + boot smoke tests
npm run lint       # ESLint
npm run check      # lint + test + build (CI gate)
```

## Features

- **Mastering chain** — input drive, 6-band tone EQ + tilt, 3-band multiband compressor
  (LR4 crossovers, parallel mix, per-band bypass/solo), transient shaper, saturation,
  reference-match EQ, per-band stereo width, depth engine, and analog character.
- **Loudness** — BS.1770-style gated integrated LUFS/LRA (K-weighting implemented directly),
  loudness normalization, look-ahead true-peak limiting with post-render verification.
- **Meters & scopes** — integrated/short-term/momentary LUFS, true peak, LRA, RMS,
  correlation, spectrum, goniometer (vectorscope), and live gain-reduction readouts.
- **Stereo safety** — mono / mid / side audition, bass-mono, phase-risk and correlation
  warnings, per-module bypass, and a visual signal-flow view.
- **Analog character** — tape wow/flutter + head bump, hiss, vinyl crackle/rumble, all driven
  by a deterministic texture seed so exports are reproducible and preview matches export.
- **Exports** — WAV 16/24-bit, WAV 32-bit float, AIFF 24-bit, MP3 320 kbps (locally bundled
  encoder, no CDN), multichannel WAV, ADM BWF (BS.2076-style interchange), channel-ID test
  tones, channel-map JSON, and a JSON render report (LUFS/true-peak before & after, gain
  reduction, ceiling verification, seed, dither, timestamps).
- **Immersive** — 5.1 / 7.1 / 7.1.2 / 7.1.4 / 9.1.6 and the Sonic Lab 20.4 periphonic layout
  (Anton Bruckner Privatuniversität, Linz), with binaural monitor fold-down and a speaker map.
- **Sessions** — undo/redo, autosaved session state, JSON session/preset import/export,
  theme switching, keyboard controls, and browser capability diagnostics.

## Repository structure

```text
signal-rot-mastering-suite/
├── index.html            # application shell
├── src/
│   ├── main.js           # entry point
│   ├── styles.css        # dark industrial laboratory theme (+ light theme)
│   ├── app/
│   │   ├── state.js      # canonical state, undo/redo, session persistence
│   │   ├── engine.js     # audio graph, offline render, export, immersive, batch
│   │   └── ui.js         # DOM wiring, meters, scopes, controls, flow view
│   ├── lib/
│   │   ├── math.js       # dB/gain, PRNG, filename sanitization
│   │   ├── dsp.js        # saturation, true-peak, LUFS/LRA, FFT, transient, match EQ
│   │   ├── limiter.js    # look-ahead true-peak limiter + verification
│   │   ├── encode.js     # WAV / AIFF / MP3 / multichannel / ADM writers + dither
│   │   ├── layouts.js    # immersive speaker metadata + channel maps
│   │   ├── params.js     # parameter schema, ranges, validation, migration
│   │   ├── presets.js    # preset catalogs + validation
│   │   ├── notify.js     # toast / download helpers
│   │   └── version.js    # engine version stamp
│   └── workers/
│       └── analysis.worker.js   # loudness + true-peak off the main thread
├── tests/                # Vitest unit tests + jsdom boot smoke test
├── ARCHITECTURE.md       # signal flow + DSP behavior + limitations
├── vite.config.js
├── eslint.config.js
└── package.json
```

## Honesty notes

Signal Rot is built to sound good *and* to tell the truth about what it is doing:

- **Loudness** is a BS.1770-style gated measurement (K-weighting, 400 ms blocks, absolute
  −70 LUFS and relative −10 LU gates). It is **not** a formally certified ITU-R BS.1770
  meter. The live meter analyzes the first 90 s; the export report always measures the
  full track.
- **True peak** uses 4× polyphase oversampling with a 100-tap Kaiser-windowed sinc
  (flat to 18 kHz, −0.07 dB @ 19 kHz). The limiter is stereo-linked with lookahead,
  soft knee, and program-dependent release, then the final file is **re-measured** and a
  warning is shown if the ceiling was exceeded.
- **Saturation and tape/vinyl character are stylized**, not physical component modeling.
- **Reference matching is broad tonal matching**, not cloning: net-gain bias is removed and
  per-band correction is clamped to ±8 dB.
- **Immersive upmixing is synthetic** — matrix-derived center, decorrelated surrounds,
  synthesized height. It does **not** create true object-based Atmos information, and the
  ADM BWF is an uncompressed interchange bed, **not** a certified Dolby master.
  Binaural monitoring is a fixed-HRTF fold-down, not a head-tracked renderer.

See `ARCHITECTURE.md` for the full signal-flow map and known limitations.

## Browser support

Any modern browser with `AudioContext`, `OfflineAudioContext`, and Web Workers
(Chrome/Edge, Firefox, Safari 14+). Audio decoding relies on the browser's codecs —
Chromium decodes the widest set (WAV, MP3, FLAC, AAC/M4A, Ogg). MP3 export is encoded
locally and needs no network access.
