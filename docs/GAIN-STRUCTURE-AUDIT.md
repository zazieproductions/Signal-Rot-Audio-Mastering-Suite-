# Gain-structure audit — why the masters come out loud, crushed and harsh

Engine `7.0.0`, branch `arena/01a077e2`, audited 2026-09-06.

This is a first-principles trace of the signal path from decoded source to encoded file,
stage by stage, with the level contribution of each stage **measured** (scripts in the
appendix reproduce every number). It does not retune anything. It identifies the
structural reasons the output is not a transparent, finished-sounding master, ranked by
audible impact.

The short version: the engine does **not** double-normalise, and the offline limiter and
loudness loop are structurally sound. The damage happens **upstream of the limiter**, in
three places the code believes are level-neutral but are not — an undocumented hard
clipper, an undocumented make-up gain, and a "peak-normalised" saturator that raises
level — and then the limiter is asked to finish a signal that has already been flattened.

---

## 1. The signal path as it actually is

```
decodeAudioData ─┐  (browser resamples to the *live* context rate; export re-resamples
                 │   again inside OfflineAudioContext — linear interpolation in Blink)
                 ▼
 AudioBufferSourceNode
   → chain.input
   → TRIM            gain = dbToGain(p.drive)                  0 … +12 dB   ← level enters here
   → MATCH EQ        8 × peaking, Q 1.0, ±3/5/8 dB per band   0 … ~+8 dB   (boost-capable)
   → TONE            6 bands ±12 dB + tilt ±6 dB               0 … ~+20 dB  (boost-capable)
   → MULTIBAND       3 × DynamicsCompressorNode
                       · per-band HIDDEN spec make-up: (1/curve(1.0))^0.6   +0.6 … +17 dB  ← §2.2
                       · optional mbAutoMakeup (off by default)              +0.9 … +2.4 dB
                       · 6 ms fixed look-ahead pre-delay on the WET path only          ← §2.4
                     wet/dry sum (dry is all-pass matched in phase, NOT in delay)
   → STEREO          M/S width 0 … 2.5× side, per-band width, Haas, crossfeed
                     (crossfeed adds up to +0.45 of opposite channel → up to +3 dB sum)
   → CHARACTER       tape head-bump +3.5 dB @ full, hiss/crackle/rumble additive
   → DEPTH           direct + 2 taps (0.28 + 0.22)             up to +3.5 dB on sustained
   → SATURATION      dcBlock → preGain (1−0.35a) → WaveShaper → LP → makeup (1+0.25a)
                       · WaveShaperNode CLAMPS input to [−1, 1] → HARD CLIP at 0 dBFS   ← §2.1
                       · net stage gain is +0.4 … +5 dB, not 0                            ← §2.3
   → chain.output → OfflineAudioContext.destination            (float, no clip)
   ─────────────────────────────── offline-only (render-master.js) ───────────────────────
   → TRANSIENT       ±6 dB differential envelope (after saturation, before limiting)
   → NORMALISE       static gain = target − measured, then …
   → LIMITER         true-peak look-ahead 2.5 ms, Hann-smoothed, release 15/180 ms
     ↺ re-measure, secant-correct, up to 5 passes from a pristine copy   (correct; no double-norm)
   → DITHER (16/24-bit)
   → encode (WAV clamps ±1 after rounding; MP3 → Int16 clamp)
```

Live preview path differs only after `chain.output`: `→ safety DynamicsCompressor
(−1.2 dB, 20:1, hard knee) → post gain (static loudness estimate) → destination`.

### Checked and found **correct**

