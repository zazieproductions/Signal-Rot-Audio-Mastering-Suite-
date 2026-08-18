/**
 * Signal Rot — preset catalogs.
 * Pure data. Catalog values use "UI units" where noted (see params.js catalogToState).
 * Preset descriptions are user-facing and must match what the processing actually does.
 */
import { catalogToState, validateState, DEFAULTS } from './params.js';

export const DIMENSION = [
  { n: 'Analog Womb', d: 'Tape-warmed multiband glue, head bump, enveloping depth. The expensive-console sound.', p: { targetLUFS: -14, ceiling: -1.0, tape: 35, mbLow: 30, mbMid: 20, mbHigh: 15, mbMix: 60, warm: 1.6, sub: 1.2, depth: 20, sat: 8, width: 1.05 } },
  { n: 'Crystal Palace', d: 'Ultra-wide crystalline highs over anchored bass. Pristine, dimensional, hi-fi.', p: { targetLUFS: -13, ceiling: -1.0, widthHigh: 1.6, widthLow: 0.7, air: 2.5, clarity: 1.2, mbHigh: 20, mbMix: 70, depth: 15, sat: 3 } },
  { n: 'Fourth Dimension', d: 'Full spatial engagement — depth bloom, binaural field, per-band imaging.', p: { targetLUFS: -14, ceiling: -1.0, depth: 45, depthSize: 'large', binaural: true, crossfeed: 40, widthMid: 1.3, widthHigh: 1.5, spread: 35, air: 1.5, sat: 4 } },
  { n: 'Tape Ghost', d: 'Heavy wow/flutter, hiss bed, dark and haunted. Signal rot as mastering aesthetic.', p: { targetLUFS: -16, ceiling: -1.0, tape: 70, hiss: 25, tilt: -1.5, air: -1.5, mbMix: 40, mbLow: 25, sat: 12, width: 1.15 } },
  { n: 'Vinyl Séance', d: 'Crackle, rumble, narrowed low end. A record that remembers being played.', p: { targetLUFS: -15, ceiling: -1.0, vinyl: 45, warm: 2, widthLow: 0.5, bassMono: 100, harsh: -1, sat: 10, depth: 12 } },
  { n: 'Hyperreal', d: 'Multiband punch, transient attack, wide sparkle. More vivid than reality.', p: { targetLUFS: -11, ceiling: -1.0, transAttack: 35, mbLow: 35, mbMid: 25, mbHigh: 30, mbMix: 70, widthHigh: 1.4, clarity: 1.5, air: 2, sat: 6 } },
];

export const GENRE = [
  { n: 'Transparent', t: 'flat', d: 'No coloration. Just safe true-peak ceiling.', p: {} },
  { n: 'Streaming -14', t: 'loud', d: 'Spotify/Apple target, gentle glue.', p: { targetLUFS: -14, ceiling: -1.0, drive: 1.2, clarity: 0.6, air: 0.8, sat: 4 } },
  { n: 'Club / EDM', t: 'loud', d: 'Loud, tight low end mono, bright top.', p: { targetLUFS: -9, ceiling: -0.5, drive: 3, bassMono: 120, air: 1.8, clarity: 1, width: 1.1, sat: 10 } },
  { n: 'Hip-Hop', t: 'warm', d: 'Thick lows, controlled width, present mids.', p: { targetLUFS: -10, ceiling: -0.5, drive: 2.5, warm: 1.6, bassMono: 90, clarity: 1.0, sat: 8 } },
  { n: 'Ambient / Drone', t: 'open', d: 'Wide, airy, untouched dynamics.', p: { targetLUFS: -18, ceiling: -1.0, width: 1.35, air: 1.5, warm: 0.8, normalize: true, sat: 3 } },
  { n: 'Acoustic / Folk', t: 'natural', d: 'Light touch, natural stereo, no pump.', p: { targetLUFS: -16, ceiling: -1.0, drive: 0.5, clarity: 0.5, warm: 0.5, sat: 2 } },
  { n: 'Industrial', t: 'harsh', d: 'Aggressive, mid-forward, hard ceiling.', p: { targetLUFS: -9, ceiling: -0.5, drive: 3, ms: -10, clarity: 1.5, bassMono: 140, sat: 14 } },
  { n: 'Classical', t: 'pure', d: 'Preserve dynamics, only protect peaks.', p: { targetLUFS: -20, ceiling: -1.0, normalize: false, drive: 0, sat: 0 } },
];

