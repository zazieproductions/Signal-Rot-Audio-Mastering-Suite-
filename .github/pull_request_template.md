## What this changes

<!-- One paragraph. If it changes what a render sounds like, say so in the first sentence. -->

## Area

<!-- The seven repository domains from docs/COLOR-SYSTEM.md. The labeler applies the
     matching `area:*` labels from your touched paths; check this list against them. -->

- [ ] DSP — engine, measurement, render maths
- [ ] Spatial — immersive beds, speaker fields, Sonic Lab
- [ ] Runtime — jobs, workers, budgets, preflight
- [ ] Export — formats, ADM, delivery, interoperability
- [ ] Testing — suites, conformance lab, CI
- [ ] UI — controls, visualizers, styles
- [ ] App — state, schema, presets

## Type

- [ ] Bug fix
- [ ] DSP change (audible)
- [ ] DSP change (inaudible / refactor)
- [ ] New feature
- [ ] Documentation
- [ ] Tooling / CI

## Audio impact

- [ ] No change to rendered output
- [ ] Changes rendered output — described below, with before/after measurements

<!--
If output changes, include measured numbers, not adjectives. For example:
  pink noise @ -14 LUFS target: before -14.02 LUFS / -1.00 dBTP, after -14.00 / -1.00
-->

## Claims

- [ ] I have not added any claim of standards compliance that is not backed by a test
- [ ] Any approximation is documented as an approximation in the code and in `docs/`
- [ ] UI labels match what the DSP actually does

## Checks

- [ ] `npm run lint` passes
- [ ] `npm run test` passes
- [ ] `npm run build` passes
- [ ] New behaviour has tests
- [ ] `docs/` updated if behaviour or limitations changed
- [ ] `CHANGELOG.md` updated
