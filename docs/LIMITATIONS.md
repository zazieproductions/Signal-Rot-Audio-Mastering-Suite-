# Limitations

Every approximation, every deviation, every thing this software cannot do. Nothing here is
hidden in a footnote.

If you find a claim in the interface or the documentation that is not backed by a test or
qualified here, that is a bug — please report it as one.

---

## Measurement

### The loudness meter is not certified

It reproduces the ITU-R BS.1770-4 K-weighting coefficients to machine precision and gates
per the standard, but it has **not** been validated against the EBU Tech 3341 compliance
material. No compliance claim is made. Validating it, and publishing the results pass or
fail, is on the roadmap.

### K-weighting is designed at the working rate

BS.1770-4 tabulates coefficients at 48 kHz only and is silent on other rates. Signal Rot
uses bilinear design at the source rate with the parameters that reproduce the tables
exactly at 48 kHz — the same approach as ffmpeg's `ebur128`, libebur128 and pyloudnorm.
Measured consequence: under 0.1 LU across 44.1 kHz to 192 kHz.

### Height-channel loudness weights are an assumption

BS.1770-4 defines G for front (1.0), LFE (0.0) and surround (1.41) channels. It does not
define weights for height channels. Signal Rot assumes 1.0. This affects the `bext` loudness
values written into immersive ADM exports.

### The true-peak meter is not the Annex 2 filter

It is a windowed-sinc polyphase interpolator (12 taps per phase, Kaiser β = 8.6), not the
48-tap FIR tabulated in BS.1770-4 Annex 2. Measured error on the standard worst case — a
0 dBTP sine at fs/4 sampled at ±45° — is **−0.168 dB**. The pre-7.0 cubic interpolator
missed the same case by −1.072 dB.

The residual is not a design defect: the sinc series for that signal has 1/n tails and
converges too slowly for any short FIR. Lengthening to 32 taps per phase changes the reading
by under 0.001 dB.

### The live meters are indicators, not measurements

- **Momentary and short-term** are computed from an analyser tap on the already-summed
  stereo bus, with a time-windowed accumulator driven by animation frames. They approximate
  400 ms and 3 s windows; on a heavily loaded machine they read slightly low.
- **True peak** uses a strided 8-tap estimate and is labelled "est." in the interface.
- **RMS** is unweighted and sine-referenced.

Every integrated LUFS, loudness range and true-peak figure that matters comes from the
offline pass, which is the tested implementation.

---

## Processing

### Loudness targets have a hard physical ceiling

A transparent look-ahead limiter cannot exceed a loudness set by the material's crest
factor. Measured on pink noise at a −1 dBTP ceiling:

```
+18 dB → −10.18 LUFS
+22 dB →  −9.80 LUFS
+30 dB →  −9.80 LUFS   ← saturated: more gain buys nothing
```

Signal Rot detects the plateau, stops iterating and reports `targetReachable: false` with an
explanation. It does **not** secretly insert a clipper. Getting louder than this needs
clipping, distortion, or a different mix — and no clipping mode is offered.

### Waveshaper saturation aliases

`WaveShaperNode.oversample = '4x'` is set, but the Web Audio specification does not define
the quality of that oversampling and implementations differ. A tanh-family curve generates
harmonics without limit, so 4× is not enough at high drive.

Mitigations: up to −3.1 dB of pre-gain into the shaper with matching make-up, and a
post-shaper low-pass tightening from 22 kHz to 17.5 kHz as drive rises. These **reduce**
audible aliasing; they do not eliminate it. Clearly audible on bright synthetic material
above roughly 20 % saturation. The `Rust` preset uses 32 % and the aliasing is part of the
sound.

A properly oversampled saturator with an anti-imaging filter is on the roadmap.

### The multiband compressors are browser nodes

`DynamicsCompressorNode` is a fixed-topology feed-forward compressor with an
implementation-defined detector and a small amount of undocumented look-ahead. It is used
because it is the only per-sample dynamics processor available without an `AudioWorklet`.

Consequences: the multiband will not sound bit-identical across browsers, the true attack
and release behaviour is not exactly what the ballistics presets nominally say, and the
`reduction` reading is whatever the browser reports.

The crossover around it is exact — that part is tested to 0.00000 dB.

### The transient shaper acts on the onset region, not the onset

The two envelope followers diverge for as long as the slow one is still rising: with a 50 ms
slow attack, roughly the first 40 ms of an event. Measured consequence on a percussive
train: `attack = −80` reduces sample peak by ~1 dB but reduces RMS by ~3 dB. Normal for a
differential-envelope shaper, and why the control is "punch emphasis" and not "peak limiter".

