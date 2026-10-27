# 05 — Productivity + Discoverability Infrastructure

**Audit:** hidden creative power in KYX / Pulse Forge · **Date:** 2026-10-27 · **Domain:** productivity + discoverability machinery
**Scope owner:** `05-productivity-discoverability.md` · No `src/` or `tests/` file was modified.

---

## 1. Scope, method, and limits

**Question answered here:** of the creative power that already exists, how much can a user _find_, _activate_
and _understand_? The subject is the machinery, not the features:

| Surface                        | Definition site                                                                                                                                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keyboard shortcut registry     | `src/ui/shortcuts.ts` — `SHORTCUTS` 109–228, `EDITOR_SHORTCUTS` 303–408, `PANEL_IDS_BY_SHORTCUT` 68–83, `safeBindingReason` 511–518, `collisionFor` 520–537                                                                        |
| Command palette                | `src/ui/commandPalette.ts` — `buildPaletteActions` 40–109, `fuzzyScore` 116–136, `filterActions` 139–155 · `src/ui/PaletteOverlay.tsx`                                                                                             |
| Help overlay · context menu    | `src/ui/HelpOverlay.tsx` · gestures `src/ui/helpContent.ts` · `src/ui/ContextMenu.tsx`                                                                                                                                             |
| Hints / onboarding · dock tabs | `src/ui/OnboardingHint.tsx`, `OnboardingTour.tsx`, `StatusHint.tsx`, `ActivityCenter.tsx`, `UndoHistoryPanel.tsx`, `SessionStateIndicator.tsx`, `dawProfile.ts` · `src/ui/DockChrome.tsx` 35–128 · ids `src/shared/layout-data.ts` |

**Method.** All counts come from throwaway Node scripts (deleted; not in the repo) that parse source as
text, so they reproduce without the app running:

1. **Shortcut count** — slice `src/ui/shortcuts.ts` from `export const SHORTCUTS` to the next `\n];`, count
   `^\s{2}\{ key: "` (44) + `^\s{4}key: "` (7) → **51**.
2. **Dispatcher count** — slice `src/ui/App.tsx` from `runShortcutRef.current = (matched` to
   `const matchedShortcut = matchShortcut`, count `case "…"` → **51**; diff the key sets → **identical, zero orphans**.
3. **Command-handler count** — per `src/commands/*.ts`, scan `export function` signatures, balance the parameter
   parentheses, accept iff the text after `)` starts `: Command` → **297** factories across **51 files** (44 modules
   with ≥1 factory; 7 plumbing: `commands.ts`, `types.ts`, `geometry.ts`, `docOps.ts`, `docDelta.ts`, `yDocBridge.ts`,
   `yDocHelpers.ts`). Re-verified against the tree at write time: still 51 / 297.
4. **Palette reachability** — copy `fuzzyScore`/`filterActions` verbatim from `commandPalette.ts`, build the
   55-action list from the parsed registry + 4 extras, search it.
5. **Disabled-state audit** — walk `src/**/*.tsx`; for every `disabled=` attribute check whether a `title=` or
   `aria-label=` appears within ±12 lines of the same element.

