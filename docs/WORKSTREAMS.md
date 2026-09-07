# Workstreams & ownership

Signal Rot is developed as five parallel workstreams, each owned by a named agent, each
colour-coded by its domain from [COLOR-SYSTEM.md](COLOR-SYSTEM.md). This document is the
single map of **who owns which ground, what crosses the seams, and what the handoff rules
are.** It reflects the real arrangement recorded across
[CONTRIBUTING.md](../CONTRIBUTING.md),
[PRODUCT-EXPERIENCE.md](PRODUCT-EXPERIENCE.md),
[FINDINGS-FOR-AGENT-A.md](FINDINGS-FOR-AGENT-A.md) and
[runtime contracts](../src/runtime/README.md) — it is not an aspiration.

## Ownership map

```mermaid
graph TB
  subgraph AGENT_A["AGENT A · DSP & MEASUREMENT + SPATIAL ENGINE"]
    A1["src/audio/dsp · analysis · graph · render · adaptive<br/>25 files · 4,855 lines"]:::dom-dsp
    A2["src/audio/immersive/{layouts,sonic-lab,speaker-feeds,binaural}<br/>up-mix + feeds + monitor"]:::dom-spatial
  end

  subgraph AGENT_B["AGENT B · TESTING & CONFORMANCE"]
    B1["tests/browser · tests/conformance · tools/{conformance,audio-regression,benchmarks}<br/>ci/conformance.yml · lab-results JSON"]:::dom-testing
  end

  subgraph AGENT_C["AGENT C · EXPORT & FORMATS"]
    C1["src/audio/encode (10 files · 2,294 lines)<br/>immersive/adm.js · delivery profiles/packages/manifests/checksums"]:::dom-export
  end

  subgraph AGENT_D["AGENT D · RUNTIME & WORKERS"]
    D1["src/runtime (scheduler · rpc · memory budget · preflight · pyramid · stream)<br/>src/workers · 386 lines"]:::dom-runtime
  end

  subgraph AGENT_E["AGENT E · UI & PRODUCT"]
    E1["src/ui (19 files · 2,177 lines) · src/visualizers · src/styles · index.html<br/>MASTER + SPATIAL LAB surfaces"]:::dom-ui
  end

  subgraph SHARED["HOUSE · APP STATE & PRESETS"]
    H1["src/app (store · schema · presets-io) · src/presets (72 presets · 8 groups)"]:::dom-app
  end

  B1 -- "findings inbox · regression test stays<br/>docs/FINDINGS-FOR-AGENT-A.md" --> A1
  A1 -. "routing flags (e.g. speaker solo export)" .-> E1
  C1 -. "writer APIs → export summary" .-> E1
  D1 -. "progress · memory · waveform levels<br/>// adapter boundary" .-> E1
  D1 -. "cancellation + scheduler keys" .-> A1
  D1 -. "batch export progress" .-> C1
  H1 == "parameter schema is the contract for everyone" ==> E1
  A1 -- "audible change? numbers first (CONTRIBUTING)" --> B1

  classDef dom-dsp fill:#222131,stroke:#a78bfa,color:#a78bfa
  classDef dom-spatial fill:#152332,stroke:#58a6ff,color:#58a6ff
  classDef dom-runtime fill:#262c19,stroke:#c8e15c,color:#c8e15c
  classDef dom-export fill:#2a1a2c,stroke:#e26bd8,color:#e26bd8
  classDef dom-testing fill:#112631,stroke:#38bdf8,color:#38bdf8
  classDef dom-ui fill:#2d1b27,stroke:#f472b6,color:#f472b6
  classDef dom-app fill:#1f2328,stroke:#94a3b8,color:#94a3b8
```

Colour means _domain_, the subgraph title means _owner_. Where one agent spans two
domains (A), both swatches appear.

## Who owns what, concretely

