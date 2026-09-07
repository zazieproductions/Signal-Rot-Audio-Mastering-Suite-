## SON-6 — When a target is unreachable the loop buys the _loudest_ damaged pass, not the cleanest one

**SONIC ISSUE**
The crest-aware budget does refuse stupid requests, which is right — but _how_ it refuses. On
high-crest material the loop keeps pushing until the limiter is working very hard, and then delivers a
master that is barely louder than the input while being measurably flatter. The engine spends 6 dB of
peak gain reduction and 5 dB of crest factor to buy 0.5 LU of loudness, and the report prints a
warning as if that were the intended outcome. If the target cannot be reached, the correct output is
the _quietest pass that still meets the material_, not the most-processed pass that gets closest.

**MATERIAL**
`transients.wav` (sparse percussive, source −24.70 LUFS, crest 25.2 dB), `acoustic.wav`, `rock.wav`,
`bass-heavy.wav`.

**SETTINGS**
`Reference HD` (the pristine flagship; source-aware layer reduces its bands to 8/7/6 on this material),
ceiling −1, `targetLUFS` requested as −8.

**REPRO**

    node qa/scripts/render.mjs --jobs qa/jobs-stress.json --out /tmp/o
    python3 qa/scripts/compare.py --out /tmp/o            # L-8__trans, L-12/L-10/L-9__acoustic
    python3 qa/scripts/audit.py --dir /tmp/o

**MEASUREMENTS**

    transients.wav, Reference HD
      requested -8  → delivered -16.43 LUFS, avg GR -1.93, max GR -5.96, crest 25.2 → 20.3, attack -2.9 dB
      requested -15 → delivered -16.94 LUFS, avg GR -1.19, max GR -4.31, crest → 20.6, attack -2.2 dB
      requested -25 (≈ the source's own level) → no limiting needed
      i.e. going from a -15 request to a -8 request buys **+0.5 LU** and costs 1.65 dB more peak
      reduction and 0.3 dB more attack loss — a trade no mastering engineer would take, chosen by
      the loop, not by the user.
      (a clean pass with zero limiting exists for this file at about its own level; the loop did not
       pick it.)

    acoustic.wav, Reference HD
      -18 → -18.01 ✓   -16 → -16.10 ✓   -14 → -13.91 ✓   -12 → -12.89 (capped)
      -10 → -12.92 (capped)   -9 → -12.92 (capped)   -8 → -12.87 (capped)
      every capped pass lands at the same place with max GR -5.9 dB and crest 20.0 → 15.0: the
      budget caps the *target*, so all four requests converge on the most-limited pass at that cap.

    rock.wav: -14 ✓ / -12 ✓ / -10 ✓ (-10.02) / -9 → -10.23 (ambition) / -8 → -9.81 (ambition) with
      crest 15.7 → 10.7 and HF -8 dB at matched loudness.
    bass-heavy.wav: -14 ✓, -10 → -10.39, -8 → -10.35 (capped), crest 12.0 → 8.2.

    across all 72 presets × 2 materials: ambitionReduced 13/144, crestAware-capped 12/144, and
    **0 renders clipped** (no sample above full scale anywhere in the matrix) — the guard rail itself
    works; it is the objective function inside it that is wrong.

**EXPECTED**
Per `src/audio/render/normalize.js`: passes are scored `|delta| + overBudget × 1.5` and the loop keeps
the best score, stopping when average reduction passes 3 dB. Two things follow from that, and both are
the opposite of what a mastering tool should do:

1. When the target is unreachable, `|delta|` is large for every pass, so the score is minimised by
   being **louder** — the objective silently changes from "least damage" to "closest to an impossible
   number".
2. With the flagship's gentle settings, average GR (1.5–1.9 dB) never approaches the 3 dB stop even
   while peak GR is ~6 dB and 5 dB of crest factor is gone, because `LIMITER_GR_BUDGET_DB = 1.5` and
   `LIMITER_GR_CEILING_DB = 3` are both **average** measures.

**ACTUAL**
`targetReachable: false`, `ambitionReduced: true`, and a warning telling the user the truth — but the
audio delivered is the crushed pass. The report is honest; the selection is not conservative.

**SEVERITY**
MEDIUM. Nothing clips, nothing is corrupted, and the refusal to brickwall is genuinely good behaviour
relative to the industry. The remaining gap is judgement: on transient-heavy and dynamic material a
hot request should cost the master nothing, because there is a clean pass available and the loop chose
not to take it.

**Suggested fix (not prescriptive)**
When a pass cannot reach its (possibly reduced) target, score on damage first — e.g. pick the
_quietest_ pass whose average GR is within budget, or add a term for peak GR / crest loss so that
"louder by 0.5 LU with 6 dB more peak reduction" strictly loses. Also worth reporting, since it is the
number a user actually wants: delivered LUFS **relative to the source's own LUFS**, so "I asked −8 and
got −16.4" is visibly "the file was already at −16.9 and there was nothing to buy".
