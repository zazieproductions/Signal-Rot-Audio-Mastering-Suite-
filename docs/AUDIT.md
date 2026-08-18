# Signal Rot // Master — Repository & DSP Audit

**Audit date:** 2026-08-18
**Audited commit:** `5c0621e` (`Add files via upload`)
**Auditor role:** mastering engineer / DSP developer / web-platform engineer
**Scope:** every file in the repository at the audited commit.

The repository at the audited commit contained six files:

| File              | Lines | Role                                                                                   |
| ----------------- | ----- | -------------------------------------------------------------------------------------- |
| `index.html`      | 332   | Full application markup, tab shell, CDN encoder `<script>`                             |
| `app.js`          | 1709  | Entire engine: UI wiring, Web Audio graph, DSP, analysis, encoders, presets, immersive |
| `styles.css`      | 177   | Complete visual system                                                                 |
| `README.md`       | 47    | Overview                                                                               |
| `ARCHITECTURE.md` | 60    | Module-split proposal                                                                  |
| `package.json`    | 14    | Vite scaffold, no tests, no lint                                                       |

---

## 1. Current architecture (as found)

```
index.html ──(script type=module)──> app.js   [monolith]
           ──(link)────────────────> styles.css
           ──(script src=cdnjs)────> lamejs 1.2.1
```

`app.js` is a single top-level module that executes side effects at import time. There are
no exports, no imports, and no module boundaries. Responsibilities observed, in file order:

1. Tab switching (DOM, lines 3–9)
2. Utilities `$`, `clamp`, `dbToGain`, `toast`, `fmtTime` (14–19)
3. Global mutable parameter object `P` (21–46)
4. Global audio singletons `AC`, `srcBuffer`, `nodes`, `playing`, `abMode`, `analysis` (51–57)
5. Saturation curve generation (69–94)
6. `buildChain()` — 160-line Web Audio graph constructor returning a 40-key node bag (95–254)
7. `setChainParams()` — 84-line parameter push, contains all unit conversions (255–338)
8. Live graph + analyser construction (339–361)
9. Playback transport (418–434)
10. Canvas visualisers, all called from one `requestAnimationFrame` loop (438–585)
11. Offline render + BS.1770 loudness measurement (586–641)
12. True-peak limiter, FFT, spectral fingerprint, transient shaper (676–829)
13. WAV / AIFF / MP3 encoders and the download shim (846–929)
14. Export + batch orchestration (932–1011)
15. Preset catalogue: six arrays of literal objects (1013–1065)
16. `applyPreset()` — 50 lines of `if (q.x != null) P.x = q.x` (1066–1115)
17. `syncControls()` — 42 hand-written DOM writes (1134–1174)
18. Event binding, ~60 inline `$('#id').onclick = …` statements
19. Immersive module: speaker table, layouts, upmix, ADM XML/BWF writers, binaural
    preview, speaker map (1310–1700)

**Every one of the fifteen concerns the brief asks about is mixed into this one file.**
There is no state container, no validation, no test seam, and no way to exercise any DSP
function without a DOM and an `AudioContext`.

---

## 2. Showstopper: the application does not run

`index.html` loads:

```html
<link href="./src/styles.css" rel="stylesheet" />
<script src="./src/app.js" type="module"></script>
```

but `app.js` and `styles.css` are at the **repository root**, not in `src/`. Serving the
repo produces an unstyled page and a 404 on the engine. `README.md` and `ARCHITECTURE.md`
both describe the `src/` layout as if it existed. The repository as published is broken
and its documentation describes a state it is not in.

`index.html` also contains a duplicated `<!DOCTYPE html>` on lines 1–2.

---

## 3. Audio-correctness findings

Ordered by severity. Line numbers refer to the audited `app.js`.

### 3.1 Critical

**A. Saturation make-up gain is silently discarded in preview (L376–382).**
`setChainParams()` sets `outGain.gain = postMakeup`; `applyParamsToGraph()` then
unconditionally overwrites the same node with `trim * normG`. The offline render calls
`setChainParams()` alone, so **the export is up to 1.9 dB louder than the preview at
`sat = 100`** and the A/B is not level-matched. Two responsibilities are sharing one node.

**B. "Match loudness" does not match loudness (L369–375).**
When auditioning B the trim is forced to `1` and the normalisation gain is applied; when
auditioning A the trim is `proc − orig` and normalisation is _not_ applied. A therefore
lands at the processed programme loudness while B lands at the target loudness. The two
are equal only when the processed loudness already equals the target. The control does the
opposite of what its label promises on every non-trivial setting.

