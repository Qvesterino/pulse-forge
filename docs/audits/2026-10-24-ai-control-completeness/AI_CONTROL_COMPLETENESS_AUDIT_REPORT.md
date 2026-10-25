# AI Control Completeness Audit — KYX / Pulse Forge

| Field            | Value                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Audit date       | 2026-10-24 (UTC)                                                                                                         |
| Repository       | `D:\pulse-forge`                                                                                                         |
| Revision audited | `f61da8eb` at audit start, with concurrent sessions committing during the audit (see Evidence limits)                    |
| Scope            | UI, Intent Engine, MCP desktop/web transports, command layer, project state, audio projection, undo, persistence, export |
| Mode             | Read-only audit. No production code, schema, dependency, tool contract or UI change. One disposable probe was removed.   |
| Report location  | `docs/audits/2026-10-24-ai-control-completeness/AI_CONTROL_COMPLETENESS_AUDIT_REPORT.md`                                 |

## Status vocabulary

| Status                            | Meaning in this report                                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Verified end-to-end (document)    | Executed in this audit against the real command/store boundary; committed state and undo were asserted. Audio/DSP was not measured. |
| Verified end-to-end (persistence) | Executed in this audit or by a committed test that binds the real repository; state survived flush/reload.                          |
| Wired, not end-to-end verified    | Source path and tests exist, but this audit did not execute the full downstream effect (typically audio, transport or UI).          |
| Partially supported               | Some essential variants, controls or transports are missing.                                                                        |
| Broken / misleading               | The path exists but produces an ineffective, incorrect, unauthorized or overstated result.                                          |
| Not exposed                       | The real feature exists in the product but no approved AI path exists.                                                              |
| Intentionally restricted          | A documented refusal or boundary. The restriction itself is not a defect.                                                           |
| Unknown                           | Insufficient evidence; the report states how to close it.                                                                           |

A “document” verification is deliberately not called an audio verification. The project document is the state authority; PCM/DSP remains a separate claim.

---

## Implementation follow-up (2026-10-25)

The audit snapshot above is read-only history. The three highest-value actions were implemented in a separate follow-up session:

- **F-01 (destructive generation):** `kyx_generate {replaceMode:"replace"}` now rides the destructive unlock + session checkpoint; `new` stays ungated.
- **F-02 (truthful intent receipts):** `kyx_intent` now compares the document before/after, returns `mutated:false` + `stage:"noop"` for a no-op, and emits a document read-back for non-param routes instead of “verification: applied”.
- **F-03 (stale mirrors):** both mirrors were regenerated and `npm run verify:mcp-mirrors` is a dedicated CI hygiene step; the repository currently reports “mirrors in sync”.
- **F-04 (UN-SUNO transcribe):** `loadSampleMono` is wired in both the web and desktop hosts (bank hit, repository fallback, mono mixdown), with a unit test for the loader.
- **F-12 (persistence stage + save):** results carry `stage` (`read/runtime/applied/persisted/rendered/dry-run/replayed/noop`); new `kyx_save` force-flushes the autosave pipeline and only reports `stage:"persisted"` after the repository flush resolves.
- **F-06/F-07 (stable targets):** `kyx_plugin_param`, `kyx_fx` and `kyx_automation` accept a stable `fxId`; `kyx_clips` writes accept a stable `clipId` (anchor bar remains a compatibility fallback).

Verification at the follow-up snapshot: `npx vitest run` over 10 affected MCP/intent files → **359 tests passed**; `npm run verify:mcp-mirrors` → in sync; `npm run typecheck` has no errors in the changed MCP/intent files (pre-existing errors remain in other in-flight work). The report’s findings below should be read with this follow-up in mind.

### P1 follow-up (2026-10-25)

- **F-10 (per-operation risk):** `effectiveRisk(name, args)` now refines risk per op (add vs remove, list vs edit, `kyx_generate replace`, `kyx_export autofix`, `kyx_batch` as its riskiest child). The executor audits that risk, starts session checkpoints from it, and returns `risk` on every call; the web transport publishes `_meta["kyx/risk"]`. Static tool annotations remain conservative by design.
- **F-11 (structured receipts):** the eight primary tools now declare output schemas: `kyx_state`, `kyx_intent`, `kyx_tracks`, `kyx_fx`, `kyx_clips`, `kyx_automation`, `kyx_master`, `kyx_export`. Count is now **39 tools / 34 output schemas / 5 text-first** (remaining: `kyx_generate`, `kyx_pattern`, `kyx_checkpoint`, `kyx_song`, `kyx_unsuno`). The new schemas guarantee `status` + `stage` plus the receipt/read-back fields; family-specific fields remain additive.
- **F-13 (transport discovery):** new `kyx_state {subject:"capabilities"}` and `kyx://session/capabilities` report the hooks this window actually has (export, meters, loudness, render/diagnose, gallery, SFZ, UN-SUNO PCM, save, offline mix render, undo frames, destructive unlock). **Cancellation is explicitly advertised as unsupported** — no cooperative MCP abort is exposed yet, so the capability is not faked.
- **Real-audio hardening:** `npm run verify:param-readback` passes on real offline DSP renders (saturation, tone, width, level, and the honest unmeasured time case). `kyx_save` is now covered twice: against the real repository + autosave debouncer over fake IndexedDB (`stage:"persisted"` only after flush; reload sees the mutation), and end-to-end in Chromium via `npm run verify:mcp-save` (real IndexedDB flush + reload, PASS; CI gate). The measured DSP read-back gate is run locally (`npm run verify:param-readback`).

Final P1 verification: 17 affected MCP/intent files → **439 tests passed**; `npm run verify:mcp-mirrors` reports in sync; real-browser `npm run verify:param-readback` reports PASS on the re-run. The P1 items still open are the **five** remaining text-only tools and **actual cooperative cancellation**; neither is claimed as done.

### P2 follow-up (2026-10-25)

Delivered with explicit gates rather than blanket parity:

- **Save / save-as:** `kyx_save {"op":"saveAs","name":"...","confirm":true}` flushes the current project, duplicates it under a new id, renames the copy, and leaves the current project open. It returns `stage:"persisted"` plus the new `projectId`. Save-as during a collab session is refused.
- **Project discovery:** `kyx_state {"subject":"projects"}` lists the saved library (id, name, BPM, track count, updatedAt) without switching anything.
- **Open:** intentionally **not exposed** to MCP. Switching the open project tears down and rebuilds services, so it stays a human ProjectBrowser action; the capability block says so.
- **Track reorder:** `kyx_tracks {"op":"move","trackId":...,"relativeTo":...,"where":"before|after"}` uses the canonical `moveTrackAdjacent` command and returns the before/after slots.
- **Clip pitch:** `kyx_clips {"op":"audioUpdate","pitchSemitones":-24..24}` edits the clip’s independent transpose through `updateAudioClip`; out-of-range values are rejected, not clamped.
- **Selected-track context:** the IntentPanel rewrites “this track” / “the selected channel” to the ONE mix target that resolves exactly to the selected track before routing. A family that resolves to several tracks is never used (no silent fan-out); without an exact target the router clarifies.
- **Audio import / recording:** intentionally **not exposed**. Audio import needs a human file picker and has no binary MCP channel under the 1 MB body cap; recording needs a device-permission gesture and the ArrangementPanel recorder state. Both are named in `unavailableByDesign` instead of being advertised as working.

P2 verification: save-as copy + project list against the real repository, plus the Chromium `verify:mcp-save` gate now covering the copy in real IndexedDB; track move; clip pitch acceptance + rejection; selected-track rewrite/fan-out refusal. The focused P2 run passed 23 tests; the wider affected suite passed 447 tests across 18 files. Mirrors and the agent manifest were regenerated.

---

## 1. Executive summary

**Maturity verdict: KYX has trustworthy document control through a shared command path, but it is not yet a trustworthy autonomous DAW operator.**

The strongest part of KYX is real: UI, Intent and MCP converge on one serializable command layer, the project document is the authority, undo is inverse-patch based, MCP transports are token-gated and bounded, destructive document removals have a real gate, and the tested paths commit and undo correctly. This is not a fake agent surface.

The weakness is not “too few tools”. It is **control truthfulness and operational completeness**:

- The AI can edit the document but cannot reliably prove that the edit was a change, that a claimed verification happened, that the change persisted, or that the audio result matches the document.
- The MCP catalog is stale in both generated mirrors: the newest instrument kinds (`strk`, `cink`) are missing from the served schemas, and `tests/mcp-mirror-sync.test.ts` is red at HEAD.
- One advertised operation (`kyx_unsuno transcribe`) has a capability hook that no shipping host provides.
- A destructive variant of generation (`kyx_generate` with `replaceMode: "replace"`) overwrites the active pattern without the destructive-operation gate.
- The primary AI edit tool, `kyx_intent`, reports `mutated: true` and “verification: applied” for a no-op, and does not read back most route kinds. A probe confirmed this: a second “mute the drums” returned `mutated: true` while the undo depth stayed at 1.

The most serious confirmed gaps are ranked in §6. The highest-value next actions are in §11; strategic capability work is separated into §12.

---

## 2. Evidence method and limits

Evidence was gathered by:

1. Reading the repository guidance (`AGENTS.md`, `docs/AGENT-MAP.md`, `docs/CURRENT-STATE.md`), prior audits under `docs/audits/`, and the current source.
2. Parsing the real `MCP_TOOLS` catalog with the TypeScript AST (not by guessing from docs): **38 tools**, **25 with `outputSchema`**, **13 text-first**.
3. Executing focused suites:
   - `npx vitest run tests/mcp-tools.test.ts tests/mcp-real-store-undo.test.ts tests/mcp-idempotency.test.ts tests/mcp-batch-dryrun.test.ts tests/mcp-error-codes.test.ts tests/agent-trust.test.ts tests/mcp-headless-acceptance.test.ts tests/mcp-intent-param-readback.test.ts tests/mcp-mirror-sync.test.ts tests/mcp-persistence.test.ts`
     - **9 files passed; 1 file failed.** The failure is `tests/mcp-mirror-sync.test.ts` (2 tests failed, 2 passed).
   - `npx vitest run tests/intent-e2e-audit.test.ts tests/param-intent.test.ts tests/intent-router-corpus.test.ts tests/intent-decline-ux.test.ts`
     - **304 tests passed; 1 test failed** in `tests/intent-router-corpus.test.ts` (model route gate).
4. Running one disposable probe against the real headless MCP host to confirm the `kyx_intent` no-op receipt. The probe file was deleted after execution.
5. Source tracing for transport, auth, persistence, audio projection and risk classification.

**Not performed:** human listening, PCM comparison of an AI edit, real-browser MCP relay round-trip, real desktop stdio round-trip, real crash/recovery interruption, concurrent human+AI gesture race, native audio device test, full typecheck/build gate.

