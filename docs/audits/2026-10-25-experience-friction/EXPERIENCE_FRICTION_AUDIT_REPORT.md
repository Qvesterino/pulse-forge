# Experience Friction Audit — KYX / Pulse Forge

| Field             | Value                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Audit date        | 2026-10-25 (UTC)                                                                                                        |
| Repository        | `D:\pulse-forge`                                                                                                        |
| Revision observed | `0ffa24f4` plus concurrent in-flight work; `src/ui/ProjectBrowser.tsx` was modified by another session during the audit |
| Mode              | Read-only UX / interaction audit. No production code, settings, presets, projects or audio assets were changed.         |
| Deliverable       | `docs/audits/2026-10-25-experience-friction/EXPERIENCE_FRICTION_AUDIT_REPORT.md`                                        |
| Evidence class    | Static source tracing, existing tests, three executed accessibility suites, prior audit evidence. No human listening.   |

---

## 1. Executive assessment

**Strongest UX areas**

- **One command spine.** The studio is not a set of disconnected widgets: UI gestures, the Intent Engine and MCP all converge on domain commands and `ProjectStore`. Undo is inverse-patch based, not a screen-level illusion. This is the product’s best trust foundation.
- **Transport and keyboard coverage.** Global shortcuts are centralized (`src/ui/shortcuts.ts`), the help overlay documents shortcuts and gestures (`src/ui/HelpOverlay.tsx`, `src/ui/helpContent.ts`), and the command palette is keyboard-complete for the actions it indexes (`src/ui/commandPalette.ts`).
- **Clip-editing depth.** Audio clips expose trim, fades, gain, slip, stretch, warp pins, crossfade, slicing and take workflows through canonical commands. The gesture surface is rich, not decorative.
- **Feedback for long work and agent work.** Save status is visible in the TopBar, export has progress/cancel, and `ActivityCenter` exposes running jobs plus an agent audit with session revert.
- **Accessibility gate exists.** `tests/a11y-panels.test.tsx` runs axe on the four primary surfaces and requires every control to have a non-empty accessible-name hint. It passed in this audit (23 tests across three a11y files).

**Weakest UX areas**

- **Project lifecycle is incomplete in the studio.** There is no in-studio Save As / Save a copy. Versioning requires leaving the studio, finding the project, pressing DUP and reopening it.
- **Track administration is trapped in the Mixer.** Delete, duplicate, group and reorder live almost entirely on the mixer strip; reorder is an undiscoverable mouse-only drag with no keyboard or palette path.
- **Destructive feedback is inconsistent.** Clip deletion shows a recoverable Undo toast; track deletion is immediate and gets only a generic command label, with no Undo action.
- **Recording has two different REC targets.** The global transport REC records MIDI into the active pattern; audio recording is a separate control inside the Arrangement panel. The visible button does not say MIDI.
- **Agent authority is not globally visible.** Enabling MCP destructive operations is a single click inside the Intent panel, persisted across sessions, with no global badge that it is still on.
- **Discoverability is uneven.** The command palette indexes shortcuts and four extras, but not core actions such as save-a-copy, track move, time/pitch, or audio import. Several important gestures exist only on right-click or hover.
- **Language is mixed.** The landing page and most of the app are English; the Intent panel and parts of mastering use Slovak sentences and labels, with no locale system.

**Evidence limits**

- No screenshot pass or human usability session was completed in this audit. A Vite server was started for screenshots but did not complete a request; it was stopped. Findings therefore rely on source paths, existing tests and prior audit evidence, not on visual timing measurements.
- No audio was listened to. Nothing in this report claims an audible defect.
- Interaction counts are derived from code paths, not measured with users. They are lower bounds, not timings.
- Prior audits are used as corroboration, not repeated as new findings. Where a prior audit already owns a defect, this report says so instead of re-selling it.

---

## 2. Verified architecture and interaction map

### 2.1 Entry and navigation

```text
src/main.tsx
  boot -> LandingPage (first visit) -> ProjectBrowser -> Studio
                                     ^                |
                                     |  backToBrowser |
                                     +----------------+
  browser: create template / song starter / import / demo / open / DUP / REN / DEL
  studio:  App shell -> TopBar + Arrangement + Inspector + Dock (two slots) + ActivityCenter
```

- `src/main.tsx:424-432` — `backToBrowser` awaits `services.closeProject()` (which saves) before returning to the browser, so project switching is not a silent data-loss path.
- `src/ui/ProjectBrowser.tsx:660-780` — project rows expose OPEN, DUP, REN, DEL; DUP calls the repository directly (`ProjectBrowser.tsx:331`), not the studio.
- `src/ui/App.tsx:510-535` — first-run INTENT panel and the guided starter are deliberate onboarding, not accidental panel state.

### 2.2 State ownership behind visible controls

