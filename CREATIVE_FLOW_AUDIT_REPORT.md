# CREATIVE_FLOW_AUDIT_REPORT — KYX / Pulse Forge

| Field          | Value                                                                                                                                                                                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audit date     | 2026-10-27 (UTC)                                                                                                                                                                                                                                                              |
| Repository     | `D:\pulse-forge`, branch `main`, fixes pushed through `5f32ba99`                                                                                                                                                                                                              |
| Mode           | Audit-to-optimization: read-only evidence sweep + four gate-passing fixes implemented and shipped. No redesigns, no schema changes, no dependency bumps.                                                                                                                      |
| Deliverable    | `CREATIVE_FLOW_AUDIT_REPORT.md` (this file) + commits `f016e2cd`, `11d3e6b0`, `94cc06ef`, `5f32ba99`                                                                                                                                                                          |
| Evidence class | Static source tracing with file:line citations (five parallel read-only sweeps over transport/keyboard, recording, clip editing, sound design, save/AI), existing suites executed locally, prior audits as corroboration. **No human listening, no human usability session.** |
| Prior art      | `docs/audits/2026-10-25-experience-friction/` (F-01…F-15) — every finding re-checked at HEAD; status table in §4.1.                                                                                                                                                           |

---

## 1. Executive assessment

**The one-paragraph verdict.** The studio's flow foundation is unusually strong: one command spine with honest undo, one-gesture-one-undo granularity everywhere it was measured, ghost previews that match the commit, crash-safe capture with a real recovery UI, and a keyboard system with one matcher, rebindable chords and a contextual Escape ladder. The interruptions that remain are not architectural — they are **asymmetries**: paths the engine already supports that the UI never wired (live knob preview existed for PRISM and faders but not the other 40+ devices; save existed but not while typing; the mixer's guarded undo toast existed but the arrangement's twin was unguarded), plus a short list of context-loss moments (Escape-as-stop, zoom lost on panel close, no follow-playhead, playhead not parked after a take) and trust gaps that survived the previous audit unchanged (the one-click MCP destructive toggle).

**What this audit changed (shipped, verified, pushed):**

| Fix   | One line                                                                                                                  | Commit     |
| ----- | ------------------------------------------------------------------------------------------------------------------------- | ---------- |
| CF-01 | Arrangement delete-toast UNDO no longer reverts a newer edit (stale-guard, mirroring the mixer)                           | `f016e2cd` |
| CF-02 | Mixer M/S announce the track name and pressed state (`aria-label` + `aria-pressed`)                                       | `11d3e6b0` |
| CF-03 | Every generic device knob is audible **during** the drag, via the PRISM preview path, with automation/interruption guards | `94cc06ef` |
| CF-04 | Ctrl+S (force save) works while typing; all other chords keep native text behavior                                        | `5f32ba99` |