**Shared-tree caveat:** other sessions committed and edited files during this audit (`f61da8eb`, `f33986fd`, and in-flight `quick-bounce` edits). The report records the state actually observed. The mirror drift and the red model-gate test were re-run with `--no-cache` and are reproducible at the observed revision.

---

## 3. Architecture and control-flow map

```text
Human UI                         Natural language
ProjectBrowser / panels          IntentPanel / kyx_intent
        |                               |
        |  execute(Command)             | routeIntentText -> plan -> Command
        v                               v
   +--------------------------------------------------+
   | ProjectStore (document authority, inverse-patch   |
   | undo/redo, undo frames, normalization)            |
   +----------------------+---------------------------+
                          | onDocChanged
                          v
   services.ts: engine.setProject(doc) + autosave debouncer
                          |
        +-----------------+------------------+
        v                                    v
   AudioEngine / Scheduler              ProjectRepository (IndexedDB)
   (live audio graph)                   (durable project record)

External MCP client
   desktop: stdio -> loopback HTTP bridge -> IPC -> renderer desktop-host.ts
   web:     POST /mcp -> WebSocket relay -> src/mcp/web-host.ts -> bridge.ts
                          |
                          v
                 executeMcpTool(ctx, name, args)
                          |
        risk/audit/checkpoint/dry-run/idempotency/batch
                          |
                          v
                 ctx.execute(Command) -> ProjectStore
```

| Boundary          | Producer → consumer                                                                                     | Authority / contract                                                                                    | Validation and failure behavior                                                                                                               | Evidence                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| UI edit           | Panel control → command factory → `ProjectStore.execute`                                                | `ProjectDocument` is authoritative; React is a view.                                                    | Commands clamp/validate; no-op commands return the same document; store records history only when the document changed.                       | `src/store/ProjectStore.ts:213-300`; `src/commands/project.ts:320-352`                                      |
| Intent            | Text → `routeIntentText` → `planIntent` → command → store                                               | The deterministic route wins; model fallback is gated and cannot overrule a specific route.             | Clarify/refuse on ambiguity, descriptions, negation, hypotheticals; destructive routes save a checkpoint before execution.                    | `src/intent/route.ts:741-900`; `src/intent/model-route-gate.ts:139-160`; `src/ui/IntentPanel.tsx:4134-4145` |
| MCP dispatch      | Transport → `executeMcpTool` → `executeMcpToolCore` → `executeMcpToolDispatch` → `ctx.execute`          | MCP is a transport, not a bypass; document edits use the same command layer.                            | Risk classification, audit, session checkpoint, dry-run sandbox, idempotency key/signature, typed error codes, per-call destructive gates.    | `src/mcp/tools.ts:3873-4160`; `src/mcp/agentTrust.ts:50-137`                                                |
| Desktop transport | `desktop/mcp-server.cjs` → loopback bridge → host manager → renderer `desktop-host.ts`                  | Token-gated loopback bridge; one focused KYX window owns execution.                                     | Constant-time token compare; body cap 1 MB; token-bucket rate limit (30/min); 15 s/60 s call timeouts.                                        | `desktop/mcp-bridge-server.cjs:20-26,150-166`; `desktop/mcp-host-manager.cjs:24-25,214-227`                 |
| Web transport     | `server/collab-server.mjs` `/mcp` → `/mcp-relay` → `bridge.ts` → `web-host.ts`                          | Bearer `MCP_TOKEN`; single relay window owns the session.                                               | 1 MB body cap; no `/mcp` rate limiter; relay displacement close code 4409; 15 s/60 s call timeouts.                                           | `server/collab-server.mjs:997-1025`; `src/mcp/bridge.ts:120-190`; `src/mcp/web-host.ts`                     |
| Audio projection  | `services.store.onDocChanged` → `engine.setProject`; scheduler → `AudioEngine.applyAutomation`          | Document holds base values; engine owns derived nodes and runtime state.                                | Engine sync is triggered by the same `onDocChanged` path; live/offline share the same engine entry points.                                    | `src/services.ts:1239-1285`; `tests/mcp-persistence.test.ts:124-200`                                        |
| Persistence       | Autosave debouncer → `ProjectRepository.save`; load → validate/migrate                                  | Saved project record is authoritative at rest; `SCHEMA_VERSION` and `migrateProject` own compatibility. | Debounced 800 ms, force-flushed after 5 s/50 arms; save failures set `saveStatus: "error"`.                                                   | `src/services.ts:1190-1285`; `src/persistence/autosave-debouncer.ts`; `tests/mcp-persistence.test.ts`       |
| Observability     | `kyx_state`, `kyx_meter`, `kyx_render_summary`, `kyx_diagnose_mix`, `kyx_loudness`, `kyx_audio_preview` | Read-back is the independent check; meter/render hooks are honestly refused when unavailable.           | Structured `data` exists for 25 tools; 13 tools are text-first. Transport exposes `structuredContent` only when the tool declares/returns it. | `src/mcp/tools.ts:1473-3035`; `src/mcp/tools.ts:3243-3290`; `server/mcp-core.mjs:5758-5768`                 |

**No divergent mutation path was found.** Every document change observed goes through `ProjectStore.execute` (or a domain command executed by it). The meaningful exceptions are deliberately host-level side effects: checkpoint repository writes, SFZ user-library import, gallery publishing, audio preview/render, and live mix-preview arming. Those are not document-undoable and are documented as such.

---

## 4. Capability inventory (derived from implementation)

The inventory below is the contract-level view. The coverage matrix in §5 is the operation-level view.

| Area                 | Canonical operations and owner                                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project lifecycle    | Browser/open/close/new/save-as in the app; `ProjectRepository`, save lifecycle, schema migration. No MCP lifecycle tool.                                                         |
| Document state       | `ProjectDocument` + `ProjectStore`; commands are serializable forward/inverse deltas (`src/commands/core.ts`).                                                                   |
| Tracks               | `createDrumTrack`, `createInstrumentTrack`, `deleteTrack`, `duplicateTrack`, `setTrackParams`, `addToGroup`, `removeFromGroup`, group/return commands.                           |
| Arrangement scenes   | Scene add/remove/duplicate/reorder/resize/intensity; `arrangeWords`, `song`, `sections` command paths.                                                                           |
| Clips                | Scene clips: add/move/resize/split/duplicate/delete/ripple/clipboard. Audio clips: move/split/update/slip/stretch/crossfade/duplicate/mute/nudge/slice/strip/consolidate/delete. |
| Recording and takes  | AudioEngine/PcmMicRecorder + pattern recorder; take-group commands (`setActiveAudioTake`, deletion, comping).                                                                    |
| Notes and steps      | Note commands (add/move/delete/velocity/quantize/transpose); step velocity and step metadata commands.                                                                           |
| Musical time         | `Transport` (PPQ 480), `Scheduler`, tempo/key/meter/pattern length commands, markers, loop.                                                                                      |
| Mixer / routing      | Track gain/pan/mute/solo, groups, returns, sends, effect rack, master chain (`EffectRack`, `AudioEngine`).                                                                       |
| FX and instruments   | `addEffectToTracks`, `removeEffect`, `moveEffect`, `toggleEffectBypass`, `setEffectParam`, `setInstrumentParam`; registries for 48+ effects and 29 instrument kinds.             |
| Automation           | Automation lane/point commands; scheduler and offline renderer share `AutomationBridge`.                                                                                         |
| History              | `ProjectStore` inverse-patch undo/redo, coalescing, 256-entry stack, 64 history snapshots.                                                                                       |
| Checkpoints/recovery | `src/intent/checkpoints.ts`, MCP checkpoint map + repository; crash journal in save lifecycle.                                                                                   |
| Export/render        | `renderProject`, `quickBounceDownload`, stems zip, MP3/LAME, WAV/FLAC, Mix Doctor read-back.                                                                                     |
| Mastering/analysis   | Master chain, loudness measurement, render summary, mix diagnosis, blind A/B.                                                                                                    |
| AI-native            | Intent engine, generation/song/arrange, producer DNA/preferences, mix ideas, UN-SUNO, gallery publishing.                                                                        |
| MCP control plane    | 38 tools, 25 output schemas, typed errors, dry-run, idempotency, batch, annotations, audit log, session checkpoint.                                                              |

---

## 5. AI control coverage matrix

Legend: **UI** = real user path; **Intent** = deterministic NL route (UI or `kyx_intent`); **MCP** = tool/op; **Canonical** = command/API; **Undo** = document history; **Save/load** = persistence behavior. Status labels are defined at the top.