**C. Parallel ("New York") mix collapses the crossover regions (L165–175).**
This is the worst DSP defect in the codebase, and it is not obvious from reading the code.

The crossover itself is fine. The topology is parallel — `LP4(140)`, `HP4(140)→LP4(3200)`,
`HP4(3200)` — and although a three-way parallel LR4 split is not _guaranteed_ flat, at
these particular crossover frequencies the two crossovers are far enough apart (4.5
octaves) that the bands do sum flat in magnitude: measured worst-case deviation over
20 Hz–22 kHz is **−0.02 dB**. The band sum is fine.

The problem is what it sums _to_. An LR4 split reconstructs to an **all-pass**, not to
unity — the summed band signal has the same magnitude as the input but a frequency-
dependent phase, passing through 360° across each crossover. `mbDry` is a straight wire
with zero phase. Mixing an all-pass against its own dry signal is a comb filter.

Measured, dry+wet at the 50 % mix the UI advertises as "the audiophile move":

| Frequency               | Response     |
| ----------------------- | ------------ |
| 100 Hz                  | −7.4 dB      |
| **140 Hz (crossover)**  | **−30.3 dB** |
| 200 Hz                  | −5.7 dB      |
| 2 kHz                   | −3.8 dB      |
| **3.2 kHz (crossover)** | **−30.3 dB** |
| 5 kHz                   | −5.0 dB      |

Swept on a fine grid the null bottoms out at **−58.9 dB at 137 Hz**. Two complete nulls,
one straight through the kick/bass fundamental region and one through the presence band.
Anyone who reached for parallel compression in this tool got a destroyed master and no
indication why.

The fix — a serial split with the low band all-pass-compensated, and a dry path through
`AP2(140) · AP2(3200)` — reconstructs to **0.00000 dB at every mix position**.
Verified in `tests/dsp/multiband-crossover.test.js`, which asserts both the old failure
and the new result.

**D. Post-crossover band sum is all-pass, not linear-phase.**
Related to C but independent: even at 100 % wet, the multiband section imposes ~720° of
phase rotation across the audio band. That is normal and acceptable for an IIR multiband
compressor, and it is what every analogue-style multiband does — but it must be
compensated on any path that bypasses it, and nothing in the code does that.

**E. LRA is not EBU Tech 3342 (L629–637).**
Loudness range is computed from the _400 ms_ momentary-block distribution, gated at the
_integrated_ relative threshold (−10 LU). Tech 3342 requires **3 s short-term blocks with
1 s hop**, an absolute gate at −70 LUFS and a **relative gate at −20 LU**, then the 10th
and 95th percentiles. The reported figure is systematically too large (momentary blocks
have far more spread than short-term blocks) — typically 1.5–4 LU high on real programme.

**F. True-peak detection uses cubic interpolation (L573–582, L676–684, L700–708).**
Catmull–Rom is not a band-limited reconstruction filter. Against the BS.1770-4 Annex 2
requirement (≥4× oversampling with a specified FIR), cubic interpolation **under-reads**.
Measured on the classic worst case — a full-scale sine at `fs/4` sampled exactly at
±45°, so every sample sits at 0.7071:

```
sample peak  −3.010 dBFS
cubic 4×     −1.072 dBTP      <- what the tool reports
true peak     0.000 dBTP      <- what a compliant meter reports
```

**The limiter lets 1.07 dB of inter-sample overshoot through while displaying compliance.**
Set the ceiling to −0.1 dBTP and the delivered file can reach +0.97 dBTP after
reconstruction — audible clipping on any lossy encode.

**G. Limiter applies an instantaneous gain step (L727–743).**
`if (target < g) { g = target; }` — a discontinuous jump in the gain signal. The
"look-ahead" is a forward _minimum_, which anticipates _when_ to duck but not _how_ to get
there. A step in gain is a multiplication by a step function: broadband splatter on every
transient. This is the difference between an audible "click on the kick" and transparent
limiting.

**H. Normalisation target is not achieved (L830–844).**
`renderMaster()` measures LUFS, applies the gain, then limits. Limiting removes energy, so
the delivered integrated loudness is below target — by 0.1 dB on gentle material and by
1 dB or more on dense material at −9 LUFS. Nothing measures the result, and nothing tells
the user.

**I. Offline export is not reproducible.**
Hiss, crackle and rumble beds are filled with `Math.random()` inside `buildChain()`, which
the offline renderer calls fresh for every render (L184–213). Two exports of the same
project with the same settings are different files. For a mastering tool this is
disqualifying.

