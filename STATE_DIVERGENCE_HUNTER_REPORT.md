# STATE DIVERGENCE HUNTER — KYX / Pulse Forge

**Audit type:** Cross-layer consistency and reliability audit (state authority, synchronization, persistence, audible truth)
**Date:** 2026-10-25
**Repository:** `D:\pulse-forge` — KYX (display name) / Pulse Forge (repo name), `SCHEMA_VERSION = 38`
**Mode:** READ-ONLY. No production code, schema, project asset or user data was modified.
**Deliverable:** this file.

---

## 1. Executive reliability verdict

**The DAW's *authoritative state* is sound. Its *reported state* is not uniformly sound.**

KYX has a genuinely well-disciplined core: exactly one authoritative document, exactly one write path
(commands → store), delta-based undo that cannot revert a concurrent human edit, an atomic IndexedDB
commit, a revision-guarded save path, a typed MCP error taxonomy, and a plugin param write path that
re-reads the committed document and reports `PARTIAL_FAILURE` when the commit does not match the
intent. Those are not incidental; they are defended by named tests. **The user can trust what the
project saves and what the undo stack contains.**

What is *not* uniformly sound is everything that **reports** on that state rather than holding it:

| Surface | Verdict |
|---|---|
| Project document, undo/redo, save/reload | **Trustworthy.** One authority, one write path, atomic save, verified round-trip. |
| MCP refusal + acknowledgement contract | **Mixed — and improving in the working tree.** The new R-02 `verifiedMutation` gate now corrects false *successes* at one dispatch choke point. It does **not** cover two paths: a refusal that is not flagged as an error, and the idempotency replay, which returns before the gate. |
| Export paths | **Divergent from each other.** The master export refuses to render a changed project; the stem and track exports do not check at all and can ship a stale arrangement. |
| Automation / DSP value display | **Divergent.** The knob shows the committed document value while the DSP plays the automated value, with no "under automation" indicator anywhere in the rack. |
| Persistence recovery | **Weakest area.** The unload recovery buffer is a single global slot — a second dirty project overwrites the first's only copy of uncommitted work. |

**The headline risk is not "the DAW loses data on save". It is "the DAW says something that is not
true"** — in three places where a human can be misled about whether work happened: the REC indicator
says "recording" while notes are silently discarded; an MCP refusal is returned as a *success* to any
client that keys on the structured error flag; and a stem export can render the arrangement as it
was before the edit.

**A note on the state of the art.** Partway through this audit another session landed the **R-02
`verifiedMutation` gate** — a surface-wide choke point that corrects a mutating tool's claim against
the document. It is the right architecture and it closes the false-success class for the paths that
flow through it. **This report's findings are therefore best read as the remaining perimeter of
that gate, plus the areas it does not reach at all** (exports, persistence/recovery, automation
semantics, and the DSP display surface). Where this audit and that effort overlap, the coordinate
is deliberate rather than accidental.

**Evidence limits — read before trusting this report.**

1. **The repository's own test suite (1230 test files) was NOT executed.** No `npm run test`,
   no `npm run typecheck`, no `npm run build`. Every claim below is either read from source or
   measured by a purpose-built probe. Where a claim rests only on reading, it is labelled as such.
2. **Two probe harnesses were used; both executed.** `tmp-divergence-probe.mts` (7 sub-probes,
   `vite-node`) and `tmp-probe/f03.test.ts` (5 sub-probes, the repository's own **vitest** harness,
   **5/5 green**). An earlier `vite-node` attempt at the second probe hung for 420 s twice and was
   abandoned; re-implementing it under vitest loaded the same module graph in **8 seconds**. Results
   and raw output are in §5.
3. **The working tree moved under this audit, and it changed a finding.** `src/mcp/tools.ts` was
   edited by another session *while the probes were running* (file mtime 11:36:56; `git diff` grew
   during the session). The change landed the **R-02 `verifiedMutation` gate**, which fixed the
   F-03 false-success. This report reflects the **post-change** state, and §4/F-03 states plainly
   what was true before, what changed, and what is still open. **F-05, F-06 and F-07 were measured
   against the current source and are still open.** Every other finding was read from source; a
   finding outside `src/mcp/tools.ts` may also have been affected by concurrent work and should be
   re-verified before acting.
4. **No audio was listened to.** Audible-truth claims (F-09, F-10, F-11, F-17, F-18, F-19) are
   *structural* claims about what value reaches which DSP node. They are not perceptual claims.
   §10 specifies the listening protocol that would close them.
5. **No browser was driven.** UI-level claims (F-01 staleness, F-02 indicator, F-09 knob) are derived
   from the subscription model and the render-time capture, not from a rendered frame.
6. **Four layer maps were produced by delegated read-only exploration and then independently
   spot-checked.** The parent verified, by direct grep/read, the claims marked *Confirmed* below.
   Claims that survived only the delegated reading are marked *Strongly indicated*. No finding in
   this report is carried on a delegated citation alone.

---

## 2. Observed state architecture

### 2.1 Authority map (code-backed)

| Domain value | Authority | Writers | Consumers | Transition contract | Persistence | Potential drift |
|---|---|---|---|---|---|---|
| Project document (all slices) | `ProjectStore.doc_` (`src/store/ProjectStore.ts:75, 264`) — replaced, never mutated | `store.execute` / `executeUserEdit` only; `replaceDoc` | UI hooks, engine, scheduler, renderer | command → `execute` → identity guard (`:256-263`) → `normalizeProject` (`:264`) → undo push (`:265`) | IndexedDB `projects`, whole doc, one transaction (`src/persistence/ProjectRepository.ts:50-62`) | none at this layer — verified |
| Undo / redo history | `ProjectStore.undoStack` / `redoStack` (`:28-29`) | `applyCommand` (`:265`), `undo`/`redo` | UI history panel, `kyx_undo` | delta snapshot (`src/commands/core.ts:34-45`), history capped at 256 (`:269-273`) | not persisted | undo inside an open frame (F-22) |
| Save status / watermark | `ProjectStore.saveStatus_` / `lastSavedAt_` | `services.doSave` only | TopBar, `kyx_save` | revision-guarded (`src/services.ts:1153, 1173-1179`) | **never persisted** | three notions of "when" (F-15) |
| Unload recovery buffer | `localStorage["kyx:recovery-buffer:v1"]` | `services.onUnload` (sync) | `ProjectBrowser` | one global slot, overwritten unconditionally | localStorage | **single slot (F-04)** |
| Project snapshots | IndexedDB `project-snapshots` | `SnapshotRepository.save` | History panel | separate store | IndexedDB | none found |
| Runtime transport cursor | `Transport`, anchored on the **AudioContext clock** (`src/audio-engine/AudioEngine.ts:545-547` → `src/services.ts:588`) | engine | UI playhead via shared rAF | audio-clock, not wall clock | not persisted | UI playhead freezes in a hidden tab (F-21) |
| Effect parameter (document) | `EffectInstance.params` | commands, MCP, plugin panel | `EffectRack` (`src/ui/EffectRack.tsx:930, 1270`), engine | `syncFxParams` diff-guarded push (`src/audio-engine/AudioEngine.ts:1620-1625`) | with the document | **knob ≠ DSP under automation (F-09)** |
| Effect parameter (runtime) | AudioParam in the graph | `syncFxParams`, automation bridge, macro | DSP only | `setTargetAtTime`, tc 20 ms native / instant worklet | not persisted | macro vs automation conflict (F-11) |
| Track gain | `track.gain` (fader) + `modAutoGain` (automation) + `modMacroGain` (macro) | commands | mixer UI | chain `gain → modAutoGain → modMacroGain` (`AudioEngine.ts:1896-1905`) | with the document | **absolute-vs-multiplicative (F-10)** |
| Automation lane | `doc.automation` points | commands, MCP | engine (runtime only), arrangement lanes | `writeAutomationTargetAt` (`src/audio-engine/automationBridge.ts:1191-1210`) | with the document | points addressed by value (F-07) |
| MCP read model | **none** — tools read `ctx.getDoc()` live | — | all tools | — | — | idempotency ledger replay (F-06) |
| Session checkpoint / A-B | `masterAbStore`, outside the document (`src/mcp/tools.ts:74`) | MCP session | `kyx_master` | not invalidated on document change | not persisted | stale restore (F-08) |

### 2.2 Propagation graph (one intent → one transition → N representations)

```
                    ┌──────────────────────────────────────────────┐
  HUMAN UI ────────►│  src/commands/*  (the ONLY write path)       │
  MCP / AI ─────────►│  every mutation = a Command {execute,undo}  │
  Intent engine ────►│                                              │
                    └───────────────┬──────────────────────────────┘
                                    │  store.execute(cmd)
                                    ▼
                    ┌──────────────────────────────────────────────┐
                    │  ProjectStore.applyCommand                   │
                    │   :257 identity guard  → no-op ⇒ no undo     │
                    │   :264 normalizeProject → clamps             │
                    │   :265 undoStack.push                        │
                    └───────┬───────────────────────┬──────────────┘
                            │ doc_ (replaced)       │ undo delta
                            ▼                       ▼
        ┌───────────────────────────┐   ┌────────────────────────────┐
        │ React (useSyncExternalStore│   │ undo / redo               │
        │  fine-grained slices,      │   │  delta apply              │
        │  structural sharing)       │   └────────────────────────────┘
        │  ⚠ F-01: a slice NOT      │
        │  subscribed to does not   │
        │  re-render the consumer   │
        └───────┬───────────────────┘
                │
                ▼
     ┌────────────────────────────────┐        ┌──────────────────────────┐
     │ engine.setProject(doc)         │───────►│ DSP graph (AudioParams)  │
     │  diff-guarded sync             │        │  native: 20 ms glide     │
     │  ⚠ F-17 bypass ⇒ full rebuild │        │  worklet: instant write  │
     └───────┬────────────────────────┘        └──────────────────────────┘
             │
             ├──► Scheduler (25 ms tick) ──► automationBridge ──► runtime AudioParams
             │                                  ⚠ F-09 lane overrides the doc value
             │                                  ⚠ F-10 lane is multiplicative, authored absolute
             │                                  ⚠ F-11 macro + automation ⇒ same AudioParam
             ▼
     ┌────────────────────────────────┐
     │ renderProject(doc)  (offline)  │──► export / bounce / share
     │  ⚠ F-01 stems/tracks have NO   │
     │  freshness assertion; master   │
     │  DOES (assertMasterSourceCurrent)
     └────────────────────────────────┘
```

### 2.3 Ambiguities left deliberately unresolved (flagged, not presumed)

- **`src/collab/YDocStore.ts`** is a second authority when a project is collaborative. It
  re-projects with `normalize = false` for local-origin edits while `ProjectStore` normalises every
  command → the same command yields a different document shape solo vs collab. Not confirmed
  end-to-end here (**Strongly indicated**, F-16).
- **`src/audio-engine/AudioEngine.ts`** holds `this.doc` — a reference, not a copy — and defers the
  graph sync through `projectPromise`. Document and graph are briefly out of step (sub-frame). This
  is a *sync latency*, not a state divergence, and is not filed as a finding.