| Capability / operation                      | UI path                      | Intent path                                    | MCP tool / API                                                     | Canonical command                                                                               | Args / units validated                                           | Target identification             | Observed result                                    | Undo        | Save / load                  | Authorization                        | Evidence                                                                       | Status                                                  |
| ------------------------------------------- | ---------------------------- | ---------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------- | -------------------------------------------------- | ----------- | ---------------------------- | ------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------- |
| New/open/close project                      | ProjectBrowser               | none                                           | none                                                               | repository/services                                                                             | loader validates schema/version                                  | project id                        | new active document                                | n/a         | full lifecycle               | user action                          | `src/ui/ProjectBrowser.tsx`; `src/services.ts`                                 | Not exposed                                             |
| Save / save-as                              | App save + autosave          | “save” (UI only; MCP refuses)                  | none                                                               | `flushSave` / repository                                                                        | n/a                                                              | active project                    | durable record                                     | n/a         | yes, app-owned               | user action; MCP v1 refusal          | `src/mcp/tools.ts:11637`; `src/services.ts:1190-1210`                          | Intentionally restricted                                |
| Autosave / recovery / migration             | automatic                    | none                                           | `kyx_checkpoint` (separate facility)                               | debouncer + repository + crash journal                                                          | schema/version checks                                            | active project                    | dirty→saved                                        | n/a         | yes                          | automatic                            | `tests/mcp-persistence.test.ts`; `tests/persistence/`                          | Wired, not end-to-end verified (crash)                  |
| Project name / metadata                     | ProjectBrowser / metadata UI | none                                           | none                                                               | `setProjectName` / metadata commands                                                            | string validation at UI                                          | project                           | renamed project                                    | yes         | autosave                     | user action                          | `src/commands/project.ts:17-31`                                                | Not exposed                                             |
| Track create                                | TrackTabs / menus            | add track                                      | `kyx_tracks addDrum/addInstrument`                                 | `createDrumTrack` / `createInstrumentTrack`                                                     | family/instrument enum, name bounds                              | family or instrument kind         | new track read-back                                | yes         | autosave                     | MCP token; tool marked destructive   | `tests/intent-e2e-audit.test.ts:795-820`; `tests/mcp-tools.test.ts:661`        | Verified end-to-end (document)                          |
| Track delete                                | Track menu                   | delete track                                   | `kyx_tracks remove`                                                | `deleteTrack`                                                                                   | last-track guard; exact id/family                                | track id or family                | removed, history label                             | yes         | autosave                     | D4 destructive flag + checkpoint     | `tests/mcp-tools.test.ts:854-870`; `tests/intent-e2e-audit.test.ts:828`        | Verified end-to-end (document)                          |
| Track rename                                | Track menu                   | rename track                                   | `kyx_tracks rename`                                                | `setTrackParams`                                                                                | non-empty name; exact id/family                                  | track id or family                | renamed read-back                                  | yes         | autosave                     | MCP token                            | `tests/mcp-tools.test.ts:1455-1480`; `tests/intent-e2e-audit.test.ts:817`      | Verified end-to-end (document)                          |
| Track duplicate                             | Track menu                   | duplicate track                                | `kyx_tracks duplicate`                                             | `duplicateTrack`                                                                                | exact id/family                                                  | track id or family                | clone with FX/routing                              | yes         | autosave                     | MCP token                            | `tests/mcp-tools.test.ts`; `tests/intent-e2e-audit.test.ts:848`                | Verified end-to-end (document)                          |
| Track reorder                               | drag / menus                 | none                                           | none                                                               | (UI command)                                                                                    | n/a                                                              | n/a                               | order change                                       | yes         | autosave                     | user action                          | UI only                                                                        | Not exposed                                             |
| Track arm / input monitor                   | recording UI                 | record arm/start/stop (UI)                     | none                                                               | recorder/service                                                                                | device/runtime state                                             | track                             | armed/monitoring                                   | n/a         | runtime                      | user action                          | `src/intent/exact.ts:731-738`; MCP refuses record                              | Intentionally restricted (MCP)                          |
| Track gain/pan/mute/solo                    | Mixer                        | fader / exact                                  | `kyx_tracks setGain/setPan/setMute/setSolo`                        | `setTrackParams`                                                                                | gainDb −60..+3.5 or linear 0..1.5; pan −1..1; booleans           | family or exact id                | verify-by-read text                                | yes         | autosave                     | MCP token                            | `tests/mcp-real-store-undo.test.ts`; `tests/intent-e2e-audit.test.ts:101-145`  | Verified end-to-end (document)                          |
| Groups / buses                              | Track menu / routing         | none validated                                 | `kyx_routing createGroup/addToGroup`                               | `createGroupTrack` / `addToGroup`                                                               | exact ids/names; flat group model                                | track/group ids                   | verified group/route read-back                     | yes         | autosave                     | MCP token                            | `tests/mcp-tools.test.ts`; prior audit                                         | Verified end-to-end (document)                          |
| Sends / returns                             | Mixer                        | send intent                                    | `kyx_state sends`; `kyx_routing`                                   | `setTrackSend` / `setReturnGain`                                                                | finite gain; exact ids                                           | track/return ids                  | verified send levels                               | yes         | autosave                     | MCP token                            | `tests/mcp-tools.test.ts:1837-1860`                                            | Verified end-to-end (document)                          |
| Scene clips list/move/resize/split/delete   | Arrangement                  | clips / arrange                                | `kyx_clips` scene ops                                              | `moveArrangementClip`, `resizeArrangementClip`, etc.                                            | 1-based bars; anchor-bar target; meters                          | bar anchor                        | list/read-back                                     | yes         | autosave                     | delete gated; others token           | `tests/mcp-tools.test.ts`; `tests/intent-e2e-audit.test.ts:919-1003`           | Verified end-to-end (document)                          |
| Clip copy/cut/paste/ripple                  | Arrangement / menus          | selected clip arrange                          | `kyx_clips copy/cut/paste/moveRipple`                              | clipboard + ripple commands                                                                     | bar bounds; per-session clipboard                                | bar anchor                        | clipboard summary; paste read-back                 | yes         | clipboard not persisted      | cut gated                            | `tests/mcp-tools.test.ts`; prior parity tests                                  | Verified end-to-end (document)                          |
| Audio import                                | Import dialog                | none                                           | `kyx_import_sfz` only                                              | sample import + command                                                                         | SFZ base64, sample set, size limits                              | track id                          | import report                                      | partial     | user library + project       | MCP token; dry-run refused           | `src/mcp/tools.ts:2476-2510`; `src/sample-library/sfz-import.ts`               | Partially supported                                     |
| Audio recording                             | Recording UI                 | record arm/start/stop (UI)                     | none                                                               | recorder/service                                                                                | mic/device runtime                                               | track                             | audio take                                         | frame       | takes persisted              | user gesture                         | MCP route refusal `src/mcp/tools.ts:11637`                                     | Not exposed (MCP)                                       |
| Take list/activate/delete                   | Take lanes                   | none                                           | `kyx_takes list/activate/deleteTake`                               | take-group commands                                                                             | exact group/take ids                                             | take id                           | committed take read-back                           | yes         | autosave                     | delete gated                         | `tests/mcp-tools.test.ts`; prior audit                                         | Verified end-to-end (document)                          |
| Audio clip move/split/slip/stretch/fades    | Arrangement                  | selected audio fade only                       | `kyx_clips audio*`                                                 | `moveAudioClip`, `splitAudioClipAtTick`, `updateAudioClip`, `stretchAudioClip`, `slipAudioClip` | gain 0..2; rate 0.25..4; fades seconds; bar anchor               | trackId/family + bar              | audio clip read-back                               | yes         | autosave                     | delete gated; others token           | `tests/mcp-tools.test.ts`; `tests/editor-uncovered-verbs.test.ts`              | Verified end-to-end (document)                          |
| Audio clip crossfade/duplicate/mute/nudge   | Arrangement                  | none                                           | `kyx_clips audioCrossfade/audioDuplicate/audioMute/audioNudge`     | clip editing commands                                                                           | overlap/range checks; gain; bars                                 | trackId/family + bar              | read-back                                          | yes         | autosave                     | delete gated where applicable        | `tests/mcp-tools.test.ts`; `tests/editor-uncovered-verbs.test.ts`              | Verified end-to-end (document)                          |
| Audio clip slice/strip/consolidate/delete   | Arrangement                  | none                                           | `kyx_clips audioSlice/audioStrip/audioConsolidate/audioDelete`     | clip editing commands                                                                           | segment ranges; source duration; bufferId                        | trackId/family + bar              | read-back; consolidate needs a pre-rendered buffer | yes         | autosave                     | delete gated                         | `tests/mcp-tools.test.ts`; prior audit                                         | Partially supported (consolidate needs external render) |
| Audio clip pitch                            | Time & pitch dialog          | none                                           | none                                                               | `updateAudioClip` (`pitchSemitones`)                                                            | ±24 semitones                                                    | clip                              | rendered pitch                                     | yes         | autosave                     | user action                          | `docs/CURRENT-STATE.md` schema v37; no MCP field                               | Not exposed                                             |
| Audio clip source trim                      | Arrangement / clip editor    | none                                           | partial: `audioSlip` / `audioStrip`                                | clip editing                                                                                    | offsets/segments                                                 | clip                              | audible window                                     | yes         | autosave                     | user action                          | `src/commands/clipEditing.ts`                                                  | Partially supported                                     |
| MIDI note add/move/delete/velocity/quantize | Piano Roll                   | selected step assist / pattern verbs (partial) | `kyx_notes`                                                        | note commands                                                                                   | pitch 0..127; beats/ticks; stable noteId                         | track id/family + noteId          | committed note read-back                           | yes         | autosave                     | delete gated                         | `tests/mcp-tools.test.ts`; `tests/mcp-notes-music.test.ts`                     | Verified end-to-end (document)                          |
| Drum step add/remove/toggle/ghost/clear     | Sequencer                    | step edit / pattern verbs                      | `kyx_steps`                                                        | step commands                                                                                   | 1..stepCount (max 128); velocity 0.05..1; 2048-cell cap          | pad family                        | exact cell read-back                               | yes         | autosave                     | token                                | `tests/mcp-tools.test.ts:685-806`                                              | Verified end-to-end (document)                          |
| Pattern select / rename / length            | Pattern bar                  | pattern / exact                                | `kyx_pattern`, `kyx_music setPatternLength`                        | pattern commands                                                                                | 1-based index/name; 1..128 steps; meter-aware bars               | pattern                           | committed pattern                                  | yes         | autosave                     | token                                | `tests/mcp-tools.test.ts:806-854`                                              | Verified end-to-end (document)                          |
| Tempo / key / meter / transpose             | Transport / metadata         | exact / tempo                                  | `kyx_music`                                                        | `setBpm`, `setProjectKey`, `setTimeSignature`, transpose                                        | integers; key enum; meter numerator/denominator                  | project/pattern/target family     | committed read-back + disclosure                   | yes         | autosave                     | token                                | `tests/mcp-tools.test.ts`; `tests/intent-e2e-audit.test.ts:452`                | Verified end-to-end (document)                          |
| Markers                                     | Ruler / marker lane          | marker intent                                  | `kyx_markers`                                                      | marker commands                                                                                 | 1-based bars; meter-aware; stable markerId                       | marker id or nearest bar          | committed marker read-back                         | yes         | autosave                     | remove gated                         | `tests/mcp-tools.test.ts:597-660`                                              | Verified end-to-end (document)                          |
| Sections / scene intensity                  | Scene strip / arrangement    | arrange / sceneIntensity                       | `kyx_sections`                                                     | section commands                                                                                | stable scene id/name/index/role; 1..64 bars; intensity 0..1      | scene id/name/index/role          | committed scene read-back                          | yes         | autosave                     | remove gated                         | `tests/mcp-tools.test.ts:498-596`                                              | Verified end-to-end (document)                          |
| Transport / loop / seek / scene launch      | Transport bar                | transport                                      | `kyx_transport`                                                    | `Transport` methods                                                                             | 1-based bars/beats; scene id/name/index                          | scene or transport                | state read-back                                    | n/a         | runtime only                 | token                                | `tests/mcp-tools.test.ts:1081-1830`                                            | Verified end-to-end (runtime)                           |
| Snap / grid settings                        | Editor settings              | none                                           | none                                                               | UI state                                                                                        | n/a                                                              | n/a                               | grid change                                        | n/a         | UI preference                | user action                          | UI only                                                                        | Not exposed                                             |
| FX catalog / insert / remove / bypass       | EffectRack                   | effect intent                                  | `kyx_catalog`; `kyx_fx`                                            | `addEffectToTracks`, `removeEffect`, `toggleEffectBypass`                                       | effect enum; instance 1..128; remove gated                       | trackId/family + instance         | chain read-back                                    | yes         | autosave                     | remove gated                         | `tests/mcp-tools.test.ts:455-498`                                              | Verified end-to-end (document)                          |
| FX parameter read/write                     | EffectRack                   | param intent                                   | `kyx_plugin_param`, `kyx_catalog`                                  | `setEffectParam`                                                                                | native value, catalog min/max/unit/kind/options                  | trackId/family + effect + ordinal | per-track before/requested/committed               | yes         | autosave                     | token                                | `tests/mcp-tools.test.ts:1184-1360`; `tests/mcp-intent-param-readback.test.ts` | Verified end-to-end (document); audio unverified        |
| FX preset load                              | EffectRack presets           | effect preset intent (partial)                 | none                                                               | effect preset command                                                                           | preset ids                                                       | effect instance                   | preset applied                                     | yes         | autosave                     | user action                          | UI only                                                                        | Not exposed (MCP)                                       |
| Instrument parameters                       | Instrument panel             | production / instrument intent (partial)       | `kyx_instrument_param`                                             | `setInstrumentParam`                                                                            | catalog range/kind/options; exact trackId                        | exact trackId                     | committed value                                    | yes         | autosave                     | token                                | `tests/mcp-instrument-control.test.ts`                                         | Verified end-to-end (document)                          |
| Automation points/lanes                     | Automation editor            | automate intent (ramps, partial)               | `kyx_automation`, `kyx_state automation`                           | automation commands                                                                             | native units; bars/beats; effect+ordinal; clear/remove gated     | track/family + effect ordinal     | lane read-back                                     | yes         | autosave                     | clear/remove gated                   | `tests/mcp-tools.test.ts`; `tests/automation-bridge.test.ts`                   | Verified end-to-end (document)                          |
| Mixer meters / FX telemetry                 | Meters                       | none                                           | `kyx_meter`                                                        | live engine snapshot                                                                            | scope enum; live engine required                                 | master/tracks/fx                  | numeric snapshot                                   | n/a         | runtime only                 | token                                | `tests/mcp-fx-meters.test.ts`; `tests/mcp-tools.test.ts:1490`                  | Wired, not end-to-end verified (audio)                  |
| Undo / redo / history                       | Undo panel / shortcuts       | undo intent                                    | `kyx_undo`, `kyx_state history`                                    | `ProjectStore.undo/redo`                                                                        | 1..20 steps; foreign-work consent; mic-recording refusal         | global LIFO                       | reverted labels/counts                             | native      | autosave                     | token + foreign consent              | `tests/mcp-real-store-undo.test.ts`; `tests/mcp-tools.test.ts:961-1054`        | Verified end-to-end (document)                          |
| Checkpoints                                 | Checkpoint panel             | checkpoint intent                              | `kyx_checkpoint`                                                   | separate repository + `snapshot` restore                                                        | name bounds; 8 kept; restore one undo step                       | project checkpoint                | list/diff/restore                                  | restore yes | checkpoint repo              | token; restore not D4-gated          | `tests/mcp-checkpoint*.test.ts`                                                | Verified end-to-end (checkpoint)                        |
| Export / bounce / stems                     | Export panel                 | export (UI; MCP route refuses)                 | `kyx_export`                                                       | `quickBounceDownload` / `renderProject`                                                         | wav/mp3; 44.1/48/96 kHz; 16/24/32; stems                         | full mix or stem group            | duration/size/mix-check report                     | n/a         | download lands in app window | token; dry-run refused               | `tests/quick-bounce.test.ts`; `src/export/quick-bounce.ts`                     | Wired, not end-to-end verified (file/PCM)               |
| Loudness measure / match                    | Mastering panel              | loudness                                       | `kyx_loudness`                                                     | measure→trim→verify                                                                             | targetDb/direction; render context required                      | master                            | measured before/after                              | yes (trim)  | autosave                     | token                                | `tests/mcp-tools.test.ts`; `tests/automation-bridge.test.ts`                   | Wired, not end-to-end verified (PCM)                    |
| Master / ZENIT / platform / land            | Mastering panel              | none validated                                 | `kyx_master`                                                       | master commands                                                                                 | profile/targets/trim; remove gated; `iterate` needs desktop hook | track/group/master                | plan/measure read-back                             | yes         | autosave                     | remove gated; other ops token        | `src/mcp/tools.ts:10287-10700`                                                 | Partially supported (transport hooks)                   |
| Mix diagnosis / mix idea                    | Mix Doctor                   | complaint/mix                                  | `kyx_diagnose_mix`, `kyx_mix_idea`                                 | analysis + command plan                                                                         | scope; bounded idea/target strings                               | master/tracks                     | findings + fix suggestions                         | apply yes   | autosave                     | token                                | `tests/mcp-mix-diagnosis.test.ts`; `tests/mcp-mix-idea.test.ts`                | Wired, not end-to-end verified (audio)                  |
| Generation / groove / song / arrange        | Generate buttons             | pattern/groove/arrange/mix (UI)                | `kyx_generate`, `kyx_groove`, `kyx_song`, `kyx_arrange`, `kyx_mix` | generate + `applyGenerationResultCommand`, groove/arrange commands                              | seed/genre/bars/energy; song refuses existing arrangement        | active pattern / song form        | pattern/scene read-back                            | yes         | autosave                     | token; `replaceMode:replace` ungated | `tests/mcp-tools.test.ts:336-960`; `tests/intent-e2e-audit.test.ts`            | Verified end-to-end (document); one destructive gap     |
| Gallery publish                             | Publish button               | publish intent (UI)                            | `kyx_publish_gallery`                                              | `publishBeat`                                                                                   | title/tags bounds; token                                         | current project                   | gallery id                                         | n/a         | network side effect          | token; runtime                       | `tests/mcp-gallery-publish.test.ts`                                            | Wired, not end-to-end verified (network)                |
| Blind A/B                                   | A/B panel                    | none                                           | `kyx_blind_ab`                                                     | blind-ab module                                                                                 | lane/trial caps; p-value; confirm reset                          | session lane                      | plan/verdict read-back                             | n/a         | session only                 | token; reset confirm                 | `tests/mcp-blind-ab.test.ts`                                                   | Verified end-to-end (session)                           |
| UN-SUNO transcribe/restyle/regen/similarity | UN-SUNO panel                | none                                           | `kyx_unsuno`                                                       | `unsunoCommand` / restyle/regen                                                                 | sourceId/artist/separation enum                                  | user sample id                    | project build / style swap                         | yes         | autosave                     | token                                | `tests/mcp-unsuno.test.ts` (injects a loader)                                  | Broken / misleading (no host provides loader)           |
| Producer DNA / preferences                  | Intent panel / memory UI     | UI learning flow                               | none (reads only)                                                  | preference/ledger modules                                                                       | local memory bounds                                              | user history                      | local learning                                     | n/a         | IndexedDB                    | local only                           | `src/intent/preference-*.ts`                                                   | Not exposed                                             |
| Selection / focused context                 | Selection store              | selected clip/range/step only                  | none                                                               | selection store                                                                                 | clip/range/step; no selected track                               | UI selection                      | route context                                      | n/a         | session                      | user action                          | `src/intent/route.ts:741-748`; `src/ui/IntentPanel.tsx:4106-4111`              | Partially supported                                     |
| Batch operations                            | n/a                          | compound                                       | `kyx_batch`                                                        | up to 10 calls; optional undo frame                                                             | nested/async refused; dry-run preflight                          | per-call                          | per-call results + single-undo flag                | yes         | autosave                     | token; destructive subcalls gated    | `tests/mcp-batch-dryrun.test.ts`; `tests/mcp-headless-acceptance.test.ts`      | Verified end-to-end (document)                          |

