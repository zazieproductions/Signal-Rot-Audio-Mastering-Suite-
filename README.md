# Signal Rot Mastering Suite

A browser-based mastering and immersive-audio laboratory built on the Web Audio
API. Import a mix, shape it with tone/dynamics/stereo/character processing,
meter it against broadcast loudness standards, and export stereo, multichannel,
or ADM BWF masters — entirely client-side. No audio ever leaves the machine.

```bash
npm install
npm run dev
```

## Features

- Import, transport, waveform overview, spectrum, goniometer and loudness meters
- Tone, loudness, multiband dynamics, transient, stereo, spatial, tape, vinyl
  and reference-match processing
- Preset catalogue across dimension, genre, cinematic, mood, colour and spatial
  groups, with JSON import/export
- WAV (16/24/32-bit), AIFF, MP3, batch, multichannel and ADM BWF export
- Immersive layouts from 5.1 through 9.1.6, plus the Sonic Lab 20.4 rig
- Dark and light themes

## Measurement conformance

Loudness and true-peak metering follow the standards rather than approximating
them, and the test suite asserts it:

- **ITU-R BS.1770-4 K-weighting**, derived analytically and bilinear-transformed
  at the session rate, reproducing the standard's 48 kHz coefficient tables to
  six decimal places and staying correct at 44.1/88.2/96/192 kHz.
- **EBU Tech 3341** integrated-loudness compliance cases 1–5.
- **EBU Tech 3342** loudness-range compliance cases 1–4.
- **BS.1770-4 Annex 2** 4x polyphase true-peak measurement.
- BS.1770 channel weighting for multichannel material, with the LFE excluded.

The true-peak limiter iterates until the requested ceiling is actually met,
because applying a time-varying gain creates inter-sample peaks that a single
pass cannot see.

`docs/DSP-VALIDATION.md` records what changed against the previous
implementation, with measurements — including one change that is a deliberate
3x performance regression in exchange for a ceiling that holds.

## Fixed-point export

Exports to 16- or 24-bit are dithered. TPDF is the default at 16-bit, with
optional second-order noise shaping; 24-bit defaults to none, and 32-bit float
is never dithered because nothing is quantised.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build |
| `npm test` | Full test suite |
| `npm run test:watch` | Watch mode |
| `npm run coverage` | Coverage report |
| `npm run lint` | ESLint |
| `npm run check` | Lint and test together |

## Repository structure

```text
├── index.html                    Application markup and CDN encoder dependency
├── src/
│   ├── app.js                    DOM wiring, live Web Audio graph, canvases,
│   │                             offline render orchestration
│   ├── styles.css
│   ├── dsp/
│   │   ├── units.js              dB/gain conversion, clamping, time formatting
│   │   ├── loudness.js           BS.1770-4 / R 128 integrated loudness and LRA
│   │   ├── true-peak.js          Polyphase true-peak metering and limiting
│   │   ├── dither.js             TPDF and noise-shaped quantisation
│   │   ├── transient.js          Differential-envelope transient shaper
│   │   └── reference-match.js    FFT, spectral fingerprint, match curve
│   ├── export/
│   │   └── wav.js                RIFF/WAVE and AIFF encoders
│   └── immersive/
│       └── layouts.js            Speaker table, layouts, WAVE channel masks
├── tests/                        Vitest suites, incl. EBU compliance signals
└── docs/
    ├── ARCHITECTURE.md
    └── DSP-VALIDATION.md
```

Everything under `src/dsp`, `src/export` and `src/immersive` is pure: no DOM, no
Web Audio context, no globals. That is what makes it testable in Node, and it is
where the audio correctness lives. `src/app.js` is the browser layer.

## Browser notes

Decoding support depends on the browser; Chromium handles the widest range of
source formats. MP3 export loads `lamejs` from a CDN, so that path needs network
access until the dependency is vendored.

Rendering and limiting run on the main thread. A five-minute export spends
roughly twelve seconds in the limiter behind the progress bar; moving this to a
worker is the main outstanding performance item (see `docs/ARCHITECTURE.md`).

## License

MIT — see [LICENSE](LICENSE).
