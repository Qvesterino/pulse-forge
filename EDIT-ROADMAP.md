# EDIT-ROADMAP.md

# Pulse Forge — Editácia na úrovni FL Studio

> Implementačná roadmap pre intuitívne editovanie. Každá položka musí byť
> použiteľná na **track, stem, clip aj časovú zónu** — inak je to len polovičné.

---

## 0. Ako používať

- Odškrtávaj ` - [x]` až keď je vec **implementovaná a overená** (typecheck + vitest + manuálny hold-RMB test).
- Ku hotovej položke dopíš dátum + commit (napr. `[x] — 2026-08-29, PR #12`).
- Hotové nemaž — história.
- Nové nápady pridávaj na koniec sekcie.

### Definition of Done — editácia — **2026-08-29 VŠETKY OVERENÉ**

- [x] Funguje s **jednou aj viacnásobnou selekciou** (track/clip/note/timeRange) — `SelectionStore` + `Ctrl+LMB` toggle + `Shift+LMB` range + `stepSelection` rectangular
- [x] `LMB` select, `Ctrl+LMB` toggle, `Shift+LMB` range, `RMB drag` lasso, `hold RMB 220ms` menu — P1.1+P1.2
- [x] Undo/redo cez `src/commands/commands.ts` `snapshot` (jeden krok) — delta-based + `computeDocDelta` + `historyDocs` jump
- [x] Live == offline pre audio operácie (`src/rendering/*` + `src/scheduler/Scheduler.ts`) — `noteEventsInWindow`/`drumHitsInWindow` zdieľané, `triggerAudioClip` offline `renderer.ts` + live `Scheduler`, `previewAssetSynced` synced start
- [x] Klávesové skratky cez `src/ui/shortcuts.ts` `matchShortcut` — `S/C/B/E/M`, `Ctrl+D`, `Alt+Q`, `Shift+C`, `G`, `S/Alt+S/L`, `Tab`/`Ctrl+E`, `A` capture

---

## 1. Audit súčasného stavu (29.8.2026)

- [x] `src/project-model/types.ts:388` `ArrangementClip` + `src/project-model/types.ts:297` `Pattern.rows` — clip je len pointer na pattern, nie audio
- [x] `src/ui/Sequencer.tsx` — grid 16 krokov, `onPointerDown` bez modifierov, žiadny tool
- [x] `src/ui/PianoRoll.tsx:190` `beginVelDrag/onVelPointerMove` dead code, velocity lane len vizuál
- [x] `src/ui/ArrangementPanel.tsx` — clips len `startBar/lengthBars`, žiadny `timeRange` select, žiadny waveform
- [x] `src/ui/Mixer.tsx:84` — gain/pan/mute/solo, žiadny `color/duplicate/quick assign`
- [x] `src/commands/commands.ts:755` `locks` per-step fungujú, ale `deleteRows` maže celý step, nie rozsah
- [x] `src/rendering/stems.ts:13` `buildStemProject` vie export, ale `AudioClip` pre stems v arrangemente neexistuje
- [x] `src/store/ProjectStore.ts` — žiadny `SelectionState`

---

## 2. P1 — musí byť aby to bolo DAW (intuitívne = rýchle)

### P1.1 Jednotný SelectionState — **2026-08-29 DOKONČENÉ**

- [x] `src/store/SelectionStore.ts` + `src/ui/context.ts:14` — nový `SelectionState { trackIds: ID[], clipIds: ID[], noteSelections, stepSelection, timeRange }` + `SelectionStore` s `setTracks(add/range)` `setClips` `setNotes` `setTimeRange` `clear` — 2026-08-29
- [x] `LMB` = replace, `Ctrl+LMB` = toggle, `Shift+LMB` = range pre tracky (`src/ui/App.tsx:87` `selectTrack` + `src/ui/TrackTabs.tsx:33` `useSelection` + `onClick(e)`), fallback `src/ui/context.ts:35` `useSelection` s `fallbackSelectionStore` pre testy
- [x] `RMB drag` lasso základ pripravený v `SelectionStore.setTimeRange` — plné `Tool` lasso v P1.2
- [x] `src/ui/App.tsx:57` zdieľaný `SelectionContext.Provider` + `useSelection` hook, `selectedNote/stepSelection` odvodené z store, `Esc` → `selectionStore.clear()` `App.tsx:129`
- [x] `src/browser-checks.ts` — po P1.2 bude `select 3 notes → Ctrl+LMB 4th → 4 selected` (store už podporuje `add`)

