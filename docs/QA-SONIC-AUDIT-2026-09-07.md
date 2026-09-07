# Signal Rot — sonic QA audit, 2026-09-07

Judgement by measurement at matched loudness, from `qa/` (render-and-measure rig; `qa/README.md`).
This is not a listening report: **no human audition has taken place**, and nothing below claims to have
heard anything. It is a rigorous objective pass over real renders, with the parts that need ears
labelled.

## BUILD TESTED

`17b77c7bcb956f4146e9b8cdc81a78d5799a5fd9` (main, v7.0.0) on session branch
`arena/01a07d08-signal-rot-audio-mastering-sui`.

- `npx vitest run` → **39 files, 1063 tests, all green**, 233 s.
- `npm run lab:conformance` → **cannot run here**: needs a Playwright browser, and this sandbox can
  neither download Chromium (CDN blocked) nor apt-get libs. So no real-browser number in this report.
  One finding is cross-checked against the Chromium measurement already recorded in
  `docs/FINDINGS-FOR-AGENT-A.md` (`A-6`), which agrees with mine to 0.04 dB.
- Renders driven through the production path (`renderMaster` → real `OfflineAudioContext` graph →
  transient shaping → iterated normalise/limit → dither → `writeWav`), measured with independent
  meters in `qa/scripts/measure.py`.
- Material: 23 fixtures (10 musical incl. mono, extremely wide, already-mastered, bright, dark,
  transient-heavy; 13 deterministic), 72 presets × 2 materials (144 renders), 88 stress renders
  (loudness targets −18…−8, GR ladder, saturation ladder, HF accumulation, width/M-S/crossfeed/Haas/
  phase-rot/depth, transient shaper, multiband mix+amount ladders, 6 sample rates, 16/24/32-bit,
  determinism), plus module-attribution, section-isolation, immersive-bed and mono sets. ~400 renders.

## BEST RESULTS — what is genuinely good

These are not green-test platitudes; they are measured outcomes.

1. **Loudness is hit, not faked.** Median |Δ| 0.00 LU over 144 preset renders, p90 0.22 LU, and the
   meter agrees with an independent BS.1770-4 implementation to ≤0.1 LU everywhere.
2. **It refuses to brickwall.** 12/144 renders capped by the crest-aware budget, 13 by the ambition
   guard, **0/144 delivered a sample above full scale**. Ask the pristine flagship for −8 LUFS on
   dynamic acoustic and it hands back −12.9 with a warning explaining why. That is the correct
   professional answer and it is rare in this category of tool.
3. **Source-awareness is real and directionally musical**, not decorative: `air +12 → +0.5 dB (source
already bright)`, `tilt +6 → 0 dB`, `input drive 4 → 0 dB (already at mastering loudness)`,
   `mbLow 12 → 5` on a pre-mastered file, `mono-below 0 → 90 Hz` on bass-heavy. Bright material gets
   _less_ HF, exactly the restraint the brief demands.
4. **On an already-squashed mix it gave dynamics back**: `already-mastered.wav` crest 10.2 → 13.8 dB
   at exactly −15.0 LUFS with 0 dB of limiter action. Re-opening a crushed master without adding
   distortion is the single nicest result in the whole matrix.
5. **The assembled graph at defaults is near-transparent on stereo material**: +0.02 dB level, sweep
   flat to ±0.16 dB (30 Hz–12 kHz), DC ≤0.001, no NaN anywhere in ~400 renders. Bypass is implemented
   as parameter-neutralisation and `moduleBypass` really does neutralise (defaults-with-bypass differs
   from defaults by 0.01 dB).
6. **Dither and bit depth behave**: −48 dBFS tone at 16 bits shows a −15 dB quantisation spur undithered,
   −47 dB with TPDF, noise tilted up at Nyquist in `shaped`; 32-bit float correctly refuses dither.
7. **Determinism holds**: same project + seed → byte-identical files, including the dithered path.
8. **The immersive bed is sane**: fronts are the stereo pair untouched (corr +1.000 at 0 samples), LFE
   is low-passed with no top-end leak, all 6 heights are decorrelated (0/15 bit-identical pairs) and
   symmetric, bed total +0.4 LU over the stereo master. It does not look like a phasey delay hack.
