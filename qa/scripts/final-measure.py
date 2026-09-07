#!/usr/bin/env python3
"""Final evidence run: renders the sets quoted in the findings, measures them independently,
and writes qa/results/final-evidence.json (+ printed tables).

    LD_LIBRARY_PATH=<stub> node qa/scripts/render.mjs --jobs qa/jobs-final.json --out qa/results/final
    python3 qa/scripts/final-measure.py
"""
import json
import os
import sys

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

QA = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(QA)
HERE = os.path.join(QA, "scripts")
sys.path.insert(0, HERE)
from measure import BANDS, band_levels, lufs_integrated, onset_transient_metrics, stereo_metrics  # noqa: E402

RES = os.path.join(QA, "results")
OUTD = os.path.join(RES, "final")
MATDIR = os.environ.get("QA_MAT", "/home/user/qa/materials")


def fft_tp(x, os_=8):
    if x.ndim == 1:
        x = x[:, None]
    L = x.shape[0]
    best = -999.0
    for c in range(x.shape[1]):
        X = np.fft.rfft(x[:, c])
        N = L * os_
        Y = np.zeros(N // 2 + 1, dtype=complex)
        Y[: len(X)] = X
        y = np.fft.irfft(Y, n=N) * (N / L)
        best = max(best, 20 * np.log10(np.max(np.abs(y)) + 1e-12))
    return best


def load48(p):
    x, sr = sf.read(p, always_2d=True)
    x = np.asarray(x, dtype=np.float64)
    if sr != 48000:
        x = resample_poly(x, 48000, sr, axis=0)
    return x, 48000


def matched(p, target=-16.0):
    x, sr = load48(p)
    lu, _ = lufs_integrated(x, sr)
    if lu <= -69:
        return x, lu
    return x * 10 ** ((target - lu) / 20.0), lu


def main():
    reports = {r["job"]["id"]: r for r in json.load(open(os.path.join(OUTD, "reports.json"))) if "error" not in r}
    rows = {}
    for jid, r in reports.items():
        x, _ = load48(r["output"])
        xm, lu = matched(r["output"])
        sm = stereo_metrics(xm, 48000)
        tr = onset_transient_metrics(xm, 48000)
        rows[jid] = dict(
            src=r["job"]["src"],
            preset=r["job"].get("preset"),
            bypass=r["job"].get("bypass"),
            overrides=r["job"].get("overrides") or {},
            lufs=round(lu, 3),
            tgtLUFS=r["report"]["loudness"]["targetLufs"],
            dLU=r["report"]["loudness"]["deltaLu"],
            tpExact=round(fft_tp(x, 8), 3),
            ceil=r["report"]["limiter"]["ceilingDbtp"],
            tpClaimed=r["report"]["limiter"]["achievedTruePeakDbtp"],
            ceilingRespected=r["report"]["limiter"]["ceilingRespected"],
            grAvg=r["report"]["limiter"]["averageGainReductionDb"],
            grMax=r["report"]["limiter"]["maximumGainReductionDb"],
            crest=round(fft_tp(x, 8) - 20 * np.log10(np.sqrt(np.mean(x**2)) + 1e-12), 2),
            corr=round(sm["correlation"], 3),
            sideMid=round(sm["sideToMidDb"], 2),
            bands={k: round(v, 2) for k, v in band_levels(xm, 48000).items()},
            attack=None if tr["attackRatioDb"] is None else round(tr["attackRatioDb"], 2),
            warns=r["report"]["warnings"],
            notes=r["report"]["adaptation"]["notes"],
            sourceClass=r["report"]["adaptation"]["sourceClass"],
        )

    def delta(a, b):
        if a not in rows or b not in rows:
            return None
        return {k: round(rows[b]["bands"][k] - rows[a]["bands"][k], 2) for k, _, _ in BANDS}

    groups = {
        "sampleRate (Reference HD, all modules)": ["RATE-48", "RATE-96", "RATE-192"],
        "sampleRate (multiband BYPASSED)": ["RATE-nomb-48", "RATE-nomb-96", "RATE-nomb-192"],
        "parallel-mix ladder (mb 12/10/8)": ["MIX-0", "MIX-25", "MIX-50", "MIX-75", "MIX-100"],
        "amount ladder (mbMix 50)": ["AMT-0", "AMT-12", "AMT-30", "AMT-60", "AMT-100"],
    }
    tables = {}
    print("band deltas within each group, matched loudness (dB, relative to the first member)\n")
    for name, keys in groups.items():
        print(f"### {name}")
        hdr = "  " + f"{'render':16s} " + " ".join(f"{k[:6]:>7s}" for k, _, _ in BANDS) + "   LUFS   crest  corr  side/mid"
        print(hdr)
        base = keys[0]
        tbl = []
        for k in keys:
            if k not in rows:
                continue
            d = delta(base, k)
            tbl.append(dict(id=k, **rows[k], delta=d))
            print(
                f"  {k:16s} "
                + " ".join(f"{(d[k2] if d else 0):+7.2f}" for k2, _, _ in BANDS)
                + f"  {rows[k]['lufs']:6.2f} {rows[k]['crest']:6.2f} {rows[k]['corr']:6.2f} {rows[k]['sideMid']:7.2f}"
            )
        print()
        tables[name] = tbl
    json.dump({"renders": rows, "groups": tables}, open(os.path.join(RES, "final-evidence.json"), "w"), indent=1)
    print(f"wrote {os.path.join(RES, 'final-evidence.json')}")


main()
