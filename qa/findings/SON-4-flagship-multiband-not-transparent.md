## SON-4 — Engaging any multiband band reshapes the master by ±5 dB at 50 % wet, and it is _not_ compression

**SONIC ISSUE**
The multiband "glue" is the first thing every mastering preset turns on, and it does not behave like
a compressor: with the bands set to the **smallest setting that engages them at all** — threshold
−0.24 dB, ratio 1.02:1, i.e. arithmetically incapable of moving level by more than a few hundredths
of a dB — the master still comes back with **+4.9 dB of low end, +4.6 dB of presence, −1.2 dB of air,
3.1 dB _more_ crest factor, and 4.6 dB less level** than the same file with the bands at zero.

The signature is wet/dry interference, not dynamics: the artefact is _larger_ at a 50 % parallel mix
than at 100 % wet, and it moves by up to 10 dB when the sample rate changes. A comb does that. A
compressor does not.

**MATERIAL**
`acoustic.wav` (dynamic acoustic fixture). Also reproduced on rock/bass-heavy/bright and on the
stationary pink fixtures.

**SETTINGS**
No preset — schema defaults plus the fields listed below. `normalize: false` so no gain staging is
involved at all. Output 32-bit float through the repo's own encoder.

**REPRO**

    node qa/scripts/render.mjs --jobs qa/jobs-mbproof.json --out /tmp/proof
    # then measure band balance at matched loudness (qa/scripts/final-measure.py does this)

