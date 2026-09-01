# Browser compatibility

**How to read this document.** Every row is marked with how it was established:

| Mark         | Meaning                                                             |
| ------------ | ------------------------------------------------------------------- |
| **tested**   | Exercised by the automated suite or by hand during the 7.0 refactor |
| **expected** | Follows from documented platform behaviour; not exercised here      |
| **unknown**  | Not determined                                                      |

The claims in the pre-7.0 README were neither tested nor sourced. This document does not
repeat that mistake: where something was not tested, it says so.

The most reliable answer is always the **About tab**, which probes the running browser at
load time and shows what it actually found.

---

## Verification status for 7.0

| Environment                          | Status                                                                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node 22 + jsdom                      | **tested** — 544 Vitest tests including a boot smoke test that loads the real `index.html`, stubs Web Audio and canvas, runs `bootstrap()`, and asserts no console errors                        |
| Vite dev server and production build | **tested** — both build and serve cleanly                                                                                                                                                        |
| Chromium via Playwright              | **not run during the 7.0 refactor.** The development sandbox had no network access to the Playwright browser CDN. The 37 specs in `e2e/` are written and configured; CI runs them on every push. |
| Firefox, Safari, mobile              | **not run.** Claims below are expectations from platform documentation.                                                                                                                          |

---

## Minimum versions

| Browser                     | Minimum  | Why                                                 |
| --------------------------- | -------- | --------------------------------------------------- |
| Chrome / Edge / Brave / Arc | **111**  | `color-mix()` in CSS                                |
| Firefox                     | **128**  | ES modules in workers, stable `OfflineAudioContext` |
| Safari / iOS Safari         | **16.4** | `color-mix()`, ES modules in workers                |

## Platform features used

| Feature                                  | Required                       | Fallback                                                                     | Status           |
| ---------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------- | ---------------- |
| `AudioContext`                           | yes                            | none — a clear error message                                                 | tested (fake)    |
| `webkitAudioContext`                     | —                              | used if the unprefixed form is absent                                        | expected         |
| `OfflineAudioContext`                    | yes                            | none — export is impossible without it                                       | tested (fake)    |
| `Worker` with `type: 'module'`           | no                             | `analyseInline` runs the identical code on the main thread                   | tested           |
| `PannerNode` with `panningModel: 'HRTF'` | binaural only                  | `setPosition()` for pre-14.1 Safari                                          | expected         |
| `DynamicsCompressorNode.reduction`       | meters only                    | reads 0                                                                      | tested (fake)    |
| `WaveShaperNode.oversample`              | saturation (live preview only) | quality is implementation-defined everywhere; exports use the offline engine | expected         |
| `AudioBuffer.copyToChannel`              | yes                            | none                                                                         | expected         |
| `Blob` + `URL.createObjectURL`           | export                         | none                                                                         | expected         |
| `<a download>`                           | export                         | none                                                                         | expected         |
| `localStorage`                           | autosave only                  | autosave is skipped silently                                                 | tested           |
| `CSS color-mix()`                        | cosmetic                       | the affected surfaces fall back to flat colours                              | expected         |
| `prefers-reduced-motion`                 | accessibility                  | ignored                                                                      | tested (CSS)     |
| `prefers-contrast: more`                 | accessibility                  | ignored                                                                      | expected         |
| `OffscreenCanvas`                        | not used                       | —                                                                            | probed, reported |

---

## Sample-rate support

`OfflineAudioContext` sample-rate support is **not uniform**. The sample-rate menu probes
each rate with a one-frame context at load time and **disables what the browser refuses**,
labelling it "unsupported in this browser". That probe is authoritative; the table is not.

| Rate     | Chromium   | Firefox    | Safari                   |
| -------- | ---------- | ---------- | ------------------------ |
| 44.1 kHz | expected ✓ | expected ✓ | expected ✓               |
| 48 kHz   | expected ✓ | expected ✓ | expected ✓               |
| 88.2 kHz | expected ✓ | expected ✓ | unknown                  |
| 96 kHz   | expected ✓ | expected ✓ | expected ✓               |
| 192 kHz  | expected ✓ | expected ✓ | **historically refused** |

