/**
 * Spatial scene engine — pure decision logic for the source-aware up-mixer (§7–§13).
 *
 * Everything that decides *what* the advanced engine routes where lives here, as pure,
 * deterministic functions over plain objects, so the routing laws are unit-tested in
 * Node while `spatial-feeds.js` turns a scene into Web Audio nodes.
 *
 * ── What a scene is ───────────────────────────────────────────────────────────────────
 * Per band (sub/low/low-mid/mid/presence/air) a routing row:
 *   frontM   mid fed to the front pair (main image retention)
 *   centreM  mid fed to the centre speaker(s) (per-band centre affinity; the user's
 *            centreExtract knob and the front-pair compensation are applied on top)
 *   frontS   side fed to the front pair (per-band stereo-width retention)
 *   sideS    side fed to the surround pair
 *   rearS    side fed to the rear pair
 *   heightS  side fed to the height pair(s)
 *   lfeM     mid fed (LR4 low-passed) to the LFE/sub group — only the sub band uses it
 * plus a decorrelation amount per band (0 = pass the raw side) and `levels` for the
 * destination rings. Motion is a separate modulation of ring *levels* only — front,
 * centre, bass and LFE are never part of a motion path (§11).
 *
 * ── Laws that hold for every preset (validated by tests) ─────────────────────────────
 *   · Bass anchor: below 300 Hz nothing but the front pair and LFE carries signal —
 *     the sub/low rows have zero sideS/rearS/heightS, and only the sub band may have
 *     lfeM. What a centre extractor would do to a stereo bass image is not worth the
 *     room modes it excites.
 *   · The front pair comes first: frontM ≥ 0.85 in every band, and the front pair is
 *     the only place full-band-width mid content exists.
 *   · S budgets: per band, sideS² + rearS² + heightS² ≤ 3.2. Presets sit around
 *     ≤ 2.0 (+3 dB of decorrelated material across all rings — the front image stays
 *     dominant); the cap only bites at the deliberate "every knob wide open" corner.
 *
 * ── Source-awareness ──────────────────────────────────────────────────────────────────
 * `planSpatialScene` starts from the preset row and then *adapts* it with the measured
 * profile (§7): phasey side material gets less decorrelation; incoherent bass anchors
 * to the front; transient-heavy material keeps its fronts; near-mono collapses to a
 * front stage; bright material fills the heights more gently. Adaptations only ever
 * *reduce* routing — the preset is the ceiling, so switching presets always changes
 * the sound and the measured profile can only pull a scene back toward the front.
 */

/** Band ids, low to high — matches `SPATIAL_BANDS` in analysis/spatial-profile.js. */
export const ENGINE_BANDS = Object.freeze(['sub', 'low', 'lowmid', 'mid', 'pres', 'air']);

/** Ring pairs a scene routes into. */
export const RINGS = Object.freeze(['side', 'rear', 'height', 'ground']);

/** Crossover frequencies between bands, low to high (Hz) — synthesis mirror of
 * `SPATIAL_BANDS`. */
export const ENGINE_XOVERS = Object.freeze([100, 300, 900, 3000, 8000]);

const row = (frontM, centreM, frontS, sideS, rearS, heightS, lfeM = 0) => ({
  frontM,
  centreM,
  frontS,
  sideS,
  rearS,
  heightS,
  lfeM,
});

const def = (rows, decorr, levels, motion, label) => ({ rows, decorr, levels, motion, label });

/**
 * The nine spatial preset families (§10).
 * Rows carry *delivered per-band gains* — they already include the ring-level balance,
 * so levels only nudges a destination ring on top of its rows.
 */
