# Input compatibility

**How to read this document.** Every row is marked with how it was established:

| Mark         | Meaning                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| **tested**   | Exercised by the automated corpus suites (`tests/corpus/`, `tests/browser/input-corpus.spec.js`) or the unit suites |
| **expected** | Follows from documented platform behaviour; not exercised here                                                      |
| **unknown**  | Not determined — the About tab and the corpus logs are the answer                                                   |

The contract: **a file that cannot be handled is refused with a specific message
naming the file and the reason — never a frozen UI, never a cryptic exception,
never a partial or mis-attached result.** And a file that _is_ loaded is loaded
**unaltered**: no re-normalisation, no polarity correction, no channel drop,
swap, reorder or re-rate at the import boundary.

---

## Where the import lives

Every audio file — single load, reference load, batch queue — passes through one
module: `src/app/import-audio.js`.

```
File ──▶ preflightFile      size 0 / above the 512 MB ceiling ─────────┐
     ──▶ file.arrayBuffer() read failure (moved / revoked) ────────────┤
     ──▶ decodeAudioData    browser codec layer; failures classified ──┤
     ─▶ validateDecodedBuffer                                              │
          · no samples (0 frames)                                          │
          · non-finite (NaN/±Inf) samples — full scan of every channel     │
          · channel count above the 24-channel ceiling                     │
          · duration above the 60-minute ceiling (hard) / 15-minute (warn) │
          · honest memory preflight for the full-buffer render             ─┤
                                                                            ▼
                                   { ok:false, errors: [specific messages] }
                                   or { ok:true, buffer, warnings, notes }
```

A refusal never touches the source state, so a bad drop after a good load
cannot clobber what is loaded. This is covered by
`tests/app/import-flow.test.js` at the whole-app level and by
`tests/app/import-audio.test.js` at the module level.

### What the browser is and is not

The browser's `decodeAudioData` **is** the codec layer. Signal Rot claims no
codec support the browser does not have. The decode-error classifier
(`describeDecodeError`) maps failures to human language:

| Decoder failure                   | Message (abridged)                                                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `EncodingError`                   | "truncated or corrupted, or the container uses a codec this browser cannot parse"                                                |
| `NotSupportedError` / `TypeError` | "not supported by this browser's audio decoder. WAV and MP3 work everywhere; FLAC, M4A/AAC, Opus and AIFF depend on the browser" |
| `ReadError` / `SecurityError` / … | "could not be read — it may have been moved, deleted, or the OS revoked access"                                                  |

## The input matrix

The deterministic corpus (`tools/corpus/cases.js`, 48 cases, ~156 MB) covers:

| Axis         | Cases                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Channels     | mono, stereo, dual mono, hard L/R, 5.1, 7.1, 24 ch, 32 ch (extensible RIFF)                                                                        |
| Bit depth    | 16-bit PCM, 24-bit PCM, 32-bit float                                                                                                               |
| Rate         | 8 kHz, 22.05 kHz, 44.1 kHz, 48 kHz, 88.2 kHz, 96 kHz, 176.4 kHz, 192 kHz                                                                           |
| Duration     | 1 sample, 10 ms, 1 s, 2 s, 3 min, 16 min, 37 min, 61 min                                                                                           |
| Content      | silence, near-silence, DC offset, clipped integer, sub-heavy, bright, loud, very dynamic, polarity inversion, float > 1.0                          |
| Data hazards | NaN sample, ±Inf sample, truncated data, oversized data declaration, corrupted header, zero-length data, odd chunk order (data before fmt)         |
| Metadata     | heavy RIFF INFO with Unicode (`Träumerei 🎛 — 12" master copy`), Unicode/emoji/quote/apostrophe/300-char/Windows-reserved/HTML-injection filenames |
| Containers   | WAV (all of the above), MP3 (lamejs — the app's own dependency), AIFF (16-bit)                                                                     |
| Files        | 0-byte file, plain text with a `.wav` name                                                                                                         |

Every byte is synthesised from a seeded PRNG: legal to ship, identical on every
machine, reproducible (`tests/corpus/corpus.test.js` hashes the rebuild).

### Behaviour per class

| Class                                                            | Expected behaviour (all)                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean audio (any listed rate ≤ 96 kHz, ≤ 24 ch)                  | Loads. The store buffer must equal a fresh in-page decode of the same bytes (shape + samples). **tested** in Chromium by `input-corpus.spec.js`; **expected** in Firefox/WebKit                                                                                                               |
| Mono                                                             | Loads with a persistent note: "Input is mono; stereo processing will use explicit dual-mono routing." **tested**                                                                                                                                                                              |
| 5.1–24 ch                                                        | Loads (where the decoder agrees) with an explicit fold-down note; above 24 ch is refused with a channel-count message. **tested** (Chromium) / **expected**                                                                                                                                   |
| 176.4 / 192 kHz                                                  | Decodes where the browser's decoder accepts it (Safari's _offline render_ at 192 kHz is probed separately and disabled in the export menu when refused). Otherwise: specific refusal. **tested** per-browser by the corpus logs                                                               |
| Silence / near-silence                                           | Loads; loudness analysis reports silence honestly (no `NaN` in the UI). **tested**                                                                                                                                                                                                            |
| Clipped / DC-offset / polarity / float > 1.0                     | Loaded unaltered — verified against a fresh decode. **tested**                                                                                                                                                                                                                                |
| Empty file                                                       | Refused **before** any decode: "empty (0 bytes)". **tested**                                                                                                                                                                                                                                  |
| Corrupted / truncated / oversized / bad header / non-audio bytes | Refused with corruption or codec language (decoder-dependent cases may legitimately decode partially — the app then loads the sane result; a crash is the only failure). **tested**                                                                                                           |
| NaN / ±Inf float data                                            | Decoders often accept it; the app's post-decode scan refuses it with a frame/channel-specific message. **tested** (Chromium)                                                                                                                                                                  |
| 0-frame decode                                                   | Refused: "decoded but contains no audio samples". **tested**                                                                                                                                                                                                                                  |
| > 15 min                                                         | Loads with a duration warning ("renders will be slow and memory-hungry"). **tested** (16 min, 8 kHz)                                                                                                                                                                                          |
| > 60 min                                                         | Refused: "is 1:01:00 long; the limit is 1:00:00". **tested** (61 min, 8 kHz)                                                                                                                                                                                                                  |
| Memory                                                           | `estimateRender()` from the runtime preflight classifies the full-buffer render (source + DSP + output). SAFE/HEAVY/VERY HEAVY → warning at load; LIKELY UNSAFE → warning at load, **hard refusal of that batch item** at run time (a single export warns and defers to the user). **tested** |

