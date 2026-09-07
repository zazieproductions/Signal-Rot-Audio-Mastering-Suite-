/**
 * Machine-readable delivery manifest.
 *
 * ── Purpose ──────────────────────────────────────────────────────────────────────────
 * A receiving engineer opens a folder of WAV files and has to answer, without asking
 * anyone: what is each file, what layout is it, what order are the channels in, what does
 * the mask mean, was anything up-mixed, how loud is it, and did it arrive intact. The
 * manifest answers all of that in one JSON document that a script can also read.
 *
 * ── Honesty obligations ──────────────────────────────────────────────────────────────
 * The manifest is where every claim about the export gets qualified. Three fields exist
 * purely so a downstream party cannot be misled:
 *
 *   `upmix`               states, per layout, that height/surround content was synthesised
 *                         from stereo and is therefore creative, not recovered.
 *   `validation`          states exactly which validation was performed and, critically,
 *                         which was NOT — `schemaValidated: false`, `atmosCertified: false`.
 *   `limitations`         the software's known limits, copied into the delivery so they
 *                         travel with the file rather than living in a repository the
 *                         recipient will never read.
 *
 * A manifest that overstates what was verified is worse than no manifest. Every boolean
 * here is set from what the tooling actually established.
 */

import { ENGINE_NAME, ENGINE_VERSION } from '../../app/constants.js';
import { LAYOUTS, SPEAKERS, wavChannelOrder, lfeChannelIndices } from '../immersive/layouts.js';
import { DELIVERY_PROFILES } from './delivery-profiles.js';

/** Schema version of the manifest document itself. */
export const MANIFEST_SCHEMA_VERSION = 1;

const num = (v) => (Number.isFinite(v) ? Number(v.toFixed(3)) : null);

/**
 * Per-layout up-mix disclosure.
 *
 * Signal Rot's immersive layouts are derived from stereo. There is no height information
 * in a stereo file; the height channels carry ambience synthesised from the side signal.
 * That is a legitimate creative choice and an illegitimate thing to leave unstated.
 *
 * @param {string} layoutId
 */
export function upmixDisclosure(layoutId) {
  const layout = LAYOUTS[layoutId];
  if (!layoutId || layoutId === 'stereo' || !layout) {
    return {
      upmixed: false,
      syntheticHeight: false,
      statement: 'Stereo delivery. No up-mix was performed.',
    };
  }
  const { order } = wavChannelOrder(layoutId);
  const heights = order.filter((k) => (SPEAKERS[k]?.elevation ?? 0) > 0);
  const surrounds = order.filter(
    (k) => Math.abs(SPEAKERS[k]?.azimuthAdm ?? 0) > 80 && (SPEAKERS[k]?.elevation ?? 0) <= 0,
  );
  // Assembled as sentences so the empty cases simply drop out, rather than leaving a
  // dangling clause about channels the layout does not have.
  const sentences = [`This ${layout.name} deliverable was up-mixed from a two-channel source.`];
  if (heights.length) {
    sentences.push(
      `The ${heights.length} height channel(s) (${heights.join(', ')}) contain ambience ` +
        'SYNTHESISED from the stereo side signal. Stereo contains no height information; ' +
        'this is a creative up-mix, not a recovered height layer.',
    );
  }
  if (surrounds.length) {
    sentences.push(
      `The ${surrounds.length} surround channel(s) (${surrounds.join(', ')}) are derived ` +
        'from the stereo difference signal.',
    );
  }
  sentences.push(
    'Nothing in the WAV or ADM metadata can express this — ADM has no up-mix vocabulary ' +
      '— so this manifest is the disclosure.',
  );

  return {
    upmixed: true,
    syntheticHeight: heights.length > 0,
    heightChannels: heights,
    surroundChannels: surrounds,
    statement: sentences.join(' '),
  };
}

/**
 * Build the channel-order block: the authoritative statement of what track N is.
 * @param {string} layoutId
 */
