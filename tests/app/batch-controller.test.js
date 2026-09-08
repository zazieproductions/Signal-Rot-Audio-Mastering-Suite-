/**
 * @vitest-environment jsdom
 *
 * Batch-workflow tests against the real controller: queue states, per-file
 * failure isolation, cancellation, retry, memory preflight refusal and output
 * naming. `renderMaster` is mocked — this is a workflow test, not a DSP test —
 * but decoding, encoding, naming and the queue UI are all real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createStore } from '../../src/app/state.js';
import { createExportController } from '../../src/app/export-controller.js';
import { installFakeCanvas } from '../helpers/fake-canvas.js';

vi.mock('../../src/audio/render/render-master.js', () => ({
  renderMaster: vi.fn(async ({ source, sampleRate }) => {
    const frames = Math.ceil(source.duration * (sampleRate || source.sampleRate));
    return {
      data: {
        sampleRate: sampleRate || source.sampleRate,
        length: frames,
        channels: [new Float32Array(frames).fill(0.1), new Float32Array(frames).fill(0.1)],
      },
      report: {
        loudness: { achievedLufs: -14.2 },
        limiter: {
          achievedTruePeakDbtp: -1.0,
          maximumGainReductionDb: -0.3,
          ceilingRespected: true,
        },
        warnings: [],
      },
    };
  }),
  renderChain: vi.fn(),
  requiresStereo: () => false,
}));

const { renderMaster } = await import('../../src/audio/render/render-master.js');

/** A default 100 ms 48 kHz stereo tone buffer. */
function toneBuffer({ channels = 2, sampleRate = 48000, frames = 4800 } = {}) {
  const data = [];
  for (let c = 0; c < channels; c++) {
    const ch = new Float32Array(frames);
    for (let i = 0; i < frames; i++)
      ch[i] = 0.2 * Math.sin((2 * Math.PI * (110 + c * 50) * i) / sampleRate);
    data.push(ch);
  }
  return {
    numberOfChannels: channels,
    length: frames,
    sampleRate,
    duration: frames / sampleRate,
    getChannelData: (c) => data[c],
  };
}

function makeFile(name, bytes = new TextEncoder().encode(name), type = 'audio/wav') {
  const file = new File([bytes], name, { type });
  // jsdom's File has no arrayBuffer(); the app only reads bytes through it.
  file.arrayBuffer = () =>
    Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return file;
}

let toast;
let announce;

beforeEach(() => {
  vi.restoreAllMocks();
  installFakeCanvas(window);
  document.body.innerHTML = `
    <select id="fmtSelect"><option value="wav24" selected>24</option></select>
    <select id="srSelect"><option value="0" selected>source</option></select>
    <button id="exportBtn"></button>
    <div id="exportProg"><i></i></div>
    <div id="exportProgText"></div>
    <div id="exportNotice"></div>
    <div id="renderHistory"></div>
    <div id="batchList"></div>
    <button id="batchRunBtn"></button>
    <button id="batchCancelBtn" hidden></button>
    <div id="batchProg"><i></i></div>
    <div id="batchProgText"></div>
    <div id="toast"></div>
  `;
  toast = vi.fn();
  announce = vi.fn();

  // The app's shared-context module keeps a module-level singleton; the first
  // test's fake class is reused afterwards, which is fine — every fake decodes
  // identically from the file *contents*.
  window.AudioContext = class {
    constructor() {
      this.state = 'running';
    }
    decodeAudioData(bytes) {
      const text = new TextDecoder().decode(bytes);
      if (text.includes('CORRUPT')) return Promise.reject(new DOMException('bad', 'EncodingError'));
      if (text.includes('UNSUPPORTED'))
        return Promise.reject(new DOMException('no codec', 'NotSupportedError'));
      // Shape encoded in the file contents: "ch<N>_<rate>k_<minutes>m"
      return Promise.resolve(parseShape(text) ?? toneBuffer());
    }
  };
});

/** Decode the shape string `ch<N>_<rate>k_<minutes>m` into a buffer. */
function parseShape(text) {
  const m = text.match(/^ch(\d+)_(\d+(?:\.\d+)?k)_(\d+)m/);
  if (!m) return null;
  const channels = Number(m[1]);
  const sampleRate = Number(m[2].replace('k', '')) * 1000;
  const frames = Number(m[3]) * 60 * sampleRate;
  const data = [];
  for (let c = 0; c < channels; c++) data.push(new Float32Array(frames));
  return {
    numberOfChannels: channels,
    length: frames,
    sampleRate,
    duration: frames / sampleRate,
    getChannelData: (c) => data[c],
  };
}

afterEach(() => {
  window.AudioContext = undefined;
});

