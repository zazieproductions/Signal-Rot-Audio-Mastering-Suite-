# Contributing

## The one rule

**Do not add a claim that is not backed by a test.**

Signal Rot's value is that its documentation and its interface describe what the code
actually does. If a process is an approximation, the code comment, the UI copy and the
documentation must all say so. If you cannot test a claim, qualify it.

The pre-7.0 build described a cubic interpolator as "4× oversampled inter-sample detection"
and an approximated K-weighting as "BS.1770". Both were true-ish and both were misleading.
That is the failure mode this project is organised against.

## Getting started

```bash
npm ci
npm run dev
npm run check    # lint + test + export validation + build — run before opening a PR
```

Read [continuity notes](docs/CONTINUITY.md) before rebasing or changing a protected
baseline, and [CI status](ci/README.md) before claiming a pull request is fully gated.

## Where things go

| Kind of change              | Where                                                       |
| --------------------------- | ----------------------------------------------------------- |
| A numeric routine           | `src/audio/**` as a **pure function over typed arrays**     |
| Web Audio node construction | `src/audio/graph/**` or `src/audio/immersive/**`            |
| A new user-facing value     | `src/app/parameters.js` first — the UI is generated from it |
| A new control               | Nowhere. Add the parameter; the control appears.            |
| File-format work            | `src/audio/encode/**` or `src/audio/immersive/adm.js`       |
| Interface                   | `src/ui/**` — never construct audio nodes here              |
| Drawing                     | `src/visualizers/**` — never allocate per frame             |

Which workstream owns which ground, who reviews what, and the boundary conventions between
them: [`docs/WORKSTREAMS.md`](docs/WORKSTREAMS.md). The seven domain colours those documents
and the diagrams share are specified in [`docs/COLOR-SYSTEM.md`](docs/COLOR-SYSTEM.md);
`npm run test` keeps code, docs and GitHub labels in sync.

### Adding a parameter

Add one entry to `PARAMETER_LIST`:

```js
{
  key: 'myControl',
  type: 'number',
  defaultValue: 0,
  min: 0, max: 100, step: 1,
  unit: '%',
  label: 'My control',
  hint: 'What it actually does, including the frequency if it has one.',
  group: 'tone',
  displayFormatter: (v) => `${Math.round(v)} %`,
  previewSupported: true,
  exportSupported: true,
}
```

You get the slider, the label, the readout, the `aria-valuetext`, clamping on every write
including preset load, the export-only badge if `previewSupported` is false, the row in the
About tab's divergence table, and the row in `docs/PRESET-SCHEMA.md`.

If `previewSupported` is false you **must** supply `previewNote`. A test enforces it.

## DSP changes

Anything that changes what a render sounds like:

1. **Measure before and after.** Numbers, not adjectives.
2. **Add the measurement to the test suite**, preferably in
   `tests/integration/render-pipeline.test.js`.
3. **Put the numbers in the PR description.**
4. **Update `docs/DSP-SIGNAL-FLOW.md`** if the chain order or a stage's behaviour changed.

Example of the standard:

> Pink noise at a −14 LUFS target, −1 dBTP ceiling
> before: −14.02 LUFS / −1.00 dBTP / −3.4 dB max GR
> after: −14.00 LUFS / −1.00 dBTP / −3.1 dB max GR

## Tests

Read [`docs/TESTING.md`](docs/TESTING.md). The essentials:

- Assert against **analytically known** values where one exists. A test that asserts a
  function returns what it currently returns proves nothing.
- Generate test signals with `tests/helpers/signals.js`. **Never commit audio files.**
- Verify file formats with `tests/helpers/riff.js`, not with the writer's own code.
- When fixing a bug, add the reproduction **first**, and keep an assertion of the old
  failure if it is cheap to express — see `tests/dsp/multiband-crossover.test.js`.

## Style

ESLint and Prettier are configured and enforced in CI. Beyond that:

- **Comment the mathematics, not the syntax.** `// increment i` is noise. `// 10·log10
because z is a mean square, not an amplitude` is the reason the next reader will not
  break it.
- **Cite the standard** where one applies, with the section: "BS.1770-4 §5.3", "EBU Tech
  3342 §2".
- **Record measurements in the source** where they justify a design choice. The true-peak
  module carries its own accuracy table.
- **Name things after what they are.** The control formerly called "phase rotation" is a
  comb filter, and is now called one.
- JSDoc on every exported function. Types where they clarify; this is plain JavaScript with
  JSDoc, not TypeScript.

## Scope

Signal Rot is a mastering, spatial-audio and degraded-media laboratory. In scope:

- Mastering processes and measurement
- Immersive and spatial audio
- Degraded-media aesthetics — tape, vinyl, noise, decay
- Experimental sound design
- Anything that makes the tool more honest about what it is doing

Out of scope: general-purpose audio editing, MIDI, instruments, stem separation, "AI
mastering", anything requiring a server, and any feature that would need a claim we cannot
test.

Complex features are not removed for being difficult. If something is hard and
approximate, the answer is to improve it and describe its limitations accurately — not to
delete it.

## Commits and pull requests

Conventional Commits, with an `audio:` scope for anything audible:

```
fix(audio): phase-match the multiband dry path
feat(immersive): export a channel identification file
docs: record the measured true-peak accuracy
test(dsp): assert the pre-7.0 crossover null
```

The PR template asks whether the change alters rendered output. Answer it honestly; it is
the most useful line in the whole form.

## Reporting problems

Use the issue templates. For an audio defect, the **render report** usually answers the
question on its own — it records the analysis before and after, the gain applied, the gain
reduction and the verified true peak. Attach it, and the preset JSON.

Please describe signals we can generate ("pink noise at −20 dBFS", "full-scale sine at
fs/4") rather than attaching music.

## Licence

Contributions are accepted under the MIT licence.