export function channelOrderBlock(layoutId) {
  if (!layoutId || layoutId === 'stereo') {
    return {
      layout: 'stereo',
      name: 'Stereo',
      channelCount: 2,
      channelMask: 0x3,
      channelMaskHex: '0x3',
      standardMask: true,
      interleaveOrder: 'WAVEFORMATEXTENSIBLE ascending mask-bit order',
      lfeChannels: [],
      // Same field set as the immersive block below, so every consumer — the README
      // renderer included — can treat the two identically instead of branching.
      channels: [
        {
          channel: 1,
          id: 'L',
          label: 'Front left',
          azimuthAdm: 30,
          azimuthHrtf: -30,
          elevation: 0,
          ring: 'ear',
          lfe: false,
          admSpeakerLabel: 'M+030',
          wavMaskBit: 0x1,
          wavMaskBitHex: '0x1',
        },
        {
          channel: 2,
          id: 'R',
          label: 'Front right',
          azimuthAdm: -30,
          azimuthHrtf: 30,
          elevation: 0,
          ring: 'ear',
          lfe: false,
          admSpeakerLabel: 'M-030',
          wavMaskBit: 0x2,
          wavMaskBitHex: '0x2',
        },
      ],
      routingNote: 'Standard stereo. No routing documentation needed.',
      conventions: {
        azimuthAdm: 'degrees, positive = left (ITU-R BS.2076)',
        azimuthHrtf: 'degrees, positive = right (Web Audio PannerNode)',
        elevation: 'degrees, positive = up',
      },
    };
  }
  const layout = LAYOUTS[layoutId];
  if (!layout) throw new Error(`channelOrderBlock: unknown layout "${layoutId}"`);
  const { order, mask, standard } = wavChannelOrder(layoutId);

  return {
    layout: layout.id,
    name: layout.name,
    description: layout.description,
    channelCount: order.length,
    channelMask: standard ? mask : 0,
    channelMaskHex: standard ? `0x${mask.toString(16).toUpperCase()}` : '0x0',
    standardMask: standard,
    interleaveOrder: standard
      ? 'WAVEFORMATEXTENSIBLE ascending mask-bit order (NOT layout order)'
      : 'Layout order — no standard mask describes this layout',
    lfeChannels: lfeChannelIndices(layoutId, order).map((i) => i + 1),
    channels: order.map((k, i) => {
      const s = SPEAKERS[k];
      return {
        channel: i + 1,
        id: s.id,
        label: s.description,
        azimuthAdm: s.azimuthAdm,
        azimuthHrtf: s.azimuthHrtf,
        elevation: s.elevation,
        ring: s.ring,
        lfe: !!s.lfe,
        admSpeakerLabel: s.admSpeakerLabel,
        wavMaskBit: s.wavMaskBit,
        wavMaskBitHex: `0x${(s.wavMaskBit >>> 0).toString(16).toUpperCase()}`,
      };
    }),
    routingNote: standard
      ? 'The channel mask fully describes this layout. Conforming players route it ' +
        'correctly without the channel map. The map is still supplied for verification.'
      : 'CHANNEL MASK IS 0 BY DESIGN. No WAVEFORMATEXTENSIBLE mask can describe this ' +
        'layout, and writing an approximate one would make a player route the file ' +
        'confidently to the wrong speakers. Route strictly from the channel map. ' +
        'Verify with the channel-identification file before committing to a mix.',
    conventions: {
      azimuthAdm: 'degrees, positive = LEFT (ITU-R BS.2076)',
      azimuthHrtf: 'degrees, positive = RIGHT (Web Audio PannerNode)',
      elevation: 'degrees, positive = UP',
    },
  };
}

/**
 * @typedef {object} ManifestInput
 * @property {string} [sourceFilename]
 * @property {string} [layoutId]           omit or 'stereo' for stereo
 * @property {string} [profileId]
 * @property {number} sampleRate
 * @property {16|24|32} bitDepth
 * @property {number} channelCount
 * @property {number} frames
 * @property {string} [container]          'RIFF' | 'RF64' | 'BW64'
 * @property {'none'|'DirectSpeakers'} [admType]
 * @property {Date|string} [renderedAt]
 * @property {object} [loudness]           `{integratedLufs, truePeakDbtp, loudnessRangeLu, ...}`
 * @property {Array<{filename: string, role: string, bytes?: number, sha256?: string, description?: string}>} [files]
 * @property {object} [validation]         results from the export-validation tooling
 * @property {object} [renderReport]
 */

/**
 * Build the delivery manifest.
 * @param {ManifestInput} input
 * @returns {object} JSON-serialisable
 */