| Surface                 | Owner / path                                                                    | Command path                                                           | Persistence / undo                                    |
| ----------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| TopBar transport / save | `src/ui/TopBar.tsx`                                                             | `Transport`, `services.flushSave`, `ProjectStore.undo/redo`            | autosave status; undo stack                           |
| Arrangement gestures    | `src/ui/ArrangementPanel.tsx`                                                   | clip/audio/take commands -> `services.store.execute`                   | autosave; one undoable command per gesture            |
| Mixer strips            | `src/ui/Mixer.tsx`                                                              | `setTrackParams`, `moveTrackAdjacent`, `deleteTrack`, `duplicateTrack` | autosave; undo; selection reconciled after delete     |
| Device / FX             | `src/ui/EffectRack.tsx`, `src/ui/FloatingPlugin.tsx`                            | effect commands -> store                                               | autosave; undo                                        |
| Intent                  | `src/ui/IntentPanel.tsx` -> `src/intent/route.ts` -> `src/intent/*` -> commands | same command layer                                                     | autosave; undo; destructive checkpoint                |
| MCP                     | `src/mcp/tools.ts` -> `ProjectStore`                                            | same command layer                                                     | autosave; undo; session checkpoint; Activity Center   |
| History                 | `src/ui/UndoHistoryPanel.tsx`                                                   | `ProjectStore.jumpTo` / snapshots                                      | undo labels + local snapshots                         |
| Agent activity          | `src/ui/ActivityCenter.tsx`                                                     | read-only over `jobCenter` + `agentTrust`                              | audit lives in memory; session revert uses checkpoint |

### 2.3 Interaction surfaces that actually exist

- **Panel navigation:** 13 dock tabs (`src/ui/DockChrome.tsx`, `src/shared/layout-data.ts`), two dock slots, keyboard shortcuts Alt+1–8 for the first panels.
- **Command palette:** Ctrl/Cmd+K; search + keyboard arrows; actions come from shortcuts plus four extras (`src/ui/commandPalette.ts:54-108`).
- **Help:** `?` opens a searchable shortcut/gesture/editor reference (`src/ui/HelpOverlay.tsx:155-371`).
- **Clip editing:** pointer drags, edge trim, fade corners, gain handle, Alt+edge stretch, Alt+body slip, double-click warp pin, right-click audio menu, long-press delete toast (`ArrangementPanel.tsx:5900-6050, 6600-6800`).
- **Recording:** transport REC -> pattern MIDI recorder (`TopBar.tsx:610-625`); Arrangement REC -> audio input/take recorder (`ArrangementPanel.tsx:4570-4610`).
- **Agent authority:** MCP server/relay controls and the destructive unlock live in the Intent panel (`IntentPanel.tsx:5028-5116`); agent activity appears in `ActivityCenter.tsx`.

---

## 3. Workflow journeys

| Journey                                 | Intended flow                                                              | Friction moments (evidence)                                                                                                                                                                                                                                      | Impact                                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Create -> import -> arrange -> save     | Template -> drop a loop -> arrange clips -> auto-save -> reopen            | Import lives in the browser strip, not the arrangement drop target; project search is absent; save-a-copy requires leaving the studio (`ProjectBrowser.tsx:331,777`; `TopBar.tsx:830-859`).                                                                      | Extra navigation and lost creative context before/after risky edits.                                                 |
| Record -> inspect take -> edit -> undo  | Arm audio track -> REC -> inspect take -> edit -> undo -> continue         | Global REC is MIDI, not audio (`TopBar.tsx:618-624`); audio REC is inside Arrangement (`ArrangementPanel.tsx:4597`); no global target badge tells which recorder is armed.                                                                                       | A singer can overwrite a pattern or believe audio is recording when it is not; two mental models for one red button. |
| FX chain -> tune -> automate -> export  | Add FX -> tune -> automate -> bypass compare -> export                     | Time/pitch and many clip actions are hidden in right-click menus; palette does not index them; plugin/preset discovery remains panel-specific.                                                                                                                   | Users who do not know the hidden menu never find the capability; repeated pointer travel between panels.             |
| AI/intent -> verify -> undo             | Type a command -> see result -> verify -> undo or keep                     | Ordinary intent commands execute immediately; destructive routes save a checkpoint but show no pre-execution scope preview (`IntentPanel.tsx:4134-4145`); generation has audition/confirm, direct edits do not. Activity Center is the only agent audit surface. | The user reads the scope after it happened; undo/checkpoint mitigates but does not replace “what will change?”.      |
| Large project -> locate -> precise edit | Many tracks/projects -> find target -> make one change -> preserve context | No project search/filter (`ProjectBrowser.tsx:660-780`); track admin/reorder requires Mixer; no follow-playhead option found (`ArrangementPanel.tsx:960-988, 4661`).                                                                                             | Scroll-hunting and panel switching dominate; selection context can be lost during navigation.                        |

---

## 4. Finding register

Severity: Blocker / High / Medium / Low. Confidence: Confirmed / Strongly indicated / Hypothesis / Not tested. “Confirmed” means the defect is directly visible in source or an executed test, not that a human usability session measured it.

### F-01 — No in-studio Save As / Save a copy (High, Confirmed)

