# 02 — Recording, takes and project persistence

KYX / Pulse Forge (`D:\pulse-forge`) · capability archaeology · 2026-10-27 · owner: worker (session `mvs_89a592c7bbd145a1856e11af70efb592`)

## 1. Scope, method, limits

**Scope.** Input monitoring, arming, device selection, sample-rate/buffer handling; take recording, multiple takes, take
selection, comping (`smart-comp`), crossfades; punch-in/out, loop recording, overdub; recording recovery after a crash;
track freeze and stem tracks; project save / autosave / save-lifecycle / IndexedDB repositories / open-reopen /
export-import round-trip; undo/redo of recording and destructive edits.

**Method.** Read-only archaeology. Grep-driven: every claim below is anchored to a `file:line`. I read the command layer
(`src/commands/{freeze,stemTracks,smart-comp,project,docOps,layerCommands}.ts`), the recorder
(`src/audio-engine/PcmMicRecorder.ts`, `PcmMicRecorderGroup.ts`, `recordingInput.ts`, `recordingStorageBudget.ts`,
`recordingAlignment.ts`, `take-scoring.ts`), the persistence layer (`src/persistence/{save-lifecycle,autosave-debouncer,
recoveryBuffer,crashJournal,RecordingRecoveryRepository,ProjectRepository}.ts`), the UI surfaces
(`src/ui/ArrangementPanel.tsx` is 361 KB — grepped, not read whole; `FreezeButton.tsx`, `ProjectBrowser.tsx`,
`AudioStatusChips.tsx`, `commandPalette.ts`, `shortcuts.ts`, `Mixer.tsx`, `App.tsx`, `timelineRec.ts`,
`src/arrangement/capture.ts`) and the specs (`tests/e2e/11-audio-input-recording.spec.ts`,
`tests/e2e/12-audio-take-groups.spec.ts`, `tests/e2e/14-recording-soak.spec.ts`, `tests/e2e/25-unload-save-flush.spec.ts`,
`tests/e2e/04-persistence-roundtrip.spec.ts`, `tests/{recorder-error-report,recording-silence,capture-source-identity,
smart-comp-plan,smart-comp-scoring,comp-core}.test.ts`, `tests/persistence/RecordingRecoveryRepository*.test.ts`).

**Corrections to the brief.** `src/commands/docOps.ts` is _not_ the project-persistence command file — it holds effect-chain
helpers (`docOps.ts:24 withTrackEffects`, `:48 trackEffectsOf`) and marker helpers (`:86 unlinkMarkersOfClips`). The
project-level commands are in `src/commands/project.ts` (`:16 setProjectName`, `:88 prepareRecordPattern`). `layerCommands.ts`
is velocity-layer + instrument-randomization, unrelated to recording (`:39`, `:76`).

**Drift note.** A peer session modified `src/ui/ArrangementPanel.tsx` and `src/ui/Mixer.tsx` _while this audit was
running_ (`git status` showed both as `M`). Every `ArrangementPanel.tsx` / `Mixer.tsx` citation below was re-verified
against the file as it stands at write time; the anchors used (`:754`, `:949`, `:1097`, `:1849`, `:1967`, `:4226`, `:4685`,
`:4874`, `:4900`, `:4928`, `:4944`, `:5004`, `:5058`, `:5086`, `:6209`, `:6274`, `Mixer.tsx:738`) were re-checked
individually. Line numbers elsewhere in that file may still move.

**Confidence vocabulary.** `Verified in code/tests` means the behaviour was confirmed by reading the implementation and,
where a spec pins it, by that spec — it does **not** mean I executed it. `Observed in running app` is intentionally empty
for the parent to fill in.

**Not verified.** No runtime observation — the parent runs the app; the "Observed in running app" column is left empty for
them. No test suite was executed (peers are running theirs). I did not open a mic, arm a track, or trigger a crash. Electron/
desktop-native input paths (`src/audio-engine/windowsAudioIoBridge.ts`, referenced at `ArrangementPanel.tsx:1129`) were not
exercised. `PcmMicRecorder` internal timings and the `PcmMicRecorderGroup` multi-device path were traced by reading only.

---

## 2. Capability table

