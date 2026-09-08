# Product Experience — Signal Rot // MASTER

**Audience:** users, designers, contributors working on interface and product surface. For DSP, see `DSP-SIGNAL-FLOW.md` and `LIMITATIONS.md`. For format truth, see `IMMERSIVE-AUDIO.md`.

---

## Identity

Signal Rot is an **experimental mastering laboratory** + **high-end spatial audio workstation** + **creative instrument**.

Not a SaaS page with sliders. The interface is:

- **Restrained dark technical surfaces**, precise mono typography, subtle texture — credible next to professional tools.
- **Information-dense but organized** — hierarchy over density, perceptual language over DSP jargon.
- **Honest** — synthetic height is never called recovered; ADM BWF `DirectSpeakers` is never called Atmos.

Design tokens live in `src/styles/tokens.css`. Two product modes share the same engine state.

---

## Two Product Modes

### MASTER (default — `L` toggles Master ⇄ Spatial Lab)
For conventional mastering. Emphasizes **source → tonal → dynamics → stereo → loudness → listen → export**.
- Calm, reference-focused palette (warm accent).
- Mastering status strip (integrated, true peak, LRA, crest, limiter) answers “is this deliverable?”
- Sonic summary translates real parameters into human lines — no AI claims.

### SPATIAL LAB (`L` toggles back)
For immersive / experimental spatial. Emphasizes **room → speakers → depth → height → motion → energy → binaural → bed export**.
- Technical, periphonic palette (cyan accent).
- Speaker field is the signature: top-down plan + elevation side view, both derived from `audio/immersive/layouts.js` so the map cannot disagree with the channel map.
- Same source + chain; only the monitoring and export layout change.

Both modes persist in `store.ui.workspace` and `body[data-workspace]`. All tabs remain accessible — mode only **highlights** relevant ones.

---

## Mastering Workflow Hierarchy

The Master workspace answers visually, top to bottom:

1. **What did I load?** — Source hero (`source-analysis.js`): duration, rate, channels, integrated, true peak, crest, correlation, spectral hint, and a truthful adaptive note (“Bright source — HF boost reduced” when tilt is active).
2. **What preset/profile?** — Preset browser (search, category, favorites, intensity) with 68 presets in 7 families.
3. **What is the engine doing?** — Signal flow (bypass per stage) + sonic summary + macro strip.
4. **What does it sound like vs original?** — A/B strip (see below).
5. **Is anything wrong?** — Warnings hierarchy: `info` (height is synthesized), `notice` (budget limited), `warning` (mono risk), `blocker` (memory estimate). Never all red.
6. **What am I exporting?** — Export summary card + immersive honesty callout.

Structure:
```
SOURCE (hero + waveform)
  → MASTER PROFILE (preset browser)
  → TONAL / DYNAMICS / SPACE (macros + advanced)
  → LOUDNESS / OUTPUT (mastering status + crest budget)
  → LISTEN / COMPARE (A/B, match, blind)
  → EXPORT (summary, ADM honesty, channel map)
```

---

## Perceptual Macro Controls

Seven safe macros map onto existing parameter combinations (no new DSP). Implementation: `src/ui/macro-controls.js`.

| Macro | Maps to |
|-------|---------|
| **BODY** | warm 120 Hz, body 350 Hz, sub 55 Hz, feathered tilt |
| **CLARITY** | clarity 5 kHz, harsh 2.8 kHz (inverse) |
| **PUNCH** | mbLow/mid/high, parallel mix, transient attack/sustain |
| **AIR** | air 12 kHz + tilt |
| **WIDTH** | width + widthLow/Mid/High + bassMono anchor |
| **DEPTH** | depth, depthSize, spread |
| **CHARACTER** | tape, saturation, hiss, vinyl |

- Fine-adjust: `Shift` + drag, `Shift` + wheel.
- Double-click resets to definition.
- **Advanced ▾** reveals underlying values — same engine, clearer language. No patronizing “beginner vs pro”.

---

## A/B Listening — Central

Transport shows **Original / Mastered** segmented pill; the enhanced strip `ab-enhanced.js` adds:

- **Original (A)**, **Mastered (B)**, **Matched (C)** — the master level-matched to the source — and a **Blind A/C** toggle.
- **Match loudness** (chip/button, no key) — legacy level-matched A/B; `C` is the dedicated matched audition and the honest comparison.
- **Dim (−12 dB)** for late-night checks.
- Keyboard: `A` / `B` / `C` (select), `X` (cycle, blind-safe), `H` (blind), `M` (mono monitor), `S` (side monitor), `Space` (play/pause). Blind mode hides which is which and always alternates the two *different* signals (A vs C); labels show “◈ Blind 1/2”. All keys bind once, in `initShortcuts` — no per-module window listeners (duplicate bindings used to double-fire A/B/C/X/M).