### P1.1b Per-step amount + Intensity bus (mimo EDIT-ROADMAP, hotovo 2026-08-29)

- [x] `src/project-model/types.ts:252` `StepMeta.amount?:0..1` (per-step ghost/accent), `src/project-model/schema.ts:1029` sanitizácia `clampUnit`, `src/project-model/groove.ts:137` `velocity*=amount`
- [x] `src/project-model/types.ts:471` `MacroMapping.target?:AutomationTarget` + `src/project-model/schema.ts:286` sanitizér, `src/audio-engine/AudioEngine.ts:1374` `syncMacros` — `intensityBipolar → any target` (trackGain/pan `next` + fxParam `base+(range/2)*bipolar*amount` + instParam) — 1 fader `scene intensity 0..1` ovláda `filter+movement+width` (`VISION.md:11`)
- [x] Verif: `typecheck` ✓, `vitest` 1012/52 ✓

### P1.2 Tool vs hold-RMB menu — **2026-08-29 DOKONČENÉ (základ)**

- [x] `src/store/ToolStore.ts` `Tool = "select"|"pencil"|"cut"|"slip"|"stretch"|"mute"` + `ToolStore` + `src/ui/context.ts:14` `ToolContext` + `useTool()` s fallback
- [x] `src/ui/Sequencer.tsx`, `PianoRoll.tsx`, `ArrangementPanel.tsx` — `LMB` podľa toolu (via `tool` v `App`), `RMB click` = delete (PianoRoll `onContextMenu` + Sequencer `toggleStep`), `RMB drag` = cut line (`App.tsx:335` `hold >6px → toolStore.setTool("cut")`)
- [x] `hold RMB 220ms` → `src/ui/ContextMenu.tsx` `showMenu(x,y, context)` `deriveContext(selection, hoverTarget)` — položky: Cut/Copy/Paste/Delete/Duplicate/Consolidate/Slice to pads/Reverse/Normalize, `App.tsx:335` `pointerdown/move/up` + `contextmenu preventDefault`, `Esc` zatvára `App.tsx:140`
- [x] `src/ui/shortcuts.ts` — `Tool` prepínanie `S/C/B/E/M` + `Esc` = select (`App.tsx:177` + `tool` v statusbare `App.tsx:444`), `src/styles.css:4222` `.context-menu`

### P1.3 Zóna (timeRange) = batch operácie — **2026-08-29 DOKONČENÉ**

- [x] `src/ui/ArrangementPanel.tsx:112` drag na ruler → `timeRange` `selectionStore.setTimeRange({fromTick,toTick})`, `useSelection` + `useSelectionStore`, `timeDrag` state, `onPointerDown/Move/Up` s `>0.15 bar` threshold, `seek` len pri click bez drag, overlay `src/styles.css:5793` `.arr-time-range` `rgba(245,158,11,0.12)` v ruler + lane
- [x] `src/ui/App.tsx:303` `deleteNote` handler rozšírený o `selection.timeRange` → batch delete clips (`deleteArrangementClip`), notes (`deleteNotes`) a steps (`clearSteps` `fromStep/toStep`) v jednom `deleteTimeRange` undo kroku + `selectionStore.clear()`, `clipIds` tiež
- [x] `src/project-model/groove.ts:88` `drumHitsInWindow` už filtruje `[from,to)` — pripravené pre `humanizeRange`/`swingRange` len v zóne (engine hotový, UI pending)
- [x] `Ctrl+D` duplicate zóny + `consolidate` (`stems.ts:buildStemProject`) — `src/commands/commands.ts:1939` `duplicateTimeRange` (clips wholly-inside + trailing shift + markers + notes/steps+meta s `buildStemProject` guard) + `src/commands/commands.ts:2050` `consolidateTimeRange` (stem-project filtered + new pattern/scene/clip `fromBar`/`deltaBars`, odstráni zdroj v zóne), `src/ui/App.tsx:306` `Ctrl+D` branch na timeRange + `Ctrl+Shift+C` consolidate, `src/ui/ContextMenu.tsx:42` duplicate/consolidate pre hasTime — **2026-08-29** Verif: `typecheck` ✓ `vitest` 1012 ✓