| Capability                                               | Implementation (file:line)                                                                                                                                                                                | Entry point                                                                                                                             | Prereqs                                                                                                                                                                                                            | Feedback / undo / recovery                                                                                                                                                                          | Runtime status                                                                 | Class | Confidence             |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----- | ---------------------- |
| Arm a track for capture                                  | `ArrangementPanel.tsx:754` state, `:4203-4213` arm select                                                                                                                                                 | ARR dock tab → arm select                                                                                                               | Track must exist                                                                                                                                                                                                   | Select value = armed track; REC enables                                                                                                                                                             | Reachable                                                                      | **B** | Verified in code/tests |
| ● REC capture audio → timeline                           | `ArrangementPanel.tsx:4683 startRec` → `:1097`; `PcmMicRecorder.ts`                                                                                                                                       | ARR tab → `● REC` (`:4685`)                                                                                                             | `armedTrackId`, idle, `independentInputReady`, not punch-while-playing (`:4677-4682`)                                                                                                                              | `recState` chip (`opening audio input…`/`placing clip…` `:4688-4689`), error `role="alert"` `:4712`; take placed as one undo frame `timelineRec.ts:210`                                             | Reachable                                                                      | **B** | Verified in code/tests |
| Input device selection                                   | `ArrangementPanel.tsx:773, 4410-4431`; persisted `saveRecordingInputDeviceId`                                                                                                                             | ARR tab → INPUT select                                                                                                                  | `enumerateDevices` permission; falls back to system default                                                                                                                                                        | `recordingInputListError` notice `:4690-4694`                                                                                                                                                       | Reachable                                                                      | **B** | Verified in code/tests |
| Input channel-count request                              | `ArrangementPanel.tsx:4378-4382` (`requestedChannelCount`)                                                                                                                                                | CAPTURE SETUP → channel-count select                                                                                                    | Device must support the count                                                                                                                                                                                      | Unsupported counts "stop before recording" (tooltip `:4380`)                                                                                                                                        | Reachable                                                                      | **B** | Verified in code/tests |
| Input monitoring (mic monitor)                           | `ArrangementPanel.tsx:4587-4591 setMicMonitoring`                                                                                                                                                         | CAPTURE SETUP → monitor toggle                                                                                                          | Armed track                                                                                                                                                                                                        | None (no audible/telemetry cue)                                                                                                                                                                     | Reachable                                                                      | **B** | Verified in code/tests |
| Input gain                                               | `ArrangementPanel.tsx:925-928` (clamped, persisted)                                                                                                                                                       | CAPTURE SETUP → gain                                                                                                                    | —                                                                                                                                                                                                                  | None beyond the value                                                                                                                                                                               | Reachable                                                                      | **B** | Verified in code/tests |
| Punch-in / punch-out                                     | `ArrangementPanel.tsx:763, 4373 setPunchCapture`                                                                                                                                                          | CAPTURE SETUP → punch toggle                                                                                                            | Transport + punch range armed                                                                                                                                                                                      | Inline explanation `:4706-4711`; REC disabled while playing `:4681`                                                                                                                                 | Reachable, collapsed by default                                                | **B** | Verified in code/tests |
| Loop-take capture (multi-pass)                           | `ArrangementPanel.tsx:762, 4351 setLoopTakeCapture`; `timelineRec.ts:260 recordedLoopPasses`, `:357 addRecordedLoopSession`                                                                               | CAPTURE SETUP → loop toggle                                                                                                             | Transport loop on                                                                                                                                                                                                  | Inline explanation `:4695-4700`                                                                                                                                                                     | Reachable, collapsed by default                                                | **B** | Verified in code/tests |
| Take-group / alternate-pass mode                         | `ArrangementPanel.tsx:765-769, 4309-4310` ("Recording take mode")                                                                                                                                         | CAPTURE SETUP → take-mode select                                                                                                        | Armed track                                                                                                                                                                                                        | Select shows `ALT TAKE · GROUP 1 (2 passes)`; inline explanation `:4701-4705`                                                                                                                       | Reachable, collapsed by default                                                | **B** | Verified in code/tests |
| Take lanes (list / audition / activate)                  | `ArrangementPanel.tsx:4900-4910` (toggle), `:6209` (lane panel header), `:6210-6216` crossfade, `:6274` activate-pass                                                                                     | ARR tab, only when a clip of the group is selected (`:4900`)                                                                            | `selectedAudioTakeGroup` (`:731-733`)                                                                                                                                                                              | Per-lane buttons; activation is undoable (`:6274` tooltip)                                                                                                                                          | Reachable, gated by clip selection                                             | **B** | Verified in code/tests |
| Manual comp (replace a range with a source take)         | `commands/audioClips.ts:207 compAudioTakeRange`; `ArrangementPanel.tsx:4928` "COMP RANGE"                                                                                                                 | ARR tab → COMP RANGE button                                                                                                             | `selectedAudioTakeGroup.activeTakeId !== compTakeId`                                                                                                                                                               | "undo restores the previous comp" (`:6232` tooltip)                                                                                                                                                 | Reachable                                                                      | **B** | Verified in code/tests |
| Smart comp (measure → preview → apply)                   | `commands/smart-comp.ts:133 planSmartComp`, `:277 applySmartComp`, `:249 segmentTicks`, `:261 planBars`; `audio-engine/take-scoring.ts`                                                                   | ARR tab → "SUGGEST COMP" (`:4944`), gated `selectedAudioTakeIds.length >= 2` (`:4931`)                                                  | ≥2 source takes in one group + a selected clip of that group                                                                                                                                                       | Two-phase: read-only plan with per-take score + evidence + per-segment bar map (`:4948-4987`), CANCEL / "APPLY COMP" as ONE undoable edit (`:5001-5004`)                                            | Reachable, 4-step hidden path                                                  | **B** | Verified in code/tests |
| Comp crossfade (equal power)                             | `ArrangementPanel.tsx:6210-6216`                                                                                                                                                                          | ARR tab → CROSSFADE select                                                                                                              | Take group present                                                                                                                                                                                                 | "undo restores the previous comp"                                                                                                                                                                   | Reachable                                                                      | **B** | Verified in code/tests |
| Recoverable takes after a capture failure                | `RecordingRecoveryRepository.ts:304 markRecoverable`, `:359 listRecoverable`, `:398 materializeStoredSample`; `PcmMicRecorder.ts:831, 1040`; `ArrangementPanel.tsx:1849 recoverTake`, `:1967 discardTake` | ARR tab → recovery list (`:5058-5101`), polled every 3 s (`:947-982`)                                                                   | A prior tab-load session marked recoverable; owner-scoped (`RecordingRecoveryRepository.ts:140`); "RESTORE TO TIMELINE" only when the take belongs to this project+track, else "RECOVER TO SAMPLES" (`:5086-5088`) | Button `:5086-5088`; "interrupted capture" marker `:5074`; DISCARD is `window.confirm` + permanent (`:1970`, `:5090-5096`); `recError` text promises "available for recovery" but carries no action | Reachable, far from the error                                                  | **B** | Verified in code/tests |
| Project-level crash journal + uncommitted-work recovery  | `persistence/crashJournal.ts`, `persistence/recoveryBuffer.ts:351 readRecoveryBuffer`; `installSaveUnloadGuards` `save-lifecycle.ts:74`                                                                   | **ProjectBrowser (first screen)** — banners `ProjectBrowser.tsx:550` (uncommitted), `:577` (unprotected/lost), `:593` (unclean session) | A prior tab died                                                                                                                                                                                                   | "Recover" commits the doc under its own id (`:451-453`); crash report names the last good save (`:605-606`)                                                                                         | Reachable, first screen                                                        | **A** | Verified in code/tests |
| Independent input streams (multi-device record)          | `PcmMicRecorderGroup.ts`; `ArrangementPanel.tsx:1110, 1149-1189`; per-route monitoring `:4531`                                                                                                            | CAPTURE SETUP → "Add independent input stream" (`:4553`)                                                                                | Each route needs a distinct track AND a distinct device (`:778-783`)                                                                                                                                               | `recorderGroup.onFailure` names the failing track and counts recoverable takes (`:1190-1196`)                                                                                                       | Reachable, collapsed                                                           | **B** | Verified in code/tests |
| Track freeze / unfreeze / re-freeze + staleness          | `commands/freeze.ts:17 freezeTrack`, `:66 unfreezeTrack`; `ui/FreezeButton.tsx:43, 91, 126-135, 157`                                                                                                      | Mixer strip (Alt+1) → FREEZE / UNFREEZE / RE-FREEZE button (`FreezeButton.tsx:168, 144, 157`; rendered `Mixer.tsx:738`)                 | Track not a group (`:47`)                                                                                                                                                                                          | "EDITED SINCE FREEZE" chip + RE-FREEZE (one undo step); error `role="status"` `:121-124`                                                                                                            | Reachable                                                                      | **A** | Verified in code/tests |
| Track bounce to WAV file                                 | `FreezeButton.tsx:99 handleBounce`, `:178` BOUNCE button                                                                                                                                                  | Mixer strip → BOUNCE                                                                                                                    | Same as freeze                                                                                                                                                                                                     | Downloads WAV; error `role="status"` `:112-113`                                                                                                                                                     | Reachable                                                                      | **A** | Verified in code/tests |
| Stem tracks (import stems as tracks)                     | `commands/stemTracks.ts:31 addStemTracksCommand`                                                                                                                                                          | **No UI entry point** — only `src/mcp/tools.ts:12527`                                                                                   | —                                                                                                                                                                                                                  | —                                                                                                                                                                                                   | MCP-only                                                                       | **F** | Verified in code/tests |
| Stems export (`stems.zip`)                               | `src/export/quick-bounce.ts:80` → `src/ui/ExportPanel.tsx`                                                                                                                                                | Export panel → stems                                                                                                                    | Renderable project                                                                                                                                                                                                 | Export progress UI                                                                                                                                                                                  | Reachable                                                                      | **A** | Verified in code/tests |
| Project save + bounded autosave                          | `ProjectRepository.ts:50 save`; `autosave-debouncer.ts:63 createAutosaveDebouncer` (800 ms debounce, 5 s / 50-arm ceiling `:110`), wired `services.ts:1285-1290`                                          | Ctrl+S (shortcut `save`) + autosave on every edit                                                                                       | IndexedDB available                                                                                                                                                                                                | Save-status chip `AudioStatusChips.tsx:94-129`; storage-full warning `:128-129`                                                                                                                     | Reachable                                                                      | **A** | Verified in code/tests |
| Project open / reopen / rename / duplicate / delete      | `ProjectRepository.ts:64 load`, `:90 listAll`, `:157 rename`, `:175 duplicate`, `:142 delete`, `:191 loadMostRecent`                                                                                      | ProjectBrowser (first screen)                                                                                                           | IndexedDB                                                                                                                                                                                                          | `delete` is permanent; no undo                                                                                                                                                                      | Reachable                                                                      | **A** | Verified in code/tests |
| Incompatible-project detection                           | `ProjectRepository.ts:106 listIncompatible`                                                                                                                                                               | ProjectBrowser — "NEWER VERSION" badge (`ProjectBrowser.tsx:853`)                                                                       | —                                                                                                                                                                                                                  | Explains why it is not listed                                                                                                                                                                       | Reachable                                                                      | **A** | Verified in code/tests |
| Frozen buffers survive reopen (+ GC)                     | `services.ts:1099-1112` (missing → unfreeze; unreferenced → remove)                                                                                                                                       | Automatic on open                                                                                                                       | Frozen buffer row exists                                                                                                                                                                                           | Missing buffer → track unfreezes instead of silence                                                                                                                                                 | Reachable                                                                      | **A** | Verified in code/tests |
| MIDI pattern record (arm / overdub / replace / quantize) | `midi/` pattern recorder; `commands/project.ts:88 prepareRecordPattern`                                                                                                                                   | TopBar record-arm row                                                                                                                   | MIDI device / keyboard                                                                                                                                                                                             | Record-arm indicator in TopBar                                                                                                                                                                      | Reachable                                                                      | **A** | Verified in code/tests |
| Capture last take (Ableton-style)                        | `arrangement/capture.ts:150 hasCapturedMaterial`, `:155 capturedEventCount`, `:170 captureLastTake`                                                                                                       | Pause-offer dialog `App.tsx:2007-2026` + `A` key `App.tsx:1234-1249`                                                                    | Non-empty capture ring after a pause                                                                                                                                                                               | Offer shows the event count (`App.tsx:2016`); one undo frame `capture.ts:251-256`                                                                                                                   | Reachable; help-overlay only (`shortcuts.ts:390-393`), **not in Ctrl+K**       | **C** | Verified in code/tests |
| Undo/redo of a recorded placement                        | `timelineRec.ts:210-215`, `:249` (`snapshot(...)`)                                                                                                                                                        | Ctrl+Z                                                                                                                                  | —                                                                                                                                                                                                                  | One undo frame; **the captured WAV stays in the user-sample library**                                                                                                                               | Reachable                                                                      | **C** | Verified in code/tests |
| Capture sample rate / audio buffer size control          | none — capture rate follows the live `AudioContext`; freeze hard-codes 44100 (`FreezeButton.tsx:57, 106`)                                                                                                 | —                                                                                                                                       | —                                                                                                                                                                                                                  | —                                                                                                                                                                                                   | Absent                                                                         | **I** | Verified in code/tests |
| Input latency calibration                                | `ui/LatencyCalibrationWizard.tsx` (`measureAudioRoundTrip`); `audio-engine/recordingAlignment.ts`; entry `ui/MidiPanel.tsx:173` "CALIBRATE LATENCY"                                                       | **MIDI panel** → CALIBRATE LATENCY                                                                                                      | Playback + capture round trip                                                                                                                                                                                      | Wizard with "Run again"                                                                                                                                                                             | Reachable, wrong panel                                                         | **E** | Verified in code/tests |
| Ctrl+K coverage of capture actions                       | `ui/commandPalette.ts:40-108` builds from `getActiveShortcuts()` (`shortcuts.ts:451` → `SHORTCUTS` `:109`) + 4 extras                                                                                     | Ctrl+K                                                                                                                                  | —                                                                                                                                                                                                                  | —                                                                                                                                                                                                   | No record / arm / take / comp / freeze / recovery action exists in the palette | **F** | Verified in code/tests |

