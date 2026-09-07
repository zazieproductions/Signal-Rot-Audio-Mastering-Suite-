#!/usr/bin/env bash
# Regenerate the small, quotable evidence tables behind qa/findings/*.
#   npm i                                            (node-web-audio-api must be present)
#   LD_LIBRARY_PATH=/home/user/alsastub bash qa/scripts/evidence.sh
# Output: qa/results/evidence/*.md
set -u
OUT=${1:-qa/results/evidence}
MAT=${QA_MAT:-/home/user/qa/materials}
PY=${QA_PY:-python3}
W=${TMPDIR:-/tmp}/qa-evidence
mkdir -p "$OUT" "$W/materials" "$W/dump"
[ -d "$MAT" ] || { echo "materials missing: generate with  "$PY" qa/scripts/gen_materials.py"; exit 1; }

echo "== stereo section, neutral parameters, isolated ==" > "$OUT/stereo-section.md"
node qa/scripts/isolate.mjs --section stereo --case mono1,mono2,corr,anti >> "$OUT/stereo-section.md" 2>&1

echo "" >> "$OUT/stereo-section.md"
echo "== anti-phase / in-phase impulse through the neutral stereo section: |H(f)| of side and mid ==" >> "$OUT/stereo-section.md"
node qa/scripts/isolate.mjs --section stereo --case imp-anti --dump "$W/dump" >> "$OUT/stereo-section.md" 2>&1
node qa/scripts/isolate.mjs --section stereo --case imp-mid --dump "$W/dump" >> "$OUT/stereo-section.md" 2>&1
DUMP="$W/dump" "$PY" - >> "$OUT/stereo-section.md" 2>&1 <<'PY'
import numpy as np, json, os
d = os.environ['DUMP']
freqs = [40, 80, 150, 250, 440, 1000, 2000, 4000, 6000, 10000, 14000, 18000]
for name, label in [('stereo_imp-anti', 'SIDE path (mid = 0)'), ('stereo_imp-mid', 'MID path (side = 0)')]:
    p = f'{d}/{name}.f32'
    if not os.path.exists(p):
        print('missing', p); continue
    h = json.load(open(f'{d}/{name}.hdr.json'))
    x = np.fromfile(p, dtype=np.float32).reshape(h['n'], h['ch'])
    sig = (x[:, 0] - x[:, 1]) / 2 if 'anti' in name else (x[:, 0] + x[:, 1]) / 2
    X = np.abs(np.fft.rfft(sig)); f = np.fft.rfftfreq(h['n'], 1 / h['sr'])
    print(f"\n{label}")
    print("  " + ", ".join(f"{fr} Hz: {20*np.log10(X[int(np.argmin(abs(f-fr)))]+1e-12):+.1f} dB" for fr in freqs))
    print(f"  total impulse energy {10*np.log10(np.sum(sig**2)+1e-20):+.2f} dB (unity pass-through = 0.00)")
PY

echo "== full-chain transparency: schema defaults vs fully-bypassed vs flagship ==" > "$OUT/transparency.md"
cat > "$W/transp.json" <<EOF
[
 {"id":"T-mono-defaults","src":"mono-acoustic.wav","params":{"normalize":false}},
 {"id":"T-mono-refhd","src":"mono-acoustic.wav","preset":"Reference HD"},
 {"id":"T-stereo-defaults","src":"acoustic.wav","params":{"normalize":false}},
 {"id":"T-stereo-bypassed","src":"acoustic.wav","params":{"normalize":false},
  "bypass":{"match":true,"tone":true,"multiband":true,"stereo":true,"character":true,"depth":true,"saturation":true}}
]
EOF
node qa/scripts/render.mjs --jobs "$W/transp.json" --out "$W/transp" --mat "$MAT" > /dev/null 2>&1
MATDIR="$MAT" WDIR="$W" "$PY" - >> "$OUT/transparency.md" 2>&1 <<'PY'
import json, os, sys
import numpy as np, soundfile as sf
sys.path.insert(0, 'qa/scripts')
from measure import lufs_integrated, stereo_metrics, dc_and_anomaly
src_of = {'T-mono-defaults': 'mono-acoustic.wav', 'T-mono-refhd': 'mono-acoustic.wav',
          'T-stereo-defaults': 'acoustic.wav', 'T-stereo-bypassed': 'acoustic.wav'}
print(f"{'render':22s} {'src LUFS':>9s} {'out LUFS':>9s} {'Δlevel':>7s} {'src corr':>9s} {'out corr':>9s} {'Δcorr':>7s} {'out DC':>9s}")
for r in json.load(open(os.environ['WDIR'] + '/transp/reports.json')):
    if 'error' in r: continue
    s, _ = sf.read(os.path.join(os.environ['MATDIR'], src_of[r['job']['id']]), always_2d=True)
    x, sr = sf.read(r['output'], always_2d=True)
    s = np.asarray(s); x = np.asarray(x)
    ls, _ = lufs_integrated(s, sr); lx, _ = lufs_integrated(x, sr)
    cs = stereo_metrics(s, sr)['correlation']; cx = stereo_metrics(x, sr)['correlation']
    dc = dc_and_anomaly(x, sr)['dcOffset']
    print(f"{r['job']['id']:22s} {ls:9.2f} {lx:9.2f} {lx-ls:+7.2f} {cs:9.3f} {cx:9.3f} {cx-cs:+7.3f} {dc:9.5f}")
print("\nΔlevel for a fully bypassed chain should be 0.00 dB and out corr should equal src corr.")
PY

echo "== delivered true peak vs declared ceiling (independent 4x/8x/16x/32x reconstruction) ==" > "$OUT/true-peak.md"
node qa/scripts/render.mjs --jobs qa/jobs-verify.json --out "$W/verify" --mat "$MAT" >> "$OUT/true-peak.md" 2>&1
WDIR="$W" "$PY" - >> "$OUT/true-peak.md" 2>&1 <<'PY'
import json, os
import numpy as np, soundfile as sf
def tp(x, sr, osr):
    if x.ndim == 1: x = x[:, None]
    L = x.shape[0]; best = -999.0
    for c in range(x.shape[1]):
        X = np.fft.rfft(x[:, c]); N = L * osr
        Y = np.zeros(N // 2 + 1, dtype=complex); Y[:len(X)] = X
        best = max(best, 20*np.log10(np.max(np.abs(np.fft.irfft(Y, n=N)*(N/L)))+1e-12))
    return best
print("\nfile                 ceiling  claimed  samplePk   true peak @4x @8x @16x @32x          verdict")
for r in json.load(open(os.environ['WDIR'] + '/verify/reports.json')):
    if 'error' in r: continue
    x, sr = sf.read(r['output'], always_2d=True); x = np.asarray(x)
    lim = r['report']['limiter']
    vals = [tp(x, sr, o) for o in (4, 8, 16, 32)]
    over = min(vals) - lim['ceilingDbtp']
    print(f"{r['job']['id']:20s} {lim['ceilingDbtp']:7.1f} {lim['achievedTruePeakDbtp']:8.2f} {20*np.log10(np.max(np.abs(x))):9.2f}  "
          + " ".join(f"{v:+.2f}" for v in vals)
          + f"   {over:+.2f} dB over ceiling; report ceilingRespected={lim['ceilingRespected']}, trim={lim['correctionTrimDb']}")
PY
echo "wrote $OUT"
