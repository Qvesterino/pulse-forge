# PLATFORM CAPABILITY MATRIX

> **Cross-platform readiness campaign — GOAL 11 deliverable** (2026-09-23).
> A technical migration map: per capability, what the Web implementation
> does today, what Android/iOS implementations are expected to provide, what
> logic is shared as-is, which adapter is required, and the migration risk.
> **Every cell is sourced from the campaign documents** — no new claims:
> PORTABILITY_MAP · PLATFORM-CONTRACTS · STATE-MACHINES · PERSISTENCE-SCHEMAS ·
> GOLDEN-PARITY · FAULT-CONTAINMENT · MOBILE-READINESS.
>
> "Expected" Android/iOS rows are design guidance for a future port, **not
> commitments** — the product remains browser-first (ADR 0001), and the
> Electron desktop shell already proves the thin-bridge pattern.

Legend for risk: **L** = mechanical · **M** = contained work, known surface ·
**H** = needs parity proof against existing golden vectors.

---

## 1. Project model

|                        |                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web today              | Pure TypeScript (`src/project-model`): SCHEMA_VERSION 1, `validateProjectShape → migrateProject → normalizeProject` (18 domains, idempotent, never throws), `uid()` ids with a test-only deterministic mode. Consumed through `INSTRUMENT_META` / `EFFECT_META` — the model reaches **neither runtime registry** (pinned by `tests/domain-purity.test.ts`). |
| Android / iOS expected | Port the model modules 1:1 (they are Node-pure today — no host APIs).                                                                                                                                                                                                                                                                                       |
| Shared logic           | `project-model/*`, `commands/*` (pure `(doc) → doc` closures), `shared/rng`, `shared/ids`, instrument/effect definitions.                                                                                                                                                                                                                                   |
| Required adapter       | None for the model itself; id generation needs a host source (uuid or seeded).                                                                                                                                                                                                                                                                              |
| Limitations            | SCHEMA_VERSION 1 discriminates nothing — compatibility IS `normalizeProject`, whose output evolves with builds (recorded; bump-on-breaking policy). `crypto.randomUUID` ids are non-reproducible (sequential test mode proves the alternative). Wall-clock ids in two `commands.ts` sites are uniqueness-only by design.                                    |
| Risk                   | **M** — normalize drift across builds; mitigation exists (schema-evolution matrix + drift pins).                                                                                                                                                                                                                                                            |

## 2. Persistence

|                  |                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web today        | IndexedDB via the single choke point `persistence/db.ts` (DB_VERSION 12, 15 stores, create-only upgrades); 11 `I*Repository` contracts (`persistence/contracts.ts`) threaded through `Services`; binary payloads: frozen audio = WAV 16-bit, recordings = raw planar Float32 (`pcm-f32-planar-v1`), user audio = original bytes/Blob. Full inventory + per-store versioning classes in PERSISTENCE-SCHEMAS. |
| Android expected | SQLite/Room classes implementing the same interfaces, injected via `PersistenceContracts` at the composition root.                                                                                                                                                                                                                                                                                          |
| iOS expected     | Same; plus installed-app storage removes the ~7-day eviction risk (web mitigates via `navigator.storage.persist()` at boot + install prompt).                                                                                                                                                                                                                                                               |
| Shared logic     | Sanitizers, caps, prune policies, PCM materialization math — all documented as part of the observable contract.                                                                                                                                                                                                                                                                                             |
| Required adapter | Backend bundle implementing `PersistenceContracts`; `openDatabase` injection exists on 3 of 11 repos (generalization queued).                                                                                                                                                                                                                                                                               |
| Limitations      | Recording-chunk reads are all-or-nothing strict (sequence + byte-exact) — chunking contract is implicit in the worklet; GroovePool/Kit repos are raw-cast by documented contract.                                                                                                                                                                                                                           |
| Risk             | **H** for `recording-chunks` (any chunking change orphans takes — write `pcm-f32-planar-v2` tags when it changes), **M** elsewhere (schema-evolution matrix pins behavior).                                                                                                                                                                                                                                 |

## 3. Audio engine (live + offline)