---

## 6. Confirmed and source-inferred findings

### F-01 — `kyx_generate` with `replaceMode: "replace"` is a destructive operation with no destructive gate (P1)

- **Evidence:** Confirmed by source. `kyx_generate` is classified `mutate` in `TOOL_RISK` (`src/mcp/agentTrust.ts:74`). Its schema advertises `replaceMode: ["new", "replace"]` and documents “replace = overwrite the active pattern in place” (`src/mcp/tools.ts:1710-1713`). The handler passes it to `applyGenerationResultCommand` (`src/mcp/tools.ts:4355`), whose `replace` branch overwrites the active pattern’s `rows`, `notes`, `stepMeta`, `stepCount`, `name` and `generation` (`src/commands/aiPattern.ts:78-103`). No `allowDestructive` check exists on this path.
- **Expected:** Either classify `replace` as destructive and require the same D4 flag + checkpoint as track/effect/scene removal, or require an explicit `confirm: true` argument. Adding a new pattern (`new`) can remain ungated.
- **Actual:** A client with the MCP token but without the destructive unlock can erase the active pattern’s musical content. Undo and the session checkpoint make it recoverable, but the authorization contract is bypassed.
- **Reproduction:** On a project with a non-empty active pattern, call `kyx_generate {genre:"house", replaceMode:"replace"}` with `pf:mcp-allow-destructive` off. Observe `mutated: true` and the pattern content replaced.
- **Confidence:** High (source-confirmed; not executed because the audit is read-only).
- **Owner layer:** MCP tool policy / `TOOL_RISK` refinement; command behavior is correct.

### F-02 — `kyx_intent` reports `mutated: true` and “verification: applied” without verifying or changing anything (P1)

- **Evidence:** Executed probe against the real headless MCP host:
  - First `kyx_intent {instruction:"mute the drums"}` → `mutated: true`, undo depth 1.
  - Second identical call → `mutated: true`, text “mute drums — verification: applied, one undo step in KYX”, **undo depth still 1**.
- **Root cause (source):** `executeRoutedIntent` calls `ctx.execute(command)` and then unconditionally returns `mutated: true` and the generic “verification: applied” receipt for every route kind except `paramIntent`, `effectIntent`, `preset` and `production` (`src/mcp/tools.ts:11759`). `ProjectStore` correctly refuses to record a no-op (`src/store/ProjectStore.ts:255-262`), and `setTrackParams` returns an identity command for an unchanged value (`src/commands/project.ts:344-352`). The MCP layer never compares before/after for the generic routes.
- **Expected:** `mutated` must mean “the document changed”. A no-op must return `mutated: false`, say “nothing changed”, and not claim an undo step. A route that claims verification must read back the affected value(s), not just the command label.
- **Actual:** The agent is told a mutation and a verification happened when neither did. This is the exact failure class the audit calls “optimistic acknowledgment as truth”.
- **Reproduction:** The disposable probe above; no production files changed.
- **Confidence:** High (executed).
- **Owner layer:** `executeRoutedIntent` receipt contract; ideally one shared postcondition helper for all routes.

