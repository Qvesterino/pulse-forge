# Current State — single source of truth

**Last verified:** 2026-09-24
**Verified by:** direct count against `src/effects/registry.ts`, `src/instruments/registry.ts`, `docs/adr/` and `tests/`.

This document is the **single source of truth** for the headline numbers about KYX / Pulse Forge. Older documents in this repo (`RELEASE_ROADMAP.md`, `DSP-ROADMAP.md`, `EDIT-ROADMAP.md`, `INSTRUMENT-ROADMAP.md`, `SCENE-MODE-ROADMAP.md`, `INTENT_ENGINE.md`, `KYX_CURRENT_STATE.md`, `MAINTENANCE_AUDIT_PROGRESS.md`, `PERFORMANCE.md`) may carry their own point-in-time numbers; when those disagree with the figures below, **this document wins** for the question "how many / what ships today?".

For an architecture overview, see `ARCHITECTURE.md` and `docs/adr/`. For a user-facing description of every feature, see `README.md`.

---

## Headline numbers

| What                                   |   Count | Source of truth                                                                                                                                                           |
| -------------------------------------- | ------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Instruments** (melodic track kind)   |  **15** | `INSTRUMENT_DEFS` / `InstrumentKind` in `src/instruments/registry.ts` and `src/project-model/types.ts`                                                                    |
| **Effects** (registry entries)         |  **47** | `EFFECT_DEFS` in `src/effects/registry.ts` (mirrors `EffectType` union in `src/project-model/types.ts`)                                                                   |
| └─ native/core effects                 |      42 | `EFFECT_ORDER` excluding flagship suites                                                                                                                                  |
| └─ primary Add Effect choices          |      26 | `CORE_EFFECT_ORDER` (the rest are surfaced through the effect rack)                                                                                                       |
| └─ flagship plugin suites              |   **5** | `FLAGSHIP_EFFECT_ORDER` (`fxeq`, `ultina`, `ozvena`, `kaskada`, `morphdynamics`)                                                                                          |
| **Project templates**                  |  **12** | `TemplateId` union in `src/project-model/templates.ts`                                                                                                                    |
| **Factory assets** (drum / tonal / FX) |  **71** | `FACTORY_ASSETS` in `src/sample-library/manifest.ts`                                                                                                                      |
| └─ curated WAV overrides               |      68 | `CURATED_SAMPLES` in `src/sample-library/curated.ts` (same-id override contract; synthesized fallback retained on failure — the 3 mallet assets are synthesis-only today) |
| **Factory presets**                    | **325** | `src/presets/factory.ts`                                                                                                                                                  |
| └─ instrument presets                  |     319 | `FACTORY_PRESETS`                                                                                                                                                         |
| └─ drum-synth presets                  |       6 | `DRUM_FACTORY_PRESETS`                                                                                                                                                    |
| **Architecture decision records**      |  **15** | `docs/adr/0001` … `0013`, plus 0006/0007 each have two companion files                                                                                                    |
| **Vitest spec files**                  | **494** | `tests/` files matching `*.test.ts` (393) and `*.test.tsx` (101)                                                                                                          |

## Flagship plugin implementations

| Plugin suite    | Brand             | DSP core / ownership                                         | Worklet bundle                     |
| --------------- | ----------------- | ------------------------------------------------------------ | ---------------------------------- |
| `fxeq`          | **PRISM**         | `src/effects/fxeq-core/` (vendored upstream)                 | `public/fxeq-worklet.js`           |
| `ultina`        | **VLYX**          | `src/effects/ultina-core/` (vendored upstream)               | `public/ultina-worklet.js`         |
| `ozvena`        | **VØID**          | `src/effects/ozvena-core/` (vendored upstream)               | `public/ozvena-worklet.js`         |
| `kaskada`       | **Kaskáda Delay** | first-party DSP in `src/audio-worklets/kaskada-processor.js` | `public/core-worklet.js`           |
| `morphdynamics` | **MORPH**         | first-party DSP in `src/effects/morph-dynamics-core/`        | `public/morph-dynamics-worklet.js` |

All five flagship suites use AudioWorklet DSP. PRISM, VLYX and VØID include separately vendored cores reconciled by `scripts/vendor-*.mjs`; Kaskáda and MORPH are first-party DSP owned in-tree. Plugin-specific regression / golden test suites live under `tests/<plugin>-vectors/` and `tests/<plugin>-golden/`.

## AI models shipped in the browser

| Model                      |   Size | Feature version                     | Role                                                              |
| -------------------------- | -----: | ----------------------------------- | ----------------------------------------------------------------- |
| `intent-ranker-v1.onnx`    | ~25 KB | `features.v1` (54 features)         | heuristic-vs-ONNX ranker, default **active** (0.6/0.4 blend)      |
| `symbolic-prior-v1.onnx`   | ~20 KB | `prior-features.v1` (44 features)   | drum prior fallback branch (one-hot style×role×position)          |
| `symbolic-prior-v2.onnx`   | ~18 KB | `prior-features-v2` (35 features)   | drum prior intermediate (16-dim semantic conditioning)            |
| `symbolic-prior-v3.onnx`   | ~24 KB | `prior-features-v3` (60 features)   | drum prior **default** branch (hybrid, valAUC 0.920)              |
| `symbolic-melodic-v1.onnx` | ~18 KB | `melodic-features.v1` (29 features) | melodic next-note prior, **preferred** (valDegreeAcc 0.679)       |
| `symbolic-melodic-v2.onnx` | ~21 KB | `melodic-features-v2` (41 features) | melodic embedding variant, fallback only (regression on 190 rows) |