- **Three "when did this save" notions** coexist (`doc.updatedAt` in the stored record,
  `lastSavedAt` in the store, the library list's own stamp). See F-15.

---

## 3. Critical invariants

Derived from the product's actual contracts, not imposed. Status reflects this audit's evidence.

| # | Invariant | Contract source | Status |
|---|---|---|---|
| **I-1** | Every mutation flows through the command layer; there is no second write path | `src/commands/*`; grep for direct `doc.<slice> =` in `src/` returns nothing | **Holds** (verified by search) |
| **I-2** | A parameter set by *any* control surface yields the same domain value after normalisation | `src/commands/*` is shared by UI and MCP | **Holds** for the value; **breaks** for the *report* (F-05, F-06, F-07) |
| **I-3** | A committed operation is observable in the engine/DSP path, or reports pending/failure accurately | `syncFxParams` diff-guarded push; MCP `PARTIAL_FAILURE` | **Partially holds** — F-06, F-24 |
| **I-4** | Save/reopen reproduces the arrangement, routing, automation and plugin state | `ProjectRepository.save` = whole doc, one transaction | **Holds** — measured (probe P4: reload reproduces the session doc exactly) |
| **I-5** | Undo/redo restores all logically coupled values | delta snapshot; `src/commands/docDelta.ts` | **Holds** for the measured battery (probe P2/P3) — **except** the frame case (F-22) |
| **I-6** | Automation playback does not overwrite the persistent baseline | `writeDeviceTargetAt` touches runtime only; `automationReset` restores the doc base | **Holds — this defect does NOT exist.** The doc is never written by automation. |
| **I-7** | Export/offline render uses semantically equivalent mix state and processing rules | `renderProject(doc)`; `tests/offline-parity.test.ts` | **Holds for the mix**; **breaks for freshness** (F-01) |
| **I-8** | Removing an entity invalidates stale references cleanly | `deleteTrack` cleans cross-references; `tests/delete-track-undo-cross-references.test.ts` | **Holds** (measured: deleteTrack round-trips) |
| **I-9** | A failed multi-step command leaves no undisclosed partial transition | MCP `PARTIAL_FAILURE` convention | **Holds where implemented**; F-05 shows the convention is not universal |
| **I-10** | Repeated command delivery is idempotent, or non-idempotent with explicit dedup/ordering rules | MCP idempotency ledger (requestId) | **Holds for the ledger**; **breaks for automation points** (F-07) |
| **I-11** | Transient meter/playhead values may lag within a documented bound, and that lag must not corrupt committed state | scheduler tick 25 ms, lookahead 120 ms, smoothing tc 8–20 ms | **Holds** — the lag is bounded and documented; UI playhead freeze in a hidden tab is a *display* issue (F-21) |
| **I-12** | The AI's structured answer agrees with what the document actually contains | MCP ack contract + the R-02 `verifiedMutation` gate | **Holds on the dispatch path** (gate); **breaks** on refusals and on the idempotency replay (F-05, F-06) |

**Deliberately asynchronous contracts (not defects):**

- Scheduler tick 25 ms with a 120 ms lookahead — `src/scheduler/Scheduler.ts:149, 151`.
- `setTargetAtTime` smoothing: 20 ms native FX, 8 ms track gain/pan, 10 ms macro bus. A parameter
  trails its commanded value by ~8–20 ms and settles within ~24–60 ms. This is contract-compliant.
- The offline render path is exact (`setValueAtTime`, not gliding) — `src/effects/registry.ts:206-220`,
  guarded by `tests/offline-effect-params.test.ts`. The live and offline paths are *intentionally*
  different here.
- The engine's graph sync is deferred through `projectPromise` — sub-frame, intentional.

---

## 4. Findings register

Severity: **Critical** (wrong audio / lost work / false success in the common path) ·
**High** · **Medium** · **Low**.
Confidence: **Confirmed** (read the code path that proves it, or measured it) · **Strongly indicated** ·
**Hypothesis** · **Untested**.

**24 findings.** One (F-03) was **resolved in the working tree during this audit** and is retained as
a worked example rather than an open item; 23 remain open. Eleven are **Confirmed** by code reading
that the parent re-verified directly; four of those were additionally **measured** (§5.2). Two are
**Strongly indicated** and are flagged for confirmation (F-16, F-22); one is a **Hypothesis**
(F-23).

---

### F-01 — Stem/track export renders a stale document; the master export refuses the identical situation

**Severity:** High · **Confidence:** Confirmed

- **Affected journey:** Export → Stems / Individual tracks. (Export → Master is correct.)
- **Authoritative state:** `ProjectStore.doc_`.
- **Expected contract:** an export renders the document as it stands at commit time; a source change
  during the export is refused rather than silently shipped.
- **Observed divergence:** `ExportPanel` captures the document **at render time**
  (`src/ui/ExportPanel.tsx:259` — `const doc = services.store.getDoc();`) and subscribes to only
  `markers`, `patterns`, `activePatternId`, `tracks`, `master` (`:252-256`). `normalizeProject`
  preserves object identity for untouched slices, so an edit confined to `arrangement`,
  `automation`, `returns`, `macros`, `lfos` or `scenes` does **not** re-render the panel
  (`src/ui/context.ts:100-103` — `useArrangement()` exists but is not used here) — the captured `doc`
  is the pre-edit document. `exportStems` (`:835-872`) and `exportTracks` (`:874+`) then render
  `buildStemProject(doc, …)` from that stale document with **no freshness assertion whatsoever**.
  The master path in the *same panel* does check: `exportMaster` captures
  `projectRevisionIdFor(doc)` (`:507`) and calls `assertMasterSourceCurrent()` (`:509-518`, invoked
  at `:522, 535, 543, 566, 585, 618, 643, 677, 749`), which compares the live document's identity
  against the captured one and throws *"The project changed during mastering. The stale result was
  discarded; analyze again."* (`:513`).
  `projectRevisionIdFor` is a `WeakMap` keyed on the **document object identity**
  (`src/mastering/report.ts:102-107`) — so it detects *any* mutation, including arrangement edits.
- **Two independent failure windows:**
  1. *Before* the click: an arrangement-only edit leaves the panel un-rendered → the export renders
     the pre-edit arrangement.
  2. *During* the render: the stem render is multi-second and asynchronous; an edit made during it
     is never detected, because `exportStems` never re-reads the store. The master path catches
     exactly this at `:535`.
- **Evidence:** `src/ui/ExportPanel.tsx:252-259, 509-518, 535, 835-872, 874+`;
  `src/ui/context.ts:100-103`; `src/mastering/report.ts:102-107`;
  `src/project-model/schema.ts` — `normalizeProject` returns `state.changed ? state.doc : doc`.
- **Root-cause hypothesis:** the freshness guard was added for the mastering workflow and never
  generalised. The panel's fine-grained subscription set is a *rendering* optimisation that was never
  recognised as also being a *freshness* contract.
- **Smallest safe repair:** capture the document **inside** `exportStems`/`exportTracks`
  (`services.store.getDoc()` at call time, not render time) and apply the same
  `projectRevisionIdFor` freshness assertion before and after each render, reusing the existing
  message. No schema change, no behaviour change for the master path.
- **Regression plan:** mount `ExportPanel`, mutate `doc.arrangement`, click *Export stems*, assert
  the export refuses with the same message the master path uses; and assert a mutation performed
  *during* the render also refuses.

---

### F-02 — The MIDI REC button reads "recording" while the capture path is closed

**Severity:** High · **Confidence:** Confirmed

- **Affected journey:** TopBar ⏺ → stop transport → perform notes.
- **Authoritative state:** `PatternRecorder.state.armed`.
- **Expected contract:** the indicator reflects whether input is actually being captured.
- **Observed divergence:** the TopBar derives its lit state from `armed` alone —
  `src/ui/TopBar.tsx:158` `const recording = recordState.armed;`, rendered at `:613`
  (`btn-record … ${recording ? " armed" : ""}`) and exposed to assistive tech at `:625`
  (`aria-pressed={recording}`). But capture additionally requires the transport to be running and
  the playhead to be past the content start: `src/midi/patternRecorder.ts:131`
  `if (!this.deps.isPlaying()) return null;` — notes performed while stopped are **silently
  discarded** (the code comments say explicitly: *"The hit still sounds (the fire callback is
  separate), it just doesn't stamp the pattern."*). And `onTransportInterrupted`
  (`src/midi/patternRecorder.ts:116-120`) **deliberately keeps `armed` true** across a stop.
- **Consequence:** after pressing STOP, the ⏺ stays lit. The user plays notes, hears them, and
  nothing is captured — no error, no message, no visual change. A take the user believes exists
  does not exist. This is silent loss of an intended recording.
- **Evidence:** `src/ui/TopBar.tsx:158, 613, 625`; `src/midi/patternRecorder.ts:53, 116-120, 131`.
- **Root-cause hypothesis:** one boolean is asked to carry two meanings — *"the user wants to
  record"* and *"input is being captured right now"*. They are not the same state.
- **Smallest safe repair:** split the indicator. Keep `armed` as the user's intent; derive the
  lit "recording" state as `armed && transport.playing && tick >= contentStart`, and expose both.
  Whether to also clear `armed` on interruption is a **product decision** (FL-style DAWs keep the
  arm), so propose the indicator split first — it is behaviour-preserving.
- **Regression plan:** a component test asserting the ⏺ is not in the "recording" state while the
  transport is stopped and `armed` is true.

---

### F-03 — `kyx_tracks op:rename` reported `mutated: true` for a write that changed nothing — **RESOLVED in the working tree during this audit**

**Severity:** High · **Confidence:** Confirmed (code path read at audit start) · **Status: FIXED in the working tree, verified by probe**

> **Read this finding as a worked example of how the audit interacted with a live hardening effort.**
> At the start of this audit the rename branch read:
> ```ts
> ctx.execute(setTrackParams(ctx.getDoc(), ids[0], { name }));
> return { text: `renamed to "${name}"`, mutated: true };
> ```
> `setTrackParams` drops fields equal to the current value and returns an **identity command**
> (`execute: (d) => d`), and `ProjectStore.applyCommand` then hits its identity guard
> (`src/store/ProjectStore.ts:256-263`) — so the document was byte-identical, **no undo entry
> existed**, the project was not even marked dirty, and the AI was nevertheless told
> `mutated: true` and *"renamed to X"*.
>
> **While this audit was running, another session landed a surface-wide fix** — the **R-02
> `verifiedMutation` gate** (`src/mcp/verified-mutation.ts`), applied at the single dispatch choke
> point in `src/mcp/tools.ts`:
> ```ts
> result = verifiedMutation({ before: docBefore, after: ctx.getDoc(),
>                             undoDepthBefore, undoDepthAfter: ctx.undoStackLength(), result });
> ```
> Its own comment states the intent: *"ONE PLACE WHERE A MUTATION BECOMES A CLAIM … a success with
> an identical document is not a success."* The probe (§5.2) confirms it works: the rename now
> returns `mutated: false` and *"nothing changed (the document is identical)"*.
>
> **Two things follow, and both matter more than the original finding:**
> 1. **The gate has two holes**, and both are live — see **F-05** and **F-06**, which the gate does
>    *not* cover. It is a good fix with an incomplete perimeter.
> 2. **This fix lives in the working tree, not on `main`.** It is uncommitted (the audit observed
>    `git diff` on `src/mcp/tools.ts` growing mid-run) and therefore **not yet shipped**. The
>    rename defect was real and observable in every build until this change lands.

- **Affected journey:** AI renames a track to the name it already has.
- **Root-cause hypothesis (now addressed):** the no-op guard existed only in the mixer setters; the
  surface had ~90 mutation sites, each describing what it was *asked* to do, with nothing checking
  that the document backed the claim.
- **The generalisation worth keeping:** the R-02 gate is the right shape — one choke point, applied
  to every handler, using **document identity** (`before !== after`) as the witness. That same
  identity check is what `projectRevisionIdFor` uses in the export path (§F-01), so the codebase
  already has the right primitive in two places that have not been joined up.
- **Residual recommendation:** extend the gate's perimeter (F-05 refusal signalling, F-06 replay)
  and re-use the same identity witness in the export paths (F-01).

---

### F-04 — The unload recovery buffer is a single global slot; a second dirty project destroys the first's only copy

**Severity:** High · **Confidence:** Confirmed

- **Affected journey:** Edit project A → close it dirty → open/close project B dirty → return to A.
- **Authoritative state:** `localStorage["kyx:recovery-buffer:v1"]`.
- **Expected contract:** the recovery buffer protects uncommitted work, per project.
- **Observed divergence:** `RECOVERY_KEY` is a single constant (`src/persistence/recoveryBuffer.ts:25`)
  and `writeRecoveryBuffer` overwrites it unconditionally (`:62` `store.setItem(RECOVERY_KEY, payload)`).
  `clearRecoveryBuffer(projectId)` **is** project-scoped (`:116-126` — it refuses to remove a buffer
  belonging to another project, `:123`), which shows the author knew a buffer can belong to a
  different project than the one being cleared. But the *write* path has no such scoping. The file's
  own comment (`:105`) states: *"`projectId` scopes the clear to ONE project. The buffer holds the
  ONLY copy…"* — and the write path destroys that copy for project A when project B is closed dirty.
- **Second defect on the same path:** quota failure returns `false` (`:65-68`) and the caller
  **ignores the return value** — so for a project large enough to exceed the localStorage quota, the
  buffer simply does not exist and the unload edit is lost with no signal at all.
- **Evidence:** `src/persistence/recoveryBuffer.ts:25, 51-69, 105, 116-126`;
  `src/services.ts` unload handler (return value discarded).
- **Root-cause hypothesis:** the buffer was designed as a single "most recent dirty project"
  convenience slot; the project-scoped *clear* was added later without revisiting the *write*.
- **Smallest safe repair:** key the buffer per project (`kyx:recovery-buffer:v1:<projectId>`), keep a
  small index of pending project ids, and have the unload handler act on the boolean result —
  surfacing a failure rather than dropping it.
- **Regression plan:** a spec that writes a buffer for project A, writes one for project B, and
  asserts A's buffer is still readable; plus a spec asserting a failed write is reported.

---

### F-05 — Refusal signalling is inconsistent across the MCP surface: some refusals are typed errors, others are non-error results

**Severity:** Medium-High · **Confidence:** Confirmed — **measured** (§5.2)

> **This is a hole in the new R-02 gate.** `verifiedMutation` begins with
> `if (result.mutated !== true || result.isError === true) return result;`
> (`src/mcp/verified-mutation.ts:66`). A **refusal** is by definition `mutated: false`, so the gate
> returns immediately and never inspects it. The gate can correct a *false success*; it cannot
> correct a *missing error signal*. The perimeter has to be widened.

- **Affected journey:** any AI call that targets a stale entity.
- **Authoritative state:** the MCP result envelope (`isError`, `errorCode`, `mutated`, `text`).
- **Expected contract:** a refusal is machine-detectable. The repo has a shaped constructor for
  exactly this — `src/mcp/tools.ts:3573-3579`: *"The single shaped constructor for error results —
  every `isError` result carries one"* (`mcpError(code, text)` → `{text, mutated:false, isError:true,
  errorCode}`), and a documented code taxonomy at `:3550-3568`.
- **Observed divergence — measured directly (probe P5):**

  | Tool + stale input | `isError` | `errorCode` | doc changed |
  |---|---|---|---|
  | `kyx_plugin_param` stale `trackId` | `true` | `UNKNOWN_TARGET` | no |
  | `kyx_plugin_param` stale `fxId` | `true` | `UNKNOWN_TARGET` | no |
  | `kyx_plugin_param` unknown `effect` | `true` | `UNKNOWN_TARGET` | no |
  | `kyx_plugin_param` unknown `param` | `true` | `UNKNOWN_TARGET` | no |
  | `kyx_tracks` stale `family` | `true` | `UNKNOWN_TARGET` | no |
  | `kyx_clips` stale `clipId` | `true` | `UNKNOWN_TARGET` | no |
  | `kyx_notes` stale `noteId` | `true` | `UNKNOWN_TARGET` | no |
  | **`kyx_automation` stale `trackId`** | **unset (not an error)** | **none** | no |

  `executeAutomationTool` returns refusals as plain prose: `src/mcp/tools.ts:7863`
  `if (typeof target === "string") return { text: target, mutated: false };` — and every other
  refusal in that handler follows the same shape (`:7864-7869, 7874, 7877-7881, 7897, 7919, 7922,
  7924, 7938, 7952, 7955, 7957, 7970`).
- **Consequence:** the *prose* is honest — *"no track or return with id \"no-such-track\" — list ids
  via kyx_state subject:tracks"* — but the **structured** answer says success. An agent (or a client
  SDK) that keys on `isError` / a status enum reads the refusal as a completed call. Only a model
  that reads the prose catches it. This is the "visibility gap" class in its purest form: internally
  correct, but the user cannot verify the outcome from the contract.
- **Evidence:** probe P5 output (§5); `src/mcp/tools.ts:7863` and the refusal list above;
  `src/mcp/tools.ts:3550-3568, 3573-3579` (the convention that exists).
- **Root-cause hypothesis:** `mcpError` was adopted tool-by-tool rather than enforced at the
  dispatch boundary.
- **Smallest safe repair:** route the automation handler's refusals through
  `mcpError("UNKNOWN_TARGET", …)` / `mcpError("INVALID_ARGUMENTS", …)`. Then add a **meta-test** that
  asserts every mutating tool's refusal path sets `isError` — that prevents the next drift.
- **Regression plan:** the meta-test above, plus per-tool specs asserting `isError` on stale ids.

---

### F-06 — The idempotent replay serves a stale read-back and contradicts itself

**Severity:** Medium · **Confidence:** Confirmed — **measured** (§5.2)

> **This is the second hole in the new R-02 gate, and the more surprising one.**
> The idempotency-replay path returns **before** the gate is applied. In the current
> `src/mcp/tools.ts` the replay returns at **line 4377**; the dispatch happens at **line 4430**;
> and `verifiedMutation` is applied at **line 4457**. The replay never reaches it — which is why
> the probe still measures `mutated: true` and `stage: "replayed"` on a call that changed nothing.
> A choke point only works if every exit path passes through it, and this one does not.

- **Affected journey:** an agent retries a call with the same `requestId` after a human has edited
  the same value.
- **Authoritative state:** the MCP idempotency ledger (`src/mcp/tools.ts:74`).
- **Expected contract:** a replay tells the agent what is true *now*.
- **Observed divergence:** on a repeated `requestId`, the tool returns the **cached result object**
  (`src/mcp/tools.ts:4357-4382`):
  ```ts
  const cached = idempotencyLedger.get(requestId);
  …
  return { ...cached.result,
           text: `idempotent replay — requestId was already applied; nothing re-executed\n${cached.result.text}`,
           replayed: true, stage: "replayed" };
  ```
  The cached result is the *first* call's result, including its read-back (e.g. the gain value at
  that moment). If a human changed the value since, the replay serves the **old number** as a
  fresh-looking answer.
  The response is also internally contradictory: `cached.result.mutated` is spread through
  unchanged, so the replay reports **`mutated: true`** while its own text says *"nothing
  re-executed"*, while the audit log for the same call records `mutated: false`
  (`src/mcp/tools.ts:4368`).
- **Evidence — measured (§5.2):**
  ```
  [F-06] first  text: Drums: gain 0.250 (-12.0 dB) — read-back: track "Drums" gain 0.9 -> 0.25
  [F-06] human set gain to: 0.9
  [F-06] replay text   : idempotent replay — requestId was already applied; nothing re-executed
                        Drums: gain 0.250 (-12.0 dB) — read-back: track "Drums" gain 0.9 -> 0.25
  [F-06] replay mutated: true   replayed: true   stage: "replayed"
  [F-06] gain NOW in doc: 0.9
  [F-06] replay reports gain: 0.250 | document holds 0.9
  ```
  The replay reports **0.250**; the document holds **0.9**. The replay's own text says *"nothing
  re-executed"* while its `mutated` flag says `true`.
  Code: `src/mcp/tools.ts` — replay block `:4357-4382` (returns at `:4377`, text at `:4379`), the
  audit log's `mutated: false` at `:4369`, the ledger write at `:4494`, the dispatch at `:4430`, and
  the gate applied at `:4457`.
- **Root-cause hypothesis:** the ledger was designed to guarantee *exactly-once execution*; it
  returns the cached *response* as well, and the cached response embeds a point-in-time read-back
  that is no longer point-in-time.
- **Smallest safe repair:** on the replay path force `mutated: false`, and either re-read the
  current value for the read-back portion or label the replayed text explicitly as historical
  (*"as of the original call"*).
- **Regression plan:** apply a change, then replay the same `requestId`; assert `mutated === false`
  and that the reported value equals the document's current value.

---

### F-07 — Automation points are addressed by value: an AI undo can delete the human's point, and repeated identical AI writes duplicate points

**Severity:** Medium · **Confidence:** Confirmed — **measured** (§5.2) for the duplication half; the
identity half is Confirmed by code reading only

> **Measured (§5.2):** the identical write duplicated the point and grew the undo stack.
> ```
> [F-07] lane points after #1: 1
> [F-07] lane points after #2: 2
> [F-07] undo stack       : 1 -> 2
> ```
> The R-02 gate does not help here: the document **did** change (a duplicate point is a real
> change), so the gate legitimately keeps `mutated: true` and appends a structural read-back. The
> defect is not in the claim — it is in the *operation*.

- **Affected journey:** AI writes an automation point; human writes a point at the same position;
  AI undoes.
- **Authoritative state:** `doc.automation[].points`.
- **Expected contract:** an undo removes the point it created.
- **Observed divergence:** an automation point carries only `tick` and `value` — **no identity**
  (`src/commands/automation.ts:83-86`). The undo resolves by value:
  ```ts
  const idx = l.points.findIndex((p) => p.tick === point.tick && p.value === point.value);
  ```
  (`src/commands/automation.ts:91-99`) — it removes the **first** match. When the human's point was
  inserted first at the same `(tick, value)`, the AI's undo deletes the *human's* point and leaves
  the AI's own point behind. Because the two are value-identical, the document JSON after the undo
  is indistinguishable from a correct undo — the damage is invisible to any document-level diff.
  Separately, `insertPointSorted` (`src/project-model/automation.ts`) is
  `const next = [...points, point]; next.sort((a, b) => a.tick - b.tick);` — **no de-duplication** —
  so repeated identical `addPoint` calls each add a point and each push an undo entry. The MCP ack
  (`src/mcp/tools.ts` `addPoint` branch) reports only the *last* point at that tick, so the
  duplication shows up only as a rising point count.
- **Evidence:** `src/commands/automation.ts:78-101`; `src/project-model/automation.ts`
  `insertPointSorted`; `src/mcp/tools.ts` `executeAutomationTool` `addPoint` branch.
- **Root-cause hypothesis:** automation points predate the need for identity; every other entity in
  the model (tracks, clips, effects, lanes) has an id.
- **Smallest safe repair (two options, both bounded):**
  - *Cheap, no schema change:* de-duplicate identical `(tick, value)` inserts and make the undo
    remove the **last** match rather than the first.
  - *Correct:* give points a stable `id` — this is a `SCHEMA_VERSION` bump plus a migration, and
    should be scheduled deliberately (see §7).
- **Regression plan:** a spec that adds a human point, adds an identical AI point, undoes, and
  asserts by *object identity* which point survived (a JSON diff cannot see this).

---

### F-08 — A stale ordinal target silently redirects a write to a different entity

**Severity:** Medium · **Confidence:** Confirmed (code path)

- **Affected journey:** AI restores an A/B snapshot after a human deleted the saved effect instance
  and added a different one of the same type.
- **Authoritative state:** `EffectInstance.id`; the A/B snapshot lives *outside* the document
  (`src/mcp/tools.ts:74`, `masterAbStore`) and is never invalidated when the document changes.
- **Expected contract:** a write aimed at a specific instance either hits it or fails.
- **Observed divergence:** the restore resolves the instance by id **with an ordinal fallback**
  (`src/mcp/tools.ts`, `kyx_master` → `op: "ab"` → `restore`):
  ```ts
  const matchingDevices = track.effects.filter((fx) => fx.type === device.type);
  const instance =
    matchingDevices.find((fx) => fx.id === device.fxId) ?? matchingDevices[device.instanceIndex ?? 0];
  ```
  The code comment says *"the per-type occurrence handles recreated IDs"* — but a human who
  **deletes** the saved instance and adds a **different** one of the same type is indistinguishable
  from one who recreated it. The write lands on the wrong instance, and the acknowledgement labels
  it by ordinal (`… #2`), so the AI sees a plausible-looking success on the wrong entity. The
  acknowledgement never discloses that the original instance was gone.
