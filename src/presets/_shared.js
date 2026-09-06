/**
 * Preset catalogue helpers.
 *
 * ── Unit conversion at the boundary ──────────────────────────────────────────────────
 * The audited catalogue stored `ms`, `crossfeed`, `phaseRot` and `spread` as percentages
 * and divided by 100 inside `applyPreset`, while the runtime object stored them as
 * ratios. Two representations of the same quantity, converted in one place and only one
 * place, is exactly the kind of hidden unit conversion the brief asks to eliminate.
 *
 * The catalogues here are written in **schema units** — the same units `app/parameters.js`
 * declares. There is no conversion step. A preset value is a parameter value.
 *
 * ── The `audit` field ────────────────────────────────────────────────────────────────
 * Every preset carries a short note recording what was checked and anything a user should
 * know before reaching for it. These are surfaced as tooltips, not hidden in a comment.
 */

/**
 * Two families, two promises:
 *
 *  · `mastering` — pristine, professional, controlled. No degradation DSP may appear
 *    here: tape, hiss, vinyl, Haas and the side comb are always zero, enforced both by
 *    catalogue review and at runtime by `sanitizeForFamily`.
 *  · `creative` — Signal Rot at its strangest: intentionally degraded, haunted,
 *    distorted, unstable. Anything goes as long as it is labelled honestly.
 *
 * @typedef {object} Preset
 * @property {string} name
 * @property {string} tag         short category label shown on the card
 * @property {string} description
 * @property {Record<string, any>} parameters  sparse — only what this preset changes
 * @property {string} [audit]     result of the safety review
 * @property {'safe'|'caution'|'destructive'} risk
 * @property {'mastering'|'creative'} [family] explicit family; inferred when omitted
 */

/** @param {Preset} p */
export const preset = (p) => Object.freeze({ risk: 'safe', ...p });

/** Parameters that constitute degradation DSP. Never non-zero in the mastering family. */
export const DEGRADATION_KEYS = Object.freeze(['tape', 'hiss', 'vinyl', 'phaseRot', 'haas']);

/**
 * Resolve a preset's family. An explicit `family` field wins; otherwise any use of
 * degradation DSP marks a preset creative.
 * @param {Preset} p
 * @returns {'mastering'|'creative'}
 */
export function presetFamily(p) {
  if (p.family === 'creative' || p.family === 'mastering') return p.family;
  const q = p.parameters ?? {};
  for (const key of DEGRADATION_KEYS) {
    if ((q[key] ?? 0) !== 0) return 'creative';
  }
  return 'mastering';
}

/**
 * Enforce the family contract on a parameter block about to be applied.
 * Mastering presets get every degradation control zeroed, even if a hand-edited file
 * set them. Creative presets pass through untouched.
 *
 * @param {'mastering'|'creative'} family
 * @param {Record<string, any>} parameters
 * @returns {{parameters: Record<string, any>, scrubbed: string[]}}
 */
export function sanitizeForFamily(family, parameters) {
  if (family !== 'mastering') return { parameters, scrubbed: [] };
  const scrubbed = [];
  const out = { ...parameters };
  for (const key of DEGRADATION_KEYS) {
    if ((out[key] ?? 0) !== 0) {
      out[key] = 0;
      scrubbed.push(key);
    }
  }
  return { parameters: out, scrubbed };
}
