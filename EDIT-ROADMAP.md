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

### Definition of Done — editácia

- [ ] Funguje s **jednou aj viacnásobnou selekciou** (track/clip/note/timeRange)
- [ ] `LMB` select, `Ctrl+LMB` toggle, `Shift+LMB` range, `RMB drag` lasso, `hold RMB 220ms` menu
- [ ] Undo/redo cez `src/commands/commands.ts` `snapshot` (jeden krok)
- [ ] Live == offline pre audio operácie (`src/rendering/*` + `src/scheduler/Scheduler.ts`)
- [ ] Klávesové skratky cez `src/ui/shortcuts.ts` `matchShortcut`

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

### P1.3 Zóna (timeRange) = batch operácie

- [ ] `src/ui/ArrangementPanel.tsx` — drag na timeline (ruler) → `timeRange`, vizuál overlay `rgba(f59e0b,0.12)`
- [ ] `src/commands/commands.ts` — nové `deleteRange(doc, {fromTick,toTick})` (split notes na hranách, nie celý step), `duplicateRange`, `consolidateRange` (volá `stems.ts:buildStemProject` + `frozenPlaybackOffset`)
- [ ] `src/project-model/groove.ts:88` `drumHitsInWindow` už filtruje `[from,to)` — použiť pre `humanizeRange`/`swingRange` len v zóne
- [ ] Test: vyber 2 bary → `Ctrl+D` → 2 bary duplikované, undo 1 krok

### P1.4 Stems ako editovateľné AudioClips

- [ ] `src/project-model/types.ts:388` — nový `AudioClip { id, trackId, bufferId, startBar, offsetSec, trimStart, trimEnd, gain, fadeIn, fadeOut, stretchRate, reverse }` vedľa `ArrangementClip`
- [ ] `src/rendering/track-renderer.ts` + `src/audio-engine/AudioEngine.ts:1926` `frozenPlaybackOffset` — reuse pre audio clip playback (OfflineAudioContext)
- [ ] `src/ui/ArrangementPanel.tsx` — render waveform (ako `src/ui/WavetablePreview.tsx`) + handle trim/fade, `RMB` → `Slice to pads (onset-detector.ts) / Reverse / Normalize / Time-stretch`
- [ ] `src/export/*` — stem export už hotový, len prepoj `buildStemProject` na `AudioClip` výber

---

## 3. P2 — aby to bolo rýchle ako FL (po P1)

### P2.1 PianoRoll doplnky

- [ ] `src/ui/PianoRoll.tsx:190` zapojiť `beginVelDrag` (vertical drag na note → velocity 0.05..1), `Alt+drag` = duplicate, `S` = strum, `Alt+S` = slide, `L` = legato
- [ ] Ghost notes: čítaj `doc.patterns` vedľa `activePatternId` (priehľadné 30%), `src/project-model/types.ts:297` `Pattern.notes`
- [ ] `Ctrl+B` duplicate selection, `RMB` erase (už z P1.2)

### P2.2 Mixer rýchle akcie

- [ ] `src/ui/Mixer.tsx:84` — `RMB na send → Create return`, `drag track → group` (zmeniť `track.groupId`), `RMB na fader → Reset / Type value / Link to macro` (hold menu)
- [ ] `color/label` + `duplicate track with FX` (`src/commands/commands.ts` `duplicateTrack`)
- [ ] Batch FX: `addEffectToTracks(trackIds: ID[], type: EffectType)` — 1 klik na 5 trackov

### P2.3 Sequencer (Channel Rack) rýchlosť

- [ ] `src/ui/Sequencer.tsx` — `Alt+drag` step → microtiming `StepMeta.microtiming -1..1` (`MAX_MICRO_TIMING 30 ticks`), `Ctrl+drag` → probability
- [ ] Per-step `amount` už v `types.ts:252` — zobraziť ho ako mini slider pod stepom

---

## 4. Guardrails (INTUITÍVNE = PREDVÍDATEĽNÉ)

- [ ] Žiadny `alert()` / modal na bežnej akcii — všetko toast `src/ui/CommandToast.tsx`
- [ ] Každý `hold RMB` má `Esc` na zavretie, `Enter` na potvrdenie
- [ ] Všetky zmeny cez `snapshot` → `Ctrl+Z` jeden krok, nie 5
- [ ] Myš + klávesnica musia robiť to isté: `Ctrl+D` = `RMB→Duplicate`

---

## 5. Riziká

- [ ] `timeRange` cez viac trackov + `stepMeta.locks` — merge konflikt v `YDocAdapter.ts:623` stepMeta sync, test `collab-hardening`
- [ ] `AudioClip` stretch → potrebuje `OfflineAudioContext` resample, nie `playbackRate` len (pitch vs time)
- [ ] `hold RMB 220ms` vs `RMB drag` — rozlíšiť `pointerMove > 6px` = drag, inak hold

---

## 6. Poradie práce (sprinty)

1. **Sprint 1 (3 dni):** P1.1 SelectionState
2. **Sprint 2 (2 dni):** P1.2 Tool + hold-RMB menu (bez neho je P1.3 prázdne)
3. **Sprint 3 (3 dni):** P1.3 Zóna batch
4. **Sprint 4 (5 dní):** P1.4 AudioClip stems
5. **Sprint 5 (2 dni):** P2.1 PianoRoll + P2.2 Mixer

---

## Changelog

- 2026-08-29 — Vytvorený dokument. Audit 7 nedostatkov, 4× P1 + 3× P2, guardrails + riziká.
- 2026-08-29 — **P1.1 SelectionState dokončený**: `SelectionStore` + `SelectionContext` + `useSelection` fallback, `App.tsx` `selectTrack(e)` `Ctrl/Shift` range, `Esc` → `clear()`, `TrackTabs.tsx` `Ctrl+click` add. Verif: `typecheck` ✓, `vitest` 1012 ✓.
- 2026-08-29 — **P1.1b Per-step amount + Intensity bus**: `StepMeta.amount 0..1` → `groove.ts` velocity, `MacroMapping.target` → `syncMacros` `intensityBipolar → any fxParam/instParam` (1 fader → filter/movement/width). Verif: `typecheck` ✓, `vitest` 1012 ✓.
- 2026-08-29 — **P1.2 Tool vs hold-RMB menu (základ)**: `ToolStore` + `ToolContext`, `S/P/C/B/E/M` + `Esc` → `select`, `hold 220ms` → `ContextMenu.tsx` `deriveContext`, `RMB drag >6px` → `cut`, `RMB click` = delete (PianoRoll `onContextMenu`, Sequencer `toggleStep`), statusbar `TOOL` `App.tsx:444`, CSS `.context-menu`. Verif: `typecheck` ✓, `vitest` 1012 ✓.