A steady 100 Hz tone still picks up +0.67 dB at `attack = 100`. Irreducible: no envelope
detector can distinguish a 10 ms sine cycle from a 10 ms transient without a window longer
than both.

### Bypass is neutralisation, not disconnection

Rewiring the graph during playback clicks, so bypass sets a module's parameters to neutral
instead. A bypassed multiband or stereo section is still in the signal path. Both are
all-pass in their neutral state — documented and tested, and inaudible.

### The depth engine combs

Two delayed taps mixed with the direct signal is a comb filter by construction. Return
levels are capped at 0.28 so it is a colouration rather than a cancellation, and both taps
are high-passed at 180 Hz to keep it out of the sub region. It is not a reverb and does not
claim to be.

### Reference matching moves eight EQ bands

It cannot transfer arrangement, performance, dynamics, stereo image, saturation or any of
the decisions that actually distinguish one master from another. Two tracks with different
instrumentation have genuinely different correct tonal balances.

The confidence score exists to say so. Below about 0.6, the curve is chasing an arrangement
difference and should be treated as information rather than a target.

---

## Character engines

**None of this is a tape-machine model.** A tape model needs hysteresis (Jiles-Atherton or
similar), bias, record/playback head gap loss, self-erasure and speed-dependent
equalisation. Signal Rot has:

| Engine              | What it is                                                        |
| ------------------- | ----------------------------------------------------------------- |
| Wow, flutter, drift | Three sine LFOs modulating a delay line                           |
| Head bump           | A peaking filter at 60 Hz                                         |
| HF roll-off         | A low-pass                                                        |
| Hiss                | Seeded Gaussian noise, high-passed                                |
| Crackle             | Seeded sparse impulses with a heavy-tailed amplitude distribution |
| Rumble              | Seeded brown noise, band-limited and DC-removed                   |

It sounds like degraded media, which is the point of the aesthetic. Calling it an emulation
would be a lie.

The noise beds are 12-second loops. On a track longer than that, the loop repeats. Audible
only on the crackle bed at high vinyl settings, where the repeat is a rhythmic pattern.

---

## Immersive

### These are synthesised channel beds

Stereo contains no height information and no discrete surround content. The additional
channels are decorrelated, filtered derivations of the side signal. It is a creative
up-mix, and describing the height channels as recovered content would be false.

### The ADM is not a Dolby Atmos master

Every channel is `typeDefinition="DirectSpeakers"` — a fixed loudspeaker bed. There are no
audio objects, no positional automation, no object metadata. An ADM BWF _can_ be an ingest
format for licensed Atmos tooling; it is not itself a certified deliverable.

### The ADM is structurally validated, not schema-validated

Every CI run parses the exported `axml` with an **independent** validator that shares no
code with the writer (`tools/export-validation/adm-validate.js`) and checks namespaces,
element nesting, required attributes, BS.2076 ID grammar, `typeLabel` ⇄ `typeDefinition` ⇄
ID-digit agreement, cross-reference resolution, DirectSpeakers semantics, coordinate
ranges, `speakerLabel` ⇄ azimuth agreement, and `chna` ⇄ `axml` ⇄ `fmt` consistency. That
is what "structurally validated" means here, and it is genuinely established.

It has **not** been validated against the normative ITU-R BS.2076 XSD. The ITU does not
license the schema for redistribution, so this repository cannot vendor one and CI cannot
download one; the tooling reports the check as _not attempted_ rather than skipping it
quietly. Point `npm run validate:adm -- --xsd <path>` at your own licensed copy to close
the gap locally.

It has also **not** been ingested into the Dolby Atmos Renderer, the Sony 360 Reality
Audio suite, or an MPEG-H authoring tool as part of CI. That remains the single most
valuable manual check to perform on a delivery.

See `docs/EXPORT-INTEROPERABILITY.md` for exactly what is and is not established.

### The binaural monitor is fixed and generic

Not head-tracked. Not personalised. It uses the browser's built-in HRTF dataset, which
differs between engines, so the same project sounds different in Chromium and Safari. It is
useful for confirming that surround and height content exists and is on the correct side.
It is not a substitute for the room.

### Decorrelation is delay plus all-pass

Cheap, phase-safe at the delays used, and it needs no impulse-response library. It is not a
true decorrelation filter bank and it does not produce the diffuse field a proper one would.

### Non-standard layouts need their channel map

9.1.6 has top-middle speakers with no `WAVEFORMATEXTENSIBLE` bit; Sonic Lab 20.4 is not a
standard layout at all. Both are written with `mask: 0`, which means "routing is described
elsewhere". **Always deliver the exported channel map with those files.**

---

## Export

### The container is not the limit — the browser is