- **Contrast — the stable-id path is correct:** a stale `fxId` elsewhere is a typed `UNKNOWN_TARGET`,
  and an fxId↔instance disagreement is `INVALID_ARGUMENTS`. Only the ordinal form has no staleness
  signal. The same ordinal fallback shape exists in the effect-instance and automation-target
  resolvers.
- **Evidence:** `src/mcp/tools.ts` (`kyx_master` A/B restore); the typed-error contrast at the
  `kyx_plugin_param` resolver (`:10074-10087`).
- **Smallest safe repair:** on the fallback path, say so — *"original instance gone; applied to
  instance #2"* — so the outcome is verifiable. (Removing the fallback entirely would break the
  legitimate "recreated the same effect" case; disclosure is the right minimum.)
- **Regression plan:** delete the saved instance, add a different instance of the same type, run the
  restore, assert the acknowledgement discloses the substitution.

---

### F-09 — The effect knob shows the document value while the DSP plays the automated value, and nothing indicates automation is active

**Severity:** Medium · **Confidence:** Confirmed

- **Affected journey:** any effect parameter under an active automation lane, during playback.
- **Authoritative state:** two of them — `EffectInstance.params` (document) and the runtime
  `AudioParam` (DSP).
- **Expected contract:** the value a control displays is the value in effect (or the difference is
  disclosed).
