# CI configuration

## Active gates

The four `.github/workflows/*.yml` files are the active GitHub Actions gates on every
push and pull request:

| Workflow | Triggers | Catches |
| --- | --- | --- |
| `ci.yml`               | every push / PR              | lint, full Vitest suite (Node DSP/integration/regression/oracle/A-B-C/sample-rate), independent export validation, build |
| `conformance.yml`      | DSP / preset / UI / browser / dependency changes | goldens, Node benchmarks, **Chromium / Firefox / WebKit** matrix |
| `qa.yml`               | DSP / preset / QA / oracle changes | true-peak oracle (issue #21 acceptance), regression locks, sample-rate matrix, QA structural checks |
| `export-interoperability.yml` | every push / PR        | independent RIFF/ADM parsers, ffprobe cross-check, fixture checksums |

The pre-existing `label.yml` and `summary.yml` are unchanged.

## What each new gate runs

### `ci.yml` — fast, always-on

- `npm run lint`
- `npm test` — every Node test, including the 96 added in this change (regression
  locks, true-peak oracle, sample-rate matrix, A/B/C contract, scope markers)
- `npm run validate:exports -- --quiet` — production writers vs independent
  parsers and ffprobe. Asserts the report makes no false claim (no Atmos / BS.2076
  certification claims, channel order verified for every multichannel fixture).
- `npm run build` — production bundle must build cleanly

### `conformance.yml` — slow, path-filtered

Triggered by any change to:

- `src/audio/**` (DSP, graph, render, immersive)
- `src/presets/**` (mastering presets)
- `src/app/parameters.js`, `src/app/constants.js` (the schema, the engine constants)
- `package.json` / `package-lock.json` (dependency changes)
- `tests/browser/**`, `tests/fixtures/**`, `tests/conformance/**` (the conformance lab)
- `tests/dsp/**`, `tests/integration/**`, `tools/**` (DSP-touching tests + tools)
- `tests/ui/**`, `src/ui/**`, `src/app/bootstrap.js`, `src/app/state.js`,
  `src/app/presets-io.js` (UI / state / I/O)

Documentation-only changes are intentionally excluded.

Runs the full Vitest goldens test, the Node benchmarks, and the
Chromium / Firefox / WebKit browser matrix. Each browser uploads its
`playwright-report` and `test-results` as an artifact on failure.

### `qa.yml` — focused, fast

Triggered by DSP / preset / QA / oracle changes. Five jobs:

- `true-peak-oracle` — the independent oracle for issue #21. The fix lands against
  this; until the fix is in, this job is green but logs the limiter-vs-oracle gap.
- `regression-locks` — the seven specific regressions this change exists to prevent.
- `sample-rate-matrix` — the six-rate matrix (44.1 / 48 / 88.2 / 96 / 176.4 / 192 kHz).
- `structural` — every `qa/jobs-*.json` parses; every `qa/findings/SON-*.md` has a
  proper issue header.

### `export-interoperability.yml` — unchanged

Already gates the repo. Same scope: independent RIFF/ADM parsers + ffprobe.

## Path filters

`conformance.yml` and `qa.yml` have explicit path filters so a documentation PR does
not pay the cost of a three-browser matrix. The fast `ci.yml` runs on every PR —
that is the gate a typo in `README.md` will not pass. The browser matrix is
intentionally not in the always-on gate.

## What was staged, what is active

The two `ci/*.yml` templates have been moved into `.github/workflows/`:

- `ci/conformance.yml` → `.github/workflows/conformance.yml`
- `ci/github-actions-ci.yml` → folded into `.github/workflows/ci.yml`

The `ci/` directory now contains only this README. The templates that lived there
are *not* deleted: the README points at the active files, and the directory is
preserved for any future re-staging.

## Format cleanup

`npm run format:check` is **not** part of `ci.yml`. Prettier flags ~50 files in
this repo's working tree, and the existing `ci/README.md` deliberately keeps the
formatting cleanup separate from the functional DSP/UI changes. The plan is a
single formatting-only PR; until that lands, format-check failures do not block.

## Local equivalents

```bash
npm ci
npm run check            # lint + full Vitest + independent export validation + build
npm run format:check     # separate from check
npm run test:e2e         # requires: npx playwright install chromium
npm run test:conformance # requires: npx playwright install chromium firefox webkit
npm run lab:goldens && npm run lab:bench
```