---

## 3. Candidate findings

**HCP-02-01 — The command palette contains zero capture actions. (Class F)**
Evidence: `src/ui/commandPalette.ts:54` maps `getActiveShortcuts()`; `src/ui/shortcuts.ts:451` returns only the `SHORTCUTS`
array (`:109`), whose `ShortcutKey` union (`:9-60`) contains no `record`/`arm`/`take`/`comp`/`freeze` key; `:77-106` adds four
palette-only extras (snapshot, gallery, history, diagnostics). The palette therefore cannot reach arm, REC, punch, loop takes,
take groups, take lanes, comp, smart comp, freeze or recovery. _Searched:_ `shortcuts.ts` (whole), `commandPalette.ts` (whole).
_User problem:_ Ctrl+K is the product's only "what can I do here" surface, and it answers "you cannot record". _Minimal
intervention:_ add palette-only entries that dispatch the same handlers the ARR panel buttons use (no keybinding needed) —
"Record to armed track", "Freeze track", "Suggest comp on selected take group", "Restore recoverable take".

**HCP-02-02 — The whole capture configuration sits inside one collapsed `<details>`. (Class B)**
Evidence: `src/ui/ArrangementPanel.tsx:4226` `<details className="arr-capture-setup">`, summary `:4228` "CAPTURE SETUP";
inside it the loop-take toggle (`:4351`), punch toggle (`:4373`), channel-count select (`:4378`), input device (`:4410-4431`),
independent inputs (`:4432`), monitor (`:4587-4591`), take mode (`:4309-4310`). The `<details>` is closed on first render.
_User problem:_ opening the ARR tab, arming a track and pressing REC looks like the complete feature; punch, loop takes and
take grouping are invisible until the user happens to expand CAPTURE SETUP. _Minimal intervention:_ keep it collapsed but show
the active modes in the summary (the summary already renders a state string at `:4229-4231`) and add a one-line hint listing
the three hidden modes.

