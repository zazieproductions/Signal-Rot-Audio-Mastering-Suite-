# Runtime contracts

- `createJobScheduler()` is the shared bounded scheduler. Jobs expose `cancel()`, `run({ isCancelled, report })`, and observable states. Use `key` for latest-wins/backpressure. Heavy render jobs should use concurrency 1.
- `createWorkerRpc(worker)` is the common worker protocol. Transfer only disposable buffers; transferred buffers are detached and must never be reused by the caller.
- `estimateRender(shape)` and `estimateImmersiveRender(shape)` provide structured preflight results for UI consumers.
- `buildWaveformPyramid(channel)` creates cached min/max data; visualizers should select `waveformLevel(pyramid, pixelWidth)` instead of rescanning source audio.
- `consumeAudioChunks()` is stream-ready infrastructure. Existing Web Audio mastering remains a full-buffer render.

Agent A can use scheduler cancellation/progress without changing DSP. Agent C can use scheduler keys and subscriptions for sequential batch export progress. Agent E can consume job snapshots, preflight classification/breakdown, and waveform levels without changing presentation.
