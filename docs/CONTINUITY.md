# Continuity

## Protected baselines

- `5adcf91` + reconciliation `78e264b`: saturation has ±4 curve-domain headroom and
  unity small-signal gain; compressor fixed make-up is cancelled separately; multiband
  dry delay is 6 ms. Preserve `tests/dsp/saturation.test.js`,
  `tests/dsp/dynamics-compressor-makeup.test.js` and `tests/integration/graph.test.js`.
- `78e264b`: preview/export share `adaptParameters`; mastering families exclude
  degradation, and crest/ambition guards may deliver below the requested loudness.
  Preserve `tests/dsp/source-aware.test.js`, `tests/dsp/mastering-guardrails.test.js`,
  `tests/app/preset-families.test.js` and `tests/integration/render-pipeline.test.js`.
- `14e8529`: DirectSpeakers IDs use type `0001`; RF64/BW64 planning and independent
  export checks are authoritative. Preserve `tests/format/` and
  `tests/interoperability/`; structural/decoder validation is not XSD or Atmos certification.

## Integration contracts

- PCM is `{ sampleRate, length, channels: Float32Array[] }`.
  `renderMaster({ source, parameters, ... })` returns `{ data, report }`; retain both.
- `src/runtime/` contains opt-in primitives, **not** a completed migration. Bootstrap
  still uses `createAnalysisScheduler()` / `src/workers/analysis-client.js`; do not
  delete that protocol or claim streaming/worker rendering is active.
- Audition state is `A` original / `B` mastered / `C` matched. `initAbEnhanced` owns
  both loudness-match click controls; the real-bootstrap test guards against double toggles.
- Package/engine version remains `7.0.0`, preset schema `3`; unreleased changes do not
  make the dormant branch's `7.1.0` an adopted release.

## Open handoffs / merge order

- [Browser multiband A-6 (#12)](https://github.com/zazieproductions/Signal-Rot-Audio-Mastering-Suite-/issues/12) remains open: the ideal Node filter model is not evidence of a
  flat real wet sum. Keep `tests/browser/multiband.spec.js`'s 1.5 dB limit and the
  compensated gain/delay baseline while fixing it. See [findings](FINDINGS-FOR-AGENT-A.md).
- [Enhanced A/B vs A/B/C (#13)](https://github.com/zazieproductions/Signal-Rot-Audio-Mastering-Suite-/issues/13): keyboard/indicator handling still conflicts. Port
  the enhanced UI to the three-way contract rather than reverting Matched mode.
- [General CI/conformance (#15)](https://github.com/zazieproductions/Signal-Rot-Audio-Mastering-Suite-/issues/15) are uninstalled templates; only export validation is an active
  test workflow. Resolve existing formatting and browser failures before installing;
  [CI notes](../ci/README.md) give the prerequisites.
- [Dormant branch handoff (#14)](https://github.com/zazieproductions/Signal-Rot-Audio-Mastering-Suite-/issues/14): before reviving
  `arena/01a05b69-signal-rot-audio-mastering-sui` (`eea94dc`), rebase
  onto merged main and port its HQ saturator to the current headroom/gain contract.
  `arena/01a0132a-signal-rot-audio-mastering-sui` (`75efa36`) duplicates the old modular
  refactor: retire it, or port only a demonstrably missing fix; do not merge it wholesale.