- **Observed divergence:** the rack reads the **document** — `src/ui/EffectRack.tsx:930` and `:1270`
  `values={fx.params}`. Automation writes the **absolute lane value** into the runtime
  (`src/audio-engine/automationBridge.ts:1209` → `writeDeviceTargetAt` →
  `src/audio-engine/deviceLookup.ts`). The `param.secondary` affordance
  (`src/effects/types.ts:39`, `src/effects/definitions.ts:937, 948`) is computed from the *same*
  document values, so it does not disclose the gap. There is **no "under automation" indicator**
  anywhere in the rack or inspector.
- **Consequence:** during playback the knob reads the committed value, the audio plays the lane
  value, and a manual knob edit is overwritten within one scheduler tick (25 ms) while the knob
  keeps displaying the user's number. The user adjusts a knob and hears nothing change — and sees a
  number that is not what they hear.
- **Evidence:** `src/ui/EffectRack.tsx:930, 1270`; `src/audio-engine/automationBridge.ts:1209`;
  `src/audio-engine/deviceLookup.ts:144-145`; `src/effects/types.ts:39`.
- **Root-cause hypothesis:** the document is treated as the only display source. That is correct for
  a DAW *without* automation, and wrong at exactly the moment automation is running.
- **Smallest safe repair:** add an explicit "AUTO" badge on parameters that have an active lane,
  and show the lane's current value alongside the committed value. This is additive and does not
  touch the DSP path.
- **Regression plan:** a component test that mounts the rack with an active lane and asserts the
  effective value / AUTO indicator; a DSP-level test asserting the runtime value equals the lane
  value.

---

### F-10 — Track-gain automation is authored in an absolute domain but applied multiplicatively

**Severity:** Medium · **Confidence:** Strongly indicated (code path read; needs a product decision)

- **Affected journey:** a track-gain automation lane with a fader that is not at unity.
- **Authoritative state:** `doc.automation` lane value vs. `track.gain` (fader).
- **Expected contract:** the lane's displayed value is the gain you hear.
- **Observed divergence:** the lane value is written into `modAutoGain.gain`
  (`src/audio-engine/automationBridge.ts:1199-1203`), and the code comment states the
  **authoritative range is `targetParamDef` (0..1.5)** — an absolute gain domain. But the audio
  chain is `gain` (fader) → `modAutoGain` → `modMacroGain` (`src/audio-engine/AudioEngine.ts:1896-1905`),
  and `modAutoGain.gain.value = 1` — a **multiply** stage. Effective channel gain = fader × lane.
  With the default fader (1.0) the two coincide. With fader 0.8 and a lane point of 0.5, the
  channel plays **0.4** while the lane reads 0.5 and the fader reads 0.8 — *neither* surface shows
  0.4.
- **This is a unit/semantic drift, and it needs a product decision, not a code change:** either the
  lane is absolute (then the graph is wrong and the lane should drive the fader) or the lane is a
  modulation (then the 0..1.5 clamp, the lane UI and the comment are wrong). Note the *return* bus
  path (`:1197-1198`) has the same shape.
- **Evidence:** `src/audio-engine/automationBridge.ts:1194-1208`;
  `src/audio-engine/AudioEngine.ts:1896-1905`; `src/project-model/targets.ts:225`.
- **Smallest safe repair:** decide the semantic first; then either (a) make the lane drive the
  fader's `AudioParam` directly, or (b) rename/relabel the lane as a modulation and document the
  multiplication. Option (b) is documentation-only and safe; option (a) is a behavioural change.
- **Regression plan:** an audio-measurement test: fader 0.8, lane 0.5, assert the rendered channel
  level equals the documented intent (0.4 or 0.5, per the decision).

---

### F-11 — Macro, modulator and automation all write the same effect `AudioParam`; last writer wins

**Severity:** Medium · **Confidence:** Confirmed

- **Affected journey:** a macro mapped to an effect parameter that also has an automation lane.
- **Authoritative state:** one `AudioParam` per device parameter
  (`src/audio-engine/deviceLookup.ts:59-93`).
- **Expected contract:** composed sources sum (or a documented precedence applies).
- **Observed divergence:** the macro path and the automation path both call
  `this.lookup.writeDeviceTargetAt(target, value, when)` with the *same* target shape
  (`{kind:"fxParam", trackId, fxId, paramId}`) — `src/audio-engine/automationBridge.ts:341-342`
  (macro) and `:1209` (automation). The macro writes `base + delta`; the automation writes the
  **absolute** lane value; the modulator writes `base + halfRange·value`. There is no composition.
  During playback the scheduler rewrites the parameter every 25 ms, so the macro's contribution to
  an effect parameter is **silently dropped**. (Track-level gain/pan are different — they have a
  dedicated `modMacro` bus and are not affected.)
- **Evidence:** `src/audio-engine/automationBridge.ts:341-342, 673, 693, 1139-1140, 1209`;
  `src/audio-engine/deviceLookup.ts:59-93`.
- **Root-cause hypothesis:** track-level parameters were given dedicated modulation buses; effect
  parameters were not, and were later given both a macro source and an automation source without a
  composition layer.
- **Smallest safe repair:** define an explicit precedence (automation > macro > modulator) and apply
  it in one place, or give effect parameters the same dedicated modulation bus the track buses have.
- **Regression plan:** a playback test with both a macro and a lane on one effect parameter, asserting
  the documented precedence.

---

### F-12 — Normalisation silently clamps user intent on every command, and the clamps are not reported

**Severity:** Medium · **Confidence:** Confirmed

- **Affected journey:** any command that sets a value outside a normalised range.
- **Authoritative state:** `normalizeProject` (`src/project-model/schema.ts`).
- **Expected contract:** a value the user set is either honoured or the change is disclosed.
- **Observed divergence:** `normalizeProject` runs after **apply, coalesce, undo and redo**
  (`src/store/ProjectStore.ts:236, 264, 381, 414`) — not only on load. It clamps, among others:
  limiter lookahead 1..20 ms and release 10..2000 ms; loudness trim ±12 dB; LUFS target −24..0;
  and **truncates `liveSets` at 32 — the 33rd set is silently dropped**. It also deletes the legacy
  `limiterStereoLink` field and copies it into transient/release links — a v20 migration
  implemented inside a normaliser. `Command.detail` exists precisely for *"silently cleaned something
  up"* (`src/store/ProjectStore.ts:100-104`), but normaliser clamps are **not** routed into it.
- **Evidence:** `src/project-model/schema.ts` (`normalizeProject` and its domain clamps);
  `src/store/ProjectStore.ts:236, 264, 381, 414, 100-104`.
- **Root-cause hypothesis:** the normaliser grew from a load-time repair routine into a
  per-command invariant enforcer, keeping its silent-clamp semantics.
- **Smallest safe repair:** have the normaliser collect what it changed and surface it through
  `Command.detail` (the mechanism already exists).
- **Regression plan:** a spec asserting that an out-of-range set reports the clamp in `detail`.

---

### F-13 — `migrateProject` is not a migration

**Severity:** Medium · **Confidence:** Confirmed

- **Affected journey:** opening a project written by an older build.
- **Authoritative state:** `SCHEMA_VERSION` + `migrateProject`.
- **Expected contract:** a version bump implies version-conditional transformation.
- **Observed divergence:** `migrateProject` accepts any version ≤ `SCHEMA_VERSION`, **never branches
  on the source version**, and only stamps the version and normalises. The entire per-version
  history is a **comment block** (`src/project-model/schema.ts:3534-3589`), starting at v3 — v1/v2
  have no documented provenance. The project log states the intent outright: *"SCHEMA_VERSION
  discriminates nothing today (compatibility = normalizeProject)"*.
- **Why this matters now:** the path is *total* (every version is accepted), so nothing breaks — but
  there is **no version-conditional code to extend** when a real breaking change lands. The first
  genuine breaking change will have nowhere to live except inside the normaliser, where it is
  invisible and unreviewable (this is exactly how the `limiterStereoLink` migration ended up
  embedded in F-12).
- **Evidence:** `src/project-model/schema.ts:3528-3592`; `AGENT_WORK_LOG.md:3477`.
- **Smallest safe repair:** introduce a `MIGRATIONS: Record<number, (doc) => doc>` chain and make
  `migrateProject` walk it. Behaviour-neutral for every version ≤ 38 (the chain is empty), but it
  creates the place where the next breaking change goes.
- **Regression plan:** a spec asserting that migrating from every version ≤ `SCHEMA_VERSION` yields a
  document equal to `normalizeProject` of the same input (the current behaviour, locked in).

---

### F-14 — Recovery writes an unvalidated, un-migrated document into the project store

**Severity:** Medium · **Confidence:** Confirmed

- **Affected journey:** close the app dirty → reopen → accept the recovery banner.
- **Authoritative state:** the recovered `ProjectDocument`.
- **Expected contract:** a recovered document is validated and migrated before it is trusted.
- **Observed divergence:** the recovery path casts without validating —
  `const doc = buffer.doc as ProjectDocument` — then writes it straight into the project store and
  enters the studio with it (`src/ui/ProjectBrowser.tsx:392-399`). `ProjectRepository.save`
  performs **no shape validation and no migration** (`src/persistence/ProjectRepository.ts:50-62`);
  migration runs only on load (`:69`). Consequently: (a) the recovered in-memory document keeps its
  old `schemaVersion` and that stale version is written back to disk verbatim; (b) a buffer that
  passes the reader's shallow check but is structurally broken is written into the `projects` store
  and then becomes **invisible** — `listAll` skips records failing `validateProjectShape`
  (`ProjectRepository.ts:96-98`) and `listIncompatible` only lists `schemaVersion > SCHEMA_VERSION`
  (`:106-113`). The user is told *"Recovered"*; the project is gone at the next boot.
- **Evidence:** `src/ui/ProjectBrowser.tsx:392-399`; `src/persistence/ProjectRepository.ts:50-62,
  69, 96-98, 106-113`; `src/persistence/recoveryBuffer.ts:95`.
- **Smallest safe repair:** run the recovered document through `validateProjectShape` +
  `migrateProject` before `repo.save`, and surface a failure to the user instead of claiming a
  recovery that did not happen.
- **Regression plan:** a spec that feeds a structurally broken buffer and asserts the recovery is
  refused with a message, and that the project list still shows the project.

---

### F-15 — Three different notions of "when did this save"

**Severity:** Low-Medium · **Confidence:** Confirmed

- **Affected journey:** reading a timestamp from the app vs. from the library vs. from an exported
  report.
- **Observed divergence:** `ProjectRepository.save` stamps `updatedAt` on a **shallow copy**
  (`src/persistence/ProjectRepository.ts:52`) — the in-memory document keeps the previous value.
  `setSaveStatus("saved")` stamps a *separate* `lastSavedAt_` (`src/store/ProjectStore.ts:178`).
  The library list shows the stored `updatedAt`; the TopBar shows `lastSavedAt`; anything reading
  `doc.updatedAt` from the live document (export reports, share payloads) sees the **previous
  save's** timestamp.
- **Class:** unit/semantic drift — the same concept, three representations, no single owner.
- **Smallest safe repair:** make the store's `lastSavedAt` the single in-memory authority and have
  the repository stamp the same value, rather than each deriving its own.
- **Regression plan:** a spec asserting the three timestamps agree after a save.

---

### F-16 — Collab local edits skip normalisation (solo ≠ collab document shape)

**Severity:** Low-Medium · **Confidence:** Strongly indicated (not confirmed end-to-end)

- **Observed divergence:** `YDocStore` re-projects with `normalize = false` for local-origin edits
  (`src/collab/YDocStore.ts:139-143`), while `ProjectStore` normalises after every command
  (`src/store/ProjectStore.ts:264`). The same command therefore yields a different document shape
  solo vs collab. `exportProject` writes the raw document; `importProject` validates and migrates
  (`src/export/project-io.ts:75-83`) — so a collab-exported project re-imports as a *different*
  project.
- **Not confirmed** because the Yjs projection path was not traced end-to-end in this audit. The
  normalisation asymmetry itself was read directly.
- **Smallest safe repair:** normalise on the collab local-origin path too, or normalise at the
  export boundary (which fixes the export asymmetry regardless).

---

