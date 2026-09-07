# SIGNAL ROT // MASTER

**A browser-native mastering and immersive-audio laboratory — experimental, technical, atmospheric.**

Web Audio API · BS.1770-4 loudness · band-limited true-peak limiting · 24-channel periphonic
rendering · ADM BWF interchange · deliberately degraded media · **two workspaces: MASTER + SPATIAL LAB**

> **Master** — calm, reference-focused: source → profile → tonal/dynamics/space → loudness → listen → export.  
> **Spatial Lab** — the signature immersive workstation: speaker field (top-down + elevation) → depth/height/motion → energy → binaural → bed.

Everything runs locally in the tab. No upload, no account, no server. Open it, drop a file
in, and the only thing that leaves your machine is the file you choose to download.

**Repository colour key** — seven domain codes colour every diagram in this README and
`docs/`, `.github/labeler.yml`, and `--dom-*` tokens in `src/styles/tokens.css`:
● DSP (violet) · ● SPATIAL (azure) · ● RUNTIME (chartreuse) · ● EXPORT (fuchsia) ·
● TESTING (sky) · ● UI (pink) · ● APP (slate). Full spec:
[`docs/COLOR-SYSTEM.md`](docs/COLOR-SYSTEM.md).

> **Product experience by Agent E** — see [`docs/PRODUCT-EXPERIENCE.md`](docs/PRODUCT-EXPERIENCE.md) for the full design system, workspace, A/B, macros, Spatial Lab, preset browser, export and accessibility.

```
INPUT → MATCH EQ → TONE → MULTIBAND → STEREO → CHARACTER → DEPTH → SATURATION
      → [TRANSIENT] → [NORMALIZATION] → [LIMITER] → EXPORT
```

Stages in brackets run only during the offline render. The interface says so, in the
signal-flow view and on every affected control.

---

## Contents

