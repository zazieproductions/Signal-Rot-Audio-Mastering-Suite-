/**
 * Delivery package builder.
 *
 * ── Why a folder and not a ZIP ───────────────────────────────────────────────────────
 * This produces a **list of files**, not an archive. Building a ZIP in the browser means
 * either a dependency or a hand-rolled deflate, and either way the result is one opaque
 * blob that the recipient has to trust and unpack before they can see anything. A set of
 * plainly named files, each downloaded individually, is more robust across browsers, is
 * inspectable the moment it lands, and degrades gracefully if one download fails.
 *
 * The caller decides how to emit them: `downloadDeliveryPackage` walks the list with the
 * existing download helper (with a pause between files, because browsers rate-limit
 * consecutive programmatic downloads), and the CLI fixture generator writes the same list
 * to disk. Both produce byte-identical packages.
 *
 * ── Package shape ────────────────────────────────────────────────────────────────────
 *   <base>_master.wav                    the deliverable
 *   <base>_master.adm.wav                ADM BWF, when the profile asks for one
 *   <base>_adm.xml                       the ADM XML, extracted for inspection
 *   <base>_channel-identification.wav    counted beeps + ID tone per channel
 *   <base>_channel-map.txt               human-readable routing
 *   <base>_channel-map.json              machine-readable routing
 *   <base>_render-report.json            what the mastering chain did
 *   <base>_delivery-manifest.json        the auditable record
 *   README-delivery.txt                  how to read all of the above
 *   SHA256SUMS.txt                       integrity, verifiable with coreutils
 */

import { channelMapJson, channelMapText, wavChannelOrder } from '../immersive/layouts.js';
import { buildChannelIdentification } from './channel-identification.js';
import { formatChecksumFile, sha256 } from './checksum.js';
import { buildDeliveryManifest, buildDeliveryReadme } from './delivery-manifest.js';
import { DELIVERY_PROFILES } from './delivery-profiles.js';
import { downloadBlob, downloadText, sanitizeFilename } from './download.js';
import { writeWav } from './wav.js';

/**
 * @typedef {object} PackageFile
 * @property {string} filename
 * @property {string} role
 * @property {string} description
 * @property {Blob} blob
 * @property {string} [sha256]
 * @property {number} [bytes]
 */

const DESCRIPTIONS = {
  master: 'THE MASTER. This is the deliverable.',
  'adm-master':
    'ADM BWF (BS.2076 DirectSpeakers bed). Ingest/interchange asset — not a ' +
    'certified Atmos master.',
  'adm-xml': 'The ADM XML extracted from the axml chunk, for inspection and validation.',
  identification:
    'Channel-identification test signal. Channel N = N beeps + one tone. ' +
    'Play this FIRST to verify routing.',
  'channel-map-text': 'Human-readable channel map. Which physical speaker each track feeds.',
  'channel-map-json': 'The same channel map, machine-readable.',
  'render-report': 'What the mastering chain did: parameters, achieved loudness, true peak.',
  manifest:
    'Auditable delivery record: layout, channel order, loudness, disclosures, ' +
    'validation status, checksums.',
  readme: 'START HERE. Plain-language explanation of every file in this package.',
  checksums: 'SHA-256 of every file. Verify with: sha256sum -c SHA256SUMS.txt',
};

/**
 * Assemble a delivery package.
 *
 * The audio is passed in already rendered and already in delivery order — this module
 * does not render, resample, or reorder anything. Its only audio-generating act is the
 * channel-identification signal, which is a separate file and never touches the master.
 *
 * @param {object} input
 * @param {import('../dsp/audio-data.js').AudioData} input.master  channels in delivery order
 * @param {string} input.profileId
 * @param {string} [input.baseName]        default `'master'`
 * @param {string} [input.sourceFilename]
 * @param {string} [input.layoutId]
 * @param {Blob} [input.admBlob]           a pre-written ADM BWF, when the profile wants one
 * @param {string} [input.admXml]
 * @param {object} [input.loudness]
 * @param {object} [input.renderReport]
 * @param {object} [input.validation]
 * @param {boolean} [input.includeIdentification] default: whatever the profile requires
 * @param {boolean} [input.includeChecksums]      default: true
 * @param {Date} [input.renderedAt]
 * @returns {Promise<{folderName: string, files: PackageFile[], manifest: object}>}
 */
