# Current State — single source of truth

**Last verified:** 2026-09-22
**Verified by:** direct count against `src/effects/registry.ts`, `src/instruments/registry.ts`, `docs/adr/` and `tests/`.

This document is the **single source of truth** for the headline numbers about KYX / Pulse Forge. Older documents in this repo (`RELEASE_ROADMAP.md`, `DSP-ROADMAP.md`, `EDIT-ROADMAP.md`, `INSTRUMENT-ROADMAP.md`, `SCENE-MODE-ROADMAP.md`, `INTENT_ENGINE.md`, `KYX_CURRENT_STATE.md`, `MAINTENANCE_AUDIT_PROGRESS.md`, `PERFORMANCE.md`) may carry their own point-in-time numbers; when those disagree with the figures below, **this document wins** for the question "how many / what ships today?".

For an architecture overview, see `ARCHITECTURE.md` and `docs/adr/`. For a user-facing description of every feature, see `README.md`.

---

## Headline numbers

| What                                   |   Count | Source of truth                                                                                                            |
| -------------------------------------- | ------: | -------------------------------------------------------------------------------------------------------------------------- |
| **Instruments** (melodic track kind)   |  **14** | `INSTRUMENT_ORDER` in `src/instruments/registry.ts`                                                                        |
| **Effects** (registry entries)         |  **45** | `EFFECT_ORDER` in `src/effects/registry.ts`                                                                                |
| └─ native/core effects                 |      40 | `EFFECT_ORDER` excluding flagship suites                                                                                   |
| └─ primary Add Effect choices          |      24 | `CORE_EFFECT_ORDER` in same file                                                                                           |
| └─ flagship plugin suites              |   **5** | `FLAGSHIP_EFFECT_ORDER` (`fxeq`, `ultina`, `ozvena`, `kaskada`, `morphdynamics`)                                           |
| **Project templates**                  |  **12** | `TemplateId` union in `src/project-model/templates.ts`                                                                     |
| **Factory assets** (drum / tonal / FX) |  **50** | `FACTORY_ASSETS` in `src/sample-library/manifest.ts` (15 kicks after the 2026-09 kick-bank expansion)                                                                       |
| └─ curated WAV overrides               |      50 | `CURATED_SAMPLES` in `src/sample-library/curated.ts` (same-id override contract; synthesized fallback retained on failure) |
| **Factory presets**                    | **238** | `src/presets/factory.ts`                                                                                                   |
| └─ instrument presets                  |     232 | `FACTORY_PRESETS`                                                                                                          |
| └─ drum-synth presets                  |       6 | `DRUM_FACTORY_PRESETS`                                                                                                     |
| **Architecture decision records**      |  **14** | `docs/adr/` (0001–0012, plus 0006/0007 each have two companion files)                                                      |
| **Vitest spec files**                  | **422** | `tests/` files matching `*.test.*` in the current working tree                                                             |

## Flagship plugin implementations

| Plugin suite    | Brand             | DSP core / ownership                                          | Worklet bundle                     |
| --------------- | ----------------- | ------------------------------------------------------------- | ---------------------------------- |
| `fxeq`          | **PRISM**         | `src/effects/fxeq-core/`                                      | `public/fxeq-worklet.js`           |
| `ultina`        | **VLYX**          | `src/effects/ultina-core/`                                    | `public/ultina-worklet.js`         |
| `ozvena`        | **VØID**          | `src/effects/ozvena-core/`                                    | `public/ozvena-worklet.js`         |
| `kaskada`       | **Kaskáda Delay** | bundled via `src/audio-worklets/` (no separate vendored core) | `public/core-worklet.js`           |
| `morphdynamics` | **MORPH**         | `src/effects/morph-dynamics-core/` (first-party DSP)          | `public/morph-dynamics-worklet.js` |

All five flagship suites use AudioWorklet DSP. PRISM, VLYX and VØID include separately vendored cores; Kaskáda and MORPH are first-party DSP owned in-tree. Relevant plugin-specific regression/golden tests are under `tests/`.