### F-03 — Both generated MCP mirrors are stale; the newest instrument kinds are not served (P1/P2)

- **Evidence:** Executed `tests/mcp-mirror-sync.test.ts` twice (including `--no-cache`): **2 failed, 2 passed**. The diff shows the source enums contain `strk` and `cink`, while `desktop/mcp-tool-defs.cjs` and `server/mcp-core.mjs` stop at `hlas`. Source uses `enum: INSTRUMENT_ORDER` in `kyx_tracks` (`src/mcp/tools.ts:1932`) and `kyx_catalog` (`src/mcp/tools.ts:2123`). The mirrors were last regenerated in `4a09104d` (05:53); the instrument registry gained `strk`/`cink` in `9419e8e1` (08:24) without a mirror regeneration. A later `tools.ts` change (`88cc4524`) did not change the enums but also did not refresh the mirrors.
- **Impact:** A schema-validating MCP client cannot request the 28th/29th instrument kinds through `kyx_tracks addInstrument` or discover them through `kyx_catalog subject:instrument`. The desktop and web transports serve the stale schemas. The repository’s own drift gate is red.
- **Expected:** Regenerate both mirrors and commit them with the source change. Add a CI gate that runs `npm run verify:mcp-mirrors` on every change to `src/mcp/tools.ts` or the instrument/effect registries.
- **Actual:** Discovery and execution disagree; a new capability exists but is not advertised.
- **Confidence:** High (executed).
- **Owner layer:** generated artifacts + CI.

### F-04 — `kyx_unsuno transcribe` is advertised but no shipping host provides its required hook (P2)

- **Evidence:** The tool requires `ctx.loadSampleMono` (`src/mcp/tools.ts:3188`), and the handler refuses when absent (`src/mcp/tools.ts:10201-10205`). A repository-wide search finds `loadSampleMono` **only** in `src/mcp/tools.ts`; neither `src/mcp/desktop-host.ts` nor `src/mcp/web-host.ts` supplies it. `tests/mcp-unsuno.test.ts` injects a synthetic loader into a fake context, so the test proves the contract but not the product wiring.
- **Impact:** In both live transports, `kyx_unsuno {action:"transcribe"}` always returns “needs a live session able to load user-sample audio — this context cannot”. The restyle/regen/similarity actions work only after a transcribe, so the primary pipeline is unreachable.
- **Expected:** Implement the hook in both hosts (read the user sample bank, decode to mono, return PCM + sample rate) or remove `transcribe` from the advertised surface until it exists.
- **Actual:** An advertised capability that cannot work through any shipping transport.
- **Confidence:** High (source-confirmed; no host implementation).
- **Owner layer:** transport host capability wiring.

### F-05 — The AI control surface cannot perform or verify project lifecycle, audio import, recording, track reorder, or clip pitch (P1/P2 coverage)

- **Evidence:** The 38-tool catalog contains no save, save-as, open, new, close, audio-file import, recording arm/start/stop, track reorder, or audio-clip pitch operation. `kyx_intent` explicitly refuses save/export/record routes over MCP (`src/mcp/tools.ts:11637`); `kyx_export` exists as a separate runtime tool. Track reorder and clip pitch exist in UI commands (`src/commands/tracks.ts`, `src/commands/clipEditing.ts`) but are not exposed.
- **Impact:** An agent can compose and edit, but cannot reliably start a project, bring in audio, record a take, reorder the arrangement’s track stack, or perform the pitch edit a user can perform. It also cannot force a save or verify that its work is durable.
- **Expected:** Do not expose every UI action, but decide explicitly:
  - Save/save-as/open should be host-mediated, user-confirmed tools returning a durable receipt.
  - Audio import and recording should either be exposed behind a file/device picker or documented as human-only.
  - Track reorder and clip pitch are low-risk document commands and are good candidates for MCP.
- **Confidence:** High for absence; the “intentionally restricted” rationale is only explicit for save/export/record, not for the rest.
- **Owner layer:** capability policy + transport host.

### F-06 — Effect writes address instances by ordinal, while reads expose a stable `fxId` (P2)

- **Evidence:** `kyx_plugin_param` read-back includes `fxId` per instance, but the input schema has no `effectId`/`fxId` field; `set` resolves by `effect` type + `instance` ordinal (`src/mcp/tools.ts:2133-2185`, `9185-9300`). `kyx_automation` similarly resolves FX lanes by effect type + ordinal (`src/mcp/tools.ts:2240-2298`). `kyx_fx` reorder/remove also uses ordinal.
- **Impact:** An agent that reads a chain, then reorders or replaces a device, can write to a different instance than the one it intended. The stable identity exists in the read model but is not accepted by the write model.
- **Expected:** Accept `fxId` as the preferred target for set/remove/bypass/reorder and automation; keep ordinal as a compatibility fallback with an explicit ambiguity error if the ordinal no longer matches.
- **Actual:** Read/write identity asymmetry.
- **Confidence:** High (source-confirmed).
- **Owner layer:** MCP schema + command adapter; the project model already stores stable effect ids.

### F-07 — Scene-clip writes address by anchor bar, not by the clip id returned from reads (P2)

- **Evidence:** `kyx_clips list` returns clip `id`s (`src/mcp/tools.ts:7650-7675`), but `move`, `resize`, `split`, `duplicate` and `delete` resolve the target by “the clip covering bar N” (`src/mcp/tools.ts:2299-2414`, `7557-7700`). The UI has stable clip selection; MCP does not accept `clipId`.
- **Impact:** A concurrent move, insert or ripple can make the same bar resolve to a different clip between an agent’s read and write. Audio clip ops have the same track+bar addressing.
- **Expected:** Accept stable `clipId` for both scene and audio clips, with anchor bar as a compatibility fallback and an explicit “target changed” error when the resolved id differs.
- **Confidence:** High (source-confirmed).
- **Owner layer:** MCP target resolution + command adapter.

### F-08 — Intent has no selected-track context (P2)

- **Evidence:** `routeIntentText` accepts `hasSelectedStepSelection`, `selectedClipId` and `selectedRange` only (`src/intent/route.ts:741-748`). `IntentPanel` passes exactly those (`src/ui/IntentPanel.tsx:4106-4111`). There is no `selectedTrackId`.
- **Impact:** “Lower this track by 3 dB” has no track context; the router can only clarify or require a named family. The audit’s contextual example fails unless the track is named.
- **Expected:** Pass the selected track id(s) into the route context and let explicit named targets win; use the selection only for deictic asks (“this track”, “the selected one”). The resolved target must be named in the receipt.
- **Confidence:** High (source-confirmed).
- **Owner layer:** intent context + UI wiring.

### F-09 — The model route gate is red at HEAD (P2)

- **Evidence:** Executed focused suite: `tests/intent-router-corpus.test.ts > model route gate > accepts a model mutation only when its plan is executable` failed with `expected undefined to be 'effectIntent'` at `tests/intent-router-corpus.test.ts:593`. The other 304 intent tests passed.
- **Impact:** A model-proposed effect mutation that the test considers valid is rejected, so the local-model fallback can fall back to clarify. This is a safe failure (no wrong mutation), but it is a coverage regression and a red gate.
- **Expected:** Restore the gate contract or update the fixture with a recorded rationale. Because the test is not in `suite-expectations.json`, it is currently an unowned red.
- **Confidence:** High (executed). Root cause not isolated; the recent resolver unification (`88cc4524`) and effect-target work (`79ec68af`) are the likely neighborhood.
- **Owner layer:** `src/intent/model-route-gate.ts` / `src/plugin-catalog.ts` / test fixture.

### F-10 — Tool-level risk annotations are too coarse for least-privilege clients (P2)

- **Evidence:** `TOOL_RISK` classifies whole tools (`src/mcp/agentTrust.ts:50-90`); annotations are derived statically (`src/mcp/agentTrust.ts:131-137`). `kyx_tracks` is `destructive` because it contains `remove`, so every `addDrum`, `setGain` or `rename` call is advertised as destructive. Conversely, `kyx_generate` is `mutate`, although `replaceMode:replace` overwrites content. Per-op gates exist in handlers (`src/mcp/tools.ts:5145`), so the annotation and the actual gate disagree in both directions.
- **Impact:** A spec-compliant client that asks for confirmation only on destructive tools will over-confirm routine edits and under-confirm pattern replacement. Least privilege cannot be expressed at the call level.
- **Expected:** Add per-op risk metadata (or per-op annotations in the result) and align the gate with the annotation. Keep a conservative tool-level default for unknown ops.
- **Confidence:** High (source-confirmed).
- **Owner layer:** trust layer + tool schemas.

### F-11 — Thirteen tools, including the primary state and intent tools, are text-first (P2)

- **Evidence:** AST measurement of the current catalog: 38 tools, 25 `outputSchema`, 13 without: `kyx_intent`, `kyx_state`, `kyx_export`, `kyx_generate`, `kyx_fx`, `kyx_tracks`, `kyx_pattern`, `kyx_automation`, `kyx_clips`, `kyx_checkpoint`, `kyx_song`, `kyx_unsuno`, `kyx_master`. Some return `data` opportunistically (e.g. `kyx_state mixer`, `kyx_clips list`), but the contract is not declared or enforced.
- **Impact:** Agents cannot rely on a stable structured result for discovery → edit → verify loops. The transport only emits `structuredContent` when `data` exists; a missing required schema cannot be distinguished from a text-only tool.
- **Expected:** Add output schemas in family batches, starting with `kyx_state`, `kyx_intent`, `kyx_tracks`, `kyx_fx`, `kyx_clips`, `kyx_automation`, `kyx_master`, `kyx_export`.
- **Confidence:** High (measured).
- **Owner layer:** MCP contract.

### F-12 — Receipts do not distinguish applied, persisted, rendered and audible (P2)

- **Evidence:** `McpToolResult` carries `mutated`, `replayed`, `dryRun`, `docId/docName`, `errorCode`, but no completion stage (`src/mcp/tools.ts:3243-3290`). Document mutations arm the autosave debouncer; the MCP result returns before the debounce flush (`src/services.ts:1239-1285`). Export reports “WAV exported …” after `downloadBlob`/`downloadWav` is triggered, without verifying a file on disk (`src/export/quick-bounce.ts:98-110`).
- **Impact:** An agent can reasonably read `mutated: true` as “saved” or “exported”, which is not true. There is no common stage vocabulary across tools.
- **Expected:** Add a bounded completion stage: `applied` (document), `history-recorded`, `persisted` (repository transaction resolved), `rendered` (PCM produced), `delivered` (download/network receipt). Do not claim a later stage than was observed.
- **Confidence:** High (source-confirmed).
- **Owner layer:** result contract + persistence/export adapters.

### F-13 — Transport parity and identity gaps: desktop-only render hook, shared agent identity, no cancellation, no web rate limit (P2/P3)