**HCP-02-03 — Smart comp is excellent but reachable only through a four-step hidden path. (Class B)**
Evidence: `src/commands/smart-comp.ts:133 planSmartComp` / `:277 applySmartComp`; UI `ArrangementPanel.tsx:4931` (gate:
`selectedAudioTakeIds.length >= 2`), `:4944` "SUGGEST COMP", `:4948-4988` preview (per-take score + `evidence` string +
per-segment bar map), `:5001-5004` "APPLY COMP" as one undoable edit. The gate depends on `selectedAudioTakeGroup`
(`ArrangementPanel.tsx:731-733`), which requires the user to have clicked a take clip in the timeline.
_User problem:_ the product's most impressive creative feature is invisible to anyone who has not already worked out that
record-twice-into-one-group → click the clip → comp is the flow. _Minimal intervention:_ (a) put "SUGGEST COMP" in the
CAPTURE SETUP summary when the armed track has a take group, and (b) name the prerequisite in the button tooltip
("needs ≥2 passes in one group").

**HCP-02-04 — Take selection is an unlabelled expert workflow. (Class B)**
Evidence: "ACTIVE PASS" `ArrangementPanel.tsx:4874` (select `:4877`), "COMP RANGE" `:4928`, take-lane toggle `:4900-4908`,
activate-pass `:6274` — all gated on `selectedAudioTakeGroup`, derived from the selected clip's `takeGroupId` (`:731-733`).
Nothing in the UI states that the take-mode select must point at an _existing_ group for the second pass to join it.
_User problem:_ a user who records two passes into two different groups sees no comp affordance at all and no explanation of
why. _Minimal intervention:_ when a take group has ≥2 passes, show the take-lane header with the pass count even when the
group is not the selected clip's group.

