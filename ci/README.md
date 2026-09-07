# CI configuration

## Active checks

`.github/workflows/export-interoperability.yml` runs format/interoperability unit tests,
ADM structural validation, independent export validation and ffprobe/channel-order checks.
It does **not** run the full application, DSP, runtime, UI or browser suites.

The Labeler workflow uses `.github/labeler.yml` (the v4 glob format) and the existing
`documentation` label. A missing config previously failed every PR's label check.

## Templates, not active gates

Enablement is tracked in [#15](https://github.com/zazieproductions/Signal-Rot-Audio-Mastering-Suite-/issues/15).

- `github-actions-ci.yml`: formatting, lint, the full Vitest suite, build and UI E2E.
- `conformance.yml`: Node goldens/benchmarks and Chromium/Firefox/WebKit conformance.

These were staged here because the original automation account could not push workflow
changes. Their presence does not mean GitHub runs them. Before installing them:

1. Resolve the existing repository-wide `npm run format:check` failures in a separate
   formatting-only change; do not mix wholesale formatting with a DSP fix.
2. Run UI E2E and the browser matrix. Keep the multiband A-6 contract in
   `tests/browser/multiband.spec.js`; do not relax it just to turn a new gate green.
3. Move the templates to `.github/workflows/ci.yml` and
   `.github/workflows/conformance.yml`. Update the conformance workflow's own path filters
   from `ci/conformance.yml` to its installed path, and include dependency/preset changes.

No secrets are needed for those test jobs. Check results after installation, not just the
workflow files, before claiming the full suite is protected on pull requests.

## Local checks

```bash
npm ci
npm run check            # lint + full Vitest + independent export validation + build
npm run format:check     # separate from check
npm run test:e2e         # requires: npx playwright install chromium
npm run test:conformance # requires: npx playwright install chromium firefox webkit
npm run lab:goldens && npm run lab:bench
```