**Evidence limitations (read this before the findings).** No human musician touched the product during this audit; every "flow cost" claim is code-inferred reasoning about attention, not a measured user. Real-browser journeys were attempted (Playwright `keyboard-guards`, landing→studio) and are **currently unrunnable on the shared tree**: the dev server the runner booted took 36 s to serve the first document and `page.goto` exceeded its 45 s budget while a concurrent session was mid-edit on `src/project-model/schema.ts` and the commands layer (their wave, not this audit's diff — none of the failing steps touch a surface this audit changed). jsdom suites against the same source are green. `npm run typecheck` is red **from the concurrent wave** (7 errors, all in files that session has dirty — zero in files this audit touched). Interaction counts are lower bounds derived from code paths.

---

## 2. Existing strengths — do not change these

These were verified in source during this audit and are the reason the fixes above were small:

1. **One command spine, honest undo.** Every measured gesture commits exactly one undo entry: audio move/resize/stretch/trim/slip/fade/gain (`ArrangementPanel.tsx:3752-3845`), multi-clip move as one composite ("Move N audio clips", `:3697-3742`), PianoRoll note/velocity drags (`PianoRoll.tsx:1143-1189`), Alt-drag duplicate collapsed via `beginUndoFrame` (`PianoRoll.tsx:1095-1113`), mixer faders commit on release only (`Mixer.tsx:598,622,651`).
2. **Gesture terminator.** Escape/blur/pointercancel cancels every drag machine without committing — the old failure mode ("Escape mid-drag, then release COMMITTED the move") is documented and guarded (`ArrangementPanel.tsx:3856-3889`), with a PianoRoll equivalent (`PianoRoll.tsx:1472-1489`).
3. **Ghost previews equal commits.** "The geometry the user is shown is the geometry that lands" (`ArrangementPanel.tsx:3540-3544`), including ripple-mode downstream ghosts.
4. **One shortcut registry feeds every surface.** Palette, help overlay, tooltips and statusbar all derive from `SHORTCUTS` (`commandPalette.ts:54`, `HelpOverlay.tsx:45`, `TopBar.tsx:97`), so bindings cannot disagree between surfaces. Auto-repeat is suppressed for transport chords (`App.tsx:1610-1627`).
5. **Crash-safe capture with a real recovery UI.** PCM commits durably during recording; every failure path preserves staged audio and offers RESTORE TO TIMELINE / RECOVER TO SAMPLES / DISCARD (`ArrangementPanel.tsx:5058-5102`); silent takes are labelled honestly (`:1796-1798`).
6. **Cross-surface destructive checkpoint net.** Intent and MCP share one `routeIsDestructive` predicate and one checkpoint store; restore is itself one undoable step (`route-guard.ts:17-52`, `IntentPanel.tsx:4366-4377`).
7. **Honest export semantics.** Cancelled/failed/done are distinct outcomes with distinct copy and stated cancellation granularity (`ExportPanel.tsx:361-373, 1536`).
8. **Doc-persisted effect A/B with single-command recall** on the flagship devices (`EffectAbControls.tsx:40-137`, `plugins.ts:299-353`), and a **declicked bypass** (15 ms wet/dry crossfade, tails preserved — `AudioEngine.ts:1817-1831`).
9. **Snap done right:** persisted per-view, J-togglable, Shift-suspend, secondary targets within 8 px, delta-snap preserves internal spacing (`snap.ts:60-105`, `ArrangementPanel.tsx:3560-3579`).
10. **Dock persistence:** 14 tabs / 2 slots, layout + slot assignment survive reload in versioned `pf-layout` (`DockChrome.tsx:34-129`, `dockLayout.ts:205-220`).

---

## 3. Creative journey maps (interruption inventory)

Format: musical objective → where attention leaves the task. All citations verified at HEAD.

**J1 — Idea → arranged clip → auditioned.** Template/drop → arrange → space to hear. Friction: zoom/scroll live in component state and die with the ARR tab (`ArrangementPanel.tsx:578`, unmount at `App.tsx:1928-1958`); the playhead leaves the viewport during playback and nothing follows it (`ArrPlayheadLine` only renders position, `:7438-7456`); Escape with nothing selected stops playback and rewinds to bar 1 (`Transport.ts:175-183` sets `pauseTick = 0`; binding `shortcuts.ts:121`).

**J2 — Heard a problem → edit → A/B → keep or undo.** Select → trim/fade → compare. Friction: generic device knobs were silent during the drag (CF-02 — fixed); A/B exists only on the 5 flagship devices (`EffectRack.tsx:1268-1280`); an empty A/B slot click flips `active` with no audible change (`EffectAbControls.tsx:69-76`); bypass has no keyboard chord anywhere (`shortcuts.ts` has zero bypass entries) and its "B" button sits directly above the A/B slot "B" button on flagship editors — same letter, two meanings (`EffectRack.tsx:937-944`).

**J3 — Arm → perform → take → retry/comp.** Friction: after STOP the transport keeps rolling and the playhead is not returned to the take start (`stopRec` contains no seek, `ArrangementPanel.tsx:1628-1846`), so an immediate SINGLE-TAKE retry records at the drifted playhead (`:4676` "at the playhead"); latency calibration — which produces the audio offset applied to mic takes — is reachable only from the MIDI panel (`MidiPanel.tsx:172-174`, no other mount in `src/ui`); live take-lane audition is Song-mode only (`:2632-2634` — Pattern mode gets an error, not an offer); the native WASAPI path can capture from a different source than the dropdown named, disclosed only after the take (`:1802-1810`).

**J4 — MIDI REC.** Friction: selecting REPLACE while armed clears the active pattern **instantly**, straight from the dropdown's `onChange` (`TopBar.tsx:719` → `patternRecorder.ts:78-109` → `project.ts:88-115` zeroes the pattern); mitigation exists (the whole pass collapses into ONE "Recorded take" undo frame) but nothing tells the user that at the moment of the clear.

**J5 — Ask the AI / agent.** Friction: the MCP destructive toggle (MAZANIE) is still one click, persisted across sessions, with no confirmation and no global badge — grep for it in `src/ui` matches only `IntentPanel.tsx:5351-5366`; the intent plan line is passive and blind to `arrange`/`clips` routes (`intent-plan.ts:450-468` falls to `default: []`); MixPreviewChip's APPLY executes the frozen command against the _current_ document with no staleness check (`MixPreviewChipLazy.tsx:140-144` vs the IntentPanel's `previewDocRef` revision guard at `IntentPanel.tsx:1741-1747`) — what lands can differ from what was heard.

**J6 — Save → crash → recover → export.** Friction: recovery (uncommitted-work buffer) is offered only in the ProjectBrowser on next boot (`ProjectBrowser.tsx:550-591`), never in-session; a deep-link or "continue" user never sees the offer. Export itself is a strength (§2.7).

---

## 4. Finding register — top 15

Severity: Blocker / High / Medium / Low. Confidence: Confirmed (visible in source or an executed test) / Strongly indicated. Status reflects what this audit did.

### CF-01 | High | Confirmed | **FIXED — commit `f016e2cd`**

- **Goal:** undo a mis-clicked clip delete within the toast's 6 s window.
- **Was:** the arrangement toast's UNDO called `store.undo()` unconditionally (`ArrangementPanel.tsx:6391-6397` pre-fix); after any newer edit, one click reverted _that edit_, not the deletion. The mixer's twin had carried the stale-guard since the 2026-10-25 audit (`Mixer.tsx:287-292`) — the inconsistency was the defect.
- **Fix:** toast captures `undoDepth` at arm time; UNDO fires only while the delete is still the newest command. Negative spec added. Same contract, same words, both panels.