- **Goal / persona:** Advanced editor or mix engineer wants a named version before a risky change.
- **Reproduction / static path:** In the studio, inspect the save status area: `TopBar.tsx:830-859` only shows SAVED/UNSAVED/SAVING/ERROR and retry. No save-as action exists in `TopBar`, `App` or the palette. The only copy path is leaving to the project browser and pressing DUP (`ProjectBrowser.tsx:331,777`). The MCP `kyx_save` error text even says “use Save As in the project browser”, but the browser button is labelled DUP (`src/mcp/tools.ts:4647-4650`).
- **Observed:** To snapshot a version, the user must click PROJECTS, find the row, click DUP, then reopen the project. That is a context switch out of the music and back.
- **Expected / impact:** A DAW should let a user create a named copy from the current session without leaving it. Snapshots exist in the history panel, but they are not a named project copy and are not a substitute for “Save As”.
- **Smallest safe intervention:** Add “Save a copy…” to the save-status menu and command palette. Reuse `saveProjectAsCopy` (already implemented for MCP) with a name dialog. Do not switch the open project. Show a toast with OPEN / KEEP CURRENT.
- **Risk / regression surface:** repository duplicate/rename, most-recent pointer, collab refusal (`saveProjectAsCopy` refuses during collab), autosave flush. No document schema change.
- **Verification:** one action from studio creates a durable copy; current project id/name unchanged; browser shows the copy; cancel creates no record; reload sees both.
- **Confidence:** Confirmed (source + the copy helper already exists).

### F-02 — Track administration is trapped in the Mixer; reorder is an undiscoverable mouse-only drag (High, Confirmed)

- **Goal / persona:** Arrangement editor or keyboard user wants to delete, duplicate, group or reorder a track without changing panels.
- **Path:** Track tabs expose select, F2 rename, Ctrl/Shift multi-select and sample drop only (`TrackTabs.tsx:100-175`). Duplicate/delete live on the mixer strip (`Mixer.tsx:626-645`). Reorder is dragging the whole strip before/after another (`Mixer.tsx:377-423`). No shortcut or palette action exists for move (`shortcuts.ts`; `commandPalette.ts:54-108`). Help gestures document three arrangement gestures, none for track reorder (`helpContent.ts:42-55`).
- **Observed:** A user in the arrangement must press Alt+1 (or click MIX), find the strip, and know that the strip itself is draggable. Keyboard-only users cannot reorder at all. The same strip has DUP and × adjacent, which raises misclick risk (see F-03).
- **Expected / impact:** Track-level actions should be reachable where the track is named (tab context menu), by keyboard, and through the command palette. The command `moveTrackAdjacent` already exists.
- **Smallest safe intervention:** Add a track-tab context menu (Rename, Duplicate, Delete, Move up/down, Group) and `Alt+Shift+Up/Down`; add palette actions. Keep the mixer drag. Do not introduce a second reorder state—call `moveTrackAdjacent`.
- **Risk / regression:** track order affects group membership, routing and selection; use the existing command and undo. Group tracks may not be draggable (current guard).
- **Verification:** keyboard-only move up/down; context-menu delete/duplicate; undo restores order; group constraints unchanged.
- **Confidence:** Confirmed.

### F-03 — Track delete has no confirmation or actionable Undo toast, unlike clip delete (High, Confirmed)

- **Goal / persona:** Any user who clicks the wrong small button in a dense mixer.
- **Path:** `Mixer.tsx:634-644` executes `deleteTrack` immediately; no confirmation and no checkpoint. The generic command toast (`CommandToast.tsx:8-55`) shows a label for 1.4 s but has no controls. By contrast, arrangement clip deletion sets an actionable toast with Undo (`ArrangementPanel.tsx:1019-1024, 3273, 6319-6322`).
- **Observed:** The strip disappears and the generic toast may say “Delete track” for 1.4 s, but there is no UNDO control in it. Undo remains available only through the normal undo stack; after a reload, the deletion is part of the saved project. The session-start snapshot is a safety net, but the user is not told.
- **Expected / impact:** Destructive actions need either a confirmation for content-bearing tracks or an immediate recoverable receipt. The inconsistency teaches users that clip delete is reversible but track delete is not.
- **Smallest safe intervention:** Show the same “Deleted track — UNDO” toast used by clips; if the track has clips/takes/FX, add a confirmation (or hold-to-delete). Do not add a modal for an empty scratch track.
- **Risk / regression:** Selection pruning, group membership, take/automation references, undo labels; the command already handles cross-references.
- **Verification:** delete track -> toast visible, undo restores track/FX/clips; reload after undo; no stale selection; confirmation only for content-bearing tracks.
- **Confidence:** Confirmed.

### F-04 — The global REC records MIDI, while audio REC is a different control (High, Confirmed)

- **Goal / persona:** Recording artist or singer presses the red transport button and expects audio capture.
- **Path:** `TopBar.tsx:618-624` calls `services.patternRecorder.setArmed(...)`; its tooltip says “Record MIDI into the active pattern — OVERDUB merges … REPLACE clears them first.” The visible control is a red record button with no “MIDI” text. Audio recording is a separate `● REC` inside Arrangement (`ArrangementPanel.tsx:4597`), enabled only when an audio input is armed.
- **Observed:** Two recorders share the same red-dot visual language and no global target badge. A user can arm an audio track, return to the transport, press REC, and capture MIDI into the pattern instead of audio. In REPLACE mode the pattern can be cleared.
- **Expected / impact:** The record control must name its target before the click. This is a safety and mental-model issue, not a preference.
- **Smallest safe intervention:** Label the transport button `MIDI REC` (or a split REC with `PATTERN` / `AUDIO` target chips) and show the armed target. When an audio track is armed, either route the global REC to audio or require an explicit target switch. Keep both paths backed by existing commands.
- **Risk / regression:** Pattern recorder arm/overdub/replace semantics, transport count-in, audio permission gestures, keyboard shortcut expectations.
- **Verification:** with pattern mode, button says PATTERN/MIDI; with audio armed, says AUDIO and records a take; REPLACE cannot fire from an audio-target click; undo/recovery.
- **Confidence:** Confirmed.