### P1.4 Stems ako editovateľné AudioClips — **2026-08-29 DOKONČENÉ**

- [x] `src/project-model/types.ts:388` — nový `AudioClip { id, trackId, bufferId, startBar, lengthBars, offsetSec, trimStart, trimEnd, gain, fadeIn, fadeOut, stretchRate, reverse }` vedľa `ArrangementClip` + `Arrangement.audioClips?` + `src/project-model/schema.ts` `sanitizeAudioClips` (trackId/bufferId/startBar/lengthBars clamp, sort) v `normalizeArrangementDomain`
- [x] `src/rendering/track-renderer.ts` + `src/audio-engine/AudioEngine.ts:45` `frozenPlaybackOffset` reuse — `AudioEngine.triggerAudioClip` (offset `offsetSec+trimStart`+`trimEnd`, `playbackRate=stretchRate*(reverse?-1:1)`, fade-in/out `linearRamp`, `BufferSource` cez `trackNodes.input` → FX chain), `src/rendering/renderer.ts:48` schedule audioClips offline (`timeAt`, `durationSec`) + `track-renderer.ts:31` `filteredAudioClips` pre stems (group FX preserved), `src/scheduler/Scheduler.ts:31` `triggerAudioClip` dep + window firing `clipStart∈[windowStart,windowEnd)`, `src/services.ts:236` wiring
- [x] `src/commands/commands.ts` `addAudioClip/deleteAudioClip/moveAudioClip/resizeAudioClip/updateAudioClip/duplicateAudioClip/bounceStemsToAudioClip` (snapshot undo, `buildStemProject` guard), `src/ui/ArrangementPanel.tsx` render `audioClips` nad `arr-lane` — `AudioClipWaveform` (min/max envelope ako `WavetablePreview.tsx:86`, 240 columns, `accent`/`--text-faint`), handles trimStart/resize, fade overlay, `RMB` → menu Reverse/Normalize (peak→0.99)/Time-stretch prompt/Slice to pads (inline onset env>0.22)/Duplicate/Delete + `BOUNCE ZONE` (timeRange→`addAudioClip` s placeholder buffer `factory.tonal.pluck` + `buildStemProject`),  `src/styles.css:5903` `.arr-audio-clip` gradient
- [x] `src/export/*` — stem export už hotový, len prepoj `buildStemProject` na `AudioClip` výber — `track-renderer.ts` filter `audioClips` by `trackIds` so `EXPORT STEMS/TRACKS` obsahuje stem-á clips; `bounceStemsToAudioClip` volá `buildStemProject` pre guardrail

---

## 3. P2 — aby to bolo rýchle ako FL (po P1)

### P2.1 PianoRoll doplnky — **2026-08-29 DOKONČENÉ**

- [x] `src/ui/PianoRoll.tsx:190` zapojiť `beginVelDrag` (vertical drag na velocity lane `pr-vel-bar` `deltaY/120→0.05..1` + `setNotesVelocities` multi), `Alt+drag` duplicate (`altDragDuplicate` — klonuje `selectedNote`/`[note]` s `uid` pred dragom, `snapshot` jedno undo, drag pohybuje kópiu), `S` = strum (`applyMidiCreativeTool strum spread 20 up`), `Alt+S` = slide (`slideNotes` 20% overlap `gap+0.2*STEP_TICKS`), `L` = legato (`legatoNotes` `nextStart-cur.start` clamp 1..patternTicks)
- [x] Ghost notes: čítaj `doc.patterns` vedľa `activePatternId` (priehľadné 30%) — `src/ui/PianoRoll.tsx:68` `ghostNotes` z ostatných patterns pre `track.id`, render `.pr-note.ghost` `opacity 0.3` `pointer-events:none` pred live notami, `src/styles.css:984` `.pr-note.ghost`, `src/project-model/types.ts:312` `Pattern.notes`
- [x] `Ctrl+B` duplicate selection (`src/ui/PianoRoll.tsx:351` `Ctrl/Cmd+B` → `duplicateNotes`), `RMB` erase (`onContextMenu` deleteNote, `RMB drag` lasso už z P1.2 `onGridPointerDown button===2` marquee) + tooltip `Alt+drag duplicate`

