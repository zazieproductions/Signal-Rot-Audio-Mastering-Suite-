/**
 * Signal Rot — analysis worker.
 * Offloads loudness (BS.1770) and true-peak measurement off the main thread.
 * Channel data is transferred (zero-copy) as detached ArrayBuffers.
 */
import { measureLUFS, truePeakFile } from '../lib/dsp.js';

self.onmessage = (e) => {
  const { id, kind, sampleRate, channels } = e.data;
  try {
    const buf = {
      numberOfChannels: channels.length,
      sampleRate,
      length: channels[0] ? channels[0].length : 0,
      getChannelData: (c) => channels[c],
    };
    let result = {};
    if (kind === 'lufs') result = measureLUFS(buf);
    else if (kind === 'tp') result = { tp: truePeakFile(buf) };
    else if (kind === 'both') {
      const lufs = measureLUFS(buf);
      result = { lufs: lufs.lufs, lra: lufs.lra, tp: truePeakFile(buf) };
    }
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error && error.message ? error.message : String(error) });
  }
};