export async function buildDeliveryPackage(input) {
  const profile = DELIVERY_PROFILES[input.profileId];
  if (!profile) {
    throw new Error(`buildDeliveryPackage: unknown delivery profile "${input.profileId}"`);
  }
  const master = input.master;
  if (!master || !Array.isArray(master.channels) || master.channels.length === 0) {
    throw new Error('buildDeliveryPackage: no master audio supplied');
  }

  const layoutId = input.layoutId ?? (profile.layout === 'stereo' ? null : profile.layout);
  const base = sanitizeFilename(input.baseName ?? 'master', { fallback: 'master' }).replace(
    /\.[^.]+$/,
    '',
  );
  const ch = master.channels.length;

  if (layoutId) {
    const expected = wavChannelOrder(layoutId).order.length;
    if (ch !== expected) {
      throw new Error(
        `buildDeliveryPackage: master has ${ch} channels but layout "${layoutId}" needs ` +
          `${expected}. Refusing to build a package whose documentation contradicts its audio.`,
      );
    }
  }

  /** @type {PackageFile[]} */
  const files = [];
  const add = (filename, role, blob) =>
    files.push({ filename, role, description: DESCRIPTIONS[role] ?? role, blob });

  // ── The master ──
  const mask = layoutId ? wavChannelOrder(layoutId).mask : undefined;
  const masterBlob = writeWav(master, {
    bitDepth: profile.bitDepth,
    ...(layoutId ? { channelMask: mask, forceExtensible: true } : {}),
  });
  add(`${base}_master.wav`, 'master', masterBlob);

  // ── ADM BWF, when supplied ──
  if (input.admBlob) add(`${base}_master.adm.wav`, 'adm-master', input.admBlob);
  if (input.admXml) {
    add(
      `${base}_adm.xml`,
      'adm-xml',
      new Blob([input.admXml], { type: 'application/xml;charset=utf-8' }),
    );
  }

  // ── Channel identification ──
  const wantsId =
    input.includeIdentification ??
    profile.requiredSidecars.some((s) => s.includes('channel-identification'));
  if (wantsId) {
    const id = buildChannelIdentification(ch, { sampleRate: master.sampleRate });
    add(
      `${base}_channel-identification.wav`,
      'identification',
      writeWav(id, {
        bitDepth: profile.bitDepth === 32 ? 24 : profile.bitDepth,
        ...(layoutId ? { channelMask: mask, forceExtensible: true } : {}),
      }),
    );
  }

  // ── Channel maps ──
  if (layoutId) {
    const meta = {
      sourceName: input.sourceFilename,
      sampleRate: master.sampleRate,
      engineVersion: input.renderReport?.engine?.version,
    };
    add(
      `${base}_channel-map.txt`,
      'channel-map-text',
      new Blob([channelMapText(layoutId, meta)], { type: 'text/plain;charset=utf-8' }),
    );
    add(
      `${base}_channel-map.json`,
      'channel-map-json',
      new Blob([JSON.stringify(channelMapJson(layoutId, meta), null, 2)], {
        type: 'application/json',
      }),
    );
  }

  // ── Render report ──
  if (input.renderReport) {
    add(
      `${base}_render-report.json`,
      'render-report',
      new Blob([JSON.stringify(input.renderReport, null, 2)], { type: 'application/json' }),
    );
  }

  // ── Manifest (needs the sizes and hashes of everything above) ──
  const wantsChecksums = input.includeChecksums ?? true;
  for (const f of files) {
    f.bytes = f.blob.size;
    if (wantsChecksums) f.sha256 = await sha256(f.blob);
  }

  const manifest = buildDeliveryManifest({
    sourceFilename: input.sourceFilename,
    layoutId: layoutId ?? 'stereo',
    profileId: profile.id,
    sampleRate: master.sampleRate,
    bitDepth: profile.bitDepth,
    channelCount: ch,
    frames: master.length,
    container: masterBlob.riffContainer ?? 'RIFF',
    admType: input.admBlob || input.admXml ? 'DirectSpeakers' : 'none',
    renderedAt: input.renderedAt,
    loudness: input.loudness,
    validation: input.validation,
    files: files.map((f) => ({
      filename: f.filename,
      role: f.role,
      description: f.description,
      bytes: f.bytes,
      sha256: f.sha256,
    })),
  });

  const manifestName = `${base}_delivery-manifest.json`;
  const readmeName = 'README-delivery.txt';
  const sumsName = 'SHA256SUMS.txt';

  // The manifest lists itself, the README and the checksum file by name so the recipient
  // can tell at a glance whether the package is complete, but their hashes are omitted:
  // a document cannot contain its own hash, and a checksum file listing itself is a
  // circular claim. `SHA256SUMS.txt` covers the files whose integrity actually matters.
  manifest.files.push(
    {
      filename: manifestName,
      role: 'manifest',
      description: DESCRIPTIONS.manifest,
      bytes: null,
      sha256: null,
    },
    {
      filename: readmeName,
      role: 'readme',
      description: DESCRIPTIONS.readme,
      bytes: null,
      sha256: null,
    },
  );
  if (wantsChecksums) {
    manifest.files.push({
      filename: sumsName,
      role: 'checksums',
      description: DESCRIPTIONS.checksums,
      bytes: null,
      sha256: null,
    });
  }

  add(
    manifestName,
    'manifest',
    new Blob([JSON.stringify(manifest, null, 2)], {
      type: 'application/json',
    }),
  );
  add(
    readmeName,
    'readme',
    new Blob([buildDeliveryReadme(manifest)], {
      type: 'text/plain;charset=utf-8',
    }),
  );

  if (wantsChecksums) {
    add(
      sumsName,
      'checksums',
      new Blob([formatChecksumFile(files.filter((f) => f.sha256))], {
        type: 'text/plain;charset=utf-8',
      }),
    );
  }

  for (const f of files) if (f.bytes === undefined) f.bytes = f.blob.size;

  const folderName = layoutId
    ? `${base}_${layoutId.replace(/[^\w.]/g, '')}_delivery`
    : `${base}_delivery`;

  return { folderName, files, manifest };
}

/**
 * Download every file in a package.
 *
 * Browsers rate-limit consecutive programmatic downloads and some will silently drop the
 * later ones, so the files are spaced out. The master goes first: if the user cancels
 * partway through, they still have the thing that matters.
 *
 * @param {{files: PackageFile[]}} pkg
 * @param {{delayMs?: number}} [opts]
 * @returns {Promise<{downloaded: number, failed: string[]}>}
 */
export async function downloadDeliveryPackage(pkg, opts = {}) {
  const delay = opts.delayMs ?? 400;
  const failed = [];
  let downloaded = 0;
  for (const [i, f] of pkg.files.entries()) {
    const result =
      f.blob.type.startsWith('text/') || f.blob.type.startsWith('application/')
        ? downloadBlob(f.blob, f.filename)
        : downloadBlob(f.blob, f.filename);
    if (result.ok) downloaded++;
    else failed.push(f.filename);
    if (i < pkg.files.length - 1) await new Promise((r) => setTimeout(r, delay));
  }
  return { downloaded, failed };
}

/** Re-exported so a caller can emit a single text sidecar without importing two modules. */
export { downloadText };
