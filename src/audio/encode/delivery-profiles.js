/**
 * Professional delivery profiles.
 *
 * ── The one rule ─────────────────────────────────────────────────────────────────────
 * **A delivery profile never changes the mastering processing.** It selects a container,
 * a bit depth, a sample rate, a channel layout and a set of metadata/sidecar obligations
 * — nothing else. The audio that comes out of the mastering chain for a given set of
 * parameters is identical whichever profile you deliver it under; only the wrapper and
 * the paperwork differ.
 *
 * This is deliberate and it is the whole point. "Which deliverable am I making?" and
 * "how should this sound?" are different questions, and conflating them is how a
 * film-mix deliverable ends up quietly re-limited because someone picked a menu item.
 * If a profile ever needs to change gain, that belongs in the mastering parameters where
 * it is visible in the render report — not here.
 *
 * `sampleRate: null` means "keep the source rate". `bitDepth`, likewise, is a constraint
 * on the container, not a re-render instruction.
 *
 * ── Ceilings ─────────────────────────────────────────────────────────────────────────
 * Each profile documents a *recommended* true-peak ceiling. It is documentation: the
 * profile records what the delivery spec asks for so the manifest can state whether the
 * render met it. Enforcement lives in the limiter, which this layer does not touch.
 */

/**
 * @typedef {object} DeliveryProfile
 * @property {string} id
 * @property {string} name
 * @property {string} summary
 * @property {'wav'|'adm-bwf'} container
 * @property {16|24|32} bitDepth
 * @property {number[]} sampleRates      acceptable rates; the first is preferred
 * @property {number|null} preferredSampleRate  null = keep the source rate
 * @property {string} layout             layout id, or 'stereo'
 * @property {number|null} recommendedCeilingDbtp
 * @property {number|null} recommendedLoudnessLufs
 * @property {string[]} requiredSidecars filenames (templated) that MUST accompany the audio
 * @property {string[]} notes
 * @property {string[]} disclaimers      statements that must appear in the README verbatim
 */

const CEILING_NOTE =
  'The ceiling is documentation of the delivery spec, not an instruction to the limiter. ' +
  'The manifest reports the achieved true peak and whether it met this figure.';

const NO_DSP_NOTE =
  'Selecting this profile changes the container, bit depth, sample rate and sidecar set. ' +
  'It does not change any mastering processing.';

