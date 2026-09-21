# STATE MACHINES

> **Cross-platform readiness campaign — GOAL 04 deliverable** (2026-09-22).
> The important implicit state machines formalized from the ACTUAL code
> (three parallel read-only sweeps, spot-verified), with valid states,
> transitions, invalid/unsafe transitions, side effects, failure states and
> recovery. Unsafe transitions marked **FIXED (GOAL 04)** were repaired in
> this campaign goal; **RECORDED** ones are deliberate, bounded, or queued
> with a reason. No state-machine framework was introduced (campaign rule) —
> guards + tests pin the contracts. Companion: `docs/PLATFORM-CONTRACTS.md`,
> `CAMPAIGN_STATE.md`.

---

## 1. Transport (`src/transport/Transport.ts` + `PlaybackController` in `src/services.ts`)

**States** (fields, not an enum): **stopped** (`!playing && !paused`,
`pauseTick=0`), **paused** (`!playing && paused`, frozen `pauseTick`),
**playing** (content: `position ≥ contentStartTick`) with implicit
**count-in/pre-roll** sub-state (`position < contentStartTick`, may be
negative). Looping is orthogonal (`loopEnabled` polled per tick).

**Key transitions** (all user paths go through `PlaybackController`):
playPause (stopped/paused→playing with lead-in math; playing→paused =
`scheduler.stop → panic → pause`), stop (any→stopped, full teardown),
seek (safe both states), setBpm (position-preserving re-anchor),
launchScene (quantized: immediate when stopped, next-bar when playing).

**Unsafe transitions — verdicts:**

| #   | Finding                                                                                                                                                                                                                                  | Verdict                                                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | `Transport.play()` while playing: no state guard — re-anchors to stale `pauseTick` + arms a fresh count-in (hidden seek+restart; double-scheduling risk). All in-app callers guard today; reachable via the `window.__pfJam` debug hook. | **RECORDED** — adding a guard risks the collab follower path and GhostPreviewPlayer's own instance; the guarded-caller invariant is documented here instead.                                        |
| T2  | Collab playing→playing pulse did `transport.seek()` **without** `scheduler.resync()` — remote seek left the follower's scheduling window on the old timeline (silent hole on backward jumps).                                            | **FIXED (GOAL 04)** — `services.ts` follower handler now calls `scheduler.resync()` when a pulse moves the playhead while playing (no panic: pre-seek voices ring out, jam audio stays continuous). |
| T3  | `MidiClock.handleSlavePulse` seeks +20 ticks per pulse (24×/beat), bypassing `PlaybackController.seek` — re-anchors the tick↔time map under scheduled windows and spams `onGesture` (collab broadcast) ~20 ms.                           | **RECORDED** — MIDI-slave is a niche path; proper fix is drift-threshold gating + scheduler resync in MidiClock, queued as its own change (touches `src/midi/` ownership).                          |
| T4  | `handleSlaveStop` doesn't stop the transport (asymmetric with slave-start).                                                                                                                                                              | **RECORDED** — external Stop semantics are a product decision; current behavior (keep playing) documented.                                                                                          |
| T5  | `PlaybackController.stop()` while fully stopped still runs teardown — scheduler stop **commits a pending pattern launch** (deliberate per Scheduler comment), panic kills ringing voices, gesture broadcasts.                            | **RECORDED** — pending-launch commit on stop is deliberate UX; a redundant-stop early-return would change it.                                                                                       |
| T6  | Pause during count-in rebases `contentStartTick` on resume → remaining clicks become content (events in the silent region schedule immediately).                                                                                         | **RECORDED** — deliberate ("avoid repeating count-in on resume", Transport comment); documented as surprising-but-intended.                                                                         |

**Failure/recovery:** context suspended mid-play freezes `engine.currentTime`
→ transport position freezes; the scheduler's `getContextState` gate skips
scheduling while walking the window forward (no wedge), and the
suspended→running edge re-anchors the window to the live playhead (no
"machine gun" burst); `visibilitychange` best-effort resumes + resyncs.
Scheduler window exceptions are caught, counted (`failedWindows`), playback
continues. Corrupt doc mid-play never substitutes patterns; loop-end falls
back to the first pattern so the transport can't wedge mid-loop.

## 2. Scheduler (mini-machine, `src/scheduler/Scheduler.ts`)

**States:** stopped (`timer=null`) / running (25 ms `setInterval`, 120 ms
horizon). **Guards:** double-start guarded; stop is idempotent but commits a
pending pattern launch (deliberate); `tick()` self-heals a stray start (stops
within one tick if `!transport.playing`). Per-tick pipeline (tempo-seam →
loop wrap → context gate → scheduleWindow) is wrapped in a per-window
try/catch (fail-forward, diagnostics counter).

## 3. Project lifecycle (`openProject` / `closeProject`, `src/services.ts`)