### F-05 — MCP destructive permission is a one-click toggle hidden in the Intent panel, with no global indicator (High, Confirmed)

- **Goal / persona:** User who grants an external agent permission to delete tracks/FX.
- **Path:** `IntentPanel.tsx:5104-5116` toggles `setMcpAllowDestructive` immediately. `src/mcp/flags.ts:9-24` persists it in `localStorage` across sessions. No TopBar, Activity Center or dock badge shows that destructive MCP is enabled; Activity Center shows the agent session but not the permission flag.
- **Observed:** A single click in a configuration row turns on irreversible-capable authority for every MCP client using the token. It remains on after reload. The label is Slovak (`MAZANIE`) inside an otherwise English studio.
- **Expected / impact:** Dangerous authority must be visible wherever the user is, and enabling it should be an intentional confirmation, not an accidental click while configuring a token. The current state is a trust gap, not a feature.
- **Smallest safe intervention:** Require a confirmation dialog that names the scope (“external MCP clients may delete tracks, sections and FX”), then show a persistent `AGENT DELETE ON` badge in the TopBar and Activity Center. Offer auto-expiry / “turn off after idle”. Keep the underlying flag.
- **Risk / regression:** MCP policy reads, flag persistence, token/relay setup UX, existing destructive tests. Do not weaken the gate.
- **Verification:** enabling requires confirm; badge appears in every panel; disabling removes it immediately; reload preserves the chosen state; MCP remove still refuses when off.
- **Confidence:** Confirmed.

### F-06 — The command palette does not index core commands (Medium, Confirmed)

- **Goal / persona:** Keyboard-first editor who wants to act without hunting panels.
- **Path:** `commandPalette.ts:54-108` builds actions from the shortcut registry plus four extras: snapshot, gallery, history, diagnostics. It has no actions for save-a-copy, track move, track delete/duplicate, audio import, clip time/pitch, clear solo, or MCP status.
- **Observed:** “Ctrl+K” is presented as the command surface, but it is mostly a shortcut cheat sheet. Commands that lack shortcuts remain invisible unless the user knows the exact panel or context menu.
- **Expected / impact:** The palette should be the discoverable index of actions, even when a shortcut exists. This is the systemic fix for several hidden-gesture findings.
- **Smallest safe intervention:** Add command entries with keywords and existing command runners; group them by Tracks/Clips/Project/AI. Keep shortcuts and palette labels aligned. Do not duplicate business logic—palette actions call the same commands.
- **Risk / regression:** palette focus/shortcut handling, command availability (disabled states), destructive confirmations.
- **Verification:** searching “save copy”, “move track”, “time pitch”, “import audio” returns the action; executing it changes the same state/undo as the panel path; disabled actions are explicit.
- **Confidence:** Confirmed.

### F-07 — The project browser has no search, filter or sort control (Medium, Confirmed)

- **Goal / persona:** User with dozens/hundreds of saved projects or imported sessions.
- **Path:** `ProjectBrowser.tsx:660-780` renders every project row from the repository; there is no search/filter input in the component. Rows are ordered by the repository’s recency order. Templates and demos are separate sections.
- **Observed:** Finding a project means scanning names and timestamps. The CONTINUE card helps only the most recent project.
- **Expected / impact:** Search by name/BPM/tags/transfer origin and sort by name/updatedAt are basic scale affordances. Without them, long-lived users accumulate friction every session.
- **Smallest safe intervention:** Add a local search input (name/BPM/tags/source DAW) and a sort toggle; keep the current recency order as default. No repository schema change.
- **Risk / regression:** rename/delete/duplicate row actions, keyboard focus, empty/error states, first-run template layout.
- **Verification:** typing filters rows; Escape clears; keyboard opens the first match; no-results state; project actions remain scoped to the visible row.
- **Confidence:** Confirmed.

### F-08 — Mixer mute/solo buttons expose only “M”/“S” as their accessible name and omit state (Medium, Confirmed)

- **Goal / persona:** Screen-reader or keyboard user mixing a session.
- **Path:** `Mixer.tsx:600-620` renders `<button>M</button>` and `<button>S</button>` with a `title` but no `aria-label` and no `aria-pressed`. The accessibility gate only asserts that a name hint is non-empty, so the visible “M” passes; it also accepts `title` as a fallback when text is empty. It does not grade name quality and does not assert pressed state (`tests/a11y-panels.test.tsx:53-62,117-137`).
- **Observed:** A screen reader announces “M button” / “S button” without the track name or whether mute/solo is on. This is the most frequently used control pair in mixing.
- **Expected / impact:** Names should be “Mute Drums” / “Solo Drums” and state should be exposed with `aria-pressed`; group mute should say “Mute group Drums”.
- **Smallest safe intervention:** Add `aria-label` and `aria-pressed`; update the a11y gate to require an explicit `aria-label` for single-letter controls and to assert the pressed state. Keep the visual M/S.
- **Risk / regression:** existing shortcut Alt+M/Alt+S; group mute/solo behavior; screen-reader name tests.
- **Verification:** accessible name includes track and action; aria-pressed matches doc; axe/Testing Library; keyboard toggle announces.
- **Confidence:** Confirmed.

