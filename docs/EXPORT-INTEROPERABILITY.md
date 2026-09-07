# Export interoperability

**Signal Rot should not have to trust itself to prove that its own files are valid.**

Everything in this document exists to make that literally true. The validation layer
described here imports nothing from Signal Rot's encoders, parses the specifications
independently, and cross-checks against FFmpeg — a third-party implementation with no
knowledge of, or sympathy for, this project's assumptions.

---

## Contents

1. [What is actually verified](#what-is-actually-verified)
2. [Terminology, used precisely](#terminology-used-precisely)
3. [Running the validation](#running-the-validation)
4. [The tooling](#the-tooling)
5. [Golden multichannel fixtures](#golden-multichannel-fixtures)
6. [Channel-order verification](#channel-order-verification)
7. [Round-trip validation](#round-trip-validation)
8. [RF64 / BW64](#rf64--bw64)
9. [Delivery profiles](#delivery-profiles)
10. [Delivery packages and manifests](#delivery-packages-and-manifests)
11. [Checksums](#checksums)
12. [Inspecting an export yourself](#inspecting-an-export-yourself)
13. [Remaining limitations](#remaining-limitations)

---

## What is actually verified

Every entry below runs on every CI build against real files produced by the production
writers.

| Property                                | How it is established                                                   | Tool                        |
| --------------------------------------- | ----------------------------------------------------------------------- | --------------------------- |
| RIFF/WAVE structure                     | Independent chunk walk from the RIFF specification                      | `riff-inspect.js`           |
| `fmt ` correctness                      | `blockAlign` and `byteRate` recomputed from first principles            | `riff-inspect.js`           |
| Channel count / sample rate / bit depth | Compared against the fixture index _and_ against ffprobe                | both                        |
| `WAVE_FORMAT_EXTENSIBLE`                | `cbSize`, `wValidBitsPerSample`, GUID tail, mask bit-count              | `riff-inspect.js`           |
| Channel mask correctness                | Mask decoded to speaker names, count checked against `fmt`              | `riff-inspect.js`           |
| Mask = 0 where required                 | Non-standard layouts asserted to advertise 0, not an approximation      | `validate-exports.js`       |
| Interleave order                        | Recovered from the **audio** via identification tones                   | `channel-identification.js` |
| Chunk sizes and padding                 | Every chunk's declared size walked; odd payloads must be padded         | `riff-inspect.js`           |
| `bext`                                  | Length, version, date/time grammar, loudness field decoding             | `riff-inspect.js`           |
| `chna`                                  | Size arithmetic, track indices, UID grammar, uniqueness, ordering       | `riff-inspect.js`           |
| `axml`                                  | Extracted and parsed with an independent XML parser                     | `adm-validate.js`           |
| ADM ID cross-references                 | Every `*IDRef` resolved to a defined element of the right kind          | `adm-validate.js`           |
| ADM `typeLabel` consistency             | Label ⇄ `typeDefinition` ⇄ digits embedded in the ID                    | `adm-validate.js`           |
| DirectSpeakers semantics                | `speakerLabel` present, coordinates in range, polar/Cartesian not mixed | `adm-validate.js`           |
| Coordinate consistency                  | `M+030` must sit at azimuth +30; `U+…` must have positive elevation     | `adm-validate.js`           |
| LFE metadata                            | Low-frequency channels carry a plausible `lowPass` frequency            | `adm-validate.js`           |
| `chna` ⇄ `axml` agreement               | UID sets compared in both directions                                    | `validate-exports.js`       |
| Metadata ⇄ container agreement          | XML `sampleRate`/`bitDepth` vs the `fmt` chunk                          | `adm-validate.js`           |
| Round-trip PCM integrity                | Decoded and compared sample-by-sample within quantisation tolerance     | `riff-inspect.js`           |
| Frame count / no truncation             | Decoded length compared against what was written                        | `validate-exports.js`       |
| Polarity                                | Per-channel correlation must be positive                                | `validate-exports.js`       |
| Peak amplitude                          | Compared before and after, within tolerance                             | `validate-exports.js`       |
| No unexpected silence                   | A channel written with signal must read back with signal                | `validate-exports.js`       |
| External decodability                   | The file is opened by FFmpeg and its report compared                    | `ffprobe`                   |
| RF64/BW64 `ds64`                        | Sentinel, 64-bit fields, chunk position, `sampleCount` agreement        | `riff-inspect.js`           |
| Streaming/in-memory writer identity     | Streaming encoder output is **byte-identical** to the in-memory writer, per layout × bit depth, then independently parsed and decoded | `stream-round-trip.test.js` |

**What is not established** is in [Remaining limitations](#remaining-limitations). That
section is the important one.

---

## Terminology, used precisely

These words are not interchangeable and this project does not treat them as such.

| Term                        | Means                                                                                                                                                                        | True here?                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **well-formed**             | The XML parses.                                                                                                                                                              | **Yes** — on every build.                                     |
| **structurally validated**  | Nesting, required attributes, ID grammar, cross-references, DirectSpeakers semantics and coordinate consistency were checked by a validator sharing no code with the writer. | **Yes** — on every build.                                     |
| **interoperability tested** | An independent third-party tool parsed and decoded the file.                                                                                                                 | **Yes** — FFmpeg, on every build.                             |
| **schema validated**        | Validated against the normative ITU-R BS.2076 XSD.                                                                                                                           | **No.** See below.                                            |
| **BS.2076 conformant**      | A formal conformance claim.                                                                                                                                                  | **No.** Structural validation is evidence, not certification. |
| **Dolby Atmos certified**   | Produced and certified by licensed Dolby tooling.                                                                                                                            | **No, and never will be from this toolchain.**                |

### Why not schema validated

The ITU publishes the normative BS.2076 XSD but does not license it for redistribution.
This repository therefore cannot vendor a copy, and CI cannot download one. Rather than
quietly skip the check, the tooling reports it as _not attempted_ and the manifest records
`admSchemaValidated: false`.

If you hold a licensed copy, you can close the gap locally:

```bash
npm run validate:adm -- --xsd /path/to/BS.2076-2.xsd
```

That runs `xmllint --schema` in addition to the structural checks, and the CLI will then
report `schema validated: yes`. The CI gate explicitly asserts that the _automated_ report
never claims it.

### Why not Atmos certified

A Dolby Atmos deliverable — `.atmos` / DAMF / IMF IAB — is produced by licensed Dolby
tooling from a session containing **object** metadata: individual sound sources with
positional automation, rendered at playback time to whatever speaker array is present.

Signal Rot writes a **DirectSpeakers channel bed**: fixed loudspeaker positions, one
`audioChannelFormat` per track, no objects, no automation. An ADM BWF of this kind is a
legitimate and widely-used _ingest_ format for Atmos tooling. It is not itself an Atmos
master, and calling it one would be a lie that costs somebody a delivery deadline.

---

## Running the validation

```bash
npm run validate:exports      # generate fixtures, validate everything, write a JSON report
npm run validate:adm          # ADM structural validation for every layout
npm run fixtures:export       # just write the fixtures to .fixtures/export/
npm run inspect:export -- <file>   # inspect any WAV/BWF/RF64/BW64 file
npm run check                 # lint + unit tests + export validation + build
```

`validate-exports.js` exits non-zero on any failure and writes
`export-validation-report.json`:

```jsonc
{
  "schema": "signal-rot/export-validation/1",
  "tooling": {
    "independentRiffParser": "tools/export-validation/riff-inspect.js",
    "independentAdmValidator": "tools/export-validation/adm-validate.js",
    "externalDecoder": "…/ffprobe",
    "externalDecoderAvailable": true,
  },
  "claims": {
    "riffStructurallyValidated": true,
    "admStructurallyValidated": true,
    "admSchemaValidated": false,
    "interoperabilityTested": true,
    "dolbyAtmosCertified": false,
  },
  "summary": { "total": 30, "passed": 30, "failed": 0, "warnings": 0 },
  "results": [
    /* per-fixture detail */
  ],
}
```

The CI job asserts that `dolbyAtmosCertified` and `admSchemaValidated` are `false` and
that `externalDecoderAvailable` is `true` — so a missing ffprobe fails the build rather
than silently downgrading the guarantee.

---

## The tooling

Everything lives in `tools/export-validation/` and imports **nothing** from
`src/audio/encode` or `src/audio/immersive`, other than the writers it is testing and the
layout tables it is testing them against.

| File                   | Role                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `riff-inspect.js`      | Independent RIFF/RF64/BW64/`bext`/`chna`/`axml` parser and PCM decoder, written from the specifications. Reports findings; never throws on bad input. |
| `adm-validate.js`      | Independent ADM structural validator with its own dependency-free XML parser.                                                                         |
| `ffprobe.js`           | Adapter for FFmpeg. Reports `skipped, with a reason` when unavailable — a missing optional tool is not a passing test.                                |
| `generate-fixtures.js` | Deterministic fixture generation using the _production_ writers.                                                                                      |
| `validate-exports.js`  | The runner. Machine-readable JSON, non-zero exit on failure.                                                                                          |
| `validate-adm-cli.js`  | Standalone ADM validation, with the optional `--xsd` hook.                                                                                            |
| `inspect-cli.js`       | Inspect any file, including files Signal Rot did not produce.                                                                                         |

### Why the parsers are duplicated on purpose

If the writer and the reader shared a constant, a test could only prove they were
_self-consistent_. Two independent implementations of the same specification agreeing is
evidence about the specification. That duplication is the point, not an oversight, and it
is why `tools/export-validation/riff-inspect.js` exists alongside `tests/helpers/riff.js`.

---

## Golden multichannel fixtures

Generated deterministically for:

| Layout         | Channels | Mask            | Notes                                |
| -------------- | -------- | --------------- | ------------------------------------ |
| 5.1            | 6        | `0x3F`          | BS.2051 System B                     |
| 7.1            | 8        | `0x63F`         | Separate side and rear surrounds     |
| 7.1.2          | 10       | `0x_…` standard | Front heights                        |
| 7.1.4          | 12       | standard        | The usual Atmos home bed             |
| 9.1.6          | 16       | **0**           | Top-middle speakers have no mask bit |
| Sonic Lab 20.4 | 24       | **0**           | Venue-specific; not a standard       |

Plus mono, stereo, forced-extensible stereo, and an odd-length file that exercises RIFF
word-alignment padding. Each layout is written at 16- and 24-bit, at 32-bit float up to
12 channels, and as a 24-bit ADM BWF.

Fixtures are deterministic — pure arithmetic content and a pinned `bext` timestamp — so a
fixture's SHA-256 is a stable regression signal. They are written to `.fixtures/export/`,
which is gitignored: they total ~135 MB and are cheap to regenerate.

---

## Channel-order verification

This is the part that catches the mistake that actually happens.

Nothing about a 12-channel WAV tells you by ear whether track 9 is `Ltf` or `Ltr`, and the
mask, the channel map and the ADM document can all agree with one another while all three
disagree with the audio. So the fixtures **put the answer in the audio**:

- Channel _N_ emits _N_ short 1 kHz beeps, with every other channel silent — countable by
  ear at a patchbay.
- Then one tone at `220 × 2^((N−1)/12) Hz` — a chromatic ladder, so adjacent channels are
  a semitone apart.

`identifyChannelOrder()` recovers the index of every channel from the decoded PCM using a
Goertzel single-bin DFT, with no reference to the layout, the mask, or the metadata. The
validator then compares that against what the file claims.

A swap, a rotation, or a left/right flip fails the build. The tests in
`tests/interoperability/round-trip.test.js` deliberately introduce each of those and
assert that they are caught.

The same signal is shipped in delivery packages as `*_channel-identification.wav`, so a
receiving engineer can run the identical check on the actual rig before trusting the
master.

---

## Round-trip validation

For every layout × bit depth: write → decode with the independent decoder → compare.

Tolerance is derived from the format, not guessed. An _n_-bit conversion rounds to the
nearest step of 2⁻⁽ⁿ⁻¹⁾, so the reconstruction error is at most half a step:

| Bit depth    | Tolerance                          |
| ------------ | ---------------------------------- |
| 16-bit       | 1.526 × 10⁻⁵                       |
| 24-bit       | 5.960 × 10⁻⁸                       |
| 32-bit float | 1 × 10⁻⁷ (exact but for denormals) |

Checked per channel: frame count, channel count, sample rate, polarity (correlation must
be positive), peak amplitude, absence of unexpected silence, and worst-case sample error.

---

## RF64 / BW64

Signal Rot previously threw above 4 GiB. It now promotes the container.

| Situation                                     | Container                                          |
| --------------------------------------------- | -------------------------------------------------- |
| Sizes fit in 32 bits                          | `RIFF` — universally readable, unchanged behaviour |
| Sizes overflow, plain WAVE                    | `BW64` by default, `RF64` on request               |
| Sizes overflow, ADM export                    | `BW64` (ITU-R BS.2088 is the ADM-facing spelling)  |
| `container: 'riff'` forced but sizes overflow | **throws**                                         |

The size arithmetic is isolated in `src/audio/encode/riff-layout.js`, deliberately
separate from the encoders, so the 4 GiB boundary can be tested exhaustively without
allocating a 4 GiB buffer. `tests/format/riff-layout.test.js` covers the exact tipping
point, one byte either side, the padding interaction, and the ds64 field values.

`ds64` is written per EBU Tech 3306: first chunk after the form type, 28 bytes, carrying
`riffSize`, `dataSize` and `sampleCount` as 64-bit little-endian, with `tableLength = 0`
(no other chunk this project writes can overflow 32 bits). The 32-bit fields carry the
`0xFFFFFFFF` sentinel. **A wrapped 32-bit size is never written.**

> ### The browser ceiling, and how it is lifted
>
> Writing RF64 headers is necessary but **not sufficient** on its own: a writer that
> materialises the whole file in a single `ArrayBuffer` is capped well below 4 GiB by the
> browser — Chromium's default maximum is around 2 GiB and Safari's is lower. The
> container planner refuses in that situation with a message that says plainly the
> _container_ supports the size and the _browser_ does not.
>
> The direct export paths (the main stereo/master export and every immersive bed export,
> including ADM BWF) now have a **streaming writer** (`src/audio/encode/wav-stream.js`,
> `src/audio/immersive/adm-stream.js`, sinks in `src/audio/encode/stream-sinks.js`). When
> an export is estimated above 256 MiB and the browser exposes the File System Access
> API (`showSaveFilePicker` — Chromium-based browsers), the file is written straight to
> the user-chosen location in 4 MiB blocks. Peak live memory is one block plus a tiny
> header, the planner's ArrayBuffer ceiling is bypassed (only the container's 64-bit
> limit remains), and a failure mid-stream aborts the partial file rather than leaving a
> truncated master behind. Browsers without the API (Firefox, Safari) keep the instant
> download, which stays subject to the ≈2 GiB ceiling; the delivery-package builder also
> stays on the in-memory path (its files are sidecars and metadata, not album-length
> masters).
>
> The streaming and in-memory paths share every byte-producing helper — container plan,
> `fmt `/`bext`/`chna` writers and PCM encoders — so their outputs are byte-identical by
> construction, and that identity is asserted in
> `tests/interoperability/stream-round-trip.test.js` for every layout × bit depth, plus a
> forced-BW64 case, with the assembled streams validated by the same independent parser
> and decoder used for everything else in this document.

Small files continue to use ordinary `RIFF`. There is no standards reason to promote them
and every reason not to: an `RF64` FourCC turns away readers that predate Tech 3306.

---

## Delivery profiles

**A delivery profile never changes the mastering processing.** It selects a container, a
bit depth, a sample rate, a layout and a set of sidecar obligations. The audio out of the
mastering chain for a given set of parameters is identical whichever profile you deliver
under; only the wrapper and the paperwork differ. A test asserts that no profile object
carries a gain, limiter, dither, normalisation, EQ or compression field.

| Profile               | Format             | Rate          | Layout         | Ceiling   | Mandatory sidecars                     |
| --------------------- | ------------------ | ------------- | -------------- | --------- | -------------------------------------- |
| `stereo-distribution` | 24-bit WAV         | 44.1 / 48 kHz | stereo         | −1.0 dBTP | report, manifest                       |
| `film-video`          | 24-bit WAV         | 48 kHz only   | stereo         | −2.0 dBTP | report, manifest                       |
| `high-res-archive`    | 32-bit float       | 48–192 kHz    | stereo         | —         | report, manifest, checksums            |
| `bed-714`             | 24-bit WAVE_EXT    | 48 / 96 kHz   | 7.1.4          | −1.0 dBTP | channel map, ID file, report, manifest |
| `sonic-lab-204`       | 24-bit, **mask 0** | 48 / 96 kHz   | Sonic Lab 20.4 | −1.0 dBTP | all of the above + README + checksums  |
| `adm-ingest`          | ADM BWF            | 48 / 96 kHz   | 7.1.4          | −1.0 dBTP | channel map, ADM XML, README, manifest |

Recommended ceilings are **documentation of the delivery spec**, not instructions to the
limiter. `checkProfileConformance()` reports a rate/depth/layout mismatch as a _deviation_
and an exceeded ceiling as an _advisory_ — the file is still valid, the spec just wanted
more headroom. Conflating those would make the tool cry wolf.

`adm-ingest` is labelled, in the profile, in the manifest and in the README, as an
**ingest/interchange asset and not a certified Atmos master**.

---

## Delivery packages and manifests

`buildDeliveryPackage()` produces a list of files, not a ZIP. Archives in the browser mean
either a dependency or a hand-rolled deflate, and either way the recipient gets one opaque
blob they must unpack before they can see anything. Plainly named files are more robust
across browsers, inspectable the moment they land, and degrade gracefully if one download
fails.

```
song_7.1.4_delivery/
  song_master.wav                    THE MASTER. This is the deliverable.
  song_master.adm.wav                ADM BWF ingest asset (adm-ingest profile only)
  song_adm.xml                       The ADM XML, extracted for inspection
  song_channel-identification.wav    Channel N = N beeps + a tone. Play this FIRST.
  song_channel-map.txt               Human-readable routing
  song_channel-map.json              Machine-readable routing
  song_render-report.json            What the mastering chain did
  song_delivery-manifest.json        The auditable record
  README-delivery.txt                START HERE
  SHA256SUMS.txt                     sha256sum -c SHA256SUMS.txt
```

### The manifest

`song_delivery-manifest.json` records the engine version, source filename, render
timestamp, layout, channel count, full channel order with labels and coordinates, sample
rate, bit depth, channel mask, container, ADM type, true peak, integrated loudness, LRA,
per-file SHA-256, and — most importantly — three honesty blocks:

- **`upmix`** — states that height/surround content was synthesised from stereo, per
  layout, naming the specific channels. ADM has no up-mix vocabulary, so the manifest is
  the only place this can be said.
- **`validation`** — exactly what was verified and what was not, with
  `admSchemaValidated: false` and `atmosCertified: false` hard-wired, plus a glossary of
  the terminology so nobody has to guess what "structurally validated" bought them.
- **`limitations`** — the software's known limits, copied into the delivery so they travel
  with the file instead of living in a repository the recipient will never read.

### mask = 0 layouts

For 9.1.6 and Sonic Lab 20.4 the routing documentation is deliberately loud. The README
prints `ZERO, BY DESIGN` next to the mask and the manifest's `routingNote` reads:

> CHANNEL MASK IS 0 BY DESIGN. No `WAVEFORMATEXTENSIBLE` mask can describe this layout,
> and writing an approximate one would make a player route the file confidently to the
> wrong speakers. Route strictly from the channel map. Verify with the
> channel-identification file before committing to a mix.

For Sonic Lab the README additionally flags that channels 21–24 are four separate
subwoofers at surveyed positions and must not be summed, and that the asymmetric azimuths
are measurements, not typos.

---

## Checksums

SHA-256, in `SHA256SUMS.txt`, in the format GNU coreutils, BusyBox and `shasum -a 256 -c`
all accept:

```bash
sha256sum -c SHA256SUMS.txt
```

The implementation is `crypto.subtle` where available, with a FIPS 180-4 fallback for
insecure origins (`crypto.subtle` is undefined on plain `http://`, and a mastering tool on
a LAN address should still be able to hash a delivery). Both paths are tested against the
published FIPS/RFC 6234 vectors, including the one-million-character case.

> **These are file-integrity checks, not audio fingerprints.** They answer "are these the
> bytes that were sent?" — the question that matters for venue delivery, archival and
> installation work. Re-rendering identical audio at a different bit depth, or with a
> different `bext` timestamp, produces a completely different hash. Do not use them to
> decide whether two files sound the same.

The checksum file does not list itself: a document cannot contain its own hash, and a
checksum file that claims to verify itself is a circular claim.

---

## Inspecting an export yourself

Do not take this document's word for any of it. Every command below uses standard
open-source tooling.

### Channel count, sample rate, bit depth

```bash
ffprobe -v error -select_streams a:0 \
  -show_entries stream=channels,channel_layout,sample_rate,bits_per_raw_sample,sample_fmt \
  -of default=noprint_wrappers=1 master_7.1.4.wav
```

### Duration and frame count

```bash
ffprobe -v error -select_streams a:0 \
  -show_entries stream=duration,duration_ts,nb_frames \
  -of default=noprint_wrappers=1 master.wav
```

### Every chunk in the file, with sizes

```bash
npm run inspect:export -- master_7.1.4.adm.wav
```

Or without this repository, using `xxd` to read the header by hand:

```bash
xxd -l 64 master.wav          # RIFF/RF64/BW64 FourCC, size, WAVE, first chunk
```

### Extract and validate the ADM XML

```bash
# With this repository:
npm run inspect:export -- master.adm.wav --xml > adm.xml
npm run validate:adm -- master.adm.wav

# With your own licensed BS.2076 schema:
npm run validate:adm -- master.adm.wav --xsd /path/to/BS.2076-2.xsd

# With FFmpeg alone (dumps all attached chunks it recognises):
ffprobe -v error -show_format -of json master.adm.wav
```

### Check the XML is at least well-formed, without this repository

```bash
xmllint --noout adm.xml && echo "well-formed"
```

### Verify integrity

```bash
sha256sum -c SHA256SUMS.txt
```

### Decode to raw PCM and compare two files

```bash
ffmpeg -v error -i a.wav -f f32le -acodec pcm_f32le a.raw
ffmpeg -v error -i b.wav -f f32le -acodec pcm_f32le b.raw
cmp a.raw b.raw && echo "bit-identical"
```

### Confirm the channel identification by ear

Play `*_channel-identification.wav` through the target rig. Channel _N_ emits _N_ beeps
then a tone, with everything else silent. If the count does not match the speaker, the
routing is wrong — not the file.

### Extract one channel to check it in isolation

```bash
# Channel 9 of a 7.1.4 file (Ltf, if the map is being honoured):
ffmpeg -i master_7.1.4.wav -filter_complex "pan=mono|c0=c8" -y ch9.wav
```

### Confirm a large file really is RF64/BW64

```bash
head -c 4 huge.wav          # prints RF64 or BW64
xxd -s 12 -l 40 huge.wav    # the ds64 chunk: id, size, then three 64-bit LE values
```

---

## Remaining limitations

Stated plainly, because a limitation you know about is a risk you can manage.

### Not established by this work

1. **ADM XML is not schema validated.** The normative ITU-R BS.2076 XSD is not
   redistributable. Structural validation is thorough but it is not a schema check, and it
   cannot catch a constraint expressed only in the XSD. Use `--xsd` with your own copy.

2. **No commercial renderer ingest in CI.** The exports have not been round-tripped
   through Dolby, Nuendo, Pyramix, Reaper's ADM importer, or the EBU/IRT reference
   renderer as part of automated validation. That is manual, licensed, and out of scope
   for an open-source CI job. It remains the single most valuable manual check to perform.

3. **Not Dolby Atmos certified**, and cannot be from this toolchain. Object-based
   authoring is not implemented. What is produced is a DirectSpeakers bed suitable as an
   ingest asset.

4. **No BS.2051 common-definitions cross-check.** The pack format IDs recorded for 5.1 and
   7.1 (`AP_00010003`, `AP_00010004`) are the documented common-definition values, but the
   exported XML declares its own custom pack rather than referencing the common
   definitions file. A renderer expecting `common_definitions.xml` semantics may treat the
   pack as unknown. This is valid ADM; it is just less idiomatic than it could be.

5. **`chna` and `axml` are validated against each other, not against a renderer's
   interpretation.** Two documents can be mutually consistent and still be understood
   differently by a third party.

### Format and platform limits

6. **~2 GiB practical ceiling remains on the in-memory paths.** The delivery-package
   builder and downloads in browsers without the File System Access API (Firefox,
   Safari) still materialise the whole file in one `ArrayBuffer`; RF64/BW64 headers are
   correct, but the browser is the binding constraint there. See
   [RF64 / BW64](#rf64--bw64). Direct exports on Chromium-based browsers stream to disk
   and are not subject to this ceiling (though see limitation 6a).

   **6a. Streaming lifts the *encoder* ceiling, not the *renderer* ceiling.** Decode and
   render still hold the full programme as 32-bit float (see
   `docs/LIMITATIONS.md` — "Everything is in memory"). A file that streams out in 4 MiB
   blocks was still rendered into a buffer of `channels × frames × 4` bytes several
   times over. The streaming writer removes the last and largest of the encoding copies;
   it is not itself a streaming renderer.

7. **Streaming is only on the single-file direct exports.** The delivery-package builder
   assembles each package as in-memory Blobs. Its master WAV is the same bytes a direct
   export streams, but the package path is used for documented bundles of sidecars; at
   album lengths, use the direct master export and add the sidecars individually if you
   need them on disk beyond the browser's ceiling. A future chunk-collecting sink (Blob
   parts without one backing buffer) can close this gap without any new encoding.

8. **No `ds64` chunk-size table.** `tableLength` is always 0 because no chunk this project
   writes other than `data` can overflow 32 bits. The parser handles a populated table on
   read; the writer never produces one.

9. **AIFF and MP3 are outside this validation layer.** The AIFF writer has its own tests
   in `tests/format/aiff.test.js`, but it is not covered by the external-parser gate, the
   round-trip matrix, or the channel-order verification.

10. **No `cue `, `list`, `iXML`, `SMPTE` or `axml`-adjacent broadcast chunks.** Timecode is
    written as `bext` `TimeReference = 0` — exports carry no meaningful timecode origin.

### Measurement caveats that propagate into metadata

11. **The loudness values in `bext` and in the manifest come from a meter that is not EBU
    Tech 3341 certified.** See `docs/LIMITATIONS.md`.

12. **Height-channel loudness weighting is an assumption.** BS.1770-4 defines G for front,
    LFE and surround channels only. Signal Rot assumes 1.0 for height. This affects the
    `bext` loudness fields of every immersive export.

13. **True peak is measured with a windowed-sinc interpolator, not the BS.1770-4 Annex 2
    filter.** Worst-case error −0.168 dB.

### Content caveats

14. **Immersive layouts are up-mixed from stereo. Height content is synthesised.** This is
    disclosed in the manifest and the README because ADM has no vocabulary for it, but the
    ADM file itself cannot say so. A recipient who reads only the XML will not learn it.

15. **The Sonic Lab 20.4 layout is venue-specific.** No renderer knows it. Its custom
    `SIGNALROT_SL_*` speaker labels are valid BS.2076 custom labels and are meaningless to
    anything that has not read `docs/SONIC-LAB-20.4.md`.

### Tooling caveats

16. **ffmpeg (as opposed to ffprobe) may be unavailable.** `ffprobe-static` ships only
    ffprobe, so sample-accurate external decoding falls back to this repository's own
    independent decoder. CI installs full ffmpeg; a local run may not have it. The report
    distinguishes _skipped_ from _passed_, and CI fails on a skip.

17. **Fixture content is synthetic.** Identification tones are ideal for catching routing
    and format faults and tell you nothing about how real programme material survives the
    chain.

---

## Related documents

- `docs/LIMITATIONS.md` — every approximation in the DSP and measurement layers
- `docs/IMMERSIVE-AUDIO.md` — how the immersive layouts are derived
- `docs/SONIC-LAB-20.4.md` — the venue layout in full
- `docs/TESTING.md` — the test suite as a whole
