#!/usr/bin/env python3
"""Compare a Signal Rot render against its source (or another render), at matched loudness.

    python3 compare.py --out /home/user/qa/out [--ref out2] [--match] [--quiet]

For every job in reports.json it measures the rendered WAV and the *source* material, then
prints what the master did: loudness, peak, spectrum per band (at matched loudness), image,
transients, mono fold-down, clipping. Loudness matching is what makes "louder = better"
impossible, so the tonal/image numbers below are level-compensated.
"""
import argparse
import json
import os
import sys

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from measure import (  # noqa: E402
    BANDS,
    band_levels,
    clip_stats,
    lufs_integrated,
    onset_transient_metrics,
    stereo_metrics,
    true_peak,
    dc_and_anomaly,
)

MAT = "/home/user/qa/materials"


def load(path):
    x, sr = sf.read(path, always_2d=True)
    return np.asarray(x, dtype=np.float64), int(sr)


def gain_for(x, sr, target):
    lu, _ = lufs_integrated(x, sr)
    if lu <= -69:
        return 1.0, lu
    return float(10 ** ((target - lu) / 20.0)), lu


def tp(x, sr):
    return true_peak(x, sr, 8)


def analyse_pair(src_path, out_path, target=-16.0):
    xs, sr = load(src_path)
    xm, _ = load(out_path)
    # match loudness of BOTH to the same target for tonal comparison
    gs, lus = gain_for(xs, sr, target)
    gm, lum = gain_for(xm, sr, target)
    src = xs * gs
    mst = xm * gm
    sb = band_levels(src, sr)
    mb = band_levels(mst, sr)
    ss = stereo_metrics(src, sr)
    ms = stereo_metrics(mst, sr)
    st = onset_transient_metrics(src, sr)
    mt = onset_transient_metrics(mst, sr)
    delta = {k: round(mb[k] - sb[k], 2) for k, _, _ in BANDS}
    mono_src = np.mean(src, axis=1)
    mono_mst = np.mean(mst, axis=1)
    fold_s, _ = lufs_integrated(mono_src[:, None], sr)
    fold_m, _ = lufs_integrated(mono_mst[:, None], sr)
    # both compared against the *matched* level, so the number is fold loss, not the trim
    src_ref, _ = lufs_integrated(src, sr)
    mst_ref, _ = lufs_integrated(mst, sr)
    return dict(
        src=os.path.basename(src_path),
        out=os.path.basename(out_path),
        lufsSrc=round(lus, 2),
        lufsOut=round(lum, 2),
        tpSrc=round(tp(src, sr), 2),
        tpOut=round(tp(mst, sr), 2),
        tpOutRaw=round(tp(xm, sr), 2),
        spOutRaw=round(20 * np.log10(np.max(np.abs(xm)) + 1e-12), 2),
        crestOut=round(tp(xm, sr) - 20 * np.log10(np.sqrt(np.mean(xm**2)) + 1e-12), 2),
        lufsCrest=round(
            (20 * np.log10(np.max(np.abs(xm)) + 1e-12)) - lum, 2
        ),
        specDeltaDb=delta,
        specSrc={k: round(v, 1) for k, v in sb.items()},
        specOut={k: round(v, 1) for k, v in mb.items()},
        corrSrc=round(ss["correlation"], 3),
        corrOut=round(ms["correlation"], 3),
        smSrc=round(ss["sideToMidDb"], 2),
        smOut=round(ms["sideToMidDb"], 2),
        foldLossSrc=round(fold_s - src_ref, 2),
        foldLossOut=round(fold_m - mst_ref, 2),
        bandCorr={k: round(v["corr"], 2) for k, v in ms["bands"].items()},
        bandMonoLoss={k: round(v["monoLossDb"], 1) for k, v in ms["bands"].items()},
        atkSrc=None if st["attackRatioDb"] is None else round(st["attackRatioDb"], 2),
        atkOut=None if mt["attackRatioDb"] is None else round(mt["attackRatioDb"], 2),
        onsets=mt["onsets"],
        clip=clip_stats(xm),
        anomaly=dc_and_anomaly(xm, sr),
        srOut=sr,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/home/user/qa/out")
    ap.add_argument("--target", type=float, default=-16.0)
    ap.add_argument("--only", default=None, help="substring filter on job id")
    ap.add_argument("--json", default=None)
    args = ap.parse_args()
    reports = json.load(open(os.path.join(args.out, "reports.json")))
    rows = []
    for r in reports:
        job = r["job"]
        if "error" in r:
            print(f"{job['id']:32s} RENDER ERROR: {r['error'].splitlines()[0][:80]}")
            continue
        if args.only and args.only not in job["id"]:
            continue
        out = r["output"]
        src = os.path.join(MAT, job["src"])
        try:
            row = analyse_pair(src, out, args.target)
        except Exception as e:  # noqa: BLE001
            print(f"{job['id']:32s} MEASURE ERROR {e!r}")
            continue
        row["id"] = job["id"]
        row["preset"] = job.get("preset")
        row["overrides"] = job.get("overrides", {})
        rep = r["report"]
        row["repLufs"] = rep["analysisAfter"]["integratedLufs"]
        row["repTp"] = rep["analysisAfter"]["truePeakDbtp"]
        row["ceiling"] = rep["limiter"]["ceilingDbtp"]
        row["ceilingOk"] = rep["limiter"]["ceilingRespected"]
        row["gr"] = [rep["limiter"]["averageGainReductionDb"], rep["limiter"]["maximumGainReductionDb"]]
        row["deltaLu"] = rep["loudness"]["deltaLu"]
        row["reach"] = rep["loudness"]["targetReachable"]
        row["amb"] = rep["loudness"]["ambitionReduced"]
        row["cap"] = (rep["loudness"]["crestAware"] or {}).get("capped")
        row["adap"] = rep["adaptation"]["sourceClass"]
        row["adapNotes"] = rep["adaptation"]["notes"]
        row["warn"] = rep["warnings"]
        rows.append(row)

    hdr = (
        f"{'job':30s} {'LUFS':>7s} {'dLU':>5s} {'TP':>6s} {'ceil':>5s} {'grA/M':>11s} "
        f"{'crest':>5s} {'corr':>6s} {'S/M':>6s} {'fold':>5s} {'atk':>6s} {'clip':>5s} {'nan':>4s} {'adap':>14s}"
    )
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        atk = (
            "  n/a"
            if r["atkOut"] is None
            else f"{r['atkOut'] - r['atkSrc']:+.1f}"
        )
        print(
            f"{r['id']:30s} {r['repLufs']:7.2f} {r['deltaLu']:5.2f} {r['tpOutRaw']:6.2f} "
            f"{r['ceiling']:5.1f} {str(r['gr'][0])+'/'+str(r['gr'][1]):>11s} {r['crestOut']:5.1f} "
            f"{r['corrOut']:6.2f} {r['smOut']:6.1f} {r['foldLossOut']:5.1f} {atk:>6s} "
            f"{r['clip']['nearFullScale']:5d} {r['anomaly']['nonFinite']:4d} {str(r['adap'])[:14]:>14s}"
        )
    print()
    print(f"{'job':30s} " + " ".join(f"{n[:6]:>7s}" for n, _, _ in BANDS) + "   (spectrum delta at MATCHED loudness, dB)")
    for r in rows:
        print(f"{r['id']:30s} " + " ".join(f"{r['specDeltaDb'][n]:+7.1f}" for n, _, _ in BANDS))
    bad = [r for r in rows if not r["ceilingOk"] or r["tpOutRaw"] > r["ceiling"] + 0.05]
    if bad:
        print("\nCEILING OVERRUNS (measured 8x true peak vs requested ceiling):")
        for r in bad:
            print(f"  {r['id']}: measured {r['tpOutRaw']} dBTP vs ceiling {r['ceiling']} dBTP (report says {r['repTp']}, respected={r['ceilingOk']})")
    over = [r for r in rows if r["foldLossOut"] < -1.0]
    if over:
        print("\nMONO FOLD-DOWN LOSS > 1 dB:")
        for r in over:
            print(f"  {r['id']}: {r['foldLossOut']} dB (source was {r['foldLossSrc']} dB); worst bands {r['bandMonoLoss']}")
    if args.json:
        json.dump(rows, open(args.json, "w"), indent=1)


main()