|                  |                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web today        | Web Audio + AudioWorklet. Context creation/graph rebuild only via `AudioEngine.useContext`; one shared engine for live and offline (`renderProject` hands it an OfflineAudioContext); scheduler gates on context state (suspension-safe, re-anchors on resume); worklet load failure → native fallback + degraded surfacing; runtime processor errors counted (`processor-errors.ts`). |
| Android expected | Native audio backend (Oboe/AAudio class) implementing the two existing ports: context lifecycle (create/resume/rebuild) and `SchedulerDeps` (trigger/noteOn/automation/midiCC — already driven headless in tests).                                                                                                                                                                     |
| iOS expected     | Same + `AVAudioSession` interruption mapping onto the existing suspend/resume/recover state machine (verified suspension-safe in MOBILE-READINESS); mic interruptions already stop-to-recovery with a bounded resume timeout.                                                                                                                                                          |
| Shared logic     | Scheduler planning (pure over doc+transport), transport `Clock` injection, instruments/effects PARAMETER logic (definitions), offline render event planning (render-event parity tests).                                                                                                                                                                                               |
| Required adapter | Context lifecycle + audio host + **DSP re-implementation or embedded runtime for ~30 worklet processors** — the largest single lift.                                                                                                                                                                                                                                                   |
| Limitations      | DSP is JavaScript by design (ADR 0004/0005); 4 plugin suites have bit-exact golden vectors, the rest have round-trip/render tests; latency probe is platform-specific.                                                                                                                                                                                                                 |
| Risk             | **H** — mitigated by the golden-vector suites a port must pass before shipping sound.                                                                                                                                                                                                                                                                                                  |

## 4. Filesystem (save handoff)

|                        |                                                                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web today              | No direct FS access; every artifact funnels through `downloadBlob` (`src/export/download.ts`) — Blob → anchor → 5 s revoke; Electron bridges via `will-download` → native Save-As. |
| Android / iOS expected | System save/share targets; iOS Files app.                                                                                                                                          |
| Shared logic           | All byte producers (WAV encoder with seeded dither, ZIP writer, JSON serializers) are pure.                                                                                        |
| Required adapter       | Replace ONE function (documented save boundary).                                                                                                                                   |
| Limitations            | None architectural.                                                                                                                                                                |
| Risk                   | **L**.                                                                                                                                                                             |

## 5. File picker / import

|                        |                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Web today              | `<input type="file">` (5 sites) + drag-drop; caps: project 10 MiB, samples 25 MiB; every import path validates (`parseAndValidate`, hostile corpora pinned). |
| Android / iOS expected | System pickers (SAF / Files) feeding the same byte pipelines.                                                                                                |
| Shared logic           | Import semantics are pure (JSON/MIDI/WAV matrices in import-export-robustness).                                                                              |
| Required adapter       | Picker UI only.                                                                                                                                              |
| Limitations            | None.                                                                                                                                                        |
| Risk                   | **L**.                                                                                                                                                       |

## 6. Sharing

|                        |                                                                                                                                                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web today              | lz-string share codes — prefixed variants (`PFKIT1:` `PFBIND1:` `PFTHM1:` `PFPACK1:`) and the bare share code; decode pins (`decode-goldens.json`) must decode identically forever; caps 2 M chars / 8 M decompressed; favorites pack JSON `{version:1}` consumed by Node trainers. |
| Android / iOS expected | Native share sheet + the same codecs.                                                                                                                                                                                                                                               |
| Shared logic           | Encoders/decoders are pure (byte- and doc-level goldens exist).                                                                                                                                                                                                                     |
| Required adapter       | Share-sheet invocation; clipboard via native API.                                                                                                                                                                                                                                   |
| Limitations            | Server-side gallery cap (400 k) diverges from the client cap (2 M) — recorded; the share code has NO container prefix (adding one breaks existing shares — recorded non-change).                                                                                                    |
| Risk                   | **L–M** (cap divergence is a product decision, not technical).                                                                                                                                                                                                                      |

## 7. Clipboard

|                        |                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| Web today              | `navigator.clipboard.writeText` at 7 UI sites, explicit availability check in IntentPanel. |
| Android / iOS expected | Same API works in WebView/standalone; native clipboard otherwise.                          |
| Required adapter       | None (or a fallback for locked-down webviews).                                             |
| Risk                   | **L**.                                                                                     |

## 8. Notifications

Not used anywhere in `src/` (verified GOAL 03/07). Add a contract only when a feature needs it. **Risk: —.**

## 9. Permissions

|                        |                                                                                                                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web today              | Mic via `getUserMedia` with error-name → user-message mapping (typed quota errors in recovery repo); MIDI via `requestMIDIAccess` try/catch (feature-absent = silent degrade); no `navigator.permissions.query` usage. |
| Android / iOS expected | Runtime permission prompts mapped onto the same error-name semantics; iOS MIDI availability varies (graceful).                                                                                                         |
| Shared logic           | Capability-detection pattern (`typeof` guards, fail-soft) is uniform.                                                                                                                                                  |
| Required adapter       | Permission → error-name mapping in the host bridge.                                                                                                                                                                    |
| Risk                   | **L–M** (iOS MIDI).                                                                                                                                                                                                    |

## 10. Background execution

