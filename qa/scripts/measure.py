#!/usr/bin/env python3
"""Independent QA measurement set for Signal Rot renders.

Deliberately NOT built on the repo's own analysis modules: the point of this file is to be
an outside yardstick for LUFS / true peak / spectrum / image / transient / mono numbers.
Where it disagrees with the render report, one of the two is wrong and that is a finding.

Usage:
    python3 measure.py <wav...> --json out.json
"""
import argparse
import json
import os
import sys

import numpy as np
import soundfile as sf
from scipy.signal import lfilter, butter, sosfilt, resample_poly

BANDS = [
    ("sub", 20, 60),
    ("low", 60, 150),
    ("lowmid", 150, 400),
    ("mid", 400, 1200),
    ("uppermid", 1200, 2500),
    ("presence", 2500, 5000),
    ("brilliance", 5000, 10000),
    ("air", 10000, 20000),
]


def k_weight(sr):
    """BS.1770-4 K-weighting at arbitrary sample rate (shelf + RLB high-pass)."""
    f0, G, Q = 1681.974450955533, 3.99984385397, 0.70717523695542
    A = 10.0 ** (G / 40.0)
    w0 = 2 * np.pi * f0 / sr
    alpha = np.sin(w0) / (2 * Q)
    cw = np.cos(w0)
    sq = 2 * np.sqrt(A) * alpha
    b = np.array(
        [
            A * ((A + 1) + (A - 1) * cw + sq),
            -2 * A * ((A - 1) + (A + 1) * cw),
            A * ((A + 1) + (A - 1) * cw - sq),
        ]
    )
    a = np.array([(A + 1) - (A - 1) * cw + sq, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - sq])
    b = b / a[0]
    a = a / a[0]
    shelf = (b, a)

    fr, Qr = 38.13547087613982, 0.500327037323877
    w0 = 2 * np.pi * fr / sr
    alpha = np.sin(w0) / (2 * Qr)
    cw = np.cos(w0)
    bh = np.array([(1 + cw) / 2, -(1 + cw), (1 + cw) / 2])
    ah = np.array([1 + alpha, -2 * cw, 1 - alpha])
    bh = bh / ah[0]
    ah = ah / ah[0]
    return shelf, (bh, ah)


def lufs_integrated(x, sr, block=0.4, overlap=0.75, abs_gate=-70.0, rel_gate=-10.0):
    """Gated programme loudness (LUFS). x: (n,) or (n,ch) float."""
    if x.ndim == 1:
        x = x[:, None]
    n, ch = x.shape
    coef = {1: 1.0, 2: 1.0, 3: 1.0, 4: 1.415}[min(ch, 4)] if ch <= 4 else 1.0
    weights = np.ones(min(ch, 4))
    if ch >= 4:
        weights = np.array([1.0, 1.0, 1.0, 1.415])
    y = np.empty_like(x)
    for c in range(ch):
        (bb, ba), (hb, ha) = k_weight(sr)
        s = lfilter(bb, ba, x[:, c])
        y[:, c] = lfilter(hb, ha, s)
    blocklen = int(sr * block)
    hop = int(blocklen * (1 - overlap))
    if blocklen < 2:
        return -70.0, np.array([])
    starts = range(0, max(1, n - blocklen + 1), hop)
    ms = []
    for s in starts:
        seg = y[s : s + blocklen]
        if seg.shape[0] < blocklen:
            seg = np.pad(seg, ((0, blocklen - seg.shape[0]), (0, 0)))
        p = np.sum(seg**2, axis=0) / blocklen
        ms.append(10.0 * np.log10(np.dot(p[: len(weights)], weights) + 1e-16))
    ms = np.array(ms)
    z = 10.0 * np.log10(np.mean(10.0 ** (ms / 10.0)) + 1e-20)  # ungated
    gated = ms[ms > abs_gate]
    if gated.size == 0:
        return -70.0, ms
    rel = gated.mean() if gated.size else z
    rel = 10.0 * np.log10(np.sum(10.0 ** (gated / 10.0)) / gated.size)
    keep = gated[gated > rel + rel_gate]
    if keep.size == 0:
        return -70.0, ms
    val = -0.691 + 10.0 * np.log10(np.mean(10.0 ** (keep / 10.0)))
    return float(val), ms


def st_lufs(x, sr, win=3.0, hop=0.1):
    if x.ndim == 1:
        x = x[:, None]
    n = x.shape[0]
    block = int(sr * win)
    step = int(sr * hop)
    if block < 16:
        block = 16
    out = []
    for s in range(0, max(1, n - block + 1), step):
        v, _ = lufs_integrated(x[s : s + block], sr, block=0.4)
        out.append(v)
    return np.array(out) if out else np.array([-70.0])