## Decoder support

Decoding is `decodeAudioData`, which uses the browser's own codecs. Support genuinely
varies and Signal Rot cannot change that.

| Format              | Chromium | Firefox         | Safari    |
| ------------------- | -------- | --------------- | --------- |
| WAV (PCM 16/24/32f) | ✓        | ✓               | ✓         |
| AIFF                | ✓        | partial         | ✓         |
| MP3                 | ✓        | ✓               | ✓         |
| FLAC                | ✓        | ✓               | ✓ (14.1+) |
| AAC / M4A           | ✓        | **usually not** | ✓         |
| Ogg Vorbis          | ✓        | ✓               | ✗         |
| Opus                | ✓        | ✓               | partial   |

The About tab lists what `canPlayType()` reports for the running browser. That is a hint
about _playback_, not about `decodeAudioData`, and it is labelled as a hint. A decode
failure produces a specific message naming the formats that work everywhere.

## Known behavioural differences

| Area                                | Difference                                               | Consequence                                                                                                   |
| ----------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `DynamicsCompressorNode`            | Internals are implementation-defined                     | The multiband will not sound bit-identical across browsers                                                    |
| `WaveShaperNode` 4× oversampling    | Quality is unspecified                                   | Live-preview saturation aliasing differs across browsers; exports are unaffected (offline engine since 7.1.0) |
| `PannerNode` HRTF dataset           | Chromium ships an IRCAM-derived set; others differ       | The binaural monitor sounds different in each browser                                                         |
| Autoplay policy                     | All browsers suspend `AudioContext` until a user gesture | Import and playback both resume it; the reference and batch inputs do too                                     |
| Programmatic download rate-limiting | Varies                                                   | Batch export pauses 450 ms between files; some browsers still block after several                             |
| `Float32Array` allocation limits    | Vary by platform and available memory                    | Long high-rate renders fail differently in each browser                                                       |

The first three mean **a render is only bit-reproducible within one browser engine**. The
render report says so explicitly in its `reproducibility` block.

## Mobile

Usable for auditioning and short renders. Not recommended for delivery.

- iOS Safari requires a genuine user gesture to start audio; the import button provides it.
- Background tabs are suspended aggressively. A long render will be killed.
- Memory limits are much lower. The resource guards apply but are tuned for desktop.
- The layout collapses to a single column below 760 px and the tab strip scrolls
  horizontally. Range thumbs grow to 24 px on coarse pointers, above the WCAG 2.2 target-size
  minimum.

## Resource guards

| Guard                | Threshold | Behaviour                             |
| -------------------- | --------- | ------------------------------------- |
| File size            | 512 MB    | refuse, with the size in the message  |
| Duration             | 15 min    | warn                                  |
| Duration             | 60 min    | refuse                                |
| Total render samples | 400 M     | warn with an estimated byte size      |
| RIFF size            | 4 GB      | refuse — RF64/BW64 is not implemented |

These are conservative because browsers do not report available memory, and an
`OfflineAudioContext` render allocates roughly `channels × length × 4` bytes _per
intermediate copy_.

## Content Security Policy

Signal Rot loads nothing from a third-party origin. This policy is sufficient:

```
default-src 'self';
script-src 'self';
style-src 'self';
worker-src 'self' blob:;
connect-src 'self' blob:;
img-src 'self' data:;
```

`data:` for images covers the inline SVG select arrow. `blob:` covers the analysis worker
and the download URLs. The MP3 encoder is bundled and code-split, so it is fetched from your
own origin the first time someone exports an MP3.

The pre-7.0 build loaded `lamejs` from `cdnjs.cloudflare.com`, which required
`script-src 'self' https://cdnjs.cloudflare.com`, broke MP3 export offline, and meant a
third party could change the bytes executing in the user's browser.

## Offline operation

The production build has **no runtime network dependencies**. Serve `dist/` from a local
file server, a USB stick or a service worker and every feature works, MP3 export included.