**HCP-02-05 — The recovery promise is not clickable from the error that makes it. (Class B)**
Evidence: the recorder reports every error and the UI shows the latest in `ArrangementPanel.tsx:4712-4716` (`role="alert"`),
whose text states the previously committed audio "is available for recovery"; the recovery list renders at
`ArrangementPanel.tsx:5058-5101` — roughly 380 lines of JSX below — and only while the ARR dock tab is mounted
(`App.tsx:1716-1720`); the poll that fills it runs every 3 s (`ArrangementPanel.tsx:947-982`). The list is good
("RECOVERABLE AUDIO TAKES", per-take duration, an "interrupted capture" marker at `:5074`, a conditional
"RESTORE TO TIMELINE" / "RECOVER TO SAMPLES" button at `:5086-5088`, a DISCARD at `:5090-5096`) — it is simply not where
the user is when the error appears.
_User problem:_ the one moment the user needs the recovery affordance, the affordance is off-screen in a different panel.
_Minimal intervention:_ render the recovery list inline in the error region (or make the error text a button that expands it),
and surface the count of recoverable takes in the error message itself — the group-failure path already computes it
(`ArrangementPanel.tsx:1193`).

**HCP-02-06 — The recorder's full error log is collected but never shown. (Class E)**
Evidence: `src/audio-engine/PcmMicRecorder.ts` accumulates every failure into an error list and invokes `onError` per error
(contract pinned by `tests/recorder-error-report.test.ts`); the UI handler `ArrangementPanel.tsx` `setRecError(message)`
_replaces_ the message, so only the last error survives; intermediate causes are dropped. The multi-input path is better —
the group failure message names the failing track and how many takes are recoverable (`ArrangementPanel.tsx:1193`, `:1198`) —
but it still collapses N per-input failures into one string (`:1541`, `:1550`).
_User problem:_ a multi-device failure reports one cause at a time; the other inputs' causes are invisible. _Minimal
intervention:_ keep the error list in state and render it as a stacked list (the alert region already exists) instead of
overwriting.

