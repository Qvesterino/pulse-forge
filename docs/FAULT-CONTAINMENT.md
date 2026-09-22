# FAULT CONTAINMENT

> **Cross-platform readiness campaign — GOAL 07 deliverable** (2026-09-22).
> Where failures are contained, how they surface, and what remains open.
> Method: two parallel read-only sweeps (UI boundary census; async/worker/
> network/persistence rejection sweep), spot-verified. Companion:
> `docs/STATE-MACHINES.md` (failure states per machine), `CAMPAIGN_STATE.md`.
>
> Rule honored: no broad catch blocks — every fix below narrows a real
> escape path; recorded items list the reason they stay open.

---

## 1. Fault boundary map (what contains what)

| Boundary                                                                  | Contains                                                                                                                                                                                          | Status                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Route boundaries (`main.tsx`)                                             | embed / gallery / download apps — full crash screen with `crashNote`                                                                                                                              | pre-existing                                    |
| Studio root boundary (`main.tsx:243`)                                     | whole studio; `onCrashSave` fires `flushSave()`                                                                                                                                                   | pre-existing                                    |
| **Dock panel boundaries** (App.tsx, `panel=` inline retry ×10)            | devices/fx/plugin, mixer, arr, mod, exp, midi, dice, intent, diagnostics                                                                                                                          | pre-existing                                    |
| **Sequencer boundary** (App.tsx, `panel="sequencer"`)                     | the primary writing surface + PianoRoll — was root-crash class                                                                                                                                    | **FIXED (GOAL 07)**                             |
| **Inspector boundary** (App.tsx, `panel="inspector"`)                     | PresetBrowser + SliceLab lazy chunks (the #1 crash source: deploy chunk 404) + ModMatrix/SampleBrowser/Freesound                                                                                  | **FIXED (GOAL 07)**                             |
| **PaletteOverlay boundary** (App.tsx, `panel="palette"`)                  | lazy command-palette chunk                                                                                                                                                                        | **FIXED (GOAL 07)**                             |
| **TopBar popover boundaries** (TopBar.tsx, ×4: scale/collab/theme/assist) | CollabPanel swaps live services — its failure must not destroy the path back to ProjectBrowser                                                                                                    | **FIXED (GOAL 07)**                             |
| **Gallery per-card boundary** (GalleryPage.tsx)                           | one bad card no longer replaces the whole feed                                                                                                                                                    | **FIXED (GOAL 07)**                             |
| **LandingPage boundary** (main.tsx)                                       | landing route had NO containment                                                                                                                                                                  | **FIXED (GOAL 07)**                             |
| **ProjectBrowser crashNote** (main.tsx)                                   | default copy over-claimed "Your work has been saved" for a browser screen                                                                                                                         | **FIXED (GOAL 07)**                             |
| Worker clients (`src/ai/*-client.ts` etc.)                                | `typeof Worker` degradation + job-id + timeout + circuit breaker                                                                                                                                  | pre-existing (audited strong)                   |
| Scheduler windows (`Scheduler.ts`)                                        | per-window try/catch → `failedWindows` counter, playback continues                                                                                                                                | pre-existing                                    |
| PCM recorder (`PcmMicRecorder`)                                           | error → self-stop → `markRecoverable`; `onprocessorerror` wired                                                                                                                                   | pre-existing                                    |
| Effect worklets (load time)                                               | `isWorkletReady` + native fallback + degraded flag + rack warning                                                                                                                                 | pre-existing                                    |
| **Effect worklets (runtime)**                                             | `attachProcessorErrorGuard` (`src/audio-worklets/processor-errors.ts`) — `onprocessorerror` → console + `processorErrors` counter surfaced in `getDiagnostics()`; wired in `createWorkletRuntime` | **FIXED (GOAL 07, incremental wiring)**         |
| Corrupted projects                                                        | shape gate → migrate (throws on future) → normalize; quarantine via `listIncompatible`                                                                                                            | pre-existing (pinned by GOAL 05 matrix)         |
| Curated samples                                                           | decode failure → synthesized fallback                                                                                                                                                             | pre-existing                                    |
| Frozen tracks                                                             | restore failure → auto-unfreeze                                                                                                                                                                   | pre-existing (restoration silence recorded, §3) |

## 2. Rejection paths closed (GOAL 07)

1. **`AudioEngine.setProject` deferred body** — `try/finally` had no catch;
   the queue is the hottest path in the app (every doc change). A thrown
   body now logs `[audio-engine] setProject body failed` instead of
   rejecting unhandled (mirrors `queueFxRebuild`'s own guard).
2. **`doSave` save-status listener** — `setSaveStatus("saving")` moved
   inside the try: a throwing store listener can no longer reject
   `flushSave` unhandled exactly during pagehide/beforeunload/crash-save.
3. **Groove-pool delete** (ModPanel) — `.then` without onRejected → console
   error surfaced.
4. **`intent/audition` resume** — closed-context race rejected silently into
   an unhandled rejection → caught (rebuild-on-next-audition already
   handles the state).
5. **Service-worker update poll** (sw-update ×3) — offline/deployed-404
   update fetches rejected every 15 min → caught.

## 3. Recorded (open, with reasons)

- **Runtime `onprocessorerror` wiring is incremental**: `createWorkletRuntime`
  (transient/gate) is wired; the ~28 per-effect/instrument node factories
  are not (mechanical sweep, touch when their churn clears — the effects
  registry path covers the plugin class the campaign names).
- **Bounce-to-clip persistence failure is console-only** (App.tsx /
  ArrangementPanel): the clip plays this session and is gone after reload.
  Needs a session-scoped warning channel — queued (UI copy decision).
- **Frozen-track restore failure and user-sample boot-restore decode
  failure are console-only** — sample silently missing after reload. A
  "restored with warnings" list would need a persistent flag across the
  boot path — queued.
- **Crash screen copy** ("Your work has been saved.") remains unconditional —
  `onCrashSave` is fire-and-forget by design (a crashing tree cannot await);
  honest copy requires the boundary to read save status — queued.
- **Collab relay retries are unbounded** (y-websocket default) and the 8 s
  `markSyncFailed` degrade has no "jam is offline, edits stay local"
  message — partially visible via the status pill; queued.
- **No global `window.onerror` / `unhandledrejection` reporter** — adding one
  is a diagnostics decision (where would it report?); queued.
- **Gallery server cap divergence, `fxeq.band.*` unbounded localStorage
  namespace** — carried from GOAL 05 (server-side / cleanup decisions).

## 4. Verified safe (do not re-chase)

`ensureWorkletsForDoc` (loaders never reject), curated-layer + library-load
swallows (by contract), MIDI requestAccess (never rejects), AI worker
extractor promises (`.catch` at creation), gallery feed/publish two-arg
`.then` chains, ArrangementPanel/ExportPanel recording quota UX (typed
`RecordingStorageQuotaError` → user messages), snapshot failure banner
(UndoHistoryPanel), morph preset error banner, autosave failure → SAVE
ERROR — RETRY pill (TopBar).