**States:** idle → opening → open → closing → closed, per Services instance.
The engine + AudioContext are **shared across projects** (setProject diff
swap; no context swap on close).

**Transitions/guards:** `closeProject` sets `closed` FIRST (synchronously),
then stops playback/capture/ghost/noteRepeat, disposes collab/MIDI,
uninstalls unload guards, and drains `flushSave` LAST. Fire-and-forget
continuations (frozen restore, MIDI access) check `closed`.

**Unsafe transitions — verdicts:**

| #   | Finding                                                                                                                                                                                                                                                                                                                             | Verdict                                                                                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **Write-after-close:** `store.onDocChanged` did not consult `closed` — a late async mutation (e.g. a recording finalize landing after close) re-pointed the SHARED engine at the dead project and re-armed the debouncer, writing the old project after close (cross-cutting theme behind recording/export/collab unsafe findings). | **FIXED (GOAL 04)** — `onDocChanged` early-returns when `closed`; the final flush sequence inside `closeProject` is unaffected (it runs through `flushSave`, not a doc change). |
| P2  | No double-close guard (second `closeProject` re-runs idempotent teardown + flush).                                                                                                                                                                                                                                                  | **RECORDED** — idempotent in practice; a re-entrancy flag is one line when a second caller appears.                                                                             |
| P3  | No open-during-close guard across instances (isolation relies on each stale instance's own `closed` checks).                                                                                                                                                                                                                        | **RECORDED** — by design: instances are isolated; the engine's queue coalescing is the serializer.                                                                              |

## 4. Recording (`PcmMicRecorder` + `RecordingRecoveryRepository` + UI drivers)

**States:** recorder `idle → starting → recording → stopping` (typed union,
`state_`) + persisted session status `recording → recoverable` (+ atomic
finalize promote to user-sample stores). UI adds armed (track selected) and
saving.

**Guards that exist (strong):** double-start (state + `startInFlight` +
start-token invalidation on cancel), double-stop (shared `finishPromise`),
chunk sequence strictness (worklet ack only after the IndexedDB commit),
repo-side append aborts on status/sequence mismatch, cross-tab recovery
`markRecoverable` BEFORE reading (a still-open source tab cannot extend the
take; its next append aborts → self-stop), per-tab `ownerId` exclusion,
`pruneAncient` 30-day GC, quota typed as `RecordingStorageQuotaError`.

**Unsafe transitions — verdicts:**

| #   | Finding                                                                                                                                                                                            | Verdict                                                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Unmount while `stopRec` finalizes: the continuation (finalize → clip command → UI state) had no post-await mount/closed gate; via P1 the clip command could re-point the shared engine post-close. | **FIXED (GOAL 04) at the root** — P1's `onDocChanged` closed-guard kills the engine/debouncer effect of any late tail; the UI-local state writes are React no-ops after unmount. |
| R2  | Cross-tab recovery can kill a frozen-but-alive take after 5 s without a committed block (`RECOVERY_STALE_MS`).                                                                                     | **RECORDED** — deliberate staleness policy; last ≤0.5 s chunk lost, source self-stops with clear messaging.                                                                      |
| R3  | Error during `starting` + UI stop race leaves a mic graph + session row briefly alive; self-heals via the late-resolution guard + per-attempt pending ref.                                         | **RECORDED** — self-healing, bounded window.                                                                                                                                     |
| R4  | `onError` assigned after `start()` is invoked → a synchronous first-slice error surfaces only via the 8 s ready timeout (slow-fail, no data loss).                                                 | **RECORDED** — assign-before-start would be a one-line reorder in the UI driver; queued for the next ArrangementPanel touch.                                                     |
| R5  | HumToMelody teardown nulls `recRef` before `stop()` completes → un-cancellable analyzing stop; take ends recoverable.                                                                              | **RECORDED** — recovery path exists; queued with R4.                                                                                                                             |

**Failure/recovery:** mic disconnect/context loss → self-stop →
`markRecoverable` (committed blocks recoverable, tail may be incomplete);
crash → next session's 3 s recovery poll; finalize failure leaves the take
staged for retry.

## 5. Autosave / save lifecycle (`autosave-debouncer`, `save-lifecycle`, services)

**States:** `saved | dirty | saving | error` (+ `syncing` for collab stores).
Revision captured at save-call time; a doc change mid-write re-queues
(never reports a stale revision saved). Flush coalesces concurrent flushers
through one shared promise chain; unload guards are idempotent per target.

**Unsafe transitions — verdicts:**

| #   | Finding                                                                                                                       | Verdict                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| A1  | Write-after-close re-arm — same class as P1.                                                                                  | **FIXED (GOAL 04)** via P1.                                                                                                   |
| A2  | `pagehide` cannot await IndexedDB; iOS Safari lacks `beforeunload` → last ≤800 ms edit (≤5 s under gesture) lost on tab kill. | **RECORDED** — inherent platform limit, documented in-file.                                                                   |
| A3  | Collab peers autosave full projections last-writer-wins (a lagging peer can overwrite a newer save).                          | **RECORDED** — recovery via snapshots + CRDT room state; versioned saves are a persistence-format change (GOAL 05 territory). |

## 6. Collab session (`CollabSession`, `YDocStore`, `CollaborationProvider`)

**States:** detached → connecting (pre-first-sync command buffering, ≤200)
→ first-sync decision (hydrate empty room | adopt remote with pre-adopt
local snapshot) → ready → disposed → detached. `switchingRef` guards
overlapping project swaps; `ProjectStore ↔ YDocStore` never coexist (full
services replacement).

**Unsafe transitions — verdicts:**

| #   | Finding                                                                                                                                         | Verdict                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| C1  | Follower remote seek left the scheduler window stale (transport machine T2).                                                                    | **FIXED (GOAL 04)** — see T2.                                                                                      |
| C2  | `openProject` failure mid-swap leaves the app with guards uninstalled (no pagehide flush / unload warning) on the half-closed services object.  | **RECORDED** — needs a restore-path design (re-open previous store or reinstall guards); queued as its own change. |
| C3  | Relay-down ≥8 s → each waiting tab self-seeds → two diverged initial docs merge on relay return (converges, content interleaves unpredictably). | **RECORDED** — documented degradation; a room-generation token is the future fix.                                  |
| C4  | `executeBuffered` throw = partial Y.Doc mutation, no rollback (yjs has no transactions) — already broadcast.                                    | **RECORDED** — inherent to CRDT; commands are validated before execute.                                            |

## 7. Export pipeline (`ExportPanel` + `renderer` + encoders)

**States:** `idle | busy(label) | done | error` per export; abort via one
`AbortController` checked at 4 pre-render points, per-chunk in MP3/video,
per-stem in stems. Live engine is untouched (new OfflineAudioContext + new
throwaway engine; shared bank attached/detached).

**Unsafe transitions — verdicts:**

| #   | Finding                                                                                                                                                                                 | Verdict                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| E1  | Abort (or any throw) between `attachBank` and the `try { startRendering }` leaked the throwaway engine's bank subscription into the SHARED bank (retention grows per cancelled export). | **FIXED (GOAL 04)** — the last abort window moved inside the try/finally that detaches.                        |
| E2  | `abortRef` clobber on overlapping exports (double-click before React re-render): CANCEL aborts only the newest run.                                                                     | **RECORDED** — `disabled={busy}` covers normal use; a token counter is the fix when programmatic export lands. |
| E3  | Exports capture the doc once (snapshot semantics) — mid-export edits excluded.                                                                                                          | **RECORDED** — intended ("export = snapshot").                                                                 |

## 8. AudioEngine project queue (setProject, `src/audio-engine/AudioEngine.ts`)

**States:** idle / body-settling (`projectPromise`) with a 1-slot coalescing
queue (latest doc wins). `this.doc` assignment is synchronous (renderer/UI
read it immediately); bodies are fully synchronous today and drain FIFO with
coalescing.

**Unsafe transitions — verdicts:**

| #   | Finding                                                                                                                                                                                                                                                                                                                            | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | **Master glue park defect (handed off by the hardening campaign GOAL 12):** a project switch landing while another body was settling deferred the new doc's master config by a microtask — the native glue fallback kept the stale −6/2 threshold/ratio across the switch (`master-finish.test.ts` failing by design until fixed). | **RESOLVED UPSTREAM (concurrent session, `1361202`)** — probe + test re-authoring established the ENGINE was never wrong: `runBody` is fully synchronous (zero internal awaits), the queue drain applies the latest doc one microtask later, and the racing tests simply asserted before the flush. The tests now flush the deferred drain and pass 3/3 on the unmodified engine; the deferral is documented queue semantics. The handed-off engine-side fixes (a/b/c) are therefore moot — this campaign implemented them, verified the analysis, and REVERTED in favor of the upstream verdict. If a future synchronous reader ever needs the graph settled at setProject return, applying the incoming master config in the coalescing branch is the prepared option; do not add it speculatively. |

---

## Cross-cutting themes

1. **Post-close async tails** — systematically closed at the ROOT (P1) instead of gating every panel continuation; UI-local post-unmount writes are React no-ops.
2. **Single-slot UI guards vs multi-instance recorders** — three panels can each run their own mic recorder; recovery store handles it, a global mic-ownership token would be a UX change (**RECORDED**).
3. **Platform-inherent loss windows** (pagehide, iOS beforeunload) — documented, not fixable in-page.
4. **House stale-guard style**: context-identity guards (`this.ctx !== ctx`) pre-existed; GOAL 04 adds the first doc-identity guards (`this.doc !== target`) and the `closed` gate — future queued operations should follow these two patterns.
