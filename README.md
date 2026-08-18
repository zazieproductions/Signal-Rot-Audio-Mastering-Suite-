# Signal Rot Mastering Suite

A browser-based mastering and immersive-audio laboratory built with the Web Audio API. This repository reorganizes the original standalone HTML application into a conventional Vite project without changing its core DSP behavior or interface.

## Features

- Browser audio import, transport, waveform, spectrum, goniometer, and loudness meters
- Tone, loudness, multiband dynamics, transient, stereo, spatial, tape, vinyl, and reference-match processing
- Preset system with JSON import/export
- WAV, AIFF, MP3, batch, multichannel, binaural, and ADM BWF export paths
- Immersive layouts from 5.1 through 9.1.6 plus the Sonic Lab 20.4 configuration
- Dark and light themes

## Run locally

```bash
npm install
npm run dev
```

Open the local URL printed by Vite.

## Production build

```bash
npm run build
npm run preview
```

The deployable static build is written to `dist/`.

## Repository structure

```text
signal-rot-mastering-suite/
├── index.html          # Application markup and external encoder dependency
├── src/
│   ├── app.js          # UI, Web Audio graph, DSP, analysis, presets, and exports
│   └── styles.css      # Complete application styling and responsive layout
├── docs/
│   └── ARCHITECTURE.md # Technical map and suggested future module boundaries
├── package.json
└── .gitignore
```

## Browser notes

Audio decoding support depends on the browser. Chromium browsers generally support the widest range of source formats. MP3 export loads `lamejs` from a CDN, so that export option requires network access unless the dependency is later vendored or installed locally.

## Current architecture

The repository is intentionally a behavior-preserving first pass. The original application logic remains together in `src/app.js`, which minimizes regression risk. `docs/ARCHITECTURE.md` identifies safe module boundaries for a later refactor.