**MEASUREMENTS** — octave-band energy at matched loudness, relative to the dry (bands-off) render

    render                  sub    low  lowmid    mid  upperm  presence  brill    air   LUFS     crest   corr
    bands 0, wet 0 %      +0.00  +0.00  +0.00  +0.00  +0.00    +0.00   +0.00  +0.00  -20.76   16.63  +0.959
    bands 0, wet 100 %    +0.00  +0.00  +0.00  +0.00  +0.00    +0.00   +0.00  +0.00  -20.76   16.63  +0.959   ✓ fully transparent
    bands 1, wet 100 %    +1.40  +4.87  -0.42  +0.69  +1.12    +4.56   +0.54  -1.21  -21.59   18.57  +0.944
    bands 1, wet  50 %    +4.97  +6.97  -4.68  +3.97  +3.06    +6.21   +2.94  +1.86  -25.36   19.74  +0.922
    bands 12/10/8, wet 100 +1.49  +4.92  -0.48  +0.79  +1.17    +4.63   +0.62  -1.11  -21.89   18.57  +0.943
    Reference HD (12/10/8, wet 50 %) — the shipping flagship:
                          +5.11  +6.87  -5.07  +4.03  +2.76    +5.78   +2.61  +1.60  -15.01   17.07  +0.920

    amount ladder (bands 12/10/8 → 30/25/20 → 60/50/40 → 100/83/67, all at 50 % wet, target -15):
      the tilt is *the same* (+5.0/+6.9/-5.0/+5.8) at every amount from 12 to 100 → it does not
      scale with gain reduction, so it is not the compression.
    mix ladder (12/10/8, wet 0 → 25 → 50 → 75 → 100 %):
      wet 25 % and 50 % give +4.9/+5.2/-4.1/+4.1 and +5.1/+6.9/-5.1/+5.8; wet 75 % and 100 % are
      identical to each other (+1.5/+4.8/-0.5/+0.8) → non-monotonic, level-cancelling, classic comb.
    sample-rate dependence (identical material and settings, native-rate sources):
      48 kHz → 96 kHz: mid -9.66 dB, lowmid +5.93 dB, presence -3.90 dB, crest 17.07 → 14.99
      48 kHz → 192 kHz: sub -6.80, low -5.35, mid -5.52, lowmid +5.33
      with the multiband bypassed the same comparison is flat to ±0.05 dB below 5 kHz and +0.15 to
      +2.3 dB above it (the high-frequency part is the fixtures' own band-limit, not the chain)
      → the rate sensitivity lives entirely in the multiband path.
    limiter reports average GR of 0.18 dB / max 3.5 dB for the flagship on this file, so the
    normalisation loop is quietly paying for a large part of this with gain it then has to trim.

**ROOT CAUSE — identified in SON-3, this is the symptom.**
The `+7.4 dB` bump is the multiband's LR4 legs being resonant rather than Butterworth, because
`BiquadFilterNode` takes `Q` in dB for `lowpass`/`highpass` while the project sets
`Q = Math.SQRT1_2` intending a linear 0.7071. A single section therefore sits +0.71 dB high at its
corner instead of −3.01 dB, the legs no longer sum flat, and the `allpass` compensation legs (where Q
_is_ linear) are now tuned for a filter that is not in the graph. Everything below is what that looks
like on a master; it is kept as evidence, not as a separate fix. This also means the browser
measurement in `docs/FINDINGS-FOR-AGENT-A.md` row `A-6` (+7.38 dB at 140 Hz, +7.39 dB at 3.2 kHz on
the wet path, still "open") and this render-side evidence are the same one bug.

**EXPECTED**
`mbMix` is documented as a parallel mix where 0 % is dry and the wet path is the same audio with
band dynamics applied, aligned by a fixed 6 ms dry-path delay (`MB_COMPRESSOR_LOOKAHEAD_S`,
"the dry path of the parallel mix carries a `DelayNode` of this length so wet and dry arrive
together"). With the bands barely engaged, wet and dry are the _same signal_, so:
50 % wet must be unity within a few hundredths of a dB at every frequency. It is not: it loses
4.6 dB of level and moves octave bands by 5–7 dB.

**ACTUAL**
Every preset that uses the multiband — which is all four mastering presets and most of the genre
family — carries a fixed comb in addition to whatever dynamics the user set. Three consequences a
listener actually hears:

1. **Bass build-up and 4 kHz glare** (+5 to +7 dB in those regions on this fixture) from a preset
   documented as "no EQ moves". `Reference HD` is flagged `HF-HYPE +8.4 dB / LF-BLOAT +12.1 dB`
   against its own source on the acoustic fixture.
2. **Crest factor going _up_ with "glue"** (16.6 → 19.7 dB at 50 % wet): the opposite of what a
   compressor should do, because the comb re-sharpens peaks. The limiter then works harder for it.
3. **The master is not the same record at 96 kHz as at 48 kHz** (mid −9.7 dB). A mastering tool has
   to be rate-transparent; this is not.

**SEVERITY**
HIGH. It is the single biggest reason the flagship master does not win against the source once the
level advantage is taken away.

**CAVEAT — must be re-measured in a real browser before a fix is judged.** The wet path's exact
group delay depends on `DynamicsCompressorNode` internals (look-ahead, emphasis filters, make-up),
which the render report itself flags as engine-dependent, and this harness runs
`node-web-audio-api`, not Chrome/Firefox/WebKit. What is _not_ engine-dependent is the class of the
result: a parallel mix whose "barely engaged" state is not transparent is mis-aligned or
mis-compensated, and the alignment constant is hard-coded at 6 ms — one number for every sample rate
— while the measured artefact is exactly what changes with sample rate. Verify the mix-ladder and
rate-ladder numbers in Chrome (the same fixtures and `qa/jobs-mbproof.json` shape, driven through
`tests/browser/`), then fix whichever way the browser points.

**Also worth checking while in there**

- `mbAutoMakeup` on vs off changes the result by ≤0.1 dB in every test above: a documented control
  with no audible effect at these settings (it is `(1 − 1/ratio)·6·0.5`, ≈0.58 dB at ratio 1.24, and
  it cannot repair a comb).
- The tilt does not scale with band amount (identical at 12 and at 100), so users cannot dial it out.
- `tests/dsp/multiband-crossover.test.js` asserts 0.00000 dB reconstruction **with the bands
  inactive** (`ratio 1:1` ⇒ cancellation node = 1 ⇒ trivially flat). The engaged case is what breaks.