export const SPATIAL = [
  { n: 'Cathedral', d: 'Natural tail bloom on the sides + air, no added reverb.', p: { targetLUFS: -15, ceiling: -1.0, width: 1.3, ms: 18, air: 2.0, warm: 0.6, bassMono: 80, sat: 3 } },
  { n: 'Binaural Deep', d: '3D headphone optimization — crossfeed + HRTF depth.', p: { targetLUFS: -14, ceiling: -1.0, binaural: true, crossfeed: 55, spread: 45, width: 1.2, haas: 4, air: 1.0, sat: 4 } },
  { n: 'Inverse Phase', d: 'Creative side phase manipulation — surreal imaging.', p: { targetLUFS: -14, ceiling: -1.0, phaseRot: 65, width: 1.4, ms: 25, sat: 5 } },
  { n: 'Holographic', d: 'Extreme mid/side separation, 3D soundstage.', p: { targetLUFS: -13, ceiling: -1.0, width: 2.1, ms: 40, bassMono: 110, air: 1.4, sat: 5 } },
  { n: 'Tunnel Vision', d: 'Focused mono center, atmospheric wide edges.', p: { targetLUFS: -14, ceiling: -1.0, ms: -30, width: 1.6, bassMono: 160, haas: 8, air: 0.8, sat: 4 } },
  { n: 'Panoramic', d: '180°→360° widefield — Haas + decorrelated sides.', p: { targetLUFS: -13, ceiling: -1.0, width: 2.4, haas: 14, spread: 70, crossfeed: 20, bassMono: 120, sat: 5 } },
];

export const CINEMATIC = [
  { n: 'Psychological Horror', d: 'HD/Hollywood-grade: weighted lows, scooped mud, tamed harshness, extended ASMR air. Dynamics preserved for tension.', p: { targetLUFS: -16, ceiling: -1.0, drive: 1, sub: 3.0, warm: 0.8, body: -2.0, harsh: -3.5, clarity: 1.3, air: 3.0, sat: 8, width: 1.25, bassMono: 90 } },
  { n: 'Synthwave', d: 'Neon and saturated — punchy sub, wide, bright analog top.', p: { targetLUFS: -11, ceiling: -1.0, drive: 2, sub: 1.8, warm: 1.6, clarity: 1.5, air: 2.5, tilt: 0.6, sat: 18, width: 1.3, bassMono: 110 } },
  { n: 'Electronic Experimental', d: 'Open and detailed, transient-preserving, minimal coloration.', p: { targetLUFS: -14, ceiling: -1.0, drive: 1.0, clarity: 0.8, air: 1.6, sat: 5, width: 1.4, bassMono: 80 } },
  { n: 'Sound Design / Foley', d: 'Maximum detail and dynamics. Transparent, full-range, no loudness war.', p: { targetLUFS: -23, ceiling: -1.0, normalize: false, drive: 0, clarity: 1.5, air: 1.5, width: 1.1, sat: 0 } },
  { n: 'Cinematic Trailer', d: 'Huge and weighted — deep sub, scooped mud, wide and punchy.', p: { targetLUFS: -13, ceiling: -1.0, drive: 2, sub: 3.2, warm: 0.8, body: -2.4, clarity: 0.8, air: 2.4, sat: 7, width: 1.4, bassMono: 100 } },
  { n: 'Dark Ambient Score', d: 'Deep, wide, subdued highs, heavy lows. Slow and dynamic.', p: { targetLUFS: -18, ceiling: -1.0, sub: 3, warm: 1.6, tilt: -2.5, air: -1.5, sat: 5, width: 1.5, bassMono: 70 } },
  { n: 'Drone / Doom', d: 'Dense and heavy — saturated low-mid weight, dark, narrowed for mass.', p: { targetLUFS: -15, ceiling: -1.0, drive: 1.5, sub: 2.4, body: 1.6, tilt: -1.6, sat: 14, width: 0.9, bassMono: 120 } },
  { n: 'Noise / Harsh Wall', d: 'Saturated, dense, gritty top, loud and centered.', p: { targetLUFS: -11, ceiling: -0.5, drive: 3, sat: 22, harsh: 1.8, tilt: 0.8, clarity: 0.8, width: 1.0, bassMono: 140 } },
];