| Concern                                    | Finding                                                                                                                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Double normalisation                       | No. `normalizeAndLimit` restores a pristine copy before every pass; live `post` gain is monitor-only and never reaches the export.                                               |
| Normalisation before _and_ after limiting  | No. One static gain, then limit, then re-measure. The loop converges (measured: −14 in 1 pass, −11 in 3, −9 in 4).                                                               |
| Limiter overdrive / re-limiting            | No. Each pass limits the unlimited signal.                                                                                                                                       |
| Preset values applied twice                | No. Presets are schema units; one `applyParameters`.                                                                                                                             |
| Stacked saturation make-up vs. output gain | Fixed in 7.0 (separate nodes).                                                                                                                                                   |
| Limiter true-peak detection                | Polyphase sinc, same filter for detect and verify; −0.17 dB residual on the fs/4 case; verify pass trims ≤ 1 dB. Sound.                                                          |
| Limiter release IMD                        | Measured THD on a steady tone 3–6 dB over: −41 dB @ 40 Hz, −54 dB @ 60 Hz, < −150 dB ≥ 100 Hz. Slower release (80/400 ms) gains ~9 dB at 40 Hz. Acceptable, not a primary cause. |
| Hard clip at encode                        | Only after limiting; ceiling −1 dBTP means it never engages on a well-formed render.                                                                                             |

So the "loud, crushed, harsh" complaint is **not** a bug in normalisation or limiting.
It is upstream.

---

## 2. Defects, ranked by audible impact

### 2.1 ❗ The saturation stage is a hard clipper at 0 dBFS — even at `sat = 0`

`buildSaturation` creates a `WaveShaperNode` and leaves it in the path permanently with
`IDENTITY_CURVE` when `sat = 0`. Per the Web Audio specification, a WaveShaper's input is
**clamped to [−1, +1]** before the curve lookup; any sample outside that range maps to the
curve endpoint. With an identity curve whose endpoints are ±1 that is, exactly, a hard
clipper at 0 dBFS. With a tanh curve the tail is soft _inside_ ±1 but still hard-stops at
±1.

Nothing upstream keeps the signal under 0 dBFS. `drive` is 0…+12 dB, the tone EQ can
add +12 dB per band, the multiband adds hidden make-up (§2.2), and modern sources arrive at
−0.3 dBFS sample peak. Measured on a −0.3 dBFS dense programme at `sat = 0`:

| pre-shaper gain                                | samples hard-clipped | peaks flattened by |
| ---------------------------------------------- | -------------------- | ------------------ |
| +0.5 dB                                        | 0.007 %              | 0.2 dB             |
| +1.2 dB (Streaming −14, Modern Country)        | 0.17 %               | 0.9 dB             |
| +2.5 dB (Hip-Hop, Drum & Bass)                 | 0.68 %               | 2.2 dB             |
| +3.0 dB (Club/EDM, Industrial, Noise Wall)     | 0.96 %               | 2.7 dB             |
| +6.0 dB (drive + EQ + hidden make-up, typical) | 2.7 %                | 5.7 dB             |

Those percentages are _drum hits_. Every transient the mix has is being squared off
before the limiter ever sees it. That is where the harshness and the loss of punch come
from: the true-peak limiter is then given a signal whose peaks are already flat-topped,
and it does the polite thing with a signal that has already been damaged.

The stage's own comment says the curve is "peak-normalised, so saturation is character,
never level". That is true of the _curve_; it is not true of the _node_.

Also: `oversample = '4x'` makes the clip happen at 4× rate — it reduces aliasing of the
clip, it does not remove the clip.

**Structural fix (not a retune):** headroom must be guaranteed at the shaper input. Either
(a) scale the curve domain so the shaper sees the signal ÷ K and multiplies back by K
(e.g. K = 4 → +12 dB of shaper headroom, curve generated over [−K, K]), or (b) bypass the
WaveShaper entirely (disconnect, not identity curve) when `sat = 0` _and_ apply (a) when it
is engaged. The whole chain should run at a defined internal reference (e.g. −6 dBFS
nominal into colour stages) with the limiter's normalisation gain absorbing the offset —
this is how every professional chain is staged.

### 2.2 ❗ Undocumented +0.6 … +17 dB make-up inside every multiband band

`DynamicsCompressorNode` applies a **fixed, non-configurable make-up gain** equal to
`(1 / curve(1.0))^0.6` — a specification requirement, present in every browser. The
engine treats the node as a pure downward compressor and adds its _own_ optional
`mbAutoMakeup` on top. The hidden gain, from `bandAmountToSettings`:

| amount | threshold | ratio | hidden node make-up | + `mbAutoMakeup` | stacked  |
| ------ | --------- | ----- | ------------------- | ---------------- | -------- |
| 15     | −5.4 dB   | 1.6:1 | **+1.2 dB**         | +1.1 dB          | +2.3 dB  |
| 20     | −7.2 dB   | 1.8:1 | **+1.9 dB**         | +1.3 dB          | +3.3 dB  |
| 30     | −10.8 dB  | 2.2:1 | **+3.5 dB**         | +1.6 dB          | +5.2 dB  |
| 35     | −12.6 dB  | 2.4:1 | **+4.4 dB**         | +1.7 dB          | +6.1 dB  |
| 50     | −18 dB    | 3:1   | **+7.2 dB**         | +2.0 dB          | +9.2 dB  |
| 100    | −36 dB    | 5:1   | **+17.3 dB**        | +2.4 dB          | +19.7 dB |

Consequences, in order:

1. It pushes the signal into the 0 dBFS clip of §2.1 (Club/EDM: drive +3 + mbLow 20
   → +4.9 dB before any EQ).
2. It is applied **per band**, so a preset with `mbLow: 30` (Synthwave, Drum & Bass) gets
   +3.5 dB of low end it never asked for; `Hyperreal` (35/25/30) gets +4.4/+2.7/+3.5 dB —
   a smile curve nobody drew. This is the "tonal balance" complaint.
3. With `mbMix < 100` the boosted wet path is summed against an un-boosted dry path, so the
   parallel-mix control changes _level and tone_ as well as dynamics.
4. `readGainReduction` meters show only the reduction, so the UI reports "−2 dB" while the
   band is net +1.5 dB louder.
5. The live safety compressor (thr −1.2, 20:1) has the same hidden +0.68 dB, so the
   monitor path can sit _above_ the intended ceiling.

**Structural fix:** compute the spec make-up analytically from (threshold, knee, ratio) and
place a compensating `1 / makeup` gain node after each compressor. It is deterministic
and exact — no measurement needed. Then `mbAutoMakeup` becomes the _only_ make-up, as
the code already believes it is.

### 2.3 The saturator raises level by up to +5 dB RMS (documented as 0 dB)

Independent of the clip, the stage is not gain-neutral. The curve is peak-normalised at
x = ±1 only; its _small-signal slope_ is `tanh'(0)·k·blend` > 1, and music lives in the
small-signal region. Measured whole-stage (pre → curve → post) gain on a sine:

| sat   | −20 dBFS in | −3 dBFS in |
| ----- | ----------- | ---------- |
| 4 %   | +0.14 dB    | +0.07 dB   |
| 10 %  | +0.42 dB    | +0.20 dB   |
| 20 %  | +0.99 dB    | +0.51 dB   |
| 35 %  | +2.0 dB     | +1.1 dB    |
| 50 %  | +3.1 dB     | +1.8 dB    |
| 100 % | **+5.2 dB** | +3.4 dB    |

It is also _level-dependent_ (quiet passages get more gain than loud ones), i.e. it is a
second, uncontrolled upward compressor. The `postGain = 1 + 0.25a` make-up is on top of a
curve that already gains; the pre/post pair is not matched. **Fix:** normalise the curve
to unity small-signal slope (divide by `d/dx` at 0), and make the make-up stage
`1/preGain` exactly, so the stage is 0 dB for small signals and the only effect of `sat` is
harmonic content and peak rounding.

### 2.4 Multiband parallel mix is a 6 ms comb filter

`DynamicsCompressorNode` has a fixed **6 ms look-ahead pre-delay** (Blink `kPreDelay =
0.006f`; the spec lists the node as having latency). The multiband's dry path is
all-pass-matched in _phase_ to the band sum — the module comment proves the crossover
maths carefully — but it is not delay-matched, so at `mbMix < 100` the wet path arrives
6 ms late. That is a comb with notches at 83, 250, 417, 583 Hz …:

| mbMix                       | notch depth |
| --------------------------- | ----------- |
| 40–60 % (Dimension presets) | −14 dB      |
| 70 %                        | −8 dB       |
| 80 %                        | −4.4 dB     |
| 90 %                        | −1.9 dB     |