|                        |                                                                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web today              | No background work by design: scheduler gates on context state while hidden (window walks, no wedge, re-anchor on resume), meters ride the shared rAF (browser-paused), `pagehide` flushes saves, SW precaches. |
| Android / iOS expected | Background audio = foreground service / background-audio entitlement (native).                                                                                                                                  |
| Shared logic           | The state machines already survive suspension (STATE-MACHINES §1/§3; MOBILE-READINESS §1).                                                                                                                      |
| Required adapter       | Platform background-audio mode + its notification surface.                                                                                                                                                      |
| Limitations            | iOS `interrupted` state resume hang is already bounded (10 s) in the recorder.                                                                                                                                  |
| Risk                   | **M**.                                                                                                                                                                                                          |

## 11. Rendering (offline export)

|                        |                                                                                                                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web today              | Same engine, OfflineAudioContext, 4 abort checkpoints + per-stage aborts (MP3 chunks, video loop, stems); 4 GB WAV guard fires before rendering; stems are a pure transform; video prefers MP4→WebM. |
| Android / iOS expected | Native offline render through the ported engine, or embedded runtime; abort checkpoints carry over.                                                                                                  |
| Shared logic           | Render event planning + stems + encoders (WAV/MP3 byte-reproducible via fixed dither seeds).                                                                                                         |
| Required adapter       | Offline-context equivalent in the native backend.                                                                                                                                                    |
| Limitations            | MP3 via lame-wasm (native needs a lame build); video via MediaRecorder (native muxer).                                                                                                               |
| Risk                   | **H** (same DSP parity class as §3), encoders themselves **L**.                                                                                                                                      |

## 12. Networking / collaboration

|                        |                                                                                                                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web today              | y-websocket + BroadcastChannel (no raw sockets in app code); endpoints derived from `location`, user overrides gated by `isAllowedServerUrl`; 8 s sync guard degrades to local editing with pre-adopt snapshot safety; status pill UX. |
| Android / iOS expected | Native WebSocket transport + a CRDT layer (yjs is JS — embed or port `YDocAdapter` semantics); endpoint CONFIG injection replacing `location` derivation (contract documented, migration deferred until a second host exists).         |
| Shared logic           | `YDocAdapter` codec (drift-pinned), command buffering policy (≤200, in-order flush), role gates, `isAllowedServerUrl` security rule.                                                                                                   |
| Required adapter       | Transport host + endpoint provider + CRDT runtime decision.                                                                                                                                                                            |
| Limitations            | No reconnect logic exists (feature absent); relay-down self-seed degradation documented.                                                                                                                                               |
| Risk                   | **M–H** (CRDT runtime reuse is the crux; the codec and policies are pinned by tests).                                                                                                                                                  |

## 13. Import / export semantics

Covered across §4–§6 + PERSISTENCE-SCHEMAS §3 (11 formats with markers, validation, caps): project JSON (schema gates + 10 MiB), MIDI (format 1 only, strict rejections, full-hex golden), WAV (16/24/32f, seeded dither — byte-reproducible), MP3 (fixed seeds), scorepack (`version:"1.0"` ZIP), zyvo (`com.kyx.zyvo-transfer` v1, 1 GiB), favorites pack (v1 additive). **Risk: L** — the byte-level goldens are exactly what a port replays.

## 14. Concurrency (workers)

|                        |                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web today              | 10 workers with uniform degradation (`typeof Worker` guard → pure sync main-thread fallback), job-id + timeout + circuit-breaker wrappers; realtime DSP in AudioWorklets. |
| Android / iOS expected | Threads/executors; keep the synchronous path alive — the fallbacks are what the parity tests already exercise headless.                                                   |
| Required adapter       | Worker → thread mapping per host.                                                                                                                                         |
| Risk                   | **M** (fallbacks are the safety net; ONNX wasm becomes an ONNX mobile runtime decision).                                                                                  |

## 15. UI layer

**PLATFORM-SPECIFIC BY DESIGN.** React 18 studio UI is not portable; a native shell would consume the ported domain through the contracts above (the mobile audit confirmed the touch layer needs adaptation work regardless — queued list in MOBILE-READINESS §3). Route apps (embed/gallery/landing) each sit behind their own error boundaries today.

---

## Migration-risk summary

| Risk    | Capabilities                                                                                         |
| ------- | ---------------------------------------------------------------------------------------------------- |
| **H**   | Audio engine DSP (§3), offline rendering (§11), recording-chunk binary contract (§2)                 |
| **M–H** | Collab CRDT runtime (§12)                                                                            |
| **M**   | Project model normalize drift (§1), persistence backends (§2), background audio (§10), workers (§14) |
| **L**   | Filesystem, pickers, sharing, clipboard, permissions, import/export encoders                         |

Everything in the **H** rows already has golden vectors or strict matrices that a port must pass — the risk is effort, not unknowns.