| Agent | Domains                                                | Owns (primary paths)                                                                                                                                                            | Owns the claim in                                                                                                                                                                                                                                                                           | Guardrail it lives under                                                                                                                                                                                                         |
| ----- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | ● DSP · ● SPATIAL                                      | `src/audio/**` except `encode/` and `immersive/adm.js`; `tests/integration` assertions for the chain                                                                            | [`DSP-SIGNAL-FLOW.md`](DSP-SIGNAL-FLOW.md) · [`LOUDNESS-ANALYSIS.md`](LOUDNESS-ANALYSIS.md) · [`TRUE-PEAK-LIMITER.md`](TRUE-PEAK-LIMITER.md) · [`GAIN-STRUCTURE-AUDIT.md`](GAIN-STRUCTURE-AUDIT.md) · [`IMMERSIVE-AUDIO.md`](IMMERSIVE-AUDIO.md) · [`SONIC-LAB-20.4.md`](SONIC-LAB-20.4.md) | Every audible change ships before/after measurements, not adjectives ([CONTRIBUTING.md](../CONTRIBUTING.md) §DSP changes)                                                                                                        |
| **B** | ● TESTING                                              | `tests/browser` (conformance lab), `tests/conformance`, `tools/{conformance,audio-regression,benchmarks}`, `ci/conformance.yml`, `docs/FINDINGS-FOR-AGENT-A.md`                 | [`CONFORMANCE.md`](CONFORMANCE.md) · [`AUDIO-REGRESSION.md`](AUDIO-REGRESSION.md) · [`TESTING.md`](TESTING.md)                                                                                                                                                                              | Measures the running engine; **does not fix production DSP, does not retune from a lab failure**. Findings land as `open` / `recorded` / `platform` in Agent A's inbox; the regression test that produced a finding always stays |
| **C** | ● EXPORT                                               | `src/audio/encode/**`, `src/audio/immersive/adm.js`, delivery profiles/packages/manifests/checksums, `tools/export-validation`, `.github/workflows/export-interoperability.yml` | [`EXPORT-INTEROPERABILITY.md`](EXPORT-INTEROPERABILITY.md) · the validation workflow's assertions                                                                                                                                                                                           | Files are checked by parsers that share no code with the writers; the report may never claim Atmos certification or XSD validation it did not run                                                                                |
| **D** | ● RUNTIME                                              | `src/runtime/**` (job scheduler, worker RPC, memory budget, render preflight, waveform pyramid, audio-stream), `src/workers/**`                                                 | [`src/runtime/README.md`](../src/runtime/README.md)                                                                                                                                                                                                                                         | Contracts, not UI: consumers get _structured_ preflight/job snapshots; transferred buffers are disposable; A gets cancellation, C gets batch progress, E gets presentation data — none edit each other's internals               |
| **E** | ● UI · (SPATIAL lab surface, EXPORT summary, warnings) | `src/ui/**`, `src/visualizers/**`, `src/styles/**`, `index.html`, the export-summary and spatial-lab presentations                                                              | [`PRODUCT-EXPERIENCE.md`](PRODUCT-EXPERIENCE.md)                                                                                                                                                                                                                                            | Never constructs audio nodes, never retunes DSP; consumes A/C/D through `// adapter boundary`; every degraded path shows an info notice, not a blocker                                                                           |
| —     | ● APP                                                  | `src/app/{state,parameters,presets-io,constants,bootstrap}.js`, `src/presets/**`, `src/main.js`                                                                                 | [`PRESET-SCHEMA.md`](PRESET-SCHEMA.md) · the catalogue test                                                                                                                                                                                                                                 | The parameter schema is the single source of truth; a new user-facing value goes there first, and the control _appears_                                                                                                          |

## The seams

Three boundary conventions keep the workstreams orthogonal — each one is observable in the
codebase, not just declared:

1. **`// adapter boundary`** — where E (or D) consumes another workstream's API without
   assuming it: `ui/heavy-warning.js` derives an estimate when Agent D's API is absent;
   `spatial-lab.js` forwards `listenerYaw`/`motion` only if A exposes it, and degrades the
   dial honestly rather than dead-reckoning.