**J. Noise beds are perfectly correlated and loop every 2 s (L184–190).**
Each bed is a 2-second **mono** buffer on `loop = true`, connected to a stereo node —
Web Audio up-mixes mono by duplication, so the "tape hiss" is a dead-centre phantom rather
than a decorrelated stereo bed, and the same 2 seconds repeat for the whole programme.
On a 4-minute master that is 120 identical repetitions of the same crackle pattern.

### 3.2 High

**K. WAVE channel-mask bits are wrong for height channels (L1327–1330).**
`Rtf` is assigned `0x2000` (`SPEAKER_TOP_FRONT_CENTER`) and `Rtr` is assigned `0x10000`
(`SPEAKER_TOP_BACK_CENTER`). Correct values are `0x4000` (`TOP_FRONT_RIGHT`) and `0x20000`
(`TOP_BACK_RIGHT`). Any 7.1.2 or 7.1.4 file written by the tool declares a centre height
speaker where a right height speaker exists, and `getWavOrder()` sorts by these bits — so
the **channel order is also wrong**, not merely the label.

**L. K-weighting coefficients are approximations presented as BS.1770 (L600–620).**
The stage-1 shelf uses `f0 = 1500 Hz, G = +4 dB, Q = 0.707`; BS.1770-4 specifies the
filter whose 48 kHz coefficients are reproduced by `f0 = 1681.974 Hz, G = 3.99984 dB,
Q = 0.70718`. Stage 2 uses `38 Hz, Q = 0.5` against the specified `38.135 Hz,
Q = 0.50033`. The error is small (≈0.1–0.3 LU on broadband programme, more on
HF-dominated material) but the UI and README call it "BS.1770" without qualification.

**M. Channel weighting is missing.** `measureLUFS()` sums the mean squares of at most two
channels with unity weight (L622–627). Correct for stereo, silently wrong for any
multichannel buffer (surrounds require `G = 1.41`), and the immersive path has no loudness
measurement at all.

**N. Momentary/short-term meters are frame-rate dependent (L541–560).**
"Momentary" is the mean of the last 10 analyser frames and "short-term" the last 75. At
60 fps those are 167 ms and 1.25 s, not 400 ms and 3 s. On a 30 fps display they double.
The K-weighting for these meters is a `highshelf(1500, +4 dB)` → `highpass(38)` pair fed
by the **already-stereo-summed** post bus, so channel summation happens before weighting.

**O. Transient shaper cannot reduce transients.**
`g += atk * (tr / envF) * 0.9` with `atk` from −1…1 and a floor of `g ≥ 0.25` — but the
sustain term `sus * min(1, body*3) * 0.4` is driven by _absolute_ envelope level, so its
effect depends on how loud the file is rather than on its envelope shape. A −20 dBFS mix
and a −6 dBFS mix get different sustain processing from the same knob.

**P. `renderOffline()` forces two channels (L588).** Mono sources are up-mixed and exported
as dual-mono; the original channel count is never preserved and never reported.

**Q. Batch processing mutates the global `srcBuffer` (L985–1008)** and restores it in a
`finally`-less path. Any exception mid-queue leaves the application pointing at the wrong
buffer with a stale waveform cache.

**R. Batch LUFS analysis blocks the main thread (L975–977).** `measureLUFS()` on a
10-minute 96 kHz file is a few seconds of synchronous work per file, with a 5 ms yield
between files. The UI freezes.

### 3.3 Medium

**S. UI labels contradict the DSP.** `Warmth — low shelf 170 Hz` is a shelf at **120 Hz**.
`Body — peaking 700 Hz` is at **350 Hz**. `Harshness — peaking 3 kHz` is at **2800 Hz**.
`Clarity — presence shelf 5 kHz` is a **peaking** filter, not a shelf. `Air — high shelf
12 kHz` is correct. A mastering engineer reaching for 700 Hz mud and hitting 350 Hz will
not trust the tool again.

**T. Bass-mono is implemented as a high-pass on the side channel.** That is the correct
technique, but `bassHP.Q = 0.5` on a single biquad is a 12 dB/oct slope with a soft knee:
at the displayed "mono below 100 Hz" the side channel is still only −6 dB at 50 Hz. The
label over-promises.

**U. `phaseRot` is a single all-pass at a fixed 800 Hz** blended against the dry side.
Blending an all-pass with its own dry signal is a comb filter, not a phase rotation. The
creative result is fine; the name is wrong.

**V. Haas delay is applied to the full L or R bus**, after M/S recombination, so it delays
mid content too — that is a mono-compatibility hazard the correlation meter will show but
nothing warns about.