Active state is unmistakable: active pill gets colored border + tinted background (cyan for A, orange for B). Level-matched mastered buttons do not look “louder-better”.

---

## Loudness / Dynamics Visualization

Mastering status strip (`master-status.js`): 5 cards + budget note.

- **Integrated LUFS** — gated offline pass. Bar maps −40…0. Color: safe / near / budget-limited (amber when delivered < target −0.6 LU).
- **True peak** — polyphase estimate vs `ceiling`. Warns when within 0.2 dB.
- **LRA** — EBU Tech 3342.
- **Crest** — peak − LUFS. `<6 dB` → “limited — transients tight” (warn), `<9 dB` → moderate.
- **Limiter** — worst band GR via `readGainReduction()`.

Budget note is honest:
> “Clean loudness limit reached. Requested −9 LUFS · Delivered −12.4 LUFS — the engine protected the master from over-limiting.”

This is not framed as failure.

---

## Sonic Change Summary

`sounds/summary.js` derives four groups from real params:

- **TONAL** — sub/warm/body/harsh/clarity/air/tilt/drive/sat → “slight upper-mid clarity — reduced harshness”
- **DYNAMICS** — mb amounts → “gentle low-band control — transients preserved”
- **STEREO** — width/ms/bassMono/haas/crossfeed/depth → “moderately widened — low anchored”
- **LOUDNESS** — integrated/target/ceiling/LRA → “−12.8 LUFS · −1.0 dBTP”

Every line traces to a parameter key. Coverage hint shows filter frequencies: `sub 55 · warm 120 · body 350 · harsh 2.8k · clarity 5k · air 12k · tilt 1k`.

---

## Spatial Lab — Speaker Visualization

Signature interface (`speaker-map.js` + `elevation-view.js` + `spatial-lab.js`).

- **Plan view** (top-down): listener faces ▲. Outer ring bed (orange), inner height ring (cyan), sub squares. Radius ~38% of canvas. Solos get white halo + larger dot.
- **Elevation view**: side projection, y maps elevation 0…60°, x maps azimuth. Shows why height feels “above” vs “around”.
- Both read `azimuthHrtf` (positive = right) for screen, ADM azimuth (positive = left) for labels — conventions never conflated.
- **Interaction:** click speaker → highlight on the map; `Shift`-click → multi; group strip **Front/Centre/Surround/Rear/Height/Sub** → highlight group; **Clear highlight** resets. Highlighting is display-only: there is no audible per-speaker audition yet and exports are never touched — the hint states both.

Canvas approach (no heavy 3D lib), pooled scratch arrays, stops when hidden, honors `prefers-reduced-motion`.

---

## Spatial Energy & Warnings

`spatial-energy.js` estimates front/rear/height/sub from side/mid energy × immersive gains. Bars + `Front 54%, Rear 28%, Height 18%` accessible label.

Warnings are metric-backed:
- `Height >38%` → “Height field dominates.”
- `Rear >36%` → “Rear unusual.”
- `Centre extraction >0.78` → “Centre locked.”
- `bassMono 0 + width>1.35` → “Low coherence reduced.”

All use real levels; no disco.

---

## Spatial Macro Controls & Motion

**Spatial macros** are the same macro strip but focused: **SPACE, DEPTH, ENVELOPMENT, HEIGHT, FRONT FOCUS, MOTION** map to `depth`, `spread`, `heightLevelDb`, `frontRear`, etc. Advanced reveals `centre extraction`, `surround level/delay`, `decorrelation`, `LFE crossover/level`.

**Motion** (`motion-viz.js`): 6 trajectories — `STATIC`, `ORBIT`, `FRONT→REAR`, `RISE`, `FALL`, `BREATHING FIELD`. A 88 px canvas previews the trajectory (orbit = ellipse, rise/fall = vertical sweep). If `prefers-reduced-motion`, the preview freezes at 25% progress and shows position without animation. Motion is **monitoring visualization** unless rendering a motion-aware layout — never fake movement.

---

## Listener Orientation

`spatial-lab.js` dial:

- Yaw −180…180°, draggable dial (`--yaw` CSS var rotates the needle), arrow keys ±15°, `Home` → 0°.
- Presets: **FRONT (0°) · LEFT (90°) · RIGHT (−90°) · REAR (180°) · RESET**.
- Dial is `role="slider"` with `aria-valuenow`, keyboard operable (`←/→` 15° steps, `Home` reset), hint shows “0° — facing front.” It rotates the map *view* (`ui.listenerYaw`, shared by both speaker maps); the rendered bed is listener-independent, and the copy says so.
- State persists as `store.ui.listenerYaw` (adapter boundary for future HRTF yaw). Never called “head tracking” unless `EXPERIMENTAL HEAD TRACKING: OFF / PERMISSION REQUIRED / ACTIVE / UNAVAILABLE` is wired.

---

## Preset Browser & Taxonomy

- **7 families:** Dimension (signature engines), Genre/character (one-tap masters), Cinematic/scoring, Mood, Colour, Spatial, Restoration/corrective. Each has distinct visual treatment.
- **Taxonomy:** `REFERENCE HD` (transparent) is visually distinct from `NOISE WALL APOCALYPSE` (destructive) via risk badges (`safe`/`caution`/`destructive`) and audit note.
- **Browser:** search (name/desc/tag), category pills (All, ★ Favorites, Dimension, Genre…), favorites (`localStorage` `signal-rot:favorites`), intensity tag (`transparent`/`gentle`/`moderate`/`intense` + `X LUFS`), description + `risk` icon on card. Example:
> **CATHEDRAL** — Tall, diffuse vertical space with restrained centre wash. `spatial · gentle · −15 LUFS`

Presets are creative starting points, not fixes.

---

## Source Analysis, Waveform, Spectrum, M/S

- **Source hero** replaces “drop audio” after load, with stats grid and “What happens next” callout.
- **Waveform** (`waveform.js`): peak envelope cached per width × token, playhead, loop region (drag), click-to-seek. Honors multiresolution API if Agent D exposes it (adapter boundary).
- **Spectrum** (`spectrum.js`): smoothed, 20 Hz…22 kHz log, toggles for source/mastered/reference.
- **M/S / Stereo:** correlation, width, mid/side energy, bass coherence. Vectorscope is correctly scaled mid = (L+R)/2, side = (L−R)/2, not decorative.

All visualizers stop when hidden (`document.hidden` + `requestAnimationFrame` gating) and avoid triggering renders.

---

## Processing Module Cards & Bypass

Each stage shows: **NAME**, **ACTIVE/BYPASSED**, **purpose**, **current values**, **subtle/moderate/extreme** intensity.

Example:
```
MULTIBAND — gentle dynamic control
LOW 18% · MID 12% · HIGH 8% — inactive bypassed shows dashed + 0.55 opacity.
```

Advanced reveals 12 knobs at equal weight; summary shows 3. Bypass is obvious: dashed border, line-through name, desaturated dot — not just color.

---

## Warnings Without Panic

Hierarchy: `INFO` (blue, “Height is synthesized”), `NOTICE` (cyan, “Budget reached”), `WARNING` (amber, “High side energy”), `BLOCKER` (red, “Estimated render exceeds safe memory”).

Heavy project warning (when Agent D provides estimate):
> **SONIC LAB 20.4 · 192 kHz · 28 min** — Estimated peak ~2.8 GB. May exceed browser limits. Choices: 96 kHz / shorter region / continue anyway (if safe).

---

## Immersive Honesty

Never:
- “recovered height”
- “Dolby Atmos master”
- “personalized spatial audio”

Always:
- **Immersive bed**, **synthesized height**, **binaural monitor**, **ADM BWF interchange**, **DirectSpeakers**.

Export notice states it verbatim.

---

## Export Experience

Agent C owns writers; we own presentation (`export-summary.js`, `immersive-controller.js`).

- **Quick export** grid (24-bit, 16-bit CD, 32-bit float, MP3).
- **Format & rate** selects (probed: unsupported rates disabled).
- **Dither** (none/TPDF/shaped — never on 32-bit float).
- **Immersive:** layout (6…24 ch), channel count, channel-map status, ADM status, delivery package contents. Non-standard mask (9.1.6, Sonic Lab) shows amber badge: “This layout has no standard mask — deliver the channel map.”

**Summary before export:**
```
7.1.4 IMMERSIVE BED
12 channels · 48 kHz · 24-bit · ADM BWF DirectSpeakers
Integrated: −15.2 LUFS · True peak: −1.0 dBTP
Includes: ✓ channel map · ✓ render report · ✓ manifest
Synthetic height channels — Not an Atmos-certified master
```