### F-17 — Bypass is a structural removal, so un-bypass restarts the processor cold

**Severity:** Low · **Confidence:** Confirmed

- **Affected journey:** toggle bypass on a reverb/delay/compressor during playback.
- **Observed divergence:** `fxSignature` filters bypassed effects *out*
  (`src/audio-engine/AudioEngine.ts:1190-1199`), so toggling bypass changes the signature and
  triggers a **full chain rebuild** (`:1976-1981`) which disposes every runtime in the chain
  (`:1364-1373`). There is no node-level bypass gain. Reverb/delay tails, compressor envelope
  followers and filter memory are lost: the UI says ACTIVE while the DSP is a fresh processor. In a
  live context the old chain also crossfades out over 20 ms (`:1201-1214`), so a bypassed effect
  stays audible for 20 ms after the toggle.
- **Smallest safe repair:** a per-node bypass gain (crossfade to silence) rather than removing the
  node from the graph — a DSP change, so it needs its own ADR and a listening protocol (§10).

---

### F-18 — The worklet-unavailable fallback is a 1:1 bypass while the UI shows the full parameter surface

**Severity:** Low · **Confidence:** Confirmed

- **Observed divergence:** `bypassRuntime` is a transparent passthrough that **ignores every**
  `setParameter` (`src/effects/registry.ts:343-358`); several effect types return it when the module
  has not landed (`:1092-1093, 1110-1111`). The rack does surface a badge, but only via a 60 ms poll
  (`src/ui/EffectRack.tsx:239-249`). The knobs still read the document (`src/ui/EffectRack.tsx:755,
  778`), so the user sees a parameter set that has no effect on the audio.
- **Smallest safe repair:** when the runtime is a passthrough, disable the knobs and say so in the
  control itself rather than in a polled badge.

---

### F-19 — The native compressor fallback ignores two documented parameters

**Severity:** Low · **Confidence:** Confirmed

- **Observed divergence:** `src/effects/registry.ts:979-981` —
  `case "detector": case "scHpf": break; // no native equivalent — parameter stays stored`.
  The worklet path honours them (`:949`). The UI shows DETECTOR and SC HPF knobs
  (`src/effects/definitions.ts:809, 819`) that do nothing until the module loads.
- **Smallest safe repair:** hide or disable the two knobs when the native fallback is active.

---

### F-20 — Unit conversions are duplicated across owners

**Severity:** Low · **Confidence:** Confirmed

- **Observed divergence:** dB→linear exists twice — `src/effects/scale-bridges.ts:32`
  `dbToLinearGain` vs `src/effects/registry.ts:161` `dbToLin` (used 13× across
  `registry.ts:873-3212`). Two of four registered percent-100 bridges are hardcoded inline:
  `SCALE_BRIDGES` declares `ozvena.global.dryWet` and `morphdynamics.global.mix` →
  `mix01ToPercent100` (`scale-bridges.ts:75-84`), but `ozvenaNode.ts:143, 211, 221` and
  `morphDynamicsNode.ts:23, 91, 101` hardcode `v * 100`. `fxeqNode.ts:31` and `ultinaNode.ts:27`
  correctly use the shared helper.
- **Class:** duplication — numerically identical today, a drift risk tomorrow.
- **Smallest safe repair:** a spec asserting every `SCALE_BRIDGES` entry's function is the one the
  corresponding node actually calls (this would fail today for ozvena and morphdynamics), then
  delete the inline copies.

---

### F-21 — The UI playhead freezes in a hidden tab while the audio continues

**Severity:** Low · **Confidence:** Confirmed

- **Observed divergence:** the playhead is polled through `requestAnimationFrame`
  (`src/services/rafLoop.ts:21`, `src/ui/playhead.ts:78-85`). A hidden tab stops rAF entirely, and
  the visibility handler pauses generative output but **not** the transport
  (`src/services.ts:1284-1289`). The ruler therefore shows a stale position until the tab is shown
  again, while the audio plays on.
- **Class:** stale read / missing invalidation — display only; no committed state is affected.
- **Smallest safe repair:** on `visibilitychange`, resynchronise the playhead from the transport
  clock (which is authoritative and audio-clock driven) rather than waiting for the next frame.

---

### F-22 — Undo inside an open undo frame can resurrect the undone command

**Severity:** Low · **Confidence:** Strongly indicated

- **Observed divergence:** `ProjectStore.undo()` never consults `frameCommands`, while
  `endUndoFrame()` builds the compound command from `frameCommands`, which still contains the
  undone command. `jumpTo` seals the frame first (`src/store/ProjectStore.ts:432`) — the codebase
  knows this hazard — but `undo()` does not. With ≥3 commands in a frame and one undo, the
  compound's `execute` re-applies the undone command on redo and its `undo` applies that command's
  undo twice.
- **Not confirmed** by execution: no test covers undo-inside-a-frame
  (`tests/commands-edge-cases.test.ts:194-218` covers the happy path only).
- **Smallest safe repair:** have `undo()` seal or reconcile the open frame, exactly as `jumpTo`
  does.

---

### F-23 — The onset cache is keyed by buffer id, not by content

**Severity:** Low · **Confidence:** Hypothesis (currently unreachable)

- `getWarpOnsets` keys on `warpOnsetKey(bufferId, sourceChannel)`
  (`src/ui/ArrangementPanel.tsx:285`) and caches indefinitely with a FIFO cap (`:299-303`). If a
  buffer's *content* were replaced under an existing id, the drawn onset dots would go stale.
- No producer currently reuses an id with new content (`recordedTakeSampleId` is per-session), so
  this is a landmine rather than a live defect. The async result *is* correctly guarded against
  out-of-order overwrite by a `live` flag in the effect cleanup (`:7008-7019`).

---

### F-24 — `kyx_automation` computes its acknowledgement from a local pre-commit chain, never re-reading the committed document

**Severity:** Low · **Confidence:** Confirmed

- **Observed divergence:** the `addPoint` branch computes `next` locally, commits it with
  `ctx.execute(snapshot(…, doc, next))`, and then reports `landed.value` plus a clamp note derived
  from the **local** `next` — it never compares the committed document with its local chain. The
  dominant convention in this file is to re-read and emit `PARTIAL_FAILURE` on mismatch; this
  handler does not.
- **Consequence:** if the store's normalisation clamps further than the command did, the reported
  value differs from the stored value, and the tool cannot detect it.
- **Smallest safe repair:** re-read the committed document after `ctx.execute` and compare, as the
  `kyx_plugin_param` handler does.

---

### 4.1 Divergence scenario matrix

The scenario catalogue from the mission brief, each traced request-to-effect. **Observed** means the
divergence was measured or read directly; **Untested** means the scenario is supported by the
product but no probe or test in this audit exercised it.

#### A. Human / AI contention

| Scenario | Trigger | Expected invariant | Observed / untested | Evidence | Risk | Proposed test |
|---|---|---|---|---|---|---|
| Human moves a plugin slider while the AI issues a parameter update | both target the same `fxId` | the later write wins; both writers see the same document | **Observed** — last-write-wins, no version, no conflict signal; the AI's read-back is truthful but the human gets no notice | `src/store/ProjectStore.ts` (no revision counter); `src/project-model/types.ts:1444` (`updatedAt` only) | medium | apply an AI write, assert the human's UI re-reads the new value and that the AI's ack carries the value that actually landed |
| Two intents target the same track/clip using stale IDs | the human deleted the clip; the AI holds the old id | a typed, machine-detectable refusal | **Observed** — mostly typed (`UNKNOWN_TARGET`) and correct; **but** the ordinal fallbacks redirect the write instead of refusing | `src/mcp/tools.ts` — typed path at `:10074-10087`; ordinal fallback in the A/B restore and the instance resolvers | high (F-08) | delete the saved instance, add a different one of the same type, assert the restore refuses or discloses the substitution |
| A command acknowledges before the queued audio update is applied | a parameter write returns while the scheduler has not yet run | the ack says "pending", or the audio catches up within a documented bound | **Observed, contract-compliant** — the lag is bounded and documented (scheduler tick 25 ms, smoothing 8–20 ms) | `src/scheduler/Scheduler.ts:149`; `src/audio-engine/automationBridge.ts:1198-1203` | low — *not a defect* | assert the applied value reaches 95 % of the commanded value within 3 × tc |
| Tool output claims success though the command failed or was rejected | an AI call on a stale target | `isError` + a typed code | **Observed — diverges.** `kyx_automation` returns a refusal as a **non-error** result | `src/mcp/tools.ts:7863`; measured §5.2 | high (F-05) | the meta-test: every mutating tool's refusal sets `isError` and a code from the taxonomy |
| A human edits between an AI's call and its retry (same `requestId`) | the AI retries a timed-out call | the retry reports the document's current value | **Observed — diverges.** The replay serves the *first* call's read-back | `src/mcp/tools.ts:4377` (returns) vs `:4457` (the gate); measured §5.2 | high (F-06) | edit, retry the same `requestId`, assert the reported value equals the document's current value |

#### B. Editing and history

| Scenario | Trigger | Expected invariant | Observed / untested | Evidence | Risk | Proposed test |
|---|---|---|---|---|---|---|
| Trim / move / fade followed by undo/redo during playback | the gesture is committed while the transport runs | undo restores every coupled value; the audio follows | **Observed** — the delta round-trip is exact; the engine resyncs on the doc change | probe P2/P3 (4 shapes, 0 fallbacks); `src/commands/docDelta.ts` | low | extend the battery to entity reordering and instrument creation (the 2 shapes this audit could not measure) |
| Rapid consecutive changes coalesced in history, only partially restored | a drag gesture coalesces within the window | the coalesced entry restores the pre-gesture state | **Observed** — the coalesce branch keeps the original before-snapshot | `src/store/ProjectStore.ts:225-252` | low | coalesce a gesture, undo once, assert the pre-gesture state |
| Drag preview cancelled or interrupted, leaving domain state modified | the pointer is released outside the target | the domain is untouched | **Untested** — not exercised by this audit | `src/ui/ArrangementPanel.tsx` | medium | cancel a drag mid-flight and assert the document is byte-identical |
| Track/clip removal while dependent selections or automation references remain | the human deletes a track that has lanes | the references are invalidated cleanly | **Observed** — `deleteTrack` cleans cross-references; the undo round-trips | probe P2 (`deleteTrack`); `tests/delete-track-undo-cross-references.test.ts` | low | — |
| Undo while a previous write or background load is in flight | undo during an open undo frame | the undone command is not resurrected on redo | **Untested / Strongly indicated** — `undo()` never consults `frameCommands` | `src/store/ProjectStore.ts:333-364, 366-409, 432` | medium (F-22) | build a ≥3-command frame, undo inside it, redo, assert the undone command does not return |

#### C. Audio engine and plugin synchronization

| Scenario | Trigger | Expected invariant | Observed / untested | Evidence | Risk | Proposed test |
|---|---|---|---|---|---|---|
| Bypass toggled in the UI but not in the DSP | the user clicks bypass | the effect is audibly bypassed | **Observed — diverges in kind.** Bypass is a *structural* removal: the chain rebuilds, so processor state (tails, envelope, filter memory) is lost and the UI says ACTIVE | `src/audio-engine/AudioEngine.ts:1190-1199, 1976-1981, 1364-1373` | medium (F-17) | toggle bypass on a reverb with a long tail; assert the tail survives (listening) |
| Parameter unit mapping mismatch (0–1 vs dB/Hz/ms/%) | the doc stores a normalized value, the DSP wants a native one | the same intent yields the same sound on every surface | **Observed — two separate owners** for dB→linear, and percent-100 bridges hardcoded in 2 of 4 registered pairs | `src/effects/scale-bridges.ts:32, 75-84` vs `src/effects/registry.ts:161`; `ozvenaNode.ts:143`; `morphDynamicsNode.ts:23` | low today, **high if one is edited** (F-20) | assert every `SCALE_BRIDGES` entry is the function the node actually calls (fails today for ozvena + morphdynamics) |
| A plugin preset restores UI fields but misses runtime processor values | a preset is applied | the processor holds what the UI shows | **Observed — one candidate left open**: the parameter cache is seeded from the document and only pushes *differences*, so a factory that does not apply every parameter would leave it permanently unsent | `src/audio-engine/AudioEngine.ts:1519, 1620-1625` | medium — **not confirmed**; the shipped factories read appear to apply the full set | for every effect type, assert the runtime holds every document parameter after a rebuild |
| Reordered effects change the render but the visual order stays stale | the user drags an effect in the chain | the graph order and the visual order agree | **Observed — contract-compliant.** Doc order → signature → rebuild → serial connect | `src/audio-engine/AudioEngine.ts:1420, 1516-1517`; `src/commands/effectParams.ts:326-344` | low | — |
| The audio thread reads unsafe mutable state | a param change during a render quantum | no torn multi-field transitions | **Observed — clean.** No I/O, logging or unbounded allocation in a processor callback; change-gated `postMessage` | `src/audio-worklets/*`; `src/effects/fxeq-core/**` | low | — |