**W. No dither.** 16-bit and 24-bit integer exports are rounded with no dither, i.e.
correlated truncation distortion on fades and reverb tails.

**X. `renderImmersive()` limits the multichannel bed with `truePeakLimit()`, which is
stereo-linked across _all_ channels** including the LFE. A kick in the LFE therefore ducks
the height channels.

**Y. ADM `bext` loudness fields are left zero** (L1554–1556) even though the loudness data
exists. `axml` is written after `data`, which is legal but the EBU recommends `chna`
before `data` for streaming parsers.

**Z. Sonic Lab 20.4 uses non-standard speaker labels (`SL_01`…) inside an ADM
`typeDefinition="DirectSpeakers"` pack** with no documentation of the coordinate
convention. The venue table's `+azimuth = left` convention is stated in a code comment
only, and the four subwoofers are marked `lfe: true`, which makes the binaural fold-down
treat them as non-positional.

---

## 4. Unsupported claims found in the shipped copy

| Location                   | Claim                                                   | Reality                                            |
| -------------------------- | ------------------------------------------------------- | -------------------------------------------------- |
| `index.html` analysis hint | "computed by an offline gated (BS.1770) pass"           | Approximated K-weighting, non-standard LRA         |
| Loudness tab               | "4× oversampled inter-sample detection"                 | 4× **cubic** interpolation; under-reads by 1.07 dB |
| Dynamics tab               | parallel mix is "the audiophile move"                   | Two 30 dB notches at the crossovers (§3.1 C)       |
| Match tab                  | "fingerprint another master's tonal balance"            | 8 peaking bands from 24 frames                     |
| Character tab              | "modulates a real delay line … not decorative UI noise" | True, but described as tape modelling              |
| Spatial tab                | "crossfeed-based HRTF"                                  | Crossfeed is not HRTF                              |
| Immersive tab              | "writes a BS.2076-compliant bed"                        | Structurally close; never validated                |
| Immersive tab              | "imports into the Dolby Atmos Renderer"                 | Untested claim about third-party software          |
| `README.md`                | describes `src/` layout                                 | Does not exist                                     |
| Export tab                 | MP3 320 kbps listed with WAV                            | Requires a CDN fetch; fails offline                |

---

## 5. Performance risks

- `loop()` runs `requestAnimationFrame` unconditionally from boot, forever, even with no
  file loaded and playback stopped.
- **Six `Float32Array` allocations per frame** in `updateMeters()` + `drawGonio()`
  (2×2048 twice, 8192 once) ≈ 1.5 MB/s of garbage at 60 fps.
- `drawWaveOverview()` assigns `canvas.width` **every frame**, forcing a full backing-store
  reallocation and clear, then `g.scale(dpr,dpr)` on the fresh context.
- `truePeakBlock()` runs a 4× interpolation over 2048 samples × 2 channels per frame on the
  main thread (~16 k polynomial evaluations/frame).
- `drawSpeakerMap()` runs whenever a layout is selected, even when the Immersive tab is
  hidden.
- `measureLUFS()`, `spectrumFingerprint()`, `transientShape()` and `truePeakLimit()` are all
  synchronous main-thread passes over the entire file. A 10-minute 96 kHz stereo render is
  ~460 MB of Float32 plus several full-length copies.
- No guard on file size, duration or sample rate. A 192 kHz 30-minute import will allocate
  ~2.7 GB across the decode + render + limiter copies and take the tab down.
- `scheduleAnalyze()` fires a **full offline re-render of the entire file** 480 ms after
  _every slider move_, with no cancellation of the in-flight render.

## 6. Browser risks

- `webkitAudioContext` fallback exists, but `OfflineAudioContext` on Safari historically
  requires `webkitOfflineAudioContext(numberOfChannels, length, sampleRate)` and rejects
  sample rates outside 44.1–96 kHz — the 192 kHz export path will throw there.
- `AudioContext` is created on file import, not on a user gesture in all paths
  (`#refInput`, `#batchInput`), so autoplay policy can leave it suspended.
- `download()` wraps `a.click()` in `try/catch`, which cannot catch the failure modes that
  actually occur (blob too large, quota). The `FileReader` data-URL fallback will itself
  fail for anything over ~100 MB, and it is `readAsDataURL` on a blob that is already
  hundreds of megabytes.
- `URL.revokeObjectURL` after a fixed 2000 ms can cancel a slow download.
- `color-mix()` in CSS requires Safari 16.2+ / Chrome 111+; used without a fallback.
- No `prefers-reduced-motion`, no `prefers-contrast` handling.