### F-09 — Audio-clip trim/fade/gain handles are below the 24×24 pointer target minimum (Medium, Confirmed)

- **Goal / persona:** Touch user, motor-impaired user, or anyone editing a dense waveform.
- **Path:** `src/styles/10-scale-panel-popover-2.css:640-680` sets edge handles to 8 px wide, fade corners to 12×12 px, and the gain handle to 28×7 px. The mobile profile adds `touch-action: none` but not a larger hit box (`src/styles/55-mobile-profile.css:32-38`).
- **Observed:** These are the primary trim/fade/gain affordances; missing them selects or moves the clip instead. WCAG 2.5.8 (AA, WCAG 2.2) asks for at least 24×24 CSS px for pointer targets, with limited exceptions.
- **Expected / impact:** Keep the visual affordance small if desired, but give it an invisible hit area of at least 24×24 and larger on touch. The user should not need pixel precision to fade a vocal.
- **Smallest safe intervention:** Add a pseudo-element/absolute hit box around handles; increase touch-mode sizes; ensure the hit boxes do not overlap the body-drag region or each other.
- **Risk / regression:** clip drag arbitration, pointer capture, fade/gain drag math, overlapping handle zones.
- **Verification:** measured hit rects >=24×24; edge drag still trims; body drag still moves; touch E2E; no accidental fade on a click.
- **Confidence:** Confirmed CSS measurement; actual event hit-testing needs a browser probe.

### F-10 — Clip pitch/time-stretch is hidden in a right-click audio menu and absent from Help/palette (Medium, Confirmed)

- **Goal / persona:** Editor who wants to pitch or stretch a clip.
- **Path:** `ArrangementPanel.tsx:6699-6703` opens the Time & pitch dialog only from the audio context menu. `helpContent.ts:42-55` lists three arrangement gestures and none of the audio menu; the palette has no action. The clip title mentions fades/gain/slip, but not the menu.
- **Observed:** A user who does not right-click the waveform may never discover independent pitch, even though the capability exists and MCP can drive it.
- **Expected / impact:** Core clip transformations need a visible selected-clip affordance (inspector/action bar) and a documented route. Hiding a professional operation behind right-click is avoidable friction.
- **Smallest safe intervention:** Add a “Time & pitch…” button to the selected audio clip’s inspector/action strip and a palette action; add the gesture to Help. Reuse the existing dialog and command.
- **Risk / regression:** clip menu state, dialog focus restore, keyboard access; no new state.
- **Verification:** select clip -> button visible/focusable; dialog opens; pitch/stretch applies and undoes; Help search finds it.
- **Confidence:** Confirmed.

### F-11 — The UI mixes Slovak and English with no locale system (Medium, Confirmed)

- **Goal / persona:** Any user whose language is not the one used in the panel they are reading.
- **Path:** The landing page and most of the studio are English (`LandingPage.tsx`). The Intent panel uses Slovak sentences and labels (`IntentPanel.tsx:460,624,1707,5071,5100,5116,5153`), and mastering has Slovak status copy (`MasteringFileSessionPanel`). No i18n/locale switch exists in `App`/`TopBar`.
- **Observed:** The AI/MCP safety panel — exactly where users most need clarity — can switch language mid-sentence (“GENERATE”, “HOVOR”, “MAZANIE”). English users may not understand destructive permission copy; Slovak users get English everywhere else.
- **Expected / impact:** Either commit to one locale for v1, or introduce a real locale layer. Mixed language is a mental-model and trust issue, not a branding preference.
- **Smallest safe intervention:** Pick the primary locale for the next release; extract the small set of safety/MCP/Intent strings into a dictionary and route all new copy through it. Do not machine-translate every label in one sweep.
- **Risk / regression:** layout width, label tests, documentation, help overlay.
- **Verification:** no hard-coded mixed locale in primary surfaces; switching language persists; safety labels and aria-labels are localized; snapshot tests updated.
- **Confidence:** Confirmed.

### F-12 — Undo history does not show which commands came from an agent (Low/Medium, Strongly indicated)

- **Goal / persona:** User who let an agent edit, then wants to inspect or undo its work.
- **Path:** `UndoHistoryPanel.tsx:129-160` renders only command label, diff and time. `ActivityCenter.tsx:35-45` keeps the agent audit separately and shows tool names. Commands do not appear to carry an actor/origin through `ProjectStore` into history.
- **Observed:** After an MCP/Intent edit, the history looks exactly like a human edit. Ctrl+Z may revert the agent, but the user cannot see that provenance in the history list.
- **Expected / impact:** A mixed human/agent session should say “Agent: set reverb mix” in the same history surface, while retaining global LIFO semantics and normal undo.
- **Smallest safe intervention:** Add an in-memory actor/origin label to command execution metadata and render it in history; do not serialize actor into the project document. Join the existing audit by command id where possible.
- **Risk / regression:** command type surface, history labels, autosave schema (avoid), undo tests.
- **Verification:** agent-origin entry labelled; human entry not; undo/redo still works after reload (actor labels may disappear, provenance is not project data); no serialization diff.
- **Confidence:** Strongly indicated (no actor field found in history).