- [What this is](#what-this-is)
- [What this is not](#what-this-is-not)
- [Feature matrix](#feature-matrix)
- [Architecture](#architecture)
- [Visual organisation](#visual-organisation)
- [Signal flow](#signal-flow)
- [Live preview versus export](#live-preview-versus-export)
- [Getting started](#getting-started)
- [Browser support](#browser-support)
- [Presets](#presets)
- [Immersive audio](#immersive-audio)
- [Testing](#testing)
- [Workstreams & ownership](#workstreams--ownership)
- [Technical limitations](#technical-limitations)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Licence](#licence)

---

## What this is

Signal Rot is a mastering environment for people who want both the boring things done
correctly and the strange things done deliberately.

**The boring things, done correctly:**

- A **loudness meter** that reproduces the ITU-R BS.1770-4 K-weighting coefficients
  exactly, gates per the standard, and computes loudness range per EBU Tech 3342 — not
  a hand-tuned approximation with those names attached to it.
- A **true-peak limiter** whose detector is a band-limited polyphase interpolator, whose
  gain curve is continuous rather than stepped, and which **re-measures the finished file
  and tells you whether the ceiling actually held**.
- A **multiband crossover** with phase/delay-matched paths and an analytical diagnostic.
  The ideal filter model sums flat; the real-browser wet sum still has an
  [open reconstruction finding](docs/FINDINGS-FOR-AGENT-A.md#measured-in-a-real-browser).
- **Deterministic exports.** Same project, same texture seed, byte-identical file.
- A **render report** — downloadable JSON — recording the analysis before and after, the
  normalisation gain, the maximum gain reduction, the achieved true peak, and whether
  anything went over.

**The strange things, done deliberately:**

- Tape wow, flutter and drift; vinyl crackle, rumble and roll-off; a seeded hiss bed.
  Stylised degradation, honestly labelled — this is not a tape-machine model and the UI
  says so.
- Per-band stereo width, side-channel comb filtering, Haas widening, and presets that will
  cheerfully destroy your mono fold-down if that is what you want. The system distinguishes
  intentional destruction from accidental failure by warning you which one you are doing.
- Stereo → 5.1 / 7.1 / 7.1.2 / 7.1.4 / 9.1.6 up-mixing, plus **Sonic Lab 20.4**, the
  24-channel periphonic system at the Anton Bruckner Privatuniversität in Linz.
- ADM BWF interchange files with real loudness metadata in the `bext` chunk.

## What this is not

This section is as important as the one above.

| Not                               | Why                                                                                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A certified loudness meter        | The K-weighting matches BS.1770-4 to machine precision and the gating follows the standard, but it has **not** been validated against the EBU Tech 3341 compliance material. No compliance claim is made.           |
| A certified true-peak meter       | The interpolator is a windowed-sinc polyphase design, not the tabulated BS.1770-4 Annex 2 FIR. Measured error on the standard worst case is −0.17 dB.                                                               |
| A tape emulation                  | Wow and flutter are two sine LFOs on a delay line. There is no hysteresis, no bias, no gap loss, no self-erasure.                                                                                                   |
| HRTF spatialisation of your mix   | The "binaural" processing in the Spatial tab is crossfeed plus interaural delay. The immersive binaural monitor _does_ use HRTF, via the browser's own generic dataset — fixed, not head-tracked, not personalised. |
| A Dolby Atmos master              | The ADM export is a `DirectSpeakers` channel bed. There are no objects, no positional automation. It can be an _ingest_ format for licensed Atmos tooling; it is not itself a deliverable.                          |
| A way to reproduce another master | Reference matching moves eight EQ bands. It cannot transfer arrangement, performance, dynamics, imaging or saturation. It reports a confidence score for exactly this reason.                                       |
| A mastering-grade compressor      | The multiband uses `DynamicsCompressorNode`, whose internals are implementation-defined. It glues convincingly at modest settings. That is the claim.                                                               |
| A replacement for your room       | Nothing in a browser tab is.                                                                                                                                                                                        |

Full detail: [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md).

---

## Feature matrix

| Area          | Feature                                 | Live monitor | Export | Notes                                                                |
| ------------- | --------------------------------------- | :----------: | :----: | -------------------------------------------------------------------- |
| **Loudness**  | Integrated LUFS (BS.1770-4, gated)      | offline pass |   ✓    | Momentary/short-term meters are frame-driven approximations          |
|               | Loudness range (EBU Tech 3342)          | offline pass |   ✓    | 3 s blocks, −20 LU relative gate                                     |
|               | Normalisation to target                 | approximate  |   ✓    | Export iterates to convergence; reports if the target is unreachable |
|               | True-peak metering                      |   estimate   |   ✓    | Live meter is strided and labelled "est."                            |
| **Dynamics**  | 3-band compressor, serial LR4           |      ✓       |   ✓    | Reconstructs flat at every mix position                              |
|               | Per-band GR meters, solo, bypass        |      ✓       |   ✓    | Solo is monitoring only                                              |
|               | Parallel (New York) mix                 |      ✓       |   ✓    | Phase-matched dry path                                               |
|               | Transient shaper                        |      ✗       |   ✓    | Needs per-sample gain — offline only                                 |
|               | Look-ahead true-peak limiter            |      ✗       |   ✓    | Monitor uses a `DynamicsCompressorNode` safety limiter               |
| **Tone**      | 6-band EQ + tilt                        |      ✓       |   ✓    | Labels generated from the filter definitions                         |
|               | Waveshaper saturation                   |      ✓       |   ✓    | Unity small-signal slope; +12 dB structural headroom                 |
| **Stereo**    | Width, M/S balance, bass mono (LR4)     |      ✓       |   ✓    |                                                                      |
|               | Per-band width (250 Hz / 4 kHz)         |      ✓       |   ✓    | Side channel only                                                    |
|               | Haas, crossfeed, side comb blend        |      ✓       |   ✓    | Phase warnings on all three                                          |
|               | Mono / side / L / R audition            |      ✓       |   ✗    | Monitoring only                                                      |
|               | Per-band mono-compatibility analysis    | offline pass |   ✓    | In the render report                                                 |
| **Character** | Tape wow / flutter / drift / head bump  |      ✓       |   ✓    | Seeded, reproducible                                                 |
|               | Vinyl crackle / rumble / roll-off       |      ✓       |   ✓    | Seeded, reproducible                                                 |
|               | Hiss bed                                |      ✓       |   ✓    | Gaussian, decorrelated between channels                              |
| **Match**     | Reference tonal matching, 8 bands       |      ✓       |   ✓    | Broad / balanced / precise; confidence score                         |
| **Depth**     | Two filtered early reflections          |      ✓       |   ✓    | Not a reverb                                                         |
| **Immersive** | 5.1 · 7.1 · 7.1.2 · 7.1.4 · 9.1.6       |   map only   |   ✓    | Synthesised up-mix                                                   |
|               | Sonic Lab 20.4 (24 ch)                  |   map only   |   ✓    | Venue-specific; ships a channel map                                  |
|               | Binaural monitoring and fold-down       |      ✓       |   ✓    | Fixed HRTF, not head-tracked                                         |
|               | ADM BWF (BS.2076)                       |      —       |   ✓    | `DirectSpeakers` bed with `bext` loudness                            |
|               | Channel identification file             |      —       |   ✓    | Tone bursts, one channel at a time                                   |
| **Export**    | WAV 16 / 24 / 32-bit float              |      —       |   ✓    | `WAVE_FORMAT_EXTENSIBLE` above 2 channels                            |
|               | AIFF 16 / 24-bit                        |      —       |   ✓    | Big-endian, 80-bit extended sample rate                              |
|               | MP3 320 kbit/s                          |      —       |   ✓    | Bundled `lamejs`, code-split, works offline                          |
|               | Dither: none / TPDF / 2nd-order shaped  |      —       |   ✓    | Never applied to 32-bit float                                        |
|               | JSON render report                      |      —       |   ✓    | Verified, not predicted                                              |
|               | Batch queue                             |      —       |   ✓    | Off-thread loudness analysis                                         |
| **Workflow**  | Undo / redo, autosaved session          |      ✓       |   —    | 60 steps                                                             |
|               | Command palette (`⌘K` / `Ctrl+K`)       |      ✓       |   —    | Every preset, tab and action                                         |
|               | Signal-flow view with per-module bypass |      ✓       |   ✓    |                                                                      |
|               | Preset save / load with migration       |      ✓       |   ✓    | Reads pre-7.0 files                                                  |
|               | Render history                          |      ✓       |   —    | Re-download any report                                               |

---

## Architecture

Same graph as before, re-inked with the domain colours from
[`docs/COLOR-SYSTEM.md`](docs/COLOR-SYSTEM.md) — the hue tells you which workstream owns a
node before you read its name. Fuchsia nodes inside an otherwise-violet island are the
export-owned writers living among the DSP (ADM is a spatial⇄export boundary; the analysis
worker is runtime plumbing).

```mermaid
graph TD
  subgraph Shell
    HTML[index.html]:::dom-ui --> MAIN[src/main.js]:::dom-app
    MAIN --> BOOT[app/bootstrap.js]:::dom-app
  end

  subgraph State
    BOOT --> STORE[app/state.js<br/>validated store]:::dom-app
    STORE --- SCHEMA[app/parameters.js<br/>parameter schema]:::dom-app
    STORE --- PIO[app/presets-io.js<br/>serialise · validate · migrate]:::dom-app
  end

  subgraph UI
    BOOT --> CTRL[ui/controls.js<br/>generated from schema]:::dom-ui
    BOOT --> TABS[ui/tabs.js]:::dom-ui
    BOOT --> FLOW[ui/signal-flow.js]:::dom-ui
    BOOT --> TRANS[ui/transport.js]:::dom-ui
    BOOT --> PAL[ui/command-palette.js]:::dom-ui
    BOOT --> VIZ[visualizers/*]:::dom-ui
  end

  subgraph Audio
    BOOT --> CTX[audio/context.js]:::dom-dsp
    BOOT --> CHAIN[audio/graph/build-mastering-chain.js]:::dom-dsp
    CHAIN --> TONE[graph/tone.js]:::dom-dsp
    CHAIN --> MB[graph/multiband.js]:::dom-dsp
    CHAIN --> ST[graph/stereo.js]:::dom-dsp
    CHAIN --> CH[graph/character.js]:::dom-dsp
    CHAIN --> DP[graph/depth.js]:::dom-dsp
  end

  subgraph Offline
    EXP[app/export-controller.js]:::dom-export --> RM[render/render-master.js]:::dom-dsp
    RM --> CHAIN
    RM --> TS[render/transient-shaper.js]:::dom-dsp
    RM --> NORM[render/normalize.js]:::dom-dsp
    NORM --> LIM[render/limiter.js]:::dom-dsp
    RM --> DITH[render/dither.js]:::dom-dsp
    RM --> REP[render/report.js]:::dom-dsp
    RM --> ENC[encode/wav · aiff · mp3]:::dom-export
  end

  subgraph Analysis
    W[workers/analysis.worker.js]:::dom-runtime --> LOUD[analysis/loudness.js]:::dom-dsp
    W --> TP[analysis/true-peak.js]:::dom-dsp
    W --> CORR[analysis/correlation.js]:::dom-dsp
    W --> SM[analysis/spectral-match.js]:::dom-dsp
  end

  subgraph Immersive
    IMM[app/immersive-controller.js]:::dom-spatial --> LAY[immersive/layouts.js]:::dom-spatial
    IMM --> SL[immersive/sonic-lab.js]:::dom-spatial
    IMM --> FEEDS[immersive/speaker-feeds.js]:::dom-spatial
    IMM --> BIN[immersive/binaural.js]:::dom-spatial
    IMM --> ADM[immersive/adm.js]:::dom-export
  end

  BOOT --> W
  BOOT --> EXP
  BOOT --> IMM

  classDef dom-dsp fill:#222131,stroke:#a78bfa,color:#a78bfa
  classDef dom-spatial fill:#152332,stroke:#58a6ff,color:#58a6ff
  classDef dom-runtime fill:#262c19,stroke:#c8e15c,color:#c8e15c
  classDef dom-export fill:#2a1a2c,stroke:#e26bd8,color:#e26bd8
  classDef dom-testing fill:#112631,stroke:#38bdf8,color:#38bdf8
  classDef dom-ui fill:#2d1b27,stroke:#f472b6,color:#f472b6
  classDef dom-app fill:#1f2328,stroke:#94a3b8,color:#94a3b8
```

The organising principle: **every numeric routine is a pure function over plain typed
arrays**, so the entire DSP layer is unit-testable in Node without a browser, a DOM or a
mock. Web Audio types appear in exactly two adapter functions
(`audio/dsp/audio-data.js`) and in the graph-construction modules.

Full detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

```text
src/
├── main.js                     entry point
├── app/
│   ├── bootstrap.js            wiring: store, graph, UI, loops
│   ├── constants.js            engine identity, limits, signal-flow order
│   ├── parameters.js           the parameter schema — one source of truth
│   ├── state.js                validated store, undo/redo, autosave
│   ├── presets-io.js           serialise · validate · migrate
│   ├── export-controller.js    export, encoding, batch, render history
│   └── immersive-controller.js layouts, binaural monitor, immersive export
├── audio/
│   ├── context.js              AudioContext creation and capability probing
│   ├── dsp/                    math · biquad · audio-data · prng
│   ├── graph/                  tone · multiband · stereo · character · depth · chain
│   ├── analysis/               loudness · true-peak · rms · correlation · fft · match
│   ├── render/                 render-master · transient · normalize · limiter · dither · report
│   ├── immersive/              layouts · sonic-lab · speaker-feeds · binaural · adm
│   └── encode/                 wav · aiff · mp3 · download
├── presets/                    mastering · dimension · genre · cinematic · mood · color · spatial · restoration
├── ui/                         dom · controls · tabs · transport · signal-flow · palette · …
├── visualizers/                waveform · spectrum · vectorscope · speaker-map · …
├── workers/                    analysis worker + client with in-thread fallback
└── styles/                     tokens · layout · controls · visualizers · responsive
```

---

## Visual organisation

Seven colours code the repository's major areas. They are design tokens
(`--dom-*` in [`src/styles/tokens.css`](src/styles/tokens.css)), the palette of every
diagram in this file and in `docs/`, the `area:*` GitHub labels applied by
[`.github/labeler.yml`](.github/labeler.yml) — and deliberately nothing else: the product
keeps its two-accent identity (cyan = original, orange = processed), and no meter or scope
ever borrows a domain hue. The claim "same colour, same meaning, everywhere" is enforced by
`tests/app/visual-system.test.js`.

```mermaid
graph LR
  DSP["DSP & MEASUREMENT<br/>4,855 lines · 392 tests"]:::dom-dsp
  SPA["SPATIAL & IMMERSIVE<br/>856 lines · up to 24-ch"]:::dom-spatial
  RUN["RUNTIME & WORKERS<br/>386 lines · contract layer"]:::dom-runtime
  EXP["EXPORT & FORMATS<br/>3,119 lines · 492 tests"]:::dom-export
  TST["TESTING & CONFORMANCE<br/>1,070 + 37 + 7"]:::dom-testing
  UII["UI & PRODUCT<br/>5,460 lines · 52 tests"]:::dom-ui
  APP["APP STATE & PRESETS<br/>5,064 lines · 72 presets"]:::dom-app

  classDef dom-dsp fill:#222131,stroke:#a78bfa,color:#a78bfa
  classDef dom-spatial fill:#152332,stroke:#58a6ff,color:#58a6ff
  classDef dom-runtime fill:#262c19,stroke:#c8e15c,color:#c8e15c
  classDef dom-export fill:#2a1a2c,stroke:#e26bd8,color:#e26bd8
  classDef dom-testing fill:#112631,stroke:#38bdf8,color:#38bdf8
  classDef dom-ui fill:#2d1b27,stroke:#f472b6,color:#f472b6
  classDef dom-app fill:#1f2328,stroke:#94a3b8,color:#94a3b8
```

| Domain              | Primary paths                                                          |    Lines (non-blank) | Guarded by                                                 |
| ------------------- | ---------------------------------------------------------------------- | -------------------: | ---------------------------------------------------------- |
| ● DSP `#a78bfa`     | `audio/{dsp,analysis,graph,render,adaptive}` + `context.js` — 25 files |                4,855 | `tests/dsp` (238) + `tests/integration` (154)              |
| ● SPATIAL `#58a6ff` | `audio/immersive` (minus `adm.js`) + spatial lab UI                    |             856 + UI | `tests/format/{layouts,adm}`, browser immersive spec       |
| ● RUNTIME `#c8e15c` | `src/runtime` + `src/workers` — 8 files                                |                  386 | `tests/runtime` (6)                                        |
| ● EXPORT `#e26bd8`  | `audio/encode` + `immersive/adm.js` + export controller — 12 files     |                3,119 | `tests/format` (159) + `tests/interoperability` (333)      |
| ● TESTING `#38bdf8` | `tests/` · `e2e/` · `tests/browser` · `ci/` · lab tooling              | 11,760 (tests + e2e) | itself — four CI gates, [docs/TESTING.md](docs/TESTING.md) |
| ● UI `#f472b6`      | `src/ui` + `src/visualizers` + `src/styles` + `index.html`             |                5,460 | `tests/ui` (54) + a11y/responsive e2e                      |
| ● APP `#94a3b8`     | `src/app` core + `src/presets` + entry — 18 files                      |                5,064 | `tests/app` (93)                                           |

Counts are measured at this commit (104 source files / 19,403 lines total); the full
mapping — every directory, its agents, docs and boundary files — is
[docs/COLOR-SYSTEM.md](docs/COLOR-SYSTEM.md).

---

## Signal flow

Colour marks the owning domain of each stage: every process node is ● DSP — one chain
constructor serves both paths — the monitor surface is ● UI, verification and ingest are
● APP, and the encode at the end belongs to ● EXPORT. The full stage-by-stage ownership
table, with the module that builds each node, is in
[`docs/DSP-SIGNAL-FLOW.md`](docs/DSP-SIGNAL-FLOW.md).

```mermaid
flowchart LR
  IN([Source]):::dom-app --> TRIM[Input drive]
  TRIM --> MATCH[Match EQ<br/>8 bells]
  MATCH --> TONE[Tone<br/>6 bands + tilt]
  TONE --> MB[Multiband<br/>serial LR4 140 Hz / 3.2 kHz]
  MB --> STEREO[Stereo<br/>M/S · per-band width · bass mono]
  STEREO --> CHAR[Character<br/>tape · vinyl · hiss]
  CHAR --> DEPTH[Depth<br/>early reflections]
  DEPTH --> SAT[Saturation<br/>waveshaper]
  SAT --> LIVE([Live monitor]):::dom-ui
  SAT -.offline.-> TRANS[Transient shaper]
  TRANS --> NORM[Normalise]
  NORM --> LIMIT[True-peak limiter]
  LIMIT --> VERIFY{Verify ceiling}
  VERIFY -->|over| TRIM2[Bounded corrective trim]
  TRIM2 --> VERIFY
  VERIFY -->|ok| DITHER[Dither]
  DITHER --> ENCODE([Encode]):::dom-export

  classDef dom-dsp fill:#222131,stroke:#a78bfa,color:#a78bfa
  classDef dom-spatial fill:#152332,stroke:#58a6ff,color:#58a6ff
  classDef dom-runtime fill:#262c19,stroke:#c8e15c,color:#c8e15c
  classDef dom-export fill:#2a1a2c,stroke:#e26bd8,color:#e26bd8
  classDef dom-testing fill:#112631,stroke:#38bdf8,color:#38bdf8
  classDef dom-ui fill:#2d1b27,stroke:#f472b6,color:#f472b6
  classDef dom-app fill:#1f2328,stroke:#94a3b8,color:#94a3b8

  class TRIM,MATCH,TONE,MB,STEREO,CHAR,DEPTH,SAT,TRANS,NORM,LIMIT,VERIFY,TRIM2,DITHER dom-dsp
```

Why this order, and what changed from the pre-7.0 chain, is argued in
[`docs/DSP-SIGNAL-FLOW.md`](docs/DSP-SIGNAL-FLOW.md).

---

## Live preview versus export

A mastering tool that quietly does something different when you press export is worse than
one that does less. Signal Rot marks every divergence in the interface — an
`export only` badge next to the control, a cyan dot in the signal-flow view — and the
About tab lists them all.

| Process                                               | Live monitor                            | Export                               | Why they differ                                                              |
| ----------------------------------------------------- | --------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------- |
| Tone, multiband, stereo, character, depth, saturation | identical                               | identical                            | The _same_ `buildMasteringChain()` builds both graphs                        |
| Transient shaper                                      | **omitted**                             | applied                              | Per-sample gain is not available from native nodes without an `AudioWorklet` |
| True-peak limiter                                     | `DynamicsCompressorNode` safety limiter | look-ahead band-limited limiter      | Look-ahead needs the whole buffer                                            |
| Normalisation                                         | static gain from the last analysis      | iterated to convergence and verified | Preview cannot re-render on every frame                                      |
| Dither                                                | not applied                             | applied at quantisation              | Only meaningful at the fixed-point conversion                                |
| Solo / mono / side audition                           | applied                                 | **never applied**                    | Monitoring, not processing                                                   |
| Analogue noise beds                                   | seeded, identical                       | seeded, identical                    | Same seed, same PRNG                                                         |
| Momentary / short-term meters                         | frame-driven, time-windowed             | full BS.1770 pass                    | The live meter is an indicator                                               |

---

## Getting started

**Requirements:** Node 20.11 or newer.

```bash
git clone https://github.com/zazieproductions/Signal-Rot-Audio-Mastering-Suite-.git
cd Signal-Rot-Audio-Mastering-Suite-
npm install
npm run dev            # http://localhost:5173
```

### Scripts

| Command                    | What it does                                                                    |
| -------------------------- | ------------------------------------------------------------------------------- |
| `npm run dev`              | Vite dev server with HMR                                                        |
| `npm run build`            | Production build to `dist/`                                                     |
| `npm run preview`          | Serve the production build                                                      |
| `npm run lint`             | ESLint over `src`, `tests` and `tools`                                          |
| `npm run format`           | Prettier, write                                                                 |
| `npm run format:check`     | Prettier, check only (separate from `check`)                                    |
| `npm run test`             | Vitest: unit, DSP, format, interoperability, runtime and integration tests      |
| `npm run test:watch`       | Vitest in watch mode                                                            |
| `npm run test:coverage`    | Coverage report                                                                 |
| `npm run test:e2e`         | Playwright browser tests (needs `npx playwright install chromium`)              |
| `npm run validate:exports` | Generate export fixtures and validate them with independent parsers and ffprobe |
| `npm run validate:adm`     | ADM structural validation (`-- --xsd <path>` adds schema validation)            |
| `npm run fixtures:export`  | Write the deterministic export fixtures to `.fixtures/export/`                  |
| `npm run inspect:export`   | Inspect any WAV / BWF / RF64 / BW64 file with the independent parser            |
| `npm run check`            | lint + test + export validation + build                                         |

### Deployment

The build is a static bundle with no server component and no runtime network dependency.

```bash
npm run build
# dist/ → any static host
```

`vite.config.js` sets `base: './'`, so `dist/` works from a subdirectory — GitHub Pages
project sites, an itch.io upload, a USB stick — without rewriting paths.

**Content Security Policy.** Signal Rot loads nothing from a CDN. A policy of
`default-src 'self'; worker-src 'self' blob:; connect-src 'self' blob:` is sufficient. The
MP3 encoder is bundled and code-split, so it is fetched from your own origin the first
time someone exports an MP3 and never otherwise.

---

## Browser support

Tested and unsupported behaviours are recorded in
[`docs/BROWSER-COMPATIBILITY.md`](docs/BROWSER-COMPATIBILITY.md), which also explains
which rows are _tested_ and which are _expected_. The About tab probes the running browser
and shows what it actually found, which is more reliable than any table.

| Browser                                  | Status                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Chromium 111+ (Chrome, Edge, Brave, Arc) | Primary target. Widest decoder support, 192 kHz offline rendering.                                                              |
| Firefox 128+                             | Supported. No AAC/M4A decode on most builds.                                                                                    |
| Safari 16.4+                             | Supported with caveats. Offline rendering above 96 kHz may be refused — the sample-rate menu disables what the browser rejects. |
| Mobile Safari / Chrome Android           | Usable for auditioning and short renders. Long renders will be killed by the OS.                                                |

---

## Presets

Seventy-two presets in eight groups, led by `Reference HD` in the Mastering group. Every one carries a review note recording what was
checked and anything you should know before reaching for it, and a risk level:

- **safe** — no mono-compatibility or level hazard
- **caution** — legitimate creative territory that needs a check
- **destructive** — will not survive a mono fold-down, on purpose

The catalogue is enforced by tests, not by good intentions
(`tests/app/presets-catalog.test.js`): no preset may use a ceiling hotter than −1.0 dBTP,
none may widen past 130 % without a bass-mono anchor, none may stack more than 6 dB of
overlapping low shelves, and a preset whose description promises compression must actually
compress.

The `mastering` and `creative` families are independent of those groups. Mastering
presets scrub tape, hiss, vinyl, Haas and side-comb processing; creative presets keep
their intentional degradation. Family guardrails live in `tests/app/preset-families.test.js`.

Preset files are JSON, versioned, and validated on load — a hand-edited file cannot set
`width: 1e9`. Pre-7.0 files are migrated automatically. Format:
[`docs/PRESET-SCHEMA.md`](docs/PRESET-SCHEMA.md).

---

## Immersive audio

Read [`docs/IMMERSIVE-AUDIO.md`](docs/IMMERSIVE-AUDIO.md) before delivering anything.

The short version: these are **synthesised channel beds** derived from a stereo master.
Stereo contains no height information; the height channels carry decorrelated ambience
because it sounds like space, not because anything was recovered. The ADM file is a
`DirectSpeakers` bed with BS.2076 metadata — a legitimate interchange format, not a
certified Atmos master.

Sonic Lab 20.4 has its own document, [`docs/SONIC-LAB-20.4.md`](docs/SONIC-LAB-20.4.md),
covering all 24 channels, both azimuth conventions, the ring structure and the exported
channel map.

---

## Testing

```bash
npm run test              # Node + jsdom regression suites
npm run test:e2e          # UI browser tests (install Chromium first)
npm run test:conformance  # real Web Audio: Chromium / Firefox / WebKit
npm run validate:exports  # production exports checked by independent tools
```

The active export workflow validates formats and interoperability. Full application
CI and browser conformance workflows are still templates in `ci/`, not active gates;
see [`ci/README.md`](ci/README.md). Passing `npm run check` does **not** establish
browser conformance: the wet multiband reconstruction finding remains open in
[`docs/FINDINGS-FOR-AGENT-A.md`](docs/FINDINGS-FOR-AGENT-A.md).

Four validation routes are detailed in
[docs/TESTING.md §The pipeline](docs/TESTING.md#the-pipeline); only Gate 4 is active CI:

```text
GATE 1  npm run check            lint · 1,070 vitest · validate:exports · build
                                 format:check is separate; general CI remains a template
GATE 2  browser template         37 Playwright specs on real Chromium — bytes parsed
GATE 3  conformance template     goldens (Node) + 7 specs × chromium/firefox/webkit
                                 measurements → lab-results JSON → Agent A's findings inbox
GATE 4  CI export interop        production writers → independent parsers + ffprobe
                                 ≥25 fixtures · channel order from the AUDIO · no over-claims
```

| Suite                     | Tests | What it proves                                                                                                                                                                                                     |
| ------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/dsp/`              | 238   | K-weighting matches the BS.1770-4 tables to 1e-12; ideal crossover maths sum flat (browser A-6 remains open); the limiter holds every ceiling on every pathological signal; dither is triangular and decorrelating |
| `tests/format/`           | 159   | RIFF and IFF chunk sizes, padding, endianness, channel masks, ADM ID cross-references, `chna` entry widths, RF64/BW64 `ds64` planning at the 4 GiB boundary                                                        |
| `tests/interoperability/` | 333   | Multichannel round trips through an **independent** decoder; channel order recovered from the audio itself; RF64/BW64 write path; hostile-metadata fuzzing; delivery profiles, manifests and checksums             |
| `tests/app/`              | 93    | Schema integrity, clamping, hostile preset files, catalogue safety review                                                                                                                                          |
| `tests/integration/`      | 154   | Graph topology against a recording fake context; the full post-render pipeline                                                                                                                                     |
| `tests/ui/`               | 54    | Schema-driven controls, ARIA tab pattern, DOM-injection safety, application boot against the real `index.html`                                                                                                     |
| `tests/runtime/`          | 6     | Scheduler backpressure and cancellation, RPC transfer hygiene, memory planning, pyramid levels, chunk stream                                                                                                       |
| `tests/fixtures/`         | 13    | Golden bank snapshots — a DSP change that moves measured numbers moves a test first                                                                                                                                |
| `tests/conformance/`      | 20    | The lab's own classification and immersive catalog fixtures — the instrument is calibrated, too                                                                                                                    |
| `e2e/`                    | 37    | Real browser: import, decode, render, download, verify header bytes                                                                                                                                                |

All test signals are generated programmatically (`tests/helpers/signals.js`) — no
copyrighted audio in the repository, and every result reproducible on any machine.

### Export validation is deliberately not self-referential

`npm run validate:exports` writes real files with the production encoders and then checks
them with an independent RIFF/RF64/BW64 parser, an independent ADM validator, and FFmpeg —
none of which share code with the writers. Multichannel fixtures carry
channel-identification tones, so the channel order is recovered from the **audio** rather
than believed from the metadata: a swap, a rotation or a left/right flip fails the build.

The principle: **Signal Rot should not have to trust itself to prove that its own files
are valid.**

More: [`docs/TESTING.md`](docs/TESTING.md) and
[`docs/EXPORT-INTEROPERABILITY.md`](docs/EXPORT-INTEROPERABILITY.md).

---

## Workstreams & ownership

Five workstreams, one findings loop, three boundary conventions — the full map is
[`docs/WORKSTREAMS.md`](docs/WORKSTREAMS.md). Agents are coloured by the domain they own:

```mermaid
flowchart LR
  A["AGENT A<br/>DSP engine + measurement<br/>+ spatial feeds & layouts"]:::dom-dsp
  B["AGENT B<br/>conformance lab<br/>findings inbox · golden bank"]:::dom-testing
  C["AGENT C<br/>encoders · ADM · delivery<br/>interoperability gate"]:::dom-export
  D["AGENT D<br/>scheduler · RPC · budgets<br/>preflight · pyramid"]:::dom-runtime
  E["AGENT E<br/>both workspaces · scopes<br/>styles · export summary UX"]:::dom-ui

  B -- "finding + kept regression test<br/>never fixes DSP" --> A
  A -- "routing flags · chain API" --> E
  C -- "writer APIs" --> E
  D -- "progress · memory · levels<br/>// adapter boundary" --> E
  D -. "cancellation" .-> A
  D -. "batch keys" .-> C
  R["HOUSE — store · schema · 72 presets"]:::dom-app
  R == "one parameter schema for everyone" ==> E

  classDef dom-dsp fill:#222131,stroke:#a78bfa,color:#a78bfa
  classDef dom-runtime fill:#262c19,stroke:#c8e15c,color:#c8e15c
  classDef dom-export fill:#2a1a2c,stroke:#e26bd8,color:#e26bd8
  classDef dom-testing fill:#112631,stroke:#38bdf8,color:#38bdf8
  classDef dom-ui fill:#2d1b27,stroke:#f472b6,color:#f472b6
  classDef dom-app fill:#1f2328,stroke:#94a3b8,color:#94a3b8
```

The loop that makes it work: **B measures the real engine and files findings; the
regression test that produced a finding always stays; A fixes against it or tightens the
threshold with a one-line reason.** Nobody retunes DSP from a lab printout, and nobody
fixes a format claim by editing the claim.

---

## Technical limitations

The honest list, in full, is [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md). The ones most
likely to matter:

1. **Loudness targets have a hard ceiling.** A transparent limiter cannot make pink noise
   reach −9 LUFS at a −1 dBTP ceiling; it saturates around −9.8 LUFS. Signal Rot detects
   the plateau and says so rather than silently missing the target.
2. **Waveshaper aliasing.** `WaveShaperNode`'s 4× oversampling is not specified by quality
   and a tanh curve generates harmonics without limit. High saturation aliases audibly on
   bright material.
3. **`DynamicsCompressorNode` is implementation-defined.** The multiband will not sound
   bit-identical across browsers.
4. **Exports are capped at about 2 GB by the browser, not by the format.** RF64/BW64 with
   a correct `ds64` chunk is written when sizes exceed 32 bits, but the whole file is held
   in one `ArrayBuffer`, and browsers cap that below 4 GiB. A wrapped size field is never
   written.
5. **Everything is in memory.** A 30-minute 192 kHz import will exhaust a browser tab.
   Guards warn and refuse at documented thresholds.
6. **Browser decoders vary.** FLAC, M4A and Opus support is not universal. The About tab
   reports what your browser claims.

---

## Roadmap

- [ ] Validate the loudness meter against the EBU Tech 3341 compliance set and publish the
      results (pass or fail)
- [ ] Oversampled saturation with a proper anti-imaging filter, replacing the
      `WaveShaperNode` mitigation
- [ ] `AudioWorklet` path for the transient shaper, so preview and export converge further
- [x] RF64 / BW64 writer for files above 4 GB — see `docs/EXPORT-INTEROPERABILITY.md`
- [ ] Streaming render for long files, to lift the ~2 GB in-memory ceiling
- [ ] Validate the ADM against the normative BS.2076 XSD in CI (blocked: the ITU does not
      license the schema for redistribution — `npm run validate:adm -- --xsd` works locally)
- [ ] Round-trip an ADM export through a commercial renderer and publish the result
- [ ] Object-based ADM authoring with real positional metadata
- [ ] Project session files (audio reference + full state)
- [ ] Spectrogram view and waveform region export
- [ ] Match EQ with more bands and an optional minimum-phase / linear-phase choice

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). The short version: **do not add a claim that is
not backed by a test.** If a process is an approximation, the code comment, the UI copy and
the documentation must all say so.

## Known issues

- The live momentary and short-term meters are time-windowed but still frame-driven; on a
  heavily loaded machine they read slightly low. The integrated figure is unaffected.
- The binaural monitor sounds different in Chromium and Safari because the HRTF datasets
  differ. This is not fixable from inside the page.
- Reference matching on a track with a long silent intro can still be pulled by fades if
  the fade is above the −30 dB relative rejection threshold.
- Batch export relies on sequential programmatic downloads, which some browsers rate-limit
  or block after the first few files.

## Licence

MIT — see [`LICENSE`](LICENSE).

The Sonic Lab 20.4 speaker layout describes a real installation at the Anton Bruckner
Privatuniversität, Linz. It is included as technical data with no claim of affiliation or
endorsement.