RIFF size fields are unsigned 32-bit, so a file above 4 GiB cannot be described by a plain
RIFF header. Signal Rot now **promotes the container** rather than refusing: `BW64`
(ITU-R BS.2088) by default, `RF64` (EBU Tech 3306) on request, with a correct 28-byte
`ds64` chunk carrying the real 64-bit sizes and the `0xFFFFFFFF` sentinel in the 32-bit
fields. Small files stay ordinary `RIFF`, because an `RF64` FourCC turns away readers that
predate Tech 3306. **A wrapped 32-bit size is never written.**

That said, writing RF64 headers is necessary but not sufficient. Every export path
materialises the whole file in a single `ArrayBuffer` before handing it to `Blob`, and
browsers cap that well below 4 GiB — Chromium's default is around 2 GiB and Safari's is
lower. The writer therefore refuses above roughly 2 GiB with a message that says plainly
that the _container_ supports the size and the _browser_ does not.

Practical ceiling: about 10 minutes of 32-bit float stereo at 192 kHz, or about
25 minutes of 24-bit 7.1.4 at 48 kHz. Lifting it needs a streaming writer (File System
Access API with incremental chunk emission), which is not implemented.

### Everything is in memory

Decode, render and encode all hold the full programme. A render allocates roughly
`channels × length × 4` bytes per intermediate copy. Guards warn at 15 minutes and 400 M
samples, and refuse above 512 MB of source or 60 minutes.

Streaming render is on the roadmap; it would lift this ceiling substantially.

### MP3 is a convenience, not a delivery format

CBR 320 kbit/s through a JavaScript port of LAME. Offered for references and revisions.
A lossy decoder can also overshoot its encoder input by around 1 dB, which is why the
default ceiling is −1.0 dBTP.

### Ceiling compliance is verified before encoding, not after

The verification pass measures the finished float buffer. It does not measure:

- The file after lossy encoding — an MP3 or AAC decoder can exceed the encoder input
- The file after resampling outside Signal Rot

Export at your delivery rate, and leave headroom for lossy distribution.

### Noise shaping is not psychoacoustic

The `shaped` dither mode is a plain second-order error-feedback shaper with a
`(1 − z⁻¹)²` noise transfer function. It is **not** POW-R, not UV22, not the
Lipshitz/Vanderkooy E-weighted minimum-audibility curve. Roughly 6–8 dB of perceived
improvement over flat TPDF, not the ~15 dB a high-order optimised curve achieves. The UI
calls it "2nd-order noise shaping" and never "psychoacoustic".

### Batch export depends on sequential downloads

Browsers rate-limit or block repeated programmatic downloads. There is a 450 ms pause
between files; some browsers still refuse after several. Batch is best for a handful of
files, not for fifty.

---

## Reproducibility

A render is **bit-reproducible within one browser engine** given the same engine version,
the same parameters and the same texture seed. It is **not** reproducible across engines,
because `DynamicsCompressorNode`, `WaveShaperNode` oversampling and `PannerNode` HRTF are
all implementation-defined.

The render report states this in its `reproducibility` block.

---

## Interface

- The live monitor omits the transient shaper and uses a `DynamicsCompressorNode` safety
  limiter instead of the real true-peak limiter. Both are badged in the interface and listed
  in the About tab.
- The waveform peak envelope is cached per file per canvas width; resizing recomputes it,
  which is briefly visible on a long file.
- The speaker map only redraws when the Immersive tab is open.
- The render loop is capped at ~40 fps and stops entirely when the tab is hidden.

## Accessibility

Improved substantially in 7.0 — the ARIA tab pattern, `role="switch"` toggles,
`aria-valuetext` on every slider, visible focus rings, live regions, a skip link,
`prefers-reduced-motion` and `prefers-contrast` support — but **not audited by a
screen-reader user**. The canvas visualisers have accessible names but no textual
alternative for their content; the numeric meters carry the same information.

## Not implemented, deliberately

| Not implemented                    | Why                                                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Clipping / soft-clip loudness mode | Would let the loudness target be reached by distorting. Out of scope for a tool that measures honestly.                      |
| `AudioWorklet` DSP                 | Requires fetching a module from a URL, which breaks the "open it and it works" property and complicates CSP. On the roadmap. |
| Linear-phase EQ or crossover       | Needs FFT convolution and introduces latency; not worth a second DSP implementation that could diverge from the preview.     |
| Object-based ADM authoring         | Needs an object renderer. On the roadmap.                                                                                    |
| Server-side rendering              | Everything is local by design.                                                                                               |
| Account, cloud storage, telemetry  | Nothing leaves the tab.                                                                                                      |