### F-13 — No follow-playhead option in the arrangement (Medium, Strongly indicated / not live-tested)

- **Goal / persona:** User mixing or auditing a long arrangement while listening.
- **Path:** `ArrangementPanel.tsx` changes `scrollLeft` on zoom re-anchor and FIT (`960-988`, `4661`), but the playhead components only render position (`5348`, `5683`, `7386`). No follow toggle or auto-scroll path was found in `shortcuts.ts` or `helpContent.ts`.
- **Observed:** During playback the playhead can leave the visible window; the user must scroll manually. No “follow” state is exposed.
- **Expected / impact:** A follow toggle (default off, paused when the user scrolls) is standard for long sessions and avoids losing the listening position.
- **Smallest safe intervention:** Add an opt-in follow mode with hysteresis/page jumps, not continuous scroll hijacking. Persist the preference per view, not per project.
- **Risk / regression:** scroll performance, zoom anchoring, selection/playhead re-render cadence; do not break the playhead render isolation.
- **Verification:** play past viewport -> view follows; manual scroll pauses follow; toggle persists; no jank in the clip DOM census.
- **Confidence:** Strongly indicated by absence; needs a live browser test.

### F-14 — Ordinary Intent commands execute without a pre-execution scope preview; MCP has dry-run (Medium, Confirmed)

- **Goal / persona:** User typing a destructive or family-wide command into the Intent panel.
- **Path:** `IntentPanel.tsx:4072-4145` routes and executes directly; destructive routes save a checkpoint first (`4134-4145`) but there is no “targets/values” confirmation. Generation has audition/confirm; exact/fader/clip routes do not.
- **Observed:** “Delete the drums” or a family-wide edit lands immediately; the user sees the result and a checkpoint note afterward. This is safe-ish because undo/checkpoint exist, but it is not the same contract as MCP’s dry-run/destructive gate.
- **Expected / impact:** For destructive or multi-target asks, show a one-line plan (targets, values, undoability) with Confirm/Cancel. Do not add friction to single-target reversible fader edits.
- **Smallest safe intervention:** Reuse the existing route/plan data to render a scope line; only gate routes that are destructive or resolve to more than one target. Keep the command path unchanged.
- **Risk / regression:** extra step in AI flow, route latency, checkpoint semantics, keyboard submit.
- **Verification:** destructive/family ask -> scope shown, cancel leaves doc unchanged; single-target reversible ask -> no modal; MCP/UI semantics documented.
- **Confidence:** Confirmed.

### F-15 — Activity Center rows name tools, not musical actions (Low, Confirmed)

- **Goal / persona:** Musician asking “what did the agent just do?”
- **Path:** `ActivityCenter.tsx:35-45` formats `${time} ${agent} ${tool} [risk] ${duration}`. It does not show the tool’s human result or target; the full audit/report is elsewhere.
- **Observed:** A row like `kyx_plugin_param [✎] 12ms` is meaningful to a developer, not to a musician. The panel is the first place a suspicious user opens.
- **Expected / impact:** The first line should be a human summary (“Set reverb mix on Drums to 25%”), with tool/risk details expandable.
- **Smallest safe intervention:** Derive the row label from the tool result’s first text line / read-back; keep the technical fields in a secondary row. No new audit storage.
- **Risk / regression:** audit entry shape, XSS (React text only), long strings.
- **Verification:** live agent call row reads as a musical action; technical expansion remains; error rows still show code.
- **Confidence:** Confirmed.

---

## 5. Top 10 friction removals

Ordered by workflow impact, destructive risk and breadth. Each item names effort and a verification contract.

| #   | Removal                                                                 | Why it matters                                                            | Effort | Risk / regression                                                | Acceptance                                                                            |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | In-studio **Save a copy…** (F-01)                                       | Restores versioning without leaving the music; uses existing copy helper. | S      | repository duplicate/rename, most-recent pointer, collab refusal | one action creates durable copy; current stays; cancel creates none; reload sees it   |
| 2   | Track actions on the track tab + keyboard reorder + palette (F-02)      | Removes Mixer round-trip and makes reorder keyboard-reachable.            | M      | group constraints, routing, selection; use `moveTrackAdjacent`   | keyboard-only reorder; context menu; undo restores order                              |
| 3   | Recoverable track delete toast + confirmation for content tracks (F-03) | Matches clip delete and prevents silent loss.                             | S      | selection pruning, group membership, undo label                  | toast + UNDO; confirmation only for content; reload after undo                        |
| 4   | Explicit record target (MIDI vs AUDIO) and global armed target (F-04)   | Prevents recording the wrong thing and pattern overwrite.                 | M      | pattern recorder, audio permissions, count-in                    | label/target visible; audio arm records take; REPLACE not reachable from audio target |
| 5   | Visible, confirmed agent-delete authority (F-05)                        | Dangerous authority must not be a hidden persistent toggle.               | S/M    | MCP flag, policy, Activity Center, token UX                      | confirm on enable; persistent badge; disable immediate; MCP refuses when off          |
| 6   | Palette coverage for core commands (F-06)                               | One discoverable index instead of hunting panels/context menus.           | M      | palette deps, disabled states, confirmations                     | search finds save copy/move/time pitch/import; same command/undo                      |
| 7   | Project search/filter/sort (F-07)                                       | Keeps long-lived project libraries usable.                                | S      | row actions, focus, first-run layout                             | filter/sort works; keyboard; no-results; actions remain scoped                        |
| 8   | Mixer M/S accessible names + `aria-pressed`; tighten gate (F-08)        | The most-used mixing controls are ambiguous to screen readers.            | S      | shortcut labels, group mute/solo, a11y gate                      | name includes track+action; state exposed; gate catches regressions                   |
| 9   | Enlarge clip handle hit areas to >=24×24 (F-09)                         | Makes trim/fade/gain reliable for touch and motor-impaired users.         | S      | drag arbitration, overlap, pointer capture                       | measured hit rects; trim/fade still work; no accidental move                          |
| 10  | Localize the safety/AI surface or commit to one locale (F-11)           | Users must understand destructive agent copy in their language.           | M      | label width, tests, docs, help                                   | primary surfaces have one locale or real switch; safety labels localized              |