export const SPATIAL_PRESETS = Object.freeze({
  'natural-room': def(
    {
      sub: row(1, 0.15, 0, 0, 0, 0, 0.9),
      low: row(1, 0.3, 0.15, 0, 0, 0),
      lowmid: row(1, 0.35, 0.55, 0.42, 0.12, 0),
      mid: row(1, 0.3, 0.55, 0.4, 0.25, 0.14),
      pres: row(1, 0.2, 0.85, 0.6, 0.45, 0.3),
      air: row(1, 0.15, 1, 0.7, 0.55, 0.5),
    },
    { sub: 0, low: 0, lowmid: 0.35, mid: 0.5, pres: 0.7, air: 0.8 },
    { side: 1, rear: 1, height: 1, ground: 0.5 },
    'static',
    'A believable small hall: front image intact, gentle wash around and above',
  ),
  cinematic: def(
    {
      sub: row(1, 0.2, 0, 0, 0, 0, 1),
      low: row(1, 0.35, 0.1, 0, 0, 0),
      lowmid: row(0.95, 0.35, 0.6, 0.55, 0.25, 0),
      mid: row(0.95, 0.35, 0.55, 0.7, 0.45, 0.15),
      pres: row(0.9, 0.25, 0.85, 0.9, 0.65, 0.35),
      air: row(0.95, 0.2, 1, 0.85, 0.7, 0.6),
    },
    { sub: 0, low: 0, lowmid: 0.5, mid: 0.65, pres: 0.8, air: 0.9 },
    { side: 1.1, rear: 1.15, height: 1.05, ground: 0.6 },
    'static',
    'Wide cinematic space: strong sides, present rears, clear top',
  ),
  cathedral: def(
    {
      sub: row(1, 0.2, 0, 0, 0, 0, 0.9),
      low: row(1, 0.4, 0.05, 0, 0, 0),
      lowmid: row(0.98, 0.4, 0.4, 0.3, 0.35, 0),
      mid: row(0.95, 0.4, 0.35, 0.4, 0.6, 0.3),
      pres: row(0.92, 0.3, 0.7, 0.6, 0.8, 0.55),
      air: row(0.95, 0.25, 0.95, 0.7, 0.9, 0.8),
    },
    { sub: 0, low: 0, lowmid: 0.55, mid: 0.7, pres: 0.85, air: 0.95 },
    { side: 1, rear: 1.25, height: 1.2, ground: 0.8 },
    'static',
    'Long tail: rear- and height-heavy ambience, delayed decorrelation',
  ),
  'deep-field': def(
    {
      sub: row(1, 0.2, 0, 0, 0, 0, 1),
      low: row(1, 0.35, 0.1, 0, 0, 0),
      lowmid: row(1, 0.4, 0.5, 0.2, 0.4, 0),
      mid: row(0.95, 0.35, 0.45, 0.25, 0.7, 0.1),
      pres: row(0.9, 0.25, 0.75, 0.35, 0.9, 0.25),
      air: row(0.92, 0.2, 0.95, 0.4, 1, 0.4),
    },
    { sub: 0, low: 0, lowmid: 0.2, mid: 0.5, pres: 0.6, air: 0.75 },
    { side: 0.9, rear: 1.35, height: 1, ground: 0.5 },
    'static',
    'The stage pushed back: dark, rear-dominant ambience',
  ),
  'overhead-bloom': def(
    {
      sub: row(1, 0.15, 0, 0, 0, 0, 0.9),
      low: row(1, 0.3, 0.15, 0, 0, 0),
      lowmid: row(1, 0.35, 0.6, 0.25, 0.05, 0),
      mid: row(0.95, 0.3, 0.5, 0.25, 0.08, 0.45),
      pres: row(0.9, 0.2, 0.75, 0.3, 0.15, 0.9),
      air: row(0.9, 0.15, 0.85, 0.25, 0.2, 1),
    },
    { sub: 0, low: 0, lowmid: 0.45, mid: 0.6, pres: 0.8, air: 0.95 },
    { side: 1, rear: 0.9, height: 1.3, ground: 0.5 },
    'static',
    'Height-first ambience: the room blooms above the listener',
  ),
  orbital: def(
    {
      sub: row(1, 0.15, 0, 0, 0, 0, 0.9),
      low: row(1, 0.3, 0.12, 0, 0, 0),
      lowmid: row(1, 0.35, 0.6, 0.5, 0.2, 0),
      mid: row(0.95, 0.3, 0.5, 0.55, 0.4, 0.2),
      pres: row(0.9, 0.2, 0.75, 0.7, 0.55, 0.4),
      air: row(0.95, 0.15, 0.95, 0.7, 0.55, 0.55),
    },
    { sub: 0, low: 0, lowmid: 0.5, mid: 0.6, pres: 0.75, air: 0.85 },
    { side: 1.1, rear: 1.1, height: 1.05, ground: 0.5 },
    'orbit',
    'The space slowly rotates around the static front image',
  ),
  void: def(
    {
      sub: row(1, 0.2, 0, 0, 0, 0, 1),
      low: row(1, 0.35, 0.08, 0, 0, 0),
      lowmid: row(1, 0.4, 0.45, 0.55, 0.15, 0),
      mid: row(0.98, 0.35, 0.4, 0.65, 0.25, 0.12),
      pres: row(0.95, 0.25, 0.65, 0.85, 0.35, 0.25),
      air: row(1, 0.15, 0.75, 0.9, 0.45, 0.4),
    },
    { sub: 0, low: 0, lowmid: 0.6, mid: 0.7, pres: 0.85, air: 0.9 },
    { side: 1.2, rear: 0.9, height: 0.9, ground: 0.7 },
    'static',
    'Dark surround void: enveloping sides with almost no explicit rears',
  ),
  hyperreal: def(
    {
      sub: row(1, 0.2, 0, 0, 0, 0, 0.9),
      low: row(1, 0.35, 0.12, 0, 0, 0),
      lowmid: row(1, 0.4, 0.55, 0.55, 0.3, 0),
      mid: row(0.95, 0.35, 0.5, 0.6, 0.4, 0.3),
      pres: row(0.9, 0.25, 0.7, 0.7, 0.5, 0.5),
      air: row(0.9, 0.15, 0.9, 0.75, 0.55, 0.65),
    },
    { sub: 0, low: 0, lowmid: 0.6, mid: 0.7, pres: 0.85, air: 0.95 },
    { side: 1.15, rear: 1.2, height: 1.15, ground: 0.6 },
    'static',
    'Maximum believable space — every ring engaged, heavily decorrelated',
  ),
  'sonic-lab-20.4': def(
    {
      sub: row(1, 0.15, 0, 0, 0, 0, 0.85),
      low: row(1, 0.3, 0.15, 0, 0, 0),
      lowmid: row(1, 0.35, 0.6, 0.45, 0.18, 0),
      mid: row(0.95, 0.3, 0.55, 0.5, 0.35, 0.35),
      pres: row(0.9, 0.2, 0.75, 0.6, 0.5, 0.7),
      air: row(0.9, 0.15, 0.95, 0.6, 0.55, 0.9),
    },
    { sub: 0, low: 0, lowmid: 0.45, mid: 0.6, pres: 0.75, air: 0.9 },
    { side: 1.05, rear: 1.1, height: 1.1, ground: 0.9 },
    'static',
    'Tuned for the 24-speaker Linz venue: ground ring engaged, wider height spread',
  ),
});

