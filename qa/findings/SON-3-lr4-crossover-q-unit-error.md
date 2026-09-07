## SON-3 — `Q = 0.7071` is not a Butterworth section in Web Audio: every "LR4" in the graph resonates, and the crossover sums land +7.4 dB high

**This is the root cause of the flagship preset's tonal tilt (SON-4), the side-channel colouration, and the
sample-rate inconsistency — and it is the already-open `A-6` finding in `docs/FINDINGS-FOR-AGENT-A.md`,
which records _that_ Chromium disagrees but not _why_. This is the why, plus two more affected sites that
A-6 does not cover.**

**SONIC ISSUE**
Every "Linkwitz-Riley 4th-order" section in the DSP is built as `two cascaded biquads with
Q = Math.SQRT1_2`. A 2nd-order Butterworth section needs a **linear** Q of 0.7071, but
`BiquadFilterNode` interprets `Q` **in dB** for `lowpass`/`highpass`. A value of 0.7071 dB is
`10^(0.7071/20) = 1.0815` linear — a section that _peaks_ +0.71 dB at its corner instead of sitting
−3.01 dB there. So:

- each section is +0.71 dB resonant → each LR4 leg is **+1.41 dB** at its corner;
- the LP and HP legs of a crossover are both high at the same place and add in phase → **the
  "complementary" sum is +7.4 dB at the crossover frequency**, not 0 dB;
- the all-pass compensation legs are `allpass`, where `Q` _is_ linear, so they are built for the
  correct (flat) LR4 and no longer cancel anything — they add phase error instead.

Audibly: a "crossover" that is really a pair of tuned bumps. On the multiband it shows as a fixed
EQ tilt (bass and treble up, the band between them down) that does **not** scale with the amount
control, because it is filtering, not dynamics. On the stereo section it shows as a +7.4 dB bump on
the **side channel only** at 250 Hz and 4 kHz, i.e. low-mid mud and 4 kHz glare that appear on
every master and get worse the wider the source already is.

**MATERIAL**
Deterministic, no music required.

**SETTINGS**
Nothing. Schema defaults, no preset.

**REPRO — the decisive experiment** (10 lines, no repo code needed)

    // one 2nd-order lowpass, fc = 1000, measured AT fc
    Q.value =  0.7071  →  +0.71 dB   // <-- what the project uses
    Q.value =  1.0      →  +1.00 dB
    Q.value = -3.0103  →  -3.01 dB   // <-- what a Butterworth section actually needs
    // two cascaded of each, summed LP4+HP4 at fc  (the project's exact lr4() pattern)
    Q = 0.7071 →  +7.43 dB           // must be 0.00 for a complementary crossover
    Q = -3.0103 → -0.00 dB          // correct

Reproduce in this repo with `node qa/scripts/isolate.mjs --section stereo --case imp-anti` (the side
channel is the only thing the width network touches, so an anti-phase impulse measures it directly)
and `--case imp-mid` (the mid path, which bypasses the split, reads exactly 0.00 dB at every
frequency — proof the error is the split, not the matrix).

**MEASUREMENTS** — in this engine (`node-web-audio-api`, same dB-Q semantics as Blink), and matching
the Chromium 149 numbers already recorded in `A-6` to within 0.04 dB

    multiband wet path, inactive compressors (A-6, Chromium):  +7.38 dB @ 140 Hz, +7.39 dB @ 3.2 kHz
    multiband wet path, this engine:                            +7.43 dB at the LR4 corner
    stereo side path, this engine (per-band width at unity):     40 Hz +0.7 | 150 Hz +4.0 | 250 Hz +7.4
                                                                 1 kHz +1.3 | 2 kHz +2.8 | 4 kHz +7.4 | 10 kHz +1.3
      total side energy +2.47 dB; mid path 0.00 dB flat, side also 1 sample late vs mid
    consequence, flagship on the acoustic fixture at matched loudness (see SON-4):
      sub +5.1, low +6.9, lowmid -5.1, presence +5.8 dB
    consequence, full chain on a stationary pink + real side content, bands at unity vs bands off:
      overall level +1.53 dB  (a bypassed section must be 0.00 dB)
    consequence, hot-input headroom: a 0.5-amplitude anti-phase 440 Hz tone enters at -6.02 dBFS
      and leaves the "neutral" chain at +1.62 dBTP — it clips before any user control is involved.