### CF-02 | High | Confirmed | **FIXED — commit `94cc06ef`**

- **Goal:** tweak a device knob while the loop plays and _hear_ the move.
- **Was:** the shared `Slider` fires rAF-coalesced `onPreview` (`controls.tsx:320-327`) and the engine has a generic fire-and-forget preview write (`previewFxParam`, `AudioEngine.ts:3749-3771`, degraded-runtime-guarded) — but the generic `EffectParameterGrid` passed only `onCommit` (`EffectParameterGrid.tsx:100` pre-fix). Result: PRISM EQ and mixer faders were audible during drags; the other ~40 devices were silent until pointer-up. The product's most common sound-design gesture lacked its best-supported path on most of its surface.
- **Fix:** grid forwards `onPreview`/`onCancelPreview` per param; the rack wires them to `previewFxParam` with two guards — an automation-driven parameter never previews (the lane owns the sound), and an interrupted drag re-writes the committed value through the runtime with no document command and no junk undo entry. Commit is still exactly one command on pointer-up. New seam `fx-knob-live-preview` in `tests/seam-manifest.json` (real drag + two negatives). `KitMultiview`'s overview columns stay commit-only (props optional).

### CF-03 | Medium | Confirmed | **FIXED — commit `11d3e6b0`**

- **Goal:** a screen-reader user mixing a session must know which channel they are muting and whether it is muted.
- **Was:** F-08 of the 2026-10-25 audit, still open at HEAD: bare "M"/"S" text, state carried only by a CSS class (`Mixer.tsx:686-710` pre-fix). The a11y gate accepts any non-empty name, so it passed.
- **Fix:** `aria-label` "Mute/Solo `<track>`" (group-aware) + `aria-pressed`; assertion added to the gesture seam spec.

### CF-04 | Medium | Confirmed | **FIXED — commit `5f32ba99`**

- **Goal:** force-save from anywhere, including mid-typing.
- **Was:** the blanket typing guard sat before every chord handler (`App.tsx:1232`), so Ctrl+S did nothing while the caret was in any input/select/textarea — including the intent prompt and the project-name field. The registry documents Ctrl+S unconditionally (`shortcuts.ts:124-132`).
- **Fix:** the save chord is handled before the bail (`App.tsx:1233-1240`); every other chord keeps native text behavior — Ctrl+Z inside a field is still text-level undo, pinned by a negative spec.

### CF-05 | High | Confirmed | Status: **FIXED — commit `892dcc61`** (the design decision was approved by the product owner)

- **Finding:** bare **Tab** fell through the global keydown handler to next/prev track whenever any focusable element held focus — the transient-jump branch only owned the body-focus case (`tabNavigationTarget` computed, `App.tsx:1269-1275`), so a keyboard user could not reach a second control in any panel. The single largest keyboard-accessibility gap in the product.
- **Root cause:** the inverted asymmetry — canvas-focus Tab was owned by the transient-jump feature (or next/prev track when no clip is selected), while focused-element Tab was hijacked to track selection.
- **Fix:** the handler returns before the transient-jump branch when the target sits inside the interactive selector that branch already computes — no action, no `preventDefault`, the panel's controls traverse natively. Canvas focus keeps both FL behaviors untouched. Registry labels disclose the scope ("Next track (when no control has focus)").
- **Verification:** jsdom specs pin both sides (Tab/Shift+Tab on a focused control not intercepted; canvas Tab still taken); verified in a real browser against the built bundle — synthetic Tab and Shift+Tab on a focused track tab leave `defaultPrevented` false while a canvas-focus Tab is still handled. New seam `tab-traversal` (absorbed into a peer commit with the manifest). The Playwright journey is staged in `keyboard-guards.spec.ts` for when the shared dev server is healthy.
- **Acceptance met:** Tab from a control traverses; Tab on the canvas still belongs to the transport/transient features; all affected suites green (App 16/16, track-reorder, ux-audit, melodicKeys, a11y panels — 39/39).

### CF-06 | Medium-High | Confirmed | Status: **FIXED — owner-approved, shipped in HEAD (absorbed by commit `f5832eec`)**

- **Finding:** **Escape while playing stopped playback and rewound to bar 1.** Escape is the "back out" key; the contextual ladder (captureOffer → menu → help → selection → tool → blur, `App.tsx:1180-1225`) ended by falling through to the `stop` binding, and `stop()` unconditionally resets `pauseTick = 0` (`Transport.ts:175-183`). A musician pressing Escape to dismiss a stray tooltip lost playback _and_ position.
- **Fix (the written rule, approved):** **Escape never touches the transport.** The stop chord moved from Escape to **Shift+Space** ("Stop — return to start"); Space still pauses in place, Home still returns to start; the exhausted Escape ladder is a documented no-op in the handler. Stop remains on the ■ button and in the command palette; the registry-derived surfaces (help, tooltips, statusbar) updated automatically.
- **Verification:** four jsdom specs (bare Escape neither stops nor seeks; Shift+Space stops; bare Space still play/pauses and does NOT stop; Escape inside a text field blurs without stopping) + real-browser proof against the built bundle: during playback the transport showed `❚❚`, a synthetic bare Escape left it playing, Shift+Space returned it to `▶`.