#### D. Playback, recording and automation

| Scenario | Trigger | Expected invariant | Observed / untested | Evidence | Risk | Proposed test |
|---|---|---|---|---|---|---|
| Transport state / playhead differs from the engine state | the tab is hidden | the UI reflects the audio clock | **Observed — diverges (display only).** rAF stops in a hidden tab; the transport does not | `src/services/rafLoop.ts:21`; `src/ui/playhead.ts:78-85`; `src/services.ts:1284-1289` | low (F-21) | hide the tab, return, assert the playhead resyncs from the transport clock |
| Automation lane values disagree with the applied DSP values under playback | a lane is active | the knob shows what is playing | **Observed — diverges.** The knob reads the document; the DSP plays the lane; no "under automation" cue exists | `src/ui/EffectRack.tsx:930, 1270` vs `src/audio-engine/automationBridge.ts:1209` | high (F-09) | assert the effective-value read model returns the lane value while a lane is active |
| Recording stops unexpectedly while the UI remains armed/recording | a device disconnect, or the transport stops | the indicator reflects reality | **Observed — diverges.** The ⏺ stays lit; `captureTick()` returns `null` while stopped, so notes are silently discarded | `src/ui/TopBar.tsx:158, 613`; `src/midi/patternRecorder.ts:131, 116-120` | high (F-02) | stop the transport, assert the indicator is not in the "recording" state |
| Async waveform/peak generation renders stale metadata as authoritative | a buffer is replaced under the same id | the drawn peaks match the buffer | **Observed — guarded.** The async result is protected by a `live` flag; the *cache key* is content-blind | `src/ui/ArrangementPanel.tsx:285, 299-303, 7008-7019` | low (F-23, Hypothesis) | replace a buffer's content under an existing id and assert the peaks are invalidated |
| Automation playback overwrites the persistent baseline | the transport runs over a lane | the document's value survives playback | **Observed — does NOT diverge.** Automation writes runtime only; `automationReset` restores the doc base | `src/audio-engine/deviceLookup.ts:133-156`; `src/audio-engine/automationBridge.ts:1359-1380`; `tests/scene-packs.test.ts:492` | low — *the classic defect is absent* | — |
| Track-gain lane value vs the gain actually heard | the fader is not at unity | the lane's value is the gain | **Observed — diverges.** The lane is authored absolute but applied multiplicatively | `src/audio-engine/automationBridge.ts:1199-1203` vs `src/audio-engine/AudioEngine.ts:1896-1905` | medium (F-10) | render offline with fader 0.8 + lane 0.5 and measure the channel level; **needs a product decision first** |

#### E. Persistence and recovery

| Scenario | Trigger | Expected invariant | Observed / untested | Evidence | Risk | Proposed test |
|---|---|---|---|---|---|---|
| Save succeeds before all relevant state is serialized | a save is clicked | "saved" means durably written | **Observed — contract-compliant.** The save captures the exact revision, compares identity after the await, and re-queues rather than reporting a stale revision | `src/services.ts:1153, 1173-1179`; `tests/services-save-drain.test.ts` | low | — |
| Autosave captures a partial command transaction | a gesture is in flight | the saved doc is a whole state | **Observed — contract-compliant.** Debounce with a `maxDeferMs` / `maxArms` force-flush | `src/persistence/autosave-debouncer.ts:100-129` | low | — |
| Recovery restores the arrangement but not routing/plugins/automation | the recovery buffer is restored | the same project comes back | **Observed — diverges.** The buffer holds the whole document but it is written **unvalidated and unmigrated**, and a structurally broken buffer becomes invisible in the library | `src/ui/ProjectBrowser.tsx:392-399`; `src/persistence/ProjectRepository.ts:50-62, 69, 96-98, 106-113` | high (F-14) | feed a structurally broken buffer; assert the recovery refuses with a message and the project stays listed |
| A second dirty project destroys the first's only copy | project A closed dirty, then project B closed dirty | A's uncommitted work survives | **Observed — diverges.** One global slot; the write path is unscoped while the clear path is project-scoped | `src/persistence/recoveryBuffer.ts:25, 62, 116-126` | high (F-04) | write a buffer for A, then for B; assert A's buffer is still readable |
| Version migrations silently drop or reinterpret parameters | an old project is opened | the migration is explicit and total | **Observed — diverges in kind.** `migrateProject` never branches on the source version; the history is a comment | `src/project-model/schema.ts:3528-3592` | medium (F-13) | migrate from every version ≤ 38; assert the result equals today's `normalizeProject` of the same input |
| Export uses cached state that diverges from the session | the project changes, then an export runs | the export renders the session | **Observed — diverges.** Stems/tracks capture the document at *render* time and never re-check it; the master path does | `src/ui/ExportPanel.tsx:259, 509-518, 835-872, 874+`; `src/mastering/report.ts:102-107` | **high (F-01)** | edit the arrangement, then export stems; assert the export refuses with the master's message |

#### F. Async and lifecycle hazards

| Scenario | Trigger | Expected invariant | Observed / untested | Evidence | Risk | Proposed test |
|---|---|---|---|---|---|---|
| An old completion overwrites a newer intent | two async results resolve out of order | the newer result wins | **Observed — guarded** for the async onset path (`live` flag) | `src/ui/ArrangementPanel.tsx:7008-7019` | low | — |
| Mounted/unmounted UI subscribers miss updates or recreate stale local copies | a panel mounts while the document changes | the panel reads the current document | **Observed — diverges.** Fine-grained subscriptions mean an edit to an *unsubscribed* slice does not re-render the consumer — which is exactly F-01's mechanism | `src/ui/context.ts:85-138`; `src/project-model/schema.ts` (`normalizeProject` structural sharing) | **high (F-01)** | mount `ExportPanel`, edit `doc.arrangement`, assert the panel's captured document is current |
| Worker restart / IPC interruption / plugin reload | a device is unplugged | the session recovers without lying | **Observed — contract-compliant for recording**: the recorder stops itself on device loss, the group stops every member before invoking `onFailure`, and the UI resets to idle | `src/audio-engine/PcmMicRecorder.ts:703-708, 716-721`; `PcmMicRecorderGroup.ts:245` | low | — |
| Browser refresh with unsaved work | the tab is closed | the work is recoverable | **Observed — diverges.** The synchronous recovery buffer runs before the async flush, but it is one global slot and its quota failure is discarded | `src/persistence/save-lifecycle.ts:86-103`; `src/persistence/recoveryBuffer.ts:65-68` | high (F-04) | assert the unload handler surfaces a failed buffer write |
| Repeated command delivery is non-idempotent without dedup rules | the AI retries an identical automation write | the document does not accumulate duplicates | **Observed — diverges.** The point count and the undo stack both grow | measured §5.2; `src/project-model/automation.ts` (`insertPointSorted`) | medium (F-07) | already measured — assert `lane.points.length` stays 1 and the undo stack does not grow |

---

## 5. Reproduction and test outcomes

### 5.1 Probes executed

