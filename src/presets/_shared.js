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
 * @typedef {object} Preset
 * @property {string} name
 * @property {string} tag         short category label shown on the card
 * @property {string} description
 * @property {Record<string, any>} parameters  sparse — only what this preset changes
 * @property {string} [audit]     result of the safety review
 * @property {'safe'|'caution'|'destructive'} risk
 */

/** @param {Preset} p */
export const preset = (p) => Object.freeze({ risk: 'safe', ...p });