2. **The findings inbox** — `docs/FINDINGS-FOR-AGENT-A.md` is a queue with a status key
   (`open` / `recorded` / `platform`) and a consumption protocol: a finding is either
   tightened into a threshold with a reason, or fixed by Agent A against the test B left
   behind. Nobody deletes a test to go green.
3. **The golden bank** — `npm run lab:goldens && npm run lab:compare` answers "what did
   this do to the audio, in numbers?" for _any_ branch without touching A's tree: goldens
   are snapshots, comparisons are numeric, copyrighted audio never enters the repo.

## Handoff loop (how a measurement becomes a fix)

```mermaid
sequenceDiagram
  participant L as B · conformance lab
  participant I as FINDINGS-FOR-AGENT-A.md
  participant A as A · DSP
  participant V as CI (ci/conformance.yml)

  L->>L: real-browser OfflineAudioContext render<br/>(chromium · firefox · webkit)
  L->>I: finding + the regression test that caught it
  Note over I: status open / recorded / platform
  A->>A: fix in src/audio/** against the kept test
  A->>V: goldens re-run, thresholds re-checked in CI
  V-->>I: finding moves to recorded with a one-line reason
```

The four-stage verification pipeline itself (local `check` → CI → conformance matrix →
export gate) is documented in [TESTING.md](TESTING.md) §The pipeline.

## Where a change goes — decision map

```mermaid
flowchart TD
  START["I want to change…"]:::dom-app
  START --> Q1{"It changes what<br/>a render sounds like?"}
  Q1 -- yes --> A_PATH["src/audio/** · pure functions over typed arrays<br/>+ measure before/after + keep the proof in the PR"]:::dom-dsp
  Q1 -- no --> Q2{"It touches a file format<br/>or a deliverable?"}
  Q2 -- yes --> C_PATH["src/audio/encode/** · immersive/adm.js<br/>+ tests/interoperability + export-validation"]:::dom-export
  Q2 -- no --> Q3{"It is scheduling, memory,<br/>worker plumbing?"}
  Q3 -- yes --> D_PATH["src/runtime/** · contracts first,<br/>consumers via adapter boundary"]:::dom-runtime
  Q3 -- no --> Q4{"A new user-facing value?"}
  Q4 -- yes --> H_PATH["src/app/parameters.js — one schema entry.<br/>Control, clamp, aria, badges, docs row: free."]:::dom-app
  Q4 -- no --> E_PATH["src/ui/** or visualizers —<br/>never construct audio nodes here"]:::dom-ui
  A_PATH --> T["every claim ships with a test — CONTRIBUTING.md §the one rule"]:::dom-testing

  classDef dom-dsp fill:#222131,stroke:#a78bfa,color:#a78bfa
  classDef dom-export fill:#2a1a2c,stroke:#e26bd8,color:#e26bd8
  classDef dom-runtime fill:#262c19,stroke:#c8e15c,color:#c8e15c
  classDef dom-ui fill:#2d1b27,stroke:#f472b6,color:#f472b6
  classDef dom-testing fill:#112631,stroke:#38bdf8,color:#38bdf8
  classDef dom-app fill:#1f2328,stroke:#94a3b8,color:#94a3b8
```

## Status quo (honest snapshot at this commit)

- A → E: speaker solo remains monitoring-only; the export routing flag is not yet wired.
- C → E: Sonic Lab 20.4 channel-map delivery is manual; no auto-zip bundle yet.
- D: contracts are tested (6) and consumable, but no `src/app` module imports
  `src/runtime` yet — E's consumers derive fallbacks today (`heavy-warning.js`).
- E: the `PRODUCT-EXPERIENCE.md` spec is implemented; remaining gaps are listed in its
  "Remaining Degradation" section.

These are recorded in [PRODUCT-EXPERIENCE.md](PRODUCT-EXPERIENCE.md) §Remaining Degradation
and [src/runtime/README.md](../src/runtime/README.md); the diagram above shows them as
dotted boundaries rather than arrows that do not exist.