**HCP-02-07 — Stem tracks are implemented and reachable only over MCP. (Class F)**
Evidence: `src/commands/stemTracks.ts:31 addStemTracksCommand`; the only importer is `src/mcp/tools.ts:12527`. _Searched:_
`src/ui/**` for `addStemTracksCommand` / `stemTracks` — no UI import; `src/commands/stemTracks.ts` importers.
_User problem:_ "drop a stem set back into the session as tracks" exists as a capability but is not reachable by a GUI user;
the adjacent `stems.zip` _export_ is reachable, which makes the asymmetry misleading.
_Minimal intervention:_ add a "Import stems as tracks" item to the export/quick-bounce panel that reads a local stem folder.

**HCP-02-08 — Latency calibration is filed under MIDI although it calibrates audio capture. (Class E)**
Evidence: the entry point is in the MIDI panel (`src/ui/MidiPanel.tsx:173` "CALIBRATE LATENCY" → `LatencyCalibrationWizard.tsx`
`measureAudioRoundTrip`), while the thing it calibrates is the capture round trip
(`src/audio-engine/recordingAlignment.ts`, `PcmMicRecorder.ts`). _User problem:_ an audio-only user records with a systematic
input delay and never finds the fix. _Minimal intervention:_ add the same button to the CAPTURE SETUP grid next to the input
gain control, pointing at the existing wizard.

