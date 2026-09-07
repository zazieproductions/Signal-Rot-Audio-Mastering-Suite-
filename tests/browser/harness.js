/**
 * Browser-side conformance lab. Loaded by harness.html; Playwright calls into
 * `window.__SR_LAB__`.
 */

import { runCompressorSuite } from './lab/compressor.js';
import { runWaveShaperSuite } from './lab/waveshaper.js';
import { runMultibandSuite } from './lab/multiband.js';
import { runStereoSectionSuite } from './lab/stereo-section.js';
import { probeAllRates } from './lab/sample-rates.js';
import { measurePreviewExportParity } from './lab/preview-export.js';
import { runImmersiveSuite } from './lab/immersive.js';
import { runBenchmarks } from './lab/benchmarks.js';
import { ua, probeRate } from './lab/util.js';
import { SAMPLE_RATES } from '../conformance/thresholds.js';

const lab = {
  ready: true,
  browser: ua(),
  userAgent: navigator.userAgent,
  probeRate,
  probeAllRates: () => probeAllRates(SAMPLE_RATES),
  compressor: runCompressorSuite,
  waveshaper: runWaveShaperSuite,
  multiband: runMultibandSuite,
  stereoSection: runStereoSectionSuite,
  previewExport: measurePreviewExportParity,
  immersive: runImmersiveSuite,
  benchmarks: runBenchmarks,
};

window.__SR_LAB__ = lab;

const status = document.getElementById('status');
if (status) {
  status.textContent = `ready · ${lab.browser} · OfflineAudioContext ${
    window.OfflineAudioContext || window.webkitOfflineAudioContext ? 'yes' : 'no'
  }`;
}
