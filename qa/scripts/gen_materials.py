#!/usr/bin/env python3
"""Deterministic QA material bank for Signal Rot critical-listening comparisons.

Everything is synthesised from a fixed seed so runs reproduce. Materials are musical-ish
(not just pink noise) because mastering defects show up on structure: transients,
macro-dynamics, a centre image, a vocal. Fixtures are for objective checks only.
"""
import numpy as np
import soundfile as sf
import os
import json
from scipy.signal import butter, sosfilt

SR = 48000
DUR = 10.0
N = int(SR * DUR)
t = np.arange(N) / SR
rng = np.random.default_rng(1234)
OUT = os.environ.get("QA_MAT", "/home/user/qa/materials")
os.makedirs(OUT, exist_ok=True)

reg_rows = []


def reg(name, desc, kind):
    reg_rows.append(dict(file=name, desc=desc, kind=kind))


def _n(hz):
    """normalise a frequency to 0..1 (Nyquist) with headroom"""
    return float(min(max(hz, 1.0), SR / 2 * 0.98) / (SR / 2))


def highpass(x, hz):
    return sosfilt(butter(2, _n(hz), "highpass", output="sos"), x, axis=-1)


def lowpass(x, hz):
    return sosfilt(butter(2, _n(hz), "lowpass", output="sos"), x, axis=-1)


def bandpass(x, lo, hi, order=2):
    return sosfilt(butter(order, [_n(lo), _n(hi)], "bandpass", output="sos"), x, axis=-1)


def ks_pluck(freq, n, decay=0.995, damp_hz=6000.0):
    """Karplus-Strong plucked string."""
    L = max(2, int(round(SR / freq)))
    buf = rng.standard_normal(L) * 0.5
    out = np.empty(n)
    a = np.exp(-2 * np.pi * damp_hz / SR)
    prev = 0.0
    for i in range(n):
        cur = buf[i % L]
        cur = a * prev + (1 - a) * cur
        prev = cur
        out[i] = cur
        buf[i % L] = 0.5 * (cur + buf[(i + 1) % L]) * decay
    return out


def drum_kick(n, f0=55.0, dec=0.20):
    i = np.arange(n) / SR
    fr = f0 * (1 + 3.0 * np.exp(-i / 0.006))
    ph = 2 * np.pi * np.cumsum(fr) / SR
    x = np.sin(ph) * np.exp(-i / dec)
    click = rng.standard_normal(n) * np.exp(-i / 0.0025) * 0.35
    return 0.9 * x + 0.25 * bandpass(click, 800, 6000)


def drum_snare(n, dec=0.16):
    i = np.arange(n) / SR
    tone = np.sin(2 * np.pi * 185 * i) * np.exp(-i / 0.06) * 0.5
    nz = rng.standard_normal(n)
    body = bandpass(nz, 1500, 7000) * np.exp(-i / dec)
    return 0.55 * body + 0.35 * tone + 0.12 * highpass(nz, 6000) * np.exp(-i / 0.05)


def drum_hat(n, dec=0.045, bright=True):
    i = np.arange(n) / SR
    nz = rng.standard_normal(n)
    return bandpass(nz, 7000 if bright else 5000, SR / 2 * 0.9) * np.exp(-i / dec)


def place(dst, src, at):
    a = int(at * SR)
    b = min(len(dst), a + len(src))
    if a < len(dst):
        dst[a:b] += src[: b - a]


def stereo(l, r):
    return np.stack([l, r], axis=1)


def saw(f):
    return 2 * ((t * f) % 1.0) - 1


def write(name, x, kind="music", desc=""):
    x = np.asarray(x)
    if x.ndim == 1:
        x = x[:, None]
    sf.write(os.path.join(OUT, name), x.astype(np.float32), SR, subtype="FLOAT")
    reg(name, desc, kind)
    return x


# ── 1. dynamic acoustic ───────────────────────────────────────────────────────────────
L = np.zeros(N)
R = np.zeros(N)
notes = [110.0, 164.81, 220.0, 277.18, 329.63, 440.0]
step = 0.42
k = 0
while k * step < DUR - 0.05:
    at = k * step
    f = notes[k % len(notes)] * (0.5 if k % 8 < 2 else 1.0)
    amp = 0.30 + 0.18 * np.sin(k * 1.7)
    seg = ks_pluck(f, int(1.6 * SR)) * amp
    place(L, seg * (1.0 if k % 2 == 0 else 0.72), at)
    place(R, seg * (0.72 if k % 2 == 0 else 1.0), at)
    k += 1

