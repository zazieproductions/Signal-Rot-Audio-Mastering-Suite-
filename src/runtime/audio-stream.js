/** Stream-ready contract. It does not imply the Web Audio render graph is streaming. */
export function createAudioChunk({ channels, startFrame = 0, sampleRate, final = false }) {
  const frameCount = channels[0]?.length ?? 0;
  if (channels.some((channel) => channel.length !== frameCount)) throw new Error('Audio chunk channels must have equal length');
  return Object.freeze({ channels, startFrame, frameCount, sampleRate, final });
}

export async function consumeAudioChunks(source, processor, sink = () => {}) {
  if (processor.init) await processor.init();
  try {
    for await (const chunk of source) { await processor.process(chunk); await sink(chunk); }
    if (processor.flush) await processor.flush();
  } finally {
    if (processor.dispose) await processor.dispose();
  }
}
