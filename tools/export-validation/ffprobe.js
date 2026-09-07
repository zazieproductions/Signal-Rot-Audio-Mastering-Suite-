/**
 * ffprobe adapter.
 *
 * FFmpeg is the reference third-party implementation for this job: it is not ours, it has
 * decoded more broken WAV files than anything else in existence, and if it disagrees with
 * Signal Rot about a file then Signal Rot is wrong. Using it turns "our parser says the
 * file is fine" into "an independent, widely deployed decoder says the file is fine".
 *
 * ── Availability ─────────────────────────────────────────────────────────────────────
 * ffprobe is resolved in this order:
 *   1. `$FFPROBE_PATH`
 *   2. the `ffprobe-static` npm package, if installed
 *   3. `ffprobe` on `$PATH`
 *
 * When none is present the validation run reports `skipped`, with a reason, rather than
 * failing. A missing optional tool is not a malformed file, and CI must be able to
 * distinguish the two. The CI gate treats "skipped" as a warning and "failed" as an error.
 */

import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

let cached;

/** Locate an ffprobe binary, or null. */
export async function resolveFfprobe() {
  if (cached !== undefined) return cached;

  const candidates = [];
  if (process.env.FFPROBE_PATH) candidates.push(process.env.FFPROBE_PATH);
  try {
    candidates.push(require('ffprobe-static').path);
  } catch {
    /* not installed — fine */
  }
  candidates.push('ffprobe');

  for (const c of candidates) {
    try {
      if (c.includes('/') || c.includes('\\')) await access(c, constants.X_OK);
      await execFileAsync(c, ['-version'], { timeout: 10000 });
      cached = c;
      return cached;
    } catch {
      /* try the next candidate */
    }
  }
  cached = null;
  return null;
}

/**
 * Probe a file.
 *
 * @param {string} path
 * @returns {Promise<{available: boolean, reason?: string, raw?: object, summary?: object, errors: string[]}>}
 */
export async function probeFile(path) {
  const bin = await resolveFfprobe();
  if (!bin) {
    return {
      available: false,
      reason:
        'No ffprobe binary found. Set $FFPROBE_PATH, install the ffprobe-static package, ' +
        'or put ffprobe on $PATH. External-decoder validation was skipped, not passed.',
      errors: [],
    };
  }

  const errors = [];
  let raw;
  try {
    const { stdout } = await execFileAsync(
      bin,
      [
        '-v',
        'error',
        '-hide_banner',
        '-show_format',
        '-show_streams',
        '-show_error',
        '-of',
        'json',
        path,
      ],
      { timeout: 120000, maxBuffer: 32 * 1024 * 1024 },
    );
    raw = JSON.parse(stdout);
  } catch (e) {
    return {
      available: true,
      binary: bin,
      errors: [`ffprobe refused the file: ${(e.stderr || e.message || '').trim()}`],
    };
  }

  const stream = (raw.streams ?? []).find((s) => s.codec_type === 'audio');
  if (!stream) {
    errors.push('ffprobe found no audio stream in the file.');
    return { available: true, binary: bin, raw, errors };
  }

  const summary = {
    formatName: raw.format?.format_name ?? null,
    codec: stream.codec_name ?? null,
    channels: stream.channels ?? null,
    channelLayout: stream.channel_layout ?? null,
    sampleRate: stream.sample_rate ? Number(stream.sample_rate) : null,
    bitsPerSample: stream.bits_per_sample || stream.bits_per_raw_sample || null,
    sampleFormat: stream.sample_fmt ?? null,
    durationSeconds: stream.duration ? Number(stream.duration) : null,
    frames: stream.duration_ts ?? null,
    tags: raw.format?.tags ?? {},
  };

  if (raw.format?.format_name && !/wav/.test(raw.format.format_name)) {
    errors.push(`ffprobe identified the container as "${raw.format.format_name}", not WAV.`);
  }

  return { available: true, binary: bin, raw, summary, errors };
}

/**
 * Decode a file to raw 32-bit float PCM with ffmpeg, for round-trip comparison against
 * the PCM Signal Rot believes it wrote.
 *
 * ffmpeg is looked for next to ffprobe; `ffprobe-static` ships only ffprobe, so this
 * frequently reports unavailable while `probeFile` works. That is fine: `probeFile`
 * already proves an independent parser accepts the container, and the repository's own
 * independent decoder (`riff-inspect.js decodePcm`) covers the sample-accurate half.
 *
 * @param {string} path
 * @returns {Promise<{available: boolean, reason?: string, channels?: Float32Array[], sampleRate?: number}>}
 */
export async function decodeWithFfmpeg(path, expectedChannels, expectedSampleRate) {
  const probe = await resolveFfprobe();
  const bin =
    process.env.FFMPEG_PATH ?? (probe ? probe.replace(/ffprobe(\.exe)?$/, 'ffmpeg$1') : 'ffmpeg');
  try {
    await execFileAsync(bin, ['-version'], { timeout: 10000 });
  } catch {
    return {
      available: false,
      reason:
        'No ffmpeg binary found (ffprobe-static ships ffprobe only). Sample-accurate ' +
        'round-trip decoding fell back to the repository\u2019s independent RIFF decoder.',
    };
  }

  const { stdout } = await execFileAsync(
    bin,
    ['-v', 'error', '-i', path, '-f', 'f32le', '-acodec', 'pcm_f32le', '-'],
    { timeout: 300000, maxBuffer: 512 * 1024 * 1024, encoding: 'buffer' },
  );
  const interleaved = new Float32Array(
    stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength),
  );
  const ch = expectedChannels;
  const frames = Math.floor(interleaved.length / ch);
  const channels = [];
  for (let c = 0; c < ch; c++) {
    const out = new Float32Array(frames);
    for (let i = 0; i < frames; i++) out[i] = interleaved[i * ch + c];
    channels.push(out);
  }
  return { available: true, binary: bin, channels, sampleRate: expectedSampleRate, length: frames };
}