- **Evidence:**
  - `renderMix` is provided by `src/mcp/desktop-host.ts:68` but not by `src/mcp/web-host.ts`. `kyx_master op:iterate` refuses without it (`src/mcp/tools.ts:10636-10640`), so the same tool succeeds on desktop and refuses on web.
  - All web relay calls are attributed `"web-relay"` (`src/mcp/bridge.ts:160`); all desktop calls `"desktop-stdio"` (`src/mcp/desktop-host.ts:143`). There is no per-client identity or scope.
  - No MCP cancellation implementation was found (`notifications/cancelled` or equivalent). The transport timeout only stops waiting; the renderer work continues.
  - The web `/mcp` route checks the token and a 1 MB body cap but has no rate limiter (`server/collab-server.mjs:997-1025`); the desktop bridge has a 30/min token bucket (`desktop/mcp-bridge-server.cjs:20-26,150-157`).
- **Impact:** Capability discovery is transport-dependent but not advertised; multiple agents cannot be distinguished for audit or undo consent; a timed-out call can continue and a retry can duplicate work; the web endpoint is easier to hammer than the desktop one.
- **Expected:** Advertise per-transport capabilities in discovery, add an optional agent identity/scope, implement cancellation or document its absence, and apply the same rate policy to `/mcp`.
- **Confidence:** High (source-confirmed; cancellation absence by search).
- **Owner layer:** transports + trust layer.

### F-14 — Documentation and test metadata drift (P3)

- **Evidence:** Current catalog is **38 tools / 25 output schemas**. `src/ui/App.tsx:402` still says “MCP surface (31 tools)”; `tests/mcp-tools.test.ts:129` still titles the surface “the 37 documented tools” even though it asserts 38 names; the 2026-10-20 audit records 37/24. `docs/CURRENT-STATE.md` has stale/forward-dated provenance noted by the 2026-10-24 abandoned-feature audit.
- **Impact:** Humans and agents cannot trust the headline counts; the mirror gate is the only reliable count. This is not a functional defect, but it weakens the repository’s single-source-of-truth contract.
- **Expected:** Derive the displayed count from `MCP_TOOLS.length` and the schema count from the array, or update the literals in the same commit.
- **Confidence:** High (measured).
- **Owner layer:** docs + UI copy + test titles.

### F-15 — `kyx_checkpoint restore` replaces the whole document without an explicit confirmation (P3, arguably intentional)

- **Evidence:** Restore builds a full-document snapshot and executes it (`src/mcp/tools.ts:7181-7193`). It is undoable in one step and its diff op is available first, but it is not behind the D4 destructive flag.
- **Assessment:** Because the checkpoint exists specifically to restore a prior state, gating it behind the destructive unlock would make recovery harder. The current behavior is defensible if the diff is read first. Document it as a recovery-class operation, not a destructive edit.
- **Confidence:** High (source-confirmed).

---

## 7. Intent Engine findings

### 7.1 What is strong

- The router is a real precedence chain, not a bag of regexes: safety fences, transport/session commands, selection scope, complaint, descriptive decline, parameter intent, studio words, clips/arrange, compound, exact, preset/scene, send, fader, loudness/tempo, bypass, effect, section structure, production/mix, revise, clarification, pattern (`src/intent/route-precedence.ts`).
- Ambiguity is resolved toward the least destructive interpretation, and unmatched commands go to clarify with executable suggestions rather than generation (`src/ui/IntentPanel.tsx:4907-4935`).
- Destructive routes save a durable checkpoint before execution (`src/ui/IntentPanel.tsx:4134-4145`), and MCP destructive routes use the same predicate (`src/mcp/tools.ts:11695`).
- Compound asks are tested for atomicity: one undo for multiple clauses, including cross-executor compounds (`tests/intent-e2e-audit.test.ts:145-355, 624-658`).

### 7.2 Coverage against the audit’s fixtures

| Request                                           | Expected behavior                                       | Observed / inferred behavior                                                                                                                                                                                  | Status                    |
| ------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| “Mute track 3”                                    | Direct, exact target                                    | The exact parser supports named targets (drums/bass/lead/chords/vocal/pads); ordinal “track 3” is not part of the deterministic vocabulary. `kyx_tracks` needs a trackId; `kyx_intent` has no ordinal target. | Partially supported       |
| “Set vocal reverb mix to 25%”                     | Effect + parameter + target, percent semantics          | Absolute percent rides the effect’s primary knob range; tested for “set the lead reverb mix to 25%” (`tests/intent-e2e-audit.test.ts:727`). A vocal target resolves by role/clip binding in the mix layer.    | Verified (document)       |
| “Lower this track by 3 dB” when selection changes | Contextual target from selection                        | No selected-track context is passed (`src/intent/route.ts:741-748`); the phrase has no stable target.                                                                                                         | Not exposed               |
| “Duplicate the chorus, then fade the copy in”     | Compound: duplicate section/clip, then fade             | Duplicate/arrange and selected audio fade exist separately, but there is no compound clause that carries an audio fade on a newly created copy.                                                               | Partially supported       |
| “Make the vocals wider”                           | Effect move on the vocal target                         | Semantic TWIST moves exist and targets include `vocal`; per-role focus is defined only for drums/bass/chords/lead, so the vocal case is not validated.                                                        | Wired, unverified         |
| “Clean up this recording”                         | Clarify or bounded repair proposal                      | The complaint route can diagnose; there is no recording-cleanup verb. Unmatched text clarifies rather than generating.                                                                                        | Partially supported       |
| “Delete the takes”                                | Destructive, explicit target, confirm/gate              | `kyx_takes deleteTake` exists and is D4-gated; the Intent Engine has no take-delete route.                                                                                                                    | Not exposed (Intent)      |
| “Use a plugin that does not exist”                | Refuse, no invented parameter                           | `kyx_catalog` and the parameter registry reject unknown effects; the model gate rejects a non-executable plan.                                                                                                | Verified (refusal)        |
| Two tracks with the same name                     | Disambiguate or fan out with a named receipt            | Family resolution fans out to all matching tracks; MCP documents “set* ops apply to every track the family resolves to”.                                                                                      | Partially supported       |
| Cancel / timeout / project switch mid-execution   | No mutation to the wrong document; receipt says partial | Generation previews have stale guards; the general route path captures `doc` before awaits and has no document-identity check. No race probe exists.                                                          | Unknown                   |
| Human and AI edit the same clip, then undo        | Final state and undo are coherent                       | Commands are inverse-patch deltas and preserve concurrent changes, but global LIFO means undo reverts whoever is on top. No concurrency test.                                                                 | Unknown / partly inferred |

### 7.3 Confirmation behavior

- **Clarifies:** ambiguous target, missing fader target, contradictory directions, negation, hypothetical questions, descriptions that are not commands, unknown presets, unsupported effect knobs.
- **Refuses:** generation over MCP, save/export/record over MCP, destructive MCP operations without the unlock, mic-recording undo, foreign-work undo without consent.
- **Previews:** generation candidates, mix ideas, complaint chips, plan dry-runs.
- **Confirms:** destructive UI intents do **not** ask a modal; they execute with undo plus a durable checkpoint. Checkpoint restore does not ask either, but shows a diff first. This is a deliberate recovery-first design, not a hidden bypass, but it should be documented as such.
- **Atomicity:** compound and batch grouping are tested; not every multi-step domain workflow is one transaction (e.g. a song with a loudness trim is two undo steps by design).

### 7.4 The model fallback

The model is correctly treated as a fallback, not an authority: it cannot overrule a specific deterministic route, cannot mutate from a description, and must produce an executable, changing plan (`src/intent/model-route-gate.ts`). However, the gate is currently red on one corpus case (F-09), and `kyx_intent` over MCP consults the model for `pattern`/`clarify` routes (`src/mcp/tools.ts:4169-4200`), which means the same red gate can affect agent asks.

---

## 8. MCP as a control plane

### 8.1 Catalog

**38 tools, 25 output schemas, 13 text-first.** Tool families:

`kyx_intent`, `kyx_state`, `kyx_undo`, `kyx_transport`, `kyx_export`, `kyx_audio_preview`, `kyx_generate`, `kyx_groove`, `kyx_fx`, `kyx_sections`, `kyx_markers`, `kyx_tracks`, `kyx_pattern`, `kyx_steps`, `kyx_notes`, `kyx_music`, `kyx_catalog`, `kyx_plugin_param`, `kyx_instrument_param`, `kyx_meter`, `kyx_automation`, `kyx_clips`, `kyx_batch`, `kyx_loudness`, `kyx_import_sfz`, `kyx_publish_gallery`, `kyx_render_summary`, `kyx_diagnose_mix`, `kyx_mix_idea`, `kyx_checkpoint`, `kyx_mix`, `kyx_arrange`, `kyx_song`, `kyx_routing`, `kyx_unsuno`, `kyx_master`, `kyx_takes`, `kyx_blind_ab`.

Text-first (no declared `outputSchema`): `kyx_intent`, `kyx_state`, `kyx_export`, `kyx_generate`, `kyx_fx`, `kyx_tracks`, `kyx_pattern`, `kyx_automation`, `kyx_clips`, `kyx_checkpoint`, `kyx_song`, `kyx_unsuno`, `kyx_master`.

### 8.2 Discovery and schema quality

- Input schemas are generally specific: enums, bounds, units, stable-id preferences and explicit op lists. `kyx_plugin_param` correctly documents native units and points at `kyx_catalog` for ranges.
- Output schemas exist for 25 tools, but the most important orchestration tools (`kyx_state`, `kyx_intent`, `kyx_tracks`, `kyx_fx`, `kyx_clips`, `kyx_automation`) are text-first.
- The catalog does not advertise per-transport capability differences (`renderMix`, `loadSampleMono`, live meters). An agent discovers a tool, not whether the current host can execute it.
- The generated mirrors are stale (F-03), so discovery is not merely incomplete in source; it is wrong on the wire.

### 8.3 Authorization and least privilege

- Bearer token on both transports; desktop uses a random per-session token and constant-time compare; web uses `MCP_TOKEN`.
- Destructive document removals are gated by `pf:mcp-allow-destructive` and an auto-checkpoint (`destructiveAllowedWithCheckpoint`, `src/mcp/tools.ts:7074-7078`).
- The risk model is per tool, not per call (F-10), and `kyx_generate replace` is not gated (F-01).
- Checkpoints are separately persisted and restore is one undo step; they are not project save-as.
- There is no per-agent token or scope; all web clients share `"web-relay"` and all desktop clients share `"desktop-stdio"` (F-13).

### 8.4 Receipts, idempotency and errors