## Fidelity guarantees at the import boundary

The browser conformance spec (`tests/browser/input-corpus.spec.js`) fingerprints
the app's stored buffer **and** a fresh in-page decode of the identical bytes,
then asserts they agree: channel count, sample rate, length, per-channel means
and 256 head samples per channel. That proves the import did not:

- change channel count or sample rate,
- flip polarity (the `opposite-polarity` case stays inverted),
- normalise or clip (DC offset and float > 1.0 survive),
- drop, swap or duplicate channels (hard L/R stays hard; dual mono stays identical),
- reinterpret mono.

Mastering DSP is deliberately out of scope here — this is the ingestion
boundary only.

## Output naming

Single export and batch use the same scheme, so a batch of five reads like a
series:

```
TrackName_master_24bit_48k.wav
TrackName_master_320k_44.1k.mp3
TrackName_master_16bit_96k.aif
```

Rules (`src/app/import-audio.js`):

- Base comes from `file.name` through `sanitizeFilename` — path separators,
  control characters and Windows-forbidden characters are removed; **Unicode
  is kept** (a `Träumerei 🎛.wav` stays recognisable); absurdly long names are
  truncated in the base, never in the suffix.
- Collision within a session: `…_2.wav`, `…_3.wav` — deterministic, instead of
  the browser's `(2)`/`(3)` invention.
- Render reports: `<base>_render-report.json` — per item, on the item.

## Batch workflow

The batch tab is a stateful queue, not a file list:

- **States per row**: `decoding → ready → rendering → done` or `failed` /
  `cancelled`, each with its own reason text, loudness and render report.
- **Sequential, concurrency 1** — the render graph is full-buffer; two
  concurrent renders would double peak memory with no speed gain.
- **Cancellation** stops the _next_ file. A running offline render cannot be
  interrupted, and the UI says so ("Stop after current file"); a partial file
  is never written.
- **Retry** re-processes one failed row (re-decoding first when the decode was
  the failure). A bad file fails its own row; the rest of the batch continues.
- **Memory preflight per item**: an item whose render will not fit is refused
  _before_ work with a specific size estimate, and the batch continues.
- **Adding files during a run** is refused with a message (decoding more
  buffers mid-batch would raise the memory peak the preflight is guarding).
- **Dropping several files on the main drop zone** loads the first and queues
  the rest here automatically; non-audio files in the drop are counted and
  skipped, not guessed at.

The batch calls the **same** `renderMaster` path as the single export — there
is no second engine.

## What is still unsupported

- **FLAC / AAC-M4A / Ogg / Opus input** are decoded by the browser only where
  the browser supports it (see `docs/BROWSER-COMPATIBILITY.md`). They are not
  synthesised by the corpus (no permissive legal encoder in the Node toolchain);
  their behaviour is "decodes or specific refusal", which is what the refusal
  paths test.
- **> 24-channel input** — refused by design; the mastering chain is
  2-channel and the browser fold-down is lossy.
- **> 60-minute or > 512 MB files** — refused by design (tab memory).
- **`file.arrayBuffer` read failures** (file moved mid-selection, permission
  revoked) — specific message; the app cannot recover a vanished handle.
- **Streaming long renders** — the DSP graph is full-buffer by design; the
  honest answer is the preflight warning, not a fake stream.

## Cross-browser differences (recorded, not assumed)

`input-corpus.spec.js` runs per browser (Chromium, Firefox, WebKit projects in
`tests/browser/playwright.config.js`) and logs, per exotic case, whether the
engine decoded or refused. Conformance gating of those results is the
validation agent's domain; this document and the suite are the evidence.
Known structural differences that the corpus _exercises_ rather than assumes:

- Safari's `OfflineAudioContext` refuses some high rates (probed at load; the
  export menu disables what is refused).
- Firefox's AAC decoding is unreliable; its multichannel WAV decode is
  expected-but-unverified here.
- 176.4 kHz is the rate browsers disagree about most.