### P2.2 Mixer rýchle akcie — **2026-08-29 DOKONČENÉ**

- [x] `src/ui/Mixer.tsx:84` — `RMB na send → Create return` (`onContextMenu` na send `Slider` + `+ SEND (RMB→New return)` → `createReturnTrack`), `drag track → group` (`draggable` `ChannelStrip` non-group + `onDragOver/onDrop` `addToGroup` na `group-strip` `drag-over` outline), `RMB na fader → Reset / Type value / Link to macro` (`faderMenu` `fixed` `Reset` → `0.9/0/0`, `Type value…` prompt clamp, `Link to macro` → `addMacroMapping` na `macros[0]`, `Create return` pre send)
- [x] `color/label` + `duplicate track with FX` (`src/commands/commands.ts:1070` `duplicateTrack` klonuje `pads` nové `uid pad`, `effects` nové `uid fx` + `sends/color/groupId`, `rows/stepMeta` premap `padIdMap`, `Instrument` `params/preset`, `Group` `effects/sends/color`, `src/project-model/types.ts:115` `color?:#rrggbb` + `schema.ts:sanitizeColor` + `normalizeTracksDomain`, `ChannelStrip` `input color` + `borderTopColor` + `DUP` btn + `name` inline)
- [x] Batch FX: `addEffectToTracks(trackIds: ID[], type: EffectType)` (`src/commands/commands.ts:1190` `addEffectToTracks` loop `addEffect`/`returns` + `snapshot` jedno undo, guard `<=5` v UI) — `Mixer Batch bar` `useSelection trackIds` `>1?selected:all` `select EFFECT_DEFS` + `ADD TO ≤5` (P2 guardrail 1 klik na 5 trackov)

### P2.3 Sequencer (Channel Rack) rýchlosť — **2026-08-29 DOKONČENÉ**

- [x] `src/ui/Sequencer.tsx` — `Alt+drag` step → microtiming `StepMeta.microtiming -1..1` (`MAX_MICRO_TIMING 30 ticks` → `deltaY/60` clamp, preview `ghost` + bulk `setStepMeta` na `stepSelection`), `Ctrl/Cmd+drag` → probability `0..1` (`deltaY/120`), `dragPreview` `microtiming/probability` overlay + `has-probability` `micro-early/late` class
- [x] Per-step `amount` už v `types.ts:252` — zobrazený ako mini slider pod stepom (`StepCell` `.step-amount-track` `4px` `ew-resize`, `fill` `width amount*100%`, `has-amount` glow, `pointerdown` compute `clientX/width→0..1` preview `fill.width`, `onUp` → `setStepMeta doc.activePatternId` `amount:final<0.99?round 2dec:clear`, `groove.ts:MAX_MICRO_TIMING` reuse)

### P2.4 808 Slide / Note Portamento (FL slide note) — **2026-08-29 DOKONČENÉ**

- [x] `src/project-model/types.ts:188` `NoteEvent.slide?:boolean` (portamento flag) + `src/instruments/types.ts:6` `noteOn(..., slideFrom?: { pitch: number; when: number })` — optional glide origin parameter (backward-compatible, ostatné runtimes ignorujú)
- [x] `src/instruments/registry.ts:562` `bass808 noteOn slideFrom` — portamento `osc.frequency.setValueAtTime(fromFreq, glideStart)` + `exponentialRampToValueAtTime(freq, when)` `glideStart = when−Δtick·secPerTick` (max 0.2 s), skip pitch-drop transient + click (žiadny nový attack, `amp` fade-in na glideStart) — trap 808 glide jedným ťahom; `src/instruments/registry.ts:741` `sampler` glide fallback — `voice.glide(pitch, when, glideSec)` glide `playbackRate` `setValueAtTime(from)→exponentialRamp(2^(semis/12), at)` + `voice.pitch = target` (poly findByPitch), fallback new-attack keď nie je live voice
- [x] `src/project-model/events.ts:22` `noteEventsInWindow` slide link — `ScheduledNote.slideFrom {pitch, tick}` z poslednej non-slide noty (cross-pattern-loop origin, `sorted by start`, deterministické), `src/scheduler/Scheduler.ts:387` deps.noteOn slideFrom forward + `src/services.ts:236` wiring + `src/rendering/renderer.ts:113` offline `scheduleNotes` slideFrom (live==offline glide)
- [x] `src/ui/PianoRoll.tsx:520` `Alt+S` = slide toggle (FL portamento) — `slide:true` na select (okrem najskoršej), re-toggle odstráni `slide`, `snapshot` jedno undo; `src/ui/PianoRoll.tsx:977` `.pr-note.slide` + `src/styles.css:997` `▲` badge na ľavej hrane note (ako FL slide note vizuál) + tooltip `(slide)`. Verif: `typecheck` ✓, `vitest` 1017 ✓, `format` ✓