## 7. Export risks

- `writeWAV` builds one `ArrayBuffer` of `44 + n·ch·bps` bytes and fills it with
  `DataView` calls **per sample** — for a 5-minute 24-bit 96 kHz stereo file that is
  173 M `setUint8` calls.
- No RIFF 4 GB guard. A 32-bit float 192 kHz stereo 20-minute render exceeds `0xFFFFFFFF`
  and writes a corrupt size field.
- AIFF `SSND` has no odd-byte pad; 24-bit mono with an odd frame count produces a chunk
  that is not word-aligned.
- MP3 encoding is one synchronous pass with all blocks retained in an array.
- Filenames are interpolated straight from `file.name` with no sanitisation.
- `renderBatch()` writes `it.name` into `innerHTML` → **stored XSS via filename**. A file
  named `<img src=x onerror=alert(1)>.wav` executes on drop.
- Preset import does `Object.assign(P, j.P || {})` with **no validation**: a hand-edited
  JSON can set `width: 1e9`, `ceiling: 40`, or inject arbitrary keys.

## 8. Immersive metadata risks

- Channel-mask bugs (§3.2 K) make 7.1.2 / 7.1.4 files mis-routed in every player that
  honours the mask.
- `Lrs`/`Rrs` carry `adm: 'M+135'` but `az: ±150`; the speaker map and the metadata
  disagree by 15°.
- The ADM declares `typeDefinition="DirectSpeakers"` for a synthesised up-mix. That is the
  correct type, but the surrounding copy implies object-based authoring.
- Sonic Lab's 24 channels are emitted as a `DirectSpeakers` pack with invented speaker
  labels; no renderer will know what `SL_07` is without the accompanying map, which the
  tool does not export.
- No validation of the produced file exists anywhere in the codebase.

## 9. Accessibility issues

- Tabs are `<div class="tab">` with no `role="tab"`, no `aria-selected`, no keyboard
  handling, and no focus ring — the entire navigation is mouse-only.
- Toggles are `<span class="tog">` with a click handler: no `role="switch"`,
  no `aria-checked`, not focusable.
- Range inputs have visible `<label>` text but no `for`/`id` association and no
  `aria-valuetext`, so a screen reader announces "slider, 35" with no unit.
- Meters update text silently with no `aria-live`.
- The toast is the only error channel and is `pointer-events:none` with no `role="status"`.
- Icon-only buttons (`▶`, `■`, `◐`) have `title` but no accessible name in Firefox.
- No focus-visible styling anywhere; `outline:none` on `select`.
- `keydown` handler swallows `Space` globally, breaking button activation.

## 10. Highest-impact priorities

1. **Make it run.** Fix the entry points and establish a real module graph.
2. **Make the DSP testable.** Extract every numeric routine into a pure function over
   `{sampleRate, channels: Float32Array[]}` so it can be tested in Node.
3. **Fix the measurement chain** (K-weighting, gating, LRA, true peak) — everything
   downstream trusts these numbers.
4. **Fix the limiter** (band-limited detection + smoothed gain) and **verify the result**
   after render.
5. **Fix the crossover** (serial topology + all-pass-compensated dry path).
6. **Make export deterministic** (seeded noise) and **honest** (render report, dither).
7. **Fix the channel masks** before anyone delivers a 7.1.4 file from this tool.
8. **Validate all imported data** (preset JSON, filenames) and remove the `innerHTML` sink.
9. **Rewrite every claim** in the UI and README to match the implementation.
10. **Accessibility + performance passes** on the shell.

---

## 11. What is genuinely good and must be preserved

This audit is unsparing because the brief asks for it. The following are real strengths and
the refactor is required not to lose them:

- The **M/S matrix built from native nodes** is correct, elegant, and works everywhere
  without an `AudioWorklet` — including inside sandboxed iframes. That constraint is
  respected throughout and it is the right call for a tool meant to be opened from a URL.
- The **saturation curve** is thoughtfully designed: bias-free asymmetry, DC removal,
  peak normalisation so drive does not become level. Most browser saturators do not do this.
- The **per-band stereo width** operating on the side channel only, before the master width
  control, is exactly how it should be done.
- The **Sonic Lab 20.4 layout** is a real venue (Anton Bruckner Privatuniversität, Linz)
  with a real, unusual periphonic speaker table. It is the most distinctive thing here.
- The **preset catalogue** is opinionated and coherent; the descriptions are the work of
  someone who has actually listened.
- The **dark laboratory aesthetic** is restrained and legible, with the orange/cyan
  processed/original convention carried consistently through every visualiser.