/** Ordered preset ids for the UI. */
export const SPATIAL_PRESET_IDS = Object.freeze(Object.keys(SPATIAL_PRESETS));

/** Motion modes offered by the UI (§11). */
export const MOTION_MODES = Object.freeze([
  'static',
  'orbit',
  'front-rear-drift',
  'vertical',
  'clockwise',
  'anti-clockwise',
  'breathing',
  'drift',
]);

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Validate a scene/preset against the engine laws. Throws on violation.
 * @param {object} scene `{ rows, decorr, levels }` or a preset rows map
 * @param {string} [label] for error messages
 */
export function validateScene(scene, label = 'scene') {
  const rows = scene.rows;
  for (const id of ENGINE_BANDS) {
    const r = rows[id];
    if (!r) throw new Error(`${label}: missing row for band ${id}`);
    const keys = ['frontM', 'centreM', 'frontS', 'sideS', 'rearS', 'heightS', 'lfeM'];
    for (const k of keys) {
      if (typeof r[k] !== 'number' || !Number.isFinite(r[k])) {
        throw new Error(`${label}: row ${id} has non-numeric ${k}`);
      }
    }
    if (r.frontM < 0.8) throw new Error(`${label}: row ${id} frontM ${r.frontM} < 0.8`);
    if (id === 'sub' || id === 'low') {
      if (r.sideS !== 0 || r.rearS !== 0 || r.heightS !== 0) {
        throw new Error(`${label}: row ${id} violates the bass anchor (side/rear/height ≠ 0)`);
      }
      if (id === 'low' && r.lfeM !== 0) throw new Error(`${label}: low row carries LFE`);
    } else if (r.lfeM !== 0) {
      throw new Error(`${label}: row ${id} carries LFE above the sub band`);
    }
    const budget = r.sideS ** 2 + r.rearS ** 2 + r.heightS ** 2;
    if (budget > 3.2 + 1e-9) throw new Error(`${label}: row ${id} space budget ${budget.toFixed(2)} > 3.2`);
    for (const k of keys) {
      if (k === 'frontM' || k === 'lfeM') continue;
      if (Math.abs(r[k]) > 1.4) throw new Error(`${label}: row ${id} ${k} out of range`);
    }
  }
  for (const b of ENGINE_BANDS) {
    if (typeof scene.decorr[b] !== 'number' || scene.decorr[b] < 0 || scene.decorr[b] > 1) {
      throw new Error(`${label}: decorr[${b}] out of 0..1`);
    }
  }
  for (const ring of RINGS) {
    if (typeof scene.levels[ring] !== 'number' || !(scene.levels[ring] > 0)) {
      throw new Error(`${label}: levels.${ring} missing`);
    }
  }
}

