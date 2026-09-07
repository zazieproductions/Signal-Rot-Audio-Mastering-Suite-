#!/usr/bin/env python3
"""Preset / job audit: one row per render, sorted by red flags.

Reads a reports.json produced by qa/scripts/render.mjs, measures every output independently,
and flags what a mastering engineer actually cares about: ceiling integrity, tonal hype,
transient damage, mono collapse, DC, subsonic build-up, clipping — and whether the render
even delivered what it was told to. Tonal numbers are level-matched so "louder" cannot
masquerade as "better".
"""
import argparse
import json
import os
import sys

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from measure import (  # noqa: E402
    band_levels,
    clip_stats,
    dc_and_anomaly,
    lufs_integrated,
    onset_transient_metrics,
    stereo_metrics,
)

MAT = "/home/user/qa/materials"


def fft_tp(x, os_=8):
    """Exact band-limited true peak (validated: reads 0.00 dB on the fs/4 worst case)."""
    if x.ndim == 1:
        x = x[:, None]
    best = -999.0
    L = x.shape[0]
    for c in range(x.shape[1]):
        X = np.fft.rfft(x[:, c])
        N = L * os_
        Y = np.zeros(N // 2 + 1, dtype=complex)
        Y[: len(X)] = X
        y = np.fft.irfft(Y, n=N) * (N / L)
        best = max(best, 20 * np.log10(np.max(np.abs(y)) + 1e-12))
    return best


def crest_of(x, sr):
    return fft_tp(x, 8) - 20 * np.log10(np.sqrt(np.mean(x**2)) + 1e-12)


def load(p):
    x, sr = sf.read(p, always_2d=True)
    return np.asarray(x, dtype=np.float64), int(sr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--json", default=None)
    ap.add_argument("--min-flag", type=int, default=0)
    a = ap.parse_args()
    reports = json.load(open(os.path.join(a.dir, "reports.json")))
    rows = []
    for r in reports:
        job = r["job"]
        if "error" in r:
            rows.append(dict(id=job["id"], flags=["RENDER-ERROR: " + r["error"].splitlines()[0][:70]], nflag=99))
            continue
        rep = r["report"]
        xm, sr = load(r["output"])
        xs, _ = load(os.path.join(MAT, job["src"]))
        lu_m, _ = lufs_integrated(xm, sr)
        lu_s, _ = lufs_integrated(xs, sr)
        gm = 10 ** ((-16.0 - lu_m) / 20.0) if lu_m > -69 else 1.0
        gs = 10 ** ((-16.0 - lu_s) / 20.0) if lu_s > -69 else 1.0
        mb = band_levels(xm * gm, sr)
        sb = band_levels(xs * gs, sr)
        st_m, st_s = stereo_metrics(xm * gm, sr), stereo_metrics(xs * gs, sr)
        tr_m, tr_s = onset_transient_metrics(xm * gm, sr), onset_transient_metrics(xs * gs, sr)
        fold_m = lufs_integrated((xm * gm).mean(axis=1)[:, None], sr)[0] + 16.0
        fold_s = lufs_integrated((xs * gs).mean(axis=1)[:, None], sr)[0] + 16.0
        anom, anom_s = dc_and_anomaly(xm, sr), dc_and_anomaly(xs, sr)
        clip = clip_stats(xm)
        atk_d = (
            None
            if tr_m["attackRatioDb"] is None or tr_s["attackRatioDb"] is None
            else tr_m["attackRatioDb"] - tr_s["attackRatioDb"]
        )
        d = {k: mb[k] - sb[k] for k in mb}
        hype = d["presence"] + d["brilliance"]
        hf_total = d["presence"] + d["brilliance"] + d["air"]
        lf_total = d["sub"] + d["low"]
        crest_m, crest_s = crest_of(xm, sr), crest_of(xs, sr)
        tp = fft_tp(xm, 8)
        ceil = rep["limiter"]["ceilingDbtp"]
        flags = []
        if rep["loudness"]["targetLufs"] is not None and tp > ceil + 0.08:
            flags.append(f"OVER-CEILING {tp - ceil:+.2f}dB")
        if clip["nearFullScale"] > 0:
            flags.append(f"CLIP {clip['nearFullScale']}")
        if anom["nonFinite"]:
            flags.append(f"NaN {anom['nonFinite']}")
        if abs(anom["dcOffset"]) > 0.001:
            flags.append(f"DC {20*np.log10(abs(anom['dcOffset'])+1e-12):.0f}dBFS")
        if anom["sub30HzRmsDbfs"] - anom_s["sub30HzRmsDbfs"] > 2.5:
            flags.append(f"SUB-RUMBLE {anom['sub30HzRmsDbfs'] - anom_s['sub30HzRmsDbfs']:+.1f}dB")
        if hype > 3.0:
            flags.append(f"HF-HYPE {hype:+.1f}dB")
        if hf_total < -6.0:
            flags.append(f"HF-LOSS {hf_total:+.1f}dB")
        if lf_total > 3.5:
            flags.append(f"LF-BLOAT {lf_total:+.1f}dB")
        if fold_m < -2.0 and fold_m - fold_s < -1.5:
            flags.append(f"MONO-LOSS {fold_m - fold_s:+.1f}dB")
        if atk_d is not None and atk_d < -1.5:
            flags.append(f"TRANSIENTS {atk_d:+.1f}dB")
        if crest_s - crest_m > 5.0:
            flags.append(f"CREST-COLLAPSE {crest_m - crest_s:+.1f}dB")
        dl = rep["loudness"]["deltaLu"]
        tgt = rep["loudness"]["targetLufs"]
        if tgt is not None and dl is not None and dl > 0.35:
            flags.append(f"LOUDER-THAN-TARGET {dl:+.2f}LU")
        rows.append(
            dict(
                id=job["id"],
                src=job["src"],
                preset=job.get("preset"),
                family=(job.get("meta") or {}).get("family"),
                risk=(job.get("meta") or {}).get("risk"),
                overrides=job.get("overrides") or {},
                tgt=tgt,
                lufs=round(rep["analysisAfter"]["integratedLufs"], 2),
                dLU=dl,
                repTp=rep["limiter"]["achievedTruePeakDbtp"],
                tp=round(tp, 2),
                ceil=ceil,
                grA=rep["limiter"]["averageGainReductionDb"],
                grM=rep["limiter"]["maximumGainReductionDb"],
                crest=round(crest_m, 1),
                dCrest=round(crest_m - crest_s, 1),
                corr=round(st_m["correlation"], 2),
                dCorr=round(st_m["correlation"] - st_s["correlation"], 2),
                fold=round(fold_m, 1),
                dFold=round(fold_m - fold_s, 1),
                atk=None if atk_d is None else round(atk_d, 1),
                spec={k: round(v, 1) for k, v in d.items()},
                hype=round(hype, 1),
                adap=rep["adaptation"]["sourceClass"],
                adapN=len(rep["adaptation"]["notes"]),
                amb=rep["loudness"]["ambitionReduced"],
                cap=(rep["loudness"]["crestAware"] or {}).get("capped"),
                warns=rep["warnings"],
                flags=flags,
                nflag=len(flags),
            )
        )
    rows.sort(key=lambda r: -r.get("nflag", 0))
    hdr = (
        f"{'id':32s} {'fam':6s} {'LUFS':>6s} {'dLU':>5s} {'TP':>6s} {'ceil':>5s} {'grA/M':>12s} "
        f"{'crest':>5s} {'Δcr':>5s} {'corr':>5s} {'Δco':>5s} {'fold':>5s} {'atk':>5s} {'hype':>5s} {'flg':>3s}"
    )
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        if r.get("nflag", 0) < a.min_flag:
            continue
        print(
            f"{r['id'][:32]:32s} {str(r['family'])[:6]:6s} {r['lufs']:6.2f} "
            f"{(r['dLU'] if r['dLU'] is not None else 0):5.2f} {r['tp']:6.2f} {r['ceil']:5.1f} "
            f"{str(r['grA']) + '/' + str(r['grM']):>12s} {r['crest']:5.1f} {r['dCrest']:5.1f} "
            f"{r['corr']:5.2f} {r['dCorr']:5.2f} {r['fold']:5.1f} "
            f"{(r['atk'] if r['atk'] is not None else 0):5.1f} {r['hype']:5.1f} {r['nflag']:3d}"
        )
    print("\n=== FLAGS ===")
    for r in rows:
        if r.get("flags"):
            print(f"{r['id']:32s} | {' | '.join(r['flags'])}")
    if a.json:
        json.dump(rows, open(a.json, "w"), indent=1)


main()