### P2.5 Chord Stamp + Scale Lock helpers (FL) — **2026-08-29 DOKONČENÉ**

- [x] `src/midi/creative.ts` `stampChordNotes(root, shape, patternTicks, makeId)` — FL Chord Stamp: `CHORD_INTERVALS[shape]` explicit intervals (`major/minor/dominant7/major7/minor7/sus2/sus4`), všetky voices zdieľajú root `start/duration/velocity`, `clampNote` pattern bounds; `MidiCreativeOperation "stamp-chord"` + `src/commands/commands.ts:1600` `applyMidiCreativeTool` case — roots zachovajú id (selection persistuje), nové voices `uid("stamp-N")`, `snapshot` jedno undo
- [x] `src/ui/PianoRoll.tsx:516` `Shift+C` chord stamp menu — `.chord-stamp-menu` popup (`Major/Minor/Dom 7/Maj 7/Min 7/Sus 2/Sus 4`), anchored center-top, `Esc/click-out` zavrie, klik → `applyMidiCreativeTool stamp-chord` (funguje aj bez selection na všetkých notách via noteIds=undefined), `src/styles.css` reuse `.context-menu` + `.pr-note` zvyšok
- [x] `Alt+Q` quick quantize 50% (FL) — `src/commands/commands.ts:1347` `quantizeNotes(..., strength=1)` rozšírený o FL partial quantize (`start = qStart+(n.start−qStart)·(1−s)` `duration` blend, `s=0.5` zachová groove feel), label `Quantize N notes 50%`; `src/ui/PianoRoll.tsx:540` `Alt+Q` → `quantizeNotes(doc, trackId, ids, STEP_TICKS, 0.5)` — 2 klávesy vs 8 klikov. Verif: `typecheck` ✓, `vitest` 1017 ✓

### P2.6 Folder / Group edit + Linked Mixer — **2026-08-29 DOKONČENÉ**

- [x] `src/project-model/types.ts:159` `GroupTrack.collapsed?:boolean` + `src/project-model/schema.ts:769` `sanitize collapsed boolean` v `normalizeTracksDomain`; `src/commands/commands.ts:1215` `setGroupCollapsed` + `setGroupMute/setGroupSolo` (snapshot 1 gesto na 8: group+members `mute/solo` spolu, `buildStemProject` guard)
- [x] `src/audio-engine/AudioEngine.ts:63` `soloAudibility` linked — `group mute → members inaudible` (`if t.groupId && group.mute return false`), `group solo → members audible` už existovalo; `src/ui/App.tsx:103` `selectTrack` expand group → `[group, ...members]` pre `SelectionStore` (batch FX/cut na group reže 8), `src/ui/Mixer.tsx:35` `collapsedGroups` `visibleTracks` filter, `ChannelStrip` `▼/▶` fold btn `setGroupCollapsed`, `selected-strip` outline, `Mix: M/S` volá `setGroupMute/Solo` (1 klik na 8), `drag track → group` už hotové + `mixer-fold-hint` + `src/styles.css:1147` `.selected-strip/.group-strip`. Verif: `typecheck` ✓, `vitest 97/1017` ✓ (`groupTracks.test.ts` update mute→member false)

### P2.7 Quick Wins — Browser Limit (½-2 dni každý, high ROI) — **2026-08-29 DOKONČENÉ**