Additional high-value items not in the top ten: visible Time & pitch action (F-10), agent provenance in undo history (F-12), follow-playhead (F-13), pre-execution Intent scope preview (F-14), human-readable Activity Center rows (F-15).

### 5.1 Cross-system review gate applied

| Proposal                        | UI path                             | Domain command / state                               | Engine / DSP                       | Undo / persistence                               | Verdict                          |
| ------------------------------- | ----------------------------------- | ---------------------------------------------------- | ---------------------------------- | ------------------------------------------------ | -------------------------------- |
| Save a copy…                    | TopBar save menu / palette          | `saveProjectAsCopy` -> repository duplicate/rename   | none                               | no document undo; durable record; collab refusal | Safe                             |
| Track tab actions / reorder     | track tab menu / palette / shortcut | `duplicateTrack`, `deleteTrack`, `moveTrackAdjacent` | track order affects routing        | normal undo + autosave                           | Safe                             |
| Track delete toast              | Mixer toast / global toast          | existing `deleteTrack`; no new mutation              | graph rebuild already handled      | undo restores track/FX/clips                     | Safe                             |
| Record target chips             | TopBar transport                    | existing pattern recorder / audio recorder paths     | capture start/stop, take placement | no new document state; take commands remain      | Safe if one path wins explicitly |
| Agent authority badge/confirm   | TopBar + Activity Center            | `pf:mcp-allow-destructive` flag                      | none                               | localStorage only; no project data               | Safe                             |
| Palette command registry        | Palette                             | calls existing commands, no duplicate logic          | inherits                           | inherits                                         | Safe                             |
| Mixer M/S labels/state          | Mixer                               | existing `setTrackParams`/group commands             | none                               | unchanged                                        | Safe                             |
| Larger clip hit boxes           | Arrangement pointer surface         | existing clip drag commands                          | none                               | unchanged                                        | Safe, verify drag arbitration    |
| Save-as via MCP already present | `kyx_save op:saveAs`                | `saveProjectAsCopy`                                  | none                               | persisted receipt                                | Safe, but UI is missing          |

No proposal adds a second source of truth. The risky proposals to reject are: a separate “UI save as” that writes JSON outside the repository; a second track-order array in React; a record button that bypasses the recorder and writes audio directly; a palette that reimplements commands instead of calling them.

---

## 6. Top 5 experience innovations (speculative, not defects)

1. **Selection-native action bar.** A contextual strip above the arrangement that always shows the top five actions for the current selection (audio clip: trim/fade/pitch/stretch/duplicate; track: mute/solo/group/duplicate/delete). This would turn hidden gestures into visible verbs without adding another panel.
2. **Agent session timeline with diffs.** Extend Activity Center into a scrub-able timeline: each agent action with target, before/after value, and a one-click “restore to here”. The command deltas, checkpoints and audit already exist; the product layer is missing.
3. **Named version shelf.** A lightweight version list in the TopBar (manual snapshot, save-a-copy, auto-session snapshot) with “open a copy” and “compare”. This builds on snapshots and repository copies instead of inventing a new storage model.
4. **One record surface with target chips.** A single transport record control with explicit `PATTERN` / `AUDIO` target chips, armed track badge, and a clear switch between overdub/replace/take modes. This removes the two-REC mental model.
5. **Follow/overview navigator.** A minimap or fit-to-selection navigator with an opt-in follow-playhead mode; useful for long arrangements and for locating the section an agent changed.

---

## 7. Accessibility, keyboard and feedback coverage