9. **The engineering culture is auditable**: the report states what it did, the docs name their own
   deviations ("this is not a certified true-peak meter"), and the preset catalogue carries per-preset
   audit notes. It made this audit far faster, and it is why the crossover defect could be pinned to a
   unit error rather than hand-waved.

## ISSUES FOUND

| #                                                                      | Sev                         | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [SON-3](../qa/findings/SON-3-lr4-crossover-q-unit-error.md)            | **BLOCKER**                 | `Q = 0.7071` on a `lowpass`/`highpass` node is **+0.71 dB of resonance**, not a Butterworth section — Web Audio takes `Q` in **dB** for those two types. Every "LR4" leg is therefore mis-aligned, the crossover sums land **+7.4 dB** at each corner instead of 0 dB, and the all-pass compensation legs are tuned for a filter that is not in the graph. Same bug explains `A-6`, the flagship's tonal tilt, the non-unity "bypassed" stereo section, and the sample-rate inconsistency. `designBiquad` uses linear Q, so every Node-side crossover test validates a filter the browser never builds. |
| [SON-1](../qa/findings/SON-1-mono-source-returns-phase-corrupted.md)   | **HIGH**                    | A **mono** input exports as a decorrelated, mid-starved stereo file: correlation +1.000 → −0.71, mono fold-down −11.5 dB, and +5.45 dB of level error even with normalisation off. Triggered without the user asking, because the source-aware layer turns `bassMono` on for mono files, which makes `requiresStereo` true, and the M/S matrix then reads a 1-channel signal through a `ChannelSplitterNode`. The preset named `Broadcast Mono First` is the worst case (−0.82 / −12.1 dB).                                                                                                             |
| [SON-2](../qa/findings/SON-2-true-peak-ceiling-not-delivered.md)       | **HIGH**                    | 61/144 preset renders (median +0.26 dB, worst +0.94 dB) exceed the ceiling they claim to have respected; `correctionTrimDb: 0`, `ceilingRespected: true`. The verify pass measures with the same short-tap filter it is checking itself against — self-verification that cannot see its own bias. Measured with an exact reconstruction that reads 0.00 dB on the fs/4 worst case.                                                                                                                                                                                                                      |
| [SON-4](../qa/findings/SON-4-flagship-multiband-not-transparent.md)    | **HIGH** (symptom of SON-3) | `Reference HD` — documented as "no EQ moves, on a great mix it does almost nothing" — moves octave bands by **+5 to +7 dB** at matched loudness (sub +5.1, low +6.9, lowmid −5.1, presence +5.8), _and_ engages the crest-collapse trade below. The tell: `MIX-75` and `MIX-100` are identical, and the tilt is the same at band amount 12 and 100. That is not compression.                                                                                                                                                                                                                            |
| [SON-5](../qa/findings/SON-5-bypassed-chain-is-not-transparent.md)     | **MED**                     | With all seven modules bypassed an impulse arrives **14.7 ms late, 5.1 dB low, 28 % of its energy in a tail**; a sweep gains +2.0 dBTP with no spectral change. Part is SON-3, part is two fixed 6 ms delays (multiband alignment + tape transport) that no report field mentions, so exports are not sample-aligned with their source and the offset changes with settings.                                                                                                                                                                                                                            |
| [SON-6](../qa/findings/SON-6-unreachable-target-picks-loudest-pass.md) | **MED**                     | When a target is unreachable the refinement loop optimises                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Δ   | , so it buys **+0.5 LU** with **6 dB more peak GR** and 0.3 dB more attack loss instead of staying clean, and the average-GR budget (3 dB) never notices because the damage is all in the peaks. |
| small                                                                  | **LOW**                     | An unrecognised enum value is silently replaced with the default and **not** warned about (`dither: "off"` → `tpdf`, byte-identical to the dithered render), while out-of-range _numbers_ are warned. For a tool whose sell is an accountable report, an ignored field should say so.                                                                                                                                                                                                                                                                                                                   |
| small                                                                  | **LOW**                     | `mbAutoMakeup` changes every render by ≤0.1 dB — at the flagship's ratio it computes 0.58 dB, so the control is cosmetic in the exact situation it exists for.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| not a bug                                                              | —                           | 9.1.6 / Sonic Lab get `mask 0x0, standard: false` (no WAVE speaker mask exists for those orders) and ship a channel map alongside; correct behaviour, just worth knowing for receivers. `A-8`'s "no routing defect" conclusion holds in my renders too.                                                                                                                                                                                                                                                                                                                                                 |