**What I could NOT verify** (left blank for the parent's runtime pass):

- _Observed in running app_ — **not filled in**; no dev server started, no test suite run, no test-derived claim made.
- Which palette entries a user reaches in practice, and whether the panel shortcuts are shadowed by focus or
  drum-pad keys at runtime (`App.tsx` 1153–1166 implies shadowing; runtime precedence not observed).
- Whether the `App.tsx` or the `PianoRoll` window `keydown` listener wins for a shared chord (both are `window`
  listeners; registration order decides).
- `src/mcp/tools.ts` also exposes ~40 of the same factories over MCP — a fourth entry path, out of scope, and
  **not** counted in the palette or keyboard ratios.
- **Shared-worktree drift.** A parallel session edited `src/ui/shortcuts.ts`, `src/ui/App.tsx` and
  `src/ui/ArrangementPanel.tsx` while this audit ran (adding `EDITOR_SHORTCUTS` row 21 and the `P` locator
  binding, and shifting `shortcuts.ts` by +5 lines). Every citation below was machine-checked against the
  tree **after** those edits and re-pointed where they moved.

---

## 2. The quantitative cross-check

### 2.1 Palette coverage

| Quantity                                                                                                               | Value                 | How obtained                                                                 |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------- |
| `SHORTCUTS` entries                                                                                                    | **51**                | step 1 above                                                                 |
| Palette-only extras                                                                                                    | **4**                 | `commandPalette.ts` 77–106 (`snapshot`, `gallery`, `history`, `diagnostics`) |
| **Maximum actions the palette can ever show**                                                                          | **55**                | `buildPaletteActions` 54 + 108                                               |
| Of the 51 shortcuts, actions that execute a project command                                                            | **19**                | dispatcher callee scan, §2.2                                                 |
| Of the 55 actions, actions that are transport / navigation / panel-toggle only                                         | **36**                | 55 − 19                                                                      |
| **Distinct command factories reachable through the palette**                                                           | **22 of 297 = 7.4 %** | step 3 + §2.2                                                                |
| Command modules with ≥1 palette path                                                                                   | **13 of 44 (29.5 %)** | step 3                                                                       | The 22 factories: `assistVary`, `assistFill` (`patternAssist.ts`); `clearSteps` (`groove.ts`); `cutClips`, |
| `pasteClips`, `duplicateClips` (`clipClipboard.ts`); `deleteArrangementClip` (`arrangement.ts`); `deleteNote`,         |
| `deleteNotes` (`notes.ts`); `setActivePattern`, `duplicatePattern` (`patterns.ts`); `duplicateTimeRange`               |
| (`timeRange.ts`); `duplicateTrack`, `moveTrackBySteps` (`tracks.ts`); `groupClips`, `ungroupClips`,                    |
| `setClipsLocked` (`clipGroups.ts`); `setTrackParams` (`project.ts`); `toggleAudioClipsMute`,                           |
| `deleteAudioClip` (`audioClips.ts`); `deleteMidiClip` (`midiClips.ts`); `deleteAutomationClip` (`automationClips.ts`). |

### 2.2 Palette search reachability (fuzzy filter, verbatim copy of the shipped code)

47 representative capability queries against the 55-action list; **25 return zero matches**:

> record, freeze, bounce, quantize, automation, macro, midi clip, marker, crossfade, silence, consolidate,
> stem, warp, chord, groove, velocity, effect, plugin, waveform, sample, library, tempo, humanize, swing, reference

Direct answers to the brief's questions — the palette contains **no** record / arm / take / comp / freeze
action, **no** clip-edit action beyond duplicate/cut/paste/mute/lock/group, **no** automation action, **no**
send/bus routing action, **no** modulation action. `record` finds nothing; `take` and `arm` only match
unrelated titles by fuzzy accident ("Open Beat Gallery", "Toggle track devices"); `comp` matches "Open command palette".

### 2.3 Keyboard coverage

| Quantity                                             | Value                                                                                                                                                                            |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global shortcuts                                     | **51** (1:1 with the 51 dispatcher cases — no orphan registry entry, no unreachable case)                                                                                        |
| `EDITOR_SHORTCUTS` entries                           | **21** (7 Piano roll + 11 Arrangement + 1 Capture + 2 Dice tray), encoding 23 distinct binding strings (`shortcuts.ts` 303–408)                                                  |
| Command factories reachable by **any** keyboard path | **26 of 297 = 8.8 %** (22 palette-reachable + `splitAudioClipAtTick`, `crossfadeAudioClips`, `nudgeClips` in `clipEditing.ts` + `consolidateTimeRangeToAudio` in `timeRange.ts`) |
| Modules with **no** palette **and** no keyboard path | **30 of 44 → 151 factories = 50.8 % of the command surface**                                                                                                                     |

The 30 blind modules and their factory counts:
`aiPattern` 3 · `arrangementShapes` 6 · `assistSelectionCommands` 3 · `automation` 17 · `chordTrack` 8 ·
`clipPlayback` 9 · `core` 1 · `drumContent` 3 · `effectInstances` 2 · `effectOps` 3 · `effectParams` 10 ·
`freeze` 2 · `instrument` 8 · `intentRouting` 3 · `korenScene` 1 · `layerCommands` 2 · `liveSets` 7 ·
`markers` 6 · `master` 4 · `metadata` 3 · `padOps` 2 · `plugins` 11 · `producerBriefCommands` 3 ·
`quantize` 12 · `sceneAutomation` 5 · `scenes` 12 · `smart-comp` 1 · `stemTracks` 1 · `tsar` 2 ·
`twistScene` 1.

**Answer:** the families with **no** keyboard shortcut _and_ no palette entry are exactly those carrying the
product's most expressive editing power — automation (17), effects/plugins (26), scenes (12), quantize (12),
instruments (8), chord tracks (8), live sets (7), markers (6), sends/master (4), freeze (2), smart-comp (1).
Every one is reachable **only** through a panel control.

### 2.4 `EDITOR_SHORTCUTS` — advertised vs. implemented

Traced each of the 21 entries. **All 21 are implemented** — this block is honest, unlike the palette.

| Area                | Binding                                                        | Implementation                                                                                       | Status                                                                                                |
| ------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Piano roll          | Ctrl+B duplicate notes · Alt+Q quantize 50 %                   | `PianoRoll.tsx:1622` → `duplicateNotes` (`notes.ts:327`); `:1633` → `quantizeNotes` (`notes.ts:286`) | Verified in code                                                                                      |
| Piano roll          | S strum · Alt+S portamento                                     | `PianoRoll.tsx:1652,1702` → `applyMidiCreativeTool`; `:1665`                                         | Verified in code (the label conflates Alt+S portamento with Alt+Shift+S `setNotesSlideNote`, `:1653`) |
| Piano roll          | L legato · Shift+C chord menu · arrows nudge                   | `PianoRoll.tsx:1717`, `:1646`, `:1596` → `nudgeNotes`                                                | Verified in code                                                                                      |
| Arrangement         | Ctrl+B bounce range                                            | `App.tsx:1568`                                                                                       | Verified in code (routes to a review flow, not a direct clip — `App.tsx:1566–1567`)                   |
| Arrangement         | Ctrl+Shift+C consolidate range                                 | `App.tsx:1531–1548` → `consolidateRangeToAudio` → `consolidateTimeRangeToAudio` (`timeRange.ts:720`) | Verified in code                                                                                      |
| Arrangement         | X crossfade                                                    | `App.tsx:1611` → `applyRangeCrossfade`                                                               | Verified in code                                                                                      |
| Arrangement         | Ctrl+E separate                                                | `App.tsx:1445` → `splitArrangementClipAtTick`; audio path `splitAudioClipAtTick`                     | Verified in code                                                                                      |
| Arrangement         | Alt+drag body = slip                                           | `ArrangementPanel.tsx:5988` → `slipAudioClip`                                                        | Verified in code                                                                                      |
| Arrangement         | P locators to selection                                        | `App.tsx:1463`                                                                                       | Verified in code (sets the loop region from the selection)                                            |
| Capture · Dice tray | A = capture last take · D / Shift+D roll · arrows walk history | `App.tsx:1247`; `DiceTray.tsx:175–180`, `:181–186`                                                   | Verified in code (capture is conditional on `captureOffer`)                                           |

**But five of the eleven "Arrangement keys" rows are not editor-scoped at all.** `M` (mute), `J` (snap),
`Ctrl+G` / `Ctrl+Shift+G` (group/ungroup), `Shift+L` (lock) and `← / →` (nudge) are implemented in the
**global** dispatcher (`App.tsx` `runShortcut`: cases `toggleClipMute` / `toggleSnap` / `groupClips` /
`ungroupClips` / `toggleClipLock`; `App.tsx:1602` for nudge) and work everywhere. The help overlay prints them
under the heading **"EDITOR SHORTCUTS — FIXED, DEPENDS ON FOCUS"** (`HelpOverlay.tsx:372`) — the binding is
global; the label claims focus-dependence.

---

## 3. Capability table — the discoverability machinery

| #   | Capability                                     | Implementation                                                                                                                 | Entry point                                                    | Prereq                                                     | Feedback / undo                                                 | Runtime status                        | Confidence       | Class |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------- | ---------------- | ----- |
| 1   | Global shortcut registry (51)                  | `shortcuts.ts:109–228`                                                                                                         | `matchShortcut` `shortcuts.ts:256`; dispatcher `App.tsx:702`   | pad keys do not shadow (`App.tsx:1157`)                    | undo via command layer                                          | Reachable                             | Verified in code | A     |
| 2   | Palette (55 actions)                           | `commandPalette.ts:40`; `PaletteOverlay.tsx`                                                                                   | Ctrl+K (`shortcuts.ts:135`)                                    | none                                                       | delegates to `runShortcut`                                      | Reachable, coverage 7.4 %             | Verified in code | B     |
| 3   | Palette fuzzy filter                           | `commandPalette.ts:116–155`                                                                                                    | same                                                           | none                                                       | empty state `PaletteOverlay.tsx:126`                            | Reachable                             | Verified in code | A     |
| 4   | Help overlay                                   | `HelpOverlay.tsx`                                                                                                              | `?` (`shortcuts.ts:227`)                                       | none                                                       | searchable groups 107–122                                       | Reachable                             | Verified in code | A     |
| 5   | Editor shortcut list (21)                      | `shortcuts.ts:303–408`                                                                                                         | rendered `HelpOverlay.tsx:372`                                 | focus                                                      | none                                                            | Reachable; 21/21 implemented          | Verified in code | E     |
| 6   | Custom key rebinding                           | `setShortcutBinding` `shortcuts.ts:582`; capture `HelpOverlay.tsx:62–91`                                                       | CHANGE button `HelpOverlay.tsx:308–315`                        | chord must be Ctrl/Cmd+Shift+1 letter (`shortcuts.ts:513`) | message line `HelpOverlay.tsx:74`                               | Gated to Ctrl/Cmd+Shift chords only   | Verified in code | G     |
| 7   | Conflict detection · binding persistence       | `collisionFor` `shortcuts.ts:520–537`; `safeBindingReason` 511; `persistOverrides` `:571`, key `pf-shortcut-bindings-v1` (411) | rebinding flow                                                 | localStorage writable                                      | "Already used by …"; session-only fallback `HelpOverlay.tsx:87` | Reachable                             | Verified in code | A     |
| 9   | Dock tab row (14)                              | `DockChrome.tsx:35–128`                                                                                                        | click a tab                                                    | none                                                       | —                                                               | Reachable                             | Verified in code | A     |
| 10  | Context menu (15 items)                        | `ContextMenu.tsx:616–701`                                                                                                      | right-click only                                               | selection-dependent                                        | per-item command                                                | Reachable; 4 items have no other path | Verified in code | D     |
| 11  | DAW-profile mapping (8)                        | `dawProfile.ts:30–140`                                                                                                         | palette `profileHint`; tour steps 2–3                          | a profile must be picked                                   | —                                                               | Gated on profile selection            | Verified in code | G     |
| 12  | Statusbar hint                                 | `StatusHint.tsx:15–39`                                                                                                         | hover any `data-hint` element                                  | element must carry `data-hint`                             | —                                                               | Reachable                             | Verified in code | A     |
| 13  | Onboarding tour (4 steps) · hint bar (5 steps) | `OnboardingTour.tsx:109–233`; `OnboardingHint.tsx:6–12`                                                                        | auto on first run                                              | `pf-tour-v1` / `pulse-forge.onboarding.done.v1` unset      | SKIP `:185`; hint auto-advances on progress events `:38`        | Reachable                             | Verified in code | E     |
| 15  | Session-state chip                             | `SessionStateIndicator.tsx:47–89`                                                                                              | footer, always visible                                         | armed/metronome/count-in active                            | click opens REC strip                                           | Reachable                             | Verified in code | A     |
| 16  | Activity center (jobs + trust report)          | `ActivityCenter.tsx:128–157`                                                                                                   | chip in the chrome                                             | —                                                          | downloadable markdown/JSON report                               | Reachable                             | Verified in code | A     |
| 17  | Undo history panel                             | `UndoHistoryPanel.tsx`                                                                                                         | palette extra `extra:history` (`commandPalette.ts:92–98`)      | —                                                          | jump to a state                                                 | Reachable                             | Verified in code | A     |
| 18  | Diagnostics overlay                            | not located in `src/ui/`                                                                                                       | palette extra `extra:diagnostics` (`commandPalette.ts:99–105`) | —                                                          | —                                                               | **Unknown**                           | Not verified     | I     |

### The 14 dock tabs — what each one actually is

All 14 have `label`, `ariaLabel` and a `title` tooltip (`DockChrome.tsx:35–128`). **Only 10 have a keyboard
shortcut**; `CHO`, `KOPA`, `LIVE`, `REF` have none, and therefore no palette entry either (the palette is
built from the shortcut table).

| Tab    | id          | Title (the answer to "what is it?")                                               | Shortcut      |
| ------ | ----------- | --------------------------------------------------------------------------------- | ------------- |
| MIX    | `mixer`     | "Mixer — levels, sends, groups"                                                   | `panelMix`    |
| DEV    | `devices`   | "Instrument + effect chain of the selected track"                                 | `panelFx`     |
| TSAR   | `tsar`      | "TSAR - hybrid sample + synthesis engine: dual sources, morph, mod matrix, Forge" | `panelTsar`   |
| CHO    | `choral`    | "Chorál — drop-a-hum choir: grain stack, formant shaping and Forge root estimate" | **none**      |
| KOPA   | `kopa`      | "KOPA — kick designer: reference Forge, pitch/click/body/tail, LOW-END STACK"     | **none**      |
| ARR    | `arr`       | "Arrangement timeline and scenes"                                                 | `panelArr`    |
| LIVE   | `live`      | "Live Pads — save loop sets and launch loops into the song arrangement"           | **none**      |
| MOD    | `mod`       | "Automation, LFOs and macros"                                                     | `panelMod`    |
| DICE   | `dice`      | "Dice — rapid beat generator"                                                     | `panelDice`   |
| INTENT | `intent`    | "Describe the beat in words"                                                      | `panelIntent` |
| EXP    | `exp`       | "Export audio and project"                                                        | `panelExport` |
| MASTER | `master`    | "Mastering — final processing, loudness targets and stereo checks"                | `panelMaster` |
| MIDI   | `midi`      | "MIDI input and routing"                                                          | `panelMidi`   |
| REF    | `reference` | "Reference map — BPM, key and confidence of a finished track"                     | **none**      |

### Disabled states — is the reason visible?

Audit of `src/**/*.tsx`: **551** `disabled=` attributes. Within ±12 lines of the same element, **197 (35.8 %)**
carry a `title=`, **214 (38.8 %)** carry an `aria-label=`, **222 (40.3 %)** carry **neither**.

| #   | Control                                                     | Disabled reason                                                                     | Explained?                                             |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | `ScenesPanel.tsx:125` (FILL), `:133` (DROP), `:141` (BREAK) | `!selectedScene`                                                                    | **No** — no title, no aria-label                       |
| 2   | `ArrangementPanel.tsx:4779`                                 | `!selectedScene`                                                                    | **No**                                                 |
| 3   | `ArrangementPanel.tsx:4787`, `:4797`                        | `!selectedClipId`                                                                   | **No**                                                 |
| 4   | `ArrangementPanel.tsx:5588`, `:5603`, `:5618`               | `!hasSceneClipSelection`                                                            | **No**                                                 |
| 5   | `ArrangementPanel.tsx:5081`, `:5093`                        | `recoveringTakeId !== null \|\| recState !== "idle"`                                | **No**                                                 |
| 6   | `ContextMenu.tsx:616`, `:619`, `:622`, `:629`               | `!hasClips` / `!clipsClipboard` / `!hasAudioClipSelection`                          | **No** (the items do show their shortcut)              |
| 7   | `ContextMenu.tsx:653`                                       | `!hasTime`                                                                          | **No** — "Consolidate" greys out silently              |
| 8   | `ArrangementPanel.tsx:4344–4349` (LOOP PASSES)              | `recState !== "idle" \|\| punchCapture \|\| !loopEnabled \|\| loopEnd <= loopStart` | **Yes** — `title` at `:4343` states every precondition |
| 9   | `ContextMenu.tsx:677–681`                                   | `!selectedArrangementClip`                                                          | **Yes** — "Select exactly one arrangement clip"        |
| 10  | `ArrangementPanel.tsx:4914–4929` (COMP RANGE)               | not `disabled`; hidden unless a take group differs                                  | **Yes** — `title` `:4918`                              |

Rows 8–10 are the pattern that rows 1–7 do not follow. The inconsistency is the finding: the same
product both explains and hides the same class of gate.

### Onboarding / hint mechanisms — how many, do they overlap

| Mechanism                 | Component                      | Trigger                                                                        | Dismissal                                                 |
| ------------------------- | ------------------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Guided tour               | `OnboardingTour.tsx:109`       | first run per `pf-tour-v1` / `pf-transfer-tour-v1` / `pf-song-starter-tour-v1` | SKIP `:185`, LET'S FORGE `:227`                           |
| Onboarding hint bar       | `OnboardingHint.tsx:46`        | first run per `pulse-forge.onboarding.done.v1`                                 | no dismiss button; auto-advances on progress events `:38` |
| Statusbar live hint       | `StatusHint.tsx:15`            | hover/focus a `data-hint` element                                              | transient                                                 |
| First-run panel auto-open | `App.tsx:146–154`, `:544`      | `pf-intent-opened` unset                                                       | one-shot                                                  |
| Session-state chip        | `SessionStateIndicator.tsx:47` | armed / metronome / count-in                                                   | hidden when idle `:55`                                    |

**Five distinct mechanisms**, each with its own storage key. The tour (4 steps, `OnboardingTour.tsx`) and the
hint bar (5 steps, `OnboardingHint.tsx`) use **different** keys (`pf-tour-v1` vs
`pulse-forge.onboarding.done.v1`), so on a fresh browser profile **both are live simultaneously** — and they
overlap in content: tour steps 2–3 and hint step 3 both teach Ctrl+K / the bottom panels
(`OnboardingTour.tsx:174–176`, `OnboardingHint.tsx:9`).

---

## 4. Candidate findings

| id            | Class | Finding                                                                                                                                                                                                                                                                                                                               | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | User problem                                                                                                                                                                        | Minimal intervention (not implemented)                                                                                                                                                                  |
| ------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **HCP-05-01** | **B** | The command palette exposes **7.4 %** of the command surface: 22 of 297 command factories, from 13 of 44 modules.                                                                                                                                                                                                                     | `commandPalette.ts:54` builds actions from `getActiveShortcuts()` only; `App.tsx` dispatcher reaches 22 factories; 151 factories in 30 modules have neither palette nor keyboard path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | A user who knows "KYX can freeze a track" or "can comp takes" has no way to find it — `freeze`, `comp`, `take`, `record` return zero palette matches.                               | Derive palette actions from the command registry (a `Command` → `PaletteAction` adapter with an explicit `label`), instead of from the shortcut table; keep the shortcut table as the _binding_ source. |
| **HCP-05-02** | **B** | The palette's fuzzy search cannot reach the families it is meant to surface: **25 of 47** representative queries return zero hits.                                                                                                                                                                                                    | `commandPalette.ts:139–155` searches only title / group / keywords / binding; keywords = `sc.key` only unless a DAW profile is set (`:62–67`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | "record", "freeze", "automation", "macro", "effect", "tempo", "groove" all fail. The placeholder ("e.g. solo, export, loop") only advertises the three queries that happen to work. | Give each command a keyword set (or a `searchTerms` field on `Command`), and index those in the palette.                                                                                                |
| **HCP-05-03** | **D** | Four capabilities are reachable **only** by right-click: Consolidate, Producer edit selected clip…, Producer edit selected range…, and (in the clip branch) Delete.                                                                                                                                                                   | `ContextMenu.tsx:647`, `:653`, `:683`, `:699` — no shortcut, no palette action, and `consolidateTimeRange` has no other caller (`src/commands/timeRange.ts:388`; only `services/rangeConsolidation.ts` uses the _audio_ variant).                                                                                                                                                                                                                                                                                                                                                                                                                                        | Right-click-only = invisible to a keyboard-first user and to anyone reading the help overlay.                                                                                       | Add the four to the palette as `extra:` actions or give them a binding.                                                                                                                                 |
| **HCP-05-04** | **E** | The same capability is named 3–4 different ways across surfaces.                                                                                                                                                                                                                                                                      | `panelFx` label "Toggle track devices" (`shortcuts.ts:215`) vs dock aria "Toggle track device chain" (`DockChrome.tsx:45`) vs dock title "Instrument + effect chain…" (`:46`) vs id `devices` (`layout-data.ts`); `panelArr` "Toggle arrangement" (`shortcuts.ts:216`) omits "panel" while all 9 siblings say "Toggle X panel"; `panelExport` "Toggle export" (`:218`) vs "Toggle export panel" (`DockChrome.tsx:105`); `deleteNote` "Delete selected note / clear selected steps" (`shortcuts.ts:225`) vs menu item "Delete" (`ContextMenu.tsx:648`); `toggleClipMute` "Mute / unmute selected audio clips" (`:205`) vs menu "Mute"/`"Unmute"` (`ContextMenu.tsx:631`). | Users cannot map what they read in the help overlay onto what they see in the product.                                                                                              | One label per capability, shared by the registry, the palette and the menu.                                                                                                                             |
| **HCP-05-05** | **E** | The help overlay prints 5 **global** shortcuts under "EDITOR SHORTCUTS — FIXED, DEPENDS ON FOCUS".                                                                                                                                                                                                                                    | `HelpOverlay.tsx:372`; rows `shortcuts.ts:369–392` (M, J, Ctrl+G/Ctrl+Shift+G, Shift+L, arrows) are implemented in the global dispatcher `App.tsx` (`toggleClipMute`/`toggleSnap`/`groupClips`/`ungroupClips`/`toggleClipLock`, nudge `App.tsx:1602`).                                                                                                                                                                                                                                                                                                                                                                                                                   | A user reads "depends on focus" and assumes the binding needs the arrangement focused; the bindings work everywhere.                                                                | Split the registry into `global` and `editorScoped` arrays and render each under its own heading.                                                                                                       |
| **HCP-05-06** | **G** | Custom rebinding can only ever produce a **Ctrl/Cmd + Shift + one letter** chord, and 10 of the 26 letters are reserved.                                                                                                                                                                                                              | `safeBindingReason` `shortcuts.ts:511–518`; capture rejects everything else (`shortcutBindingFromEvent` `:470–479`) with the message "Press Ctrl/Cmd + Shift + one letter or number." (`HelpOverlay.tsx:74`).                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Of 51 shipped chords, only 4 are already Ctrl/Cmd+Shift+letter; the other 47 cannot be moved to a natural alternative (e.g. "Force save" can never become a bare F2 or Alt+S).      | Widen `safeBindingReason` to the whole chord space (still blocking OS-reserved chords), or make it per-shortcut opt-in.                                                                                 |
| **HCP-05-07** | **C** | **40.3 %** of disabled controls (222 of 551) expose neither a tooltip nor an aria-label explaining why they are disabled.                                                                                                                                                                                                             | `ScenesPanel.tsx:125/133/141`, `ArrangementPanel.tsx:4779/4787/4797/5081/5093/5588/5603/5618`, `ContextMenu.tsx:616/619/622/629/653`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | A greyed-out button is indistinguishable from a broken one. The product already has the correct pattern at `ArrangementPanel.tsx:4343`.                                             | Make `title` mandatory on disabled buttons (lint rule), seeded by the existing examples.                                                                                                                |
| **HCP-05-08** | **F** | Palette-driven failures are silent unless the ARR panel happens to be open. The **only** listener for `pf-arrangement-action-error` is the arrangement panel.                                                                                                                                                                         | `ArrangementPanel.tsx:658–663` is the sole subscriber; the dispatcher emits it from 9 places (`App.tsx:847, 855, 877, 887, 901, 930, 943`); `groupClips` throws "Select at least two clips to group" (`clipGroups.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Run "Group clips" from the palette with the MIX panel open → nothing happens and nothing is said.                                                                                   | Route `pf-arrangement-action-error` to a global toast, not to the arrangement panel.                                                                                                                    |
| **HCP-05-09** | **E** | Two mechanisms teach the same first-run material at once, on different storage keys.                                                                                                                                                                                                                                                  | `OnboardingTour.tsx:123` (`pf-tour-v1`) and `OnboardingHint.tsx:4` (`pulse-forge.onboarding.done.v1`); both are mounted unconditionally (`App.tsx:1823`, `:2062`); tour steps 2–3 (`OnboardingTour.tsx:174–176`) duplicate hint step 3 (`OnboardingHint.tsx:9`).                                                                                                                                                                                                                                                                                                                                                                                                         | A fresh profile gets a 4-card modal tour **and** a 5-step status bar about the same shortcuts.                                                                                      | Share one completion key, or suppress the hint bar while the tour is running.                                                                                                                           |
| **HCP-05-10** | **G** | The DAW-profile bridge is gated on a profile being picked in a modal, and 4 of the 8 mappings never reach the palette.                                                                                                                                                                                                                | `dawProfile.ts:86–96` (audition), `:98–108` (pattern-record), `:109+` (audio-record, comp) have **no** `shortcutKeys`; `commandPalette.ts:44–52` only builds profile hints for mappings that have them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | A Pro Tools user who selects "Pro Tools" gets "Record MIDI" only in the tour text, never in the palette or as an entry point.                                                       | Add `shortcutKeys` to the 4 unmapped actions, or map them to the panel that implements them.                                                                                                            |
| **HCP-05-11** | **B** | Four dock tabs — **CHO, KOPA, LIVE, REF** — have no shortcut and no palette entry, so a keyboard-only user cannot open them at all. The registry even _claims_ they are reachable.                                                                                                                                                    | `DockChrome.tsx:57–61` (choral), `:63–67` (kopa), `:76–80` (live), `:124–128` (reference) have no `shortcut:` field, unlike the other 10; `PANEL_IDS_BY_SHORTCUT` (`shortcuts.ts:68–83`) lists exactly 10 ids. Yet the comment at `shortcuts.ts:77–78` asserts "every dock tab is now keyboard-reachable (ROADMAP-UI-2027 V1)" — a false claim in the source.                                                                                                                                                                                                                                                                                                            | The reference map (BPM / key / confidence) and the choir and kick designers are unreachable without the mouse, and the source comment hides that.                                   | Add four `panel*` shortcuts — `PANEL_IDS_BY_SHORTCUT` already has the 10 that exist, so the extension is mechanical — and correct the comment.                                                          |
| **HCP-05-12** | **H** | `ungroupClips` and `setClipsLocked` build a **no-op snapshot** command when nothing changes, and the dispatcher executes it unconditionally.                                                                                                                                                                                          | `clipGroups.ts:76` ("Ungroup clips (no-op)"), `:88`; dispatcher `App.tsx:905–932` calls `services.store.execute(...)` with no null check, unlike `moveTrackBySteps` which is guarded (`App.tsx:803`) and `toggleAudioClipsMute` (`:939`).                                                                                                                                                                                                                                                                                                                                                                                                                                | Ungrouping with nothing selected still pushes an undo entry, so Ctrl+Z appears to do nothing — a trust problem.                                                                     | Return `null` from the no-op branch and guard the call site like `toggleClipMute`.                                                                                                                      |
| **HCP-05-13** | **D** | `duplicateSelection` (Ctrl+D / palette "Duplicate selection") silently **duplicates the active pattern** when nothing is selected.                                                                                                                                                                                                    | `App.tsx:851–859` — `if (selection.timeRange) … else services.store.execute(duplicatePattern(doc, doc.activePatternId));`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | A user with an empty arrangement pressing Ctrl+D expects "nothing" and gets a duplicated pattern with no confirmation.                                                              | Require an explicit target, or make the pattern branch a distinct labelled action.                                                                                                                      |
| **HCP-05-14** | **E** | `copyClips` / `cutClips` / `pasteClips` / `toggleClipMute` / `groupClips` / `ungroupClips` / `toggleClipLock` / `duplicateSelection` show their shortcut inside the context menu, but `Delete`, `Consolidate` and the two "Producer edit…" items do not — even though Delete has a global binding (`deleteNote`, `shortcuts.ts:225`). | `ContextMenu.tsx:617, 620, 623, 631, 639, 642, 645, 651` vs `:648`, `:654`, `:683`, `:699`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | The menu teaches half its own shortcuts; the user concludes the un-hinted items are not shortcuts.                                                                                  | Render the binding for every menu item that has one, from the registry (`shortcutHints.label`), including Delete.                                                                                       |

---

## 5. Verified working

- **Registry ↔ dispatcher integrity: 51 ↔ 51, zero orphans.** Every `SHORTCUTS` key has a `case` in
  `App.tsx`'s `runShortcut` and vice versa (`shortcuts.ts:109–228` vs `App.tsx:702`+). No dead entry.
- **Palette action count is exact: 55.** `buildPaletteActions` 54 + 108 → 51 registry-derived + 4 extras;
  the cache is populated at module load (`shortcuts.ts:611–612`), so the palette is never empty — and the
  palette's own placeholder examples are honest: "solo", "export" and "loop" all resolve (`PaletteOverlay.tsx:94`).
- **Every `EDITOR_SHORTCUTS` row is implemented** (21 of 21 traced to a handler, including the peer's late
  additions "P locators to selection" `App.tsx:1463` and "Consolidate the selected range" `App.tsx:1531–1548`).
- **Custom binding persistence works end to end**: capture (`HelpOverlay.tsx:62–91`) → validation
  (`shortcuts.ts:511–537`) → `localStorage["pf-shortcut-bindings-v1"]` (`:571–579`) → cache rebuild
  (`:595`) → `getActiveShortcuts()` → palette _and_ help both re-read it; conflict detection covers editor
  shortcuts too, not just globals (`shortcuts.ts:526–534`).
- **All 14 dock tabs carry a human-readable title** naming what is behind the three-letter label
  (`DockChrome.tsx:39, 46, 53, 60, 66, 72, 79, 85, 92, 99, 106, 113, 120, 127`).
- **The DAW-profile term "Arrangement → Take Lanes → Comp" is accurate** — TAKE LANES exists
  (`ArrangementPanel.tsx:6209`) and COMP RANGE sits inside it (`:4914–4929`).
- **The statusbar hint system is generic**: any element with `data-hint` publishes itself
  (`StatusHint.tsx:21`) and it listens to `pointerover` _and_ `focusin` (`:25–26`), so keyboard users get it too.
- **The session-state chip solves a real fragmentation**: arming, punch range, loop takes, metronome and
  count-in are gathered into one always-visible place (`SessionStateIndicator.tsx:61–87`).
- **Freeze exists as a real capability with a UI entry point** (`FreezeButton.tsx:76, 96`; mounted at
  `Mixer.tsx:738`) — discoverable by mouse, but with no palette or keyboard path.

---

## 6. Open questions

1. **Window-listener precedence.** Piano roll and app both register `window` `keydown` listeners
   (`PianoRoll.tsx:1754`, `App.tsx:1146`). For a shared chord — `Alt+S` is "Solo selected track" globally
   (`shortcuts.ts:169`) _and_ "Slide (portamento)" in the piano roll (`shortcuts.ts:312`, `PianoRoll.tsx:1665`)
   — which wins? Neither calls `stopImmediatePropagation`.
2. **Does the palette's `profileHint` path fire without a profile?** `commandPalette.ts:44` gates on
   `profile && profileLabel`; `dawProfile.ts:41` is a fresh-install default — is a profile auto-assigned?
3. **Is `extra:diagnostics` (`commandPalette.ts:99–105`) rendering anything?** The overlay's implementation
   was not located in `src/ui/` in this pass. **Searched:** `grep -n 'diagnostics' src/ui/`. If it toggles
   nothing, it is a dead palette entry.
4. **How many of the 222 unexplained disabled controls sit on the primary path to a first take?** The
   ±12-line heuristic is textual, not DOM-accurate; a real DOM audit would refine the 40.3 % figure.
5. **`src/mcp/tools.ts` exposes ~40 of the same command factories** over MCP — a fourth entry path this audit
   deliberately excluded. If MCP is user-facing, §2.1's ratio needs a third term.
6. **Drift risk.** A parallel session edited `src/ui/shortcuts.ts` and `src/ui/App.tsx` while this audit ran.
   Every citation here was re-verified after those edits, but a further peer commit will move them again.

---

_Prepared read-only against `main` at `D:\pulse-forge`. No `src/` or `tests/` file was modified by this audit; the only file it wrote is this document._
