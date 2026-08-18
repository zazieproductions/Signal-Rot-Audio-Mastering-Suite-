/**
 * Sonic Lab 20.4 — Anton Bruckner Privatuniversität, Linz.
 *
 * A 24-channel periphonic (full-sphere) loudspeaker system: 20 full-range loudspeakers on
 * four rings plus 4 subwoofers. This is a **real venue layout**, not a standard, and no
 * renderer knows it by name. Everything a third party needs to interpret a Signal Rot
 * Sonic Lab export is in this file and in `docs/SONIC-LAB-20.4.md`.
 *
 * ── Coordinate conventions ───────────────────────────────────────────────────────────
 * Two conventions are in play and confusing them is the single easiest way to deliver a
 * mirror-imaged master. They are kept in separate fields, never inferred from each other:
 *
 *   `azimuthAdm`  — ITU-R BS.2076 / BS.2051 convention: **positive is LEFT**, measured
 *                   counter-clockwise from front centre, range (−180, 180].
 *                   This is what is written into the ADM XML.
 *
 *   `azimuthHrtf` — Web Audio `PannerNode` convention: **positive is RIGHT**, because the
 *                   panner's +X axis points right. Always `-azimuthAdm`.
 *                   This is what drives the binaural monitor.
 *
 *   `elevation`   — degrees above the horizontal plane, positive up, both conventions.
 *
 * ── Rings ────────────────────────────────────────────────────────────────────────────
 *   Ear ring    (1–8)   elevation   0°  — the main listening plane
 *   Ground ring (9–12)  elevation  −8°  — floor-level wash
 *   High ring   (13–16) elevation +13°  — low height layer
 *   Roof ring   (17–20) elevation +33…35° — upper height layer
 *   Subwoofers  (21–24) elevation  −8°  — L / R / front / rear
 *
 * The asymmetric azimuths (−30 / +27, −67 / +61, …) are not typos. They are the surveyed
 * positions of the physical loudspeakers in the room, which is not perfectly symmetric.
 * Preserving them is the whole point of having a venue-specific layout.
 */

/**
 * @typedef {object} SpeakerDefinition
 * @property {string} id            channel identifier
 * @property {string} label         short display label
 * @property {string} description   human description of the position
 * @property {number} azimuthAdm    degrees, positive = LEFT (BS.2076)
 * @property {number} azimuthHrtf   degrees, positive = RIGHT (Web Audio)
 * @property {number} elevation     degrees, positive = UP
 * @property {string} admSpeakerLabel  label written into the ADM `<speakerLabel>`
 * @property {number} wavMaskBit    WAVEFORMATEXTENSIBLE bit, 0 when none applies
 * @property {boolean} [lfe]        true for subwoofer / LFE feeds
 * @property {string} ring
 */

const mk = (id, ring, azimuthAdm, elevation, description, extra = {}) => ({
  id,
  ring,
  label: id,
  description,
  azimuthAdm,
  // `|| 0` normalises negative zero, which JSON.stringify would silently turn into 0
  // and which would make a serialised channel map unequal to the object it came from.
  azimuthHrtf: -azimuthAdm || 0,
  elevation,
  // BS.2076 allows custom speaker labels. These are namespaced so nobody mistakes them
  // for ITU labels; `docs/SONIC-LAB-20.4.md` documents them and the exported channel map
  // ships alongside the audio.
  admSpeakerLabel: `SIGNALROT_SL_${id.replace('SL', '').padStart(2, '0')}`,
  wavMaskBit: 0,
  ...extra,
});

/** The 24 Sonic Lab channels, in delivery order (channel 1 → index 0). */
export const SONIC_LAB_SPEAKERS = Object.freeze([
  // ── Ear ring, elevation 0° ──
  mk('SL1', 'ear', 30, 0, 'Front left'),
  mk('SL2', 'ear', -27, 0, 'Front right'),
  mk('SL3', 'ear', 67, 0, 'Wide left'),
  mk('SL4', 'ear', -61, 0, 'Wide right'),
  mk('SL5', 'ear', 112.5, 0, 'Side-rear left'),
  mk('SL6', 'ear', -115, 0, 'Side-rear right'),
  mk('SL7', 'ear', 153, 0, 'Rear left'),
  mk('SL8', 'ear', -155, 0, 'Rear right'),
  // ── Ground ring, elevation −8° ──
  mk('SL9', 'ground', 43.5, -8, 'Ground front left'),
  mk('SL10', 'ground', -40, -8, 'Ground front right'),
  mk('SL11', 'ground', 134, -8, 'Ground rear left'),
  mk('SL12', 'ground', -136, -8, 'Ground rear right'),
  // ── High ring, elevation +13° ──
  mk('SL13', 'high', 43.5, 13, 'High front left'),
  mk('SL14', 'high', -40, 13, 'High front right'),
  mk('SL15', 'high', 134, 13, 'High rear left'),
  mk('SL16', 'high', -136, 13, 'High rear right'),
  // ── Roof ring, elevation +33…35° ──
  mk('SL17', 'roof', 44, 33, 'Roof front left'),
  mk('SL18', 'roof', -41.5, 35, 'Roof front right'),
  mk('SL19', 'roof', 131, 34, 'Roof rear left'),
  mk('SL20', 'roof', -130, 35, 'Roof rear right'),
  // ── Subwoofers, elevation −8° ──
  mk('SL21', 'sub', 90, -8, 'Subwoofer left', { lfe: true, admSpeakerLabel: 'SIGNALROT_SL_SUB_L' }),
  mk('SL22', 'sub', -90, -8, 'Subwoofer right', {
    lfe: true,
    admSpeakerLabel: 'SIGNALROT_SL_SUB_R',
  }),
  mk('SL23', 'sub', 0, -8, 'Subwoofer front', { lfe: true, admSpeakerLabel: 'SIGNALROT_SL_SUB_F' }),
  mk('SL24', 'sub', 180, -8, 'Subwoofer rear', {
    lfe: true,
    admSpeakerLabel: 'SIGNALROT_SL_SUB_B',
  }),
]);