export function buildDeliveryManifest(input) {
  const layoutId = input.layoutId && input.layoutId !== 'stereo' ? input.layoutId : null;
  const order = channelOrderBlock(layoutId ?? 'stereo');
  const profile = input.profileId ? DELIVERY_PROFILES[input.profileId] : null;
  if (input.profileId && !profile) {
    throw new Error(`buildDeliveryManifest: unknown delivery profile "${input.profileId}"`);
  }

  const renderedAt =
    input.renderedAt instanceof Date
      ? input.renderedAt.toISOString()
      : (input.renderedAt ?? new Date().toISOString());

  const L = input.loudness ?? {};
  const v = input.validation ?? {};

  if (input.channelCount !== undefined && input.channelCount !== order.channelCount) {
    throw new Error(
      `buildDeliveryManifest: ${input.channelCount} channels supplied but layout ` +
        `"${layoutId ?? 'stereo'}" has ${order.channelCount}. Refusing to write a manifest ` +
        'that contradicts the audio.',
    );
  }

  return {
    manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
    generator: {
      engine: ENGINE_NAME,
      engineVersion: ENGINE_VERSION,
      renderedAt,
    },
    source: {
      filename: input.sourceFilename ?? null,
      note: 'The name of the file that was loaded into the mastering chain.',
    },
    deliveryProfile: profile
      ? {
          id: profile.id,
          name: profile.name,
          summary: profile.summary,
          recommendedCeilingDbtp: profile.recommendedCeilingDbtp,
          recommendedLoudnessLufs: profile.recommendedLoudnessLufs,
          notes: profile.notes,
          disclaimers: profile.disclaimers,
          note:
            'A delivery profile selects container, bit depth, sample rate, layout and ' +
            'sidecar obligations. It does not alter mastering processing.',
        }
      : null,
    audio: {
      sampleRate: input.sampleRate,
      bitDepth: input.bitDepth,
      sampleFormat: input.bitDepth === 32 ? 'IEEE 754 32-bit float' : `${input.bitDepth}-bit PCM`,
      channelCount: order.channelCount,
      frames: input.frames ?? null,
      durationSeconds:
        input.frames && input.sampleRate ? num(input.frames / input.sampleRate) : null,
      container: input.container ?? 'RIFF',
      containerNote:
        input.container === 'RF64' || input.container === 'BW64'
          ? `${input.container}: 32-bit size fields carry the 0xFFFFFFFF sentinel and the ` +
            'real 64-bit sizes are in the ds64 chunk. Readers that predate EBU Tech 3306 ' +
            'will not open this file.'
          : 'Ordinary RIFF/WAVE. Every size field is a real 32-bit value.',
      formatTag:
        order.channelCount > 2 || layoutId
          ? 'WAVE_FORMAT_EXTENSIBLE (0xFFFE)'
          : input.bitDepth === 32
            ? 'WAVE_FORMAT_IEEE_FLOAT (0x0003)'
            : 'WAVE_FORMAT_PCM (0x0001)',
    },
    channelOrder: order,
    adm: {
      type: input.admType ?? 'none',
      present: (input.admType ?? 'none') !== 'none',
      note:
        (input.admType ?? 'none') === 'DirectSpeakers'
          ? 'ITU-R BS.2076 DirectSpeakers channel bed in an EBU Tech 3285 / BS.2088 ' +
            'Broadcast Wave file. Fixed loudspeaker positions; no audio objects, no ' +
            'positional automation.'
          : 'No ADM metadata in this deliverable.',
    },
    loudness: {
      integratedLufs: num(L.integratedLufs ?? L.integrated),
      loudnessRangeLu: num(L.loudnessRangeLu ?? L.range),
      truePeakDbtp: num(L.truePeakDbtp ?? L.truePeak),
      maxMomentaryLufs: num(L.maxMomentaryLufs ?? L.maxMomentary),
      maxShortTermLufs: num(L.maxShortTermLufs ?? L.maxShortTerm),
      ceilingRespected: L.ceilingRespected ?? null,
      measurement: {
        standard: 'ITU-R BS.1770-4 K-weighted, gated',
        truePeakMethod:
          'Windowed-sinc polyphase interpolator (12 taps/phase, Kaiser β = 8.6), not the ' +
          'BS.1770-4 Annex 2 48-tap FIR. Worst-case error −0.168 dB on a 0 dBTP sine at ' +
          'fs/4 sampled at ±45°.',
        certified: false,
        certificationNote:
          'The loudness meter has not been validated against EBU Tech 3341 compliance ' +
          'material. No compliance claim is made.',
        heightWeighting:
          layoutId && order.channels.some((c) => c.elevation > 0)
            ? 'BS.1770-4 defines no weighting for height channels. G = 1.0 is assumed. ' +
              'This affects the figures above for immersive deliverables.'
            : null,
      },
    },
    upmix: upmixDisclosure(layoutId ?? 'stereo'),
    validation: {
      riffStructure: v.riffStructure ?? null,
      channelOrderVerified: v.channelOrderVerified ?? null,
      roundTripVerified: v.roundTripVerified ?? null,
      admWellFormed: v.admWellFormed ?? null,
      admStructurallyValidated: v.admStructurallyValidated ?? null,
      admSchemaValidated: v.admSchemaValidated ?? false,
      externalParser: v.externalParser ?? null,
      terminology: {
        'well-formed': 'The XML parses.',
        'structurally validated':
          'Element nesting, required attributes, BS.2076 ID grammar, cross-reference ' +
          'resolution, DirectSpeakers semantics and coordinate consistency were checked ' +
          'by a validator that shares no code with the writer.',
        'schema validated':
          'Validated against the normative ITU-R BS.2076 XSD. NOT performed — the ITU ' +
          'does not license the schema for redistribution, so CI cannot obtain one.',
        'interoperability tested':
          'The file was parsed and decoded by at least one independent third-party tool.',
      },
      atmosCertified: false,
      atmosNote:
        'NOT DOLBY ATMOS CERTIFIED. A Dolby Atmos deliverable is produced by licensed ' +
        'Dolby tooling from a session containing object metadata. Any ADM file here is a ' +
        'DirectSpeakers channel bed suitable as an ingest asset.',
    },
    files: (input.files ?? []).map((f) => ({
      filename: f.filename,
      role: f.role,
      description: f.description ?? null,
      bytes: f.bytes ?? null,
      sha256: f.sha256 ?? null,
    })),
    integrity: {
      algorithm: 'SHA-256',
      verify: 'sha256sum -c SHA256SUMS.txt',
      note:
        'These are FILE-INTEGRITY checks, not audio fingerprints. They prove the bytes ' +
        'arrived unaltered. Two files with identical audio and different metadata ' +
        'timestamps will have different hashes; that is expected and not a fault.',
    },
    limitations: [
      'Rendering is performed by the browser\u2019s Web Audio implementation. Results are ' +
        'reproducible on a given browser build but are not guaranteed bit-identical ' +
        'across browsers or versions.',
      'The loudness meter is not EBU Tech 3341 certified.',
      'The true-peak meter is not the BS.1770-4 Annex 2 filter (see measurement.truePeakMethod).',
      'Immersive layouts are up-mixed from stereo; height content is synthesised.',
      'ADM output is a DirectSpeakers bed, structurally validated but not schema validated ' +
        'and not Atmos certified.',
      'The in-memory export path materialises the whole file in one ArrayBuffer, which ' +
        'browsers cap at roughly 2 GiB; the direct stereo/immersive export instead streams ' +
        'straight to disk via the File System Access API (Chromium-based browsers), where ' +
        'only RF64/BW64 container limits apply. Firefox and Safari lack that API and keep ' +
        'the ≈2 GiB ceiling for direct downloads.',
    ],
    readMore: 'docs/EXPORT-INTEROPERABILITY.md and docs/LIMITATIONS.md',
  };
}