- Typed error codes are a closed set of 11 (`UNKNOWN_TOOL`, `UNKNOWN_REQUEST`, `INVALID_ARGUMENTS`, `UNKNOWN_TARGET`, `EXECUTION_FAILED`, `PARTIAL_FAILURE`, `UNAVAILABLE_ON_TRANSPORT`, `POLICY_REFUSED`, `REQUEST_ID_CONFLICT`, `INVALID_REQUEST_ID`, `RESOURCE_LIMIT`). Tests pass.
- Idempotency is bound to `requestId` + canonical tool/argument signature + agent + document id, with a 256-entry in-memory ledger. Same-key different-request returns `REQUEST_ID_CONFLICT`; same-key same-request replays. The ledger is per host process and is lost on restart.
- Dry-run executes against a sandbox document and refuses runtime side effects (transport, export, gallery, audio preview, SFZ import, checkpoint save/delete, mix preview). Tests pass.
- Batch runs up to 10 calls and folds document mutations into one undo frame when the host supports it; nested and async calls are refused. Tests pass.
- **The receipt does not name a completion stage** (F-12). “Mutated” is a document claim, not a persistence or audio claim.

### 8.5 Transport safety

| Control                    | Desktop                                         | Web                                     |
| -------------------------- | ----------------------------------------------- | --------------------------------------- |
| Authentication             | Per-session random token, constant-time compare | `MCP_TOKEN`, bearer check               |
| Body cap                   | 1 MB                                            | 1 MB                                    |
| Rate limit                 | 30/min token bucket                             | None on `/mcp`                          |
| Call timeout               | 15 s; 60 s for long tools                       | 15 s; 60 s for long tools               |
| Single executor            | Focused window                                  | One relay owner; displacement code 4409 |
| Cancellation               | Not implemented                                 | Not implemented                         |
| Structured result envelope | Full `McpToolResult`                            | Full `McpToolResult` when `data` exists |

---

## 9. State consistency, undo, persistence and DSP

### 9.1 Document authority and undo

- `ProjectStore` is the single document authority. Commands are functional forward/inverse deltas; the store normalizes results and records history only when the document identity changed (`src/store/ProjectStore.ts:213-300`).
- Undo stack depth is 256; history snapshots are bounded to 64 (`src/store/ProjectStore.ts:69,269`). Coalescing groups continuous gestures.
- MCP uses the real store on both transports; `tests/mcp-real-store-undo.test.ts` proves a mutating tool writes the document, lands one undo entry, and a read pushes none.
- **Caveat:** global LIFO is the truth. Multiple agents and the human share one history; `kyx_undo` can revert foreign work only with `allowForeign: true` when the context is attributed (`src/mcp/tools.ts:4239-4252`). This is documented, not hidden.

### 9.2 Persistence

- `onDocChanged` drives engine projection and arms an 800 ms autosave debouncer; force flush happens after 5 s or 50 arms, and pagehide/visibility handlers flush (`src/services.ts:1190-1285`).
- `tests/mcp-persistence.test.ts` binds the real store, engine projection spy, real debouncer and real repository over fake IndexedDB: mutation → projection → flush → reload, plus a failed-write path that surfaces `saveStatus: "error"`.
- **No MCP save tool.** The AI cannot force or verify a durable write. `mutated: true` is not `persisted`.
- Checkpoints are a separate repository; they are not the project record and do not replace save-as.

### 9.3 Audio/DSP verification

- The document → engine projection hop is tested with a spy, not with PCM. `AudioEngine.setProject` is exercised; the actual audible result of an MCP parameter write is not measured in this audit.
- Prior audit evidence (`npm run verify:param-readback`, 2026-10-24) measured selected saturation/widener changes through real browser renders, but the current audit did not re-run it and did not measure the full song, mixer-strip initialization, automation+export, or human listening.
- Live and offline share the same engine entry points by architecture. That is a structural guarantee, not a measured one for every effect.
- No evidence was found of LLM/network waits inside AudioWorklet callbacks; MCP dispatch runs from renderer event/IPC handlers.

---

## 10. Adversarial scenario results

| Scenario                                                               | Setup / action                                     | Expected invariant                                   | Observed evidence                                                                                      | Result                 | Limit                                                          |
| ---------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------- | -------------------------------------------------------------- |
| MCP sets a plugin parameter; UI updates but DSP does not               | `kyx_plugin_param set` on a track effect           | Document, engine projection and audible output agree | Document + engine projection tested; no PCM measurement in this audit                                  | Unknown                | Needs `verify:param-readback`-style PCM after the current edit |
| Intent sends normalized value where dB expected                        | “lower the bass by 3 dB” / “set reverb mix to 25%” | dB and percent retain their domains                  | Exact/fader tests pass; param read-back tests pass; percent rides the knob range                       | Verified (document)    | No PCM                                                         |
| Human and AI edit the same clip, then undo                             | Concurrent edits, then global undo                 | Final state coherent; undo names what it reverted    | Delta commands preserve unrelated edits; undo is global LIFO; no race probe                            | Unknown                | Needs a real interleaving test                                 |
| Tool times out after applying; retry duplicates a destructive op       | Same `requestId` retry after timeout               | Replay, not duplicate                                | Idempotency ledger tested; in-memory and per-process; timeout does not cancel renderer work            | Partially verified     | Restart/eviction and late timeout unproven                     |
| AI reorders plugins while automation references an instance            | Reorder, then inspect automation                   | Automation follows stable ids or fails explicitly    | Automation targets effect ids; reorder keeps ids; no combined test                                     | Partially verified     | No end-to-end automation+reorder test                          |
| Save/load recreates state but AI holds stale track ids                 | Save, reload, reuse old id                         | `UNKNOWN_TARGET`, no silent retarget                 | MCP resolves ids at call time and returns typed errors; tests cover missing targets                    | Verified (refusal)     | No real project-switch probe                                   |
| Multi-step workflow fails at step 3 of 5                               | Batch or compound, then failure                    | Report committed prefix; no silent rollback claim    | Batch reports per-call results and `PARTIAL_FAILURE`; compound is one command; async tools refused     | Verified (document)    | No cross-tool transaction beyond batch                         |
| Agent changes tempo during recording/export                            | `kyx_music setTempo` while recording/rendering     | Lock or refuse                                       | No recording/export lock in the MCP tempo path; only undo checks mic recording                         | Unknown / risk         | No runtime probe                                               |
| Bounce succeeds as an API call but output is silent/clipped            | `kyx_export`                                       | File exists and content is meaningful                | `quickBounceDownload` returns duration/size/mix check; no file verification or PCM check in this audit | Partially verified     | Needs a download/PCM acceptance test                           |
| Human disables an effect while AI modifies it                          | Concurrent bypass/param write                      | Final document and UI/DSP agree                      | Commands are synchronous in the renderer; last write wins; no conflict detection                       | Unknown                | Needs a race probe                                             |
| Recovery restores audio but loses plugin/automation state              | Save/reload/crash recovery                         | Full project state round-trips                       | Repository round-trip tests are broad; exact FX+automation+clip combination not tested                 | Partially verified     | Needs a combined fixture                                       |
| Feature flag or permission blocks an operation while MCP advertises it | Destructive flag off, or transport hook absent     | Tool refuses honestly or is not advertised           | Destructive ops refuse honestly; `kyx_unsuno transcribe` advertises a capability no host provides      | Partially broken       | Fix F-04                                                       |
| No-op intent call                                                      | `kyx_intent` mute already-muted track              | `mutated: false`, no undo claim                      | Probe: `mutated: true`, “one undo step”, undo depth unchanged                                          | Broken                 | Confirmed                                                      |
| Stale generated mirror                                                 | Schema-validating client asks for `strk`/`cink`    | Served schema matches source                         | Mirror gate red; `strk`/`cink` absent                                                                  | Broken                 | Confirmed                                                      |
| Pattern-replace generation with destructive lock off                   | `kyx_generate replaceMode:replace`                 | Destructive gate or explicit confirmation            | No gate in source                                                                                      | Broken (authorization) | Confirmed by source                                            |

---

## 11. Prioritized hardening opportunities (Top 10)

Ranked by data-loss/authorization impact, then observability, then coverage. Each item names the owner layer and an acceptance test.

### 1. Gate pattern-replacing generation (P0/P1) — F-01

- **Owner:** MCP policy (`TOOL_RISK`, per-op gate), `kyx_generate`.
- **Minimal approach:** Treat `replaceMode: "replace"` as destructive: require `allowDestructive` and save `auto-before-kyx_generate` before mutation, or require `confirm: true` on the tool call. Keep `new` ungated.
- **Tests:** `tests/mcp-generate-replace-gate.test.ts` — locked context refuses with `POLICY_REFUSED` and no document change; unlocked context applies and one undo restores; `new` works while locked.
- **Compatibility:** No schema removal; add `confirm` as an optional argument if used. Update annotations to per-op or document the exception.
- **Acceptance:** A locked client cannot change an existing pattern’s notes/steps; a successful replace is one undo step and a checkpoint exists.

### 2. Make intent receipts truthful (P1) — F-02

- **Owner:** `executeRoutedIntent`; one shared postcondition helper.
- **Minimal approach:** Capture `before = ctx.getDoc()` and `after`; set `mutated = after !== before`; if unchanged, return “nothing changed” with no undo claim. For every route kind, read back at least the changed target/value (fader, exact, send, bypass, groove, clips, markers, sections, automation).
- **Tests:** Extend `tests/mcp-intent-param-readback.test.ts` or add `tests/mcp-intent-receipts.test.ts`: second identical mute → `mutated: false`, no undo step; fader/exact/send/clip routes include the committed value in text/data; no route returns the bare “verification: applied”.
- **Compatibility:** `mutated` becomes more accurate; clients that relied on `true` for no-ops should be updated. Add structured status, not new error codes.
- **Acceptance:** No MCP intent result claims “one undo step” when the store’s undo depth did not change.

### 3. Regenerate mirrors and make the drift gate blocking (P1) — F-03

- **Owner:** `scripts/generate-mcp-mirrors.mts`, CI.
- **Minimal approach:** Run `npm run gen:mcp-mirrors`; commit both mirrors. Add a CI/pre-commit check that runs `verify:mcp-mirrors` after `src/mcp/tools.ts` or registry changes.
- **Tests:** `tests/mcp-mirror-sync.test.ts` green; a negative test that mutates a mirror in a temp copy and proves the gate fails.
- **Compatibility:** Mirrors are generated; no API change.
- **Acceptance:** `strk`/`cink` appear in both mirrors; the full catalog compares equal in order and content.

### 4. Implement or withdraw `kyx_unsuno transcribe` (P2) — F-04