for (const [name, preset] of Object.entries(SPATIAL_PRESETS)) {
  validateScene(preset, `preset ${name}`);
}

/**
 * Compose the delivered scene for one render from state + measured profile.
 *
 * @param {object} im immersive state (`mode`, `spatialPreset`, macros…)
 * @param {object} [profile] result of `measureSpatialProfile`
 * @returns {object} `{ rows, decorr, levels, motion, label }` — never mutated afterwards
 */
export function planSpatialScene(im, profile = null) {
  const preset = SPATIAL_PRESETS[im.spatialPreset] ?? SPATIAL_PRESETS['natural-room'];
  const rows = {};
  for (const id of ENGINE_BANDS) {
    rows[id] = { ...preset.rows[id] };
  }
  const decorr = { ...preset.decorr };
  const levels = { ...preset.levels };
  let motion = preset.motion;

  // ── Macro model (§13): envelopment, front focus, rear depth, room size, heights.
  // Every factor below is *neutral at the default 0.5* — a default scene is exactly
  // the preset scene, and only deliberate knob movement changes it.
  const envelopment = clamp(im.envelopment ?? 0.5); // 0..1, 0.5 neutral
  const frontFocus = clamp(im.frontFocus ?? 0.5);
  const rearDepth = clamp(im.rearDepth ?? 0.5);
  const roomSize = clamp(im.roomSize ?? 0.5);
  const heightFocus = clamp(im.heightFocus ?? 0.5);
  const heightSpread = clamp(im.heightSpread ?? 0.5);

  for (const id of ENGINE_BANDS) {
    const r = rows[id];
    // Envelopment pulls mid-band side energy off the front pair into the space rings.
    const midWeight = id === 'mid' ? 1 : id === 'lowmid' || id === 'pres' ? 0.7 : id === 'air' ? 0.5 : 0;
    if (midWeight > 0) {
      const pull = (envelopment - 0.5) * 2 * 0.1 * midWeight;
      r.frontS = clamp(r.frontS - pull, 0, 1.2);
      r.sideS = clamp(r.sideS + pull * 1.5, 0, 1.3);
      r.rearS = clamp(r.rearS + pull * 0.75, 0, 1.3);
    }
    // Front focus pulls mid-band side energy back toward the front pair.
    if (id === 'mid' || id === 'lowmid') {
      const pull = (frontFocus - 0.5) * 2 * 0.1;
      r.sideS = clamp(r.sideS - pull * 0.8, 0, 1.3);
      r.rearS = clamp(r.rearS - pull * 0.35, 0, 1.3);
      r.frontS = clamp(r.frontS + pull * 1.1, 0, 1.4);
    }
    // Rear depth governs the presence/air rows and the rear/side ring levels.
    if (id === 'pres' || id === 'air') {
      r.rearS = clamp(r.rearS * lerp(0.7, 1.3, rearDepth), 0, 1.4);
    }
    // Room size: mid-band side energy moves a step out and decorrelation deepens.
    if (id !== 'sub' && id !== 'low') {
      const grow = (roomSize - 0.5) * 2 * 0.05;
      r.frontS = clamp(r.frontS - grow, 0, 1.2);
      r.sideS = clamp(r.sideS + grow * 0.9, 0, 1.35);
      r.rearS = clamp(r.rearS + grow * 1.2, 0, 1.35);
      r.heightS = clamp(r.heightS + grow * 0.7, 0, 1.4);
    }
    // Height intelligence (§12): heightFocus tilts height energy toward the bright top
    // (presence/air) instead of the mid band; heightSpread widens decorrelation below.
    if (id === 'pres' || id === 'air') {
      r.heightS = clamp(r.heightS * lerp(0.6, 1.4, heightFocus), 0, 1.4);
    } else if (id === 'mid') {
      r.heightS = clamp(r.heightS * lerp(1.4, 0.6, heightFocus), 0, 1.4);
    }
    if (decorr[id] > 0) {
      decorr[id] = clamp(decorr[id] * lerp(0.6, 1.4, roomSize), 0, 1);
      decorr[id] = clamp(decorr[id] * lerp(0.85, 1.15, heightSpread), 0, 1);
    }
  }
  levels.side *= lerp(0.85, 1.15, rearDepth);
  levels.rear *= lerp(0.75, 1.25, rearDepth);

  // ── Motion override: the preset suggests one, the user can pin another (§11).
  if (im.motion && im.motion !== 'default') motion = im.motion;
  void heightSpread; // consumed at synthesis time (decorrelation micro-delay spread)

  // ── Source-aware adaptation (§7): conservative — it only ever *reduces* routing,
  //    never invents more space than the preset asked for.
  if (profile) {
    const p = profile;
    // Phasey material (low ambient ratio = structured/correlated side) tolerates little
    // decorrelation; truly decorrelated side material keeps its full decorrelation.
    const phaseyScale = clamp(p.ambientRatio + 0.25, 0.35, 1);
    // Incoherent bass stays at the front (bass anchor): narrow the bass width.
    const bassScale = clamp(p.bassCoherence * 1.6, 0.15, 1);
    // Transient-heavy material keeps its fronts (transient anchor).
    const transientScale = clamp(1 - p.transientDensity * 0.012, 0.7, 1);
    // Very bright sources already fill the top; gentler heights keep it natural.
    const airScale = clamp(1 - (p.brightnessAirDb + 6) / 40, 0.6, 1);
    // Near-mono sources have nothing to extract: collapse to the front stage.
    const sideRatio = 10 ** (-clamp(p.energyMidSideDb, 0, 20) / 20);
    const nearMono = clamp(1 - sideRatio / 0.5, 0, 1);

    for (const id of ENGINE_BANDS) {
      const r = rows[id];
      if (id === 'sub' || id === 'low') {
        r.frontS = clamp(r.frontS * lerp(0.5, 1, bassScale), 0, 1.2);
      } else {
        r.sideS *= transientScale;
        r.rearS *= transientScale;
      }
      if (id === 'air') r.heightS *= airScale;
      if (nearMono >= 0.75) {
        // Graceful mono collapse: rings fall silent, fronts and LFE stay.
        r.sideS = 0;
        r.rearS = 0;
        r.heightS = 0;
      }
      if (decorr[id] > 0) {
        decorr[id] *= id === 'pres' || id === 'air' ? phaseyScale : lerp(1, phaseyScale, 0.6);
      }
    }
  }

  // ── Budget renormalisation ──
  // Macro compounding is deliberately interactive (room × rear × height knobs stack),
  // so an extreme corner can exceed the space budget. Rather than throw, scale that
  // band's ring gains back down — the knobs keep their full travel and the delivered
  // scene always obeys the law. Ratios between rings are preserved.
  for (const id of ENGINE_BANDS) {
    const r = rows[id];
    const budget = r.sideS ** 2 + r.rearS ** 2 + r.heightS ** 2;
    if (budget > 3.2 + 1e-9) {
      const k = Math.sqrt(3.2 / budget);
      r.sideS *= k;
      r.rearS *= k;
      r.heightS *= k;
    }
  }

  validateScene({ rows, decorr, levels }, `planned scene`);
  return { rows, decorr, levels, motion, label: preset.label };
}