| Probe | Harness | Result | What it establishes |
|---|---|---|---|
| `tmp-divergence-probe.mts` (P1–P7) | `vite-node` | **PASS** — executed end-to-end | 7 sub-probes, results below |
| `tmp-probe/f03.test.ts` (F-03, F-05, F-06, F-06b, F-07) | **vitest** (the repo's own harness) | **PASS — 5/5 tests green** | the MCP ack contract, measured |

Commands, from the repository root:

```
node node_modules/vite-node/vite-node.mjs tmp-divergence-probe.mts
node node_modules/vitest/vitest.mjs run --config tmp-probe/vitest.probe.config.ts --reporter=verbose
```

`vite-node` proved unreliable for the second probe — its module graph hung for 420 s twice with no
output — so it was **replaced with the repo's own vitest harness**, which loaded the same graph in
**8 seconds**. The probe lives in `tmp-probe/`, a `tmp-` prefixed directory that the repository's
`vitest.config.ts` **excludes** (`"**/tmp-*/**"`), so it is never collected by a normal full run and
cannot disturb another session's suite. The probe config is invoked explicitly and only by this
audit. Both probe locations are root-anchored `/tmp-*` session scratch and are **gitignored** —
`git status` stays clean of them. They are left in place as re-runnable evidence.

### 5.2 Probe results — `tmp-probe/f03.test.ts` (vitest, 5/5 green)

Measured against a real `ProjectStore` over the `house` template, in the live working tree.

**F-03 — the rename false-success is CORRECTED in the working tree.**
Renaming a track **to the name it already has** now returns:

```
[F-03] text            : nothing changed (the document is identical)
[F-03] mutated         : false
[F-03] document changed: false
[F-03] undo stack      : 0 -> 0
[F-03] VERDICT         : CORRECTED by the R-02 verifiedMutation gate
[F-03] control         : mutated=true  text=renamed to "PROBE_RENAMED" — read-back: renamed track "Drums" -> "PROBE_RENAMED"
```

**F-05 — refusals are still not uniformly machine-detectable.**
```
[F-05] plugin_param  isError: true   code: UNKNOWN_TARGET
[F-05] automation    isError: undefined  code: undefined
[F-05] automation    text   : no track or return with id "no-such-track" — list ids via kyx_state subject:tracks
```

**F-06 — the idempotent replay still serves a stale read-back and contradicts itself.**
```
[F-06] first  text: Drums: gain 0.250 (-12.0 dB) — read-back: track "Drums" gain 0.9 -> 0.25
[F-06] human set gain to: 0.9
[F-06] replay text   : idempotent replay — requestId was already applied; nothing re-executed
                      Drums: gain 0.250 (-12.0 dB) — read-back: track "Drums" gain 0.9 -> 0.25
[F-06] replay mutated: true     replayed: true     stage: "replayed"
[F-06] gain NOW in doc: 0.9
[F-06] replay reports gain: 0.250 | document holds 0.9
```

**F-06b — the replay escapes the new verification gate.** `mutated` stays `true` and `stage` stays
`"replayed"` — the R-02 gate never touched it.

**F-07 — the identical automation write duplicates the point and grows history.**
```
[F-07] call #1 text: Drums · Volume: point 2.1=0.5 — lane 1 pt(s), one undo step — read-back: automation lanes 0 -> 1
[F-07] call #2 text: Drums · Volume: point 2.1=0.5 — lane 2 pt(s), one undo step — read-back: automation points changed
[F-07] lane points after #1: 1
[F-07] lane points after #2: 2
[F-07] undo stack       : 1 -> 2
```


### 5.3 Probe results — `tmp-divergence-probe.mts` (`vite-node`)

**P1 — A/B control equivalence (UI command path vs MCP tool path):**
**SKIPPED** — the `house` template seeds no effect instance, so the effect-parameter comparison had
no target. *Not a pass; not run.* (Re-run against a template that seeds effects, or seed one with
`addEffectToTracks` first.)

**P2/P3 — Undo roundtrip, dev path (verifier ON) vs production path (verifier OFF):**
The `snapshot()` helper in `src/commands/core.ts` verifies its delta in development and **falls back
to a whole-document command** if the delta does not round-trip. In production that verification is
compiled out, so the shipped build runs the delta path unchecked. The probe ran the same battery in
both regimes to see whether they diverge.

| case | dev undo | dev redo | fallbacks | prod undo | prod redo | verdict |
|---|---|---|---|---|---|---|
| `setTrackColor` | true | true | 0 | true | true | same |
| `duplicateTrack` | true | true | 0 | true | true | same |
| `moveTrackAdjacent` | *(threw)* | — | — | — | — | see note |
| `addEffectToTracks` | true | true | 0 | true | true | same |
| `deleteTrack` | true | true | 0 | true | true | same |
| `createInstrumentTrack` | *(threw)* | — | — | — | — | see note |

**Verdict: no divergence detected** — the dev path and the production path agree on every case
that ran, and **zero** delta fallbacks were triggered. This is a **pass** for the measured battery:
the dev-only verifier is not currently masking a delta defect in these shapes.
*Notes:* two cases are reported as `threw` because the probe used guessed command signatures
(`createInstrumentTrack(doc, "synth")`, `moveTrackAdjacent`) that did not match the real API — they
are **not** product failures, and those two shapes remain **untested** by this probe.

**P4 — Save → load roundtrip (what IndexedDB actually stores):**
`doc serialized: 9880 bytes` · `reload reproduces session doc: **YES**` — **PASS**. A `JSON`
round-trip through `normalizeProject` reproduced the session document byte-for-byte after a
mutation.

**P5 — Failure injection (stale ids; is the refusal truthful?):**
All nine probes left the document unchanged (`document unchanged overall by the refusal battery:
**true**`) and all returned honest prose. **But the signalling is inconsistent** — this is the
measured evidence for **F-05**:

| probe | `isError` | `errorCode` | doc changed |
|---|---|---|---|
| plugin_param stale trackId | `isError` | `UNKNOWN_TARGET` | false |
| plugin_param stale fxId | `isError` | `UNKNOWN_TARGET` | false |
| plugin_param stale effect | `isError` | `UNKNOWN_TARGET` | false |
| plugin_param stale param | `isError` | `UNKNOWN_TARGET` | false |
| tracks setGain stale family | `isError` | `UNKNOWN_TARGET` | false |
| **automation stale target** | **`ok` (not an error)** | **none** | false |
| clips stale clipId | `isError` | `UNKNOWN_TARGET` | false |
| notes stale noteId | `isError` | `UNKNOWN_TARGET` | false |
| fx remove absent effect | `isError` | `INVALID_ARGUMENTS` | false |

*(The last row used `op` where the `kyx_fx` handler expects `action` — a probe-side error, not a
product finding. It is noted here because it is a minor **API inconsistency** in the tool surface:
`kyx_fx` reads `action`, most other tools read `op`, and the risk classifier accepts both.)*

**P6 — Idempotency:** **SKIPPED** — no effect instance in the `house` template (same cause as P1).
**Not a pass; not run.**

**P7 — Normalisation drift:** `normalizeProject(store.doc) === store.doc : **YES**` — **PASS**. The
store holds a canonical document; the normaliser is idempotent on it.

### 5.4 Repository suite — NOT EXECUTED

`npm run test` (1230 spec files), `npm run typecheck`, `npm run build` were **not run** in this
session. Consequently:

- this report makes **no claim** that the repository is green;
- any finding that a test already guards would be a **duplicate**, not a discovery — the reader
  should check `docs/AGENT-MAP.md`'s invariant register before acting;
- the "guarded by" test references quoted in this report were read from the **spec source**, not
  from a green run.

### 5.6 Not executed, and why it matters

| Probe | Status | Reason | What it would have settled |
|---|---|---|---|
| P1 A/B control equivalence (effect params) | **Not executed** | no effect instance in the fixture | that UI and MCP produce an identical *document* for the same parameter |
| P6 idempotency (mixer setters) | **Not executed** | same | that a repeated identical MCP write does not grow history |
| F-03 rename false-success | **Executed — and now CORRECTED** | — | the R-02 gate works ✅ |
| F-05 refusal signalling | **Executed — still open** | — | `isError` is absent on the automation refusal ❌ |
| F-06 idempotency replay staleness | **Executed — still open** | — | stale read-back + contradictory `mutated` ❌ |
| F-07 automation duplicate points | **Executed — still open** | — | 1→2 points, 1→2 undo entries ❌ |
| **F-07's other half** — an AI undo deleting the *human's* point | **Not executed** | needs point-**identity** observation, not a JSON diff | the value-addressed undo damage |
| Undo-inside-a-frame resurrection | **Not executed** | needs a ≥3-command frame | F-22 |
| Round-trip: serialize → deserialize → rehydrate engine → compare | **Not executed** | needs an `OfflineAudioContext` harness | the export-vs-session invariant at the *audio* level |
| Audio-truth measurement | **Not executed** | no listening/measurement protocol run | F-09, F-10, F-11, F-17, F-18, F-19 (§10) |

---

## 6. TOP 10 hardening priorities

Ranked by **risk of wrong audio / lost work / false success**, then by probability, scope, fix
effort and regression risk.

| # | Finding | Why this rank | Effort | Regression risk |
|---|---|---|---|---|
| **1** | **F-01** — stem/track export renders a stale document | The only finding that can ship **silently wrong output** to a paying user. The master path already proves the guard is cheap. | S (capture at call time + reuse the existing assertion) | Low |
| **2** | **F-04** — recovery buffer is a single global slot | The buffer is the **only** copy of uncommitted work; the loss is silent and permanent. | S–M (per-project key + honour the write result) | Low |
| **3** | **F-02** — REC indicator lies about capturing | Silent loss of an intended take, with a lit button asserting the opposite. | S (split armed from capturing) | Low |
| **4** | **F-05** — refusals are not machine-detectable | Every future tool inherits the ambiguity; a meta-test makes it permanent. It is also a **hole in the new R-02 gate**, which cannot correct a refusal because a refusal is `mutated: false`. | S + S (one meta-test) | Very low |
| **5** | **F-06** — idempotent replay serves a stale read-back and escapes the R-02 gate | The root cause is now precise (the replay returns **before** the gate), so the fix is small and provable — but until it is fixed, an agent's retry receives a **wrong current value**. | S | Low |
| **6** | **F-09** — knob shows the document value while the DSP plays the automated value | "What you see" ≠ "what you hear" at the most-used control in the app. This is the mission's *audible truth* clause. | M (effective-value read model) | Low–M |
| **7** | **F-07** — automation points addressed by value; identical writes duplicate | Undo can delete the human's point; repeated AI writes duplicate points **and** grow history (measured). | S (cheap variant) / M (id variant) | Low (cheap) / M (id) |
| **8** | **F-14 + F-13** — recovery writes an unvalidated document; `migrateProject` is not a migration | The two together make the *next* breaking change land in the least visible place available — and a recovered project can vanish at the next boot. | S + M | Low |
| **9** | **F-10 + F-11** — absolute-vs-multiplicative gain; macro/automation conflict | The two places where the composed signal path is not what the authoring semantics say. | M + M (behavioural) | **Medium — needs a decision and a listening protocol first** |
| **10** | **F-12** — normalisation silently clamps user intent on every command | A value the user set can be changed without any disclosure; `liveSets` is truncated at 32 and a legacy migration hides inside the normaliser. | S (route clamps into `Command.detail`) | Low |

*(F-03 — the AI false-success on rename — **left this list**: it was fixed in the working tree by the
R-02 `verifiedMutation` gate during this audit, and the probe confirms the fix (§5.2). It is
retained as a worked example in §4 rather than as an open finding. F-15 timestamps, F-16 collab
normalisation parity, F-17 bypass cold restart, F-18/F-19 fallback honesty, F-20 unit duplication,
F-21 playhead freeze, F-22 undo-in-frame, F-23 onset cache, F-24 automation ack — all **below the
top 10**: real, documented, and scheduled for a later wave.)*

---

## 7. TOP 5 systemic state architecture improvements

### S-1 — Close the perimeter of the R-02 `verifiedMutation` gate

**Expected value:** closes F-05, F-06 and F-24, and makes the false-success class *structurally*
impossible rather than per-handler.

**The gate already exists** — `src/mcp/verified-mutation.ts`, applied at the dispatch choke point in
`src/mcp/tools.ts` (~line 4457). It is the right architecture: one place where a mutation becomes a
claim, witnessed by the document's own identity. It is also **uncommitted** — it lives in the
working tree, not on `main`.

**Its perimeter has three gaps, all measured:**

1. **Refusals are invisible to it.** `verifiedMutation` returns early when
   `result.mutated !== true` (`src/mcp/verified-mutation.ts:66`). Every refusal is
   `mutated: false` by construction — so the gate can never correct a refusal that is not flagged
   as an error (**F-05**). **Fix:** extend the gate to classify results into *success* / *refusal* /
   *error*, and require a refusal to carry `isError` + a code from the taxonomy
   (`src/mcp/tools.ts:3550-3568`) — i.e. route the automation handler's refusals through the
   existing `mcpError(...)` constructor, and add a **meta-test** that every mutating tool's refusal
   sets `isError`.
2. **The idempotency replay bypasses it entirely.** The replay returns at `src/mcp/tools.ts:4377`;
   the gate is applied at `:4457`. **Fix:** move the replay inside the dispatch (or apply the gate to
   the replay result as well) — a choke point only works if every exit passes through it
   (**F-06**).
3. **The structural read-back lives in prose, not in the envelope.** When the gate appends a
   read-back, it edits `result.text` only; `result.data` is left untouched when `mutated` did not
   change (`src/mcp/verified-mutation.ts:95`). A client that reads only `data` never sees the
   verification. **Fix:** mirror the read-back into `data` as well (**F-24** covers the same seam
   from the handler side).

**Risk:** low–medium. The gate is new and uncommitted, so changing it is cheap — but it is another
session's work in progress. **Coordinate before editing**; the recommendation here is to widen a
design that is correct, not to replace it.

**Migration:** additive and backward-compatible. The error taxonomy and result envelope shapes stay
exactly as they are; only the *population* of `isError`/`errorCode` grows.

### S-2 — A document revision token every export and render path must assert

**Expected value:** closes F-01 and future variants (bounce, share, sidecar, MCP `kyx_export`).

Shape: promote `projectRevisionIdFor` (currently `src/mastering/report.ts`) into a shared
`assertDocumentCurrent(doc)` helper, and call it at the **start and end of every** render/export
path — stems, tracks, master, bounce, share, MCP export.

**Risk:** low. The mechanism already exists and the master path already uses it.

**Migration:** no schema change; a behaviour change (stems will now refuse on a changed project) —
which is the intended fix, and should be announced as such.

### S-3 — Identity for domain sub-entities that are addressed by value

**Expected value:** closes F-07 and removes a whole class of "wrong entity" defects.

Shape: every entity that can be addressed by position must carry a stable id — automation points
today; effect instances and lane points next.

**Risk:** medium-high — automation points are persisted, so this is a `SCHEMA_VERSION` bump plus a
migration, and migrations are exactly what F-13 says is currently missing. **S-3 and the
`MIGRATIONS` chain from F-13 should land together.**

**Migration:** `SCHEMA_VERSION` 38 → 39; add a `MIGRATIONS` map that assigns ids to existing
points; the normalisation continues to tolerate points without ids until the migration has run.

### S-4 — A single unit/scale ownership layer, and a documented composed signal path

**Expected value:** closes F-10, F-11, F-19 and F-20, and makes F-18 detectable.

Shape: every parameter declares, in one registry: its **domain** (absolute vs modulation), its
**display unit**, its **DSP transform**, and the **signal path** it is composed into. Then:

- every unit conversion has exactly one owner (fold `dbToLin` into `scale-bridges.ts`);
- every `SCALE_BRIDGES` entry is asserted to be the function the node actually calls;
- the track-gain lane's semantic is **decided** and the graph is made to match it;
- effect parameters get the same precedence rule (or the same dedicated modulation bus) that track
  parameters already have.

**Risk:** F-10 and F-11 are **behavioural** changes. They need a decision, an ADR and a listening
protocol (§10) before any code moves.

**Migration:** a documentation + assertion first (no behaviour change), the semantic decision
second, the graph change third.

### S-5 — Separate "the value the user set" from "the value in effect"

**Expected value:** closes F-09 and F-10's display half, and is the general answer to
"the UI shows one state but the DSP plays another".

Shape: an explicit **effective-value read model** — a pure function
`effectiveParamValue(doc, runtimeSnapshot, target)` — that the UI consults instead of reading
`doc.tracks[].effects[].params` directly. It returns the document value when nothing overrides it,
and the overriding value (with a source label: *automation*, *macro*, *modulator*) when something
does. The rack renders the effective value and labels its source.

**Risk:** medium — it is a new read model and a UI migration. But it is **additive**: it does not
change what the DSP does, only what the UI says.

**Migration:** ship the read model first and consume it in one panel (the effect rack), then widen.

---

## 8. Phased safe implementation proposal

Each phase is independently shippable and independently revertible. **No phase changes the DSP
character, the effect algorithms, the automation meaning, the preset format or the project
serialization** — except where explicitly noted (S-3 / F-07, which is a schema change and must be
scheduled with the `MIGRATIONS` chain).

### Phase 0 — Evidence (no code)

Re-run the blocked probes under the repo's own vitest harness instead of `vite-node` (which hung);
add a per-finding reproduction test for each of F-01 … F-08, F-12 … F-15, F-22. Every finding
below is then guarded by a **failing** test before a line is changed.

*Gate:* each of F-01…F-08 has a red test that reproduces it, and the red test fails for the
*stated* reason.

### Phase 1 — The false-success and refusal layer (smallest change, highest trust return)

**F-03 is already done** — the R-02 gate landed in the working tree during this audit (§4/F-03).
This phase **widens its perimeter** rather than building it.

Fix **F-05** (typed refusals for the automation handler + the meta-test that every mutating tool's
refusal sets `isError`), **F-06** (move the idempotency replay inside the gate's perimeter; force
`mutated: false` on a replay and re-read or label the read-back), and **F-24** (mirror the gate's
read-back into `result.data`).

*Gate:* the meta-test is green; F-05's and F-06's reproductions flip from red to green; no MCP
client contract changes; the R-02 gate's own regression spec (`tmp-probe/f03.test.ts`, promoted
into `tests/`) stays green.

