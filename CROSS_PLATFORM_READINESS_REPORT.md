# CROSS-PLATFORM READINESS REPORT

> **Cross-platform readiness campaign — GOAL 12 deliverable** (2026-09-23).
> Formal closure of the campaign: per-subsystem readiness classification,
> gate evidence, open queues. Companion documents (the campaign's substance):
> `docs/PORTABILITY_MAP.md` · `PLATFORM-CONTRACTS.md` · `STATE-MACHINES.md` ·
> `PERSISTENCE-SCHEMAS.md` · `GOLDEN-PARITY.md` · `FAULT-CONTAINMENT.md` ·
> `MOBILE-READINESS.md` · `PLATFORM_CAPABILITY_MATRIX.md`.
> Classification: **READY TO PORT / READY WITH KNOWN ADAPTATION / NOT READY /
> PLATFORM-SPECIFIC BY DESIGN**. No code was translated (campaign rule).

---

## 0. Gate evidence at report time (2026-09-23)

| Gate                       | Result                                                                                                                                                                                                                                                                                                         | Ownership note                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Campaign + core test batch | **200/200 across 25 files** (domain goldens, schema-evolution, fault-containment, velocity-fx, save-drain, platform-contracts, instrument-definitions, shared-data, master-finish, setProject-reentrancy, ydoc-drift, project-invariants, project-io, import-export-robustness, transport, midi-clock-master)  | campaign-owned, green                                                    |
| `tsc --noEmit` (strict)    | Campaign files: **0 errors**. HEAD currently RED from **6 concurrent-session test files** (unused imports + signature drift after their MRT2 changes: suno-mode, transport-audit, undo-redo-audit, recording-audit, project-state-audit, prior-embedding-conditioning)                                         | theirs, committed mid-flight                                             |
| `vite build`               | Currently BLOCKED by a syntax error in `src/presets/factory.ts:2794` — the concurrent session's uncommitted tonal-bank edit (their file, mid-save state). Their last successful dist (Sep 23) reported: entry 222/1070 KB, **DAW JS 2500/2500 KB (at the limit)**, AI runtimes 640/650 KB, worklets 119/150 KB | theirs; **DAW budget effectively exhausted — worth a dedicated session** |
| ModPanel.test              | HANGS (stash-isolated to their in-flight `commands.ts` MRT2 work)                                                                                                                                                                                                                                              | theirs                                                                   |

Honest reading: the **campaign surface is green and regression-pinned**; the
tree as a whole is mid-flight red from the parallel session's feature work —
the same pattern as every prior goal, verified by ownership isolation.

---

## 1. Per-subsystem readiness

| Subsystem                                                                                          | Classification                   | Evidence & conditions                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project model (types, schema, transforms, groove, automation, modulators, scales, markers, scenes) | **READY TO PORT**                | Node-pure (PORTABILITY_MAP §1); normalize idempotency + migrate determinism pinned (round-trip-integrity); goldens cover defaults/clamps (param-math, 34 cases incl. flute). Condition: id source must be host-provided; SCHEMA_VERSION bump requires a real migration step (policy in PERSISTENCE-SCHEMAS §1). |
| Commands / editing operations                                                                      | **READY TO PORT**                | Pure `(doc)→doc` closures, 57-command undo sweep + bounds pins; command-transforms goldens; doc-delta self-verification.                                                                                                                                                                                        |
| Serialization family (share codes, packs, project JSON, MIDI, WAV, favorites pack)                 | **READY TO PORT**                | Byte/doc-level goldens (MIDI full hex, share-code encode, decode pins preserved forever); hostile corpora + caps pinned; WAV seeded-dither byte-reproducible.                                                                                                                                                   |
| Transport + scheduler planning                                                                     | **READY TO PORT**                | `Clock`/`SchedulerDeps` injection; headless since inception; transport-time + scheduler-plan goldens; suspension/re-anchor machines formalized (STATE-MACHINES §1–2).                                                                                                                                           |
| Persistence (contracts + stores)                                                                   | **READY WITH KNOWN ADAPTATION**  | Contracts frozen (11 `I*Repository`); needs a backend implementing `PersistenceContracts` + generalizing the `openDatabase` seam (3/11 today); binary contracts (PCM planar v1, WAV16) must be byte-honored (PERSISTENCE-SCHEMAS §2, risk H for recording chunks).                                              |
| Intent engine (parse → plan → generate)                                                            | **READY TO PORT**                | Pure + seeded end-to-end (229+ tests, deterministic pipelines, favorites core split); ONNX models are an infra decision, the heuristic fallback is pure.                                                                                                                                                        |
| Instrument/effect definitions (metadata)                                                           | **READY TO PORT**                | `INSTRUMENT_META` (15 kinds) + `EFFECT_META` (47 types) are Node-pure, drift-pinned, goldens carry the full defaults tables.                                                                                                                                                                                    |
| DSP runtimes (worklet processors, ~30)                                                             | **READY WITH KNOWN ADAPTATION**  | JS by design (ADR 0004/0005); a native port must re-implement or embed — and pass the bit-exact golden vectors (4 suites) + render parity before shipping sound. Largest single lift (Capability Matrix §3, risk H).                                                                                            |
| Offline rendering                                                                                  | **READY WITH KNOWN ADAPTATION**  | Same-engine offline pattern is the contract; needs the native offline-context equivalent; abort checkpoints + 4 GB guard carry over (Capability Matrix §11).                                                                                                                                                    |
| Collaboration                                                                                      | **READY WITH KNOWN ADAPTATION**  | Codec (`YDocAdapter`) drift-pinned; buffering/degrade/snapshot policies tested; the CRDT runtime itself (yjs) is the port decision; no reconnect logic exists (feature absent).                                                                                                                                 |
| Error containment / diagnostics                                                                    | **READY WITH KNOWN ADAPTATION**  | Boundary map + rejection paths closed (FAULT-CONTAINMENT); host must map platform errors onto the documented error-name semantics.                                                                                                                                                                              |
| Mobile/touch UX                                                                                    | **READY WITH KNOWN ADAPTATION**  | Zero architecture blockers (MOBILE-READINESS); queued: long-press for right-click-only workflows, add-marker tap control, collab offline wording.                                                                                                                                                               |
| Web storage preferences (35+4 keys)                                                                | **READY TO PORT**                | Versioned keys, sanitize-on-read everywhere, one real migration (dock slots); inventory complete.                                                                                                                                                                                                               |
| Generative / MRT2 tracks (`src/generative/*`)                                                      | **NOT READY — NOT YET ASSESSED** | Brand-new surface from the parallel session (in flight during GOALs 07–10); zero campaign audit. Required preparation: a fault-containment + determinism pass like the rest of the app, plus its own golden set.                                                                                                |
| Latency calibration probe                                                                          | **NOT READY (for port)**         | HIGH-risk (recordings off-grid on silent failure) and untested — needs a synthetic pulse→offset harness before any port trusts it (GOAL 08 queue).                                                                                                                                                              |
| Studio UI (React) + PWA delivery                                                                   | **PLATFORM-SPECIFIC BY DESIGN**  | Browser-first is the product (ADR 0001); a native shell would consume the ported domain through the contracts.                                                                                                                                                                                                  |

## 2. Campaign summary (what produced this readiness)

- **GOAL 01** portability audit → PORTABILITY_MAP; save boundary; audition rebuild.
- **GOAL 02** extraction → instruments definitions split, theme/padkey/favorites pure modules.
- **GOAL 03** contracts → effects definitions split (project model reaches NEITHER runtime registry), `PLATFORM-CONTRACTS.md`, persistence contracts threaded through Services, asset-URL seam (10 sites), audio-decode seam.
- **GOAL 04** state machines → STATE-MACHINES (8 machines); write-after-close class killed at the root; renderer bank leak; collab follower resync; glue-park resolved upstream (tests, not engine).
- **GOAL 05** persistence → PERSISTENCE-SCHEMAS registry; schema-evolution matrix (v8 incident class pinned); YDoc drift pin (caught a real tags-materialization drift first run); pluginMode sanitize.
- **GOAL 06** goldens → domain-goldens (6 families, 45+ cases) + capture/replay harness sharing one code path; GOLDEN-PARITY consumer guide; ids nested-restore fix.
- **GOAL 07** fault containment → FAULT-CONTAINMENT map; UI boundaries (Sequencer/Inspector/Palette/TopBar/gallery-cards/Landing); setProject + doSave rejection paths; runtime worklet error reporter.
- **GOAL 08** risk coverage → save-failure drain (services layer), GroovePool/kit-pools/MidiClock-master/zyvo-contract suites; false-confidence cleanup (sec-debug deleted, ai-markov strengthened).
- **GOAL 09** determinism → velocityFx seedable (GOAL 02 claim corrected — randomness is UI-input, values baked into commands); velocity-fx golden family; wall-clock ids verified uniqueness-only by design.
- **GOAL 10** mobile → MOBILE-READINESS (zero architecture blockers); touch-drag hygiene, coarse hit pads, safe areas, `storage.persist()`, constrained-device model gate.

## 3. Open queues (handed to normal maintenance sessions)

1. Concurrent-session HEAD debt: 6 broken test files + `factory.ts` mid-edit + ModPanel.test hang (all theirs, in flight).
2. DAW JS bundle sits AT budget (2500/2500) — needs a tuning session before the next feature wave.
3. `onprocessorerror` across the ~28 unwired node factories (mechanical).
4. Right-click-only workflows on iOS → `useLongPress` reuse (recipe in MOBILE-READINESS §3).
5. Bounce-to-clip persistence warning; latencyProbe synthetic test; ExportPanel real cancel flow; scene-intensity adjacent-window goldens; `openDatabase` injection generalization; E2E specs 02/07 triage (spec 07 `routeToB:false` may be a real routing bug).

## 4. Verdict

The repository is **ready for a port to be PLANNED with confidence** — the
behavior is explicit, the contracts and parity fixtures exist, and the risk
map is honest. Per GOAL 13, the recommended entry point is the pure model
core (slice 1), which is already testable in bare Node today. Whether a port
starts is a product decision — the campaign's objective (behavior explicit
enough to reproduce confidently) is met.