| Area                  | Verified in this pass                                                                 | Gap / risk                                                                                               | Unknown / not tested                                |
| --------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Accessible names      | Three a11y suites passed (23 tests); every primary surface passes the project’s gate. | Gate accepts `title` as a name and does not test pressed state; Mixer M/S is the concrete miss.          | Real screen-reader output per control.              |
| Keyboard reachability | Global shortcuts, panel tabs, help search, palette arrows, focus restore tested.      | Track delete/duplicate/reorder lack keyboard/palette paths; clip transforms are pointer-only.            | Full keyboard-only journey through a large session. |
| Focus visibility      | CSS `:focus-visible` rules exist; prior audit found focus restore issues and fixes.   | Dialog focus trap not asserted; palette listbox lacks `aria-activedescendant` (see note).                | Real browser focus order, 200% zoom.                |
| Contrast              | Token math: `--text-faint` #7a8290 on raised surfaces computes 4.07–4.45:1.           | jsdom axe excludes color-contrast; actual composited backgrounds need a browser check.                   | Screenshot/axe pass; high-DPI.                      |
| Touch targets         | Clip handles are 8–12 px; mobile profile does not enlarge them.                       | Below WCAG 2.5.8 24×24 for primary edit handles.                                                         | Real touch-device drag trials.                      |
| Feedback              | Save status, command toast, export progress, Activity Center, take/clip errors exist. | Track delete lacks an actionable undo toast; agent destructive authority is hidden; history lacks actor. | Perceived latency and announcement quality.         |
| Language              | Source shows mixed Slovak/English with no locale layer.                               | Safety copy may be unreadable to the other language group.                                               | Target locale decision.                             |

**Palette accessibility note:** `PaletteOverlay.tsx` uses a dialog/listbox with `aria-selected` buttons; the search input does not expose `aria-activedescendant`, so arrow-key highlighting is visual only. This is a focused follow-up after the naming/state fixes; it is not claimed as measured screen-reader failure here.

---

## 8. Safe phased roadmap

| Phase                            | Work                                                                                                         | Compatibility / regression strategy                                                                        | Exit                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 0 — Quick wins (days)            | Save-a-copy, track delete toast, M/S aria labels/state, project search, language pass on MCP/safety labels.  | Additive UI only; reuse commands/helpers; no schema. Run a11y + mixer/project tests.                       | Each item has a DOM test and a keyboard path.                         |
| 1 — Discoverability (1–2 weeks)  | Track tab actions, keyboard reorder, palette command registry, Time & pitch action, Help gestures.           | Reuse `moveTrackAdjacent`, clip commands; no duplicate state. Snapshot before/after for interaction tests. | Keyboard-only journey passes; palette action parity with panels.      |
| 2 — Trust and safety (1–2 weeks) | Record target chips, agent authority badge/confirmation, Intent scope preview, human-readable activity rows. | Keep MCP gate and command path; no new permissions. Add regression tests for REPLACE and destructive flag. | Wrong-target recording and hidden destructive authority cannot recur. |
| 3 — Scale and navigation (later) | Follow-playhead, project/large-session navigation, version shelf, selection action bar.                      | Opt-in defaults; performance budgets; no transport/audio callback work.                                    | Large-session usability session; no DOM/render regression.            |

Do not bundle the language pass with a redesign. Do not change established shortcuts or the command path while adding palette entries; the palette must call the same domain commands.

---

## 9. Testing plan

**Automated (fast, deterministic)**

- Testing Library: accessible names/`aria-pressed` for Mixer M/S; track tab context actions; project search filtering; save-copy dialog/confirm; toast Undo; palette action availability and disabled states.
- `tests/a11y-panels.test.tsx`: strengthen `accessibleNameHint` to reject title-only names when visible text is a single letter; assert mute/solo state; add the palette listbox `aria-activedescendant` check.
- Command/unit tests: `moveTrackAdjacent` from the palette/track tab; `saveProjectAsCopy` current-stays-open; delete track undo; record target never calls the pattern recorder when audio target is selected.
- CSS/DOM measurement test: clip handle hit boxes >=24×24 (computed style or bounding box in a real browser).

**Browser/E2E (safe, no user assets)**

- Playwright: studio -> save a copy -> browser shows copy -> reopen; track reorder by keyboard; track delete toast/undo; audio REC target; palette search and execute; MCP destructive badge persists/clears.
- Real-browser contrast/axe pass with `color-contrast` enabled (jsdom cannot).
- Focus restoration after dialog/palette, and Tab order on the four primary surfaces.

**Human musician sessions**

- 5–8 users across beginner, advanced editor, recording artist and mix engineer; tasks from §3.
- Measure completion, wrong-target events, undo usage, unnecessary panel switches, and time-to-target only if actually timed.
- Do not treat a prettier screenshot as acceptance. The success criterion is fewer wrong actions and less software-thinking during musical work.

---

## 10. Unverified assumptions, limitations and next questions

1. The Vite screenshot attempt was not completed; no visual/timing claims are made. A future pass should capture 1440/1024 studio, mixer, arrangement and Intent states.
2. The mixer M/S accessible-name finding is source-confirmed; actual screen-reader verbosity depends on the browser/AT pair and was not tested live.
3. The clip handle sizes are CSS-measured; actual hit-testing with overlapping handles and pointer capture needs a browser probe.
4. The follow-playhead absence is strongly indicated by source search, but a live long-timeline test is still needed to confirm there is no hidden follow path.
5. The mixed-language issue assumes an English-first product because the landing page and most panels are English. If the product is intentionally Slovak-first, the finding reverses: the English studio is the inconsistency.
6. The track-delete data-loss risk depends on how quickly autosave persists and whether the user notices the undo window; no timing was measured.
7. The agent authority risk depends on the user's MCP setup and token sharing; the local product still stores the flag in `localStorage`.
8. Prior audits already own some interaction mechanics (clip gestures, focus restore, mixer selection hygiene). This report does not re-open them; it focuses on workflow-level friction and feedback.
9. No user settings, presets, projects or audio assets were modified. No production code was changed.
