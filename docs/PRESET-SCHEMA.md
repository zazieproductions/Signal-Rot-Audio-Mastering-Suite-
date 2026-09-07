# Preset schema

Implementation: [`src/app/parameters.js`](../src/app/parameters.js) ·
[`src/app/presets-io.js`](../src/app/presets-io.js)
Tests: [`tests/app/parameters.test.js`](../tests/app/parameters.test.js) (23) ·
[`tests/app/presets-io.test.js`](../tests/app/presets-io.test.js) (21) ·
[`tests/app/presets-catalog.test.js`](../tests/app/presets-catalog.test.js) (16)

---

## File format — schema version 3

```json
{
  "format": "signal-rot-preset",
  "schemaVersion": 3,
  "engineVersion": "7.0.0",
  "name": "Analog Womb",
  "description": "",
  "savedAt": "2026-08-18T09:41:07.104Z",
  "parameters": {
    "normalize": true,
    "targetLUFS": -14,
    "ceiling": -1,
    "tape": 35,
    "mbLow": 30,
    "…": "every schema key, with its current value"
  },
  "immersive": {
    "layout": "7.1.4",
    "centerExtract": 0.5,
    "surrLevelDb": -3,
    "…": ""
  }
}
```

A saved preset is **complete**: every schema key is present. Catalogue presets in the source
are sparse (they list only what they change) and are expanded against the defaults on apply.

## Loading is a trust boundary

A preset file is untrusted input. Loading it:

1. Refuses anything over 256 kB **before parsing**.
2. Parses with `JSON.parse` inside a `try`; a parse failure returns a specific message, not
   a generic "bad preset file".
3. Rejects a non-object, an array, a scalar and `null` by type-checking before any property
   access.
4. Detects the schema version and migrates if needed.
5. Runs `validateParameters`, which **drops unknown keys** rather than merging them, fills
   missing keys with defaults, coerces every type and clamps every number to its range.
6. Type-checks the immersive block field by field against the defaults.
7. For files explicitly declaring `family: "mastering"`, zeros `tape`, `hiss`, `vinyl`,
   `haas` and `phaseRot` via `sanitizeForFamily`, with warnings. Creative or untagged
   files are not family-scrubbed.
8. Returns the warnings so the UI can report what it changed.

A hand-edited file cannot set `width: 1e9`, `ceiling: +40` or inject a key. A
`{"__proto__": {...}}` payload is inert.

## Parameter reference

