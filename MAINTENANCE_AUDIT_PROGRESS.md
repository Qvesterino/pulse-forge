# Maintenance Audit Progress

Sequential maintenance & hardening pass over **Pulse Forge** (browser DAW).

- Prompts: `prompts/00_CORE` (master operating rules), `prompts/01_COMMON` (audits 01–12), `prompts/03_PULSE_FORGE` (audits P01–P07).
- `MASTER_DAW_HARDENING_PROMPT.md` in `00_CORE` is the shared operating constitution (loop + non-negotiable rules), applied to every audit below — it is not a separate mission.
- Status legend: `[ ]` pending · `[~]` running · `[x]` completed · `[!]` blocked / needs human review.
- Rule: strictly one audit at a time, in the order below. Do not start the next until the current one is complete, verified (typecheck + tests), and recorded here.
- Each audit must end with: defects found/fixed, tests added/strengthened, commands run + outcomes, remaining risks, files changed.

## Execution order

### Phase A — Common audits (01_COMMON)

- [x] 01 — Critical Path Audit (`01_CRITICAL_PATH_AUDIT.md`)
- [x] 02 — Recovery Path Audit (`02_RECOVERY_PATH_AUDIT.md`)
- [x] 03 — Project Persistence & Data Integrity Audit (`03_PROJECT_DATA_INTEGRITY_AUDIT.md`)
- [x] 04 — Undo / Redo Integrity Audit (`04_UNDO_REDO_INTEGRITY_AUDIT.md`)
- [~] 05 — Cross-Component Contract Audit (`05_CROSS_COMPONENT_CONTRACT_AUDIT.md`)
- [ ] 06 — State Consistency & Invariant Audit (`06_STATE_INVARIANT_AUDIT.md`)
- [ ] 07 — Import / Export Robustness Audit (`07_IMPORT_EXPORT_ROBUSTNESS.md`)
- [ ] 08 — Performance & Resource Leak Audit (`08_PERFORMANCE_RESOURCE_LEAK_AUDIT.md`)
- [ ] 09 — Dependency Health & Supply Chain Audit (`09_DEPENDENCY_HEALTH_AUDIT.md`)
- [ ] 10 — Security Surface Audit (`10_SECURITY_SURFACE_AUDIT.md`)
- [ ] 11 — Dead / Suspicious / Legacy Code Audit (`11_DEAD_SUSPICIOUS_CODE_AUDIT.md`)
- [ ] 12 — Final Reliability Sweep (`12_FINAL_RELIABILITY_SWEEP.md`)

### Phase B — Pulse Forge domain audits (03_PULSE_FORGE)

- [ ] P01 — Audio Scheduler Precision Audit (`01_AUDIO_SCHEDULER_PRECISION_AUDIT.md`)
- [ ] P02 — Browser Audio Lifecycle Audit (`02_BROWSER_AUDIO_LIFECYCLE_AUDIT.md`)
- [ ] P03 — Sequencer Integrity Audit (`03_SEQUENCER_INTEGRITY_AUDIT.md`)
- [ ] P04 — Web Audio Graph Lifecycle Audit (`04_WEB_AUDIO_GRAPH_LIFECYCLE_AUDIT.md`)
- [ ] P05 — Beat Engine Stress Audit (`05_BEAT_ENGINE_STRESS_AUDIT.md`)
- [ ] P06 — Browser Compatibility Hardening Audit (`06_BROWSER_COMPATIBILITY_HARDENING.md`)
- [ ] P07 — Offline Render / Export Accuracy Audit (`07_OFFLINE_RENDER_EXPORT_ACCURACY_AUDIT.md`)

### Final

- [ ] Full verification suite: `npm run typecheck` + `npm test` + `npm run build`
- [ ] Final summary: fixes, tests added, remaining risks, blocked items

## Results log

