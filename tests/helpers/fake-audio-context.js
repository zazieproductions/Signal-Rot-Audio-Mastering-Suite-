/**
 * A minimal, recording implementation of the Web Audio node API.
 *
 * It does not process audio. Its purpose is to let the graph-construction code run in Node
 * so that tests can assert on **topology and parameter values** — that every declared
 * speaker feed exists, that bypass really neutralises a module, that the saturation
 * make-up gain lives on its own node, that no oscillator is leaked.
 *
 * Node behaviour that matters to the code under test is implemented (`connect`,
 * `disconnect`, `AudioParam.value`, `AudioParam.connect` for LFO modulation,
 * `DynamicsCompressorNode.reduction`); everything else throws loudly rather than silently
 * doing nothing, so a test cannot pass because the fake was too forgiving.
 */

class FakeAudioParam {
  constructor(name, value = 0) {
    this.name = name;
    this.value = value;
    this.inputs = [];
  }
  setValueAtTime(v) {
    this.value = v;
    return this;
  }
}

let nodeId = 0;

class FakeAudioNode {
  constructor(context, type) {
    this.context = context;
    this.type = type;
    this.nodeType = type;
    this.id = ++nodeId;
    this.outputs = [];
    this.inputs = [];
    this.disconnected = false;
    context.nodes.push(this);
  }
  connect(destination, output = 0, input = 0) {
    if (!destination) throw new Error(`connect() to ${destination}`);
    this.outputs.push({ destination, output, input });
    if (destination.inputs) destination.inputs.push({ source: this, output, input });
    return destination instanceof FakeAudioParam ? undefined : destination;
  }
  disconnect(target) {
    this.disconnected = true;
    if (target) this.outputs = this.outputs.filter((o) => o.destination !== target);
    else this.outputs = [];
  }
}

class FakeGainNode extends FakeAudioNode {
  constructor(context) {
    super(context, 'gain');
    this.gain = new FakeAudioParam('gain', 1);
  }
}

class FakeBiquadFilterNode extends FakeAudioNode {
  constructor(context) {
    super(context, 'biquad');
    this.type = 'lowpass';
    this.frequency = new FakeAudioParam('frequency', 350);
    this.Q = new FakeAudioParam('Q', 1);
    this.gain = new FakeAudioParam('gain', 0);
    this.detune = new FakeAudioParam('detune', 0);
  }
}

class FakeDelayNode extends FakeAudioNode {
  constructor(context, maxDelay) {
    super(context, 'delay');
    this.maxDelayTime = maxDelay;
    this.delayTime = new FakeAudioParam('delayTime', 0);
  }
}

class FakeDynamicsCompressorNode extends FakeAudioNode {
  constructor(context) {
    super(context, 'compressor');
    this.threshold = new FakeAudioParam('threshold', -24);
    this.knee = new FakeAudioParam('knee', 30);
    this.ratio = new FakeAudioParam('ratio', 12);
    this.attack = new FakeAudioParam('attack', 0.003);
    this.release = new FakeAudioParam('release', 0.25);
    this.reduction = 0;
  }
}

class FakeWaveShaperNode extends FakeAudioNode {
  constructor(context) {
    super(context, 'waveshaper');
    this.curve = null;
    this.oversample = 'none';
  }
}

class FakeOscillatorNode extends FakeAudioNode {
  constructor(context) {
    super(context, 'oscillator');
    this.type = 'sine';
    this.frequency = new FakeAudioParam('frequency', 440);
    this.detune = new FakeAudioParam('detune', 0);
    this.started = false;
    this.stopped = false;
  }
  start() {
    if (this.started) throw new Error('oscillator started twice');
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
}

class FakeBufferSourceNode extends FakeAudioNode {
  constructor(context) {
    super(context, 'buffersource');
    this.buffer = null;
    this.loop = false;
    this.started = false;
    this.stopped = false;
  }
  start() {
    if (this.started) throw new Error('buffer source started twice');
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
}

class FakeChannelSplitterNode extends FakeAudioNode {
  constructor(context, channels) {
    super(context, 'splitter');
    this.numberOfOutputs = channels;
  }
}

class FakeChannelMergerNode extends FakeAudioNode {
  constructor(context, channels) {
    super(context, 'merger');
    this.numberOfInputs = channels;
  }
}

class FakePannerNode extends FakeAudioNode {
  constructor(context) {
    super(context, 'panner');
    this.panningModel = 'equalpower';
    this.distanceModel = 'inverse';
    this.refDistance = 1;
    this.maxDistance = 10000;
    this.positionX = new FakeAudioParam('positionX', 0);
    this.positionY = new FakeAudioParam('positionY', 0);
    this.positionZ = new FakeAudioParam('positionZ', 0);
  }
}

class FakeAudioBuffer {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this._data = [];
    for (let c = 0; c < channels; c++) this._data.push(new Float32Array(length));
  }
  getChannelData(c) {
    return this._data[c];
  }
  copyToChannel(source, c) {
    this._data[c].set(source);
  }
}

export class FakeAudioContext {
  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.state = 'running';
    this.nodes = [];
    this.destination = new FakeAudioNode(this, 'destination');
  }
  createGain() {
    return new FakeGainNode(this);
  }
  createBiquadFilter() {
    return new FakeBiquadFilterNode(this);
  }
  createDelay(maxDelay = 1) {
    return new FakeDelayNode(this, maxDelay);
  }
  createDynamicsCompressor() {
    return new FakeDynamicsCompressorNode(this);
  }
  createWaveShaper() {
    return new FakeWaveShaperNode(this);
  }
  createOscillator() {
    return new FakeOscillatorNode(this);
  }
  createBufferSource() {
    return new FakeBufferSourceNode(this);
  }
  createChannelSplitter(channels = 2) {
    return new FakeChannelSplitterNode(this, channels);
  }
  createChannelMerger(channels = 2) {
    return new FakeChannelMergerNode(this, channels);
  }
  createPanner() {
    return new FakePannerNode(this);
  }
  createAnalyser() {
    const node = new FakeAudioNode(this, 'analyser');
    node.fftSize = 2048;
    node.frequencyBinCount = 1024;
    node.smoothingTimeConstant = 0.8;
    node.getFloatTimeDomainData = (a) => a.fill(0);
    node.getByteFrequencyData = (a) => a.fill(0);
    return node;
  }
  createBuffer(channels, length, sampleRate) {
    return new FakeAudioBuffer(channels, length, sampleRate ?? this.sampleRate);
  }
}

/** Every node of a given type in the context. */
export const nodesOfType = (ctx, type) => ctx.nodes.filter((n) => n.nodeType === type);

/**
 * Breadth-first search for a path from `from` to `to` through the connection graph.
 * Used to assert that a signal path exists without depending on how it is wired.
 */
export function isConnected(from, to) {
  const seen = new Set();
  const queue = [from];
  while (queue.length) {
    const node = queue.shift();
    if (node === to) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const edge of node.outputs ?? []) queue.push(edge.destination);
  }
  return false;
}