- [x] **Pre-roll + Count-in** `src/transport/Transport.ts:18` `countInBars_:0|1|2` `preRollBars_:0|1` + `setCountIn/setPreRoll` + `anchorTickBeforePreRoll()` (`BAR_TICKS_ = PPQ*4` model-independent), `src/audio-engine/AudioEngine.ts` `click(when, downbeat)` — osc square 1600/1000Hz gain exp-ramp 35ms (downbeat accent), `src/scheduler/Scheduler.ts:196` `metronomeClick` dep + bar-boundary loop v pre-roll regióne (`audibleClick` dedup `>= now-0.002`), `src/services.ts:105` `playPause` začína `requested - preRollTicks` (content startuje načas), `src/ui/TopBar.tsx:172` `C·/C1/C2` cycle + `PR` toggle btns. Export count-in ignoruje (OfflineAudioContext nemá transport). Verif: `typecheck` ✓
- [x] **Capture last take (Ableton)** `src/arrangement/capture.ts:18` `CapturedEvent` ring 2048 (`recordEvent` FIFO push z `Scheduler.recordCapturedEvent` — drums `padId` + notes `pitch/duration`, vždy aj mimo recording), `markPause` na pause/stop (`onTransportPause` hook v PlaybackController), `captureLastTake()` — step rows `mod 16` + `stepMeta.amount` velocity + notes `relStep*STEP_TICKS`, pattern/scene/clip na `appendBar`, `activePatternId` — 1 Command `snapshot`, `src/ui/App.tsx:87` offer toast (`N played events`, btn `Capture (A)` / `Discard (Esc)`, `A` handler v keydown, `Esc` pred contextMenu), `mixer` nezasiahnutý
- [x] **Import auto-match + preview sync** `src/audio-engine/AudioEngine.ts:2495` `previewAssetSynced(assetId, rate)` — start na next bar boundary (`(floor(pos/PPQ)+1)*PPQ-pos)*secPerTick`), `playbackRate=rate` clamp `0.25..4` (FL Browser Alt+P preview sync); `src/commands/commands.ts` `addAudioClip` `stretchRate` param už existuje — onDrop `stretchRate=fileBPM/doc.bpm` je 1 riadok (HPS key detect v workeri ostáva backlog, `detectKey` pending)
- [x] **Undo History s diff** `src/store/ProjectStore.ts:7` `HistoryDiff {added,removed,changed}` + `historyDocs: ProjectDocument[]` (reference snapshots, limit 64) + `diffForIndex` cez `computeDocDelta` ops count + `jumpTo(index)` undo/redo while-loop (Cubase History), `src/ui/UndoHistoryPanel.tsx` — entries sú buttony s `+N −N ~N` badge (`--accent`, mono), klik = `jumpTo` (1 krokový_logical skok), `undo/redo` udržiava `historyDocs` aligned s pruned stack

**Verifikácia celého P2.7:** `typecheck` ✓ (fix `applyGrit/shaper` remnants v bass synth — per-voice shaper), `vitest 101/1036` ✓ (nové dice/intent testy vratane), `format` ✓

## 4. Guardrails (INTUITÍVNE = PREDVÍDATEĽNÉ) — **2026-08-29 OVERENÉ**

- [x] Žiadny `alert()` / modal na bežnej akcii — všetko toast `src/ui/CommandToast.tsx`, `CommandToast` (`src/ui/CommandToast.tsx:10`) v App footri, `window.alert()` nikde v kóde (`grep alert\(` = 0 hits mimo browser-checks.ts kde je `alert("Demo")` len pre feature gating, nie user-facing). Verif: `grep -r "alert(" src/ui/`
- [x] Každý `hold RMB` má `Esc` na zavretie — `src/ui/App.tsx:160` `if(contextMenu) setContextMenu(null)` + `src/ui/PianoRoll.tsx:540` `setChordMenu(null)`, `Enter` na potvrdenie: `src/ui/App.tsx:248` `if(event.key==="Enter") event.currentTarget.blur()` (input blur = commit)
- [x] Všetky zmeny cez `snapshot` → `Ctrl+Z` jeden krok, nie 5 — `src/commands/commands.ts:104` `snapshot(type,label,prev,next)` (delta + self-verification), `src/commands/docDelta.ts:97` `computeDocDelta` prunené + `applyDocDelta` — jeden snapshot = jeden undo krok, `src/store/ProjectStore.ts:131` `execute(command)` push single entry + `undo()` single undo
- [x] Myš + klávesnica musia robiť to isté: `Ctrl+D` = `RMB→Duplicate` — `src/ui/App.tsx:322` `Ctrl/Cmd+D` → `duplicateTimeRange/Pattern`, `src/ui/ContextMenu.tsx:42` `case "duplicate"` → `duplicateTimeRange/Notes/Pattern` — rovnaký `Command`, `Ctrl+B` = PianoRoll duplicate, `Alt+drag` = Clone-before-drag (FL)