**HCP-02-09 — Undoing a recording leaves the captured audio in the library. (Class C)**
Evidence: the placement is one undoable frame (`src/ui/timelineRec.ts:210-215` `snapshot("addRecordedAudioClips", …)`,
`:249` `snapshot("addRecordedAudioTakeClip", …)`); no command removes the saved WAV from the user-sample repository;
`recordedTakeAlreadyPlaced` (`timelineRec.ts:88`) exists only to avoid duplicating a _clip_, not an asset.
_User problem:_ "undo" leaves orphaned audio in the sample bank — invisible, but it consumes the same IndexedDB quota the
storage preflight warns about (`recordingStorageBudget.ts:24`). _Minimal intervention:_ on undo, mark the sample orphaned and
GC it with the frozen-buffer GC already present at `services.ts:1110-1112`.

**HCP-02-10 — "Capture last take" is in the help overlay but not in the command palette. (Class C)**
Evidence: `src/ui/shortcuts.ts:390-393` lists "Capture last take (after stop/pause)" with binding `A` inside
`EDITOR_SHORTCUTS` (`:303`) — a help-overlay list, not the palette registry (`commandPalette.ts:54` reads `SHORTCUTS` only);
the runtime offer is `src/ui/App.tsx:2007-2026` and the key handler `:1234-1249`.
_User problem:_ the offer only appears after a pause that leaves a non-empty capture ring, so a user who never pauses sees
nothing; and Ctrl+K cannot find the action. _Minimal intervention:_ add a palette-only entry, and make the offer explain
_why_ it appeared ("3 played events were captured").

**HCP-02-11 — Capture rate and freeze rate are two different, unexplained numbers. (Class E)**
Evidence: capture follows the live `AudioContext` rate (`recordingStorageBudget.ts:24` estimates from the context rate);
freeze renders at a hard-coded `sampleRate: 44100` (`src/ui/FreezeButton.tsx:57` and `:106`) regardless of the live context.
_User problem:_ a 48 kHz session's frozen buffer is resampled behind the user's back; the UI shows a capture rate
(`ArrangementPanel.tsx` capture-info chip) but never mentions the freeze rate. _Minimal intervention:_ render freeze at the
live context rate, or surface the mismatch in the strip.

**HCP-02-12 — ● REC is disabled by rules the user cannot see. (Class D)**
Evidence: `src/ui/ArrangementPanel.tsx:4677-4682` disables the button unless `armedTrackId` is set, `recState === "idle"`,
`independentInputReady`, and `!(punchCapture && services.transport.playing)`. The arm select is at `:4203-4213`; no label,
tooltip or hint links the greyed button to the missing arm. _User problem:_ the most important button in the app is
unexplained when it is disabled. _Minimal intervention:_ change the disabled tooltip to name the unmet condition
("arm a track first" / "finish the previous capture" / "independent inputs need distinct devices").

### DO NOT SURFACE candidates (destructive or irreversible)

- `ProjectRepository.delete` (`src/persistence/ProjectRepository.ts:142`) — permanent project deletion, no undo path; the
  frozen-buffer cascade is also permanent. _Keep out of any quick-action / one-click surface._
- Discarding an unrecovered take (`src/ui/ArrangementPanel.tsx:1967-1975`) — `window.confirm` then permanent PCM deletion; the
  only irreversible step in the recovery path. _Do not put it next to "RESTORE TO TIMELINE" without a distinct visual weight._
- Frozen-buffer GC (`src/services.ts:1110-1112`) — removes any frozen buffer no project references; silent and irreversible.
  _Never surface as a user-facing action._

---

## 4. Verified working

Read from the code and pinned by the named specs; no runtime observation claimed.