---

## Runtime / Job UI

Consumes Agent D’s progress APIs. Tasteful feedback for every stage:

`ANALYSING → MASTERING → SPATIAL RENDER → LIMITING → ENCODING → VALIDATING → WRITING`

Progress bar + `progtext`, cancel where supported, queue if relevant. Distinguishes genuine cancellation from “Finishing current browser render…” when the operation cannot be interrupted.

---

## Responsive & Keyboard

- **Desktop/laptop primary** — spatial needs space. Tablet workable; phone not a mastering target but never broken.
- Breakpoints: `980 px` scopes stack, `760 px` header wraps, `520 px` grids collapse, `pointer: coarse` enlarges thumbs to 24 px.
- Shortcuts (one owner, `initShortcuts`): `Space` play/pause, `A`/`B`/`C` audition select, `X` cycle audition, `H` blind, `M` mono monitor, `S` side monitor, `L` toggle Master ⇄ Spatial Lab, `⌘K`/`Ctrl+K` palette, `⌘Z`/`⇧⌘Z` undo/redo, `Esc` close palette, arrows navigate tabs (WAI-ARIA pattern), `←/→` dial yaw.

All hints appear in tooltips/menus.

---

## Accessibility

- Skip link first focusable element.
- Every slider has `label[for]` + `aria-valuetext` (“Warmth, 1.6 dB”).
- Toggles are `role="switch"` with `aria-checked`.
- Focus rings via `--focus` token (2px bg, 4px accent).
- Contrast follows palette + `prefers-contrast: more`.
- `prefers-reduced-motion` disables animation across tokens.
- Live region `aria-live="polite"` for toasts and preset applied announcements.
- Canvas maps expose text: “Front 54%, rear 28%, height 18%.”

---

## Technical Explanations

Small `?` or `info-tip` (16 px circle) beside concepts: LUFS, true peak, crest, centre extraction, decorrelation, ADM, DirectSpeakers, binaural, height synthesis.

Plain English first:
> **Decorrelation** — Reduces similarity between speaker feeds so ambience surrounds the listener instead of sounding like duplicated stereo. (Technical: all-pass phase randomization per height feed.)

---

## Change Feedback & Safe Interactions

- Diff from preset baseline: macro cards get `active` border when >3 steps from def; module cards can show `modified`/`bypassed`.
- `Reset module` / `Reset preset` actions.
- Sliders: `Shift` for fine (step/10), double-click reset, arrow keys, numeric readout with units, clear min/max.

---

## Visualizer Performance

- Stop when hidden (`#scopesRow.hidden`, `document.visibilitychange`).
- Honor `prefers-reduced-motion`.
- Pooled `getScratch()` arrays — no per-frame allocation.
- Use cached analysis (`computePeaks` per width×token).
- Never trigger mastering renders from drawing.

---

## Documentation & Portfolio

- This file, plus `IMMERSIVE-AUDIO.md`, `LIMITATIONS.md`, `ARCHITECTURE.md`.
- README hero shows: browser-native, deterministic, BS.1770-4 gated, true-peak verified, 7.1.4/9.1.6/20.4, binaural, channel beds, extensive tests, honest limits.
- Screenshots (real app state): Master workspace, loudness-matched A/B, Spatial Lab 7.1.4, Sonic Lab 20.4, export/delivery view — kept under 1 MB total.

No claims: no “AI mastering”, no “Dolby Atmos certified”, no “revolutionary next-gen”.

---

## Integration Boundaries (Agents A/C/D)

- **A (DSP):** perceptual macros map via adapter to safe param combos; if A exposes new `listenerYaw`/`motion` API, `spatial-lab.js` forwards it, otherwise degraded ( dial still rotates map, energy bars still tick).
- **C (formats):** export summary consumes `export-controller`/`immersive-controller` APIs; writers themselves are not touched.
- **D (runtime):** progress, memory estimates, waveform multiresolution are consumed via existing client (`analysis-client.js`); worker files not modified.

Mark integration points with comment `// adapter boundary` where appropriate.

---

## Remaining Degradation

- Speaker highlight is map-only: there is no per-speaker audition (monitor or export) yet; the UI says so instead of calling it “solo”.
- Motion trajectory is visualization only — no renderer consumes `motionMode`, every export is a static bed, and the copy says exactly that.
- 20.4 channel map needs manual delivery — no auto-zip bundle yet (Agent C).

All degraded states fail gracefully with an info notice rather than a blocker.
