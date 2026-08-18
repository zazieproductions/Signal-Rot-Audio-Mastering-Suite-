# Architecture

## Layering

The codebase is split along one line: **code that can be tested without a
browser, and code that cannot.**

```
┌─────────────────────────────────────────────────────────┐
│ index.html          markup, controls, canvases          │
├─────────────────────────────────────────────────────────┤
│ src/app.js          DOM wiring · live Web Audio graph   │  browser layer
│                     canvas drawing · render orchestration│  (jsdom smoke test)
├─────────────────────────────────────────────────────────┤
│ src/dsp/*           loudness · true peak · dither       │  pure modules
│ src/export/*        RIFF/WAVE · AIFF                    │  (unit tested
│ src/immersive/*     speaker table · layouts · masks     │   in Node)
└─────────────────────────────────────────────────────────┘
```

Nothing under `src/dsp`, `src/export` or `src/immersive` touches the DOM, an
`AudioContext`, or module-level mutable state. They take plain arrays and
AudioBuffer-shaped objects and return values. That constraint is what lets the
audio correctness be verified against published compliance signals in CI.

`src/app.js` keeps the parts that genuinely need a browser: node graph
construction, `OfflineAudioContext` renders, canvas visualisation, file I/O and
event handling.

## Runtime flow

1. A file is decoded to an `AudioBuffer` via `decodeAudioData`.
2. `buildGraph()` constructs the live monitoring chain; `setChainParams()`
   pushes the parameter block `P` onto it. The same function parameterises
   offline chains, so preview and render cannot drift apart.
3. `runAnalyze()` renders a capped window offline and measures it with
   `src/dsp/loudness.js`, updating the meters.
4. `renderMaster()` performs the export render: offline chain → transient
   shaping → loudness normalisation → true-peak limiting.
5. Encoders in `src/export/` quantise (with dither) and wrap in a container.
6. Immersive renders derive multichannel beds or a binaural fold-down from the
   processed stereo master, using the speaker table in `src/immersive/`.

## Signal chain

```
in ─ match EQ ─ tone EQ ─ multiband comp ─┬─ M/S matrix ─ per-band width ─┐
                                          └─ dry ────────────────────────┤
                                                                          │
  ┌───────────────────────────────────────────────────────────────────────┘
  └─ Haas ─ crossfeed ─ tape/vinyl character ─ depth ER ─ DC block
     ─ pre-sat pad ─ waveshaper ─ post LP ─ make-up ─ out
```

Transient shaping and true-peak limiting are deliberately **not** in this graph.
Both need per-sample gain control, which native Web Audio nodes cannot express,
so they run over the rendered buffer at export time.

## Testing strategy

| Suite | What it protects |
| --- | --- |
| `tests/loudness.test.js` | EBU Tech 3341 cases 1–5, Tech 3342 cases 1–4, BS.1770-4 coefficient tables, sample-rate independence, LFE exclusion |
| `tests/true-peak.test.js` | Polyphase accuracy bounds, ceiling guarantees across ceilings and material, channel-gain linkage, gain-envelope smoothness, convergence |
| `tests/export.test.js` | RIFF/AIFF chunk structure and alignment parsed by a real chunk walker, clamping, symmetric quantisation, dither decorrelation |
| `tests/layouts.test.js` | Channel-mask correctness, mask/channel-count agreement, ordering, ADM/renderer azimuth consistency |
| `tests/dsp-extras.test.js` | FFT correctness (Parseval, bin placement), fingerprint behaviour, transient shaper level-independence |
| `tests/app-boot.test.js` | The real bundle executing against the real markup in jsdom — catches dead selectors and boot-time throws |

Fixture-based golden-audio tests are **not** used, deliberately: small graph
reorderings change rendered output in ways that are correct but not
bit-identical, and golden files would produce constant false failures. The
tests assert measurable properties instead.

## Known limitations and next steps

**Performance.** Rendering, limiting and encoding all run on the main thread.
A five-minute export spends roughly twelve seconds in the limiter. The
polyphase envelope and the limiter passes are the hot paths and are pure
functions over typed arrays, so the natural next step is to move
`renderMaster()`'s post-processing into a Web Worker with transferable buffers.
The module boundaries were drawn with that in mind.

**Non-deterministic renders.** The tape hiss, vinyl crackle and rumble beds are
generated with `Math.random()`, so two exports of the same settings are not
bit-identical. Seeding them from a PRNG stored in the preset would make renders
reproducible.

**Constant latency.** The character stage keeps a fixed 6 ms tape delay in
circuit even at zero tape depth, so the processed path is time-offset from the
source. That is inaudible in isolation but prevents a null test against the
original, which is the standard way to verify a bypass is truly transparent.

**MP3 encoding** depends on a CDN-loaded `lamejs`. Vendoring or npm-installing
it would make the app fully offline-capable.

**Further module extraction.** `src/app.js` still holds the live graph, the
preset catalogue, control binding, meters and the immersive renderer in one
file. The natural next split is `state/parameters.js`, `state/presets.js`,
`audio/live-graph.js`, `ui/meters.js`, `ui/scopes.js` and `immersive/render.js`.
That work is lower priority than it looks: the DSP that determines whether a
master is correct has already been extracted and covered.