### CF-07 | High (risk perception) | Confirmed | Status: **FIXED — commit `e063fa0e`**

- **Finding:** selecting **REPLACE while armed clears the active pattern instantly** — straight from the dropdown `onChange`, via `setArmed`/`setMode` into `prepareRecordPattern`. During a performance, one mis-click empties the beat. The whole pass (clear + notes) is ONE "Recorded take" undo frame, but nothing surfaced that at the moment of the clear; the only guard was tooltip text.
- **Fix (the approved proposal — behavior kept, silence removed):** every trigger funnels through `runReplaceClear()`, which now fires an `onReplaceClear` hook; services turns it into a window event and the TopBar answers on its existing `mode-hint` surface: "REPLACE cleared the pattern — one Ctrl+Z brings it back". The copy is honest at any moment — `ProjectStore.undo` seals the open record frame first, so the single undo takes the whole pass back, clear included, even mid-take. The wipe itself is unchanged; no friction added to the happy path.
- **Verification:** recorder unit specs (hook fires exactly once per pass — at arm and on a mid-pass mode flip — and never on overdub), TopBar specs (the `role="status"` disclosure renders on the event and NOT when arming through the real record button), seam `pattern-replace-disclosure` (96 seams, gate green), typecheck clean. Real-browser run was skipped this time: the in-app browser guest refused to attach for the whole session — the two-sided jsdom seam carries the proof.

### CF-08 | High (for the recording journey) | Confirmed | Status: **FIXED — commit `28e68a71`**

- **Finding:** **latency calibration was unreachable from the record flow.** The wizard's audio phase produces the per-device offset applied to mic takes, and per-device storage is excellent — but the only mount in `src/ui` was a button inside the MIDI panel. Nothing near the record toolbar said "un-calibrated / calibrated (+N ms)".
- **Fix:** the record toolbar discloses the armed input's state LIVE through the shared per-device controller — `NOT CALIBRATED`, or `CALIBRATED ±N ms` (the same number `compensateRecordingStartBar` applies, so the readout cannot disagree with the placement) — and a **CALIBRATE** button opens the same wizard, lazy-loaded so the boot-path closure does not pay for a ~20-second dialog (the boot-path seam gate stays green).
- **Verification:** toolbar spec — NOT CALIBRATED before a measurement exists, the wizard opens from the toolbar and closes, and a set offset reads live in both signs through the SAME controller the placement uses; seam `record-flow-calibration` (100 seams, gate green).

### CF-09 | Medium | Confirmed | Status: **FIXED — commit `28e68a71`** (F-13 closes with it)

- **Finding:** **no follow-playhead.** The playhead line is a positioned leaf driven by `usePlayheadBar` (1/8-bar cadence); the only `scrollLeft` writes were zoom re-anchor and FIT. During a long play the playhead exits the viewport and the user hand-scrolls.
- **Fix:** opt-in **FOLLOW** control in the view cluster, default off, persisted per browser (`pf:arr-follow`, view-layer policy like snap). The jump rides the EXISTING playhead leaf — no new subscriptions, nothing else re-renders — and fires only when the playhead leaves the comfortable window (15–75 % of the viewport), landing it at 20 % from the left: rare page jumps, never continuous tracking. A USER scroll suspends follow (persisted off); the app's own writes — the follow jump itself, FIT, zoom re-anchor — mask themselves with a programmatic-scroll flag and never do.
- **Verification:** pure `followScrollLeft` decision table (in/out of window both sides, clamps, zero-width viewport), toggle persistence, and the mask negative (a masked scroll leaves follow on; an unmasked one suspends it). The DOM census budget moved 53 260 → 53 280 for the measured +3 FIXED shell elements — per-clip cost unchanged; census, viewport-windowing and boot-path gates green.

### CF-10 | Medium-High | Confirmed | Status: **FIXED — commit `197f89c8`**

- **Finding:** **after a take, the playhead is not parked.** `stopRec` performed placement, compensation and toasts but no seek. Take-group passes already anchor to the group start (a seek the panel itself makes when the next pass starts) and loop passes ride the loop locators — the SINGLE take was the one flow with no anchor, and its retry recorded "at the playhead", which had rolled on. The highest-frequency interruption in the record journey.
- **Fix:** after the placement lands, `stopRec` parks the playhead at the take's latency-compensated start bar and the placement notice discloses it ("Playhead returned to the take start."). The decision is a pure table (`takeStartReturnTick`): punch keeps its documented post-roll, loop and take-group captures return null (their anchoring contracts own the playhead), and a failed placement never claims a parked playhead. A **RETURN TO START toggle** sits next to DRY SOFT MON — default on, persisted per browser (`pf:rec-return-to-start`) — so the roll-on behavior stays one click away.
- **Verification:** specs drive the REAL `stopRec` through the fake recorder — the parked seek is the last seek and equals the take's start bar (clip placed at bar 5, notice shown); the OFF toggle leaves the playhead alone while the take still places; the decision table pins every null branch plus fractional/negative clamps. Suite 37/37, ArrangementPanel + recording-audit 38/38, seam gate 98 seams, typecheck clean. (Harness note: the mock transport's frozen clock cannot express positions, so the fixture owns the recorded `session.startBar` — the honest recorded reality — and the assertion reads the seek + the placed clip.)

