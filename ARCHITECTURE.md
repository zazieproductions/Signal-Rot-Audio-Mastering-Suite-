# Architecture

## Runtime flow

1. `index.html` defines the application shell, controls, canvases, file inputs, and encoder script.
2. `src/styles.css` supplies the full visual system, responsive layout, controls, meters, cards, and tabs.
3. `src/app.js` initializes the interface and owns the application state.
4. Imported audio is decoded into an `AudioBuffer` through the Web Audio API.
5. A live graph supports auditioning and visualization.
6. Offline graphs perform analysis, normalization, processing, limiting, and export.
7. Immersive rendering derives multichannel beds or binaural fold-downs from the processed stereo master.

## Major systems inside `src/app.js`

- Shared utilities and parameter state
- Live Web Audio graph construction
- Parameter synchronization and controls
- Playback and waveform navigation
- Spectrum, goniometer, true-peak, correlation, RMS, LUFS, and LRA analysis
- Offline mastering render
- WAV, AIFF, MP3, multichannel WAV, and ADM BWF writers
- Reference-spectrum matching
- Transient shaping and true-peak limiting
- Batch processing
- Preset catalog and preset persistence
- Immersive speaker maps, upmixing, HRTF preview, and export

## Recommended next refactor

A later revision can split `src/app.js` into these modules:

```text
src/
├── main.js
├── state/
│   ├── parameters.js
│   └── presets.js
├── audio/
│   ├── context.js
│   ├── live-graph.js
│   ├── mastering-chain.js
│   ├── analysis.js
│   ├── limiter.js
│   ├── transient.js
│   └── reference-match.js
├── immersive/
│   ├── layouts.js
│   ├── upmix.js
│   ├── preview.js
│   └── adm.js
├── export/
│   ├── wav.js
│   ├── aiff.js
│   ├── mp3.js
│   └── download.js
└── ui/
    ├── controls.js
    ├── meters.js
    ├── waveform.js
    ├── scopes.js
    └── tabs.js
```

That second-stage split should be accompanied by fixture-based audio tests because small graph-order changes can alter rendered output.