## GITHUB ACTIONS

At the time of the audit run the sandbox's GitHub token was rejected (`gh auth status`: _the github.com
token in GH_TOKEN is no longer valid_, HTTP 401 on the API; `git push` also failed to authenticate), so
every finding was written as a ready-to-post body in `qa/findings/`, in the SONIC ISSUE / MATERIAL /
SETTINGS / REPRO / MEASUREMENTS / EXPECTED / ACTUAL / SEVERITY format. Six issues, not twenty: SON-4 is
recorded explicitly as a symptom of SON-3 rather than a separate defect.

**Update (2026-09-07, same day): the connection was repaired and all six were filed** —
[SON-3 → #19](https://github.com/zazieproductions/Signal-Rot-Audio-Mastering-Suite-/issues/19) (the root
cause; it also explains the open `A-6` / #12 wet-sum violation, which should close with it),
[SON-1 → #20](https://github.com/zazieproductions/Signal-Rot-Audio-Mastering-Suite-/issues/20),
[SON-2 → #21](https://github.com/zazieproductions/Signal-Rot-Audio-Mastering-Suite-/issues/21),
[SON-4 → #22](https://github.com/zazieproductions/Signal-Rot-Audio-Mastering-Suite-/issues/22),
[SON-5 → #23](https://github.com/zazieproductions/Signal-Rot-Audio-Mastering-Suite-/issues/23),
[SON-6 → #24](https://github.com/zazieproductions/Signal-Rot-Audio-Mastering-Suite-/issues/24).
The `qa/findings/` bodies remain the source of record; the GitHub App token in this sandbox can create
issues but not comment on or edit existing ones, so the SON-3 ↔ #12 cross-reference is documented here
rather than in the tracker.

## REGRESSIONS

None: this is the first commit I have measured, so there is no older build to be worse than. The
numbers in `qa/goldens/README.md` are the tripwire from here.

## VERDICT — **HOLD**

Do not ship this as a mastering release yet.

At matched loudness I would not yet choose the Signal Rot master over the input on clean material: the
flagship re-EQs the record by 5–7 dB and spends crest factor doing it, because the crossover sections
are resonant rather than flat (SON-3). The loudness discipline, source-awareness, restraint, dither,
determinism and the immersive bed are genuinely good and should be protected as baselines.

Fix order: **SON-3** (one unit conversion; it likely closes SON-4 and most of SON-5's smear), then
**SON-1**, then **SON-2**. Re-run the whole `qa/` matrix after SON-3 rather than patching presets —
any preset tuned to compensate for the resonant crossover will have to be retuned again afterwards.

### Scorecard (1–10, this build, measured)

transparency 4 · tonal balance 4 · transient integrity 6 · low-end control 6 · treble smoothness 4 ·
depth 6 · stereo image 3 · dynamics 7 · loudness quality 7 · fatigue resistance 4 · translation 4 ·
immersive coherence 7

The weaknesses are not spread evenly: transparency, tonal balance, treble smoothness, image,
fatigue and translation all trace back to SON-3 + SON-1, and loudness quality/dynamics/restraint are
the strongest part of the product.

## NEXT TEST (highest leverage)

Re-measure the crossover in **Chrome** against `qa/jobs-mbproof.json` (parallel-mix ladder + amount
ladder + `imp-anti`/`imp-mid` isolation) before and after the Q fix, and gate it on the _wet path_ of
both the multiband and the stereo section. If the +7.4 dB at 140 Hz/250 Hz/3.2 kHz/4 kHz collapses to
±0.1 dB, SON-3/4/5 close together and the flagship's matched-loudness tilt should vanish with them; if
it does not, my engine, not the project, owns the error and this whole report must be re-based.

After that: the 2–5 kHz glare, the 8–16 kHz fizz, the pumping at 4–6 dB of GR and the mono collapse
are exactly the things a scope cannot settle — those four need a human on a known converter, at
matched level, with the A/B files this rig can produce on request.
