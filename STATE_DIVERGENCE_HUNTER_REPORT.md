# STATE DIVERGENCE HUNTER — KYX / Pulse Forge

**Audit type:** Cross-layer consistency and reliability audit (state authority, synchronization, persistence, audible truth)
**Date:** 2026-10-25
**Repository:** `D:\pulse-forge` — KYX (display name) / Pulse Forge (repo name), `SCHEMA_VERSION = 38`
**Mode:** READ-ONLY. No production code, schema, project asset or user data was modified.
**Deliverable:** this file.

---

> ## REMEDIATION STATUS — updated 2026-10-27, after the audit was delivered
>
> **The audit body below is unchanged.** It records what the read-only audit
> OBSERVED at that moment, and every finding keeps its original evidence and
> severity. This block says what has been **repaired since**, so the document
> never claims a fix is still open when it is not.
>
> | Finding                                  | Severity     | Status                                                                                                                                                                                                                                                                                                           | Commit                                    |
> | ---------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
> | **F-28** PRISM write-back — canonical id | **Critical** | **FIXED** — the rack↔core id map is now bidirectional and the command canonicalises the id and the value into the document domain                                                                                                                                                                                | `a53a13a6`                                |
> | **F-29** automation-point undo           | High         | **FIXED** — the undo verifies the slot before splicing, then re-anchors by identity                                                                                                                                                                                                                              | `9c016d92`                                |
> | **F-25** stale AI write                  | High         | **FIXED** — per-field compare-and-swap: the write is REFUSED with a named conflict instead of overwriting the human's value                                                                                                                                                                                      | `5267cb2f`                                |
> | **F-01** stale export                    | High         | **FIXED** — the stem and track exports capture the document at call time and assert it before and after each render                                                                                                                                                                                              | `c0de98ae`                                |
> | **F-10** track-gain lane                 | Medium       | **FIXED (display)** — the lane says it is a multiplier and draws the unity line; the mixer now shows the **composed** channel gain (fader × lane)                                                                                                                                                                | `6452dadd`, `ca104349`                    |
> | **F-06** idempotent replay               | Medium       | **FIXED** — the replay keeps its pinned original outcome and gains a sibling `current` field carrying what moved; the R-02 gate is replay-aware                                                                                                                                                                  | `c050b03f` (partly carried by `4d7bf750`) |
> | **F-16** collab normalisation            | High         | **FIXED** — local collab writes are normalised in the CRDT; the general contract is pinned by a test on a second domain                                                                                                                                                                                          | `04c41290` (parallel session), `faba6885` |
> | **F-09** effect knob vs. the DSP         | Medium       | **FIXED** — the rack discloses the value IN EFFECT: an AUTO badge on the knobs a lane drives, and the lane's value beside the committed one                                                                                                                                                                      | `3d59627e`                                |
> | **F-11** macro / modulator / lane        | Medium       | **FIXED** — one write gate with an explicit precedence (automation > modulator > macro > MIDI CC); the UI names the owner of a parameter the macro cannot win. **Code-verified, not listening-verified** (§10's perceptual check was not executed — jsdom has no `OfflineAudioContext`)                          | `64e71cd3` · ADR 0067                     |
> | **F-18** fallback runtime vs. the knobs  | Low          | **FIXED** — the controls themselves disclose the 1:1 passthrough (the engine's own reason, in the flagship panels' words), and the device chip says PASSTHROUGH instead of ACTIVE                                                                                                                                | `361fb5b6`                                |
> | **F-12** silent clamps                   | Medium       | **FIXED** — a value the domain had to change is now disclosed on the command and lands in `Command.detail` (the toast's channel). Two producers feed it: the **command layer** (the clamp the audit never named) and the **normaliser's footprint**, read from the document. The MCP answer states the clamp too | `51c6ec59` · ADR 0069                     |
> | F-03, F-04, F-14                         | —            | already resolved when this report was written (§5.8)                                                                                                                                                                                                                                                             | —                                         |
>
> **The audit's own verdict line ("29 findings, 3 resolved, 26 open, 1
> Critical") is the state as DELIVERED.** With the repairs above it reads:
> **29 findings, 14 resolved, 15 open, 0 Critical.**
>
> **Still open, and the next wave:** the rest of §6's TOP 10, the systemic
> improvements in §7 (S-1 … S-5) and the remaining phases in §8. _(An earlier
> revision of this block said "the rest of §11" — §11 is the method appendix,
> not a work list; the pointer is corrected here.)_

---

## 1. Executive reliability verdict

**The DAW's _authoritative state_ is sound — with two exceptions the audit found, one of them
Critical. Its _reported state_ is not uniformly sound.**

KYX has a genuinely well-disciplined core: one authoritative document, one command write path,
delta-based undo that cannot revert a concurrent human edit, an atomic IndexedDB commit, a
revision-guarded save path, a typed MCP error taxonomy, and a plugin param write path that
re-reads the committed document and reports `PARTIAL_FAILURE` when the commit does not match the
intent. Those are not incidental; they are defended by named tests. **The user can trust what the
project saves and what the undo stack contains.**

**The exception is F-28**, and it is the one finding that breaks the product's own doctrine: the
PRISM plugin's DSP core is a **second writer** to the document. Its in-plugin Undo applies the change
to the audio, writes the value back into the document — and the normaliser then discards that write,
because the value arrives under the plugin's _internal_ id rather than the project's canonical one.
The result is measured, not inferred: **the DSP plays wet/dry 1.0 while the document and the knob
say 0.3, and a save + reload moves the sound back to 0.3.** One second writer, one missing
inverse-id map, and the project's "same project, same sound" contract breaks.

**The second exception is F-29**, and it is the opposite failure: the document is right, but the
**undo** that is supposed to restore it can remove the wrong thing. An automation point carries no
identity, so its undo is anchored to an array _position_; when the lane shifted between the AI's
write and its undo, the AI's undo removed the **human's** point and left the AI's standing —
measured, §5.7. It is a silent loss of authored work, and the window that opens it is F-26's
unsynchronised dispatch.

**A third, and the most awkward:** F-16. The same command produces **two different documents**
depending on whether a collab session is open — and the difference lands on the DSP's wet/dry
(measured, §5.9). It also makes the Critical finding **mode-dependent**: the PRISM write-back is
discarded solo and lands in collab. **Whoever repairs F-28 has to know that.**

**And the audit corrected itself three times.** A duplicate-guard scan over all 1277 spec files (§5.8)
showed that **two findings the report had listed as open were already fixed** by a concurrent
session — F-04 and F-14, whose fix landed _six minutes before this report's own last commit_. A
third, F-06, turned out to be **half a deliberately pinned contract** rather than a defect. Every
`file:line` in this report was then re-verified mechanically against the current tree (§11). And in a
later correction pass **F-10 was re-measured and its verdict reversed** — the track-gain lane is a
_multiplier_ and the graph is **correct**; the defect is its label and the missing effective-value
readout, so it fell from **High to Medium** and left the TOP 10 (§4/F-10). The
verdict below is stated on the corrected list: **29 findings, 3 resolved, 26 open, 1 Critical.**

What is _not_ uniformly sound is everything that **reports** on that state rather than holding it:

| Surface                                  | Verdict                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project document, undo/redo, save/reload | **Trustworthy — with two holes.** One authority, one write path, atomic save, verified round-trip. **F-28** is the critical one: a second writer whose value is discarded. **F-29** is the second: the document is right, but an automation point's undo is _positional_, so a shifted lane lets the AI's undo remove the **human's** point. |
| MCP refusal + acknowledgement contract   | **Mixed — and improving in the working tree.** The new R-02 `verifiedMutation` gate now corrects false _successes_ at one dispatch choke point. It does **not** cover two paths: a refusal that is not flagged as an error, and the idempotency replay, which returns before the gate.                                                       |
| Export paths                             | **Divergent from each other.** The master export refuses to render a changed project; the stem and track exports do not check at all and can ship a stale arrangement.                                                                                                                                                                       |
| Automation / DSP value display           | **Divergent.** The knob shows the committed document value while the DSP plays the automated value, with no "under automation" indicator anywhere in the rack. The track-gain lane has the same shape: it is **correctly** a multiplier, but it is labelled and scaled like an absolute "Volume" (F-10).                                     |
| Persistence recovery                     | **Much improved in the working tree — it was the weakest area.** The single global recovery slot is gone (per-project slots, `9d2fc17c`), and a malformed, foreign or newer buffer is now **refused** instead of written into the store. One hole survives: a **failed buffer write is still discarded** (`src/services.ts:1328`).           |

**The headline risk is not "the DAW loses data on save". It is "the DAW says something that is not
true"** — in three places where a human can be misled about whether work happened: the REC indicator
says "recording" while notes are silently discarded; an MCP refusal is returned as a _success_ to any
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

1. **The repository's suite was measured — and it is RED.** The full suite ran on a **clean
   baseline worktree** at the audited commit: **1232 files, 1213 passed, 19 failed** (21 tests), plus
   **13 typecheck errors in 5 files**. All of it is pre-existing and none of it is caused by this
   audit — its four commits touched one Markdown file. The production build **cannot** run, because
   `build` starts with the failing `tsc`. So this report does not rest on a green tree: every claim
   below is still either read from source or measured by a purpose-built probe, and where a claim
   rests only on reading it is labelled as such. (§5.5)
2. **Four probe harnesses were used; all executed.** `tmp-divergence-probe.mts` (7 sub-probes,
   `vite-node`) and four vitest specs — `tmp-probe/f03.test.ts` (5 sub-probes, **5/5 green**),
   `tmp-probe/scenarios.test.ts` (7 sub-probes, **7/7 green**, covering the four mission probes the
   first pass had to report as _not executed_), `tmp-probe/second-writer.test.ts` (T6, the DSP
   write-back) and `tmp-probe/gaps.test.ts` (T7–T9, **7/7 green** — the three probes §5.6 had left
   open, which produced **F-29** and refuted **F-22**). An earlier `vite-node` attempt at the second
   probe hung for 420 s twice and was abandoned; re-implementing it under vitest loaded the same
   module graph in **8 seconds**. Results and raw output are in §5.
3. **The working tree moved under this audit, and it changed a finding.** `src/mcp/tools.ts` was
   edited by another session _while the probes were running_ (file mtime 11:36:56; `git diff` grew
   during the session). The change landed the **R-02 `verifiedMutation` gate**, which fixed the
   F-03 false-success. This report reflects the **post-change** state, and §4/F-03 states plainly
   what was true before, what changed, and what is still open. **F-05, F-06 and F-07 were measured
   against the current source and are still open.** Every other finding was read from source; a
   finding outside `src/mcp/tools.ts` may also have been affected by concurrent work and should be
   re-verified before acting.
4. **No audio was listened to.** Audible-truth claims (F-09, F-11, F-17, F-18, F-19) are
   _structural_ claims about what value reaches which DSP node. They are not perceptual claims.
   §10 specifies the listening protocol that would close them. **F-10 was re-measured during the
   correction pass and re-classified from an audible-truth claim to a visibility gap** (§4/F-10).
5. **No browser was driven.** UI-level claims (F-01 staleness, F-02 indicator, F-09 knob) are derived
   from the subscription model and the render-time capture, not from a rendered frame.
6. **Four layer maps were produced by delegated read-only exploration and then independently
   spot-checked.** The parent verified, by direct grep/read, the claims marked _Confirmed_ below.
   Claims that survived only the delegated reading are marked _Strongly indicated_. No finding in
   this report is carried on a delegated citation alone.

---

## 2. Observed state architecture

### 2.1 Authority map (code-backed)

| Domain value                  | Authority                                                                                                               | Writers                                                | Consumers                                                | Transition contract                                                                                                                                        | Persistence                                                                                     | Potential drift                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Project document (all slices) | `ProjectStore.doc_` (`src/store/ProjectStore.ts:77, 264`) — replaced, never mutated                                     | `store.execute` / `executeUserEdit` only; `replaceDoc` | UI hooks, engine, scheduler, renderer                    | command → `execute` → identity guard (`:256-263`) → `normalizeProject` (`:264`) → undo push (`:265`)                                                       | IndexedDB `projects`, whole doc, one transaction (`src/persistence/ProjectRepository.ts:50-62`) | none at this layer — verified                                                            |
| Undo / redo history           | `ProjectStore.undoStack` / `redoStack` (`:28-29`)                                                                       | `applyCommand` (`:265`), `undo`/`redo`                 | UI history panel, `kyx_undo`                             | delta snapshot (`src/commands/core.ts:34-45`), history capped at 256 (`:269-273`)                                                                          | not persisted                                                                                   | undo inside an open frame (F-22)                                                         |
| Save status / watermark       | `ProjectStore.saveStatus_` / `lastSavedAt_`                                                                             | `services.doSave` only                                 | TopBar, `kyx_save`                                       | revision-guarded (`src/services.ts:1153, 1173-1179`)                                                                                                       | **never persisted**                                                                             | three notions of "when" (F-15)                                                           |
| Unload recovery buffer        | `localStorage["kyx:recovery-buffer:v1:<projectId>"]` — one slot **per project**; a legacy single key is migrated        | `services.onUnload` (sync)                             | `ProjectBrowser`                                         | per-project slot; the write result is **discarded**                                                                                                        | localStorage                                                                                    | **a failed write is not surfaced (F-04, second half)**                                   |
| Project snapshots             | IndexedDB `project-snapshots`                                                                                           | `SnapshotRepository.save`                              | History panel                                            | separate store                                                                                                                                             | IndexedDB                                                                                       | none found                                                                               |
| Runtime transport cursor      | `Transport`, anchored on the **AudioContext clock** (`src/audio-engine/AudioEngine.ts:545-547` → `src/services.ts:595`) | engine                                                 | UI playhead via shared rAF                               | audio-clock, not wall clock                                                                                                                                | not persisted                                                                                   | UI playhead freezes in a hidden tab (F-21)                                               |
| Effect parameter (document)   | `EffectInstance.params`                                                                                                 | commands, MCP, plugin panel                            | `EffectRack` (`src/ui/EffectRack.tsx:969, 1310`), engine | `syncFxParams` diff-guarded push (`src/audio-engine/AudioEngine.ts:1620-1625`)                                                                             | with the document                                                                               | **knob ≠ DSP under automation (F-09)**                                                   |
| Effect parameter (runtime)    | AudioParam in the graph                                                                                                 | `syncFxParams`, automation bridge, macro               | DSP only                                                 | `setTargetAtTime`, tc 20 ms native / instant worklet                                                                                                       | not persisted                                                                                   | macro vs automation conflict (F-11)                                                      |
| **DSP-side write-back**       | **a second writer — and the only one found**                                                                            | the PRISM core, via `FxEqPanel`'s in-plugin Undo/Redo  | the document, via `setFxEqParam`                         | arrives under the plugin's **internal** id (`globalMix`, 0..100) instead of the project's canonical one (`mix`, 0..1) — so the normaliser discards it      | **not persisted**                                                                               | **F-28 — measured: the audio and the document disagree, and a reload changes the sound** |
| Track gain                    | `track.gain` (fader) + `modAutoGain` (automation **lane — a multiplier**) + `modMacroGain` (macro — a multiplier)       | commands                                               | mixer UI                                                 | chain `gain → modAutoGain → modAutoPan → modMacroGain` (`AudioEngine.ts:2016-2019`; the return strip is `gain → modAutoGain → modMacroGain`, `:1904-1906`) | with the document                                                                               | **the lane is a multiplier but is labelled and scaled like an absolute "Volume" (F-10)** |
| Automation lane               | `doc.automation` points                                                                                                 | commands, MCP                                          | engine (runtime only), arrangement lanes                 | `writeAutomationTargetAt` (`src/audio-engine/automationBridge.ts:1291-1310`)                                                                               | with the document                                                                               | points have **no identity** → addressed by value and by position (F-07, F-29)            |
| MCP read model                | **none** — tools read `ctx.getDoc()` live                                                                               | —                                                      | all tools                                                | —                                                                                                                                                          | —                                                                                               | idempotency ledger replay (F-06)                                                         |
| Session checkpoint / A-B      | `masterAbStore`, outside the document (`src/mcp/tools.ts:77`)                                                           | MCP session                                            | `kyx_master`                                             | not invalidated on document change                                                                                                                         | not persisted                                                                                   | stale restore (F-08)                                                                     |

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
             │                                  ⚠ F-10 lane is a MULTIPLIER, labelled as absolute "Volume"
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
  is a _sync latency_, not a state divergence, and is not filed as a finding.
- **Three "when did this save" notions** coexist (`doc.updatedAt` in the stored record,
  `lastSavedAt` in the store, the library list's own stamp). See F-15.

---

## 3. Critical invariants

Derived from the product's actual contracts, not imposed. Status reflects this audit's evidence.

| #        | Invariant                                                                                                        | Contract source                                                                           | Status                                                                                                                                                                                                                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **I-1**  | Every mutation flows through the command layer; there is no second write path                                    | `src/commands/*`; grep for direct `doc.<slice> =` in `src/` returns nothing               | **Holds** (verified by search)                                                                                                                                                                                                                                                                                                 |
| **I-2**  | A parameter set by _any_ control surface yields the same domain value after normalisation                        | `src/commands/*` is shared by UI and MCP                                                  | **Holds — MEASURED** (§5.3, T1): identical domain map **and** identical DSP param cache. The _report_ still breaks (F-05, F-06, F-07)                                                                                                                                                                                          |
| **I-3**  | A committed operation is observable in the engine/DSP path, or reports pending/failure accurately                | `syncFxParams` diff-guarded push; MCP `PARTIAL_FAILURE`                                   | **Partially holds** — F-06, F-24                                                                                                                                                                                                                                                                                               |
| **I-4**  | Save/reopen reproduces the arrangement, routing, automation and plugin state                                     | `ProjectRepository.save` = whole doc, one transaction                                     | **Holds — MEASURED** (§5.3, T3): the reloaded document is byte-identical **and** rehydrates to an identical DSP state — **except after a DSP-side write-back (F-28), where the reload changes what you hear**                                                                                                                  |
| **I-5**  | Undo/redo restores all logically coupled values                                                                  | delta snapshot; `src/commands/docDelta.ts`                                                | **Holds** for the measured battery (probe P2/P3) — **except** the frame case (F-22)                                                                                                                                                                                                                                            |
| **I-5b** | A late-acknowledged write must not overwrite a newer write to the same field                                     | no version, no expected-revision guard                                                    | **Breaks — MEASURED** (§5.3, T2): last-APPLIED-wins (F-25). An unrelated field is protected by the delta snapshot; the same field is not                                                                                                                                                                                       |
| **I-6**  | Automation playback does not overwrite the persistent baseline                                                   | `writeDeviceTargetAt` touches runtime only; `automationReset` restores the doc base       | **Holds — this defect does NOT exist.** The doc is never written by automation.                                                                                                                                                                                                                                                |
| **I-7**  | Export/offline render uses semantically equivalent mix state and processing rules                                | `renderProject(doc)`; `tests/offline-parity.test.ts`                                      | **Holds for the mix**; **breaks for freshness** (F-01)                                                                                                                                                                                                                                                                         |
| **I-8**  | Removing an entity invalidates stale references cleanly                                                          | `deleteTrack` cleans cross-references; `tests/delete-track-undo-cross-references.test.ts` | **Holds** (measured: deleteTrack round-trips)                                                                                                                                                                                                                                                                                  |
| **I-9**  | A failed multi-step command leaves no undisclosed partial transition                                             | MCP `PARTIAL_FAILURE` convention                                                          | **Holds where implemented**; F-05 shows the convention is not universal                                                                                                                                                                                                                                                        |
| **I-10** | Repeated command delivery is idempotent, or non-idempotent with explicit dedup/ordering rules                    | MCP idempotency ledger (requestId)                                                        | **Holds for the ledger**; **breaks for automation points** (F-07)                                                                                                                                                                                                                                                              |
| **I-11** | Transient meter/playhead values may lag within a documented bound, and that lag must not corrupt committed state | scheduler tick 25 ms, lookahead 120 ms, smoothing tc 8–20 ms                              | **Holds** — the lag is bounded and documented; UI playhead freeze in a hidden tab is a _display_ issue (F-21)                                                                                                                                                                                                                  |
| **I-12** | The AI's structured answer agrees with what the document actually contains                                       | MCP ack contract + the R-02 `verifiedMutation` gate                                       | **Holds on the dispatch path** (gate); **breaks** on refusals and on the idempotency replay (F-05, F-06)                                                                                                                                                                                                                       |
| **I-13** | There is exactly **one** writer to the authoritative document                                                    | `src/commands/*` → `ProjectStore.execute`                                                 | **Breaks — MEASURED** (§5.3, T6): the PRISM DSP core is a second writer (its in-plugin undo writes into the document), and the normaliser discards that write — so the audio and the document diverge (F-28)                                                                                                                   |
| **I-14** | An undo removes **the entity it created**, not whatever occupies its slot                                        | `src/commands/*` → the command's own `undo`                                               | **Breaks — MEASURED** (§5.7, T7c): an automation point has no identity, so its undo is anchored to a _position_; when the lane shifted, the AI's undo removed the **human's** point and left the AI's (F-29). The sibling command `moveAutomationPoint` already honours this invariant (audit 06 D3) — the add's undo does not |
| **I-15** | The **same command** produces the **same document** in every store mode (solo, collab)                           | `src/commands/*` → `ProjectStore.execute` / `YDocStore.executeBuffered`                   | **Breaks — MEASURED** (§5.9, T10): the collab path skips normalisation, so one command yields `params.globalMix = 1` solo and `30` in a collab session, and normalising on the way out rewrites it (F-16). **It also makes F-28 mode-dependent**: the Critical write-back is discarded solo and lands in collab                |

**Deliberately asynchronous contracts (not defects):**

- Scheduler tick 25 ms with a 120 ms lookahead — `src/scheduler/Scheduler.ts:149, 151`.
- `setTargetAtTime` smoothing: 20 ms native FX, 8 ms track gain/pan, 10 ms macro bus. A parameter
  trails its commanded value by ~8–20 ms and settles within ~24–60 ms. This is contract-compliant.
- The offline render path is exact (`setValueAtTime`, not gliding) — `src/effects/registry.ts:206-220`,
  guarded by `tests/offline-effect-params.test.ts`. The live and offline paths are _intentionally_
  different here.
- The engine's graph sync is deferred through `projectPromise` — sub-frame, intentional.

---

## 4. Findings register

Severity: **Critical** (wrong audio / lost work / false success in the common path) ·
**High** · **Medium** · **Low**.
Confidence: **Confirmed** (read the code path that proves it, or measured it) · **Strongly indicated** ·
**Hypothesis** · **Untested**.

**29 findings.** **Three** are now **resolved in the working tree** and are retained as worked
examples rather than open items: **F-03** (fixed by the R-02 `verifiedMutation` gate during this
audit) and **F-04 + F-14** (fixed by a concurrent persistence commit, `9d2fc17c` — found by the
duplicate-guard scan in §5.8, which the report had promised but had not performed). **26 remain
open**, one of them **Critical** (F-28), and **F-04's second half** — the discarded write result —
survives its own fix and stays on the list.
Fourteen are **Confirmed** by code reading that the parent re-verified directly; **nine of those were
additionally measured** (§5). **F-16 has been upgraded to Confirmed — MEASURED** (§5.9, probe T10),
so it is no longer one of the two _Strongly indicated_ findings. **F-22 was downgraded to
_Hypothesis — not reproduced_** by the §5.7 probe. One remains a **Hypothesis** (F-23).

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
  The master path in the _same panel_ does check: `exportMaster` captures
  `projectRevisionIdFor(doc)` (`:507`) and calls `assertMasterSourceCurrent()` (`:509-518`, invoked
  at `:522, 535, 543, 566, 585, 618, 643, 677, 749`), which compares the live document's identity
  against the captured one and throws _"The project changed during mastering. The stale result was
  discarded; analyze again."_ (`:513`).
  `projectRevisionIdFor` is a `WeakMap` keyed on the **document object identity**
  (`src/mastering/report.ts:102-107`) — so it detects _any_ mutation, including arrangement edits.
- **Two independent failure windows:**
  1. _Before_ the click: an arrangement-only edit leaves the panel un-rendered → the export renders
     the pre-edit arrangement.
  2. _During_ the render: the stem render is multi-second and asynchronous; an edit made during it
     is never detected, because `exportStems` never re-reads the store. The master path catches
     exactly this at `:535`.
- **Evidence:** `src/ui/ExportPanel.tsx:252-259, 509-518, 535, 835-872, 874+`;
  `src/ui/context.ts:100-103`; `src/mastering/report.ts:102-107`;
  `src/project-model/schema.ts` — `normalizeProject` returns `state.changed ? state.doc : doc`.
- **Root-cause hypothesis:** the freshness guard was added for the mastering workflow and never
  generalised. The panel's fine-grained subscription set is a _rendering_ optimisation that was never
  recognised as also being a _freshness_ contract.
- **Smallest safe repair:** capture the document **inside** `exportStems`/`exportTracks`
  (`services.store.getDoc()` at call time, not render time) and apply the same
  `projectRevisionIdFor` freshness assertion before and after each render, reusing the existing
  message. No schema change, no behaviour change for the master path.
- **Regression plan:** mount `ExportPanel`, mutate `doc.arrangement`, click _Export stems_, assert
  the export refuses with the same message the master path uses; and assert a mutation performed
  _during_ the render also refuses.

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
  discarded** (the code comments say explicitly: _"The hit still sounds (the fire callback is
  separate), it just doesn't stamp the pattern."_). And `onTransportInterrupted`
  (`src/midi/patternRecorder.ts:116-120`) **deliberately keeps `armed` true** across a stop.
- **Consequence:** after pressing STOP, the ⏺ stays lit. The user plays notes, hears them, and
  nothing is captured — no error, no message, no visual change. A take the user believes exists
  does not exist. This is silent loss of an intended recording.
- **Evidence:** `src/ui/TopBar.tsx:158, 613, 625`; `src/midi/patternRecorder.ts:53, 116-120, 131`.
- **Root-cause hypothesis:** one boolean is asked to carry two meanings — _"the user wants to
  record"_ and _"input is being captured right now"_. They are not the same state.
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
>
> ```ts
> ctx.execute(setTrackParams(ctx.getDoc(), ids[0], { name }));
> return { text: `renamed to "${name}"`, mutated: true };
> ```
>
> `setTrackParams` drops fields equal to the current value and returns an **identity command**
> (`execute: (d) => d`), and `ProjectStore.applyCommand` then hits its identity guard
> (`src/store/ProjectStore.ts:279-286`) — so the document was byte-identical, **no undo entry
> existed**, the project was not even marked dirty, and the AI was nevertheless told
> `mutated: true` and _"renamed to X"_.
>
> **While this audit was running, another session landed a surface-wide fix** — the **R-02
> `verifiedMutation` gate** (`src/mcp/verified-mutation.ts`), applied at the single dispatch choke
> point in `src/mcp/tools.ts`:
>
> ```ts
> result = verifiedMutation({
>   before: docBefore,
>   after: ctx.getDoc(),
>   undoDepthBefore,
>   undoDepthAfter: ctx.undoStackLength(),
>   result,
> });
> ```
>
> Its own comment states the intent: _"ONE PLACE WHERE A MUTATION BECOMES A CLAIM … a success with
> an identical document is not a success."_ The probe (§5.2) confirms it works: the rename now
> returns `mutated: false` and _"nothing changed (the document is identical)"_.
>
> **Two things follow, and both matter more than the original finding:**
>
> 1. **The gate has two holes**, and both are live — see **F-05** and **F-06**, which the gate does
>    _not_ cover. It is a good fix with an incomplete perimeter.
> 2. **This fix lives in the working tree, not on `main`.** It is uncommitted (the audit observed
>    `git diff` on `src/mcp/tools.ts` growing mid-run) and therefore **not yet shipped**. The
>    rename defect was real and observable in every build until this change lands.

- **Affected journey:** AI renames a track to the name it already has.
- **Root-cause hypothesis (now addressed):** the no-op guard existed only in the mixer setters; the
  surface had ~90 mutation sites, each describing what it was _asked_ to do, with nothing checking
  that the document backed the claim.
- **The generalisation worth keeping:** the R-02 gate is the right shape — one choke point, applied
  to every handler, using **document identity** (`before !== after`) as the witness. That same
  identity check is what `projectRevisionIdFor` uses in the export path (§F-01), so the codebase
  already has the right primitive in two places that have not been joined up.
- **Residual recommendation:** extend the gate's perimeter (F-05 refusal signalling, F-06 replay)
  and re-use the same identity witness in the export paths (F-01).

---

### F-04 — The unload recovery buffer is a single global slot; a second dirty project destroys the first's only copy

**Severity:** High (was) · **Status:** **RESOLVED in the working tree** — the slot scoping is fixed and pinned by a spec; **one half remains open** (the discarded write result)
**Confidence:** Confirmed — and the fix is _measured by the repo's own spec_, not asserted

> **Audit update — duplicate-guard scan (§5.8).** The scan found `tests/recovery-overwrite.test.ts`
> — a spec whose doc comment reads _"THE RECOVERY MUST NOT BECOME THE DESTRUCTION"_. It pins **one
> slot per project**, the legacy-key migration and the project-scoped clear. The fix landed in
> commit `9d2fc17c` _"fix(persistence): recovery must not destroy the saved project (P0 data loss)"_
> (2026-10-25 **14:19:56**) — **six minutes before this report's own last commit** (`fa9a7d2b`,
> 14:36:05). That is why this entry was still open when the report was written, and why the
> top-10 ranking had to change. **The slot defect is closed.**

- **What was wrong (before the fix):** `RECOVERY_KEY` was a single constant
  (`src/persistence/recoveryBuffer.ts:25`) and `writeRecoveryBuffer` overwrote it unconditionally
  (`:62` `store.setItem(RECOVERY_KEY, payload)`). `clearRecoveryBuffer(projectId)` **was**
  project-scoped (`:116-126` — it refuses to remove a buffer belonging to another project, `:123`),
  which shows the author knew a buffer can belong to a different project than the one being cleared —
  but the _write_ path had no such scoping. The file's own comment (`:105`) stated: _"`projectId`
  scopes the clear to ONE project. The buffer holds the ONLY copy…"_ — and the write path destroyed
  that copy for project A when project B was closed dirty.
- **What it is now:** `RECOVERY_KEY_PREFIX = "kyx:recovery-buffer:v1:"` with a per-project
  `recoveryKey(projectId)` (`src/persistence/recoveryBuffer.ts:37, 57-59`), a legacy single key kept
  for migration (`:35, 92-93`), and a scoped clear. `writeRecoveryBuffer` returns a **boolean**
  (`:77`).
- **THE HALF THAT IS STILL OPEN — and it is the one the original finding was really about.** The
  write result is still **discarded** at the call site: `writeRecoveryBuffer(store.doc, store.doc.id);`
  (`src/services.ts:1328`), while the function's own doc comment says _"Returns false when the
  payload could not be stored (quota, private mode, serialization failure); the caller treats that as
  'no protection this time', never as an error"_ (`src/persistence/recoveryBuffer.ts:73-75`).
  **The comment describes a caller behaviour that does not exist.** So for a project large enough to
  exceed the localStorage quota, the buffer silently does not exist and the unload edit is lost with
  no signal at all — the exact failure this finding named.
- **Smallest safe repair (the surviving half):** either make the unload handler act on the boolean
  result and surface a failure, or amend the comment to say the result is deliberately dropped — and
  then decide deliberately. Right now the code and its own documentation disagree, and only one of
  them is a decision.
- **Regression plan:** the repo's own spec already covers the slot scoping; the surviving half needs
  a spec that asserts a failed write is reported (or, by explicit decision, is deliberately dropped).

---

### F-05 — Refusal signalling is inconsistent across the MCP surface: some refusals are typed errors, others are non-error results

**Severity:** Medium-High · **Confidence:** Confirmed — **measured** (§5.2)

> **This is a hole in the new R-02 gate.** `verifiedMutation` begins with
> `if (result.mutated !== true || result.isError === true) return result;`
> (`src/mcp/verified-mutation.ts:93`). A **refusal** is by definition `mutated: false`, so the gate
> returns immediately and never inspects it. The gate can correct a _false success_; it cannot
> correct a _missing error signal_. The perimeter has to be widened.

- **Affected journey:** any AI call that targets a stale entity.
- **Authoritative state:** the MCP result envelope (`isError`, `errorCode`, `mutated`, `text`).
- **Expected contract:** a refusal is machine-detectable. The repo has a shaped constructor for
  exactly this — `src/mcp/tools.ts:3576-3582`: _"The single shaped constructor for error results —
  every `isError` result carries one"_ (`mcpError(code, text)` → `{text, mutated:false, isError:true,
errorCode}`), and a documented code taxonomy at `:3550-3568`.
- **Observed divergence — measured directly (probe P5):**

  | Tool + stale input                   | `isError`                | `errorCode`      | doc changed |
  | ------------------------------------ | ------------------------ | ---------------- | ----------- |
  | `kyx_plugin_param` stale `trackId`   | `true`                   | `UNKNOWN_TARGET` | no          |
  | `kyx_plugin_param` stale `fxId`      | `true`                   | `UNKNOWN_TARGET` | no          |
  | `kyx_plugin_param` unknown `effect`  | `true`                   | `UNKNOWN_TARGET` | no          |
  | `kyx_plugin_param` unknown `param`   | `true`                   | `UNKNOWN_TARGET` | no          |
  | `kyx_tracks` stale `family`          | `true`                   | `UNKNOWN_TARGET` | no          |
  | `kyx_clips` stale `clipId`           | `true`                   | `UNKNOWN_TARGET` | no          |
  | `kyx_notes` stale `noteId`           | `true`                   | `UNKNOWN_TARGET` | no          |
  | **`kyx_automation` stale `trackId`** | **unset (not an error)** | **none**         | no          |

  `executeAutomationTool` returns refusals as plain prose: `src/mcp/tools.ts:7865`
  `if (typeof target === "string") return { text: target, mutated: false };` — and every other
  refusal in that handler follows the same shape (`:7864-7869, 7874, 7877-7881, 7897, 7919, 7922,
7924, 7938, 7952, 7955, 7957, 7970`).

- **Consequence:** the _prose_ is honest — _"no track or return with id \"no-such-track\" — list ids
  via kyx_state subject:tracks"_ — but the **structured** answer says success. An agent (or a client
  SDK) that keys on `isError` / a status enum reads the refusal as a completed call. Only a model
  that reads the prose catches it. This is the "visibility gap" class in its purest form: internally
  correct, but the user cannot verify the outcome from the contract.
- **Evidence:** probe P5 output (§5); `src/mcp/tools.ts:7865` and the refusal list above;
  `src/mcp/tools.ts:3553-3571, 3573-3579` (the convention that exists).
- **Root-cause hypothesis:** `mcpError` was adopted tool-by-tool rather than enforced at the
  dispatch boundary.
- **Smallest safe repair:** route the automation handler's refusals through
  `mcpError("UNKNOWN_TARGET", …)` / `mcpError("INVALID_ARGUMENTS", …)`. Then add a **meta-test** that
  asserts every mutating tool's refusal path sets `isError` — that prevents the next drift.
- **AUDIT UPDATE (§5.8) — the repo already owns the OTHER HALF of that gate.**
  `tests/mcp-error-codes.test.ts:107-124` carries a gate of exactly this kind:
  _"GATE: every error result is constructed through mcpError — no un-coded literals"_, asserting that
  every `isError: true` literal in `src/mcp/tools.ts` carries its own `errorCode`
  (`expect(unCoded).toBe(0)`). The file states the rationale outright: _"GAP-09 taught this lesson
  for handlers: coverage without a gate rots."_ (`:108`)
  **F-05 is the missing complementary half of an existing gate, not a new idea:** that gate counts
  `isError: true` literals, and F-05's refusal is `isError: undefined` — it is not an error at all,
  so the gate cannot see it. The fix is one more rule in the same file, in the same style.
- **Regression plan:** the meta-test above, plus per-tool specs asserting `isError` on stale ids.

---

### F-06 — The idempotent replay serves a stale read-back and contradicts itself

**Severity:** Medium · **Confidence:** Confirmed — **measured** (§5.2)

> **This is the second hole in the new R-02 gate, and the more surprising one.**
> The idempotency-replay path returns **before** the gate is applied. In the current
> `src/mcp/tools.ts` the replay returns at **line 4391**; the dispatch happens at **line 4444**;
> and `verifiedMutation` is applied at **line 4471**. The replay never reaches it — which is why
> the probe still measures `mutated: true` and `stage: "replayed"` on a call that changed nothing.
> A choke point only works if every exit path passes through it, and this one does not.

- **Affected journey:** an agent retries a call with the same `requestId` after a human has edited
  the same value.
- **Authoritative state:** the MCP idempotency ledger (`src/mcp/tools.ts:4036`).
- **Expected contract:** a replay tells the agent what is true _now_.
- **Observed divergence:** on a repeated `requestId`, the tool returns the **cached result object**
  (`src/mcp/tools.ts:4375-4400`):
  ```ts
  const cached = idempotencyLedger.get(requestId);
  …
  return { ...cached.result,
           text: `idempotent replay — requestId was already applied; nothing re-executed\n${cached.result.text}`,
           replayed: true, stage: "replayed" };
  ```
  The cached result is the _first_ call's result, including its read-back (e.g. the gain value at
  that moment). If a human changed the value since, the replay serves the **old number** as a
  fresh-looking answer.
  The response is also internally contradictory: `cached.result.mutated` is spread through
  unchanged, so the replay reports **`mutated: true`** while its own text says _"nothing
  re-executed"_, while the audit log for the same call records `mutated: false`
  (`src/mcp/tools.ts:4451`).
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
  The replay reports **0.250**; the document holds **0.9**. The replay's own text says _"nothing
  re-executed"_ while its `mutated` flag says `true`.
  Code: `src/mcp/tools.ts` — replay block `:4372-4397` (returns at `:4391`, text at `:4393`), the
  audit log's `mutated: false` at `:4383`, the ledger write at `:4509`, the dispatch at `:4444`, and
  the gate applied at `:4471`.
- **AUDIT CORRECTION (duplicate-guard scan, §5.8) — the stale read-back is a PINNED CONTRACT, not a
  defect.** `tests/mcp-idempotency.test.ts` asserts the replay's exact text:
  ```ts
  expect(second.text).toBe(`idempotent replay — requestId was already applied; nothing re-executed\n${first.text}`);
  ```
  (`:94`) — and the spec's contract list states it as an intended property:
  _"ID1 same requestId twice → applies exactly once; the second call is a replay carrying the
  ORIGINAL outcome"_ (`:16-17`) and _"ID6 undo after a mutation: the replay still returns the
  original outcome and does NOT re-apply (the agent owns undo/redo)"_ (`:22-23`), pinned at
  `:143-153`. **So "the replay serves a stale read-back" is a DUPLICATE of an existing, deliberate
  contract, not a discovery.** Whether that contract is _right_ — should a retry report the value as
  of the original call, or the value now? — is a **product judgement**, and it is a different question
  from the one this finding asked.
- **What survives, and is a real finding:** the replay's **envelope is ambiguous for a machine
  client**. `mutated` is spread through from the original call, so it reads `true` on a call that
  executed nothing; the disambiguation lives only in prose (`replayed: true`,
  `stage: "replayed"`, the words _"nothing re-executed"_) and in a field (`result.data`) that a
  client keying on `mutated` never reads. **A client that keys on `mutated` alone gets the opposite
  of the truth.** That is the mission's _visibility gap_ class, and it is aggravated by the fact that
  the replay returns **before** the R-02 gate — the one mechanism whose whole purpose is to make
  `mutated` honest.
- **Root-cause hypothesis:** the ledger was designed to guarantee _exactly-once execution_ and it
  does; it returns the cached _response_ as well, and that response carries the original operation's
  flags. The flags describe the past, the envelope describes the present.
- **Smallest safe repair:** on the replay path set `mutated: false` and keep `replayed: true` —
  the original outcome is already preserved in the cached result and in the text. The stale _value_
  inside the read-back is a separate, contract-level decision (it is pinned today; changing it
  changes ID1 and ID6).
- **Regression plan:** apply a change, then replay the same `requestId`; assert `mutated === false`
  and `replayed === true`. The value-freshness half needs a **product decision first**, not a test.

---

### F-07 — Automation points are addressed by value: an AI undo can delete the human's point, and repeated identical AI writes duplicate points

**Severity:** Medium · **Confidence:** Confirmed — **measured** (§5.2) for the duplication half; the
identity half was Confirmed by code reading only and is now **measured** (§5.7, T7a–T7c)

> **Superseded in part by F-29.** §5.7 measured the identity half and found the mechanism is
> **positional**, not merely value-addressed: the undo delta splices whatever occupies the recorded
> index and never compares the point it carried. **F-29 carries the destructive form** — the AI's
> undo removes the human's point outright — while F-07 keeps the duplication half. The two share one
> root cause (an automation point has no identity) and one repair.
> **The repair already exists in the sibling command:** `moveAutomationPoint` re-anchors by identity
> then by `(tick, value)` — "Audit 06 D3" (`src/commands/automation.ts:128-131`), pinned by
> `tests/automation-audit.test.ts:91-110`. `addAutomationPoint.undo` never got it.

> **Measured (§5.2):** the identical write duplicated the point and grew the undo stack.
>
> ```
> [F-07] lane points after #1: 1
> [F-07] lane points after #2: 2
> [F-07] undo stack       : 1 -> 2
> ```
>
> The R-02 gate does not help here: the document **did** change (a duplicate point is a real
> change), so the gate legitimately keeps `mutated: true` and appends a structural read-back. The
> defect is not in the claim — it is in the _operation_.

- **Affected journey:** AI writes an automation point; human writes a point at the same position;
  AI undoes.
- **Authoritative state:** `doc.automation[].points`.
- **Expected contract:** an undo removes the point it created.
- **Observed divergence:** an automation point carries only `tick` and `value` — **no identity**
  (`src/commands/automation.ts:90-93`). The undo resolves by value:
  ```ts
  const idx = l.points.findIndex((p) => p.tick === point.tick && p.value === point.value);
  ```
  (`src/commands/automation.ts:105-113`) — it removes the **first** match. When the human's point was
  inserted first at the same `(tick, value)`, the AI's undo deletes the _human's_ point and leaves
  the AI's own point behind. Because the two are value-identical, the document JSON after the undo
  is indistinguishable from a correct undo — the damage is invisible to any document-level diff.
  Separately, `insertPointSorted` (`src/project-model/automation.ts`) is
  `const next = [...points, point]; next.sort((a, b) => a.tick - b.tick);` — **no de-duplication** —
  so repeated identical `addPoint` calls each add a point and each push an undo entry. The MCP ack
  (`src/mcp/tools.ts` `addPoint` branch) reports only the _last_ point at that tick, so the
  duplication shows up only as a rising point count.
- **Evidence:** `src/commands/automation.ts:85-108`; `src/project-model/automation.ts`
  `insertPointSorted`; `src/mcp/tools.ts` `executeAutomationTool` `addPoint` branch.
- **Root-cause hypothesis:** automation points predate the need for identity; every other entity in
  the model (tracks, clips, effects, lanes) has an id.
- **Smallest safe repair (two options, both bounded):**
  - _Cheap, no schema change:_ de-duplicate identical `(tick, value)` inserts and make the undo
    remove the **last** match rather than the first.
  - _Correct:_ give points a stable `id` — this is a `SCHEMA_VERSION` bump plus a migration, and
    should be scheduled deliberately (see §7).
- **Regression plan:** a spec that adds a human point, adds an identical AI point, undoes, and
  asserts by _object identity_ which point survived (a JSON diff cannot see this).

---

### F-08 — A stale ordinal target silently redirects a write to a different entity

**Severity:** Medium · **Confidence:** Confirmed (code path)

- **Affected journey:** AI restores an A/B snapshot after a human deleted the saved effect instance
  and added a different one of the same type.
- **Authoritative state:** `EffectInstance.id`; the A/B snapshot lives _outside_ the document
  (`src/mcp/tools.ts:77`, `masterAbStore`) and is never invalidated when the document changes.
- **Expected contract:** a write aimed at a specific instance either hits it or fails.
- **Observed divergence:** the restore resolves the instance by id **with an ordinal fallback**
  (`src/mcp/tools.ts`, `kyx_master` → `op: "ab"` → `restore`):
  ```ts
  const matchingDevices = track.effects.filter((fx) => fx.type === device.type);
  const instance = matchingDevices.find((fx) => fx.id === device.fxId) ?? matchingDevices[device.instanceIndex ?? 0];
  ```
  The code comment says _"the per-type occurrence handles recreated IDs"_ — but a human who
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
- **Smallest safe repair:** on the fallback path, say so — _"original instance gone; applied to
  instance #2"_ — so the outcome is verifiable. (Removing the fallback entirely would break the
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
- **Observed divergence:** the rack reads the **document** — `src/ui/EffectRack.tsx:969` and
  `src/ui/EffectRack.tsx:1310` `values={fx.params}`. Automation writes the **absolute lane value**
  into the runtime
  (`src/audio-engine/automationBridge.ts:1309` → `writeDeviceTargetAt` →
  `src/audio-engine/deviceLookup.ts`). The `param.secondary` affordance
  (`src/effects/types.ts:39`, `src/effects/definitions.ts:979, 948`) is computed from the _same_
  document values, so it does not disclose the gap. There is **no "under automation" indicator**
  anywhere in the rack or inspector.
- **Consequence:** during playback the knob reads the committed value, the audio plays the lane
  value, and a manual knob edit is overwritten within one scheduler tick (25 ms) while the knob
  keeps displaying the user's number. The user adjusts a knob and hears nothing change — and sees a
  number that is not what they hear.
- **Evidence:** `src/ui/EffectRack.tsx:969, 1310`; `src/audio-engine/automationBridge.ts:1309`;
  `src/audio-engine/deviceLookup.ts:144-145`; `src/effects/types.ts:39`.
- **Root-cause hypothesis:** the document is treated as the only display source. That is correct for
  a DAW _without_ automation, and wrong at exactly the moment automation is running.
- **Smallest safe repair:** add an explicit "AUTO" badge on parameters that have an active lane,
  and show the lane's current value alongside the committed value. This is additive and does not
  touch the DSP path.
- **Regression plan:** a component test that mounts the rack with an active lane and asserts the
  effective value / AUTO indicator; a DSP-level test asserting the runtime value equals the lane
  value.

---

### F-10 — The track-gain lane is a **multiplier**, but it is labelled and scaled like an absolute "Volume"

**Severity:** Medium (was High) · **Confidence:** Confirmed — **measured** (§5.3, probe T4 + T4b)

- **Affected journey:** a track-gain automation lane on a strip whose fader is not at unity.
- **Authoritative state:** the composed channel gain = fader (`track.gain`) × lane (`modAutoGain`) ×
  macro (`modMacroGain`).
- **Expected contract:** the number the lane shows is the number the user means.
- **MEASURED (probe T4 — the repo's own mock-AudioContext harness, which records `connect()` so the
  topology is asserted, not guessed):**
  ```
  [T4] fader (doc track.gain)      : 0.8
  [T4] lane value written to DSP  : 0.5
  [T4] fader -> modAutoGain is a SERIES connection: true
  [T4] modAutoGain -> modMacroGain series: false
  [T4] product (multiplicative)   : 0.4
  [T4] lane is a MULTIPLIER (unity 1.0), NOT an absolute gain: true
  [T4] VERDICT: modAutoGain is a MULTIPLY stage in series after the fader — the audible gain is 0.4 while the lane reads 0.5
  ```
  The decisive fact is the third line: the fader's `GainNode` feeds `modAutoGain` **directly**, in
  series. The track strip's chain is `gain → modAutoGain → modAutoPan → modMacroGain`
  (`src/audio-engine/AudioEngine.ts:2016-2019`); the _return_ strip is `gain → modAutoGain →
modMacroGain` (`:1904-1906`). So the audible channel gain is **0.8 × 0.5 = 0.4**, while the lane
  reads **0.5** and the fader reads **0.8** — _neither_ surface shows 0.4.
- **The stage's contract is "multiplier around unity" — measured, not inferred.** Three independent
  facts in the source agree, and all three would be meaningless for an absolute gain:
  1. **The modulator composes `1 + v` into the same parameter.** `makeModulatorWriter` clamps a gain
     modulator to `1 + v` (0..1.5) and writes it into the **same** `modAutoGain` param the lane
     writes (`src/audio-engine/automationBridge.ts:1208-1218`) — the code's own comment: _"Gain
     modulators swing the channel multiplier around base 1"_. An absolute-gain param has no base 1.
  2. **A new lane starts at unity.** `targetParamDef` declares `default: 1` for `trackGain`
     (`src/project-model/targets.ts:232`) and the lane editor creates a new lane at that default
     (`src/ui/arrangement/AutomationClipLanes.tsx:250`) — so adding a lane **cannot change the
     sound**. Under absolute semantics a new lane would have to start at the fader's value, or adding
     a lane would jump the mix.
  3. **Stop restores unity, not the fader's value.** `automationReset()` writes `1` back into the
     stage (`src/audio-engine/automationBridge.ts:1426-1453`), and cancels the pending scheduled
     values first — so a stopped lane leaves **no residue**.
  ```
  [T4b] modulator amount 0.2 -> modAutoGain.gain = 1.2   (base 1 + v, clamped 0..1.5)
  [T4b] trackGain lane default = 1, range 0..1.5
  [T4b] after automationReset(): modAutoGain.gain = 1
  ```
- **CORRECTION (2026-10-25).** An earlier revision of this report stated that the lane was _"authored
  absolute but applied multiplicatively"_, and that therefore _"the 0..1.5 clamp, the lane UI and the
  comment are wrong"_. **That was wrong, and it would have misled an implementer into "fixing" a
  correct lane.** The clamp, the lane range and the code comment are exactly right for a multiplier:
  0..1.5 bounds the _multiplier_ (up to +3.5 dB) to the same ceiling the fader may legally reach —
  which is what `automationBridge.ts:1300-1302` says. **The lane is a modulation and the graph is
  right.** The finding is re-classified from _wrong audio_ to a **visibility + presentation-semantics
  gap**, and its severity drops from **High to Medium**.
- **What actually diverges.** The lane's number is a **multiplier**, but:
  - it is **labelled "Volume"** — `targetParamDef` returns
    `{ id: "gain", label: "Volume", min: 0, max: 1.5, default: 1 }` for `trackGain`
    (`src/project-model/targets.ts:232`), the _same definition_ the absolute fader uses;
  - it is **drawn on the same 0..1.5 scale as the fader** — `clampFaderGain` bounds the fader at
    0..1.5 (`src/audio-engine/AudioEngine.ts:73-75`) and the lane is drawn on `def.min..def.max`
    (`src/ui/arrangement/AutomationClipLanes.tsx:122`);
  - and **no surface shows the composed result**. Fader 0.8, lane 0.5 → the channel sits at **0.4**,
    while the two surfaces read **0.8** and **0.5**.
- **Root cause:** one parameter definition (`targetParamDef`) serves **two different domains** — an
  absolute fader and a multiplicative lane — so the lane inherits the fader's label and its numeric
  scale while meaning something else.
- **Evidence:** measurement above; `src/audio-engine/automationBridge.ts:1208-1218, 1191-1210,
1326-1353`; `src/audio-engine/AudioEngine.ts:2016-2019, 73-75`;
  `src/project-model/targets.ts:232`; `src/ui/arrangement/AutomationClipLanes.tsx:122, 250`.
  The `mixer-audit3` suite already pins the _clamp_ on this lane (0..1.5) and never the
  _composition_ — `tests/mixer-audit3.test.ts:355-370`.
- **Smallest safe repair — now purely additive, no ADR and no behaviour change:**
  1. **Relabel** the lane (display only; the `targetParamDef` id stays `gain`, so no public MCP
     contract breaks) — e.g. "Gain mod" — and draw a **unity line at 1.0**, so the multiplier's neutral
     point is visible instead of implied.
  2. **Show the effective value** — the composed channel gain (fader × lane) beside the lane, with an
     "AUTO" badge. This is the **S-5 effective-value read model**, the _same_ repair F-09 needs; one
     read model closes both.
  3. Declare the domain in the parameter registry (`absolute` vs `modulation`) — the **S-4** registry,
     so the next lane kind cannot inherit a mismatched label.
- **Regression plan:** probe T4/T4b is already the test — promote it into `tests/` as a graph-topology
  assertion (fader 0.8 + lane 0.5 → the product; a new lane is unity; a stop restores unity). Add a
  component test that the lane renders the unity line and the effective value.

---

### F-11 — Macro, modulator and automation all write the same effect `AudioParam`; last writer wins

**Severity:** Medium · **Confidence:** Confirmed

- **Affected journey:** a macro mapped to an effect parameter that also has an automation lane.
- **Authoritative state:** one `AudioParam` per device parameter
  (`src/audio-engine/deviceLookup.ts:59-93`).
- **Expected contract:** composed sources sum (or a documented precedence applies).
- **Observed divergence:** the macro path and the automation path both call
  `this.lookup.writeDeviceTargetAt(target, value, when)` with the _same_ target shape
  (`{kind:"fxParam", trackId, fxId, paramId}`) — `src/audio-engine/automationBridge.ts:773`
  (macro) and `:1309` (automation). The macro writes `base + delta`; the automation writes the
  **absolute** lane value; the modulator writes `base + halfRange·value`. There is no composition.
  During playback the scheduler rewrites the parameter every 25 ms, so the macro's contribution to
  an effect parameter is **silently dropped**. (Track-level gain/pan are different — they have a
  dedicated `modMacro` bus and are not affected.)
- **Evidence:** `src/audio-engine/automationBridge.ts:773, 793, 1239-1240, 1309`;
  `src/audio-engine/deviceLookup.ts:59-93`.
- **CORRECTION (2026-10-27).** Two claims above were wrong; both are corrected here (the rest of
  the finding is unchanged):
  1. **The citation.** `automationBridge.ts:341-342` was labelled "the macro path" — those two
     lines are the **scene-pack** writer (`writeScenePackTargets`). The macro writes at `:773`
     (the live macro at `:960`).
  2. **The order.** The finding proposed "automation > macro > modulator" and presented it as the
     audible outcome. Measured: the scheduler calls `applyAutomation` and then `applyModulators`
     in the same window, and the modulator's write is scheduled **5 ms later**
     (`src/scheduler/Scheduler.ts:1200` and `:1250` — the modulator adds
     `scheduleOffsetSec() + 0.005` where the lane adds `scheduleOffsetSec()`). **The modulator
     wins that contest today — by scheduling, not by a rule.** ADR 0067 therefore decides
     **automation > modulator > macro > midiCC**: the lane wins deterministically, which is a
     deliberate change, not a description of the old behaviour.
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
  (`src/store/ProjectStore.ts:235, 264, 381, 414`) — not only on load. It clamps, among others:
  limiter lookahead 1..20 ms and release 10..2000 ms; loudness trim ±12 dB; LUFS target −24..0;
  and **truncates `liveSets` at 32 — the 33rd set is silently dropped**. It also deletes the legacy
  `limiterStereoLink` field and copies it into transient/release links — a v20 migration
  implemented inside a normaliser. `Command.detail` exists precisely for _"silently cleaned something
  up"_ (`src/store/ProjectStore.ts:123-127`), but normaliser clamps are **not** routed into it.
- **Evidence:** `src/project-model/schema.ts` (`normalizeProject` and its domain clamps);
  `src/store/ProjectStore.ts:235, 264, 381, 414, 100-104`.
- **Root-cause hypothesis:** the normaliser grew from a load-time repair routine into a
  per-command invariant enforcer, keeping its silent-clamp semantics.
- **Smallest safe repair:** have the normaliser collect what it changed and surface it through
  `Command.detail` (the mechanism already exists).
- **Regression plan:** a spec asserting that an out-of-range set reports the clamp in `detail`.
- **REPAIR (2026-10-27, ADR 0069).** The disclosure now travels **on the command** and lands in
  `Command.detail` — the toast's channel. Two producers feed it, because the measured reachable
  silent clamps live in two places, not one:
  - the **command layer** — the clamp helpers (`clampEffectParam`, `clampInstrumentParam`,
    `clampTargetValue`, the output trim) take an optional sink and the command factories attach
    the events to the command (`Command.clamps`). This is the clamp the audit never named: the
    command clamps _before_ the normaliser sees the document, so on the parameter path the
    normaliser has nothing left to clamp.
  - the **normaliser's footprint** — `normalizeProject` returns the _same object_ when it changed
    nothing, so the store compares the document the command produced with the one the normaliser
    returned (`src/store/clampRepairs.ts`). The difference between the two IS the normaliser's
    footprint and nothing else. Measured: a legal write, an out-of-range parameter write and a
    track creation leave a footprint of **zero** ops; an out-of-range master write leaves exactly
    the three clamped fields. **No noise on the common path.**
  > **Correction to the audit text.** The prescription above ("have the normaliser collect what it
  > changed") is necessary but not sufficient: it names only one of the two producers, and the
  > one it names is the one that is silent on the parameter path. `setMasterConfig` — which the
  > audit's master-family examples point at — does **not** clamp at all, so there the normaliser is
  > the only clamp; every other parameter family clamps in the command. The repair therefore reads
  > the normaliser's footprint from the document **and** instruments the command layer.
  > The MCP keeps its own per-tool disclosure (`clamped: boolean`, `requestedValue` vs `value` —
  > already correct) and gains the command-level disclosure in its answer text. The UI's own
  > range enforcement stays (a typed value snaps to the control's range, the conventional
  > behaviour); the command-layer report covers the API / script / agent callers.

---

### F-13 — `migrateProject` is not a migration

**Severity:** Medium · **Confidence:** Confirmed

- **Affected journey:** opening a project written by an older build.
- **Authoritative state:** `SCHEMA_VERSION` + `migrateProject`.
- **Expected contract:** a version bump implies version-conditional transformation.
- **Observed divergence:** `migrateProject` accepts any version ≤ `SCHEMA_VERSION`, **never branches
  on the source version**, and only stamps the version and normalises. The entire per-version
  history is a **comment block** (`src/project-model/schema.ts:3534-3589`), starting at v3 — v1/v2
  have no documented provenance. The project log states the intent outright: _"SCHEMA_VERSION
  discriminates nothing today (compatibility = normalizeProject)"_.
- **Why this matters now:** the path is _total_ (every version is accepted), so nothing breaks — but
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

**Severity:** Medium (was) · **Status:** **RESOLVED in the working tree** · **Confidence:** Confirmed — and the fix is _measured by the repo's own spec_

> **Audit update — duplicate-guard scan (§5.8).** `tests/recovery-overwrite.test.ts` pins this
> behaviour, and the code now implements it. The fix landed in the same commit as F-04's
> (`9d2fc17c`, 2026-10-25 14:19:56) — six minutes before this report's own last commit. **All three
> failure modes this finding named are closed.**

- **What was wrong (before the fix):** the recovery path cast without validating —
  `const doc = buffer.doc as ProjectDocument` — then wrote it straight into the project store and
  entered the studio with it (`src/ui/ProjectBrowser.tsx:392-399`). `ProjectRepository.save`
  performed **no shape validation and no migration** (`src/persistence/ProjectRepository.ts:50-62`);
  migration ran only on load (`:69`). Consequently: (a) the recovered in-memory document kept its
  old `schemaVersion` and that stale version was written back to disk verbatim; (b) a buffer that
  passed the reader's shallow check but was structurally broken was written into the `projects`
  store and then became **invisible** — `listAll` skips records failing `validateProjectShape`
  (`ProjectRepository.ts:96-98`) and `listIncompatible` only lists `schemaVersion > SCHEMA_VERSION`
  (`:106-113`). The user was told _"Recovered"_; the project was gone at the next boot.
- **What it is now:**
  - `prepareRecoveredDocument(buffer): RecoveryVerdict` (`src/persistence/recoveryBuffer.ts:267-289`)
    decides **before** anything is written: it refuses a shape that does not validate (`:268-272`),
    refuses a buffer belonging to a **different project** (`:275-279`), **migrates** an older schema
    (`:281-282`), and refuses a document written by a **newer** KYX (`:283-288`).
  - `recoverProject(target, buffer)` (`:301-304`) returns that verdict and **writes only on
    `ok`** — and the file states it plainly: _"The refusal path never writes: the saved body stays
    exactly as it was, and the buffer stays in place so the work is not thrown away"_
    (`:296-300`).
  - The verdict carries a **reason string** (`:246`), so the refusal can be shown to the user
    instead of a silent "Recovered".
- **Smallest safe repair:** none needed — this is the repair, and it is already in the tree.
- **Regression plan:** the repo's own spec covers it. Nothing further is required from this audit.

---

### F-15 — Three different notions of "when did this save"

**Severity:** Low-Medium · **Confidence:** Confirmed

- **Affected journey:** reading a timestamp from the app vs. from the library vs. from an exported
  report.
- **Observed divergence:** `ProjectRepository.save` stamps `updatedAt` on a **shallow copy**
  (`src/persistence/ProjectRepository.ts:52`) — the in-memory document keeps the previous value.
  `setSaveStatus("saved")` stamps a _separate_ `lastSavedAt_` (`src/store/ProjectStore.ts:233`).
  The library list shows the stored `updatedAt`; the TopBar shows `lastSavedAt`; anything reading
  `doc.updatedAt` from the live document (export reports, share payloads) sees the **previous
  save's** timestamp.
- **Class:** unit/semantic drift — the same concept, three representations, no single owner.
- **Smallest safe repair:** make the store's `lastSavedAt` the single in-memory authority and have
  the repository stamp the same value, rather than each deriving its own.
- **Regression plan:** a spec asserting the three timestamps agree after a save.

---

### F-16 — Collab local edits skip normalisation (solo ≠ collab document shape)

**Severity:** Medium-High (was Low-Medium) · **Confidence:** **Confirmed — MEASURED** (§5.9, probe T10)

- **Affected journey:** two people edit the same project in a collab session; the session ends (or
  the project is exported); the wet/dry the user hears changes under them.
- **Observed divergence:** `YDocStore` re-projects with `normalize = false` for local-origin edits
  (`src/collab/YDocStore.ts:151-155` — `this.doc_ = this.readDoc(origin !== this)`), and its
  `execute()` path never normalises either (`src/collab/YDocStore.ts:407-415` — the command's raw
  output goes straight into the Y.Doc). `ProjectStore` normalises after every command
  (`src/store/ProjectStore.ts:287`). **The same command therefore yields a different document shape
  solo vs collab.**
- **MEASURED (§5.9, T10).** The same command — `setFxEqParam(..., "globalMix", 30)` — applied to a
  solo store and to a collab store built from the _same_ document:
  ```
  [T10a] CONTROL — the Yjs round-trip alone (no command) is identical to the normaliser's output: true
  [T10b] BEFORE  : {"mix":1,"globalMix":1}
  [T10b] SOLO    : {"mix":1,"globalMix":1}     ← the write was DISCARDED
  [T10b] COLLAB  : {"mix":1,"globalMix":30}    ← the write LANDED
  [T10b] SEMANTIC differences: ["$.tracks[0].effects[0].params.globalMix: solo=1 collab=30"]
  [T10c] in collab            : {"mix":1,"globalMix":30}
  [T10c] after leaving collab : {"mix":1,"globalMix":1}
  [T10c] the document CHANGES when the session ends: true
  [T10d] a carrier-free command (gain 0.42): differing paths — (none)
  ```
  **One field differs, and it is the DSP's wet/dry.** T10a is the control that rules out the Yjs
  round-trip as the cause, and T10d is the control that shows the divergence is **not generic**: a
  command whose output is already normalised produces an identical document in both paths.
- **THE COUPLING TO F-28 IS THE POINT.** In solo, the PRISM write-back is **discarded** by the
  normaliser (F-28: `normalizePluginParams` keeps `mix` as the source of truth and derives
  `globalMix` from it — `src/effects/definitions.ts:457-460`). **In collab the same write-back
  lands**, because the normaliser that discards it never runs. So **the Critical finding F-28
  behaves differently in the two modes**, and a fix for F-28 that only touches the solo path would
  leave the collab path untouched — and vice versa. T10c shows the consequence: the document the
  user sees in a collab session is **not** the document they get when the session ends; the
  normaliser rewrites it on the way out.
- **Class:** hard divergence between two control surfaces (solo UI vs a collab session) + **serialization
  drift** — the value changes across the session boundary, with no report to anyone.
- **Smallest safe repair:** normalise at the **export boundary** — which fixes the export asymmetry
  regardless of the store mode — and normalise on the collab local-origin path too, so the session's
  document and the saved document are the same object. Both are local changes; neither alters the
  audio character or the schema.
- **Regression plan:** promote probe T10. Assert (a) the same command produces the same document in
  a solo store and a collab store, and (b) normalising a collab document is a no-op.

---

### F-17 — Bypass is a structural removal, so un-bypass restarts the processor cold

**Severity:** Low · **Confidence:** Confirmed

- **Affected journey:** toggle bypass on a reverb/delay/compressor during playback.
- **Observed divergence:** `fxSignature` filters bypassed effects _out_
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
  `setParameter` (`src/effects/registry.ts:343-359`); several effect types return it when the module
  has not landed (`:1092-1094, 1110-1112`). The rack does surface a badge, but only via a 60 ms poll
  (`src/ui/EffectRack.tsx:242-244`). The knobs still read the document (`src/ui/EffectRack.tsx:969,
 1310`), so the user sees a parameter set that has no effect on the audio.
- **Smallest safe repair:** when the runtime is a passthrough, disable the knobs and say so in the
  control itself rather than in a polled badge.
- **REPAIR (2026-10-27).** The disclosure now sits **AT the controls**: the generic parameter grid
  and the quick controls render the engine's own reason in the same banner the flagship panels
  already use, and the device state chip reads **PASSTHROUGH** instead of ACTIVE (the audio passes
  through 1:1 — "ACTIVE" was a lie). **The knobs were deliberately NOT disabled** (the audit
  suggested it): a fallback runtime ignores the write, but the value stays in the project and
  applies when the module lands (the worklet refresh re-syncs the document), and the flagship
  panels keep their controls live in exactly the same situation. A disabled control would block a
  value the project keeps; the disclosure is what tells the truth.

---

### F-19 — The native compressor fallback ignores two documented parameters

**Severity:** Low · **Confidence:** Confirmed

- **Observed divergence:** `src/effects/registry.ts:979-981` —
  `case "detector": case "scHpf": break; // no native equivalent — parameter stays stored`.
  The worklet path honours them (`:949`). The UI shows DETECTOR and SC HPF knobs
  (`src/effects/definitions.ts:851, 819`) that do nothing until the module loads.
- **Smallest safe repair:** hide or disable the two knobs when the native fallback is active.

---

### F-20 — Unit conversions are duplicated across owners

**Severity:** Low · **Confidence:** Confirmed

- **Observed divergence:** dB→linear exists twice — `src/effects/scale-bridges.ts:32`
  `dbToLinearGain` vs `src/effects/registry.ts:162` `dbToLin` (used 13× across
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

**Severity:** Low · **Confidence:** Hypothesis — **NOT REPRODUCED** by the §5.7 probe (T9)

- **Observed divergence:** `ProjectStore.undo()` never consults `frameCommands`, while
  `endUndoFrame()` builds the compound command from `frameCommands`, which still contains the
  undone command. `jumpTo` seals the frame first (`src/store/ProjectStore.ts:461`) — the codebase
  knows this hazard — but `undo()` does not. With ≥3 commands in a frame and one undo, the
  compound's `execute` re-applies the undone command on redo and its `undo` applies that command's
  undo twice.
- **Not confirmed** by execution: no test covers undo-inside-a-frame
  (`tests/commands-edge-cases.test.ts:194-218` covers the happy path only).
- **MEASURED AND NOT REPRODUCED (audit correction, §5.7 T9).** The probe opened a frame, ran three
  commands on three different tracks, pressed undo **inside** the frame, sealed it, and then pressed
  the frame's single Ctrl+Z:
  ```
  [T9] inside the frame            : 0.11 0.22 0.33
  [T9] after the undo inside the frame: 0.11 0.22 0.85     ← the third command reverted
  [T9] stack length after the inner undo: 2
  [T9] after endUndoFrame           : 0.11 0.22 0.85
  [T9] stack length after the seal  : 1                   ← collapsed to ONE entry
  [T9] after the frame's single Ctrl+Z: 0.9 0.85 0.85     ← the BASELINE, exactly
  ```
  The frame's undo restored the baseline **exactly** — no resurrection, no partial revert. The reason
  is visible in the code: `endUndoFrame` computes `grew = undoStack.length − frameOpenDepth`
  (`src/store/ProjectStore.ts:414`) and the inner undo already reduced that count, so the compound
  was built from a **shorter** command list than the frame recorded. §5.7 T9b confirms the
  underlying mechanism _does_ exist — the compound's undo re-runs a command that was already undone
  inside the frame — but for the commands exercised (snapshot-based) that re-run is idempotent and
  changes nothing.
- **So the finding is narrowed, not dismissed:** the hazard is real in the _mechanism_ but it needs a
  **value-addressed** command (an automation point's undo removes "one instance of that
  (tick, value)" — `src/commands/automation.ts:107`) **and** a duplicate point to remove twice
  (F-07). That combination was not exercised here.
- **Smallest safe repair:** have `undo()` seal or reconcile the open frame, exactly as `jumpTo`
  does.

---

### F-23 — The onset cache is keyed by buffer id, not by content

**Severity:** Low · **Confidence:** Hypothesis (currently unreachable)

- `getWarpOnsets` keys on `warpOnsetKey(bufferId, sourceChannel)`
  (`src/ui/ArrangementPanel.tsx:291`) and caches indefinitely with a FIFO cap (`:305-308`). If a
  buffer's _content_ were replaced under an existing id, the drawn onset dots would go stale.
- No producer currently reuses an id with new content (`recordedTakeSampleId` is per-session), so
  this is a landmine rather than a live defect. The async result _is_ correctly guarded against
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

### F-25 — A delayed older write overwrites a newer one: the ordering semantics are _last-APPLIED-wins_

**Severity:** Medium-High · **Confidence:** Confirmed — **measured** (§5.2, probe T2)

- **Affected journey:** the AI issues a write; a human edits **the same field** before the AI's
  command is applied; the AI's command then lands.
- **Authoritative state:** `ProjectStore.doc_`.
- **Expected contract:** either the later _intent_ wins, or the conflict is reported. The mission
  brief's own probe wording is _"apply A then B, including delayed A acknowledgement; ensure B wins
  under defined semantics"_ — so what matters is that the semantics are **defined and disclosed**.
- **Observed divergence — measured.** The probe drives the real MCP surface with a context whose
  `execute` defers the command, which is exactly "A's acknowledgement is late":
  ```
  [T2] A text: nothing changed (the document is identical); no undo step — reported: Drums: gain 0.500 (-6.0 dB)
  [T2] B applied: gain=0.9
  [T2] final gain=0.5
  [T2] VERDICT: the OLDER, late-acknowledged intent wins (last APPLIED wins)
  ```
  **The human's newer value (0.9) is overwritten by the older AI intent (0.5).**
  The _other_ half of the probe is the good news and is worth stating explicitly:
  ```
  [T2] B applied: pan=-0.7
  [T2] final gain=0.5 pan=-0.7
  [T2] VERDICT: a late acknowledgement does NOT revert an unrelated field
  ```
  The delta snapshot (`src/commands/core.ts:34-45`) correctly preserves a human edit to a
  **different** field. The exposure is confined to the **same** field, where there is no version,
  no expected-revision guard, and no conflict signal — `ProjectDocument` has no revision field
  (`src/project-model/types.ts:1405-1445` — the interface ends at `updatedAt`; there is no revision
  field) and `ProjectStore.execute` takes no expected-version argument
  (`src/store/ProjectStore.ts:268`).
- **Root-cause hypothesis:** last-write-wins is the documented design for _field-level_ safety, but
  the design never addressed **intent age**. A write that was _issued_ first and _applied_ last wins,
  and the AI's acknowledgement does not say so.
- **Smallest safe repair:** two independent steps, in increasing cost.
  1. _Cheap, no schema change:_ the AI's acknowledgement should name the value it set **and** say
     when it was applied over a newer value. The R-02 gate already re-reads the document — it has
     the information it needs to say "applied 0.5 over a newer 0.9".
  2. _Correct:_ a monotonic document revision counter, and an MCP write path that compares the
     revision the tool computed against the current one, refusing or flagging a stale write.
- **Regression plan:** probe T2 is the test — promote it into `tests/`, and assert the documented
  precedence (whatever the ADR chooses) rather than the accidental one.

---

### F-26 — The new R-02 verification gate silently assumes `ctx.execute` is synchronous

**Severity:** Medium · **Confidence:** Confirmed — **measured** (§5.2, probe T5) · **NOT live today**

- **Affected journey:** any MCP host whose `execute` does not apply the command inline.
- **Authoritative state:** the gate's own verdict.
- **Expected contract:** a mutation that happens is reported as a mutation.
- **Observed divergence — measured.** The R-02 gate takes the document from _before_ the handler
  and the document from _after_ it, and concludes "nothing changed" when they are identical
  (`src/mcp/verified-mutation.ts:82-87`). If the host's `execute` defers the command, the document is
  identical at that moment — so the gate answers **"nothing changed (the document is identical)"**
  with `mutated: false`, and the mutation lands _afterwards_:
  ```
  [T5] text                 : nothing changed (the document is identical); no undo step — reported: Drums: gain 0.500 (-6.0 dB)
  [T5] mutated              : false
  [T5] document changed yet : false
  [T5] commands queued      : 1
  [T5] gain after the flush : 0.5
  ```
  The gate's answer was **wrong at the moment it was returned**. A whole-surface truth gate failing
  _open_ — reporting "nothing changed" for a change that did happen — is worse than no gate, because
  it is trusted.
- **Not live today:** all three real hosts apply the command inline —
  `src/mcp/web-host.ts:77`, `src/mcp/desktop-host.ts:58`, `src/mcp/headless-host.ts` (`:76`).
- **Why it matters anyway:** the precondition is **not enforced by the type**. The contract is
  `execute(command: Command): void` (`src/mcp/tools.ts`, `McpToolContext`), and TypeScript lets a
  Promise-returning function satisfy a `void`-returning signature. A future _deferred_, _queued_,
  _collab-merged_ or _worker-backed_ host would compile cleanly and would silently turn every
  mutation into "nothing changed".
- **Smallest safe repair:** make the precondition explicit and checked. Options: (a) change the
  contract so `execute` returns the committed document revision, and have the gate compare
  revisions rather than object identity; or (b) have the gate wait for the undo-depth to settle; or
  (c) at minimum, document the precondition on `McpToolContext.execute` and add a lint/test that
  asserts every host's `execute` applies the command synchronously.
- **Regression plan:** probe T5 is the test. It should be promoted into `tests/` and inverted into
  a guard: every registered MCP host's `execute` must apply the command inline.

---

### F-27 — Closing and reopening a plugin instance resets its parameters to the factory defaults, and mints a new id

**Severity:** Low-Medium · **Confidence:** Confirmed — **measured** (§5.2, probe T3)

- **Affected journey:** remove an effect instance and add one back.
- **Authoritative state:** `EffectInstance.params` and `EffectInstance.id`.
- **Expected contract:** a reopened instance is a _new_ instance; whether it should inherit the old
  settings is a product decision — but the outcome must not be silent.
- **Observed divergence — measured:**
  ```
  [T3] before close: {"decay":0.42,"predelay":20,"tone":9000,"damping":6000,"diffusion":0.5,"mod":0.35,"mix":0.3}
  [T3] after reopen: {"decay":1.8,"predelay":20,"tone":9000,"damping":6000,"diffusion":0.5,"mod":0.35,"mix":0.3}
  [T3] fxId changed: fx-28ed07b8-… -> fx-d2094d6e-…
  [T3] tuned value lost: 0.42 -> 1.8
  ```
  The removal is undoable, so the user's work is recoverable — this is **not** lost work. The two
  consequences that matter are: (a) the _audible_ settings snap back to the factory defaults with no
  on-screen notice; (b) **the instance id changes**, which invalidates every AI-held reference to
  the old instance — and that is precisely the condition under which F-08's ordinal fallback
  silently redirects a later write to the _wrong_ instance.
- **Evidence:** measurement above; `src/commands/tracks.ts` — `addEffectToTracks` /
  `removeEffectFromTracks`.
- **Smallest safe repair:** no change to the reset itself — a new instance _should_ start at
  defaults. The fix is disclosure on the AI surface: `kyx_fx` add should say it created a _new_
  instance at factory defaults, and an AI holding a stale `fxId` should be told the instance was
  replaced rather than silently falling back to an ordinal.

---

### F-28 — The PRISM in-plugin undo moves the DSP but the document write-back is normalised away: a **second writer** whose value is discarded

**Severity:** **CRITICAL** · **Confidence:** Confirmed — **measured** (§5.3, probe T6)

This is the finding the audit's own §10.3 item 13 flagged as unverified — _"does anything ever write
back into the document from the DSP?"_ **It does.** This is the first **second writer** found, and it
is the only finding that breaks the product's own central contract.

- **Affected journey:** open a PRISM (fxeq) instance → drag the MIX → press the panel's **↶ Undo**
  button → listen, then save, reload, or press Ctrl+Z.
- **Authoritative state:** `EffectInstance.params`. **Second writer:** the DSP core, via the panel.
- **Expected contract:** one musical intent → one authoritative transition → consistent observable
  representations. Here the intent produces **two** transitions, and the normaliser throws the
  second one away.
- **The chain, as read in the source:**
  1. `src/ui/FxEqPanel.tsx:219-227` — the panel's Undo/Redo calls
     `onParam(entry.id, entry.value)`, where `entry` came from the **core**.
  2. `src/effects/fxeqNode.ts:249-250` — the node's own comment states the intent: _"the restored
     entry arrives asynchronously via the callback so the host can write it through."_ The write-back
     is **deliberate design**, not an accident.
  3. `src/ui/EffectRack.tsx:1119` — `onParam` → `store.execute(setFxEqParam(doc, trackId, fxId, fullId, value))`.
  4. `src/effects/fxeq-core/core/fxEqProcessor.ts:747-756` — the core's `undo()` **already applied**
     the restored value to the live DSP (`values[entry.id] = entry.value`; and `values["globalMix"]`
     _is_ the audible wet/dry — `:591`), then returned the **core** id (`globalMix`) and the **core**
     value (0..100).
  5. `src/effects/definitions.ts:457-460` — `normalizePluginParams` **overwrites** `params.globalMix`
     with `params.mix`, because the rack id is the source of truth.
  6. `src/project-model/schema.ts:797` — the normaliser runs on **every** command execute.
  7. `src/audio-engine/AudioEngine.ts:1620-1625` — `syncFxParams` pushes only keys that **differ**
     from the cache, so an unchanged document means **nothing is pushed** and the core keeps its
     undone value.
- **MEASURED (probe T6, using the vendored core and the real normalisation path):**
  ```
  [T6] core after the drag : 30  (wet/dry 0.3)
  [T6] core after the undo : 100  (wet/dry 1)
  [T6] core undo entry     : {"id":"globalMix","value":100}
  [T6] doc before: mix=0.3 globalMix=0.3
  [T6] doc after write-back: mix=0.3 globalMix=0.3
  [T6] document changed at all: false
  [T6] params the engine would push: []
  [T6] DOCUMENT wet/dry: 0.3   DSP wet/dry: 1
  [T6] RELOADED project wet/dry: 0.3  (live session: 1)
  [T6] after Ctrl+Z the document content is unchanged: true
  ```
- **Three consequences, all measured:**
  1. **Hard divergence.** The DSP plays wet/dry **1.0**; the document — and the MIX knob the user is
     looking at — says **0.3**. Nothing is wrong on screen; everything is wrong in the audio.
  2. **The project does not reproduce the session.** A reload rebuilds the effect from the document
     (0.3), so **saving and reloading changes what you hear**. This breaks invariant **I-4**, and it
     breaks it in the loudest possible way: the sound is not the same after a save.
  3. **A dead undo step.** The document's _content_ did not change, yet the undo stack grew by one.
     Ctrl+Z consumes that step and changes nothing — a dead Ctrl+Z.
- **Reachability:** `src/ui/FxEqPanel.tsx:730-738` — a plain `<button>` with
  `aria-label="Undo PRISM parameter edit"`, **never disabled**, wired to `undoParam`. Any user with
  the PRISM panel open can hit it.
- **Root cause — precise and small:** a **canonical-id mismatch at the host boundary.** The core
  speaks **core** ids and units (`globalMix`, 0..100); the rack and the document speak **rack** ids
  and units (`mix`, 0..1). `src/effects/fxeqNode.ts:16-21` provides `RACK_TO_CORE` — a **one-way**
  map used on the way _in_ to the DSP. The write-back path needs the **inverse** (core id → rack id,
  core value → rack value) and does not have it, so it writes a core id into a rack-owned field and
  the normaliser resolves the conflict in favour of the rack — discarding the write.
- **Blast radius today:** PRISM only — `undoParam`/`redoParam` exist in `src/ui/FxEqPanel.tsx` alone
  (the other flagship panels have no in-plugin history button). But the _class_ is open: any future
  plugin with an in-plugin history inherits the same one-way map.
- **Smallest safe repair:** add the inverse map next to `RACK_TO_CORE` in `src/effects/fxeqNode.ts`
  (`toRackId`, and the inverse of `mix01ToPercent100`), and translate the write-back in
  `FxEqPanel.tsx:220-227` before it reaches `onParam` — so the document receives the rack id and the
  rack value. Then the normalisation alias (`definitions.ts:417`) stops fighting the write-back,
  because the write-back would now arrive _as_ `mix`.
- **Regression plan:** probe T6 is the test. Promote it into `tests/` and assert three things: the
  document's `mix` changes to the undone value; the document and the core agree; and a reload
  reproduces the same wet/dry.

---

### F-29 — The automation-point undo is POSITIONAL, so a shifted lane makes the AI's undo destroy the human's point

**Severity:** High · **Confidence:** Confirmed — **measured** (§5.7, probe T7)

- **Affected journey:** the human authors an automation point; the AI writes another point into the
  same lane; the user undoes.
- **Observed divergence:** a lane point carries **no identity** — `AutomationPoint` is
  `{ tick, value }` (`src/project-model/types.ts:1019-1022`), with no id. The command layer therefore
  _cannot_ address a point by identity, and the undo delta it builds is **positional**:
  `diffPlainArray` — "Lists of primitives or plain objects without ids (rows, points, tags…)"
  (`src/commands/docDelta.ts:227-241`) — diffs the points array **by index**. The `del` op even
  _carries_ the point it removed, but `applyOp` splices **whatever occupies that index now** and
  never compares it (`src/commands/docDelta.ts:309-313`).
- **Measured (§5.7 T7a–T7d):**
  ```
  [T7a] point own keys : ["tick","value"]      (has an id? false)
  [T7b] backward ops   : [{"k":"del","path":[...,"points",0],"removed":{...}}]
  [T7c] after the human      : [{"tick":0,"value":0.9}]
  [T7c] after the AI landed  : [{"tick":0,"value":0.9},{"tick":5760,"value":0.5}]
  [T7c] after the AI's undo  : [{"tick":5760,"value":0.5}]
  [T7c] the HUMAN's point was deleted by the AI's undo: true
  [T7c] the AI's own point SURVIVED the AI's undo     : true
  ```
  The AI's undo removed the **human's** point and left the **AI's** point standing — the exact
  inverse of what the undo label claims. The human's authored work is gone.
- **A dead undo step follows.** The human's own command is still on the stack, but its undo searches
  for "one instance of that (tick, value)" (`src/commands/automation.ts:107`) and no longer finds it —
  so the next Ctrl+Z changes nothing while consuming a history entry (the same dead-step class as
  F-28).
- **The window is precisely scoped — the plain stack order is SAFE.** Probe T7d is the control: with
  a synchronous dispatch the human's command sits _above_ the AI's on the stack, so its undo runs
  first and the lane is back in the shape the delta was computed against before the AI's undo runs.
  The damage requires the lane's array to shift **between the command and its undo**. One such
  window is already a finding in this report: **F-26** — the MCP host contract does not require
  `ctx.execute` to be synchronous, and the R-02 gate's verdict depends on it. The others are a
  collab merge and a point moved since the command was issued.
- **Class:** write conflict → **silent loss of authored work.** It breaks invariant I-4 (undo/redo
  restores all logically coupled values) and, through F-26, it makes a deferred AI write
  _destructive_ rather than merely mis-acknowledged.
- **Root cause — precise and small:** the undo of an identity-less object must be **value-checked**.
  The smallest safe repair is to make the point's undo verify that the slot it is about to remove
  still holds the point it created: if `points[index]` no longer matches the captured
  `{tick, value}`, the undo must refuse (and report) rather than splice blindly. That is a local
  change in `src/commands/docDelta.ts` / `src/commands/automation.ts` — no schema change, no audio
  change, no migration.
- **AUDIT UPDATE (§5.8) — THE FIX PATTERN ALREADY EXISTS IN THIS CODEBASE; ONE PATH WAS MISSED.**
  The duplicate-guard scan found `tests/automation-audit.test.ts` (audit 06 — _"index-shift-tolerant
  point ops (D3)"_), which pins that **`moveAutomationPoint` already tolerates a shifted index**:
  _"move tolerates a shifted index by re-anchoring on the captured point"_ (`:91-110`) — a collab peer
  prepends a point, the captured index shifts, and the move must still move _B_, not the wrong point.
  The source says why, in the codebase's own words (`src/commands/automation.ts:128-131`):

  > _Audit 06 D3: re-anchor by IDENTITY, then by (tick, value) — the index was validated against the
  > FACTORY doc only; a collab peer shifting the array used to make points[index] undefined
  > (TypeError) or move the WRONG point._

  **`addAutomationPoint.undo` (`:91-99`) never received that treatment** — it resolves by
  `(tick, value)` only, with no identity re-anchor and no index check. So F-29 is not a new
  mechanism and not a new insight: **it is the sibling call that was missed when the first one was
  fixed.** The repair is to apply D3's re-anchoring to the add's undo — and the regression test
  already exists in spirit, in the same spec file, for the other command.

- **Regression plan:** probe T7c is the test. Promote it and assert that the human's point survives
  the AI's undo, and that the AI's point is the one removed.

---

### 4.1 Divergence scenario matrix

The scenario catalogue from the mission brief, each traced request-to-effect. **Observed** means the
divergence was measured or read directly; **Untested** means the scenario is supported by the
product but no probe or test in this audit exercised it.

#### A. Human / AI contention

| Scenario                                                                        | Trigger                                                       | Expected invariant                                                        | Observed / untested                                                                                                              | Evidence                                                                                                                         | Risk                 | Proposed test                                                                                                                |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Human moves a plugin slider while the AI issues a parameter update              | both target the same `fxId`                                   | the later write wins; both writers see the same document                  | **Observed** — last-write-wins, no version, no conflict signal; the AI's read-back is truthful but the human gets no notice      | `src/store/ProjectStore.ts:268` (`execute` takes no expected version); `src/project-model/types.ts:1405-1445` (`updatedAt` only) | medium               | apply an AI write, assert the human's UI re-reads the new value and that the AI's ack carries the value that actually landed |
| Two intents target the same track/clip using stale IDs                          | the human deleted the clip; the AI holds the old id           | a typed, machine-detectable refusal                                       | **Observed** — mostly typed (`UNKNOWN_TARGET`) and correct; **but** the ordinal fallbacks redirect the write instead of refusing | `src/mcp/tools.ts` — typed path at `:10074-10087`; ordinal fallback in the A/B restore and the instance resolvers                | high (F-08)          | delete the saved instance, add a different one of the same type, assert the restore refuses or discloses the substitution    |
| A command acknowledges before the queued audio update is applied                | a parameter write returns while the scheduler has not yet run | the ack says "pending", or the audio catches up within a documented bound | **Observed, contract-compliant** — the lag is bounded and documented (scheduler tick 25 ms, smoothing 8–20 ms)                   | `src/scheduler/Scheduler.ts:149`; `src/audio-engine/automationBridge.ts:1298-1303`                                               | low — _not a defect_ | assert the applied value reaches 95 % of the commanded value within 3 × tc                                                   |
| Tool output claims success though the command failed or was rejected            | an AI call on a stale target                                  | `isError` + a typed code                                                  | **Observed — diverges.** `kyx_automation` returns a refusal as a **non-error** result                                            | `src/mcp/tools.ts:7865`; measured §5.2                                                                                           | high (F-05)          | the meta-test: every mutating tool's refusal sets `isError` and a code from the taxonomy                                     |
| A human edits between an AI's call and its retry (same `requestId`)             | the AI retries a timed-out call                               | the retry reports the document's current value                            | **Observed — diverges.** The replay serves the _first_ call's read-back                                                          | `src/mcp/tools.ts:4394` (returns) vs `:4471` (the gate); measured §5.2                                                           | high (F-06)          | edit, retry the same `requestId`, assert the reported value equals the document's current value                              |
| The AI's write is acknowledged late, after the human has edited the same field  | the AI's command is applied after the human's                 | the later _intent_ wins, or the conflict is reported                      | **Observed — diverges.** The later-_applied_ write wins: the human's 0.9 is overwritten by the AI's older 0.5                    | measured §5.3 (T2); no revision field (`src/project-model/types.ts:1405-1445`)                                                   | high (F-25)          | already measured — assert the documented precedence instead of the accidental one                                            |
| The AI's write is acknowledged late, after the human edited a _different_ field | same, different field                                         | the human's unrelated edit survives                                       | **Observed — holds.** The delta snapshot preserves it                                                                            | measured §5.3 (T2); `src/commands/core.ts:34-45`                                                                                 | low                  | —                                                                                                                            |

#### B. Editing and history

| Scenario                                                                      | Trigger                                           | Expected invariant                                   | Observed / untested                                                                | Evidence                                                                     | Risk          | Proposed test                                                                                               |
| ----------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| Trim / move / fade followed by undo/redo during playback                      | the gesture is committed while the transport runs | undo restores every coupled value; the audio follows | **Observed** — the delta round-trip is exact; the engine resyncs on the doc change | probe P2/P3 (4 shapes, 0 fallbacks); `src/commands/docDelta.ts`              | low           | extend the battery to entity reordering and instrument creation (the 2 shapes this audit could not measure) |
| Rapid consecutive changes coalesced in history, only partially restored       | a drag gesture coalesces within the window        | the coalesced entry restores the pre-gesture state   | **Observed** — the coalesce branch keeps the original before-snapshot              | `src/store/ProjectStore.ts:248-275`                                          | low           | coalesce a gesture, undo once, assert the pre-gesture state                                                 |
| Drag preview cancelled or interrupted, leaving domain state modified          | the pointer is released outside the target        | the domain is untouched                              | **Untested** — not exercised by this audit                                         | `src/ui/ArrangementPanel.tsx`                                                | medium        | cancel a drag mid-flight and assert the document is byte-identical                                          |
| Track/clip removal while dependent selections or automation references remain | the human deletes a track that has lanes          | the references are invalidated cleanly               | **Observed** — `deleteTrack` cleans cross-references; the undo round-trips         | probe P2 (`deleteTrack`); `tests/delete-track-undo-cross-references.test.ts` | low           | —                                                                                                           |
| Undo while a previous write or background load is in flight                   | undo during an open undo frame                    | the undone command is not resurrected on redo        | **Untested / Strongly indicated** — `undo()` never consults `frameCommands`        | `src/store/ProjectStore.ts:358-389, 366-409, 432`                            | medium (F-22) | build a ≥3-command frame, undo inside it, redo, assert the undone command does not return                   |

#### C. Audio engine and plugin synchronization

| Scenario                                                               | Trigger                                                       | Expected invariant                                         | Observed / untested                                                                                                                                                                                                                                | Evidence                                                                                                                        | Risk                                                                                | Proposed test                                                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Bypass toggled in the UI but not in the DSP                            | the user clicks bypass                                        | the effect is audibly bypassed                             | **Observed — diverges in kind.** Bypass is a _structural_ removal: the chain rebuilds, so processor state (tails, envelope, filter memory) is lost and the UI says ACTIVE                                                                          | `src/audio-engine/AudioEngine.ts:1190-1199, 1976-1981, 1364-1373`                                                               | medium (F-17)                                                                       | toggle bypass on a reverb with a long tail; assert the tail survives (listening)                                    |
| Parameter unit mapping mismatch (0–1 vs dB/Hz/ms/%)                    | the doc stores a normalized value, the DSP wants a native one | the same intent yields the same sound on every surface     | **Observed — two separate owners** for dB→linear, and percent-100 bridges hardcoded in 2 of 4 registered pairs                                                                                                                                     | `src/effects/scale-bridges.ts:32, 75-84` vs `src/effects/registry.ts:162`; `ozvenaNode.ts:143`; `morphDynamicsNode.ts:23`       | low today, **high if one is edited** (F-20)                                         | assert every `SCALE_BRIDGES` entry is the function the node actually calls (fails today for ozvena + morphdynamics) |
| A plugin preset restores UI fields but misses runtime processor values | a preset is applied                                           | the processor holds what the UI shows                      | **Observed — one candidate left open**: the parameter cache is seeded from the document and only pushes _differences_, so a factory that does not apply every parameter would leave it permanently unsent                                          | `src/audio-engine/AudioEngine.ts:1519, 1620-1625`                                                                               | medium — **not confirmed**; the shipped factories read appear to apply the full set | for every effect type, assert the runtime holds every document parameter after a rebuild                            |
| A plugin instance is closed and reopened                               | remove the effect, add it back                                | the instance state is preserved, or the reset is disclosed | **Observed — diverges.** The reopened instance starts at the **factory defaults** and mints a **new id**, invalidating every AI-held reference to the old one                                                                                      | measured §5.3 (T3)                                                                                                              | low-medium (F-27)                                                                   | assert the AI surface discloses the reset                                                                           |
| A plugin's in-plugin undo writes back into the document                | the user presses PRISM's ↶ Undo                               | the document, the UI and the DSP all show the undone value | **Observed — diverges, and it is the only second writer.** The DSP applies the undo and posts it back; the write arrives under the plugin's internal id (`globalMix`, 0..100) and the normaliser discards it in favour of the canonical id (`mix`) | **measured §5.3 (T6)**; `src/ui/FxEqPanel.tsx:219-227`; `src/effects/fxeqNode.ts:249-250`; `src/effects/definitions.ts:457-460` | **critical (F-28)**                                                                 | assert the document's `mix` changes, that document and core agree, and that a reload reproduces the same wet/dry    |
| Reordered effects change the render but the visual order stays stale   | the user drags an effect in the chain                         | the graph order and the visual order agree                 | **Observed — contract-compliant.** Doc order → signature → rebuild → serial connect                                                                                                                                                                | `src/audio-engine/AudioEngine.ts:1420, 1516-1517`; `src/commands/effectParams.ts:378-396`                                       | low                                                                                 | —                                                                                                                   |
| The audio thread reads unsafe mutable state                            | a param change during a render quantum                        | no torn multi-field transitions                            | **Observed — clean.** No I/O, logging or unbounded allocation in a processor callback; change-gated `postMessage`                                                                                                                                  | `src/audio-worklets/*`; `src/effects/fxeq-core/**`                                                                              | low                                                                                 | —                                                                                                                   |

#### D. Playback, recording and automation

| Scenario                                                                   | Trigger                                     | Expected invariant                     | Observed / untested                                                                                                                                      | Evidence                                                                                                                      | Risk                                 | Proposed test                                                                                                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport state / playhead differs from the engine state                   | the tab is hidden                           | the UI reflects the audio clock        | **Observed — diverges (display only).** rAF stops in a hidden tab; the transport does not                                                                | `src/services/rafLoop.ts:21`; `src/ui/playhead.ts:78-85`; `src/services.ts:1284-1289`                                         | low (F-21)                           | hide the tab, return, assert the playhead resyncs from the transport clock                                                                                        |
| Automation lane values disagree with the applied DSP values under playback | a lane is active                            | the knob shows what is playing         | **Observed — diverges.** The knob reads the document; the DSP plays the lane; no "under automation" cue exists                                           | `src/ui/EffectRack.tsx:969, 1310` vs `src/audio-engine/automationBridge.ts:1309`                                              | high (F-09)                          | assert the effective-value read model returns the lane value while a lane is active                                                                               |
| Recording stops unexpectedly while the UI remains armed/recording          | a device disconnect, or the transport stops | the indicator reflects reality         | **Observed — diverges.** The ⏺ stays lit; `captureTick()` returns `null` while stopped, so notes are silently discarded                                  | `src/ui/TopBar.tsx:158, 613`; `src/midi/patternRecorder.ts:131, 116-120`                                                      | high (F-02)                          | stop the transport, assert the indicator is not in the "recording" state                                                                                          |
| Async waveform/peak generation renders stale metadata as authoritative     | a buffer is replaced under the same id      | the drawn peaks match the buffer       | **Observed — guarded.** The async result is protected by a `live` flag; the _cache key_ is content-blind                                                 | `src/ui/ArrangementPanel.tsx:291, 299-303, 7008-7019`                                                                         | low (F-23, Hypothesis)               | replace a buffer's content under an existing id and assert the peaks are invalidated                                                                              |
| Automation playback overwrites the persistent baseline                     | the transport runs over a lane              | the document's value survives playback | **Observed — does NOT diverge.** Automation writes runtime only; `automationReset` restores the doc base                                                 | `src/audio-engine/deviceLookup.ts:133-156`; `src/audio-engine/automationBridge.ts:1459-1480`; `tests/scene-packs.test.ts:492` | low — _the classic defect is absent_ | —                                                                                                                                                                 |
| Track-gain lane value vs the gain actually heard                           | the fader is not at unity                   | the lane's value is the gain           | **Observed — the lane is a _multiplier_, correctly implemented, but labelled and scaled like an absolute "Volume"; no surface shows the composed value** | `src/audio-engine/automationBridge.ts:1208-1218, 1191-1210` vs `src/audio-engine/AudioEngine.ts:2016-2019`                    | medium (F-10)                        | **MEASURED (T4 + T4b)** — the graph is right; the _display_ is wrong. Fix = relabel + unity line + effective-value readout (S-5); **no ADR, no behaviour change** |

#### E. Persistence and recovery

| Scenario                                                             | Trigger                                             | Expected invariant                  | Observed / untested                                                                                                                                                                                                                                                                                                                  | Evidence                                                                                 | Risk                         | Proposed test                                                                                          |
| -------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| Save succeeds before all relevant state is serialized                | a save is clicked                                   | "saved" means durably written       | **Observed — contract-compliant.** The save captures the exact revision, compares identity after the await, and re-queues rather than reporting a stale revision                                                                                                                                                                     | `src/services.ts:1153, 1173-1179`; `tests/services-save-drain.test.ts`                   | low                          | —                                                                                                      |
| Autosave captures a partial command transaction                      | a gesture is in flight                              | the saved doc is a whole state      | **Observed — contract-compliant.** Debounce with a `maxDeferMs` / `maxArms` force-flush                                                                                                                                                                                                                                              | `src/persistence/autosave-debouncer.ts:100-129`                                          | low                          | —                                                                                                      |
| Recovery restores the arrangement but not routing/plugins/automation | the recovery buffer is restored                     | the same project comes back         | **RESOLVED in the working tree.** The buffer holds the whole document, but it is no longer written unvalidated and unmigrated: `prepareRecoveredDocument` validates the shape, refuses a foreign project, **migrates** an older schema and refuses a newer one; `recoverProject` writes only on `ok` and keeps the buffer on refusal | `src/persistence/recoveryBuffer.ts:267-289, 301-304`; `tests/recovery-overwrite.test.ts` | ~~high (F-14)~~ → **closed** | already covered by the repo's own spec                                                                 |
| A second dirty project destroys the first's only copy                | project A closed dirty, then project B closed dirty | A's uncommitted work survives       | **Observed — diverges.** One global slot; the write path is unscoped while the clear path is project-scoped                                                                                                                                                                                                                          | `src/persistence/recoveryBuffer.ts:25, 62, 116-126`                                      | high (F-04)                  | write a buffer for A, then for B; assert A's buffer is still readable                                  |
| Version migrations silently drop or reinterpret parameters           | an old project is opened                            | the migration is explicit and total | **Observed — diverges in kind.** `migrateProject` never branches on the source version; the history is a comment                                                                                                                                                                                                                     | `src/project-model/schema.ts:3528-3592`                                                  | medium (F-13)                | migrate from every version ≤ 38; assert the result equals today's `normalizeProject` of the same input |
| Export uses cached state that diverges from the session              | the project changes, then an export runs            | the export renders the session      | **Observed — diverges.** Stems/tracks capture the document at _render_ time and never re-check it; the master path does                                                                                                                                                                                                              | `src/ui/ExportPanel.tsx:259, 509-518, 835-872, 874+`; `src/mastering/report.ts:102-107`  | **high (F-01)**              | edit the arrangement, then export stems; assert the export refuses with the master's message           |

#### F. Async and lifecycle hazards

| Scenario                                                                     | Trigger                                             | Expected invariant                                   | Observed / untested                                                                                                                                                                                                                                                                                                                           | Evidence                                                                                                            | Risk                       | Proposed test                                                                                |
| ---------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------- |
| An old completion overwrites a newer intent                                  | two async results resolve out of order              | the newer result wins                                | **Observed — guarded** for the async onset path (`live` flag)                                                                                                                                                                                                                                                                                 | `src/ui/ArrangementPanel.tsx:7008-7019`                                                                             | low                        | —                                                                                            |
| Mounted/unmounted UI subscribers miss updates or recreate stale local copies | a panel mounts while the document changes           | the panel reads the current document                 | **Observed — diverges.** Fine-grained subscriptions mean an edit to an _unsubscribed_ slice does not re-render the consumer — which is exactly F-01's mechanism                                                                                                                                                                               | `src/ui/context.ts:85-138`; `src/project-model/schema.ts` (`normalizeProject` structural sharing)                   | **high (F-01)**            | mount `ExportPanel`, edit `doc.arrangement`, assert the panel's captured document is current |
| Worker restart / IPC interruption / plugin reload                            | a device is unplugged                               | the session recovers without lying                   | **Observed — contract-compliant for recording**: the recorder stops itself on device loss, the group stops every member before invoking `onFailure`, and the UI resets to idle                                                                                                                                                                | `src/audio-engine/PcmMicRecorder.ts:703-708, 716-721`; `PcmMicRecorderGroup.ts:245`                                 | low                        | —                                                                                            |
| A collab session's document differs from the saved one                       | the session ends, or the project is exported        | the document the user sees is the document they get  | **Observed — diverges.** The collab path re-projects local edits **without** normalisation, so the same command yields `params.globalMix = 1` solo and `30` in collab; normalising on the way out rewrites it. **The difference is the DSP's wet/dry**                                                                                        | `src/collab/YDocStore.ts:151-155, 391-399`; measured §5.9 (T10)                                                     | medium-high (F-16)         | already measured — assert one command yields one document in both store modes                |
| Browser refresh with unsaved work                                            | the tab is closed                                   | the work is recoverable                              | **Partly resolved.** The single global slot is gone — the buffer is now keyed per project. What survives: the synchronous recovery write's **result is discarded** at the call site, so a quota failure loses the unload edit with no signal, while the function's own doc comment claims the caller treats it as _"no protection this time"_ | `src/persistence/save-lifecycle.ts:86-103`; `src/persistence/recoveryBuffer.ts:73-75, 77`; `src/services.ts:1328`   | medium (F-04, second half) | assert the unload handler surfaces a failed buffer write                                     |
| Repeated command delivery is non-idempotent without dedup rules              | the AI retries an identical automation write        | the document does not accumulate duplicates          | **Observed — diverges.** The point count and the undo stack both grow                                                                                                                                                                                                                                                                         | measured §5.2; `src/project-model/automation.ts` (`insertPointSorted`)                                              | medium (F-07)              | already measured — assert `lane.points.length` stays 1 and the undo stack does not grow      |
| An AI undo removes the **human's** point                                     | the lane shifts between the AI's write and its undo | the undo removes the point the command created       | **Observed — diverges.** A point has no identity, so its undo is anchored to a _position_: the AI's undo removed the **human's** point and left the AI's, then the human's own undo became a dead step. The plain stack order is safe; the window is a shift between command and undo                                                         | measured §5.7 (T7c/T7d); `src/commands/automation.ts:105-113`; `src/commands/docDelta.ts:309-313`                   | high (F-29)                | already measured — apply audit 06 D3's identity re-anchoring to the add's undo               |
| A host that defers `ctx.execute`                                             | a queued, transactional or collab-backed store      | the acknowledgement describes what actually happened | **Observed — diverges (not live today).** The R-02 gate compares the document around the handler; with a deferred execute it answers _"nothing changed"_ for a mutation that lands afterwards. All three real hosts are synchronous, but the `void` type does not enforce it                                                                  | measured §5.3 (T5); `src/mcp/verified-mutation.ts`; hosts at `src/mcp/web-host.ts:77`, `src/mcp/desktop-host.ts:58` | medium (F-26)              | assert every registered MCP host applies the command inline                                  |

---

## 5. Reproduction and test outcomes

### 5.1 Probes executed

| Probe                                                   | Harness                             | Result                            | What it establishes                                                                                                                                                                 |
| ------------------------------------------------------- | ----------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tmp-divergence-probe.mts` (P1–P7)                      | `vite-node`                         | **PASS** — executed end-to-end    | 7 sub-probes, results below                                                                                                                                                         |
| `tmp-probe/f03.test.ts` (F-03, F-05, F-06, F-06b, F-07) | **vitest** (the repo's own harness) | **PASS — 5/5 tests green**        | the MCP ack contract, measured                                                                                                                                                      |
| `tmp-probe/scenarios.test.ts` (T1–T5)                   | **vitest**                          | **PASS — 8/8 tests green**        | the four mission probes the first pass could not run: A/B equivalence, ordering, lifecycle, and the graph-level audio truth for F-10 (incl. **T4b**, the multiplier-contract proof) |
| `tmp-probe/second-writer.test.ts` (T6)                  | **vitest**                          | **PASS**                          | the DSP→document write-back — the audit's first **Critical** finding (F-28)                                                                                                         |
| `tmp-probe/gaps.test.ts` (T7–T9)                        | **vitest**                          | **PASS — 7/7 tests green**        | the three probes §5.6 had left open: point-identity, mixer idempotency, undo-inside-a-frame — plus **F-29**                                                                         |
| `tmp-probe/collab.test.ts` (T10a–T10d)                  | **vitest**                          | **PASS — 4/4 green**              | the collab-vs-solo document shape — the last finding still resting on code reading alone. **F-16 → Confirmed and measured**                                                         |
| `tmp-probe/guard-scan.mjs`                              | **node**                            | **RUN — 1277 spec files scanned** | the duplicate-guard scan §5.5 promised: which of the 29 findings the repository's own tests already pin (§5.8)                                                                      |
| `tmp-probe/citation-check.mjs`                          | **node**                            | **RUN — 113 citations checked**   | every `file:line` in this report, verified against the current tree; four had drifted and were corrected, and the count was re-run after the F-10 correction pass                   |

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

### 5.3 Probe results — `tmp-probe/scenarios.test.ts` (vitest, **7/7 green**)

These are the four mission probes the first pass had to report as _not executed_. All four now ran.
The mock-AudioContext harness is the repository's own (`tests/mixer-audit3.test.ts`) — a recording
node whose `connect()` is captured, so the **graph topology** is asserted rather than guessed.

**T1 — A/B control equivalence (UI command path vs MCP tool path): PASS.**

```
[T1] MCP text: Drums: decay 1.8 → 0.42 — one undo step — read-back verified
[T1] domain UI  : {"decay":0.42,"predelay":20,"tone":9000,"damping":6000,"diffusion":0.5,"mod":0.35,"mix":0.3}
[T1] domain MCP : {"decay":0.42,"predelay":20,"tone":9000,"damping":6000,"diffusion":0.5,"mod":0.35,"mix":0.3}
[T1] dsp UI  : {"fx-a35de65d-…":{"decay":0.42,…,"mix":0.3,"__outputTrimDb":0}}
[T1] dsp MCP : {"fx-a35de65d-…":{"decay":0.42,…,"mix":0.3,"__outputTrimDb":0}}
```

The same effect parameter written through the **human command path** and through the **MCP tool
path** yields an identical domain map **and** an identical DSP parameter cache (the engine's
pushed-param map). The probe asserts the cache is non-empty, so the comparison cannot pass
vacuously. **Invariant I-2 holds at the value level** — this is the product's strongest contract.

**T2 — ordering with a delayed acknowledgement: the semantics are _last-APPLIED-wins_.**

```
[T2] B applied: pan=-0.7      →  final gain=0.5 pan=-0.7   (an UNRELATED field survives the late write)
[T2] B applied: gain=0.9      →  final gain=0.5             (the SAME field is overwritten by the OLDER intent)
```

→ **F-25.** The delta snapshot protects different fields; the same field has no ordering guarantee.

**T3 — lifecycle.**

```
[T3] document identical after reload : true
[T3] dsp session: {"fx-c3621a0d-…":{"decay":0.42,…}}
[T3] dsp loaded : {"fx-c3621a0d-…":{"decay":0.42,…}}      ← identical
[T3] tuned value lost: 0.42 -> 1.8 ; fxId changed: fx-28ed07b8-… -> fx-d2094d6e-…
```

Save → load → rehydrate reproduces **both** the document and the DSP state exactly. But closing and
reopening a plugin instance resets its parameters to the factory defaults and mints a new id
→ **F-27**.

**T4 — audio truth for F-10: MEASURED (and, in the correction pass, re-measured).**

```
[T4] fader (doc track.gain)      : 0.8
[T4] lane value written to DSP  : 0.5
[T4] fader -> modAutoGain is a SERIES connection: true
[T4] modAutoGain -> modMacroGain series: false
[T4] product (multiplicative)   : 0.4
[T4] lane is a MULTIPLIER (unity 1.0), NOT an absolute gain: true
[T4] VERDICT: modAutoGain is a MULTIPLY stage in series after the fader — the audible gain is 0.4 while the lane reads 0.5
```

**T4b — the multiplier contract, proven (added in the correction pass).**

```
[T4b] modulator amount 0.2 -> modAutoGain.gain = 1.2   (base 1 + v, clamped 0..1.5)
[T4b] trackGain lane default = 1, range 0..1.5
[T4b] after automationReset(): modAutoGain.gain = 1
```

→ **F-10 is Confirmed by measurement** — but the _verdict_ was corrected. The stage is a multiplier
around unity 1.0, and the code says so in three independent places (the modulator's `1 + v`, the lane's
default of 1, the reset to 1). The lane is therefore **correct**; what is wrong is its **label and the
missing effective-value readout**. See §4/F-10 for the full correction.

**T5 — the R-02 gate's hidden synchrony precondition.**

```
[T5] text                 : nothing changed (the document is identical); no undo step — reported: Drums: gain 0.500 (-6.0 dB)
[T5] mutated              : false
[T5] document changed yet : false
[T5] commands queued      : 1
[T5] gain after the flush : 0.5
```

→ **F-26.**

**T6 — the DSP write-back (the audit's first CRITICAL finding).**

```
[T6] core after the drag : 30  (wet/dry 0.3)
[T6] core after the undo : 100  (wet/dry 1)
[T6] core undo entry     : {"id":"globalMix","value":100}
[T6] doc before: mix=0.3 globalMix=0.3
[T6] doc after write-back: mix=0.3 globalMix=0.3
[T6] document changed at all: false
[T6] params the engine would push: []
[T6] DOCUMENT wet/dry: 0.3   DSP wet/dry: 1
[T6] RELOADED project wet/dry: 0.3  (live session: 1)
[T6] after Ctrl+Z the document content is unchanged: true
```

→ **F-28.** The DSP plays 1.0, the document and the knob say 0.3, a save + reload moves the sound
back to 0.3, and the project's undo stack carries a dead step.

### 5.4 Probe results — `tmp-divergence-probe.mts` (`vite-node`)

**P1 — A/B control equivalence (UI command path vs MCP tool path):**
**SKIPPED** — the `house` template seeds no effect instance, so the effect-parameter comparison had
no target. _Not a pass; not run._ (Re-run against a template that seeds effects, or seed one with
`addEffectToTracks` first.)

**P2/P3 — Undo roundtrip, dev path (verifier ON) vs production path (verifier OFF):**
The `snapshot()` helper in `src/commands/core.ts` verifies its delta in development and **falls back
to a whole-document command** if the delta does not round-trip. In production that verification is
compiled out, so the shipped build runs the delta path unchecked. The probe ran the same battery in
both regimes to see whether they diverge.

| case                    | dev undo  | dev redo | fallbacks | prod undo | prod redo | verdict  |
| ----------------------- | --------- | -------- | --------- | --------- | --------- | -------- |
| `setTrackColor`         | true      | true     | 0         | true      | true      | same     |
| `duplicateTrack`        | true      | true     | 0         | true      | true      | same     |
| `moveTrackAdjacent`     | _(threw)_ | —        | —         | —         | —         | see note |
| `addEffectToTracks`     | true      | true     | 0         | true      | true      | same     |
| `deleteTrack`           | true      | true     | 0         | true      | true      | same     |
| `createInstrumentTrack` | _(threw)_ | —        | —         | —         | —         | see note |

**Verdict: no divergence detected** — the dev path and the production path agree on every case
that ran, and **zero** delta fallbacks were triggered. This is a **pass** for the measured battery:
the dev-only verifier is not currently masking a delta defect in these shapes.
_Notes:_ two cases are reported as `threw` because the probe used guessed command signatures
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

| probe                       | `isError`               | `errorCode`         | doc changed |
| --------------------------- | ----------------------- | ------------------- | ----------- |
| plugin_param stale trackId  | `isError`               | `UNKNOWN_TARGET`    | false       |
| plugin_param stale fxId     | `isError`               | `UNKNOWN_TARGET`    | false       |
| plugin_param stale effect   | `isError`               | `UNKNOWN_TARGET`    | false       |
| plugin_param stale param    | `isError`               | `UNKNOWN_TARGET`    | false       |
| tracks setGain stale family | `isError`               | `UNKNOWN_TARGET`    | false       |
| **automation stale target** | **`ok` (not an error)** | **none**            | false       |
| clips stale clipId          | `isError`               | `UNKNOWN_TARGET`    | false       |
| notes stale noteId          | `isError`               | `UNKNOWN_TARGET`    | false       |
| fx remove absent effect     | `isError`               | `INVALID_ARGUMENTS` | false       |

_(The last row used `op` where the `kyx_fx` handler expects `action` — a probe-side error, not a
product finding. It is noted here because it is a minor **API inconsistency** in the tool surface:
`kyx_fx` reads `action`, most other tools read `op`, and the risk classifier accepts both.)_

**P6 — Idempotency:** **SKIPPED** — no effect instance in the `house` template (same cause as P1).
**Not a pass; not run.**

**P7 — Normalisation drift:** `normalizeProject(store.doc) === store.doc : **YES**` — **PASS**. The
store holds a canonical document; the normaliser is idempotent on it.

### 5.5 Repository suite — MEASURED on a clean baseline worktree

The first pass of this audit did not run the repository suite. **That gap is now closed**, measured
against a **clean baseline** rather than the dirty shared tree — `docs/MULTI-AGENT-GUARDRAILS.md`
rule 6 requires exactly that ("a full-suite run on a shared tree measures other waves' work in
progress, not the project").

**Method.** A detached worktree at the audited commit (`git worktree add ../pf-audit-baseline
20fbade7`), with `node_modules` and the gitignored binary assets (ONNX runtime, stem models, sample
packs) linked in — so the baseline is identical to the audited tree in source and complete in assets.
The audited commit `20fbade7` and the current tip `0b688bea` differ in **zero** non-`.md` files, so
this baseline measures **today's source**.

**Results.**

| Gate             | Command                            | Result                                                                                                        |
| ---------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Full suite       | `vitest run`                       | **1232 files — 1213 passed, 19 failed.** 13,896 tests: 13,729 passed, **21 failed**, 145 pending              |
| Typecheck        | `tsc --noEmit --incremental false` | **13 errors in 5 files**                                                                                      |
| Production build | —                                  | **NOT EXECUTED — and it cannot run:** `build` starts with `tsc --noEmit`, which fails with the same 13 errors |

**The repository is therefore NOT green at the audited commit.**

**Attribution.** All 19 failing files are pre-existing and **none** of them is caused by this
audit's work: this audit's four commits touched `STATE_DIVERGENCE_HUNTER_REPORT.md` and nothing
else — a Markdown file that no test imports. The 19:

```
tests/adr0057-meter-disclosure.test.ts          tests/ui/ContextMenu.test.tsx
tests/audio-engine-effect-intent-preview.test.ts tests/ui/DockChrome.test.tsx
tests/creative-task-contract.test.ts             tests/ui/SamplerMapping.test.tsx
tests/drift-check.test.ts                        tests/ui/shortcuts.test.ts
tests/intent-model-artifact.test.ts              tests/invariants.test.ts
tests/intent-model-schema.test.ts                tests/layout-data.test.ts
tests/mcp-edit-parity.test.ts                    tests/mcp-relay-session-ownership.test.ts
tests/plugin-functional-audit.test.ts            tests/slider-taper.test.ts
tests/transport-audit.test.ts                    tests/ux-audit.test.ts
tests/voice-envelope-release.test.ts
```

The 13 typecheck errors, likewise pre-existing:

```
src/audio-engine/previewDeck.ts        2   TS2345  null not assignable to string | undefined
src/presets/struna-factory.ts          4   TS1117  duplicate key in object literal
tests/bass-harmonic-audition.test.ts   1   TS2322  unknown[] not assignable to Record<string, unknown>[]
tests/koren-audition-engine.test.ts    4   TS2341  private member 'doc' accessed
tests/struna/engine.test.ts            2   TS2304  cannot find name 'InstrumentRuntime'
```

**Cross-check with the parallel audit.** A concurrent session published
`DAW_TRIPLE_AXIS_RELIABILITY_REPORT.md` (commit `4aeee390`) with its own full-suite baseline:
"1208/1230 files pass, 22 fail (24 tests) — every red attributed by measurement". The two
measurements agree in substance (a red tree, every red attributed) and differ in count (19 files /
21 tests here vs 22 / 24 there) because they ran on different tips. **Neither is a statement that
the repo is green.**

**What this changes for the reader.** Three of the failing files are _contract_ tests that constrain
exactly the surfaces this report touches:

- `tests/invariants.test.ts` — the leaky `as any` budget on `src/commands/`
- `tests/mcp-edit-parity.test.ts` — the MCP surface must expose every command-layer verb
- `tests/drift-check.test.ts` — `docs/CURRENT-STATE.md` must match live code

A reader about to remediate a finding in those areas must expect those guards to move.

**Consequences for this report.**

- this report makes **no claim** that the repository is green — and now it says so with a
  measurement instead of an omission;
- **the duplicate check has now been performed** (§5.8): 1277 spec files were scanned against all
  29 findings, and every candidate guard was read and judged. **Two findings were already fixed**
  (F-04, F-14), **one is half a pinned contract** (F-06), and **two have their fix pattern already
  in the codebase** (F-05's meta-gate, F-07/F-29's sibling command). A finding the repo's own tests
  pin is a duplicate, not a discovery — this report now says which ones those were;
- the "guarded by" test references quoted in this report were read from the **spec source**; the
  baseline confirms which specs are green, but it does not turn a source-read into a measured
  claim;
- **every `file:line` in this report was re-verified against the current tree** (§11): all 113
  citations resolve to the content they claim; the four that had drifted were corrected.

### 5.6 Not executed, and why it matters

| Probe                                                           | Status                                       | Reason                                                             | What it settled                                                                                                                      |
| --------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| **A/B control equivalence** (effect param, UI path vs MCP path) | **Executed — PASS** (T1)                     | —                                                                  | identical domain map **and** identical DSP param cache ✅                                                                            |
| **Ordering** (delayed A acknowledgement)                        | **Executed** (T2)                            | —                                                                  | unrelated field survives; **same field → last-APPLIED-wins** → F-25                                                                  |
| **Lifecycle** — save → load → rehydrate the engine              | **Executed — PASS** (T3)                     | —                                                                  | identical document **and** identical DSP state ✅                                                                                    |
| **Lifecycle** — reopen a plugin instance                        | **Executed** (T3)                            | —                                                                  | parameters reset to factory defaults, id re-minted → F-27                                                                            |
| **Audio truth** — the track-gain lane's composition             | **Executed — MEASURED** (T4 + T4b)           | —                                                                  | the lane is a **multiplier around unity 1.0** and the graph is correct → F-10 **re-classified** from wrong-audio to a visibility gap |
| **R-02 gate's synchrony precondition**                          | **Executed** (T5)                            | —                                                                  | the gate answers "nothing changed" for a deferred mutation → F-26                                                                    |
| **DSP → document write-back**                                   | **Executed — MEASURED** (T6)                 | —                                                                  | the DSP is a second writer and its write is discarded → **F-28, Critical**                                                           |
| F-03 rename false-success                                       | **Executed — and now CORRECTED**             | —                                                                  | the R-02 gate works ✅                                                                                                               |
| F-05 refusal signalling                                         | **Executed — still open**                    | —                                                                  | `isError` is absent on the automation refusal ❌                                                                                     |
| F-06 idempotency replay staleness                               | **Executed — still open**                    | —                                                                  | stale read-back + contradictory `mutated` ❌                                                                                         |
| F-07 automation duplicate points                                | **Executed — still open**                    | —                                                                  | 1→2 points, 1→2 undo entries ❌                                                                                                      |
| **F-07's other half** — an AI undo deleting the _human's_ point | **Executed — MEASURED** (T7a–T7d, §5.7)      | —                                                                  | points carry no identity and the undo delta is positional → the AI's undo removes the human's point when the lane shifted → **F-29** |
| P6 idempotency of the _mixer_ setters                           | **Executed — PASS** (T8, §5.7)               | —                                                                  | a repeated identical mixer write adds **no** history entry ✅                                                                        |
| Undo-inside-a-frame resurrection                                | **Executed — NOT REPRODUCED** (T9/T9b, §5.7) | —                                                                  | the frame's single Ctrl+Z restored the baseline exactly → **F-22 downgraded to Hypothesis**                                          |
| **Collab vs solo document shape**                               | **Executed — MEASURED** (T10, §5.9)          | —                                                                  | the same command yields `globalMix` 1 solo and 30 in collab; leaving collab rewrites it → **F-16 confirmed; F-28 is mode-dependent** |
| **Perceptual** audio truth for the remaining audible claims     | **Not executed**                             | jsdom has no `OfflineAudioContext`; the graph was measured instead | F-09, F-11, F-17, F-18, F-19 (§10)                                                                                                   |

### 5.7 Probe results — `tmp-probe/gaps.test.ts` (vitest, **7/7 green**)

This probe closes the three rows §5.6 had left open, **refutes one existing finding**, and produced
one new one (**F-29**).

**T7a–T7b — why an automation point cannot be undone by identity.**

```
[T7a] point object   : {"tick":5760,"value":0.5}
[T7a] point own keys : ["tick","value"]
[T7a] has an id?     : false
[T7b] forward ops  : [{"k":"ins","path":["automation"],"index":0,"value":{...lane...}}]
[T7b] backward ops : [{"k":"del","path":["automation",0],"removed":{...lane...}}]
```

`AutomationPoint` is `{ tick, value }` with no id (`src/project-model/types.ts:1019-1022`), and the
points array is diffed **by index** (`src/commands/docDelta.ts:227-241`). The `del` op carries the
point it removed, but `applyOp` splices whatever occupies that index **now** and never compares it
(`src/commands/docDelta.ts:309-313`). → the basis of **F-29**.

**T7c — the AI's undo removes the HUMAN's point. (F-29, measured.)**

```
[T7c] lane ready, points: []
[T7c] after the human      : [{"tick":0,"value":0.9}]
[T7c] after the AI landed  : [{"tick":0,"value":0.9},{"tick":5760,"value":0.5}]
[T7c] stack length         : 3
[T7c] after the AI's undo  : [{"tick":5760,"value":0.5}]
[T7c] the HUMAN's point was deleted by the AI's undo: true
[T7c] the AI's own point SURVIVED the AI's undo     : true
```

The human's point is gone; the AI's point survives. The lane's array shifted between the AI's
command and its undo, so the positional delete hit the wrong slot.

**T7d — the control: with a synchronous dispatch the same undo is CORRECT.**

```
[T7d] after the AI landed  : [{"tick":5760,"value":0.5}]
[T7d] after the human      : [{"tick":0,"value":0.9},{"tick":5760,"value":0.5}]
[T7d] after undo #1        : [{"tick":5760,"value":0.5}]   ← the human's point, correctly
[T7d] after undo #2        : []                          ← then the AI's, correctly
```

→ the finding is scoped to the **shift window**, not to every automation undo.

**T8 — P6: the mixer setter IS idempotent.**

```
[T8] undo stack: 0 -> 1 -> 1
[T8] the gain in the document: 0.5
```

A repeated identical `kyx_tracks setGain` adds **no** history entry — the identity guard in
`ProjectStore.applyCommand` (`src/store/ProjectStore.ts:279-286`) catches it. **P6 is a pass.** This
also draws the contrast with **F-07**, where the _automation_ path does **not** have that guard.

**T9 — F-22: NOT REPRODUCED.**

```
[T9] inside the frame              : 0.11 0.22 0.33
[T9] after the undo inside the frame: 0.11 0.22 0.85
[T9] stack length after the inner undo: 2
[T9] after endUndoFrame             : 0.11 0.22 0.85
[T9] stack length after the seal    : 1
[T9] after the frame's single Ctrl+Z: 0.9 0.85 0.85    ← the BASELINE, exactly
```

The frame's single undo restored the baseline exactly — no resurrection, no partial revert. **F-22
is downgraded from _Strongly indicated_ to _Hypothesis — not reproduced_ (§4/F-22).**

**T9b — the mechanism behind F-22 does exist, but is harmless for the commands exercised.**

```
[T9b] stack length inside the frame   : 4
[T9b] stack length after the inner undo: 3
[T9b] stack length after the seal      : 3
[T9b] after the frame's single Ctrl+Z  : [{"tick":0,"value":0.9}]
```

The compound's undo does re-run the command that was already undone inside the frame — but for the
snapshot-based commands used here that re-run is idempotent. It would only bite a **value-addressed**
command (an automation point) **and** only if a duplicate point exists (F-07). That combination was
not exercised.

---

### 5.8 Duplicate-guard scan — is any finding already covered by the repository's own tests?

§5.5 promised this check, and it had not been done. The report's own consequence for a reader is:
_"any finding that a test already guards would be a **duplicate**, not a discovery."_ This section
performs that check, over **1277 spec files** (`tests/` and `src/`), for all 29 findings.

**Method.** `tmp-probe/guard-scan.mjs` walks every `*.test.ts` / `*.spec.ts` in the repository and
matches each finding against a set of subject patterns, producing **candidate** guards with the
matching line. Every candidate below was then **read and judged** — a mention is not a guard, and a
pattern hit is not a verdict. The classifications are therefore judgements over read source, not
search results.

| Finding         | Candidate guard                                                                         | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F-04**        | `tests/recovery-overwrite.test.ts`                                                      | **RESOLVED — a real guard, for the fixed behaviour.** 11 tests pin one slot per project, the legacy-key migration, the scoped clear, and the file's own motto: _"THE RECOVERY MUST NOT BECOME THE DESTRUCTION"_. The fix landed in `9d2fc17c` at **14:19:56 — six minutes before this report's own last commit**. The finding was open when written; it is closed now.                                                             |
| **F-14**        | `tests/recovery-overwrite.test.ts`                                                      | **RESOLVED — the same commit.** 6 tests pin that a malformed, foreign or newer buffer is refused **without writing**, and that an old schema is migrated before it is used. All three failure modes this finding named are closed.                                                                                                                                                                                                 |
| **F-05**        | `tests/mcp-error-codes.test.ts:107-124`                                                 | **PARTIALLY GUARDED — the _other half_ of the gate exists.** The repo already gates _un-coded_ errors. F-05's refusal is `isError: undefined` — not an error at all — so that gate cannot see it. F-05 is the **missing complementary half of an existing gate**, not a new idea.                                                                                                                                                  |
| **F-06**        | `tests/mcp-idempotency.test.ts:16-17, 22-23, 94, 143-153`                               | **DUPLICATE (the stale read-back) + a real finding (the envelope).** The spec pins the replay's exact text and pins that it survives an undo: _"the replay still returns the original outcome"_ (ID6). The stale value is a **deliberate, pinned contract** — a product judgement, not a defect. What survives: the replay returns **before** the R-02 gate, so `mutated: true` contradicts its own text.                          |
| **F-07 + F-29** | `tests/automation-audit.test.ts` (audit 06, D3)                                         | **THE FIX PATTERN ALREADY EXISTS — for the sibling command.** The spec pins _"move tolerates a shifted index by re-anchoring on the captured point"_ (`:91-110`), and the source names it: _"Audit 06 D3: re-anchor by IDENTITY, then by (tick, value)"_ (`src/commands/automation.ts:128-131`). `addAutomationPoint.undo` never got it. **F-29 is the missed sibling, not a new mechanism.**                                      |
| **F-22**        | —                                                                                       | **NOT GUARDED, and not reproducible** (§5.7 T9/T9b). The mechanism exists but is idempotent for the commands exercised.                                                                                                                                                                                                                                                                                                            |
| **F-01**        | none                                                                                    | **NOT GUARDED.** The scan's only hit is an unrelated comment (_"The map was never stale"_). **No spec asserts that the stem/track export path checks the document's freshness** — the master path's `assertMasterSourceCurrent` has no sibling on the export side.                                                                                                                                                                 |
| **F-28**        | `tests/fxeq-host-integration.test.ts`, `tests/ui/fxeq-crossover-numeric-entry.test.tsx` | **NOT GUARDED — and the gap is exactly the seam where the bug lives.** The repo tests both _ends_ of the write-back: the worklet→host protocol (`undoParam` posts, the history reply resolves with the restored entry) and the UI→`onParam` write. **Nothing tests the join** — that `onParam`'s value reaches the _document_ as the same value, and survives a save + reload. Both ends green, the middle untested: that is F-28. |

**What this changes.** Three findings changed status because of this scan, and **all three changes
are corrections**: two became **resolved**, one became **narrower**. The audit's §1 claim that its
findings are discoveries is now properly qualified — **a finding the repo's own tests already pin is
a duplicate**, and the four cases above are exactly that.

**And the discipline the repo already writes down.** `tests/mcp-error-codes.test.ts:108` states it:
_"GAP-09 taught this lesson for handlers: coverage without a gate rots."_ The same is true of an
audit. A finding without a test behind it is a claim; a finding with a red test is a fact. **Every
finding in §4 should leave this report with a red test that reproduces it** — that is Phase 0 (§8),
and the repo's own convention already asks for it.

---

### 5.9 Probe results — `tmp-probe/collab.test.ts` (vitest, **4/4 green**)

This probe answers the question §10.3 had left open: _"Does a collab-edited project, exported and
re-imported, really differ from the solo equivalent?"_ It also closes **F-16**, which was the last
finding still resting on code reading alone.

**T10a — CONTROL: the Yjs round-trip is not the cause.**

```
[T10a] fx params, projected from Y.Doc  : {"mix":1,"globalMix":1}
[T10a] fx params, after normalizeProject : {"mix":1,"globalMix":1}
[T10a] the Yjs round-trip is identical to the normaliser's output: true
```

`YDocStore.fromDocument(doc)` → `getDoc()` is already normalised. So any divergence below comes
from the **command path**, not from the CRDT projection.

**T10b — the same command, two stores.**

```
[T10b] BEFORE  : {"mix":1,"globalMix":1}
[T10b] SOLO    : {"mix":1,"globalMix":1}     ← the write was DISCARDED
[T10b] COLLAB  : {"mix":1,"globalMix":30}    ← the write LANDED
[T10b] SEMANTIC differences (deep diff, key order ignored):
        ["$.tracks[0].effects[0].params.globalMix: solo=1 collab=30"]
```

**Exactly one field differs, and it is the DSP's wet/dry.** The deep diff ignores key order — the
naive `JSON.stringify` comparison is order-sensitive and would have reported a false difference on
an identical document (which is exactly what T10d then exposed).

**T10c — leaving collab changes the document.**

```
[T10c] in collab            : {"mix":1,"globalMix":30}
[T10c] after leaving collab : {"mix":1,"globalMix":1}
[T10c] the document CHANGES when the session ends: true
```

The document the user sees in a collab session is **not** the document they get when the session
ends — the normaliser rewrites it on the way out, with no report to anyone.

**T10d — CONTROL: the divergence is not generic.**

```
[T10d] solo gain: 0.42   collab gain: 0.42
[T10d] the two documents are identical: false
[T10d] differing paths: (none)
```

A carrier-free command (`setTrackParams(..., { gain: 0.42 })`) yields **semantically identical**
documents in both paths — the `false` above is a key-ORDER artefact of `JSON.stringify`, which the
deep diff corrects. So the divergence appears **only where the normaliser has something to
rewrite**: a command whose output is already normalised is safe in both paths.

**The consequence that matters: F-28 is mode-dependent.** In solo, the PRISM write-back is
discarded by the normaliser; **in collab it lands**. The Critical finding therefore does not have
one behaviour — it has two, depending on whether a session is open. A Phase-1 repair that only
touches the solo path would leave the collab path untouched.

---

## 6. TOP 10 hardening priorities

Ranked by **risk of wrong audio / lost work / false success**, then by probability, scope, fix
effort and regression risk.

| #                                                                                                     | Finding                                                                                                                 | Why this rank                                                                                                                                                                                                                                                                                                                                                                       | Effort                                                                                         | Regression risk                   |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------- |
| **1**                                                                                                 | **F-28** — the PRISM DSP is a **second writer** whose write-back is normalised away                                     | **Critical, and measured.** The DSP holds wet/dry 1.0 while the document and the knob say 0.3; a **save + reload changes what you hear**; the project's undo stack carries a dead step. It breaks the product's central doctrine and its "same project, same sound" contract. The fix is one inverse id map.                                                                        | S–M (an inverse `toRackId` + value conversion)                                                 | Low                               |
| **2**                                                                                                 | **F-01** — stem/track export renders a stale document                                                                   | The only finding that can ship **silently wrong output** to a paying user. The master path already proves the guard is cheap.                                                                                                                                                                                                                                                       | S (capture at call time + reuse the existing assertion)                                        | Low                               |
| **3**                                                                                                 | **F-02** — REC indicator lies about capturing                                                                           | Silent loss of an intended take, with a lit button asserting the opposite.                                                                                                                                                                                                                                                                                                          | S (split armed from capturing)                                                                 | Low                               |
| **4**                                                                                                 | **F-25** — a delayed older write overwrites a newer one (last-APPLIED-wins)                                             | **Measured** (§5.3, T2): the AI's late write silently clobbers the human's newer value on the same field. **Lost work**, live, on the common human/AI path — it outranks every visibility gap.                                                                                                                                                                                      | S for disclosure, M for a revision counter                                                     | Low (disclosure) / M (versioning) |
| **5**                                                                                                 | **F-11** — a macro mapped to an effect parameter is **silently dropped** during playback                                | **Wrong audio, live.** The macro path and the automation path write the _same_ `AudioParam`; during playback the scheduler rewrites the parameter every 25 ms, so the macro's contribution disappears with no message. Confirmed from the code path — the one TOP-10 entry whose evidence is a **code read, not a probe** (§5.6 lists its perceptual half as _not executed_).       | M (an explicit precedence, or the same dedicated modulation bus the track strips already have) | Medium                            |
| **6**                                                                                                 | **F-26** — the R-02 gate silently assumes `ctx.execute` is synchronous                                                  | **Measured** (§5.3, T5): the gate answers _"nothing changed"_ while the mutation lands afterwards. It is the **window that makes F-29 destructive**, and the MCP host contract (`McpToolContext.execute(command): void`) does not enforce the synchrony it depends on. Today no host defers — so this is a **precondition to fix before the first deferred host ships**, not after. | S (state the precondition; check it)                                                           | Low                               |
| **7**                                                                                                 | **F-16** — a local collab edit skips normalisation, so the session's document is not the saved document                 | **Measured** (§5.9, T10): the same command yields `params.globalMix = 1` solo and `30` in collab, and normalising on the way out rewrites it back. **It makes F-28 mode-dependent** — the Critical write-back is discarded solo and lands in collab — so F-28's repair must cover it.                                                                                               | S (normalise at the export boundary + on the local-origin path)                                | Low                               |
| **8**                                                                                                 | **F-29** — the automation-point undo is **positional**, so a shifted lane makes the AI's undo destroy the human's point | **Measured** (§5.7, T7c): the AI's undo removed the **human's** authored point and left the AI's — silent loss of work, followed by a dead undo step. The plain stack order is safe (T7d), so the window is the shift between a command and its undo — which is exactly the window **F-26** opens. The fix pattern already exists in the sibling command (audit 06 D3).             | S (verify the slot before splicing)                                                            | Low                               |
| **9**                                                                                                 | **F-05** — refusals are not machine-detectable                                                                          | Every future tool inherits the ambiguity; a meta-test makes it permanent. It is also a **hole in the new R-02 gate**, which cannot correct a refusal because a refusal is `mutated: false`. The repo already owns the _other half_ of that gate (§5.8).                                                                                                                             | S + S (one meta-test)                                                                          | Very low                          |
| **10**                                                                                                | **F-09** — knob shows the document value while the DSP plays the automated value                                        | "What you see" ≠ "what you hear" at the most-used control in the app. This is the mission's _audible truth_ clause — a **visibility gap**, so it ranks below every lost-work and wrong-audio finding above.                                                                                                                                                                         | M (effective-value read model)                                                                 | Low–M                             |
| *(F-03 — the AI false-success on rename — **left this list**: it was fixed in the working tree by the |
| R-02 `verifiedMutation` gate during this audit, and the probe confirms the fix (§5.2). It is          |
| retained as a worked example in §4 rather than as an open finding. **F-07** left this list too:       |
| it and **F-29** share one root cause — automation points have no identity, so they are addressed by   |
| value and by position — and **one repair (give the point an identity, or verify the slot before       |
| splicing) closes both**. **F-04** left this list in this pass: the duplicate-guard scan (§5.8) found  |
| `tests/recovery-overwrite.test.ts`, and the per-project recovery slots landed in `9d2fc17c` six       |
| minutes before this report's last commit — **F-14 left with it**, because the same commit made        |
| `recoverProject` refuse an unvalidated, un-migrated or foreign document instead of writing it into    |
| the store. Both are **resolved in the working tree**, not by this audit but by a concurrent one.      |
| **F-13** (`migrateProject` is not a migration), **F-12** (normalisation clamps without disclosure),   |
| **F-15** (three save timestamps),                                                                     |
| **F-06** (the idempotency replay escapes the R-02 gate — the stale read-back half is a **pinned       |
| contract**, §5.8, so what remains is the envelope ambiguity), **F-17** (bypass cold restart),         |
| **F-18/F-19** (fallback                                                                               |
| honesty), **F-20** (unit duplication), **F-21** (playhead freeze), **F-22** (undo-in-frame — now      |
| **Hypothesis: not reproduced** by the §5.7 probe), **F-23**                                           |
| (onset cache), **F-24** (automation ack), **F-27** (a reopened instance resets to defaults) are all   |
| **below the top 10**: real, documented, and scheduled for a later wave.)*                             |
| **F-10 left this list in the correction pass.** It was ranked **#5** on the claim that the track-gain |
| lane was _"authored absolute but applied multiplicatively"_ — a **wrong-audio** claim. The            |
| correction pass re-measured it (§5.3, T4 + T4b) and found the opposite: the lane **is** a multiplier  |
| and the graph is **correct**. What remains is a **visibility gap** (the lane is labelled "Volume",    |
| drawn on the fader's scale, and no surface shows the composed gain) — the same class as **F-09**, and |
| **one repair closes both**: the S-5 effective-value read model. It stays a live, documented finding   |
| (§4/F-10) and a **Phase 5** item, but it no longer outranks the wrong-audio and lost-work findings.   |

---

## 7. TOP 5 systemic state architecture improvements

### S-1 — Close the perimeter of the R-02 `verifiedMutation` gate

**Expected value:** closes F-05, F-06 and F-24, and makes the false-success class _structurally_
impossible rather than per-handler.

**The gate already exists** — `src/mcp/verified-mutation.ts`, applied at the dispatch choke point in
`src/mcp/tools.ts` (~line 4471). It is the right architecture: one place where a mutation becomes a
claim, witnessed by the document's own identity. It is also **uncommitted** — it lives in the
working tree, not on `main`.

**Its perimeter has four gaps, all measured:**

1. **Refusals are invisible to it.** `verifiedMutation` returns early when
   `result.mutated !== true` (`src/mcp/verified-mutation.ts:93`). Every refusal is
   `mutated: false` by construction — so the gate can never correct a refusal that is not flagged
   as an error (**F-05**). **Fix:** extend the gate to classify results into _success_ / _refusal_ /
   _error_, and require a refusal to carry `isError` + a code from the taxonomy
   (`src/mcp/tools.ts:3553-3571`) — i.e. route the automation handler's refusals through the
   existing `mcpError(...)` constructor, and add a **meta-test** that every mutating tool's refusal
   sets `isError`.
2. **The idempotency replay bypasses it entirely.** The replay returns at `src/mcp/tools.ts:4394`;
   the gate is applied at `:4471`. **Fix:** move the replay inside the dispatch (or apply the gate to
   the replay result as well) — a choke point only works if every exit passes through it
   (**F-06**).
3. **The structural read-back lives in prose, not in the envelope.** When the gate appends a
   read-back, it edits `result.text` only; `result.data` is left untouched when `mutated` did not
   change (`src/mcp/verified-mutation.ts:96-127` — `let text = result.text`, the read-back appended at
   `:124`, the envelope returned as `{ ...result, text }`). A client that reads only `data` never sees the
   verification. **Fix:** mirror the read-back into `data` as well (**F-24** covers the same seam
   from the handler side).
4. **It silently assumes `ctx.execute` is synchronous.** The gate compares the document from before
   the handler with the document from after it. If the host defers the command, the two are
   identical and the gate answers _"nothing changed"_ for a mutation that lands afterwards
   (**F-26**, measured). All three real hosts are synchronous today, but the type contract
   (`execute(command: Command): void`) does **not** enforce it — TypeScript lets a
   Promise-returning function satisfy a `void`-returning signature. **Fix:** make the precondition
   explicit and checked — have `execute` return the committed document revision and compare
   revisions rather than object identity, or at minimum document it and add a test asserting every
   registered host applies the command inline.

**Risk:** low–medium. The gate is new and uncommitted, so changing it is cheap — but it is another
session's work in progress. **Coordinate before editing**; the recommendation here is to widen a
design that is correct, not to replace it.

**Migration:** additive and backward-compatible. The error taxonomy and result envelope shapes stay
exactly as they are; only the _population_ of `isError`/`errorCode` grows.

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

### S-4 — A single unit/scale ownership layer, a **bidirectional** id map, and a documented composed signal path

**Expected value:** closes F-10's root cause (one parameter definition serving two domains), F-11,
F-19, F-20 and — with one line — **F-28**, the Critical one.

Shape: every parameter declares, in one registry: its **domain** (absolute vs modulation), its
**display unit**, its **DSP transform**, the **signal path** it is composed into, and — the part
F-28 proves is missing — its **canonical project id** in **both** directions. Then:

- **every id map is bidirectional.** `src/effects/fxeqNode.ts:16-21` has `RACK_TO_CORE` and no
  inverse. A one-way map is fine for values flowing _into_ the DSP and fatal for values flowing
  _back out_ of it — which is exactly what the in-plugin undo does. The registry must state, per
  parameter, the canonical id, the DSP id, and the conversion in **both** directions (**F-28**);

- every unit conversion has exactly one owner (fold `dbToLin` into `scale-bridges.ts`);
- every `SCALE_BRIDGES` entry is asserted to be the function the node actually calls;
- the track-gain lane's semantic is **already settled by measurement** (a multiplier around unity 1.0
  — §5.3, T4 + T4b) and the registry must **declare** it, so the label and the scale can no longer
  drift apart from the domain;
- effect parameters get the same precedence rule (or the same dedicated modulation bus) that track
  parameters already have.

**Risk:** F-11 is a **behavioural** change. It needs an ADR and a listening protocol (§10) before any
code moves. **F-10, after the correction, is not behavioural** — it is a registry declaration plus a
display change, and needs neither.

**Migration:** a documentation + assertion first (no behaviour change), the semantic decision
second, the graph change third.

### S-5 — Separate "the value the user set" from "the value in effect"

**Expected value:** closes F-09 and F-10's display half, and is the general answer to
"the UI shows one state but the DSP plays another".

Shape: an explicit **effective-value read model** — a pure function
`effectiveParamValue(doc, runtimeSnapshot, target)` — that the UI consults instead of reading
`doc.tracks[].effects[].params` directly. It returns the document value when nothing overrides it,
and the overriding value (with a source label: _automation_, _macro_, _modulator_) when something
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

### Phase 0 — Evidence (no production code)

**The probes already exist.** `tmp-probe/f03.test.ts` (5/5 green), `tmp-probe/scenarios.test.ts`
(8/8 green) and `tmp-probe/gaps.test.ts` (7/7 green) are re-runnable reproductions of F-03, F-05,
F-06, F-07, F-10, F-22, F-25, F-26, F-27 and **F-29**.
**Promote them into `tests/`** — they are the regression guards for this whole report, and they cost
nothing to keep.

Then add a per-finding reproduction test for each of F-01, F-02, F-04, F-08, F-12 … F-15, F-24,
and turn each remaining finding into a **failing** test before a line is changed.

_Gate:_ every finding below has a red test that reproduces it, and the red test fails for the
_stated_ reason — not for an incidental reason. The three probes that already exist stay green.

### Phase 1 — The wrong-audio layer and the truth layer (smallest change, highest trust return)

**F-28 comes first** — it is the only Critical finding, and its fix is small: add the inverse of
`RACK_TO_CORE` (`toRackId` + the inverse value conversion) in `src/effects/fxeqNode.ts`, and
translate the write-back in `FxEqPanel.tsx:220-227` so the document receives the **canonical** id and
value. Then the normalisation alias stops fighting the write-back, because the write now arrives
_as_ `mix`.

Alongside it, **widen the perimeter of the R-02 gate**: **F-05** (typed refusals for the automation
handler + the meta-test that every mutating tool's refusal sets `isError`), **F-06** (move the
idempotency replay inside the gate's perimeter; force `mutated: false` on a replay and re-read or
label the read-back), **F-26** (make the gate's synchrony precondition explicit and checked), and
**F-24** (mirror the gate's read-back into `result.data`).

And **F-29**, because it is small and it destroys authored work: make the automation point's undo
**verify the slot before it splices** — if `points[index]` no longer holds the `{tick, value}` the
command captured, the undo must refuse and say so rather than remove whatever moved into that
position. That one change also closes F-07's identity half. It touches no schema, no audio and no
serialisation.

_Gate:_ the meta-test is green; F-05's, F-06's, **F-29's** and **T6**'s reproductions flip from red
to green;
no MCP client contract changes; the R-02 gate's own regression spec stays green; and — the check
that matters most — **a PRISM in-plugin undo now survives a save + reload with the same wet/dry**.

### Phase 2 — The export freshness layer

Promote the revision assertion to a shared helper (**S-2**) and apply it to stems, tracks and the
MCP export path. Capture the document **at call time**, not at render time.

_Gate:_ F-01's reproduction (edit the arrangement, then export) now refuses with the master's
message; a stem export of an _unchanged_ project is byte-identical to before.

### Phase 3 — The persistence layer

**F-04** (per-project recovery key + honour the write result) → **F-14** (validate + migrate on
recovery) → **F-13** (`MIGRATIONS` chain, behaviour-neutral) → **F-15** (one timestamp authority) →
**F-12** (route normaliser clamps into `Command.detail`).

_Gate:_ the recovery round-trip is covered end-to-end; migrating from every version ≤ 38 still
yields the same document as today (locked in by a spec); the three timestamps agree.

### Phase 4 — The automation identity layer

**F-07**, cheap variant first (de-duplicate identical `(tick,value)` inserts; undo removes the
_last_ match), then the correct variant (**S-3**: stable point ids + the `MIGRATIONS` chain, both
landing in one `SCHEMA_VERSION` bump). Then **F-08** (disclose the ordinal substitution) and
**F-22** (undo seals the open frame).

_Gate:_ the identity-based reproduction (object identity, not JSON) passes; projects written by
v38 still open; a round-trip of every project fixture is byte-identical.

### Phase 5 — The audible-truth layer

**S-4** and **S-5**: first the _assertions_ (scale registry, unit ownership, composed-path
documentation) with no behaviour change; then the **declaration** of each parameter's domain in the
registry — the track-gain lane's semantic is **settled by measurement** (§5.3, T4 + T4b: a
multiplier around unity), so this is a _labelling + unity-line_ change, **not** a graph change and
**no ADR**; then the effective-value read model (**S-5**) consumed by the effect rack and the
track-gain lane; then
**F-09**, **F-11**. **F-17** (node-level bypass), **F-18** and **F-19** (fallback honesty) last,
because they are DSP changes.

_Gate:_ the audio-truth measurement protocol in §10 passes for every automatable parameter; live
and offline renders remain identical (`tests/offline-parity.test.ts` stays green).

### Phase 6 — The remaining display and consistency items

**F-21** (playhead resync on visibility), **F-20** (delete the duplicated unit helpers), **F-16**
(collab normalisation parity), **F-23** (onset cache content key).

---

## 9. Verification matrix

| Layer / invariant                                  | How to verify                                                                            | Automated?          | Currently covered?                                                                                                                                                                                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document authority                                 | No `doc.<slice> =` outside `ProjectStore`; grep                                          | Yes                 | search only (this audit)                                                                                                                                                                                                                     |
| Command round-trip (undo/redo)                     | probe P2/P3 battery, dev vs prod                                                         | Yes                 | partially — `tests/undo-roundtrip-sweep.test.ts`, `tests/doc-delta-*.test.ts`                                                                                                                                                                |
| Delta path == dev path                             | run the battery with the verifier off                                                    | Yes                 | **not covered** — the suite only ever runs the dev path, where the fallback silently repairs a broken delta. This audit measured parity for 4 shapes (P2/P3) and found 0 fallbacks. **2 shapes remain untested.**                            |
| Save → load round-trip                             | serialize → deserialize → normalise → compare                                            | Yes                 | **PASS (measured, P4 + T3)** — the reloaded document is byte-identical **and** rehydrates to an identical DSP state; `tests/persistence/round-trip-integrity.test.ts`                                                                        |
| Recovery correctness                               | broken buffer → recovery must refuse                                                     | Yes                 | no — **F-14**                                                                                                                                                                                                                                |
| Recovery isolation                                 | two dirty projects → both buffers survive                                                | Yes                 | no — **F-04**                                                                                                                                                                                                                                |
| Export freshness                                   | edit → export → must refuse                                                              | Yes                 | no — **F-01**                                                                                                                                                                                                                                |
| Live == offline mix                                | `renderProject` vs live playback                                                         | Yes                 | `tests/offline-parity.test.ts` ✅                                                                                                                                                                                                            |
| Export == live mix                                 | compare an export with a live capture                                                    | Yes                 | partially — no export-vs-session freshness test (**F-01**)                                                                                                                                                                                   |
| Automation does not mutate the doc                 | assert `doc` unchanged during playback                                                   | Yes                 | `tests/scene-packs.test.ts:492` ✅                                                                                                                                                                                                           |
| Effect param: doc == DSP                           | instrument the runtime AudioParam vs `fx.params`                                         | Yes                 | partially — `tests/param-range-coherence.test.ts`, `tests/fxeq-rack-contract.test.ts`                                                                                                                                                        |
| Effect param under automation                      | assert the _effective_ value reaches the DSP                                             | Yes                 | no — **F-09**, **F-11**                                                                                                                                                                                                                      |
| Track-gain lane semantics                          | measure the rendered channel level                                                       | Yes (offline)       | **MEASURED at the graph level (T4 + T4b)** — the lane is a multiply stage in series around unity 1.0, so the audible gain is the product, and the _semantic is settled_. What is still missing is the **effective-value display** — **F-10** |
| A/B control equivalence (UI path vs MCP path)      | set the same parameter both ways, compare domain **and** DSP state                       | Yes                 | **PASS (measured, T1)** ✅                                                                                                                                                                                                                   |
| Ordering (delayed acknowledgement)                 | apply A then B with A's ack late; assert the documented precedence                       | Yes                 | **MEASURED (T2)** — unrelated field survives; same field → last-APPLIED-wins. **F-25**                                                                                                                                                       |
| Lifecycle — reopen a plugin instance               | remove + re-add; assert the parameter state                                              | Yes                 | **MEASURED (T3)** — resets to factory defaults, id re-minted. **F-27**                                                                                                                                                                       |
| MCP host `execute` is synchronous                  | assert every registered host applies the command inline                                  | Yes                 | no — the type does not enforce it. **F-26**                                                                                                                                                                                                  |
| Automation undo removes the point it created       | write a point, shift the lane, undo; assert the right point went                         | Yes                 | **FAIL (measured, T7c)** — the undo is positional and removed the human's point. **F-29**                                                                                                                                                    |
| Undo inside an open frame is atomic                | frame with ≥3 commands, undo inside, then the frame's Ctrl+Z                             | Yes                 | **PASS (measured, T9)** — the baseline was restored exactly. **F-22 not reproduced**                                                                                                                                                         |
| Repeated identical mixer write is idempotent       | write the same value twice; assert the history did not grow                              | Yes                 | **PASS (measured, T8)** ✅                                                                                                                                                                                                                   |
| One command, one document — in every store mode    | apply the same command to a solo store and to a collab store; assert the documents match | Yes                 | **FAIL (measured, T10)** — `params.globalMix` = 1 solo, 30 in collab; the difference is the DSP's wet/dry. **F-16**                                                                                                                          |
| **Exactly one writer to the document**             | every write path lands in the document's canonical id and value                          | Yes                 | **MEASURED — FAILS (T6)**: the PRISM DSP write-back is discarded. **F-28**                                                                                                                                                                   |
| A plugin's in-plugin undo survives a save + reload | undo in the plugin, reload the project, compare the audible parameter                    | Yes                 | no — **F-28**                                                                                                                                                                                                                                |
| MCP ack truthfulness                               | every mutating tool: does `mutated` match the document?                                  | Yes                 | **partially ✅** — the R-02 gate covers the dispatch path; **F-06** (the replay) escapes it                                                                                                                                                  |
| MCP refusal detectability                          | every mutating tool: does a refusal set `isError`?                                       | Yes                 | no — **F-05** (the meta-test is Phase 1)                                                                                                                                                                                                     |
| MCP stale-id handling                              | stale track/fx/clip/note/param ids                                                       | Yes                 | partially ✅ (`UNKNOWN_TARGET` in most handlers)                                                                                                                                                                                             |
| MCP idempotency                                    | repeated `requestId` → one execution, honest flag                                        | Yes                 | partially ✅ — **F-06** for the flag and the read-back                                                                                                                                                                                       |
| Undo restores coupled values                       | delete-track cross-reference sweep                                                       | Yes                 | `tests/delete-track-undo-cross-references.test.ts` ✅                                                                                                                                                                                        |
| Undo inside a frame                                | undo mid-frame → redo must not resurrect                                                 | Yes                 | no — **F-22**                                                                                                                                                                                                                                |
| Normalisation disclosure                           | out-of-range set → `detail` reports the clamp                                            | Yes                 | no — **F-12**                                                                                                                                                                                                                                |
| Migration totality                                 | migrate from every version ≤ 38                                                          | Yes                 | `tests/persistence/schema-evolution.test.ts` (for the current total path)                                                                                                                                                                    |
| Bypass semantics                                   | toggle bypass → is the processor state preserved?                                        | Yes + **listening** | no — **F-17**                                                                                                                                                                                                                                |
| Fallback honesty                                   | force the native fallback → do the knobs still claim to work?                            | Yes                 | no — **F-18**, **F-19**                                                                                                                                                                                                                      |
| Record indicator                                   | stop the transport → the ⏺ must not read "recording"                                     | Yes (component)     | no — **F-02**                                                                                                                                                                                                                                |
| UI playhead vs transport                           | hide the tab → the playhead must resync on return                                        | Yes (component)     | no — **F-21**                                                                                                                                                                                                                                |
| Mirror drift                                       | `npm run verify:mcp-mirrors`                                                             | Yes                 | ✅ `tests/mcp-mirror-sync.test.ts` — _definitions only; handler behaviour is not mirrored_                                                                                                                                                   |
| Realtime safety                                    | no I/O or unbounded allocation in an audio callback                                      | Yes (static)        | ✅ — this audit found **no** I/O, logging or allocation in a processor callback                                                                                                                                                              |

---

## 10. Unknowns and observations requiring listening or manual UI testing

### 10.1 Requires human listening (no automated equality can settle these)

1. **F-10 — the lane's _semantics_ are settled by measurement; only the _display_ needs a human eye.**
   The lane is a **multiplier around unity 1.0** (§5.3, T4 + T4b): the graph is correct, the clamp is
   correct, the **label** is not. So there is no semantic decision left to make and **no code change is
   blocked**. Two things still need a human:
   - **the listening A/B (to confirm the measurement on real speakers):** fader at 0.8, one lane point
     at 0.5, and confirm the channel sits ≈ **−8 dB (0.4)**. If it sits at −6 dB (0.5) instead, the
     graph has changed since this measurement and the finding must be re-measured. This A/B also shows
     whether the _current_ labelling is actively misleading — a user who reads "Volume 0.5" and hears
     0.4 will reach for the fader.
   - **the wording (a design choice, not a measurement):** what should the lane be called — "Gain mod",
     "Volume ×", "Trim ×"? And should it show the **composed** value (fader × lane) beside the
     multiplier, or only the multiplier with a unity line? Both are additive display options; the
     second is the smaller change.
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
6. **F-28 — confirm the audible symptom.** The graph-level fact is measured (the DSP holds 1.0 while
   the document says 0.3), so no listening is needed to _establish_ the defect. What listening
   confirms is the user-visible symptom: with a PRISM instance on a track, drag MIX to 30 %, press
   the panel's ↶ Undo, and hear whether the wet/dry returns to full while the knob still reads 30 %;
   then save, reload, and hear whether the sound changes back. If the knob moves with the sound, the
   symptom does not reproduce and the finding must be re-measured before it is fixed.
7. **The 8–20 ms smoothing difference between native and worklet parameters** (`F-19`/`F-20`
   family) is a click-behaviour difference, not a value difference — only listening can rank it.

### 10.2 Requires manual UI testing (browser-driven)

7. **F-01 — is the Export panel persistently mounted?** The staleness window depends on the dock
   keeping the panel mounted across an arrangement edit. If the dock unmounts inactive panels, the
   _before-click_ window shrinks to "edit while the panel is visible"; the _during-render_ window
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

12. ~~**The collab normalisation asymmetry (F-16)** was read, not traced end-to-end. Does a
    collab-edited project, exported and re-imported, really differ from the solo equivalent?~~
    **CLOSED — YES, it differs, and the difference is the DSP's wet/dry** (§5.9, probe T10).
    The same command yields `params.globalMix = 1` solo and `30` in a collab session; normalising
    the collab document on the way out rewrites it back to `1`. Two controls make the claim tight:
    the Yjs round-trip alone is already normalised (T10a), and a carrier-free command produces
    **semantically identical** documents in both paths (T10d). **F-16 is now Confirmed and measured**,
    and it makes **F-28 mode-dependent** — the Critical write-back is discarded solo and lands in
    collab.
13. ~~**Does anything ever write back into the document from the DSP?**~~ **CLOSED — it does.**
    The PRISM core is a second writer: its in-plugin undo writes into the document and the
    normaliser discards the write (**F-28**, measured). The write-back currently exists only in
    `src/ui/FxEqPanel.tsx`; the other flagship panels have no in-plugin history button. **The
    open question is now the class, not the instance:** the reverse id map does not exist, so any
    future plugin that adds an in-plugin history inherits the same defect.
14. **How many shipped effect factories apply the full document parameter set?** The engine's
    parameter cache is seeded from the document and only pushes _differences_; a factory that does
    not apply every parameter would leave that parameter permanently unsent. The shipped factories
    read in this audit appear to apply the full set, but the full registry was not exhaustively
    checked.
15. **Is the production delta path exercised by CI at all?** The suite runs the dev path, where the
    fallback repairs a broken delta silently. This audit measured parity for four shapes and found
    zero fallbacks; **two shapes (entity reordering, instrument creation) were not measured** because
    the probe used wrong command signatures. A CI job that runs the battery with the verifier
    disabled would close this permanently.
16. **F-25 — which ordering semantics does the product actually want?** The audit measured what
    _happens_ (last-APPLIED-wins on a same-field conflict). Whether the product wants last-ISSUED
    wins, or wants the conflict surfaced, is a **product decision** — and it is the same decision
    that determines whether F-25 is a bug or a documented contract.
17. **F-26 — will any host ever defer `execute`?** Not today; all three are synchronous. The open
    question is whether a _planned_ collab-merged or worker-backed store would — and if so, whether
    the gate is fixed before that lands. **This question got heavier in this pass:** the deferred
    window is exactly what turns **F-29** from a latent positional-delete hazard into silent loss
    of the human's authored point. Until it is answered the hazard is latent; the moment any host
    defers, it is live — so the gate should be fixed _before_ that host lands, not after.

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
- **Four probe harnesses, all executed.** `vite-node` (`tmp-divergence-probe.mts`, 7 sub-probes) and
  the repository's **vitest** — `tmp-probe/f03.test.ts` (5 sub-probes, **5/5 green**),
  `tmp-probe/scenarios.test.ts` (7 sub-probes, **7/7 green**), `tmp-probe/second-writer.test.ts`
  (T6, **1/1 green**) and `tmp-probe/gaps.test.ts` (T7–T9, **7/7 green**). An earlier `vite-node`
  attempt at the second probe hung twice and was
  abandoned rather than reported as a pass; re-implementing it under vitest loaded the same module
  graph in 8 seconds.
- **The repository suite was measured on a CLEAN baseline worktree**, not on the shared dirty tree:
  a detached checkout of the audited commit with `node_modules` and the gitignored binary assets
  linked in, per `docs/MULTI-AGENT-GUARDRAILS.md` rules 5 and 6. The audited commit and the current
  tip differ in **zero** non-`.md` files, so the baseline measures today's source (§5.5).
- **Every citation in this report was checked mechanically against the tree.** `tmp-probe/
citation-check.mjs` extracts all 113 `file:line` references and prints the content that is
  actually there now. **All 113 resolve to the content they claim**; the ones that had drifted
  (the `masterAbStore` line, the idempotency-ledger line and the gate's read-back line) were
  corrected.
  This matters because a concurrent session landed a persistence fix **six minutes before this
  report's last commit** — the tree moves faster than a report can be written, so citations are
  evidence that decays and must be re-verified, not assumed.
- **…and the check has a stated limit, which the correction pass exposed.** The script proves that a
  cited **line exists and is not blank**; it does **not** prove the line says what the report claims.
  During the F-10 correction pass a concurrent session had shifted `src/mcp/tools.ts` by **+14
  lines**, so F-06's line references (`4377` → `4391`, `4430` → `4444`, `4457` → `4471`, `4369` →
  `4383`, `4494` → `4509`) still pointed at _plausible, non-blank_ lines and the automated check
  passed them. They were caught only by **re-reading the source for that claim** and correcting them
  by hand. **A citation check that verifies existence is not a citation check that verifies content**;
  every load-bearing citation still needs the reader to open it.
- **The duplicate-guard scan was performed, not promised** (§5.8): 1277 spec files matched against
  all 29 findings, every candidate read and judged.
- **Documents were compared with a deep diff, not `JSON.stringify`.** The naive comparison is
  **key-order sensitive**: on the carrier-free command it reported _"not identical"_ for two
  documents that were in fact identical, and it would have produced a false finding. The deep diff
  (§5.9 T10d) reports the differing **paths**, which is what makes the claim quotable:
  `$.tracks[0].effects[0].params.globalMix: solo=1 collab=30`.
- **The scenario probes reused the repository's own mock-Web-Audio harness** (`tests/mixer-audit3.test.ts`),
  whose recording nodes make the **graph topology** assertable rather than inferable — that is how
  F-10 moved from _strongly indicated_ to _confirmed_ — and the correction pass **re-measured it again**
  (T4 + T4b) and **reversed its verdict**: the lane is a multiplier, the graph is correct, and the
  defect is the label plus the missing effective-value readout.
- **The Critical finding was measured against the vendored core itself** (`createFxEqProcessor`),
  not a stand-in: the probe drives the real `undo()`, the real `normalizePluginParams` and the real
  `setFxEqParam`, so the whole chain — DSP → host → document → normaliser → engine push decision —
  is exercised end to end.
- **The working tree moved during the audit.** `src/mcp/tools.ts` was edited by another session
  mid-probe (mtime 11:36:56, and again at 12:01). The audit therefore **re-measured** rather than
  trusting its earlier reading: F-03 was found to be fixed, F-05/F-06/F-07 were found to still be
  open, and both verdicts are reported (§4/F-03, §5.2). Any finding outside `src/mcp/tools.ts` should
  be re-verified before acting, for the same reason.
- **No browser was driven and no audio was listened to.** The repository suite and the typecheck
  **were** run, on a clean baseline worktree (§5.5) — the production build could not run, because
  `build` starts with the failing `tsc`.
- **Line numbers** were re-verified immediately before writing this file. `src/mcp/tools.ts` was
  under concurrent edit by another session during the audit; a small drift is possible. Where a
  citation is load-bearing for a proposed fix, re-verify before editing.