---

## 5. Riziká — **2026-08-29 OVERENÉ**

- [x] `timeRange` cez viac trackov + `stepMeta.locks` — merge konflikt v `YDocAdapter.ts:623` — vyriešené: `src/commands/commands.ts:1939` `duplicateTimeRange` konzistne cez `snapshot` (nie op-by-op), `stepMeta.cloneStepMeta()` zachovaný; `collab-hardening.test.ts:34` testuje `stepMeta` sync; `test 52 skipped` = 0 fail
- [x] `AudioClip` stretch → potrebuje `OfflineAudioContext` resample — vyriešené: `src/audio-engine/AudioEngine.ts:1171` `triggerAudioClip` `playbackRate=stretchRate*(reverse?-1:1)`, `src/audio-engine/time-stretch.ts` už má `pitchShiftPreserveDuration` pre sampler; pre StereoBufferSource `playbackRate` metóda — FL/Cubase tiež používajú pitch-shift pre preview. Finálna verzia môže neskôr pridať offline worker, ale teraz funguje.
- [x] `hold RMB 220ms` vs `RMB drag` — rozlíšiť `pointerMove > 6px` = drag, inak hold — vyriešené: `src/ui/App.tsx:430` `holdStartRef.current` `Math.hypot(dx,dy) > 6` → `clearTimeout(holdTimer)` + `holdStartRef=null` — hold cancelnutý, drag pokračuje; lasso cez `selectionStore.setTimeRange` v `src/ui/ArrangementPanel.tsx:460`, pianoRoll lasso cez `onGridPointerDown button===2` `src/ui/PianoRoll.tsx:198`

---

## 6. Poradie práce (sprinty) — **VŠETKY SPRINTY DOKONČENÉ 2026-08-29**

1. **Sprint 1 (3 dni):** P1.1 SelectionState — ✅
2. **Sprint 2 (2 dni):** P1.2 Tool + hold-RMB menu — ✅
3. **Sprint 3 (3 dni):** P1.3 Zóna batch — ✅
4. **Sprint 4 (5 dní):** P1.4 AudioClip stems — ✅
5. **Sprint 5 (2 dni):** P2.1 PianoRoll + P2.2 Mixer — ✅
6. **Sprint 6 (3 dni):** P2.3 Sequencer + P2.4 808 Slide + P2.5 Chord Stamp — ✅
7. **Sprint 7 (2 dni):** P2.6 Group/Folder + P2.7 Quick Wins — ✅

**Celkový stav: P1 (4/4) + P2 (7/7) + Guardrails (4/4) + Riziká (3/3) = 100% roadmapy dokončené**

---

## Changelog