/** @type {Record<string, DeliveryProfile>} */
export const DELIVERY_PROFILES = Object.freeze({
  'stereo-distribution': {
    id: 'stereo-distribution',
    name: 'Stereo distribution',
    summary: '24-bit stereo WAV at 44.1 or 48 kHz for streaming and download aggregators.',
    container: 'wav',
    bitDepth: 24,
    sampleRates: [44100, 48000],
    preferredSampleRate: null,
    layout: 'stereo',
    recommendedCeilingDbtp: -1.0,
    recommendedLoudnessLufs: -14,
    requiredSidecars: ['{base}_render-report.json', '{base}_delivery-manifest.json'],
    notes: [
      'Deliver the highest-resolution master you have; aggregators transcode, and a 24-bit ' +
        'source gives their encoders headroom that a 16-bit one does not.',
      'Do not deliver a separately loudness-normalised copy per platform. Platforms ' +
        'normalise on playback; a pre-normalised file just loses dynamic range.',
      `−1.0 dBTP is the widely-quoted lossy-codec safety margin. ${CEILING_NOTE}`,
      NO_DSP_NOTE,
    ],
    disclaimers: [],
  },

  'film-video': {
    id: 'film-video',
    name: 'Film / video',
    summary: '24-bit, 48 kHz — the universal picture-post interchange rate.',
    container: 'wav',
    bitDepth: 24,
    sampleRates: [48000],
    preferredSampleRate: 48000,
    layout: 'stereo',
    recommendedCeilingDbtp: -2.0,
    recommendedLoudnessLufs: -23,
    requiredSidecars: ['{base}_render-report.json', '{base}_delivery-manifest.json'],
    notes: [
      '48 kHz is not a preference here — it is the rate every picture-editorial and ' +
        'conform workflow assumes. Delivering 44.1 kHz to a picture house causes a ' +
        'resample nobody asked for.',
      '−23 LUFS is EBU R 128 / ATSC A/85-adjacent broadcast practice. Confirm the actual ' +
        'target with the delivery spec you were given; it varies by territory and platform.',
      CEILING_NOTE,
      NO_DSP_NOTE,
    ],
    disclaimers: [],
  },

  'high-res-archive': {
    id: 'high-res-archive',
    name: 'High-resolution archive',
    summary: '32-bit float at the source rate (96 kHz where the source supports it).',
    container: 'wav',
    bitDepth: 32,
    sampleRates: [48000, 88200, 96000, 176400, 192000],
    preferredSampleRate: null,
    layout: 'stereo',
    recommendedCeilingDbtp: null,
    recommendedLoudnessLufs: null,
    requiredSidecars: [
      '{base}_render-report.json',
      '{base}_delivery-manifest.json',
      'SHA256SUMS.txt',
    ],
    notes: [
      '32-bit float is the archival choice because it cannot clip on write and needs no ' +
        'dither: the value stored is the value computed. An archive copy should be a ' +
        'faithful record of the render, not a distribution compromise.',
      'Never upsample for archive. Archive at the rate the material was rendered at; a ' +
        'resampled archive is a lossy archive that looks lossless.',
      'A checksum file is mandatory here — archival storage is exactly where silent bit ' +
        'rot happens, and a hash is the only way to notice.',
      NO_DSP_NOTE,
    ],
    disclaimers: [],
  },

  'bed-714': {
    id: 'bed-714',
    name: '7.1.4 bed',
    summary: '12-channel 24-bit WAVE_FORMAT_EXTENSIBLE with an explicit channel map.',
    container: 'wav',
    bitDepth: 24,
    sampleRates: [48000, 96000],
    preferredSampleRate: 48000,
    layout: '7.1.4',
    recommendedCeilingDbtp: -1.0,
    recommendedLoudnessLufs: null,
    requiredSidecars: [
      '{base}_channel-map.txt',
      '{base}_channel-map.json',
      '{base}_channel-identification.wav',
      '{base}_render-report.json',
      '{base}_delivery-manifest.json',
    ],
    notes: [
      'Channels are interleaved in ascending WAVEFORMATEXTENSIBLE mask-bit order, which ' +
        'is NOT the order the layout is usually written in. Read the channel map before ' +
        'routing anything.',
      'The channel-identification file is not optional courtesy — play it first and ' +
        'confirm each speaker counts up correctly before you trust the master.',
      NO_DSP_NOTE,
    ],
    disclaimers: [
      'Height channels contain SYNTHESISED ambience derived from the stereo side signal. ' +
        'Stereo carries no height information. This is a creative up-mix, not a recovered ' +
        'height layer.',
    ],
  },

  'sonic-lab-204': {
    id: 'sonic-lab-204',
    name: 'Sonic Lab 20.4',
    summary: '24-channel venue delivery, channel mask 0, routing documentation mandatory.',
    container: 'wav',
    bitDepth: 24,
    sampleRates: [48000, 96000],
    preferredSampleRate: 48000,
    layout: 'soniclab',
    recommendedCeilingDbtp: -1.0,
    recommendedLoudnessLufs: null,
    requiredSidecars: [
      '{base}_channel-map.txt',
      '{base}_channel-map.json',
      '{base}_channel-identification.wav',
      '{base}_render-report.json',
      '{base}_delivery-manifest.json',
      'README-delivery.txt',
      'SHA256SUMS.txt',
    ],
    notes: [
      'THE CHANNEL MASK IS 0. This is correct and deliberate. No WAVEFORMATEXTENSIBLE mask ' +
        'exists that can describe a surveyed 24-channel venue rig, and writing an ' +
        'approximate one would be worse than writing none: a player would confidently ' +
        'route the file to the wrong speakers. Mask 0 means "consult the channel map", ' +
        'and the channel map is in the package.',
      'Channels are in LAYOUT order (SL01…SL24), not mask order, because there is no mask ' +
        'order to sort into.',
      'Channels 21–24 are subwoofers, not a single LFE. They are separate feeds at ' +
        'surveyed positions and must not be summed.',
      'The azimuths are asymmetric (−30 / +27, −67 / +61, …). Those are not typos; they ' +
        'are the measured positions of physical loudspeakers in a room that is not ' +
        'symmetric. Do not "correct" them.',
      NO_DSP_NOTE,
    ],
    disclaimers: [
      'This layout is venue-specific to the Anton Bruckner Privatuniversität Sonic Lab. ' +
        'It is not a standard and no renderer knows it by name.',
      'Height and roof-ring content is SYNTHESISED from the stereo side signal.',
    ],
  },

  'adm-ingest': {
    id: 'adm-ingest',
    name: 'ADM ingest / interchange',
    summary: 'ADM BWF DirectSpeakers bed — an INGEST asset, not a certified Atmos master.',
    container: 'adm-bwf',
    bitDepth: 24,
    sampleRates: [48000, 96000],
    preferredSampleRate: 48000,
    layout: '7.1.4',
    recommendedCeilingDbtp: -1.0,
    recommendedLoudnessLufs: null,
    requiredSidecars: [
      '{base}_channel-map.txt',
      '{base}_channel-map.json',
      '{base}_adm.xml',
      '{base}_render-report.json',
      '{base}_delivery-manifest.json',
      'README-delivery.txt',
    ],
    notes: [
      'The ADM XML is written as a DirectSpeakers channel bed: fixed loudspeaker ' +
        'positions, one audioChannelFormat per track, no audio objects and no positional ' +
        'automation.',
      'The fmt chunk carries channel mask 0 by design. In an ADM file the routing is ' +
        'defined by chna and axml, and a competing mask would be a second source of truth.',
      'The XML is structurally validated on every CI run by an independent validator ' +
        '(namespaces, ID grammar, cross-references, DirectSpeakers semantics, coordinate ' +
        'consistency). It is NOT schema-validated against the normative BS.2076 XSD, ' +
        'which the ITU does not license for redistribution.',
      NO_DSP_NOTE,
    ],
    disclaimers: [
      'THIS IS NOT A DOLBY ATMOS MASTER AND IS NOT DOLBY ATMOS CERTIFIED. A Dolby Atmos ' +
        'deliverable (.atmos / DAMF / IMF IAB) is produced by licensed Dolby tooling from ' +
        'a session containing object metadata. This file is a channel bed that such ' +
        'tooling can ingest. It is an interchange asset.',
      'Height channels contain SYNTHESISED ambience derived from the stereo side signal.',
      'ADM has no vocabulary for disclosing up-mixed content, so the XML itself cannot ' +
        'state the above. This README and the delivery manifest are where it is stated.',
    ],
  },
});