/** Ring metadata for the speaker-map visualiser and the documentation. */
export const SONIC_LAB_RINGS = Object.freeze([
  { id: 'ear', label: 'Ear ring', elevation: 0, channels: [1, 2, 3, 4, 5, 6, 7, 8] },
  { id: 'ground', label: 'Ground ring', elevation: -8, channels: [9, 10, 11, 12] },
  { id: 'high', label: 'High ring', elevation: 13, channels: [13, 14, 15, 16] },
  { id: 'roof', label: 'Roof ring', elevation: 34, channels: [17, 18, 19, 20] },
  { id: 'sub', label: 'Subwoofers', elevation: -8, channels: [21, 22, 23, 24] },
]);

/**
 * Human-readable channel map, exportable alongside the audio so a venue technician can
 * patch the file without opening this repository.
 *
 * @param {object} [meta]
 * @param {string} [meta.sourceName]
 * @param {number} [meta.sampleRate]
 * @param {string} [meta.engineVersion]
 * @returns {string}
 */
export function sonicLabChannelMapText(meta = {}) {
  const lines = [];
  lines.push('SONIC LAB 20.4 — CHANNEL MAP');
  lines.push('Anton Bruckner Privatuniversität, Linz — 24-channel periphonic system');
  lines.push('');
  lines.push('Conventions:');
  lines.push('  Azimuth (ADM)  : degrees, POSITIVE = LEFT, 0 = front centre  [ITU-R BS.2076]');
  lines.push(
    '  Azimuth (HRTF) : degrees, POSITIVE = RIGHT                  [Web Audio PannerNode]',
  );
  lines.push('  Elevation      : degrees, POSITIVE = UP');
  lines.push('  Channel order  : WAV interleave order, 1-based');
  lines.push('');
  if (meta.sourceName) lines.push(`Source        : ${meta.sourceName}`);
  if (meta.sampleRate) lines.push(`Sample rate   : ${meta.sampleRate} Hz`);
  if (meta.engineVersion) lines.push(`Engine        : Signal Rot ${meta.engineVersion}`);
  lines.push('');
  lines.push('CH  ID     RING     AZ(ADM)  AZ(HRTF)   EL   TYPE   DESCRIPTION');
  lines.push('--  -----  -------  -------  --------  ----  -----  -----------------------');
  SONIC_LAB_SPEAKERS.forEach((s, i) => {
    lines.push(
      [
        String(i + 1).padStart(2),
        s.id.padEnd(5),
        s.ring.padEnd(7),
        s.azimuthAdm.toFixed(1).padStart(7),
        s.azimuthHrtf.toFixed(1).padStart(8),
        s.elevation.toFixed(0).padStart(4),
        (s.lfe ? 'SUB' : 'FULL').padEnd(5),
        s.description,
      ].join('  '),
    );
  });
  lines.push('');
  lines.push('Subwoofer feeds are low-passed at the LFE crossover frequency set in the');
  lines.push('Immersive tab (default 120 Hz, Linkwitz-Riley 4th order). They are NOT an');
  lines.push('LFE effects channel: they carry the low band of the programme, not a');
  lines.push('separate +10 dB effects feed.');
  return lines.join('\n');
}

/** Machine-readable channel map. */
export function sonicLabChannelMapJson(meta = {}) {
  return {
    layout: 'soniclab',
    name: 'Sonic Lab 20.4',
    venue: 'Anton Bruckner Privatuniversität, Linz',
    channelCount: SONIC_LAB_SPEAKERS.length,
    conventions: {
      azimuthAdm: 'degrees, positive = left, 0 = front centre (ITU-R BS.2076)',
      azimuthHrtf: 'degrees, positive = right (Web Audio PannerNode)',
      elevation: 'degrees, positive = up',
      channelOrder: 'WAV interleave order, 1-based',
    },
    ...meta,
    channels: SONIC_LAB_SPEAKERS.map((s, i) => ({
      channel: i + 1,
      id: s.id,
      ring: s.ring,
      azimuthAdm: s.azimuthAdm,
      azimuthHrtf: s.azimuthHrtf,
      elevation: s.elevation,
      lfe: !!s.lfe,
      admSpeakerLabel: s.admSpeakerLabel,
      description: s.description,
    })),
  };
}