Seventeen presets use `mbMix` between 40 and 90 %. The 250 Hz notch is squarely in the
"body" region; the 83 Hz notch is the kick fundamental. The 7.0 audit fixed the phase
comb and introduced (or left) a delay comb. **Fix:** insert a `DelayNode(0.006)` in the
dry path (and verify the constant per browser via an impulse render — it is 6 ms in
Blink and WebKit; Gecko should be measured at startup). Note the same 6 ms applies to
the low/mid/high bands equally, so the _band sum_ is internally consistent.

### 2.5 Transient shaper is in the wrong place and is then erased

`shapeTransients` runs _after_ saturation (where the clip of §2.1 has already removed
the transients it is meant to emphasise) and _before_ the limiter (which then removes
whatever it added). Measured on a dense programme normalised to −10 LUFS:

```
without shaper: crest 8.34 dB, limiter max GR −7.5 dB
transAttack +30: crest 8.36 dB, limiter max GR −7.6 dB   ← +1.7 dB of peaks, 0.02 dB survives
```

The control is effectively inert at competitive loudness and just adds gain reduction.
It should run **first** in the offline stage (before the chain, or at least before any
nonlinear stage), and the limiter should be the only thing between it and the file.

### 2.6 Loudness is asked for before the chain is capable of delivering it

Nine presets target ≥ −11 LUFS; Club/EDM and Industrial target −9. On a 12 dB crest
mix the loop delivers −9 LUFS honestly, but at a cost of **−10 dB max GR, −3.1 dB average
GR over 100 % of samples, crest 12.5 → 7.3 dB**. That is a brickwalled record by any
standard. LANDR/BandLab do not hit −9 by asking a 2.5 ms look-ahead limiter to remove
10 dB; they use (a) a slower, multi-stage approach — soft clipper for the very top of the
transient, then limiter — and (b) they _lower the target_ when the material cannot take
it. The engine already detects the saturation plateau; it does not have a **crest-factor-
aware target**: e.g. cap the delivered target so that average GR ≤ ~2 dB / max GR ≤ ~6 dB
and report the achieved figure. Loudness is the output, not the input.

### 2.7 Presets stack boosts in the region the ear finds harsh

19 of 68 presets carry `air + clarity ≥ +2.5 dB` (Euphoric Peak: air +3.5 on top of tilt
+1.8 ≈ +5 dB above 12 kHz). Every dB of HF boost before a limiter is converted into HF
gain reduction _plus_ whatever harmonic content §2.1 and §2.3 generate — and tanh
harmonics of a 5 kHz presence lift land at 10–15 kHz. This is the harshness that
survives even a good limiter. Not a constants problem per se: the structural answer is
that tonal boosts on a mastering chain should be _gentle and wide_ (Q ≤ 0.7) and the
saturator should see a **pre-emphasis-free** signal (or the saturator moves before the
tone EQ for the HF bands). Also the `harsh` band (2.8 kHz, Q 1.2) is used as a _boost_ in
several presets.

### 2.8 Sample-rate conversion happens twice, linearly

`decodeAudioData` resamples to the **live** `AudioContext` rate (device-dependent,
usually 48 kHz), then `renderChain` plays that buffer into an `OfflineAudioContext` at
the export rate, where Blink/WebKit resample **linearly** (Gecko: Speex). A 44.1 kHz
source exported at 44.1 kHz on a 48 kHz device has therefore been through
44.1 → 48 (browser decoder) → 44.1 (linear) — two conversions, one of them poor, with
imaging products in the top octave. **Fix:** decode with an `OfflineAudioContext` at the
file's native rate (`new OfflineAudioContext(1, 1, fileRate).decodeAudioData` keeps
native rate), render the chain at the source rate, and do any rate change **once**, at
the end, with a windowed-sinc SRC (the polyphase bank in `true-peak.js` is already 80 %
of one). The rendering rate also changes the multiband's 6 ms delay in samples and the
biquad warping near Nyquist, so "export at 96 k" currently sounds different from "export
at 44.1 k" for reasons other than bandwidth.

### 2.9 Smaller items

- **Stereo width is unbounded in level.** `width` up to 2.5× and `spread` add up to
  +1.6× on top; side energy +8 dB with no side compression and no side ceiling → the
  linked limiter ducks the _mid_ to control _side_ peaks; image pumps inward on hits.
