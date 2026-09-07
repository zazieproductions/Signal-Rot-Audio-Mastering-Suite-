## SON-1 — A mono source comes back phase-corrupted and loses 12 dB on mono fold-down

**SONIC ISSUE**
Any mono input (mono mixdown, vocal take, vinyl transfer) exports as a hollow, half-cancelling
pseudo-stereo image. The programme ends up _mostly in the side channel_: it sounds thin and
"phaséy" on speakers, and collapses when summed to mono. It is not the user's doing — no stereo
control needs to be touched, because the source-aware adapter silently enables `bassMono`
(`mono-below 0 → 90 Hz (bass-heavy source)` appears in the render report).

**MATERIAL**
`qa/scripts/gen_materials.py` → `mono-acoustic.wav` (mono fold of the acoustic fixture; by
construction correlation +1.00, mono fold-down loss 0.0 dB).
Also reproduced on `fx-anticorrelated.wav`, and on a 440 Hz pure tone in the isolated section test.

**SETTINGS**

- No preset at all — schema defaults + `targetLUFS: -14` → same result.
- `Reference HD` (flagship) → same result.
- `Broadcast Mono First` (the preset _for mono sources_) → worst: correlation −0.82.

**REPRO** (headless, no browser needed — see `qa/README.md`)

    python3 qa/scripts/gen_materials.py                      # writes materials/
    node qa/scripts/render.mjs --jobs qa/jobs-mono.json --out /tmp/o
    python3 qa/scripts/audit.py --dir /tmp/o
    # or isolate the stage:
    node qa/scripts/isolate.mjs --section stereo --case mono1,mono2,corr

**MEASUREMENTS** (independent meter; their report values in brackets)

    causal chain, measured directly on the production functions (mono-acoustic.wav, no preset):
      source channels                        1
      requiresStereo(raw schema defaults)    false        ← would stay mono, correctly
      adaptation notes                       ['mono-below 0 → 90 Hz (bass-heavy source)']
      requiresStereo(after adaptation)       TRUE         ← the engine's own helper forced stereo
      renderChain channel count              2
      renderChain with normalize:false       -23.71 → -18.26 LUFS  (+5.45 dB of pure level error)
    so the corruption and a 5.45 dB level jump both happen with normalisation switched off: this is
    the graph and the adapter, not the loudness loop.

    render (mono-acoustic.wav)        LUFS    corr     mono fold-down    notes
    source, by construction            —      +1.00        0.0 dB
    defaults, target -14              -14.00   -0.71      -11.5 dB       ch 2 (was 1)
    Reference HD (target -15)         -15.06   -0.56       -9.6 dB       mid −0.9 dB, side +5.5 dB above mid
    Broadcast Mono First              -13.00   -0.82      -12.1 dB
    Club / EDM                         -9.04   -0.77      -12.4 dB

Isolated section test, 440 Hz tone, **all stereo parameters at their defaults**:

    input                        out ch   LUFS      corr    L rms    R rms
    mono (1 channel)               2     -7.52    -0.425    -8.5     -11.8   <-- expected: dual mono, 0.00 dB
    identical programme, 2 ch      2     -6.70    +1.000    -9.0      -9.0   <-- correct
    fully correlated L=R           2     -6.70    +1.000    -9.0      -9.0   <-- correct

So the same programme is handled correctly when it arrives as 2 channels and corrupted when it
arrives as 1 channel. The side channel contains a delayed, polarity-flipped copy of the
programme (measured best-fit: lag 496 samples ≈ 10.3 ms, gain −1.2×).

**EXPECTED**
A mono source with no stereo processing requested either stays mono (`requiresStereo` is
documented as exactly this) or is duplicated to dual mono at the graph input and passes through
at unity. `renderChain` chooses the render channel count (`source.numberOfChannels === 1 &&
!requiresStereo(p) ? 1 : 2`) and then hands a possibly-mono signal to a graph whose stereo and
multiband sections assume two channels: the M/S encode is fed by a `ChannelSplitterNode`, and a
1-channel signal arriving at an `'explicit'`/`'discrete'` splitter is _padded with silence_, not
duplicated — so `mid = 0.5·L` and `side = 0.5·L` rather than `side = 0`.

**ACTUAL**
The same programme is handled correctly when it arrives as 2 channels and corrupted when it arrives
as 1 channel. Causal chain, verified in the reports:

1. `renderMaster` runs the source-aware adapter first, and on a mono bass-heavy file the adapter
   decides `mono-below 0 → 90 Hz (bass-heavy source)` — i.e. it turns bass-mono **on** for a source
   that has no stereo field to protect.
2. That makes `requiresStereo(effective)` true, so `renderChain` renders **2 channels from a mono
   source** and hands the 1-channel signal to the M/S matrix, whose `ChannelSplitterNode` sees
   silence on input 1. `mid` and `side` both become `0.5·L` instead of `side = 0`.
3. The decode therefore produces `L' = L`, `R' = 0`-ish, and after the following stages the master
   is a decorrelated, left-biased image: correlation +1.000 → −0.709, mono fold-down −11.5 dB.

A mono input should be a no-op for the stereo section. Verified by feeding the section a
hand-built dual-mono version of the same signal (`mono2`): 0.00 dB, correlation exactly +1.000, fold
loss 0.00 dB.

**SEVERITY**
HIGH as an engine defect; BLOCKER for the mono/restoration use case (`Broadcast Mono First`).

**Suggested fix (not prescriptive)**
Up-mix once, explicitly, at the graph input when `channels === 2` and the source is mono
(merge/duplicate into both channels before `buildMasteringChain`'s consumers), so nothing
downstream depends on the engine's discrete up-mix rules. Add an integration assertion: mono in
→ out is dual mono within 1 sample and mono fold-down loss < 0.1 dB.