All six are loaded lazily in dedicated Web Workers with bounded timeouts + circuit breaker + deterministic heuristic fallback (`src/ai/ranking/ranker-client.ts`, `src/ai/symbolic/prior-client.ts`). Inference never runs on the audio thread. Two further models are lazy-fetched on demand (not in git): multilingual MiniLM q8 ~118 MB (`npm run semantic:fetch` → `public/models/semantic/`) and AST AudioSet q8 ~86.6 MB (`npm run audio:fetch` → `public/models/audio/`); both degrade to keyword/heuristic paths when absent. The retrained `hybrid v3` symbolic prior (label smoothing + variant embeddings, logit saturation fix) is the active generation source behind the candidate bank; see `INTENT_ENGINE.md` for the full conditioning chain (semantic embedding, user style vector, SUNO MODE button).

## Platform reach

- **Browser** — Chromium-family, Firefox and Microsoft Edge are target environments. The last recorded 226/226-per-browser result is a historical baseline from 2026-09-14, not verification of the current revision.
- **Desktop** — Windows x64 shipped (NSIS installer + portable exe via `electron-builder`). The MRT2 macOS arm64 path now has a GitHub Actions package gate: after all shared CI checks pass, it builds a DMG + ZIP, verifies the DMG and packaged arm64 app/helper, boots the packaged Electron app in smoke mode, then uploads a 14-day QA artifact. This artifact is unsigned/unnotarized and does not include model weights; it is not a public macOS release or proof of MRT2 inference. Windows MRT2 uses a separate optional companion boundary and remains capture/near-realtime/realtime only after capability and benchmark evidence. Auto-update through GitHub Releases (ADR 0011).
- **Safari / iOS Safari** — manual smoke only; not covered by automated browser verifier.
- **macOS / Linux desktop** — not shipped (ADR 0010 is Windows-only by current target list). The macOS MRT2 CI artifact is an opt-in QA build only; signing/notarization and a real model-inference test remain release requirements.

## Recent additions (last two weeks)

High-level summary of what landed on top of the 2026-09-14 release-readiness candidate. Each item maps to one or more git commits and lives in `src/` today.

### Instruments