| Key             | Group     | Type    | Default  | Range                      | Unit | Preview | Export |
| --------------- | --------- | ------- | -------- | -------------------------- | ---- | :-----: | :----: |
| `normalize`     | loudness  | boolean | true     | true · false               | —    |    ✓    |   ✓    |
| `targetLUFS`    | loudness  | number  | -14      | -30 … -5                   | LUFS |    ✓    |   ✓    |
| `ceiling`       | loudness  | number  | -1       | -3 … -0.1                  | dBTP |    ✗    |   ✓    |
| `drive`         | loudness  | number  | 0        | -6 … 9                     | dB   |    ✓    |   ✓    |
| `sub`           | tone      | number  | 0        | -12 … 12                   | dB   |    ✓    |   ✓    |
| `warm`          | tone      | number  | 0        | -12 … 12                   | dB   |    ✓    |   ✓    |
| `body`          | tone      | number  | 0        | -12 … 12                   | dB   |    ✓    |   ✓    |
| `harsh`         | tone      | number  | 0        | -12 … 12                   | dB   |    ✓    |   ✓    |
| `clarity`       | tone      | number  | 0        | -12 … 12                   | dB   |    ✓    |   ✓    |
| `air`           | tone      | number  | 0        | -12 … 12                   | dB   |    ✓    |   ✓    |
| `tilt`          | tone      | number  | 0        | -6 … 6                     | dB   |    ✓    |   ✓    |
| `sat`           | tone      | number  | 0        | 0 … 100                    | %    |    ✓    |   ✓    |
| `mbLow`         | dynamics  | number  | 0        | 0 … 100                    | —    |    ✓    |   ✓    |
| `mbMid`         | dynamics  | number  | 0        | 0 … 100                    | —    |    ✓    |   ✓    |
| `mbHigh`        | dynamics  | number  | 0        | 0 … 100                    | —    |    ✓    |   ✓    |
| `mbMix`         | dynamics  | number  | 100      | 0 … 100                    | %    |    ✓    |   ✓    |
| `mbSpeed`       | dynamics  | enum    | med      | fast · med · slow          | —    |    ✓    |   ✓    |
| `mbAutoMakeup`  | dynamics  | boolean | false    | true · false               | —    |    ✓    |   ✓    |
| `mbSolo`        | dynamics  | enum    | none     | none · low · mid · high    | —    |    ✓    |   ✗    |
| `mbBypassLow`   | dynamics  | boolean | false    | true · false               | —    |    ✓    |   ✓    |
| `mbBypassMid`   | dynamics  | boolean | false    | true · false               | —    |    ✓    |   ✓    |
| `mbBypassHigh`  | dynamics  | boolean | false    | true · false               | —    |    ✓    |   ✓    |
| `transAttack`   | dynamics  | number  | 0        | -100 … 100                 | —    |    ✗    |   ✓    |
| `transSustain`  | dynamics  | number  | 0        | -100 … 100                 | —    |    ✗    |   ✓    |
| `width`         | stereo    | number  | 1        | 0 … 2.5                    | ×    |    ✓    |   ✓    |
| `ms`            | stereo    | number  | 0        | -1 … 1                     | —    |    ✓    |   ✓    |
| `bassMono`      | stereo    | number  | 0        | 0 … 400                    | Hz   |    ✓    |   ✓    |
| `haas`          | stereo    | number  | 0        | 0 … 35                     | ms   |    ✓    |   ✓    |
| `haasSide`      | stereo    | enum    | 1        | 1 · -1                     | —    |    ✓    |   ✓    |
| `crossfeed`     | stereo    | number  | 0        | 0 … 1                      | —    |    ✓    |   ✓    |
| `phaseRot`      | stereo    | number  | 0        | 0 … 1                      | —    |    ✓    |   ✓    |
| `widthLow`      | spatial   | number  | 1        | 0 … 2                      | ×    |    ✓    |   ✓    |
| `widthMid`      | spatial   | number  | 1        | 0 … 2                      | ×    |    ✓    |   ✓    |
| `widthHigh`     | spatial   | number  | 1        | 0 … 2.5                    | ×    |    ✓    |   ✓    |
| `depth`         | spatial   | number  | 0        | 0 … 100                    | %    |    ✓    |   ✓    |
| `depthSize`     | spatial   | enum    | med      | small · med · large        | —    |    ✓    |   ✓    |
| `binaural`      | spatial   | boolean | false    | true · false               | —    |    ✓    |   ✓    |
| `spread`        | spatial   | number  | 0        | 0 … 1                      | —    |    ✓    |   ✓    |
| `tape`          | character | number  | 0        | 0 … 100                    | %    |    ✓    |   ✓    |
| `hiss`          | character | number  | 0        | 0 … 100                    | %    |    ✓    |   ✓    |
| `vinyl`         | character | number  | 0        | 0 … 100                    | %    |    ✓    |   ✓    |
| `textureSeed`   | character | number  | 85346839 | 0 … 4294967295             | —    |    ✓    |   ✓    |
| `matchStrength` | match     | number  | 0        | 0 … 100                    | %    |    ✓    |   ✓    |
| `matchMode`     | match     | enum    | balanced | broad · balanced · precise | —    |    ✓    |   ✓    |
| `matchGains`    | match     | array   | all 0    | 8 × -12 … 12               | dB   |    ✓    |   ✓    |
| `dither`        | export    | enum    | tpdf     | none · tpdf · shaped       | —    |    ✗    |   ✓    |

`matchGains` is an 8-element array of dB corrections at 60, 150, 400, 1 000, 2 500, 5 000,
8 000 and 12 000 Hz. It is derived from a measurement of your source, so it is the one value
that survives a preset change — see below.

### The `previewSupported` / `exportSupported` flags

These drive the `export only` badges in the interface and the live-versus-export table in
the About tab. They exist so that a divergence between the monitor and the render is
declared in one place and surfaced automatically, rather than being documented once and
then forgotten.

## Migration

| Version                    | Shape                                            | Migration                                          |
| -------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| 3 (current)                | `{format, schemaVersion, parameters, immersive}` | none                                               |
| untagged with `parameters` | `{parameters}`                                   | treated as current, warns                          |
| 1–2 (pre-7.0)              | `{preset, P}`                                    | key filtering + defaults for new parameters, warns |