- **Crossfeed sums in level.** `crossfeed = 1` adds 0.45 of the opposite channel (low-
  passed) — up to +3 dB of correlated low-mid before the limiter.
- **Depth taps are in the mono sum.** 0.28 + 0.22 direct-added early reflections give
  +3.5 dB comb gain at some frequencies and the depth stage runs on the _whole_ mix,
  including sub. (The HP at 180 Hz helps; the level is not compensated.)
- **Character head-bump** is +3.5 dB at full `tape`, ahead of the clip in §2.1.
- **Live preview lies about level**: the monitor's safety compressor has its own hidden
  make-up and no true-peak detection, so what the user tunes by ear is not what exports.
- **Limiter release** 15/180 ms with a 50 ms blend is reasonable but single-band; a
  dedicated low-frequency pre-stage (or a longer release when reduction is dominated by
  < 100 Hz content) would remove the remaining −41 dB THD at 40 Hz.

---

## 3. Cumulative gain — a worked example (`Club / EDM`)

```
source            −0.3 dBFS peak, −12.7 LUFS, crest 12 dB
trim  +3.0        peaks +2.7 dBFS  (already over 0 dBFS)
air +1.8, clarity +1     HF peaks up to +5 dBFS
mbLow 20  hidden makeup  +1.9 dB on the low band     → kick/bass peaks ≈ +6 dBFS
width 1.1               side +0.8 dB
sat 10 %               stage gain +0.2 … +0.4 dB, then HARD CLIP at 0 dBFS
                        → 2.7 % of samples clipped, peaks flattened by ~3.4 dB
normalise → −9 LUFS    +8.6 dB more
limiter                 −10 dB max GR, −3.1 dB average, 100 % of samples in reduction
result                  −9 LUFS, −1 dBTP, crest 7 dB, transients pre-flattened by a clipper
```

Every number on the way in is positive, no stage owns headroom, and the only device that
is allowed to say "no" (the limiter) is the last one — after a clipper it does not know
about.

---

## 4. What a correct gain architecture looks like

1. **Decode at native rate. Render at native rate. SRC once, at the end, with a proper
   filter.**
2. **Define an internal reference** (e.g. −12 dBFS RMS / −6 dBFS peak nominal) and pin
   the _input_ of the chain to it by measuring the source once (the analysis pass already
   exists) and applying a static input trim. `drive` becomes a _user offset from
   reference_, not absolute gain.
3. **Every stage is unity-gain by construction**: compensate the DynamicsCompressor spec
   make-up analytically; normalise the saturation curve to unity slope; delay-match the
   multiband dry path; width and crossfeed are constant-power.
4. **No nonlinear stage may see > 0 dBFS**: give the shaper explicit headroom (scale its
   domain), and never leave a WaveShaper in the path when unused.
5. **Transient shaping before colour**, limiting last, nothing between them.
6. **Loudness is a result, not an input**: the normalise/limit loop should carry a
   crest-factor-aware cap (max average GR / max peak GR) and deliver the loudest _clean_
   result at or below the target, stated in the report.
7. **Preview parity**: the live safety compressor must be make-up-compensated so what the
   user tunes is what exports (the offline TP limiter cannot run live; but the level can
   at least be honest).

Items 3, 4 and 5 are the ones that make the difference between "crushed" and "finished".
None of them is a constant.

---

## Appendix — reproduction

All measurements were produced with the pure-JS modules (no browser), at 48 kHz:

- `limitTruePeak` THD on tones; `normalizeAndLimit` on a synthetic dense programme
  (kick + bass + noise bed + snare, −0.3 dBFS, 12 dB crest) at −14/−11/−9 LUFS.
- WaveShaper clamp emulated per spec (`clamp(x, −1, 1)` → curve lookup) with
  `makeSaturationCurve` / `saturationGainStaging` / `IDENTITY_CURVE`.
- DynamicsCompressor make-up computed per spec §1.19.4: `(1 / curve(1.0))^0.6`.
- Comb depth: `20·log10(|w − d| / (w + d))` for a 6 ms wet/dry offset.
- Chromium constant: `third_party/blink/renderer/platform/audio/dynamics_compressor.cc`,
  `kPreDelay = 0.006f`.