pad = lowpass(rng.standard_normal(N), 1200)
pad = pad / (np.max(np.abs(pad)) + 1e-9) * 0.05
vocal = np.zeros(N)
for v in range(int(DUR / 1.4)):
    i = np.arange(int(1.2 * SR)) / SR
    e = np.hanning(len(i))
    f = 220 * (1.0 + 0.02 * np.sin(v))
    x = (
        np.sin(2 * np.pi * f * i)
        + 0.5 * np.sin(2 * np.pi * 2 * f * i)
        + 0.25 * np.sin(2 * np.pi * 3 * f * i)
    ) * e * 0.16
    place(vocal, x, v * 1.4 + 0.1)
voice = lowpass(vocal, 5000) * 1.2
gainenv = np.where(t < 2.0, 0.55, np.where(t < 6.0, 0.85, 1.0))
ac = stereo((L + voice + pad * 0.8) * gainenv, (R + voice + np.roll(pad, 120) * 0.8) * gainenv)
ac = ac / np.max(np.abs(ac)) * 0.42
write("acoustic.wav", ac, "music", "dynamic acoustic guitar + breathy vocal, macro dynamics")

# ── 2. dense rock ─────────────────────────────────────────────────────────────────────
dr = np.zeros(N)
hatL = np.zeros(N)
beat = 0.5
for b in range(int(DUR / beat)):
    at = b * beat
    if at >= DUR:
        break
    remain = N - int(at * SR)
    place(dr, drum_kick(min(remain, int(0.5 * SR))) * 0.9, at)
    if b % 4 in (1, 3):
        place(dr, drum_snare(min(remain, int(0.3 * SR))) * 0.7, at)
    for s in range(2):
        ha = at + s * beat / 2
        if ha < DUR:
            place(hatL, drum_hat(min(N - int(ha * SR), int(0.06 * SR))) * 0.22, ha)
    if b % 8 == 7:
        place(hatL, drum_hat(min(N - int(at * SR), int(0.35 * SR)), 0.3, False) * 0.3, at)

bass = np.sin(2 * np.pi * 55 * t) * (0.6 + 0.4 * np.abs(np.sin(2 * np.pi * 2 * t)))
bass = (bass + 0.35 * np.tanh(3 * bass)) * 0.28
g1 = highpass(lowpass(np.tanh(3.2 * (saw(110) + saw(110 * 1.005) + 0.6 * saw(220))) * 0.30, 6500), 120)
g2 = highpass(lowpass(np.tanh(3.2 * (saw(146.8) + saw(146.8 * 0.995) + 0.6 * saw(293.7))) * 0.28, 6500), 120)
lead = highpass(np.tanh(2.5 * saw(440 + 8 * np.sin(2 * np.pi * 5 * t))) * 0.22, 300)
rock = stereo(
    dr * 0.8 + hatL + g1 + bass * 0.7 + lead * 0.4,
    dr * 0.8 + np.roll(hatL, 45) + g2 + bass * 0.7 - lead * 0.3,
)
rock = rock / np.max(np.abs(rock)) * 0.62
rock[t >= 6.0] *= 1.18
write("rock.wav", rock, "music", "dense rock: drums, bass, two saw guitars, lead, chorus lift")

# ── 3. bass heavy ─────────────────────────────────────────────────────────────────────
sub = np.zeros(N)
for f in (40.0, 60.0, 80.0):
    sub += np.sin(2 * np.pi * f * t + np.sin(2 * np.pi * 0.25 * t)) * (0.5 if f == 40 else 0.35)
sub = sub * (0.55 + 0.45 * (np.sin(2 * np.pi * 0.5 * t) > 0))
kick = np.zeros(N)
for b in range(int(DUR / 0.75)):
    at = b * 0.75
    if at < DUR:
        place(kick, drum_kick(min(N - int(at * SR), int(0.5 * SR)), 42, 0.34), at)
sn = np.zeros(N)
hh = np.zeros(N)
for b in range(int(DUR / 1.5)):
    at = b * 1.5 + 0.75
    if at < DUR:
        place(sn, drum_snare(min(N - int(at * SR), int(0.2 * SR))) * 0.6, at)