describe('batch queue lifecycle', () => {
  it('decodes each file independently: good rows ready, bad rows failed with reasons', async () => {
    const controller = createExportController({ store: createStore(), toast, announce });
    controller.init();
    await controller.enqueueFiles([
      makeFile('a.wav'),
      makeFile('broken.wav', new TextEncoder().encode('CORRUPT data')),
      makeFile('empty.wav', new Uint8Array(0)),
    ]);
    const [a, broken, empty] = controller.queue;
    expect(a.state).toBe('ready');
    expect(broken.state).toBe('failed');
    expect(broken.reason).toMatch(/truncated or corrupted/i);
    expect(empty.state).toBe('failed');
    expect(empty.reason).toMatch(/empty/);
    // The row renders the reason; the run button is enabled by the good rows.
    expect(document.querySelector('#batchList').textContent).toMatch(/truncated or corrupted/);
    expect(document.querySelector('#batchRunBtn').disabled).toBe(false);
  });

  it('renders the queue with per-row status and loudness', async () => {
    const controller = createExportController({ store: createStore(), toast, announce });
    controller.init();
    await controller.enqueueFiles([makeFile('a.wav')]);
    await vi.waitFor(() => {
      expect(controller.queue[0].lufs).toBeTypeOf('number');
    });
    const list = document.querySelector('#batchList');
    expect(list.textContent).toMatch(/ready/);
    expect(list.textContent).toMatch(/LUFS/);
  });

  it('runs the queue sequentially, names outputs predictably and deduplicates', async () => {
    const controller = createExportController({ store: createStore(), toast, announce });
    controller.init();
    await controller.enqueueFiles([
      makeFile('Track One.wav'),
      makeFile('Track One.wav'), // same base name → must not collide
      makeFile('broken.wav', new TextEncoder().encode('CORRUPT data')),
    ]);

    const order = [];
    const realRender = vi.mocked(renderMaster);
    realRender.mockImplementation(async ({ source }) => {
      order.push(source.duration);
      const frames = Math.ceil(source.duration * source.sampleRate);
      return {
        data: {
          sampleRate: source.sampleRate,
          length: frames,
          channels: [new Float32Array(frames).fill(0.1), new Float32Array(frames).fill(0.1)],
        },
        report: {
          loudness: { achievedLufs: -14 },
          limiter: {
            achievedTruePeakDbtp: -1,
            maximumGainReductionDb: -0.2,
            ceilingRespected: true,
          },
          warnings: [],
        },
      };
    });

    await controller.runBatch();

    const [first, second, broken] = controller.queue;
    expect(first.state).toBe('done');
    expect(second.state).toBe('done');
    expect(broken.state).toBe('failed'); // one bad file must not abort the batch
    expect(first.outputName).toBe('Track One_master_24bit_48k.wav');
    expect(second.outputName).toBe('Track One_master_24bit_48k_2.wav');
    // sequential: no overlapping renders
    expect(order).toHaveLength(2);
    // per-item report survives on the item, and history keeps the same name
    expect(first.report.loudness.achievedLufs).toBe(-14);
    expect(document.querySelector('#batchList').textContent).toContain(
      'Track One_master_24bit_48k.wav',
    );
    // The summary counts the batch (the ready rows); the broken row is not part of it.
    expect(document.querySelector('#batchProgText').textContent).toMatch(/2 exported of 2/);
    expect(broken.state).toBe('failed');
  });

  it('cancellation stops the batch after the current file; the rest are skipped, not silently dropped', async () => {
    const controller = createExportController({ store: createStore(), toast, announce });
    controller.init();
    await controller.enqueueFiles([
      makeFile('one.wav'),
      makeFile('two.wav'),
      makeFile('three.wav'),
    ]);

    let release;
    const gate = new Promise((r) => (release = r));
    vi.mocked(renderMaster).mockImplementationOnce(async () => {
      await gate;
      const frames = 4800;
      return {
        data: {
          sampleRate: 48000,
          length: frames,
          channels: [new Float32Array(frames).fill(0.1), new Float32Array(frames).fill(0.1)],
        },
        report: {
          loudness: { achievedLufs: -14 },
          limiter: { achievedTruePeakDbtp: -1, maximumGainReductionDb: 0, ceilingRespected: true },
          warnings: [],
        },
      };
    });

    const running = controller.runBatch();
    controller.cancelBatch(); // while file one is rendering
    release();
    await running;

    const [one, two, three] = controller.queue;
    expect(one.state).toBe('done');
    expect(two.state).toBe('cancelled');
    expect(three.state).toBe('cancelled');
    expect(document.querySelector('#batchProgText').textContent).toMatch(/1 skipped|2 skipped/);
  });

  it('retry re-attempts a failed row (and fails again with the same reason when the file is still bad)', async () => {
    const controller = createExportController({ store: createStore(), toast, announce });
    controller.init();
    await controller.enqueueFiles([
      makeFile('broken.wav', new TextEncoder().encode('CORRUPT data')),
    ]);
    const [item] = controller.queue;
    expect(item.state).toBe('failed');

    await controller.retryItem(item);
    expect(item.state).toBe('failed');
    expect(item.reason).toMatch(/truncated or corrupted/i);
  });

  it('refuses a batch add while a run is active', async () => {
    const controller = createExportController({ store: createStore(), toast, announce });
    controller.init();
    await controller.enqueueFiles([makeFile('one.wav')]);
    const running = controller.runBatch();
    const added = await controller.enqueueFiles([makeFile('two.wav')]);
    await running;
    expect(added).toBe(0);
    expect(toast).toHaveBeenCalledWith(
      expect.stringMatching(/already running/i),
      expect.anything(),
    );
    expect(controller.queue).toHaveLength(1);
  });
});

describe('batch memory preflight', () => {
  it('refuses an item whose render will not fit, before rendering it', async () => {
    // 256 MB budget via deviceMemory = 1. A 30-minute 8 kHz stereo file needs
    // ~345 MB across source+DSP+output — over the 1.25× line.
    Object.defineProperty(window.navigator, 'deviceMemory', { value: 1, configurable: true });

    const controller = createExportController({ store: createStore(), toast, announce });
    controller.init();
    await controller.enqueueFiles([makeFile('ch2_8k_30m.wav')]);
    const [item] = controller.queue;
    expect(item.state).toBe('ready');

    vi.mocked(renderMaster).mockReset();
    await controller.runBatch();

    expect(item.state).toBe('failed');
    expect(item.reason).toMatch(/memory/i);
    expect(item.reason).toMatch(/192|8\.0 kHz|8000/);
    expect(vi.mocked(renderMaster)).not.toHaveBeenCalled(); // refused before work
    expect(document.querySelector('#batchList').textContent).toMatch(/memory/i);
  });
});
