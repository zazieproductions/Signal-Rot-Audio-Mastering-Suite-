/**
 * Playback transport.
 *
 * Owns exactly one `AudioBufferSourceNode` at a time and is careful to detach `onended`
 * before stopping, because a stop that fires `onended` asynchronously after a new source
 * has already started will reset the play state of the *new* source.
 */

import { formatTime, $ } from './dom.js';

/**
 * @param {object} opts
 * @param {() => AudioContext} opts.getContext
 * @param {() => AudioNode|null} opts.getDestination
 * @param {() => AudioBuffer|null} opts.getBuffer
 * @param {(playing:boolean)=>void} [opts.onStateChange]
 */
export function createTransport(opts) {
  /** @type {AudioBufferSourceNode|null} */
  let source = null;
  let playing = false;
  let startedAt = 0;
  let offset = 0;
  /** @type {[number, number]|null} */
  let loopRegion = null;

  const stopSource = () => {
    if (!source) return;
    try {
      source.onended = null;
      source.stop();
    } catch {
      /* not started */
    }
    try {
      source.disconnect();
    } catch {
      /* already disconnected */
    }
    source = null;
  };

  const api = {
    get playing() {
      return playing;
    },
    get loopRegion() {
      return loopRegion;
    },
    setLoopRegion(region) {
      loopRegion = region;
    },

    position() {
      const buffer = opts.getBuffer();
      if (!buffer) return 0;
      if (!playing) return Math.min(offset, buffer.duration);
      const ctx = opts.getContext();
      return Math.min(Math.max(ctx.currentTime - startedAt, 0), buffer.duration);
    },

    play(at = null) {
      const buffer = opts.getBuffer();
      const destination = opts.getDestination();
      if (!buffer || !destination) return;
      const ctx = opts.getContext();
      if (ctx.state === 'suspended') ctx.resume();
      stopSource();
      source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(destination);
      const pos = Math.min(Math.max(at ?? offset, 0), buffer.duration);
      startedAt = ctx.currentTime - pos;
      const node = source;
      source.onended = () => {
        // Only react if this is still the current source.
        if (source !== node) return;
        playing = false;
        offset = 0;
        api.notify();
      };
      source.start(0, pos);
      playing = true;
      api.notify();
    },

    pause() {
      if (!playing) return;
      offset = api.position();
      stopSource();
      playing = false;
      api.notify();
    },

    stop() {
      stopSource();
      playing = false;
      offset = 0;
      api.notify();
    },

    seek(seconds) {
      offset = Math.max(0, seconds);
      if (playing) api.play(offset);
      else api.notify();
    },

    toggle() {
      if (!opts.getBuffer()) return;
      if (playing) api.pause();
      else api.play();
    },

    /** Called from the animation loop: handles loop wrap-around. */
    tick() {
      if (!playing || !loopRegion) return;
      if (api.position() >= loopRegion[1]) api.play(loopRegion[0]);
    },

    notify() {
      const button = $('#playBtn');
      if (button) {
        button.textContent = playing ? '❚❚' : '▶';
        button.setAttribute('aria-label', playing ? 'Pause' : 'Play');
        button.setAttribute('aria-pressed', String(playing));
      }
      if (opts.onStateChange) opts.onStateChange(playing);
    },

    updateTimeDisplay() {
      const buffer = opts.getBuffer();
      const label = $('#timeLabel');
      if (!buffer || !label) return;
      label.textContent = `${formatTime(api.position())} / ${formatTime(buffer.duration)}`;
    },
  };

  return api;
}