for b in range(int(DUR / 0.125)):
    at = b * 0.125
    if b % 4 != 2 and at < DUR:
        place(hh, drum_hat(min(N - int(at * SR), int(0.03 * SR))) * 0.14, at)
bl = sub * 0.8 + highpass(kick, 25) * 0.5
bass_heavy = stereo(bl + hh * 0.4 + sn * 0.4, bl + np.roll(hh, 60) * 0.4 + sn * 0.4)
bass_heavy = bass_heavy / np.max(np.abs(bass_heavy)) * 0.8
write("bass-heavy.wav", bass_heavy, "music", "sub 40/60/80 Hz + trap kick, sparse tops")

# ── 4. bright / harsh ─────────────────────────────────────────────────────────────────
cym = np.zeros(N)
for b in range(int(DUR / 0.5)):
    n = min(N - int(b * 0.5 * SR), int(1.2 * SR))
    i = np.arange(n) / SR
    place(cym, bandpass(rng.standard_normal(n), 4000, 16000) * np.exp(-i / 0.5) * 0.5, b * 0.5)
sawB = np.tanh(4 * (saw(880) + 0.7 * saw(1320) + 0.5 * saw(1760))) * 0.25
sib = np.zeros(N)
for b in range(20):
    n = int(0.18 * SR)
    place(sib, bandpass(rng.standard_normal(n), 5000, 11000) * np.hanning(n) * 0.35, b * 0.5 + 0.2)
br = highpass(cym, 2500) * 0.9 + sawB + sib * 1.6
bright = stereo(br * 0.9 + highpass(sawB, 1000) * 0.2, np.roll(br, 40))
bright = bright / np.max(np.abs(bright)) * 0.7
write("bright-harsh.wav", bright, "music", "cymbals + harsh saw + sibilance; HF-forward source")

# ── 5. dark / dull ────────────────────────────────────────────────────────────────────
pad_d = lowpass(rng.standard_normal(N), 800)
pad_d = pad_d / (np.max(np.abs(pad_d)) + 1e-9) * 0.5
drone = np.sin(2 * np.pi * 55 * t) * 0.4 + np.sin(2 * np.pi * 110 * t) * 0.2
dark = lowpass(pad_d * 0.8 + drone, 1500)
dark = dark / np.max(np.abs(dark)) * 0.5
write("dark-dull.wav", stereo(dark, np.roll(dark, 80)), "music", "lowpassed pad + drone, almost no HF")

# ── 6. transient heavy ────────────────────────────────────────────────────────────────
tr = np.zeros(N)
for b in range(48):
    at = b * (DUR / 48)
    f = [660, 880, 440, 1320][b % 4]
    n = int(0.09 * SR)
    i = np.arange(n) / SR
    x = np.sin(2 * np.pi * f * i) * np.exp(-i / 0.012) * 0.6 + rng.standard_normal(n) * np.exp(-i / 0.0015) * 0.4
    place(tr, x, at)
    if b % 6 == 0:
        place(tr, drum_snare(min(N - int(at * SR), int(0.12 * SR))) * 0.5, at + 0.1)
tr = tr / np.max(np.abs(tr)) * 0.7
write("transients.wav", stereo(tr, np.roll(tr, 55)), "music", "sparse percussive transients, very high crest")

# ── 7. already mastered (hot, low crest) ──────────────────────────────────────────────
am = rock.copy()
am = am / np.max(np.abs(am)) * 0.95
am = np.tanh(1.9 * am) / np.tanh(1.9)

def squash(x, thr=0.80):
    a = np.abs(x)
    c = np.where(a > thr, thr + (a - thr) / (1 + 3 * (a - thr)), a)
    return x * np.divide(c, a + 1e-12)

write("already-mastered.wav", squash(am), "music", "pre-mastered, soft-clipped, low crest")

# ── 8. mono ───────────────────────────────────────────────────────────────────────────
write("mono-acoustic.wav", (ac[:, 0] + ac[:, 1]) / 2, "music", "mono fold of acoustic material")

# ── 9. extremely wide / phasey ────────────────────────────────────────────────────────
mid = (rock[:, 0] + rock[:, 1]) / 2
side = (rock[:, 0] - rock[:, 1]) / 2
sd = bandpass(rng.standard_normal(N), 200, 8000)
sd = sd / (np.max(np.abs(sd)) + 1e-9) * (np.max(np.abs(side)) * 2.2)
ws = side * 0.5 + sd * 0.5
out_l = mid + ws
out_r = mid - ws
for kk in range(4):
    i = int(kk * 2.5 * SR)
    j = min(N, int((kk * 2.5 + 1.2) * SR))
    p = np.sin(2 * np.pi * 330 * t[i:j]) * 0.18
    out_l[i:j] += p
    out_r[i:j] -= p
