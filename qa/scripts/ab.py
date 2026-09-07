#!/usr/bin/env python3
"""Level-matched A/B of two renders (or a render vs its source).

    python3 ab.py --a out/rawdef__acoustic.wav --b out/null__acoustic.wav
    python3 ab.py --a materials/rock.wav --b out2/null__rock.wav --residual

Reports: loudness, true peak, spectrum per band at matched loudness, image (correlation,
side/mid, per-band mono fold loss), transient attack ratio, DC, and — with --residual — a
best-fit gain + delay aligned null test: if a "bypassed" chain is not bit-transparent the
residual tells you exactly how much of the record it is changing.
"""
import argparse
import os
import sys

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from measure import (  # noqa: E402
    BANDS,
    band_levels,
    clip_stats,
    dc_and_anomaly,
    lufs_integrated,
    onset_transient_metrics,
    stereo_metrics,
    true_peak,
)


def load(p, mono=False):
    x, sr = sf.read(p, always_2d=True)
    x = np.asarray(x, dtype=np.float64)
    if mono and x.shape[1] > 1:
        x = x.mean(axis=1)[:, None]
    return x, int(sr)


def match_gain(x, sr, target=-16.0):
    lu, _ = lufs_integrated(x, sr)
    if lu <= -69:
        return x, 0.0, lu
    g = target - lu
    return x * 10 ** (g / 20.0), g, lu


def fmt(v, w=8, d=2):
    return " " * (w - len(f"{v:.{d}f}")) + f"{v:.{d}f}" if v is not None else " " * w + "n/a"


def best_align(a, b, max_lag=512):
    """gain g and integer lag d minimising ||b - g*a[d]||, using mono sums."""
    am = a.mean(axis=1)
    bm = b.mean(axis=1)
    n = min(len(am), len(bm))
    am, bm = am[:n], bm[:n]
    ca = np.correlate(am, am, "full")[n - 1 :]
    cb = np.correlate(bm, am, "full")[n - 1 :]
    lag = int(np.argmax(np.abs(cb[: min(len(cb), max_lag + 1)])))
    seg = am[lag : lag + n] if lag else am[:n]
    if len(seg) < n:
        seg = np.pad(seg, (0, n - len(seg)))
    g = float(np.dot(bm, seg) / (np.dot(seg, seg) + 1e-20))
    res = bm - g * seg
    e_b = float(np.sum(bm**2)) + 1e-20
    e_r = float(np.sum(res**2)) + 1e-20
    return dict(
        lagSamples=lag,
        lagMs=round(lag / 48.0, 3),
        gainDb=round(20 * np.log10(abs(g) + 1e-12), 3),
        residualDb=round(10 * np.log10(e_r / e_b), 1),
        polarity="-" if g < 0 else "+",
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--a", required=True)
    ap.add_argument("--b", required=True)
    ap.add_argument("--label-a", default="A")
    ap.add_argument("--label-b", default="B")
    ap.add_argument("--residual", action="store_true")
    ap.add_argument("--target", type=float, default=-16.0)
    a = ap.parse_args()

    xa, sra = load(a.a)
    xb, srb = load(a.b)
    la, ga, lu_a = match_gain(xa, sra, a.target)
    lb, gb, lu_b = match_gain(xb, srb, a.target)
    sa, sb = band_levels(la, sra), band_levels(lb, srb)
    ia, ib = stereo_metrics(la, sra), stereo_metrics(lb, srb)
    ta, tb = onset_transient_metrics(la, sra), onset_transient_metrics(lb, srb)
    folda = lufs_integrated(la.mean(axis=1)[:, None], sra)[0]
    foldb = lufs_integrated(lb.mean(axis=1)[:, None], srb)[0]
    an = dict()
    an[a.label_a] = dict(
        lufs=round(lu_a, 2),
        tpMatched=round(true_peak(la, sra, 8), 2),
        tp=round(true_peak(xa, sra, 8), 2),
        sp=round(20 * np.log10(np.max(np.abs(xa)) + 1e-12), 2),
        crest=round(true_peak(xa, sra, 8) - 20 * np.log10(np.sqrt(np.mean(xa**2)) + 1e-12), 2),
        matchGainDb=round(ga, 2),
        corr=round(ia["correlation"], 3),
        sideMid=round(ia["sideToMidDb"], 2),
        foldLossDb=round(folda - a.target, 2),
        attack=ta["attackRatioDb"],
        dc=round(dc_and_anomaly(xa, sra)["dcOffset"], 5),
        sub30=round(dc_and_anomaly(xa, sra)["sub30HzRmsDbfs"], 1),
        clip=clip_stats(xa)["nearFullScale"],
    )
    an[a.label_b] = dict(
        lufs=round(lu_b, 2),
        tpMatched=round(true_peak(lb, srb, 8), 2),
        tp=round(true_peak(xb, srb, 8), 2),
        sp=round(20 * np.log10(np.max(np.abs(xb)) + 1e-12), 2),
        crest=round(true_peak(xb, srb, 8) - 20 * np.log10(np.sqrt(np.mean(xb**2)) + 1e-12), 2),
        matchGainDb=round(gb, 2),
        corr=round(ib["correlation"], 3),
        sideMid=round(ib["sideToMidDb"], 2),
        foldLossDb=round(foldb - a.target, 2),
        attack=tb["attackRatioDb"],
        dc=round(dc_and_anomaly(xb, srb)["dcOffset"], 5),
        sub30=round(dc_and_anomaly(xb, srb)["sub30HzRmsDbfs"], 1),
        clip=clip_stats(xb)["nearFullScale"],
    )
    print(f"{'metric':16s} {a.label_a[:16]:>18s} {a.label_b[:16]:>18s} {'Δ(B-A)':>10s}")
    for k in an[a.label_a]:
        va, vb = an[a.label_a][k], an[a.label_b][k]
        if isinstance(va, (int, float)) and isinstance(vb, (int, float)):
            d = f"{vb - va:+.2f}"
            va, vb = f"{va:.2f}" if isinstance(va, float) else str(va), f"{vb:.2f}" if isinstance(vb, float) else str(vb)
        else:
            d = ""
        print(f"{k:16s} {str(va):>18s} {str(vb):>18s} {d:>10s}")
    print("\nspectrum at matched loudness (dBFS per band):")
    print(f"{'band':12s} {'A':>8s} {'B':>8s} {'Δ':>8s}")
    for name, _, _ in BANDS:
        print(f"{name:12s} {sa[name]:8.1f} {sb[name]:8.1f} {sb[name]-sa[name]:+8.2f}")
    print("\nper-band mono fold loss (dB):")
    print(f"{'band':12s} {'Acorr':>7s} {'Bcorr':>7s} {'Afold':>7s} {'Bfold':>7s}")
    for name, _, _ in BANDS:
        print(
            f"{name:12s} {ia['bands'][name]['corr']:7.2f} {ib['bands'][name]['corr']:7.2f} "
            f"{ia['bands'][name]['monoLossDb']:7.1f} {ib['bands'][name]['monoLossDb']:7.1f}"
        )
    if a.residual:
        print("\nnull/residual test (B vs A, best-fit gain + integer delay):")
        print("  ", best_align(la, lb))


main()