/** Ordered list for UI menus. */
export const DELIVERY_PROFILE_IDS = Object.freeze(Object.keys(DELIVERY_PROFILES));

/** @param {string} id */
export const getDeliveryProfile = (id) => DELIVERY_PROFILES[id] ?? null;

/**
 * Resolve a profile against a concrete render, reporting any conflicts rather than
 * silently overriding them.
 *
 * @param {string} profileId
 * @param {object} render `{sampleRate, bitDepth, channelCount, layout, truePeakDbtp, integratedLufs}`
 * @returns {{profile: DeliveryProfile, conforms: boolean, deviations: string[], advisories: string[]}}
 */
export function checkProfileConformance(profileId, render) {
  const profile = DELIVERY_PROFILES[profileId];
  if (!profile) throw new Error(`checkProfileConformance: unknown profile "${profileId}"`);
  const deviations = [];
  const advisories = [];

  if (render.sampleRate !== undefined && !profile.sampleRates.includes(render.sampleRate)) {
    deviations.push(
      `Sample rate ${render.sampleRate} Hz is not accepted by "${profile.name}" ` +
        `(accepts ${profile.sampleRates.join(', ')} Hz).`,
    );
  }
  if (render.bitDepth !== undefined && render.bitDepth !== profile.bitDepth) {
    deviations.push(
      `Bit depth ${render.bitDepth} does not match the profile's ${profile.bitDepth}-bit ` +
        'requirement.',
    );
  }
  if (render.layout !== undefined && render.layout !== profile.layout) {
    deviations.push(`Layout "${render.layout}" does not match the profile's "${profile.layout}".`);
  }
  if (
    profile.recommendedCeilingDbtp !== null &&
    Number.isFinite(render.truePeakDbtp) &&
    render.truePeakDbtp > profile.recommendedCeilingDbtp + 0.05
  ) {
    advisories.push(
      `True peak ${render.truePeakDbtp.toFixed(2)} dBTP exceeds the profile's recommended ` +
        `${profile.recommendedCeilingDbtp.toFixed(1)} dBTP ceiling. This is an advisory: the ` +
        'file is valid, but the delivery spec asks for more headroom.',
    );
  }
  if (
    profile.recommendedLoudnessLufs !== null &&
    Number.isFinite(render.integratedLufs) &&
    Math.abs(render.integratedLufs - profile.recommendedLoudnessLufs) > 1.0
  ) {
    advisories.push(
      `Integrated loudness ${render.integratedLufs.toFixed(1)} LUFS is more than 1 LU from ` +
        `the profile's reference ${profile.recommendedLoudnessLufs} LUFS. Advisory only.`,
    );
  }

  return { profile, conforms: deviations.length === 0, deviations, advisories };
}

/** Expand a profile's sidecar templates against a base filename. */
export function sidecarsFor(profileId, base) {
  const profile = DELIVERY_PROFILES[profileId];
  if (!profile) return [];
  return profile.requiredSidecars.map((s) => s.replace('{base}', base));
}