- **Owner:** `desktop-host.ts`, `web-host.ts`, `McpToolContext`.
- **Minimal approach:** Add `loadSampleMono` in both hosts using the existing user-sample repository + `decodeAudioData`; return mono PCM + sample rate. If that is not ready, remove `transcribe` from discovery or mark it `UNAVAILABLE_ON_TRANSPORT` in the description and output schemas.
- **Tests:** Real-host wiring test (web and desktop contexts), plus an unknown-sample refusal and a silence/tempo refusal. Keep the existing fake-context contract test.
- **Compatibility:** New capability hook; no document schema change.
- **Acceptance:** A live window can transcribe a user sample and build a project in one undo step; a headless context still refuses honestly.

### 5. Add a persistence/completion stage and a host-mediated save (P1) — F-12

- **Owner:** `McpToolResult`, `services.ts`, export adapter.
- **Minimal approach:** Add an optional `stage` enum (`applied`, `history-recorded`, `persisted`, `rendered`, `delivered`) and set it only from observed facts. Add `kyx_save` (or `kyx_project save`) that force-flushes the autosave pipeline and returns the repository transaction result; require user confirmation if save-as is added.
- **Tests:** Mutation → `stage: applied`; force flush → `stage: persisted`; failed repository → error stage; export → `rendered` plus a download trigger, never `delivered` without a receipt.
- **Compatibility:** Additive field; existing clients ignore it.
- **Acceptance:** An agent can distinguish “document changed” from “durable”, and can force a durable save before ending a session.

### 6. Accept stable effect instance ids on writes (P2) — F-06

- **Owner:** `kyx_plugin_param`, `kyx_fx`, `kyx_automation`, command adapters.
- **Minimal approach:** Add optional `fxId` (or `effectId`) to set/remove/bypass/reorder and to automation FX targets. Resolve it first; if both `fxId` and `instance` are supplied, require agreement. Return `UNKNOWN_TARGET` on stale ids.
- **Tests:** Read chain → reorder → write by `fxId` still hits the original instance; ordinal write after reorder either hits the named instance or fails explicitly; automation lane follows the moved instance.
- **Compatibility:** Keep ordinal fallback; no breaking change.
- **Acceptance:** A stale ordinal can never silently write to a different device.

### 7. Declare output schemas for the primary tools (P2) — F-11

- **Owner:** MCP contract.
- **Minimal approach:** Add schemas in batches: `kyx_state` (subject-discriminated), `kyx_intent` (route/status/targets/changes/undo), `kyx_tracks`, `kyx_fx`, `kyx_clips`, `kyx_automation`, `kyx_master`, `kyx_export`.
- **Tests:** Schema validation for success and error envelopes; transport `structuredContent` parity; a missing-data test that flags a contract miss.
- **Compatibility:** Additive; text remains.
- **Acceptance:** The primary read → edit → verify loop needs no text parsing.

### 8. Fix the red model-gate test and add the case to the ratchet (P2) — F-09

- **Owner:** `src/intent/model-route-gate.ts` / `src/plugin-catalog.ts` / fixture.
- **Minimal approach:** Determine whether the resolver or the fixture is wrong. Restore the executable-plan acceptance, or record the new expected behavior with an owner and reason in `suite-expectations.json`.
- **Tests:** `tests/intent-router-corpus.test.ts` green; a negative control that a non-executable plan is still rejected.
- **Compatibility:** Intent behavior only.
- **Acceptance:** No unowned red in the focused intent corpus.

### 9. Add selected-track context and stable clip ids (P2) — F-07, F-08

- **Owner:** intent context, MCP target resolution.
- **Minimal approach:** Pass `selectedTrackId(s)` into `routeIntentText`; add `clipId` to scene/audio clip ops; keep bar/anchor fallback with an explicit “resolved a different clip” error.
- **Tests:** “Lower this track by 3 dB” uses the selected track and names it; selection change before execution either uses the captured id or refuses; clip read → move → write by id survives a concurrent insert; bar fallback reports a changed target.
- **Compatibility:** Additive fields; fallback preserved.
- **Acceptance:** Deictic asks have a target or an explicit refusal; no silent retarget.

### 10. Make transport capabilities and cancellation explicit (P2/P3) — F-13

- **Owner:** transports, discovery, Job Center.
- **Minimal approach:** Publish a capability block per session (`renderMix`, `loadSampleMono`, meters, export, preview); implement MCP cancellation or return a `CANCELLED`/`TIMED_OUT` stage with “work may still be running”; apply the desktop rate policy to `/mcp`; add optional agent identity.
- **Tests:** Web `kyx_master iterate` reports the missing capability before mutation; a cancelled call does not claim completion; a timed-out export reports the uncertain state; `/mcp` rate limit returns 429.
- **Compatibility:** Additive discovery; timeouts become more truthful.
- **Acceptance:** An agent can know what the current host can do and whether a timeout means “not applied”, “applied”, or “unknown”.

---

## 12. Top 5 strategic AI-native DAW capabilities

These are product opportunities grounded in existing architecture, not defects.

1. **Agent session transaction with diff, branch and recover.** Use the existing command deltas, checkpoints, session audit and undo frames to make an agent session a first-class object: start, preview, commit, branch, revert, export a patch. The pieces exist (`agentTrust`, `checkpoints`, `ProjectStore`); the missing product layer is a session record and a UI that compares two sessions.
2. **Audible verification loop for every edit.** A tool that renders a bounded region before/after an edit and returns PCM-derived evidence (RMS, LUFS, spectral delta, null-test result) would close the document→DSP gap. `renderProject`, `renderTrack`, `verify:param-readback` and `AudioEngine` already provide the primitives.
3. **Selection-aware co-editing.** Expose the live selection (tracks, clips, notes, ranges) as a read-only resource with a revision token, and let AI proposals cite “this selection”. This turns deictic language into a stable target and makes human/AI collaboration legible.
4. **Arrangement-level structural control.** Track reorder, audio-file import, recording arm/start/stop, clip pitch and source trim are standard DAW operations with existing commands. Exposing them behind file/device pickers and explicit confirmations would move the AI from pattern editing to actual production.
5. **Risk-aware human approval workflow.** Replace the single destructive flag with per-operation risk metadata and a proposal/approve/commit flow for irreversible or high-impact actions (pattern replace, save-as, gallery publish, bulk delete). Keep reads and reversible edits autonomous; make the dangerous ones intentional.

---

## 13. Suggested staged roadmap

| Phase                              | Work                                                                                                 | Exit evidence                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 0 — Truth before capability (days) | Regenerate mirrors; fix the red model-gate test; correct tool counts; make intent receipts truthful. | Mirror gate green; intent corpus green or explicitly ratcheted; no-op probe returns `mutated:false`. |
| 1 — Safety and durability (1 week) | Gate `replace` generation; add persistence stage + `kyx_save`; add stable `fxId` writes.             | Locked replace refuses; save returns persisted; reorder+write test passes.                           |
| 2 — Observability (1–2 weeks)      | Output schemas for the 8 primary tools; cancellation/timeout stage; transport capability discovery.  | Structured read→edit→verify loop; timeout receipts are truthful.                                     |
| 3 — Capability (2–4 weeks)         | Audio import, recording control, track reorder, clip pitch, selected-track context.                  | Each has a real host path, one undo step, and a refusal test.                                        |
| 4 — Autonomy (later)               | Session transactions, audible verification loop, approval workflow.                                  | A multi-step agent session can be reviewed, reverted and proven without human interpretation.        |

Do not start Phase 2/3 before Phase 0/1: more tools on a stale or overclaiming contract increase the blast radius.

---

## 14. Open questions, untested claims and prerequisites

1. Does the live engine actually apply a parameter written through MCP at the same value the document reports? The document→engine projection is tested with a spy, not PCM.
2. Does an offline render after an MCP edit match the live result for every effect, especially worklet-backed flagships? Prior `verify:param-readback` covered selected effects only.
3. How does a real desktop MCP client experience a structured-output miss on a text-first tool? The SDK client test covers representative tools, not all 38.
4. Does the web relay survive a project switch while a tool is in flight? No probe exists.
5. Does an agent’s idempotent retry after a transport timeout replay the committed operation or duplicate it? The ledger covers the synchronous path; the late-timeout path is unproven.
6. Does crash recovery restore the exact FX/automation/clip state an agent edited? Repository round-trips are broad but not this combination.
7. Does a human gesture during an MCP batch interleave? The renderer is single-threaded and the batch is synchronous, but no measured race exists.
8. What is the intended permission model for save-as, audio import and recording? These are product decisions, not test gaps.
9. Are the 13 text-first tools intentionally text-first, or simply not yet migrated? The prior audit treated it as incremental; no design note forbids schemas.
10. The repository is a shared worktree; any hardening change must be staged by path and verified in isolation, per `docs/MULTI-AGENT-GUARDRAILS.md`.

---

## 15. Verification log

| Command / check                                                                                                                   | Result                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AST parse of `MCP_TOOLS`                                                                                                          | 38 tools; 25 with `outputSchema`; 13 without                                                                                                                                             |
| `npx vitest run` on 10 MCP/trust/persistence files                                                                                | 9 files passed; `tests/mcp-mirror-sync.test.ts` failed (2/4 tests)                                                                                                                       |
| `npx vitest run tests/mcp-mirror-sync.test.ts --no-cache`                                                                         | Reproduced: 2 failed, 2 passed; diff shows `strk`/`cink` only in source                                                                                                                  |
| `npx vitest run` on 4 intent files                                                                                                | 304 passed; 1 failed (`tests/intent-router-corpus.test.ts:593`, model route gate)                                                                                                        |
| Disposable headless probe: two identical `kyx_intent` mute calls                                                                  | Second call `mutated:true`, text claims “one undo step”, undo depth 1→1; probe deleted                                                                                                   |
| Additional focused recheck: MCP tools/idempotency/undo/batch/agent simulation, intent corpus/parameters, persistence, mirror sync | 9 files; 365 passed, 3 failed. One `intent-router-corpus` model-route-gate assertion failed (expected `effectIntent`, got undefined); desktop and server MCP mirror parity tests failed. |
| `npm run verify:mcp-mirrors`                                                                                                      | Interrupted after startup stalled; termination output also reported drift in `desktop/mcp-tool-defs.cjs` and `server/mcp-core.mjs`. No mirrors were regenerated.                         |
| Source trace: `src/mcp/tools.ts`, `src/mcp/agentTrust.ts`, `src/store/ProjectStore.ts`, `src/services.ts`, host files             | Confirms command-path convergence, risk model, autosave, transport hooks                                                                                                                 |
| Browser/PCM/human listening                                                                                                       | Not run in this audit                                                                                                                                                                    |

**Files created:** this report only. No production code, schema, dependency, tool contract or UI was changed. One disposable probe file was created under `tests/` and deleted after execution.
