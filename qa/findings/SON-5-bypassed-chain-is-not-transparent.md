## SON-5 — "Bypassed" is not bypassed: the neutral chain attenuates an impulse by 5 dB and smears it

**SONIC ISSUE**
With every module bypassed and every parameter at its schema default, a single-sample impulse does
not come out as a single-sample impulse. It arrives **14.7 ms late**, at **−5.1 dB** of its original
amplitude, with **28 % of its energy spread into a tail** that is still −65 dB relative to the peak
20 ms later and −70 dB at 50 ms. A "do nothing" path should do nothing: an off state that
re-shapes transients is the thing a mastering engineer notices first, and here it is not optional —
it is what sits underneath every preset. The same network also costs real headroom: because the
neutral chain changes the peak-to-loudness relationship, the limiter has to spend gain reduction on
material the user asked to leave alone.

**MATERIAL**
`fx-impulse.wav` (one sample of 1.0 at 500 ms, deterministic) and `fx-sweep.wav` (log sweep
20 Hz → 0.95·Nyquist).

**SETTINGS**
`moduleBypass = { match, tone, multiband, stereo, character, depth, saturation }` (all seven),
`normalize: false`, all other parameters at schema defaults.

**REPRO**

    LD_LIBRARY_PATH=<alsa-stub> node qa/scripts/probe.mjs \
      --src fx-impulse.wav --no-normalise --bypass-all --tap --dump /tmp/qa-imp
    LD_LIBRARY_PATH=<alsa-stub> node qa/scripts/probe.mjs \
      --src fx-sweep.wav --no-normalise --bypass-all --tap
    bash qa/scripts/evidence.sh        # regenerates qa/results/evidence/*

**MEASUREMENTS** — tap by tap through the assembled chain, every module bypassed

    stage              impulse peak   offset from input   energy in tail   tail @ +20 ms   @ +50 ms
    input (source)        1.0000           0.00 ms            0.0 %             —            —
    after multiband       0.6456 (−3.8 dB)  +6.02 ms         24.9 %          −125.6 dB     −240 dB
    after stereo          0.6456 (−3.8 dB)  +6.02 ms         24.9 %          −125.6 dB     −240 dB
    after character       0.4734 (−6.5 dB)  +12.00 ms         38.4 %         −125.5 dB     −240 dB
    after saturation      0.5562 (−5.1 dB)  +14.71 ms         27.7 %           −64.8 dB     −70.5 dB
    output                0.5562 (−5.1 dB)  +14.71 ms         27.7 %           −64.8 dB     −70.5 dB

    sweep, same bypassed chain: crest factor 3.0 → 5.1 dB, true peak −2.92 → −0.96 dBTP
      (per stage: character +1.7 dB of peak, saturation +0.4 dB), band energies unchanged to ±0.17 dB
    integrated loudness of the bypassed chain, music material: 0.01–0.02 dB (so this is not a
      level error — the *shape* changes, not the average)

For comparison, a bare 22 kHz / Q 0.707 low-pass (the filter the saturation stage ends with)
applied to the same impulse in isolation: 0.0 % pre-ringing, 24 % post, peak preserved. The
bypassed chain's 5 dB impulse loss is therefore not that filter alone.

**EXPECTED**
`buildMasteringChain`'s header states the contract: bypass is implemented by neutralising
parameters, so "a neutral module is bit-transparent **except for the multiband and stereo sections,
whose all-pass paths are documented**". Measured, the exception is much larger than documented: the
impulse is already 3.8 dB down and 25 % smeared at the multiband tap, and the character and
saturation stages add a further 2.7 dB and 1.4 ms on top. Either the contract changes (the bypassed
chain really is transparent) or the render report states the offset and the peak cost, and the
export trims the delay so a master is sample-aligned with its source.

**ACTUAL**
A 14.7 ms offset with no mention in the report, a 5 dB transient loss into ringing, and +2 dB of
true peak on program material that the limiter must then absorb. The delay is also _not_ constant
across settings (14.7 ms bypassed, 20.9 ms for the same file through `Reference HD`), so users
cannot compensate it themselves by nudging the clip.

**NOTE — most of the impulse damage is SON-3.** The 3.8 dB transient loss and 25 % of energy in the
tail appear at the _multiband_ tap, which is where the resonant LR4 legs live; fix SON-3 and
re-measure this before treating the smear as a separate defect. What is _not_ explained by SON-3 is
the pure transport offset: 6 ms from `MB_COMPRESSOR_LOOKAHEAD_S`'s dry-path delay + 6 ms from
`character.js`'s `tapeDelay.delayTime = 0.006` (a constant set at build time, independent of the tape
amount) + filter group delay. Neither of those two delays is reported anywhere in the render report,
and neither is trimmed, so a master is not sample-aligned with its source and the offset changes with
settings.

**SEVERITY**
LOW/MEDIUM: a fixed delay is standard for a look-ahead chain and is inaudible in isolation; the
issue is that it is unreported and settings-dependent, so null tests and picture-locked work silently
fail. Re-measure after SON-3.

**Needs a real-browser pass.** These numbers are from `node-web-audio-api` (Rust) driving the
project's own graph, which is the closest thing to a render this sandbox can produce (no Chromium
download here). The _existence_ of the offset/smear is structural — nodes are in circuit — but the
exact dBs must be re-measured in Chrome/Firefox before any fix is judged.