### CF-11 | Medium | Confirmed | Status: **FIXED — commits `06c4d173` (peer snapshot) + `e6276191` (completion)**

- **Finding:** **arrangement zoom/scroll died with the dock tab.** `zoom` was panel `useState`; the panel unmounts on every re-route; nothing persisted zoom or scrollLeft. The panel-local `selectedClipId` (which drives take lanes, warp pins and the context menus) was likewise lost on a Mixer round-trip, while the shared `SelectionStore` selection survived.
- **Fix:** a per-project view-state module (`src/ui/arrangementViewState.ts`) — zoom, horizontal position and BOTH panel-local clip foci persist under `pf:arr-view:<docId>` (localStorage, snap's view-layer policy, never the document). Defensively re-validated payload (malformed JSON degrades to "no saved view"; wrong-typed fields dropped), a debounced writer fed by zoom/selection changes and the lane scroll, a synchronous unmount flush, and clip ids validated against the document on restore so a deleted clip selects nothing. Cross-project leakage is impossible by the key; CF-09's follow state already had its own key.
- **Verification:** module round-trip + malformed/junk payload degradation; panel-level restore (seeded `zoom: 1.4` + `selectedClipId` → the SECS field is present and the lanes are 1.4× wider on remount) with a cross-project negative (doc B mounts clean); the deleted-clip negative; zoom/scroll persistence through the debounced writer. ArrangementPanel 39/39, census/boot-path green, seam `arrangement-view-state` (101 seams). Provenance note: a peer commit (`06c4d173`, "jedeme dal") absorbed the mid-flight wiring with a TDZ ordering bug; the completion commit (`e6276191`) moves the block below the fields it saves, fixes the round-trip expectation, and pins the seam — the tree is green as of `e6276191`. Still open from this finding: the dock's focus-drop-to-body half (CF-22).

### CF-12 | Medium | Confirmed | Status: **FIXED — commit `f9dbb25a`** (F-10 closes with it)

- **Finding:** **Time & pitch (and Spectral Lab) existed only in the audio right-click menu** — not in the palette, not in Help gestures, not on any selected-clip affordance. The capability was one undoable command once found (`updateAudioClip`); discovery was the entire cost.
- **Fix:** three routes lead to the SAME dialogs — the selected audio clip exposes **TIME&PITCH** and **SPECTRAL** buttons in the arrangement toolbar's clip actions; the command palette lists both entries (**disabled with "Select an audio clip first"** while none is selected — audio clicks feed the shared selection store, which is what answers the check); and the Help gestures name all three routes. The panel listens for the palette's open events and targets its selected audio clip — no second implementation of either dialog, no new state.
- **Verification:** affordance presence + the dialog opens from BOTH the toolbar button and the palette window event; negatives (no selection → no affordance, no dialog; palette rows carry the reason); palette run dispatches the events. 95/95 across the six affected suites (ArrangementPanel, palette exposure, App, HelpOverlay, a11y, boot-path), seam `audio-clip-transform-discovery` (102 seams).

### CF-13 | Medium | Confirmed | Status: TIER B (F-07, still open)

- **Finding:** **the project browser has no search/filter/sort.** The only inputs are import/rename fields; ordering is hard-coded `updatedAt` desc at module scope (`ProjectBrowser.tsx:84, 823-905`). Long-lived libraries degrade every session.
- **Proposed:** local name/tag/BPM filter + sort toggle, recency default, no repository change.

### CF-14 | Medium-High (trust) | Confirmed | Status: DESIGN REVIEW (F-05, unchanged at HEAD)

- **Finding:** **the MCP destructive permission is a one-click, persisting toggle with no confirmation and no global badge.** `IntentPanel.tsx:5351-5366` flips it immediately; `pf:mcp-allow-destructive` survives reloads (`flags.ts:26-35`); grep shows no TopBar/ActivityCenter indicator — the closest is the risk-agnostic `AGENT n` chip (`ActivityCenter.tsx:161-168`). `flags.ts:15-23` itself documents the gap as recorded, not hidden. The consent toggle beside it is likewise single-click (`IntentPanel.tsx:535-556`).
- **Proposed:** confirmation naming the scope on enable + a persistent TopBar badge while on + optional idle expiry. Keep the flag semantics; do not weaken the MCP gate.

### CF-15 | Medium-Low | Confirmed | Status: TIER A

- **Finding:** **the cut-tool indicator vanishes exactly when it matters.** The statusbar chip "TOOL CUT (V = select)" lives in `StatusHint`'s fallback (`App.tsx:1980-1983`), which any `[data-hint]` hover/focus replaces (`StatusHint.tsx:36-38`); the CUT toggle is only visible inside the ARR toolbar; the lane crosshair cursor exists only while hovering a lane (`04-arrangement.css:950-953`). Bare C/V also appear in neither `SHORTCUTS` nor `helpContent.ts` — the tool is documented nowhere user-facing (`App.tsx:1542-1544` is a code comment).
- **Proposed:** hoist the active-tool chip out of the fallback (render it _before_ hint substitution, or pin it as its own element), and add C/V to the registry-derived surfaces. Small, additive, no gesture changes.

### Secondary findings (verified, below the top-15 line)

| ID    | Finding                                                                                                                                                                                                      | Evidence                                                        | Status                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | -------------------------- |
| CF-16 | Take-lane live audition is Song-mode-only; Pattern mode gets an error, not an offer to switch                                                                                                                | `ArrangementPanel.tsx:2632-2634`                                | TIER B                     |
| CF-17 | Two comp systems do not interoperate: arrangement take lanes vs the vocal-lane `planVocalComp` → vocalchop tracks (IntentPanel only)                                                                         | `IntentPanel.tsx:6266`, `vocal/comping.ts:72`                   | DESIGN REVIEW              |
| CF-18 | Clicking an empty A/B slot flips `active` with no audible change (status does say EMPTY)                                                                                                                     | `EffectAbControls.tsx:69-76,132-134`                            | TIER A micro               |
| CF-19 | MixPreviewChip APPLY has no staleness guard: the frozen command executes against the current doc — what lands can differ from what was heard                                                                 | `MixPreviewChipLazy.tsx:140-144` vs `IntentPanel.tsx:1741-1747` | PROTOTYPE                  |
| CF-20 | Generative resample variations live in component state and are wiped by a track switch                                                                                                                       | `Inspector.tsx:159-176`                                         | TIER B                     |
| CF-21 | Native WASAPI can capture a different source than the dropdown named; disclosed only after the take                                                                                                          | `ArrangementPanel.tsx:1802-1810`                                | TIER B (pre-REC indicator) |
| CF-22 | Closing the dock panel that holds focus drops focus to `<body>`; the dock never uses `useFocusRestore`                                                                                                       | `App.tsx:1928-1958`, hook used only by 5 overlays               | TIER A                     |
| CF-23 | ActivityCenter rows name tools, not musical actions (F-15); undo-history provenance is a `[agent-id]` label prefix only (F-12 partial, via `c9b56265`)                                                       | `ActivityCenter.tsx:35-45`, `attribution.ts:33-39`              | DEFER                      |
| CF-24 | Melodic/pad QWERTY shadows plain-letter shortcuts (L, S, …) whenever a drum/instrument track is selected — intentional and help-documented, but "my loop key died" is a live trap when switching track kinds | `App.tsx:695-696, 1157-1166`, `melodicKeys.ts:43-48`            | DEFER (document)           |

### 4.1 — Prior audit (2026-10-25, F-01…F-15) status at HEAD

| Prior | Finding                            | Status at HEAD now                                                                                                                          |
| ----- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| F-01  | In-studio Save a copy              | **FIXED by others** — TopBar ⋯ "SAVE AS" + dialog (`TopBar.tsx:479-488, 1071-1130`)                                                         |
| F-02  | Track admin trapped in Mixer       | **FIXED by others** — TrackTabs context menu + Alt+Shift+↑/↓ (`TrackTabs.tsx:209-274`)                                                      |
| F-03  | Track delete toast                 | **FIXED by others** — actionable UNDO with stale-guard (`Mixer.tsx:281-298`)                                                                |
| F-04  | Unlabeled global REC               | **PARTIAL** — title/aria say MIDI, the visible button is still an unlabeled ⏺ (`TopBar.tsx:680-711`)                                        |
| F-05  | MCP destructive one-click          | **UNCHANGED** → this audit's CF-14                                                                                                          |
| F-06  | Palette coverage                   | **PARTIAL** — track actions indexed; save-copy and time-pitch absent (`commandPalette.ts:54-106`)                                           |
| F-07  | Project browser search             | **OPEN** → CF-13                                                                                                                            |
| F-08  | Mixer M/S accessible names         | **FIXED by this audit** → CF-03                                                                                                             |
| F-09  | Clip handle hit areas              | **PARTIAL by others** — touch enlarged (`pointer: coarse`, fade 22², gain 44×14, warp pins 28 px hitbox); desktop sizes unchanged (8/12 px) |
| F-10  | Time & pitch hidden in right-click | **FIXED by this audit** → CF-12 (`f9dbb25a`)                                                                                                |
| F-11  | Mixed Slovak/English               | **OPEN** (not re-litigated here; prior audit's recommendation stands)                                                                       |
| F-12  | Undo-history agent provenance      | **PARTIAL** — label prefix only (`attribution.ts:33-39`)                                                                                    |
| F-13  | Follow-playhead                    | **FIXED by this audit** → CF-09 (`28e68a71`)                                                                                                |
| F-14  | Intent scope preview               | **PARTIAL by others** — passive plan line + destructive checkpoints; no gating, arrange/clips routes blind (`intent-plan.ts:450-468`)       |
| F-15  | ActivityCenter human-readable rows | **OPEN** → CF-23                                                                                                                            |

---

## 5. Root-cause pattern and before/after shapes

Three root causes explain most of the register:

1. **Capability wired at one surface, absent at its siblings.** The engine/plumbing already supports the interaction (`previewFxParam`, `useFocusRestore`, the stale-guard toast contract, the layout store); one call site got it and its siblings did not. CF-02/03/04 and CF-11/15/22 are all this shape. Before: knob silent until release → After: audible during drag, one commit, guards for automation and interruption. The fix pattern is always "route the sibling through the existing owner", never a parallel mechanism.
2. **Transport/keyboard semantics doing double duty.** Escape = "back out of UI" AND "stop + rewind" (CF-06); Tab = "next track" AND "DOM traversal" (CF-05). The matcher needs one more distinction (what holds focus / what the ladder exhausted), not new chords.
3. **Disclosure timing.** REPLACE clears silently (CF-07), WASAPI mis-capture is disclosed post-take (CF-21), MixPreview lands may differ from what was heard (CF-19), calibration state is invisible at the mic (CF-08). The information exists in every case; it arrives after the commitment.

---

## 6. Prioritization matrix

Scored 1–5 (impact, frequency, confidence, effort⁻¹, risk⁻¹ — higher is better; effort⁻¹ 5 = hours, 1 = weeks).

| ID                   | Impact | Freq | Conf | Effort⁻¹ | Risk⁻¹ | Sum   | Category                                           |
| -------------------- | ------ | ---- | ---- | -------- | ------ | ----- | -------------------------------------------------- |
| CF-01                | 4      | 3    | 5    | 5        | 5      | 22    | **FIX NOW (shipped)**                              |
| CF-02                | 5      | 5    | 5    | 4        | 4      | 23    | **FIX NOW (shipped)**                              |
| CF-03                | 3      | 5    | 5    | 5        | 5      | 23    | **FIX NOW (shipped)**                              |
| CF-04                | 3      | 4    | 5    | 5        | 5      | 22    | **FIX NOW (shipped)**                              |
| CF-05                | 5      | 5    | 5    | 3        | 2      | 20    | **FIXED after owner approval (commit `892dcc61`)** |
| CF-07                | 4      | 3    | 5    | 4        | 4      | 20    | **FIX NOW (shipped — disclosure, not friction)**   |
| CF-10                | 4      | 4    | 4    | 4        | 3      | 19    | **FIXED (default-on toggle, `197f89c8`)**          |
| CF-09                | 4      | 4    | 4    | 3        | 3      | 18    | **FIXED (opt-in page-jump follow, `28e68a71`)**    |
| CF-19                | 3      | 3    | 4    | 3        | 3      | 16    | PROTOTYPE                                          |
| CF-12                | 3      | 3    | 5    | 4        | 4      | 19    | **FIX NOW (shipped — `f9dbb25a`)**                 |
| CF-08                | 4      | 3    | 5    | 3        | 4      | 19    | **FIX NOW (shipped — `28e68a71`)**                 |
| CF-13                | 3      | 4    | 5    | 4        | 4      | 20    | TIER B                                             |
| CF-11                | 3      | 3    | 5    | 3        | 3      | 17    | **FIXED (per-project view state, `e6276191`)**     |
| CF-15                | 2      | 3    | 5    | 5        | 5      | 20    | TIER A                                             |
| CF-22                | 2      | 3    | 5    | 4        | 5      | 19    | TIER A                                             |
| CF-06                | 4      | 3    | 5    | 3        | 2      | 17    | **FIXED after owner approval (Shift+Space chord)** |
| CF-14                | 4      | 2    | 5    | 3        | 3      | 17    | DESIGN REVIEW                                      |
| CF-17                | 4      | 2    | 4    | 1        | 2      | 13    | DESIGN REVIEW                                      |
| CF-16/18/20/21/23/24 | 2–3    | 2–3  | 4–5  | 3–5      | 4      | 15–18 | TIER B / DEFER                                     |

Rejected proposals (would trade control for clicks, or add a second source of truth): a palette that reimplements commands instead of calling them; a second track-order array in React; auto-scroll that hijacks the user's scroll position without hysteresis; replacing REPLACE's semantics with a modal in the middle of a performance; serializing actor provenance into the project document.

---

## 7. Small fixes implemented (exact files)

| Fix   | Files                                                                                                                                                                                                               | Why it passed the gate                                                                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CF-01 | `src/ui/ArrangementPanel.tsx` (toast state + capture + guarded click), `tests/ui/ArrangementPanel.test.tsx` (negative spec)                                                                                         | Root cause evidenced by the mixer's own guarded twin; patch 4 lines + comment; mirrors an existing contract; no gesture/undo semantics change                       |
| CF-02 | `src/ui/EffectParameterGrid.tsx` (optional props + forwarding), `src/ui/EffectRack.tsx` (rack wiring + guards), `tests/ui/EffectRack.test.tsx`, `tests/ui/EffectParameterGrid.test.tsx`, `tests/seam-manifest.json` | Reuses `previewFxParam` (shipped for PRISM), degraded-runtime-safe by construction; three specs enter the real drag seam incl. two negatives; commit path untouched |
| CF-03 | `src/ui/Mixer.tsx` (aria-label + aria-pressed), `tests/ui/mixer-mute-solo-gesture.test.tsx`                                                                                                                         | Purely additive accessibility semantics; the existing seam spec asserts it; a11y gate re-run green                                                                  |
| CF-04 | `src/ui/App.tsx` (save chord before the typing bail), `tests/ui/App.test.tsx` (positive + two negatives)                                                                                                            | Restores the documented global chord; text-editing chords explicitly unchanged and pinned; 10-line patch                                                            |

Verification for the four (executed locally, 2026-10-27):

- `tests/ui/EffectRack.test.tsx` + `EffectParameterGrid.test.tsx`: 56/56 green. `ArrangementPanel.test.tsx` toast specs 2/2. `mixer-mute-solo-gesture` 4/4. `App.test.tsx` + `track-reorder-shortcut` 19/19. `Mixer.test.tsx`, `MixerDeleteToast.test.tsx`, `mixer-fader-gesture.test.tsx`, `a11y-panels.test.tsx` green.
- `node scripts/check-seam-coverage.mjs`: PASSED — 90 seams, no false claims.
- `npx prettier --check` on all touched files: clean.
- `npm run typecheck`: **red from the concurrent session's in-flight wave** (7 errors in `src/project-model/schema.ts`, `tests/analysis/contract-timeline.test.ts`, `tests/param-range-coherence.test.ts` — every one a file that session has dirty; zero errors in files this audit touched). Not drift:blessed, not "fixed" — their wave owns it.
- `npm run drift:check`: three drifts (domain goldens, status.json, spec count 1284→1294) — all attributable to the same concurrent wave's new files; left for its owner.
- Playwright real-browser journeys: **blocked on the shared tree** (dev-server boot storm while the parallel wave edits; `page.goto` exceeded 45 s before any of this audit's surfaces load). Retried after stopping the wedged runner-owned server (PID 43812, started by this audit's first run — stopped by PID); a fresh server hit the same wall. Honest gap: no browser-level observation of the four fixes; the jsdom suites drive the real components and stores.

---

## 8. Deferred for design review / approval

_(Formerly deferred here: CF-06 — the transport rule was approved and shipped; see §4.)_

1. **CF-14 (MCP destructive authority)** — was design review here; a parallel session shipped the confirmation + visible authority (commit `5dda14f6`, "explicit MIDI/AUDIO record targets and a visible, confirmed MCP delete authority") while this audit ran — re-verify its surface against the F-05 acceptance criteria on the next audit pass.
2. **CF-17 (unify the two comp systems)** — a capability-level design task (arrangement take lanes vs vocalchop), not a UI patch.
3. **Desktop-size clip handles (F-09 remainder)** — invisible hit-area expansion without touching the visual affordance; needs the drag-arbitration probe the prior audit also flagged as untested.
4. **F-11 (locale commitment)** — unchanged since the prior audit; a product decision, not an audit fix.

_(Formerly deferred here: CF-05 — approved and shipped as `892dcc61`; see §4.)_

---

## 9. Verification results, measurements, gaps

**Executed and green:** the suites listed in §7, seam gate (90 seams), prettier on touched files. **Red but not mine:** typecheck (7 errors, concurrent wave), drift (3 artifacts, same), full-suite ratchet not run (co-run with the parallel wave; the ledger labels in-flight files). **Blocked:** Playwright journeys (dev-server boot storm, documented above — this also means the audit adds no browser-level timing baseline). **Not attempted:** human usability sessions, audio listening, factory-preset browser QA (no audio surface was changed; `previewFxParam` reuses the shipped PRISM path).

**Baseline honesty:** no task-completion timings exist before or after; the four fixes are justified by defect logic and seam tests, not measured seconds. The one quantitative flow number in this report — "generic knobs silent until pointer-up" — is a structural fact from the wiring, not a stopwatch claim.

---

## 10. 30/60/90-day optimization roadmap

**30 days — disclosure and parking (small, mostly additive).**
CF-15 tool-chip pinning + C/V in the registry; CF-18 empty-A/B slot affordance; CF-22 dock focus restore. (CF-07's REPLACE disclosure shipped early — commit `e063fa0e`; CF-10's take-start parking shipped early — commit `197f89c8`.) Exit: each has a seam entry with a negative.

**60 days — the listening loops.**
CF-19 MixPreview staleness guard; CF-13 project search. (CF-08 + CF-09 shipped early — `28e68a71`, census budget measured; CF-11 view-state persistence shipped early — `e6276191`.) The CF-05 Playwright journey (staged in `keyboard-guards.spec.ts`) joins the regular suite once the shared dev server is healthy — that run is also the first real-browser measurement this audit's blocked e2e pass was waiting for.

**90 days — trust and unification.**
CF-14 destructive-authority confirmation + badge; CF-17 comp-system unification design (one lane model, two entries); F-11 locale decision; desktop hit-area expansion with a drag-arbitration probe; ActivityCenter human-readable rows (CF-23); re-run the 2026-10-25 audit's remaining owner gates (Firefox/Safari smoke) against the same journeys.

---

_Audit contract kept: architecture, audio paths, project format, shortcuts and deliberate confirmations preserved; the four shipped patches are additive or honesty-restoring, each falsifiable by its named negative spec; nothing in this report claims a measurement no one made._