The pre-7.0 runtime object already stored `ms`, `crossfeed`, `phaseRot`, `spread` and the
width controls as ratios (the catalogue stored some as percentages and divided at apply
time), so a saved `P` block needs no unit conversion — only filtering, plus defaults for
parameters that did not exist: `textureSeed`, `matchMode`, `dither`, `mbSolo`,
`mbAutoMakeup`, `mbBypassLow/Mid/High`.

Migration is covered by a test that loads a full, realistic pre-7.0 `Tape Ghost` file.

## Applying a catalogue preset

`expandCatalogPreset(sparse, { preserve })` starts from the **schema defaults** and merges
the preset's sparse block. Everything the preset does not mention returns to its default.

This is a behaviour change. The pre-7.0 `applyPreset` preserved loudness settings and the
match curve across preset changes, which meant the same preset produced different results
depending on what you had done before it. Presets are now deterministic.

The one exception is carried explicitly by the caller: **the match curve survives**, because
it is a measurement of your source rather than a creative choice. So is the texture seed,
so that switching presets does not silently change your noise.

## The catalogue

Seventy-two presets in eight groups, including the Mastering group led by `Reference HD`. Each entry:

```js
preset({
  name: 'Vinyl Séance',
  tag: 'dimension',
  family: 'creative',
  description: 'Crackle, rumble, narrowed low end. A record that remembers being played.',
  risk: 'safe', // 'safe' | 'caution' | 'destructive'
  parameters: { vinyl: 45, warm: 2, widthLow: 0.5, bassMono: 100 /* … */ },
  audit:
    'Rumble is high-passed at 15 Hz so it cannot eat headroom below the audible band…',
});
```

`audit` is not a comment — it is shown in the interface when the preset is applied, and a
test asserts every preset has one.

### Families

Catalogue groups organise the browser; `mastering` / `creative` families constrain DSP.
`presetFamily(preset)` honours an explicit family, otherwise infers `creative` from
non-zero degradation controls and `mastering` from their absence. The apply path uses
`sanitizeForFamily` before applying a mastering preset. A family is optional in saved
schema-v3 files (`serializePreset({ family, ... })`); it is not a schema-version bump.
See [`tests/app/preset-families.test.js`](../tests/app/preset-families.test.js).

### Risk levels

| Level         | Meaning                                                          |
| ------------- | ---------------------------------------------------------------- |
| `safe`        | No mono-compatibility or level hazard                            |
| `caution`     | Legitimate creative territory that needs a check before delivery |
| `destructive` | Will not survive a mono fold-down, on purpose                    |

A test asserts the declared level is **at least as severe** as the automated phase analysis
reports. A preset cannot claim to be safe while tripping a danger warning.

### Enforced safety rules

`tests/app/presets-catalog.test.js` fails the build if any preset:

| Rule                                                            | Rationale                                                  |
| --------------------------------------------------------------- | ---------------------------------------------------------- |
| uses a ceiling hotter than −1.0 dBTP                            | a lossy decoder can overshoot its encoder input by ~1 dB   |
| widens past 130 % with no bass-mono anchor                      | low-frequency content wanders and cancels                  |
| stacks more than 6 dB across `sub` + `warm`                     | the two shelves overlap and add at 50 Hz                   |
| combines a target above −10 LUFS with more than 25 % saturation | the limiter cannot cope and the aliasing becomes the sound |
| declares a risk level below what the phase analysis reports     | dishonest labelling                                        |
| promises processing in its description that it does not perform | dishonest labelling                                        |
| disables normalisation without explaining why                   | surprising behaviour                                       |
| sets a value outside its schema range                           | would be silently clamped                                  |
| sets a key that is not in the schema                            | typo                                                       |

Four presets shipped at −0.5 dBTP before this rule existed. Two promised processing they did
not perform (`Synthwave` promised "punchy sub" with no dynamics at all; `Melancholic Sunset`
promised "nostalgic compression" with none). Three widened past 130 % with no low-frequency
anchor. All are fixed, and the fixes are recorded in each preset's `audit` string.

## Autosaved session

Separately from preset files, the store writes to `localStorage` on a 400 ms debounce:

```json
{
  "schemaVersion": 3,
  "engineVersion": "7.0.0",
  "savedAt": "…",
  "parameters": {},
  "immersive": {},
  "ui": { "theme": "dark", "tab": "presets", "presetName": "Custom", "moduleBypass": {} }
}
```

Key: `signal-rot:session:v3`. Audio is never stored. A corrupt entry is removed rather than
allowed to break the boot.