def true_peak(x, sr, oversample=8):
    """Inter-sample peak via polyband FIR upsampling (scipy resample_poly is close to the
    ITU-R BS.1770 annex method; good enough to catch ceiling misses)."""
    if x.ndim == 1:
        x = x[:, None]
    up = oversample
    y = resample_poly(x, up, 1, axis=0)
    return float(20 * np.log10(np.max(np.abs(y)) + 1e-12))


def sample_peak(x):
    return float(20 * np.log10(np.max(np.abs(x)) + 1e-12))


def band_db(x, sr):
    """Energy in dB relative to total energy, per band."""
    if x.ndim == 1:
        x = x[:, None]
    m = np.mean(x**2, axis=1)
    tot = m.sum() + 1e-20
    f = np.fft.rfftfreq(len(m), 1 / sr)
    M = np.abs(np.fft.rfft(m)) ** 2
    M *= np.hanning(len(M))[None] if False else 1
    out = {}
    for name, lo, hi in BANDS:
        if lo >= f[-1]:
            out[name] = -120.0
            continue
        sel = (f >= lo) & (f < min(hi, f[-1]))
        e = M[sel].sum()
        out[name] = float(10 * np.log10(e / tot + 1e-20))
    return out


def band_levels(x, sr):
    """Absolute per-band RMS in dBFS (mono sum of channels)."""
    if x.ndim > 1:
        x = x.mean(axis=1)
    f = np.fft.rfftfreq(len(x), 1 / sr)
    X = np.abs(np.fft.rfft(x * np.hanning(len(x)))) ** 2
    out = {}
    for name, lo, hi in BANDS:
        if lo >= f[-1]:
            out[name] = -120.0
            continue
        sel = (f >= lo) & (f < min(hi, f[-1]))
        out[name] = float(10 * np.log10(X[sel].sum() / len(x) + 1e-20))
    return out


def stereo_metrics(x, sr):
    if x.ndim == 1 or x.shape[1] == 1:
        l = r = x if x.ndim == 1 else x[:, 0]
        mono_src = True
    else:
        l, r = x[:, 0], x[:, 1]
        mono_src = False
    mid = (l + r) / 2
    side = (l - r) / 2
    e_mid = float(np.mean(mid**2)) + 1e-20
    e_side = float(np.mean(side**2)) + 1e-20
    denom = np.sqrt(np.mean(l**2) * np.mean(r**2)) + 1e-20
    corr = float(np.mean(l * r) / denom)
    fl = np.fft.rfft(l * np.hanning(len(l)))
    fr = np.fft.rfft(r * np.hanning(len(r)))
    f = np.fft.rfftfreq(len(l), 1 / sr)
    bands = {}
    for name, lo, hi in BANDS:
        if lo >= f[-1]:
            bands[name] = dict(corr=1.0, monoLossDb=0.0)
            continue
        sel = (f >= lo) & (f < min(hi, f[-1]))
        pl = np.abs(fl[sel]) ** 2
        pr = np.abs(fr[sel]) ** 2
        c = np.sum(fl[sel] * np.conj(fr[sel]))
        d = np.sqrt(np.sum(pl) * np.sum(pr)) + 1e-20
        mono_e = np.sum(np.abs((fl[sel] + fr[sel]) / 2) ** 2)
        st_e = np.sum((pl + pr) / 2)
        bands[name] = dict(
            corr=float(np.real(c) / d),
            monoLossDb=float(10 * np.log10((mono_e + 1e-20) / (st_e + 1e-20))),
        )
    return dict(
        correlation=corr,
        sideToMidDb=float(10 * np.log10(e_side / e_mid)),
        monoFoldLoudnessDeltaDb=None,
        bands=bands,
        monoSource=mono_src,
    )