### Phase 2 — The export freshness layer

Promote the revision assertion to a shared helper (**S-2**) and apply it to stems, tracks and the
MCP export path. Capture the document **at call time**, not at render time.

*Gate:* F-01's reproduction (edit the arrangement, then export) now refuses with the master's
message; a stem export of an *unchanged* project is byte-identical to before.

### Phase 3 — The persistence layer

**F-04** (per-project recovery key + honour the write result) → **F-14** (validate + migrate on
recovery) → **F-13** (`MIGRATIONS` chain, behaviour-neutral) → **F-15** (one timestamp authority) →
**F-12** (route normaliser clamps into `Command.detail`).

*Gate:* the recovery round-trip is covered end-to-end; migrating from every version ≤ 38 still
yields the same document as today (locked in by a spec); the three timestamps agree.

### Phase 4 — The automation identity layer

**F-07**, cheap variant first (de-duplicate identical `(tick,value)` inserts; undo removes the
*last* match), then the correct variant (**S-3**: stable point ids + the `MIGRATIONS` chain, both
landing in one `SCHEMA_VERSION` bump). Then **F-08** (disclose the ordinal substitution) and
**F-22** (undo seals the open frame).

*Gate:* the identity-based reproduction (object identity, not JSON) passes; projects written by
v38 still open; a round-trip of every project fixture is byte-identical.

### Phase 5 — The audible-truth layer

**S-4** and **S-5**: first the *assertions* (scale registry, unit ownership, composed-path
documentation) with no behaviour change; then the **decision** on the track-gain lane semantic
(ADR required); then the effective-value read model (**S-5**) consumed by the effect rack; then
**F-09**, **F-11**. **F-17** (node-level bypass), **F-18** and **F-19** (fallback honesty) last,
because they are DSP changes.

*Gate:* the audio-truth measurement protocol in §10 passes for every automatable parameter; live
and offline renders remain identical (`tests/offline-parity.test.ts` stays green).

### Phase 6 — The remaining display and consistency items

**F-21** (playhead resync on visibility), **F-20** (delete the duplicated unit helpers), **F-16**
(collab normalisation parity), **F-23** (onset cache content key).

---

## 9. Verification matrix

| Layer / invariant | How to verify | Automated? | Currently covered? |
|---|---|---|---|
| Document authority | No `doc.<slice> =` outside `ProjectStore`; grep | Yes | search only (this audit) |
| Command round-trip (undo/redo) | probe P2/P3 battery, dev vs prod | Yes | partially — `tests/undo-roundtrip-sweep.test.ts`, `tests/doc-delta-*.test.ts` |
| Delta path == dev path | run the battery with the verifier off | Yes | **not covered** — the suite only ever runs the dev path, where the fallback silently repairs a broken delta. This audit measured parity for 4 shapes (P2/P3) and found 0 fallbacks. **2 shapes remain untested.** |
| Save → load round-trip | serialize → deserialize → normalise → compare | Yes | **PASS (measured, P4)**; `tests/persistence/round-trip-integrity.test.ts` |
| Recovery correctness | broken buffer → recovery must refuse | Yes | no — **F-14** |
| Recovery isolation | two dirty projects → both buffers survive | Yes | no — **F-04** |
| Export freshness | edit → export → must refuse | Yes | no — **F-01** |
| Live == offline mix | `renderProject` vs live playback | Yes | `tests/offline-parity.test.ts` ✅ |
| Export == live mix | compare an export with a live capture | Yes | partially — no export-vs-session freshness test (**F-01**) |
| Automation does not mutate the doc | assert `doc` unchanged during playback | Yes | `tests/scene-packs.test.ts:492` ✅ |
| Effect param: doc == DSP | instrument the runtime AudioParam vs `fx.params` | Yes | partially — `tests/param-range-coherence.test.ts`, `tests/fxeq-rack-contract.test.ts` |
| Effect param under automation | assert the *effective* value reaches the DSP | Yes | no — **F-09**, **F-11** |
| Track-gain lane semantics | measure the rendered channel level | Yes (offline) | no — **F-10** |
| MCP ack truthfulness | every mutating tool: does `mutated` match the document? | Yes | **partially ✅** — the R-02 gate covers the dispatch path; **F-06** (the replay) escapes it |
| MCP refusal detectability | every mutating tool: does a refusal set `isError`? | Yes | no — **F-05** (the meta-test is Phase 1) |
| MCP stale-id handling | stale track/fx/clip/note/param ids | Yes | partially ✅ (`UNKNOWN_TARGET` in most handlers) |
| MCP idempotency | repeated `requestId` → one execution, honest flag | Yes | partially ✅ — **F-06** for the flag and the read-back |
| Undo restores coupled values | delete-track cross-reference sweep | Yes | `tests/delete-track-undo-cross-references.test.ts` ✅ |
| Undo inside a frame | undo mid-frame → redo must not resurrect | Yes | no — **F-22** |
| Normalisation disclosure | out-of-range set → `detail` reports the clamp | Yes | no — **F-12** |
| Migration totality | migrate from every version ≤ 38 | Yes | `tests/persistence/schema-evolution.test.ts` (for the current total path) |
| Bypass semantics | toggle bypass → is the processor state preserved? | Yes + **listening** | no — **F-17** |
| Fallback honesty | force the native fallback → do the knobs still claim to work? | Yes | no — **F-18**, **F-19** |
| Record indicator | stop the transport → the ⏺ must not read "recording" | Yes (component) | no — **F-02** |
| UI playhead vs transport | hide the tab → the playhead must resync on return | Yes (component) | no — **F-21** |
| Mirror drift | `npm run verify:mcp-mirrors` | Yes | ✅ `tests/mcp-mirror-sync.test.ts` — *definitions only; handler behaviour is not mirrored* |
| Realtime safety | no I/O or unbounded allocation in an audio callback | Yes (static) | ✅ — this audit found **no** I/O, logging or allocation in a processor callback |

---

## 10. Unknowns and observations requiring listening or manual UI testing

### 10.1 Requires human listening (no automated equality can settle these)

1. **F-10 — track-gain lane semantics.** Measure: fader at 0.8, one lane point at 0.5, render the
   track offline, measure the channel level. If it is −6 dB (0.5), the lane is absolute and the
   graph is wrong. If it is ≈ −8 dB (0.4), the lane is a modulation and the **UI, the clamp and the
   comment** are wrong. **A product decision is required before any code changes.**
2. **F-09 — does the knob lie in practice?** Play an effect with an active lane and move the knob
   by ear: if the knob moves but the sound does not, the gap is user-visible; if the knob is
   already showing the lane value, the finding is cosmetic.
3. **F-11 — macro contribution.** With a macro mapped to an effect parameter that also has a lane,
   listen for whether the macro is audible between lane writes or dropped entirely.
4. **F-17 — bypass cold restart.** On a reverb with a long tail, bypass and un-bypass: does the
   tail survive? Does the compressor's envelope follower reset? Is the 20 ms crossfade audible as a
   click?
5. **F-18 / F-19 — fallback honesty.** With the worklet module unavailable, is the native fallback
   audibly different from the worklet path? A/B the two renders.
6. **The 8–20 ms smoothing difference between native and worklet parameters** (`F-19`/`F-20`
   family) is a click-behaviour difference, not a value difference — only listening can rank it.

### 10.2 Requires manual UI testing (browser-driven)

7. **F-01 — is the Export panel persistently mounted?** The staleness window depends on the dock
   keeping the panel mounted across an arrangement edit. If the dock unmounts inactive panels, the
   *before-click* window shrinks to "edit while the panel is visible"; the *during-render* window
   remains regardless.
8. **F-02 — what does the REC button look like after a stop?** Confirm the lit state persists and
   that no secondary cue contradicts it.
9. **F-09 — is there any "under automation" cue anywhere?** A full sweep of the rack, the inspector
   and the mixer for an automation indicator.
10. **F-21 — the hidden-tab playhead.** Confirm the audio continues while the tab is hidden and the
    ruler is frozen.
11. **The `kyx_fx` `op` vs `action` inconsistency** (measured in P5) — how many published tool
    schemas advertise `op` while the handler reads `action`?

### 10.3 Open questions this audit could not close

12. **The collab normalisation asymmetry (F-16)** was read, not traced end-to-end. Does a
    collab-edited project, exported and re-imported, really differ from the solo equivalent?
13. **Does anything ever write back into the document from the DSP?** The engine→document write-back
    path for plugin parameters (e.g. an in-plugin undo) was reported as a candidate by delegated
    exploration and **not independently verified** here. If it is real, it is a **second writer** and
    deserves its own finding.
14. **How many shipped effect factories apply the full document parameter set?** The engine's
    parameter cache is seeded from the document and only pushes *differences*; a factory that does
    not apply every parameter would leave that parameter permanently unsent. The shipped factories
    read in this audit appear to apply the full set, but the full registry was not exhaustively
    checked.
15. **Is the production delta path exercised by CI at all?** The suite runs the dev path, where the
    fallback repairs a broken delta silently. This audit measured parity for four shapes and found
    zero fallbacks; **two shapes (entity reordering, instrument creation) were not measured** because
    the probe used wrong command signatures. A CI job that runs the battery with the verifier
    disabled would close this permanently.

---

## 11. Appendix — method

- **Read-only.** No production code, schema, project asset or user data was modified. The probe
  files are root-anchored `/tmp-*` session scratch, gitignored, and left in place as re-runnable
  evidence; `tmp-probe/` is a `tmp-` prefixed directory that the repository's own `vitest.config.ts`
  **excludes**, so nothing here is collected by a normal full run. `git status` shows no
  tracked-file change from this audit beyond the report itself.
- **Four layer maps** were produced by delegated read-only exploration (persistence/recovery, MCP/AI
  control surface, engine→DSP projection, automation/transport/recording). Every finding that is
  labelled **Confirmed** in this report was independently re-verified by the parent with a direct
  grep or file read, and the citation was taken from that verification — not from the delegated
  text. Findings that survived only the delegated reading are labelled **Strongly indicated** and
  are flagged for confirmation.
- **Two probe harnesses, both executed.** `vite-node` (`tmp-divergence-probe.mts`, 7 sub-probes) and
  the repository's **vitest** (`tmp-probe/f03.test.ts`, 5 sub-probes, **5/5 green**). An earlier
  `vite-node` attempt at the second probe hung twice and was abandoned rather than reported as a
  pass; re-implementing it under vitest loaded the same module graph in 8 seconds.
- **The working tree moved during the audit.** `src/mcp/tools.ts` was edited by another session
  mid-probe (mtime 11:36:56). The audit therefore **re-measured** rather than trusting its earlier
  reading: F-03 was found to be fixed, F-05/F-06/F-07 were found to still be open, and both
  verdicts are reported (§4/F-03, §5.2). Any finding outside `src/mcp/tools.ts` should be
  re-verified before acting, for the same reason.
- **No test suite, typecheck or build was run** — an explicit evidence limit (§1.4).
- **Line numbers** were re-verified immediately before writing this file. `src/mcp/tools.ts` was
  under concurrent edit by another session during the audit; a small drift is possible. Where a
  citation is load-bearing for a proposed fix, re-verify before editing.