- **Flute** (kind #15) — breath-noise + delayed vibrato + legato glide (slide-from with a `GLIDE` knob) + overblow harmonic + formant / drive body. 10 factory presets covering drill slide leads, memphis / liquid / jersey / pan / whistle / breath / reed / air timbres. Browser factory audio QA 252/252. _(feat a2992f2)_

### Effects

- **Morph Dynamics** — fifth flagship plugin. First-party DSP, dedicated `morph-dynamics-worklet.js`, panel under `src/ui/MorphDynamicsPanel.tsx`. _(feat `no dobre teraz` / `okay vša`)_.
- **Granular Freeze send** — texture engine wrapped as a send-effect: freeze latch captures a window, granular cloud (64 grains, 4× overlap, Hann) plays the frozen buffer, dry path is ducked by the same envelope so the send stays usable (not a stack). Released crossfade returns to the live signal. 5 factory presets (Pad Hold / Shimmer Cloud / Deep Drone / Glitch Cloud / Tape Hold). _(feat `700c20d`)_
- **Telephone preset pack** — SVF narrow-band + distortion character for the lo-fi phone / handset chain beatmakers reach for on hooks and fills. 5 pure-preset entries (svf-telephone-band / svf-telephone-band2 / svf-radio-mid / dist-telephone / dist-intercom); no new DSP. _(feat `700c20d`)_
- **Beatmaking expansion** — tapeStop, ringMod, freqShifter, pitchShift, vinyl, beatMangler, multiTapDelay + bassMono master utility. Each ships a dedicated worklet processor, panel UI, factory presets and regression / golden tests. _(feat `0899762`)_
- **Vocoder + Reverse Swell** — two new character send-effects for the FX rack. _(feat `b3a6c69` family)_

### Sample bank expansion

- Kick bank 6 → 15 — drill / phonk / 808s / vintage / club punches / boom-bap knock; genre kits carry dedicated kicks.
- Snare bank 4 → 9 — drill crack, phonk / jersey / dnb backbeats, lofi dust.
- Hat bank 5 → 10 — drill tick, phonk dusty, jersey / dnb metallic pings, open cup; hat.pedal synth pulled apart from closed.soft (0.993 duplicate pair). _(feat `38b8fd0`, `378ab36`)_

### Preset expansion

- Synth presets 199 → 220 — 21 genre-anchored synth voices (analog leads / stabs / pads, wavetable morph leads, fm bells / keys, club plucks). _(feat `7af7c0d`)_
- Drum presets 220 → 232 — 12 genre-anchored drum-synth voices (drill crackers, memphis snare, dusty tom, jersey clap, dnb snare / rim / open cup, first Rimshot type). _(feat `027dcab`)_
- 808 presets 232 → 242 — 10 genre-anchored 808 voices with `GLIDE` front and center for drill / phonk slide ladder. _(feat `2ba6a9d`)_
- Browser factory preset audio QA currently green at 252/252 (after Flute preset addition).

### Intent and AI

- **SUNO MODE button** — "one sentence to a finished track" UI mode plus dynamic song-form expansion (intro / build / drop / outro). Embedding shadow A/B harness for safe rollout. _(feat `e7d3071`, `add0f8b`)_
- **Audio reference intent** — `feat: make it sound like this WAV`. _(feat `daa7d8a`)_
- **User style vector** — blend star-roll embeddings into the conditioning. _(feat `7491b11`)_
- **Melodic prior v2** — embedding-conditioned (41-dim semantic) melodic prior. _(feat `5e571ac`)_
- **Embedding-conditioned prior v2** — Phases D–F of the conditioning chain. _(feat `c7df20b`)_
- **Hybrid v3 prior (active)** — retrained with label smoothing + variant embeddings, logit-saturation fix; activation commit flips the runtime to the new model. _(feat `64e2b61`, `8bd904c`)_
- **Vocabulary wave** — 38 artists, sub-genres, mood / trait expansion. _(feat `33d05a2`)_
- **World roster + genre depth** — 61 artist presets total (researched BPM ranges), roller/amen/horrorcore grooves, producer session dialogue. _(feat `a1e1a1b`..)_
- **Augmented datasets into all four prior training chains.** _(feat `0c6b105`)_

### Arrangement

- Arrangement-as-a-tool — variant swap, ripple edit, paint wiring. _(feat `2a7aa23`)_
- Finish the tool wave — drop-swap, multi-ripple, ghost preview. _(feat `49f678c`)_
- Determinism: velocityFx seedable, determinism verdicts recorded. _(feat `98e2e3b`)_

### Architecture

- **ADR 0012 — MRT2 generative tracks** records the Mac Apple-Silicon-only generative-tracks helper path; the helper builds in `native/mrt2-host/`, packaging lives in `electron-builder.yml` and `desktop:build:mac:mrt2`. `.github/workflows/ci.yml` gates its downloadable QA artifact on the shared test suite and packaged-app smoke verification.
- **ADR 0013 — Windows generative companion tiers** records the separate Windows manager/transport, capture-first capability tiers, benchmark gate and fixed optional companion/model paths. The checked-in JAX capture host, opt-in WSL2/CUDA near-realtime launcher, SHA-256 package manifest verifier and guarded model-data uninstall script live under `companion/mrt2-windows/`, `desktop/` and `scripts/`; the macOS helper remains Apple Silicon-only. The 2026-09-25 RTX 3060 Laptop 600 s WSL2 stream failed promotion (35.98 ms p95, 9 overruns), so Windows live playback is still experimental and is not advertised as promoted realtime.

## Prior test-gate baseline — not verified on the current revision

The following historical results were recorded against candidate `b8c7a00` on 2026-09-14. The referenced `RELEASE_READINESS_REPORT.md` is not present in this checkout, so these figures are context only, not release evidence for the current revision. Re-run each gate before relying on it.

| Gate                                 | Historical result                                                        | Source                            |
| ------------------------------------ | ------------------------------------------------------------------------ | --------------------------------- |
| `npm run typecheck`                  | PASS (clean `tsc --noEmit`)                                              | candidate `b8c7a00`, 2026-09-14   |
| Full Vitest suite                    | **239 files / 2351 tests passed / 103 skipped / 2454 total** (`424.94s`) | candidate `b8c7a00`, 2026-09-14   |
| Real-browser verifier                | **226/226 in Chromium, Firefox and Edge**                                | candidate `b8c7a00`, 2026-09-14   |
| Factory preset audio QA              | **292/292**                                                              | candidate `b8c7a00`, 2026-09-14   |
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

- It is **not** a roadmap. See `RELEASE_ROADMAP.md`, `EDIT-ROADMAP.md`, `INSTRUMENT-ROADMAP.md`, `DSP-ROADMAP.md`, `SCENE-MODE-ROADMAP.md`, `INTENT_ENGINE.md` and `docs/IMPLEMENTATION-ROADMAP-MRT2-GENERATIVE-TRACKS.md` for planned work.
- It is **not** an architecture reference. See `ARCHITECTURE.md` and `docs/adr/`.
- It is **not** a user-facing feature description. See `README.md`.
- It is **not** a changelog. See `git log --oneline` and the commit messages; the "Recent additions" section above is a curated digest, not the full history.

When you change a number above (e.g. you add a new instrument and `INSTRUMENT_DEFS` grows to 16), update this file in the same commit. The whole point is that there's exactly one place readers look for "what ships today".