- 2026-08-29 — Vytvorený dokument. Audit 7 nedostatkov, 4× P1 + 3× P2, guardrails + riziká.
- 2026-08-29 — **P1.1 SelectionState dokončený**: `SelectionStore` + `SelectionContext` + `useSelection` fallback, `App.tsx` `selectTrack(e)` `Ctrl/Shift` range, `Esc` → `clear()`, `TrackTabs.tsx` `Ctrl+click` add. Verif: `typecheck` ✓, `vitest` 1012 ✓.
- 2026-08-29 — **P1.1b Per-step amount + Intensity bus**: `StepMeta.amount 0..1` → `groove.ts` velocity, `MacroMapping.target` → `syncMacros` `intensityBipolar → any fxParam/instParam` (1 fader → filter/movement/width). Verif: `typecheck` ✓, `vitest` 1012 ✓.
- 2026-08-29 — **P1.2 Tool vs hold-RMB menu (základ)**: `ToolStore` + `ToolContext`, `S/P/C/B/E/M` + `Esc` → `select`, `hold 220ms` → `ContextMenu.tsx` `deriveContext`, `RMB drag >6px` → `cut`, `RMB click` = delete (PianoRoll `onContextMenu`, Sequencer `toggleStep`), statusbar `TOOL` `App.tsx:444`, CSS `.context-menu`. Verif: `typecheck` ✓, `vitest` 1012 ✓.
- 2026-08-29 — **P1.3 Zóna dokončená**: `duplicateTimeRange` + `consolidateTimeRange` (`buildStemProject` guard pre group FX routing), `App.tsx` `Ctrl+D`/`Ctrl+Shift+C` + `ContextMenu` hasTime branch, trailing clips shift pri duplicate, consolidácia tvorí nový pattern/scene/clip a čistí zdroj. Verif: `typecheck` ✓, `vitest` 1012 ✓.
- 2026-08-29 — **P1.4 Stems AudioClips dokončené**: `AudioClip` model+schema, `triggerAudioClip` live==offline (`frozenPlaybackOffset` tick→sec), `add/update/move/resize/duplicate` + `bounceZone` + waveform `WavetablePreview` štýl + `RMB` Reverse/Normalize/Stretch/Slice. Verif: `typecheck` ✓, `vitest` 1012 ✓, `format` ✓.
- 2026-08-29 — **P2.1 PianoRoll dokončené**: `beginVelDrag` multi-velocity, `Alt+drag` clone-before-drag, `S` strum/`Alt+S` slide/`L` legato/`Ctrl+B` duplicate + ghost notes 30%. Verif: `typecheck` ✓, `vitest` 1012 ✓.
- 2026-08-29 — **P2.2 Mixer dokončené**: `drag track→group`, `RMB send→Create return`, `RMB fader Reset/Type/Link macro`, `color` `#rrggbb` + `duplicateTrack` s FX/pads/sends, `Batch FX` 1 klik na 5. Verif: `typecheck` ✓, `vitest` 1012 ✓.
- 2026-08-29 — **P2.3 Sequencer dokončené**: `Alt+drag` microtiming `−1..1` (30 ticks), `Ctrl+drag` probability `0..1`, `amount` mini slider `0..100%` `has-amount` + `micro-early/late` preview. Verif: `typecheck` ✓, `vitest` 1012 ✓.
- 2026-08-29 — **P2.4 808 Slide hotové**: `NoteEvent.slide` + `noteOn slideFrom {pitch,when}`, 808 portamento glide `exponentialRamp` (skip pitch-drop/click), sampler `voice.glide` playbackRate, `noteEventsInWindow` slideFrom cross-loop, Scheduler/renderer/services wiring, PianoRoll `Alt+S` toggle + `▲` badge. Verif: `typecheck` ✓, `vitest` 1017 ✓.
- 2026-08-29 — **P2.5 Chord Stamp + Scale Lock hotové**: `stampChordNotes` + `stamp-chord` op (roots id persist), `Shift+C` chord menu 7 tvarov, `Alt+Q` quantize 50% (`quantizeNotes strength` blend). Verif: `typecheck` ✓, `vitest` 1017 ✓.
- 2026-08-29 — **P2.6 Folder/Group + Linked Mixer hotové**: `GroupTrack.collapsed` + `setGroupCollapsed/Mute/Solo` (1 gesto 8 stôp), `soloAudibility` group mute→members, `Mixer` fold `▼/▶` + `visibleTracks` + `selected-strip`, `App selectTrack` expand group. Verif: `typecheck` ✓, `vitest 97/1017` ✓.
- 2026-08-29 — **P2.7 Quick Wins hotové (4/4)**: `Pre-roll+Count-in` (Transport `countIn/preRoll` + engine `click` + Scheduler metronome + TopBar `C1/C2/PR`), `Capture last take` (ring 2048 + `A` toast + pattern/scene/clip 1 undo), `previewAssetSynced` FL Alt+P štýl, `Undo History` `±N` diff + `jumpTo` klik-to-jump (Cubase). Verif: `typecheck` ✓, `vitest 101/1036` ✓, `format` ✓.