wide = stereo(out_l, out_r) / 2.1
write("wide-phasey.wav", wide, "music", "decorrelated + anti-phase sides; mono-collapse stress")

# ── 10. lo-fi noisy ──────────────────────────────────────────────────────────────────
prog = bandpass(rock[:, 0] * 0.7 + rock[:, 1] * 0.3, 250, 4500)
hum = np.sin(2 * np.pi * 60 * t) * 0.02 + np.sin(2 * np.pi * 120 * t) * 0.012
hiss = highpass(rng.standard_normal(N), 2000) * 0.012
crk = np.zeros(N)
for c in range(160):
    at = rng.uniform(0, DUR - 0.01)
    n = 60
    i = int(at * SR)
    crk[i : i + n] += rng.standard_normal(n) * np.exp(-np.arange(n) / 12) * 0.2
lofi = prog + hum + hiss + crk
write("lofi.wav", stereo(lofi, np.roll(lofi, 30) * 0.98), "music", "band-limited program + hum, hiss, crackle")

# ── deterministic fixtures ────────────────────────────────────────────────────────────
imp = np.zeros(N)
imp[SR // 2] = 1.0
write("fx-impulse.wav", stereo(imp, imp), "fx", "single-sample impulse at 1 s")

K = np.log(SR / 2 * 0.95 / 20.0) / DUR
inst = 20.0 * np.exp(K * t)
sw = np.sin(2 * np.pi * np.cumsum(inst) / SR) * 0.5
sw = sw / (np.max(np.abs(sw)) + 1e-9) * 0.7
write("fx-sweep.wav", stereo(sw, sw), "fx", "log sine sweep 20 Hz -> Nyquist")

mt_f = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 12000, 16000]
mt = sum(np.sin(2 * np.pi * f * t + i * 0.7) / len(mt_f) for i, f in enumerate(mt_f)) * 0.8
write("fx-multitone.wav", stereo(mt, mt), "fx", "11-tone complex, flat octave ladder")

for f in (40, 50, 60, 80, 100):
    x = np.sin(2 * np.pi * f * t) * 0.5
    write(f"fx-tone{f}.wav", stereo(x, x), "fx", f"{f} Hz tone, stereo")

hl = np.zeros(N)
hr = np.zeros(N)
n1 = int(2.5 * SR)
hl[:n1] = np.sin(2 * np.pi * 440 * np.arange(n1) / SR) * 0.7
hr[n1 : 2 * n1] = np.sin(2 * np.pi * 660 * np.arange(n1) / SR) * 0.7
write("fx-hard-lr.wav", stereo(hl, hr), "fx", "hard-panned L tone then R tone")

corr = np.sin(2 * np.pi * 440 * t) * 0.6
write("fx-correlated.wav", stereo(corr, corr), "fx", "fully correlated stereo")
write("fx-anticorrelated.wav", stereo(corr, -corr), "fx", "180 deg anti-phase stereo")

tb = np.zeros(N)
for b in range(100):
    i = int(b * 0.1 * SR)
    n = 40
    tb[i : i + n] += (1 - np.arange(n) / n) * 0.9 * (1 if b % 2 else -1)
write("fx-bursts.wav", stereo(tb, np.roll(tb, 10)), "fx", "100 transient bursts")

clip = np.clip(np.sin(2 * np.pi * 220 * t) * 2.5, -0.999, 0.999) * 0.95
write("fx-clipped.wav", stereo(clip, clip), "fx", "hard-clipped program (damaged input)")

json.dump(reg_rows, open(os.path.join(OUT, "manifest.json"), "w"), indent=1)
for row in reg_rows:
    d = sf.SoundFile(os.path.join(OUT, row["file"]))
    x = d.read()
    pk = float(np.max(np.abs(x)))
    rms = float(np.sqrt(np.mean(x**2)))
    print(f"{row['file']:24s} ch={d.channels} peak={pk:6.3f} rms={rms:6.4f} crest={20*np.log10(pk/(rms+1e-12)):5.1f} dB")
print("materials:", len(reg_rows))