**WHY THE TEST SUITE MISSES IT**
`src/audio/dsp/biquad.js::designBiquad` implements the RBJ formulas with a **linear** Q
(`alpha = sw / (2 * q)`). Every Node-side test that asserts a flat crossover —
`tests/dsp/multiband-crossover.test.js` ("worstDeviationDb < 0.001"), and the biquad tests — validates
that model, i.e. a filter that is not the one the browser builds. `docs/DSP-SIGNAL-FLOW.md` then
states the model's result as a property of the product ("LR4 split, all-pass reconstruction —
yes at unity gains"), which is what makes this easy to miss: the documentation, the model, and the
unit tests are all self-consistent, and only the actual nodes disagree.

**ACTUAL / EXPECTED**
Expected: a Linkwitz-Riley fourth-order pair sums to exactly unity at all frequencies (their own doc
derives `LP2² + HP2² = AP2`, and the algebra is right — it just assumes linear Q).
Actual: `+7.4 dB` at every crossover corner in the graph, in both sections that use it.

**AFFECTED SITES**

| Site                                                                                      | Node types                     | Effect                                                                                                                                                            |
| ----------------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `multiband.js::lr4Section` (×2 crossovers, 3 legs)                                        | `lowpass`/`highpass`           | +7.4 dB at 140 Hz and 3.2 kHz on the wet path — the flagship's "glue" re-EQs every master (SON-4)                                                                 |
| `multiband.js::lr4AllpassNodes`                                                           | `allpass` (linear Q — correct) | compensation tuned for a flat LR4, so it now _adds_ error instead of cancelling                                                                                   |
| `stereo.js::lr4` — `bassHp` + the three per-band width legs                               | `lowpass`/`highpass`           | +7.4 dB on the side channel at 250 Hz and 4 kHz at **unity gains**; "bypassed" is +1.5 dB loud; bass-mono corner is resonant, not LR4                             |
| `stereo.js` `hfRolloff` (`lowpass`, 22 kHz → 15 kHz with `vinyl`)                         | `lowpass`                      | +0.7 dB resonant **lift** at the corner instead of a smooth roll-off — at full vinyl that corner is 15 kHz, inside the band, so "HF roll-off" is a peak at 15 kHz |
| `stereo.js` `dcBlock` (`highpass` 5 Hz) and `postLowpass` (`lowpass` 22 kHz) in `tone.js` | `highpass`/`lowpass`           | +0.7 dB subsonic lift (works against the DC/headroom protection it exists for) and a +0.7 dB bump at 22 kHz                                                       |
| `character.js` `hissHp`, `rumbleLp`, `rumbleHp`                                           | `highpass`/`lowpass`           | resonant, not maximally-flat; cosmetic (noise beds)                                                                                                               |

**FIX (not prescriptive, but it is small)**

1. Express section alignment in the units the node actually uses: for `lowpass`/`highpass`, a
   Butterworth (→ LR4 when cascaded in pairs) is `Q.value = 20·log10(0.7071) = -3.0103`, not
   `0.7071`. One named constant (`BUTTERWORTH_Q_DB = -3.0103`) used by every `lr4`-style helper, so
   the intent stays readable.
2. Make `src/audio/dsp/biquad.js` honest about the divide: either convert dB→linear for
   `lowpass`/`highpass` inside `designBiquad`, or (better) have it take the _node_ convention and
   rename the parameter. A model that silently means something different from the node it models is
   how this survived a 1063-test suite.
3. Then re-derive the `allpass` compensation, because the identity it depends on only holds for a
   truly flat LR4.
4. Gate it: `tests/browser/multiband.spec.js` currently keeps a 1.5 dB contract and _fails_ on this
   (per `A-6`). Fix it properly and turn that annotation into a hard, non-skippable assertion at
   ±0.1 dB **on the wet path** for both sections — including the stereo section, which has no
   browser test at all today.

**SEVERITY**
BLOCKER for a tool whose headline promise is a transparent reference master. It is one unit
conversion, it is not engine-specific (Chromium's own number is in the repo already), and it is the
mechanical reason `Reference HD` measures ±5–7 dB of unwanted EQ.

**Do not** "fix" the loudness/tonal symptoms by re-tuning preset EQ, `mbAutoMakeup`, or the width
defaults on top of this. They are all downstream of the same resonant crossover, and pre-compensating
would re-break every preset the moment the filter is corrected.