/* ────────────────────────────── motion (§11) ─────────────────────────────── */

/** Smoothstep, 0..1. */
const ss = (t) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

/**
 * Motion gain profile: ring levels for one instant of the motion cycle.
 *
 * Motion only ever modulates the *space rings* (side/rear/height/ground) and never
 * front, centre, bass or LFE. Left/right of each pair is constant-power-summed per
 * sample pair shape (L² + R² stays ≤ 1) so nothing swells the sum. Returns per-side
 * ring gains; fronts stay 1 except in front-rear-drift where the rear image needs the
 * extra reach.
 *
 * @param {string} mode
 * @param {number} phase 0..1 position in the motion cycle
 * @param {object} [opts] `{ depth }` 0..1 motion amount (1 = full)
 * @returns {{sideL:number, sideR:number, rearL:number, rearR:number,
 *   heightL:number, heightR:number, groundL:number, groundR:number,
 *   frontL:number, frontR:number}}
 */
export function motionGains(mode, phase, opts = {}) {
  const depth = clamp(opts.depth ?? 1, 0, 1);
  const t = (((phase % 1) + 1) % 1);
  const one = {
    sideL: 1,
    sideR: 1,
    rearL: 1,
    rearR: 1,
    heightL: 1,
    heightR: 1,
    groundL: 1,
    groundR: 1,
    frontL: 1,
    frontR: 1,
  };
  if (mode === 'static' || !MOTION_MODES.includes(mode)) return one;

  const theta = 2 * Math.PI * t;
  const c = Math.cos(theta);
  const s = Math.sin(theta);

  if (mode === 'orbit') {
    // The space image orbits the room: the side/rear pair levels chase each other.
    const cw = 0.5 + 0.5 * c;
    const ccw = 0.5 - 0.5 * c;
    const sw = 0.5 + 0.5 * s;
    const sccw = 0.5 - 0.5 * s;
    const pan = (d) => Math.sqrt(d);
    return {
      ...one,
      sideL: lerp(1, pan(lerp(0.4, 1, cw)), depth * 0.9),
      sideR: lerp(1, pan(lerp(0.4, 1, ccw)), depth * 0.9),
      rearL: lerp(1, pan(lerp(0.4, 1, sw)), depth * 0.9),
      rearR: lerp(1, pan(lerp(0.4, 1, sccw)), depth * 0.9),
    };
  }
  if (mode === 'front-rear-drift') {
    // The space image slowly moves from the front of the room to the back.
    const drift = lerp(0.55, 1.6, ss(t));
    const front = Math.sqrt(1 / drift);
    return {
      ...one,
      sideL: lerp(1, 1 / drift, depth * 0.6),
      sideR: lerp(1, 1 / drift, depth * 0.6),
      rearL: lerp(1, drift, depth),
      rearR: lerp(1, drift, depth),
      frontL: lerp(1, front, depth * 0.3),
      frontR: lerp(1, front, depth * 0.3),
    };
  }
  if (mode === 'vertical') {
    // Height ambience slowly rises and falls; the ear rings dip in counterpoint.
    const up = lerp(0.65, 1.5, 0.5 + 0.5 * Math.sin(theta));
    const down = 2 - up;
    return {
      ...one,
      heightL: lerp(1, up, depth),
      heightR: lerp(1, up, depth),
      sideL: lerp(1, Math.sqrt(down), depth * 0.5),
      sideR: lerp(1, Math.sqrt(down), depth * 0.5),
    };
  }
  if (mode === 'clockwise' || mode === 'anti-clockwise') {
    // A continuous L→R (clockwise) or R→L circulation of the side/rear ring.
    const dir = mode === 'clockwise' ? 1 : -1;
    const sl = 0.5 + 0.5 * Math.cos(dir * theta);
    const sr = 0.5 - 0.5 * Math.cos(dir * theta);
    const rl = 0.5 + 0.5 * Math.sin(dir * theta);
    const rr = 0.5 - 0.5 * Math.sin(dir * theta);
    return {
      ...one,
      sideL: lerp(1, lerp(0.5, 1, Math.sqrt(sl)), depth * 0.8),
      sideR: lerp(1, lerp(0.5, 1, Math.sqrt(sr)), depth * 0.8),
      rearL: lerp(1, lerp(0.5, 1, Math.sqrt(rl)), depth * 0.8),
      rearR: lerp(1, lerp(0.5, 1, Math.sqrt(rr)), depth * 0.8),
    };
  }
  if (mode === 'breathing') {
    const b = Math.sqrt(1 + 0.3 * Math.sin(theta));
    return {
      ...one,
      sideL: lerp(1, b, depth),
      sideR: lerp(1, b, depth),
      rearL: lerp(1, b, depth),
      rearR: lerp(1, b, depth),
      heightL: lerp(1, Math.sqrt(b), depth * 0.7),
      heightR: lerp(1, Math.sqrt(b), depth * 0.7),
    };
  }
  // 'drift' — deterministic pseudo-random wander: four slowly stepping values.
  const h1 = Math.sin(t * 12893.17) * 43758.5453 - Math.floor(Math.sin(t * 12893.17) * 43758.5453);
  const h2 = Math.sin((t + 0.37) * 23191.71) * 9241.1 - Math.floor(Math.sin((t + 0.37) * 23191.71) * 9241.1);
  const h3 = Math.sin((t + 0.61) * 18001.3) * 12345.6 - Math.floor(Math.sin((t + 0.61) * 18001.3) * 12345.6);
  const h4 = Math.sin((t + 0.83) * 30991.7) * 5555.5 - Math.floor(Math.sin((t + 0.83) * 30991.7) * 5555.5);
  const w1 = ss((t * 4) % 1);
  const w2 = ss(((t + 0.25) * 4) % 1);
  const step = (h) => 0.6 + 0.8 * (h * 0.5 + 0.5);
  return {
    ...one,
    sideL: lerp(1, step(h1) * (0.7 + 0.3 * w1), depth * 0.5),
    sideR: lerp(1, step(h2) * (0.7 + 0.3 * w2), depth * 0.5),
    rearL: lerp(1, step(h3) * (0.7 + 0.3 * w2), depth * 0.5),
    rearR: lerp(1, step(h4) * (0.7 + 0.3 * w1), depth * 0.5),
  };
}

/**
 * Speaker → audition/monitoring group (front/side/rear/height/sub), used by solo/mute
 * chips and by the immersive render report's group meters. Ground-ring washes count as
 * "side" (they are ear-level ambience, not a height).
 */
export function auditionGroupOf(speakerId, speakerTable = null) {
  const sp = speakerTable?.[speakerId] ?? null;
  if (!sp) return 'side';
  if (sp.lfe) return 'sub';
  if (sp.ring === 'ground') return 'side';
  if (sp.ring !== 'ear') return 'height';
  const az = Math.abs(sp.azimuthAdm);
  // Same thresholds as the speaker fan-out law in spatial-feeds.js: ≤ 70° front,
  // 70–130° side, > 130° rear — so a soloed group matches exactly what its speakers
  // carry.
  if (speakerId === 'C' || az <= 70) return 'front';
  if (az > 130) return 'rear';
  return 'side';
}