| Audit | Status | Findings | Fixes | Tests added/changed | Verification |
| ----- | ------ | -------- | ----- | ------------------- | ------------ |
| (baseline) | done | `npm run typecheck` clean. Full `npm test`: 1811 passed / 3 failed / 94 skipped — failures pre-exist the audit (2 files incl. `tests/ui/EffectRack.test.tsx`). Full re-run with log capture in progress. | — | — | typecheck ✓ / tests ✗(3) |
| 01 Critical Path | done | **D1:** `openProject` fire-and-forget continuations raced `closeProject` — a late frozen-audio restore re-pointed the shared engine at the closed project's doc (`engine.setProject(store.doc)` in `finally`), and a late Web MIDI permission grant wired handlers into a dead store (engine divergence, phantom MIDI playback). **D2:** `main.tsx openDoc` dropped `openProject` rejections → silent no-op when opening fails. **D3:** flaky lazy-chunk UI test waits (1s default timeout vs dynamic-import latency under suite load; failed 3→2 tests across two baseline runs). | D1: `closed` flag in `openProject` scope guards the restore continuation (unfreeze commands + `finally` engine sync) and the MIDI grant continuation; set first in `closeProject`. D2: rejection surfaces via error screen (`openDoc`); `backToBrowser` still lands in browser on close failure with `console.error`. D3: explicit 10s timeouts on lazy-panel waits. | NEW `tests/services-close-race.test.ts` (4 tests; verified failing 3/4 on pre-fix code by temporary revert); stabilized `tests/ui/EffectRack.test.tsx` + `tests/ui/midi-io.test.tsx` waits. | typecheck ✓; targeted vitest ✓ (39 tests); prettier ✓ |
| 02 Recovery Path | done | **D1:** `ensureContext()` ran `void ctx.resume()` unguarded — rejects NotAllowedError without user gesture (the exact scenario it targets) → unhandled rejection on every suspended ensureContext (visibilitychange, clicks). Every other resume site in the repo already had `.catch`. **D2:** MIDI controller unplugged mid-hold never delivers note-off → Note Repeat roll fires forever with no UI recovery; `reconnectAll` removed the listener but left holds alive. Verified already-hardened (prior passes, no new work): interrupted save/pagehide drain, corrupt+newer-schema records, crash & per-panel ErrorBoundaries, save-error UI retry, missing media (synth fallback, missedAssets, auto-unfreeze, per-entry user-sample restore), scheduler suspend/resume re-anchor, db open retry, collab hardening suite. Residual (not defects): autosave depends on `onDocChanged` completing — engine-sync throw would skip save scheduling (no reachable input found; speculative guard rejected); no snapshot-restore UI (product gap, out of scope). | D1: `.catch(() => {})` on the resume, pinned by a source-grep test. D2: `NoteRepeatController.stopWithPrefix(prefix)` + `MidiInput.onstatechange` releases `midi:`-prefixed holds on `port.state === "disconnected"` (and on port-map removal in `reconnectAll`); UI `pad:` holds unaffected. | `tests/audio-engine-lifecycle.test.ts` +1 (resume catch pinned); `tests/note-repeat.test.ts` +2 (prefix stop semantics, timer prune); `tests/midi/MidiInput.test.ts` +2 (disconnect releases midi holds, connect/no-op keeps them). | typecheck ✓; targeted vitest ✓ (44 tests); prettier ✓ |
| 03 Project Data Integrity | done | No defects found — verified clean. Prior coverage proved partial-write atomicity (two-store transaction, `tx` resolves on `oncomplete`), corrupt/newer-version record isolation, and shape validation, but the required *deep* invariants were untested (existing round-trip tests only checked id/name/bpm/counts). New suite proves over ALL 8 templates: deep `save→load` equality (minus `updatedAt` re-stamp, by design), load-of-load fixed point, `normalizeProject` idempotency, `migrateProject` idempotency + determinism, corruption healing to a stable doc surviving persistence, and JSON-boundary (share-code/export shape) round-trip. One observation, not a defect: persisted `updatedAt` rides inside the doc body via unknown-field passthrough (harmless, tolerated by validation). | None needed. | NEW `tests/persistence/round-trip-integrity.test.ts` (7 tests). | typecheck ✓; targeted vitest ✓ (7 tests) |

> Append one row per completed audit. Keep this file updated continuously so interrupted runs can resume from the first unfinished item.