## AI models shipped in the browser

| Model                      |   Size | Feature version                   | Role                                                   |
| -------------------------- | -----: | --------------------------------- | ------------------------------------------------------ |
| `intent-ranker-v1.onnx`    | ~25 KB | `features.v1` (54 features)       | heuristic-vs-ONNX ranker over generated candidates     |
| `symbolic-prior-v1.onnx`   | ~20 KB | `prior-features.v1` (44 features) | second candidate source merged into the candidate bank |
| `symbolic-melodic-v1.onnx` | ~18 KB | `melodic-features.v1`             | melodic phrase generator                               |

All three are loaded lazily in dedicated Web Workers with bounded timeouts + circuit breaker + deterministic heuristic fallback (`src/ai/ranking/ranker-client.ts`, `src/ai/symbolic/prior-client.ts`). Inference never runs on the audio thread.

## Platform reach

- **Browser** — Chromium-family, Firefox and Microsoft Edge are target environments. The last recorded 226/226-per-browser result is a historical baseline from 2026-09-14, not verification of the current revision.
- **Desktop** — Windows x64 only (NSIS installer + portable exe via `electron-builder`). Auto-update through GitHub Releases (ADR 0011).
- **Safari / iOS Safari** — manual smoke only; not covered by automated browser verifier.
- **macOS / Linux desktop** — not shipped (ADR 0010 is Windows-only by current target list).

## Prior test-gate baseline — not verified on the current revision

The following historical results were recorded against candidate `b8c7a00` on 2026-09-14. The referenced `RELEASE_READINESS_REPORT.md` is not present in this checkout, so these figures are context only, not release evidence for the current revision. Re-run each gate before relying on it.

| Gate                                 | Historical result                                                        | Source                            |
| ------------------------------------ | ------------------------------------------------------------------------ | --------------------------------- |
| `npm run typecheck`                  | PASS (clean `tsc --noEmit`)                                              | candidate `b8c7a00`, 2026-09-14   |
| Full Vitest suite                    | **239 files / 2351 tests passed / 103 skipped / 2454 total** (`424.94s`) | candidate `b8c7a00`, 2026-09-14   |
| Real-browser verifier                | **226/226 in Chromium, Firefox and Edge**                                | candidate `b8c7a00`, 2026-09-14   |
| Factory preset audio QA              | **232/232**                                                              | candidate `b8c7a00`, 2026-09-14   |
| 300 s plugin soaks (PRISM/VLYX/VØID) | PASS (≤ 6 MB heap growth, ≤ 0.003 dB drift, zero tail peak)              | candidate `b8c7a00`, 2026-09-14   |
| `npm audit --omit=dev`               | 0 vulnerabilities                                                        | candidate `b8c7a00`, 2026-09-14   |
| `npm run format:check`               | **DEVIATIONS DOCUMENTED — owner gate open**                              | `docs/FORMAT-CHECK-DEVIATIONS.md` |

The numbers above are point-in-time and may drift between candidate revisions; the document is re-verified manually after each release-readiness review.

## Owner gates still open

These remain unverified for the current revision:

1. Manual browser/device checks (Firefox, Safari, iOS Safari, physical audio-device lifecycle).
2. Deployed smoke against a real `KYX_DEPLOY_URL` (`npm run release:deployed-smoke`).
3. Prettier formatting decision (209-file deviation baseline; `npm run format` would clear it).

## What this document is NOT

- It is **not** a roadmap. See `RELEASE_ROADMAP.md`, `EDIT-ROADMAP.md`, `INSTRUMENT-ROADMAP.md`, `DSP-ROADMAP.md`, `SCENE-MODE-ROADMAP.md`, `INTENT_ENGINE.md` for planned work.
- It is **not** an architecture reference. See `ARCHITECTURE.md` and `docs/adr/`.
- It is **not** a user-facing feature description. See `README.md`.

When you change a number above (e.g. you add a new instrument and `INSTRUMENT_ORDER` grows to 15), update this file in the same commit. The whole point is that there's exactly one place readers look for "what ships today".