/**
 * Human-readable `README-delivery.txt` for the package.
 * @param {object} manifest a document from {@link buildDeliveryManifest}
 */
export function buildDeliveryReadme(manifest) {
  const rule = '='.repeat(78);
  const thin = '-'.repeat(78);
  const out = [];
  const co = manifest.channelOrder;

  out.push(rule);
  out.push(`DELIVERY PACKAGE — ${co.name.toUpperCase()}`);
  out.push(rule);
  out.push('');
  out.push(`Rendered by  : ${manifest.generator.engine} ${manifest.generator.engineVersion}`);
  out.push(`Rendered at  : ${manifest.generator.renderedAt}`);
  out.push(`Source file  : ${manifest.source.filename ?? '(not recorded)'}`);
  if (manifest.deliveryProfile) {
    out.push(`Profile      : ${manifest.deliveryProfile.name}`);
  }
  out.push(
    `Audio        : ${co.channelCount} ch · ${manifest.audio.sampleRate} Hz · ` +
      `${manifest.audio.sampleFormat} · ${manifest.audio.container}`,
  );
  if (manifest.audio.durationSeconds) {
    out.push(`Duration     : ${manifest.audio.durationSeconds} s`);
  }
  out.push('');

  if (manifest.files.length) {
    out.push(thin);
    out.push('WHAT EACH FILE IS');
    out.push(thin);
    const width = Math.max(...manifest.files.map((f) => f.filename.length));
    for (const f of manifest.files) {
      out.push(`${f.filename.padEnd(width)}  ${f.description ?? f.role}`);
    }
    out.push('');
  }

  out.push(thin);
  out.push('CHANNEL ROUTING');
  out.push(thin);
  out.push('');
  out.push(`Channel mask : ${co.channelMaskHex}${co.standardMask ? '' : '   ← ZERO, BY DESIGN'}`);
  out.push(`Interleave   : ${co.interleaveOrder}`);
  out.push('');
  for (const line of wrap(co.routingNote, 78)) out.push(line);
  out.push('');
  out.push('CH  ID     AZ(ADM)  EL     ROLE');
  out.push('--  -----  -------  -----  ------------------------------------------');
  for (const c of co.channels) {
    out.push(
      [
        String(c.channel).padStart(2),
        (c.id ?? '').padEnd(5),
        (c.azimuthAdm ?? 0).toFixed(1).padStart(7),
        (c.elevation ?? 0).toFixed(0).padStart(5),
        `${c.label}${c.lfe ? '  [LFE / SUB — do not sum with others]' : ''}`,
      ].join('  '),
    );
  }
  out.push('');
  out.push(`Azimuth convention: ${co.conventions.azimuthAdm}`);
  out.push(`Elevation convention: ${co.conventions.elevation}`);
  if (co.lfeChannels.length) {
    out.push(`LFE / subwoofer channels: ${co.lfeChannels.join(', ')}`);
  }
  out.push('');

  out.push(thin);
  out.push('VERIFY BEFORE YOU MIX');
  out.push(thin);
  out.push('');
  out.push('1. Play the *_channel-identification.wav file through the target rig.');
  out.push('   Channel N emits N short beeps, then a tone, with all others silent.');
  out.push('   If the count does not match the speaker, your routing is wrong — not the');
  out.push('   file. Fix it before listening to the master.');
  out.push('2. Confirm the channel count and sample rate independently:');
  out.push(
    '      ffprobe -v error -show_entries stream=channels,sample_rate,bits_per_raw_sample \\',
  );
  out.push('              -of default=noprint_wrappers=1 <file>.wav');
  out.push('3. Confirm the files arrived intact:');
  out.push('      sha256sum -c SHA256SUMS.txt');
  out.push('');

  out.push(thin);
  out.push('DISCLOSURES — READ THESE');
  out.push(thin);
  out.push('');
  for (const line of wrap(manifest.upmix.statement, 78)) out.push(line);
  out.push('');
  for (const d of manifest.deliveryProfile?.disclaimers ?? []) {
    for (const line of wrap(d, 78)) out.push(line);
    out.push('');
  }
  out.push(`ADM schema validated : ${manifest.validation.admSchemaValidated ? 'yes' : 'NO'}`);
  out.push(`Dolby Atmos certified: NO`);
  for (const line of wrap(manifest.validation.atmosNote, 78)) out.push(line);
  out.push('');

  out.push(thin);
  out.push('KNOWN LIMITATIONS');
  out.push(thin);
  out.push('');
  for (const l of manifest.limitations) {
    for (const [i, line] of wrap(l, 76).entries()) out.push((i === 0 ? '· ' : '  ') + line);
  }
  out.push('');
  out.push(`Full detail: ${manifest.readMore}`);
  out.push('');
  out.push(rule);
  return out.join('\n');
}

/** Greedy word wrap. */
function wrap(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) {
      lines.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}
