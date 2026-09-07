/**
 * Test-scope markers.
 *
 * Every test in the suite is *about* something; this file makes the "what" visible
 * at the top of every test file and gives a single vocabulary the CI can grep for
 * to answer "is this suite testing the browser, or the math?"
 *
 * The two scopes are:
 *
 *   IDEAL MATH       — the test drives the production graph / detector / filter
 *                       helper with synthetic samples and compares the answer to
 *                       an analytic value. The browser is not in the loop.
 *                       These run in plain Node and in any environment.
 *
 *   REAL WEB AUDIO   — the test instantiates `OfflineAudioContext` (or the live
 *                       `AudioContext`) and runs the actual `BiquadFilterNode` /
 *                       `DynamicsCompressorNode` / `WaveShaperNode`. These can
 *                       only run in a browser engine with Web Audio. They live
 *                       in `tests/browser/` and are gated on Playwright with the
 *                       matrix `[chromium, firefox, webkit]`.
 *
 * The same file may legitimately have tests in both scopes — `tests/dsp/biquad.test.js`
 * uses `designBiquad` (IDEAL MATH) and asserts on its filter response, while
 * `tests/browser/compressor.spec.js` uses `ctx.createDynamicsCompressor()` (REAL
 * WEB AUDIO) and measures the real engine's make-up. The distinction is the *test
 * driver*, not the production code under test.
 *
 * A test that says "I am testing REAL WEB AUDIO" but is actually running in
 * Node-only `vitest` is a lie that *passes*, which is the worst kind of test.
 * This file is the gate's defence: every new test must declare its scope.
 *
 * Usage:
 *
 *   import { SCOPE, mark } from '../conformance/scope.js';
 *   describe(`${mark(SCOPE.IDEAL_MATH)} crossover reconstruction`, () => {
 *     it('mix 1 sums flat', () => { ... });
 *   });
 *
 * The marker string is what the CI run logs. The `mark` helper prefixes the
 * describe block with `[IDEAL MATH]` or `[REAL WEB AUDIO]` so a `grep` over
 * the test output can answer "what did the suite actually cover?".
 */

export const SCOPE = Object.freeze({
  IDEAL_MATH: 'IDEAL MATH',
  REAL_WEB_AUDIO: 'REAL WEB AUDIO',
});

/** Format the scope as a prefix the test report can show. */
export function mark(scope, name = '') {
  if (name) return `[${scope}] ${name}`;
  return `[${scope}]`;
}
