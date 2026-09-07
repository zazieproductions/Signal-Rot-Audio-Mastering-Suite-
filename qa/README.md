# Signal Rot — sonic QA lab (`qa/`)

An independent **render-and-measure** rig for judging what the mastering engine actually does to
audio, as opposed to whether the code looks right. It exists because the interesting failures in a
mastering chain are not assertion failures: a +7 dB crossover resonance, a ceiling that is not met, a
mono file that comes back phase-inverted, all render "successfully".

The standing question: **at matched loudness, would I choose the Signal Rot master over the input?**

## What it does

- `scripts/engine.mjs` installs a real Web Audio implementation (`node-web-audio-api`, Blink-like
  semantics) as `window.OfflineAudioContext`, so `buildMasteringChain` runs for real in Node: biquads,
  `DynamicsCompressorNode`, oversampled `WaveShaperNode`, delays, LFO-modulated tape path and all.
- `scripts/render.mjs` drives `renderMaster()` exactly like `src/app/export-controller.js` does —
  analysis → source-aware adaptation → offline graph → transient shaping → iterated
  normalise/limit → dither → the repo's own `writeWav` — from a JSON job list. What is measured is the
  file a user would download.
- `scripts/measure.py` / `compare.py` / `ab.py` / `audit.py` are **independent** meters: BS.1770-4
  gated loudness, exact band-limited true peak, octave-band energy, M/S and mono fold-down, transient
  attack ratio, DC, subsonic content, clipping. Nothing here imports `src/audio/analysis/*`, so the
  product cannot grade its own homework. When the two disagree, that is a finding.
- `scripts/probe.mjs` taps the chain stage by stage (where does the level/tone go?), `isolate.mjs`
  feeds a known signal through one section, `immersive.mjs` renders real 5.1 → 9.1.6 / Sonic Lab beds.
- `scripts/crossover-check.mjs` asserts crossover conformance headlessly (multiband wet path at
  every mix, stereo side-path unity, bass-mono LR4 shape, dry/wet alignment) at 44.1/48/96/192 kHz —
  the same contracts as the browser lab, runnable without a browser. `--strict` gates the ±0.1 dB
  design goal instead of the 1.5 dB contract.
- `scripts/gen_materials.py` synthesises the fixtures: 10 musical (dynamic acoustic, dense rock,
  bass-heavy, bright/harsh, dark/dull, transient-heavy, already-mastered, mono, extremely wide/phasey,
  lo-fi) and 13 deterministic (impulse, log sweep, multitone, 40/50/60/80/100 Hz tones, hard L/R,
  correlated, anti-correlated, burst train, clipped programme, stationary pink ±side). No audio is
  committed; fixtures are generated from code, matching `tools/audio-regression/`.

## Running

    npm install
    npm install --no-save node-web-audio-api   # render shim for qa/ only; not a product dependency
    python3 -m venv .venv-qa && .venv-qa/bin/pip install numpy scipy soundfile
    QA_MAT=$PWD/../qa-materials .venv-qa/bin/python qa/scripts/gen_materials.py
    node qa/scripts/render.mjs --jobs qa/jobs-smoke.json --out /tmp/o
    python3 qa/scripts/audit.py --dir /tmp/o
    bash qa/scripts/evidence.sh            # regenerates qa/results/evidence/*.md

On Linux the `node-web-audio-api` native binding loads `libasound.so.2` at import time, so renders
need ALSA present (`apt-get install libasound2`) or, in an offline sandbox, a minimal stub on
`LD_LIBRARY_PATH` — the environment this audit ran in had no audio stack at all and used a 79-symbol
versioned stub. `OfflineAudioContext` touches no real device either way.

Job files in `qa/jobs-*.json` are the ones the findings quote: `jobs-smoke` (preset sweep over the
matrix), `jobs-stress` (loudness targets, GR ladder, saturation, HF, width, transient, multiband,
sample rate, bit depth, determinism), `jobs-attrib` (one module bypassed at a time), `jobs-mono`,
`jobs-mbproof` (the parallel-mix ladder that proves the crossover bug), `jobs-verify` (ceiling).

## Honest limits of this rig

- **No human listening has been done.** Nothing here is an ear judgement; it is matched-level
  objective measurement plus null/AB arithmetic. Anything needing audition is labelled in the findings.
- The engine is a Rust Web Audio implementation, not Chrome/WebKit/Firefox. Node-level behaviour that
  the spec leaves implementation-defined (compressor internals, waveshaper oversampling filters) can
  differ. Where a finding could be engine-specific, the file says so and names the browser test to run.
  One case already cross-checks: the +7.4 dB crossover bump measured here matches the Chromium 149
  number recorded in `docs/FINDINGS-FOR-AGENT-A.md` (`A-6`) to 0.04 dB.
- One engine adaptation is required and lives in `engine.mjs`: that engine accepts a single
  `WaveShaperNode.curve` assignment per node, while the IDL allows re-assignment (the project assigns
  an identity curve at build, then the real curve on apply). Writes are recorded and the last one is
  flushed just before `startRendering()`; a rejected write aborts the run rather than silently
  rendering without saturation. (Without this, the whole chain reads 12 dB low and every number is
  wrong — the harness was wrong before the product was, which is the reason for the assertion.)
- A second engine divergence is handled in production, not the harness: this engine's
  `DynamicsCompressorNode` latency is 8.7/8.0/6.7/6.0 ms at 44.1/48/96/192 kHz (block-processing
  latency in the reimplementation), not the 6.000 ms browsers share. Production matches the
  multiband dry path to the *measured* latency (`resolveDryDelaySeconds`), so renders align on
  every engine; the render report records which value was used (`report.latency`).
- `LD_LIBRARY_PATH=<dir with libasound.so.2>` may be needed to load the native module in a bare
  container. No audio device is ever opened; only `OfflineAudioContext` is used.

## Layout

    scripts/      harness + meters (JS renders, Python measures)
    jobs-*.json   the exact job lists behind every number in the findings
    findings/     SON-1 … SON-5, each with material, settings, repro, measurements, severity
    results/      committed measurement JSON; no audio
    goldens/      protected sonic baselines (commit SHA + numbers + note)