export const MOOD = [
  { n: 'Melancholic Sunset', d: 'Warm low-mids, rolled-off air, nostalgic compression.', p: { targetLUFS: -15, ceiling: -1.0, drive: 1.5, warm: 2.0, body: 2.4, harsh: -1.6, air: -3, tilt: -1.6, sat: 10, width: 1.1, bassMono: 80 } },
  { n: 'Anxious Energy', d: 'Tense mid-range, controlled harshness, dynamic instability.', p: { targetLUFS: -14, ceiling: -1.0, drive: 1, body: 1.6, harsh: 1.6, clarity: 1.8, tilt: 0.8, sat: 6, width: 1.15, bassMono: 90, normalize: false } },
  { n: 'Euphoric Peak', d: 'Bright, open, expansive, uplifting frequency curve.', p: { targetLUFS: -11, ceiling: -1.0, drive: 1.5, sub: 0.8, clarity: 1.6, air: 3.5, tilt: 1.8, sat: 6, width: 1.5, spread: 30, bassMono: 100 } },
  { n: 'Dark Meditation', d: 'Deep lows, subdued highs, centered focus.', p: { targetLUFS: -18, ceiling: -1.0, drive: 0.3, sub: 4, warm: 1.6, air: -3, tilt: -2.4, ms: -25, width: 0.85, bassMono: 70, sat: 3 } },
  { n: 'Manic Joy', d: 'Saturated, bright, slightly chaotic harmonic enhancement.', p: { targetLUFS: -11, ceiling: -1.0, drive: 2, clarity: 1.6, air: 2.4, tilt: 1.4, sat: 24, phaseRot: 15, width: 1.4, bassMono: 110 } },
  { n: 'Empty Void', d: 'Stark, minimal, spacious — uncomfortable silences preserved.', p: { targetLUFS: -20, ceiling: -1.0, normalize: false, drive: 0, sub: 0.8, air: 0.8, tilt: -0.8, width: 1.6, spread: 40, sat: 0 } },
];

export const COLOR = [
  { n: 'Crimson', d: 'Warm saturation, deep fundamental emphasis.', p: { targetLUFS: -13, ceiling: -1.0, drive: 1.5, sub: 4, warm: 2.4, body: 0.8, tilt: -0.8, sat: 16, width: 1.1, bassMono: 100 } },
  { n: 'Cobalt', d: 'Cool, clean, precise, slightly clinical.', p: { targetLUFS: -14, ceiling: -1.0, drive: 0.8, clarity: 1.6, air: 1.6, harsh: -0.8, tilt: 1.6, sat: 0, width: 1.1 } },
  { n: 'Gold', d: 'Vintage warmth, harmonic richness, expensive sound.', p: { targetLUFS: -13, ceiling: -1.0, drive: 1.5, warm: 2.4, body: 0.8, harsh: -1.6, air: 1.6, tilt: -0.4, sat: 14, width: 1.2, bassMono: 90 } },
  { n: 'Obsidian', d: 'Dark, dense, mysterious low-mid emphasis.', p: { targetLUFS: -14, ceiling: -1.0, drive: 1.5, sub: 1.6, body: 3.2, harsh: -0.8, air: -2.4, tilt: -2.4, sat: 12, width: 1.0, bassMono: 100 } },
  { n: 'Pearl', d: 'Shimmering highs, elegant, refined.', p: { targetLUFS: -14, ceiling: -1.0, drive: 0.8, clarity: 1.6, air: 3.6, harsh: -1.6, tilt: 1.6, sat: 3, width: 1.25, bassMono: 70 } },
  { n: 'Rust', d: 'Degraded, oxidized, beautifully broken.', p: { targetLUFS: -12, ceiling: -0.5, drive: 2, body: 1.6, harsh: 1.6, air: -2.4, tilt: -0.8, sat: 32, width: 1.1, bassMono: 120 } },
];

export const PRESET_GROUPS = [
  { id: 'dimension', tag: 'dimension', title: 'Dimension — the new engines', list: DIMENSION },
  { id: 'genre', tag: 'genre', title: 'Genre / character — one-tap masters', list: GENRE },
  { id: 'cinematic', tag: 'cinema', title: 'Cinematic / scoring', list: CINEMATIC },
  { id: 'mood', tag: 'mood', title: 'Mood', list: MOOD },
  { id: 'color', tag: 'color', title: 'Color', list: COLOR },
  { id: 'spatial', tag: 'spatial', title: 'Spatial', list: SPATIAL },
];

export function allPresets() {
  return PRESET_GROUPS.flatMap((g) => g.list.map((p) => ({ ...p, group: g.id, tag: p.t || g.tag })));
}

export function findPreset(name) {
  return allPresets().find((p) => p.n === name) || null;
}

/**
 * Automated catalog validation used by tests:
 *  - every preset maps to real, in-range parameters
 *  - every catalog value survives catalogToState + validateState
 */
export function validatePresetCatalog() {
  const problems = [];
  const seen = new Set();
  for (const preset of allPresets()) {
    if (seen.has(preset.n)) problems.push(`duplicate preset name: ${preset.n}`);
    seen.add(preset.n);
    if (!preset.d) problems.push(`${preset.n}: missing description`);
    for (const key of Object.keys(preset.p)) {
      if (!(key in DEFAULTS)) {
        problems.push(`${preset.n}: unknown parameter "${key}"`);
        continue;
      }
    }
    const canonical = { ...DEFAULTS, ...catalogToState(preset.p) };
    const v = validateState(canonical);
    if (!v.ok) problems.push(`${preset.n}: ${v.problems.join('; ')}`);
  }
  return { ok: problems.length === 0, problems };
}
