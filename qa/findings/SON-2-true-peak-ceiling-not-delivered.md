## SON-2 — The limiter's "verified" true-peak ceiling is not met on the delivered file

**SONIC ISSUE**
Masters that report `ceilingRespected: true` and `achievedTruePeakDbtp: -1.00` are delivered above
their ceiling. Independent band-limited reconstruction of the exported file puts the real peak up
to **0.94 dB over** the declared ceiling. Sample-peak meters see nothing wrong (sample peak is often
1–2 dB _lower_ than the ceiling), so this only shows up downstream: on a DAC, in an AAC/OGG
transcode, or on a platform that enforces −1 dBTP. The renders that miss worst are the HF-forward
and saturated ones — exactly where inter-sample peaks live.

**MATERIAL**
`qa` fixtures: `dark-dull.wav`, `rock.wav`, `transients.wav`, `bright-harsh.wav`, `acoustic.wav`.
Reproduced on 61 of 144 preset renders and 42 of 88 stress renders.

**SETTINGS**
Any preset with `ceiling: -1`. Examples (all with defaults elsewhere unless listed):

    air 12, presence 12, tilt 6, sat 40, target -14   → dark-dull.wav
    Reference HD, target -8                            → rock.wav
    sat 100, target -14                                → transients.wav

**REPRO**

    node qa/scripts/render.mjs --jobs qa/jobs-verify.json --out /tmp/o
    # then compare with any accurate TP meter, e.g. ffmpeg -af ebur128=peak=true, or:
    python3 - <<'EOF'
    import numpy as np, soundfile as sf
    x, sr = sf.read('/tmp/o/V-hfmax-dark.wav', always_2d=True); x = np.asarray(x)
    for os_ in (4, 8, 16, 32):
        L = x.shape[0]; N = L*os_
        X = np.fft.rfft(x[:,0]); Y = np.zeros(N//2+1, complex); Y[:len(X)] = X
        y = np.fft.irfft(Y, n=N)*(N/L)
        print(os_, 20*np.log10(np.max(np.abs(y))))
    EOF

**MEASUREMENTS** (exact band-limited reconstruction; stable across oversampling factors, so it is
not an interpolation artifact — a 1 kHz sine at 0 dBFS and the fs/4 ±45° worst case both read 0.00 dB)

    file                 ceiling  claimed  samplePk   TP@4x  TP@8x TP@16x TP@32x   overrun
    V-hfmax-dark           -1.0    -1.00     -2.86   -0.06  -0.06  -0.06   -0.06    +0.94 dB
    V-l8-rock              -1.0    -1.00     -1.00   -0.62  -0.62  -0.62   -0.62    +0.38 dB
    V-sat-trans            -1.0    -1.00     -1.00   -0.57  -0.57  -0.55   -0.55    +0.43 dB

    61/144 preset renders and 42/88 stress renders over their declared ceiling
    median overrun +0.26 … +0.30 dB, worst +0.94 dB, `ceilingRespected: true` in every single case
    `correctionTrimDb: 0` in every case above (the verify pass believed it was already compliant)

**EXPECTED**
The verify pass in `src/audio/render/limiter.js` should either (a) use a meter at least as accurate
as the one a delivery will use, and/or (b) leave an explicit safety allowance, and (c) report
`ceilingRespected: false` when the delivered file exceeds the ceiling. `docs/TRUE-PEAK-LIMITER.md`
and the module header describe 0.05 dB of slack on the grounds that "the detector and the verifier
use the same filter, so any residual is numerical rather than structural" — but the same module's
own documentation records that its 4× / 12-tap-per-phase filter under-reads the fs/4 worst case by
0.168 dB, so the residual is _structural_, not numerical, and on program material it is much larger.
The corrective trim is additionally clamped to −1 dB (`Math.max(trimDb, -1)`), so a >1 dB miss
could never be fixed even if it were detected.

**ACTUAL**
Self-verification with the under-reading filter, 0.05 dB slack, and a hard −1 dB trim bound. The
render report therefore asserts compliance it has not established, and the file that ships exceeds
the ceiling the user asked for.

**SEVERITY**
HIGH. It does not damage the sound by itself (0.3–0.9 dB of level), but it breaks the one promise a
mastering export has to keep, and it breaks the honesty of the report — which is the report's whole
purpose. Note for whoever fixes it: _do not_ fix it by making the limiter clamp harder; trim the
static make-up (or move the limit target to `ceiling − allowance`) so transparency is not traded for
the number.