1. **Recording round trip** — arm → REC → PCM captured → WAV committed to the user-sample library → clip placed at exact
   transport-tick resolution (`src/ui/timelineRec.ts:190`, `:219`; `tests/e2e/11-audio-input-recording.spec.ts`).
2. **Take groups** — a second pass into the same group becomes an alternate take of the same clip
   (`tests/e2e/12-audio-take-groups.spec.ts`; `ArrangementPanel.tsx:4309-4310`).
3. **Crash recovery of an in-flight capture** — a renderer crash leaves the committed PCM recoverable and the arrangement
   panel offers a restore (`tests/e2e/14-recording-soak.spec.ts`; `ArrangementPanel.tsx:5058-5101`;
   `src/persistence/RecordingRecoveryRepository.ts:304`, `:359`).
4. **Uncommitted-work recovery** — the unload save flush does not commit, so the previous session's work is offered on the
   first screen (`tests/e2e/25-unload-save-flush.spec.ts`; `src/persistence/recoveryBuffer.ts`;
   `src/ui/ProjectBrowser.tsx:550-562`).
5. **Project round trip** — save → reload → reopen preserves the document (`tests/e2e/04-persistence-roundtrip.spec.ts`;
   `ProjectRepository.ts:50`, `:64`).
6. **Autosave is bounded** — 800 ms debounce with an independent 5 s / 50-arm ceiling, so a sustained gesture cannot defer
   the save indefinitely (`src/persistence/autosave-debouncer.ts:63`, `:110`; `src/services.ts:1285-1290`).
7. **Smart comp plans without mutating** — the plan is computed on demand, previewed with per-take evidence, and applied as
   one undoable command; source takes are never touched until APPLY (`src/commands/smart-comp.ts:133`, `:277`;
   `ArrangementPanel.tsx:2468-2472`, `:4948-5004`; `tests/smart-comp-plan.test.ts`, `tests/smart-comp-scoring.test.ts`).
8. **Freeze integrity** — a freeze is stamped with a document signature; if the project changes, the strip says
   "EDITED SINCE FREEZE" and offers a one-step RE-FREEZE, and a missing buffer unfreezes the track instead of playing silence
   (`src/ui/FreezeButton.tsx:64-70`, `:126-135`; `src/services.ts:1099-1106`).
9. **MIDI recording** — arm / overdub / replace / quantize in the TopBar; REPLACE mode clears only the performed surfaces of
   the active pattern and is one undo step (`src/commands/project.ts:88`).

---

## 5. Open questions

1. Does the recoverable-take list appear in a fresh tab whose owner id differs, in practice? The mechanism exists
   (`RecordingRecoveryRepository.ts:140`, `:359`) but the owner-scoped exclusion is a runtime assumption I did not exercise.
2. Is the 3 s recovery poll (`ArrangementPanel.tsx:947-982`) cheap enough to leave running for a whole session, or is it
   competing with the recorder for IndexedDB transactions under load?
3. Does `PcmMicRecorderGroup` survive a device unplug mid-take? The failure path is `onFailure`
   (`ArrangementPanel.tsx:1190-1196`) but no spec covers multi-device interruption.
4. Are recorded takes re-loaded correctly after a project reopen — i.e. does the saved WAV get re-linked to its clip, or does
   the clip come back pointing at a missing asset? `tests/e2e/04-persistence-roundtrip.spec.ts` covers the document, not the
   recorded-asset link; this needs a runtime check.
5. Is there an undo for a smart-comp APPLY that also restores the previous _active pass_? The tooltip at
   `ArrangementPanel.tsx:5002` claims one undoable edit; the restore path is `commands/audioClips.ts:207` and was not
   exercised.
6. Does the sample-rate split (capture = context rate, freeze = 44100, `FreezeButton.tsx:57`) actually resample on playback
   in `AudioEngine`, or does the frozen source play at the wrong rate? Needs a runtime measurement.
7. The `PcmMicRecorder` error list is collected but unread by any UI (`tests/recorder-error-report.test.ts` pins the
   collection). Is there an intended consumer that was never wired, or is the list genuinely diagnostic-only?
8. Are there capture capabilities in the Electron/desktop path (`src/audio-engine/windowsAudioIoBridge.ts`,
   `ArrangementPanel.tsx:1129`) that the web build cannot reach at all? Not audited — outside this domain's file list.