def onset_transient_metrics(x, sr):
    """Attack preservation: for each onset, energy in the first 5 ms vs the following
    45 ms, and the peak sample of the attack itself."""
    if x.ndim > 1:
        x = x.mean(axis=1)
    e = np.abs(x)
    win = max(1, int(sr * 0.005))
    ef = np.convolve(e**2, np.ones(win) / win, mode="same")
    thr = np.percentile(ef, 60) + 1e-9
    d = np.diff(ef)
    onsets = np.where(d > (np.percentile(np.abs(d), 99.0)))[0]
    onsets = onsets[:: max(1, len(onsets) // 60)][:60] if len(onsets) else onsets
    rat = []
    pks = []
    seg = []
    for o in onsets:
        a = ef[o : o + win]
        b = ef[o + win : o + 10 * win]
        if len(a) < win or len(b) < win:
            continue
        rat.append(float(10 * np.log10((a.mean() + 1e-18) / (b.mean() + 1e-18))))
        pks.append(float(np.max(np.abs(x[o : o + win]))))
        seg.append(int(o))
    return dict(
        onsets=len(rat),
        attackRatioDb=float(np.mean(rat)) if rat else None,
        attackPeakDbfs=float(20 * np.log10(np.max(pks) + 1e-12)) if pks else None,
        onsetIndex=seg[:200],
    )


def clip_stats(x):
    if x.ndim == 1:
        x = x[:, None]
    flat = np.abs(x) > 0.999
    runs = 0
    for c in range(x.shape[1]):
        v = flat[:, c].astype(np.int8)
        runs += int(np.sum((np.diff(np.concatenate(([0], v, [0]))) == 1)))
    return dict(nearFullScale=int(flat.sum()), flatTopRuns=runs)


def dc_and_anomaly(x, sr):
    if x.ndim == 1:
        x = x[:, None]
    dc = float(np.mean(x, axis=0).max())
    nan = int(np.sum(~np.isfinite(x)))
    sos = butter(2, min(30.0, sr / 2 * 0.4) / (sr / 2), "lowpass", output="sos")
    sub = sosfilt(sos, x, axis=0)
    sub_rms = float(20 * np.log10(np.sqrt(np.mean(sub**2)) + 1e-16))
    return dict(dcOffset=dc, nonFinite=nan, sub30HzRmsDbfs=sub_rms)


def analyse(path):
    x, sr = sf.read(path, always_2d=True)
    x = np.asarray(x, dtype=np.float64)
    if x.shape[1] == 0:
        raise SystemExit("empty file " + path)
    lu, ms = lufs_integrated(x, sr)
    st = st_lufs(x, sr)
    a = dict(
        file=os.path.basename(path),
        sampleRate=int(sr),
        channels=int(x.shape[1]),
        seconds=round(x.shape[0] / sr, 3),
        lufs=round(float(lu), 2),
        truePeakDb=round(true_peak(x, sr, 8), 2),
        samplePeakDb=round(sample_peak(x), 2),
        crestDb=round(true_peak(x, sr, 8) - (20 * np.log10(np.sqrt(np.mean(x**2)) + 1e-12)), 2),
        lraLu=round(float(np.percentile(st[st > -60], 95) - np.percentile(st[st > -60], 10)), 2)
        if np.any(st > -60)
        else 0.0,
        maxShortTerm=round(float(np.max(st)), 2),
        minShortTerm=round(float(np.min(st[st > -60])) if np.any(st > -60) else -70.0, 2),
        spectrumDb=band_levels(x, sr),
        stereo=stereo_metrics(x, sr),
        transients=onset_transient_metrics(x, sr),
        clipping=clip_stats(x),
        anomaly=dc_and_anomaly(x, sr),
    )
    return a


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--json", default=None)
    args = ap.parse_args()
    out = []
    for f in args.files:
        try:
            out.append(analyse(f))
        except Exception as e:  # noqa: BLE001
            out.append(dict(file=f, error=repr(e)))
    if args.json:
        json.dump(out, open(args.json, "w"), indent=1)
    hdr = f"{'file':34s} {'LUFS':>7s} {'TP':>6s} {'SP':>6s} {'crest':>6s} {'LRA':>5s} {'corr':>6s} {'S/M':>6s} {'atk':>6s} {'DC':>7s} {'nan':>4s}"
    print(hdr)
    for a in out:
        if "error" in a:
            print(f"{os.path.basename(a['file']):34s} ERROR {a['error'][:60]}")
            continue
        st = a["stereo"]
        atk = a["transients"]["attackRatioDb"]
        print(
            f"{a['file']:34s} {a['lufs']:7.2f} {a['truePeakDb']:6.2f} {a['samplePeakDb']:6.2f} "
            f"{a['crestDb']:6.2f} {a['lraLu']:5.1f} {st['correlation']:6.2f} {st['sideToMidDb']:6.1f} "
            f"{(atk if atk is not None else float('nan')):6.1f} {a['anomaly']['dcOffset']*1000:7.3f} {a['anomaly']['nonFinite']:4d}"
        )


if __name__ == "__main__":
    main()
