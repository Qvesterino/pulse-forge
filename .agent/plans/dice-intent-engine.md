# Dice / Intent Engine — Plan pre rýchlo-tvorbu beatov

> Cieľ: každým kliknutím **trochu iný beat/pattern**, 100 hodov → nájdeš perfektný. Deterministicky, s históriou, lockami a rýchlym preview.

---

## 1. Kontext

### Čo už existuje (deterministické jadro je hotové)

- `src/shared/rng.ts` — `mulberry32`, `hashString` (FNV-1a), `forkRandom(seed, stream)` — pure, nezávislé streamy
- `src/intent/*` — `IntentSpec` (genre/style/energy/density/complexity/variation/seed/key/bpmRange/length/roles/controls) → `planGeneration()` → `effectiveSeed` (seed + source content hash) → `generationSeed` (genre|effectiveSeed|grooveId) → 8× `forkRandom` sub-seedov (`drums.core/variation/meta`, `melody.*`, `groove`)
- `src/ai/generator.ts` — `generatePattern(doc, options)` — Markov 2. rádu per pad (256 stavov, temperature), ghost/fill/anchor/syncopation/phrase contour, `stepMeta` (micro/probability/ratchet)
- `src/assist/patternOps.ts` — 4 chirurgické operácie na existujúcom patterne: `vary` / `build` (expand) / `replace` (hats/kicks/snares × style) / `fill`
- UI dnes: `GenerateDialog.tsx` 🎲 `Math.random()` 6-znak seed, `AssistPanel.tsx` ⚄ `Math.random().toString(36).slice(2,6)` + auto re-roll po apply, `TopBar` fire-and-forget `Math.random()` — **rozptýlené, nedeterministické, bez histórie**

### Problém

- Hody nie sú reťazené → nedá sa vrátiť k hodu #37
- Žiadne locky → chceš zamknúť kick, prehadzovať len hats → musíš ručne kopírovať
- Preview ≠ apply mentálne oddelené, ale technicky už parity majú (`generateLocalResultFromOptions` rovnaký plán)
- `Math.random()` láme determinizmus — rovnaký seed nevráti rovnaký pattern po reload-e ak si ho nezapísal

### Cieľový UX (tvoja veta)

> "dice alebo seed generator … každým kliknutím trochu iný beat … po 100 randomizáciách nájdem perfektný"

To znamená: **jedno veľké 🎲**, drží intent konštantný, mení len seed (príp. mikro-jitter controls), drží históriu 100 hodov s preview, favorite a lockami.

---

## 2. Návrh architektúry

### 2.1 Zdieľané jadro: `src/shared/dice.ts` (nový, ~80 riadkov)

Pure funkcie nad `rng.ts`, žiadny stav:

```ts
export function nextSeed(seed: string, salt?: string): string
  // hashString(`${seed}|${salt ?? "dice"}`).toString(36).slice(-8).padStart(6,"0")
  // deterministická reťaz: seed_n+1 = f(seed_n)

export function seedAt(seed: string, n: number): string  // n-krát nextSeed

export function throwDice(seed: string, faces?: number): { value: number, nextSeed: string }

export function jitterControls(seed: string, base: IntentControls, amount: number): IntentControls
  // forkRandom(seed,"dice.controls") → ghost/micro/velVar/temperature ± amount*rozsah

export function pickStyle(seed: string, genre: IntentGenre, current: string|null): string|null
  // forkRandom(seed,"dice.style") → náhodný štýl z getStyleNamesForGenre
```

Prečo nové súbory a nie rozšíriť `rng.ts`? `rng.ts` je 23 riadkov, load-bearing všade; dice je doménová nadstavba. Alternatíva `src/intent/dice.ts` by viazala dice len na intent — ale dice chceme aj pre assist a MIDI creative.

### 2.2 Intent rozšírenie (minimálne, bez migrácie)

`IntentSpec` **nemeníme** (je to perzistovaný kontrakt v `pattern.generation.intent`). Namiesto toho:

- `src/intent/dice.ts` (alebo `history.ts`) — `DiceSession` typ držaný **v UI stave**, nie v `ProjectDocument`:

```ts
interface DiceSession {
  intent: IntentSpec;          // zamknutý intent (genre/style/energy/…)
  seedChain: string[];         // [seed0, seed1, … seedN] — lineárna história
  cursor: number;              // index aktuálneho hodu
  locks: DiceLocks;            // čo nehádzať
  favorites: Set<number>;      // indexy ★
  mode: "full" | "vary" | "micro"; // full=nový pattern, vary=assistVary, micro=jitter controls
}

interface DiceLocks {
  genre: boolean; style: boolean;
  drums: boolean; bass: boolean; chords: boolean; lead: boolean;
  // jemnejšie: kick/snare/hats — mapuje sa na subSeeds, pri locku sa subSeed recykluje z predchádzajúceho hodu
}
```

Perzistencia voliteľná: `localStorage["pulse-forge:dice:${docId}"]` alebo neskôr `doc.diceSessions` ak chceš share cez Yjs.

Determinizmus: `seedChain[n+1] = nextSeed(seedChain[n])` → celá 100-hodová session je rekonštruovateľná z `seed0`. `intentHash` + `seed` už dnes v `Pattern.generation` — stačí.

### 2.3 Generačné cesty (3 režimy jedného 🎲)

| Režim | Čo robí | Vstup | Výstup |
|-------|---------|-------|--------|
| **Full** | `generatePattern` s novým seedom | `intent` + `nextSeed` → `planGeneration` | nový `Pattern` (NEW alebo REPLACE) |
| **Vary** | `assistVary` na aktívnom patterne | `activePattern` + `nextSeed` + `amount` | mutácia rows/stepMeta |
| **Micro** | jitter controls pri rovnakom seede | `intent.controls` + `jitterControls(seed)` | jemná variácia ghost/micro/temp |

Prepínač v Dice Tray. Default **Full** — to je tvoj "trochu iný beat každým kliknutím".

### 2.4 UI: `src/ui/DiceTray.tsx` (nový) + úpravy existujúcich

**Nový komponent `DiceTray`** — plávajúci panel / dock vedľa `PatternBar`:

```
┌─ Dice ─────────────────────────────────────────────┐
│ [Full ▾]  [🎲 ROLL]  [↩︎] [↪︎]   seed: a7f3k2  [📋] │
│ Locks: [Kick ■] [Snare □] [Hats □] [Bass ■] [Chords □] │
│ History: ━●━━●━━★━━●━━●━━○━━●  37/100  [★ Favorite] [Apply] │
│ Preview: ▖▖▖▖▖▖▖▖  before 12 hits → after 14 hits       │
└────────────────────────────────────────────────────┘
```

- **ROLL** — `space` / `d` hotkey, `nextSeed = nextSeed(seedChain[cursor])`, push do chain, `preview = generateLocalResult(intentWithNextSeed, "preview")`, render do mini `PatternPreview` + hit count + quality badge
- **History strip** — horizontálny scroll, klik = jump, ★ = favorite, farba podľa `generation.quality.styleDistance`
- **Apply** — `services.store.execute(generatePatternCommand / assistVary)` s aktuálnym preview seedom → jeden undo entry
- **Locks** — toggle; pri locku sa príslušný `subSeed` nep regenerative, ale skopíruje z predchádzajúceho patternu (implementácia: po generácii prekopíruj rows/notes danej role z `prevPattern`)

**Úpravy existujúcich (minimálne, re-use):**

- `GenerateDialog.tsx` — nahraď `randomSeed()` (`Math.random`) → `nextSeed(seed)`; pridaj link "Open in Dice Tray" (neprepisujeme dialóg, len ho napájame)
- `AssistPanel.tsx` — nahraď `Math.random().toString(36).slice(2,6)` → `nextSeed`; zjednoť seed zdroj s DiceTray (cez context)
- `TopBar.tsx` / `PatternBar.tsx` quick dice → deleguj na `DiceTray` store
- `src/ui/context.ts` — nový `DiceContext` (React context) drží `DiceSession` + `roll / jump / toggleLock / favorite`
- `src/ui/shortcuts.ts` — `d` / `shift+d` pre roll / prev

**Alternatíva zvažovaná a zamietnutá:** prerobiť `GenerateDialog` na DiceTray — príliš invazívne; radšej nový komponent, dialóg zostane pre "presné" generovanie.

### 2.5 Kontext / State management

`src/ui/DiceContext.tsx` (nový):

- `useState<DiceSession>` + `useMemo` preview (`generateLocalResult` — synchrónne, < 5 ms)
- `roll()` — čistá funkcia, žiadny async
- Perzistencia: `useEffect` → `localStorage`, restore pri mount-e
- Žiadny Yjs sync v1 — dice je lokálny nástroj; zdieľa sa až výsledný `Apply`

---

## 3. Plán implementácie (fázy)

### Fáza 0 — Príprava (0.5 dňa, bez UI)

- [ ] `src/shared/dice.ts` + `tests/dice.test.ts` (determinizmus: `nextSeed` chain, `seedAt`, `jitterControls` bounds)
- [ ] `src/intent/dice.ts` — `createDiceSession(intent, seed?)`, `rollSession(session): {session, previewPlan}`, `jumpSession`, `toggleLock`, helper `applyLocks(prevPattern, nextPattern, locks)`
- [ ] Nahraď `Math.random` v `GenerateDialog` / `AssistPanel` / `TopBar` za `nextSeed` (3× one-liner, žiadna zmena UX)

**Verifikácia:** `vitest run tests/dice.test.ts`, `tsc --noEmit`, existujúce `ai/*` testy stále zelené

### Fáza 1 — DiceTray MVP (1–1.5 dňa)

- [ ] `src/ui/DiceContext.tsx` — context + hook `useDice()`
- [ ] `src/ui/DiceTray.tsx` — ROLL, history strip (10–20 položiek, bez virtualizácie), seed display + copy, mode select, preview mini-grid
- [ ] Integrácia do `App.tsx` — tray pod `PatternBar` alebo ako collapsible panel (reuse `Panel` štýl)
- [ ] Hotkey `d` (roll) + `shift+d` (prev) cez `shortcuts.ts`
- [ ] `Apply` → `generatePatternCommand` / `assistVary` podľa mode

**Verifikácia:** manuálne 100 rollov, `vitest run --reporter=dot`, `vite build`

### Fáza 2 — Locky + Favorites (1 deň)

- [ ] `DiceLocks` UI (toggle chips) + logika `applyLocks` (kopíruj `rows[padId]` / `notes[trackId]` z `prevPattern` podľa role)
- [ ] Favorites ★ + filter "len favorites" v history stripe
- [ ] Perzistencia `localStorage` + restore
- [ ] Undo coalescing: 100 rollov = 0 undo entries, až `Apply` = 1 entry (už dnes `snapshot` delta)

**Verifikácia:** `tests/dice-locks.test.ts` — lock kick → kick rows identické naprieč rollmi

### Fáza 3 — Polish (0.5–1 deň, voliteľné)

- [ ] Micro režim (jitter controls slider)
- [ ] Style dice — tlačidlo 🎲 vedľa Style selectu v tray
- [ ] Export session — "Copy 100 seeds" / "Share dice link" (`?diceSeed=…&intentHash=…`)
- [ ] Telemetry v `Pattern.generation` — `diceSessionId`, `rollIndex` pre replay

**Celkom: ~3–4 dni** pre plný dice engine s lockami a históriou; MVP (fáza 0+1) za **1.5–2 dni**.

---

## 4. Alternatívy a prečo nie

| Alternatíva | Prečo nie |
|-------------|-----------|
| Rozšíriť `GenerateDialog` namiesto nového tray | Dialóg je modálny, blokuje audition; dice chceš mať stále po ruke pri prehrávaní |
| Ukladať `seedChain` do `ProjectDocument` / Yjs | Zbytočná perzistencia a sync overhead v1; dice je lokálny prieskum, zdieľa sa až výsledok |
| Menit `IntentSpec` pridaním `diceHistory` | Láme `INTENT_SCHEMA_VERSION`, migrácie, `pattern.generation.intent` bloat; session patrí do UI |
| Použiť `crypto.randomUUID` / `Math.random` pre dice | Stráca determinizmus — cieľ je replayovateľnosť |
| Generovať 100 patternov naraz (batch) | Pamäť/undo bloat; lazy roll po jednom s preview je rýchlejší a interaktívnejší |

---

## 5. Riziká a mitigácie

- **Preview drift** — ak preview a apply použijú iný plán → user počuje iné ako dostane. Mitigácia: obe cesty cez `planGeneration` + `generateLocalResultFromOptions` s rovnakým `intent+seed` (už dnes garantované).
- **Lock implementácia krehká** — kopírovanie rows/notes podľa role závisí od `padRoles` heuristiky. Mitigácia: lock na úrovni `subSeed` (nepregeneruj `drums.core` ak drums locked) je čistejšie než post-copy; v MVP stačí post-copy s testom.
- **Výkon 100 rollov** — `generatePattern` ~2–5 ms, 100 rollov lazy (po jednom) je v pohode; batch 100 naraz by bol ~300 ms — nerobíme.
- **Yjs collab konflikt** — dice session lokálna, apply ide cez `YDocStore.execute` → `applyProjectToYMap` diff, žiadny konflikt.

---

## 6. Rozhodnutia (schválené 2026-08-30)

1. **Kde má bývať Dice Tray?** → **Bottom dock panel `Dice`** (prepínateľný s `Arr/Mixer/FX/Mod/Midi`), plus malý quick `🎲` button pri `PatternBar` ktorý prepne dock na Dice.
2. **Čo má dice meniť defaultne?** → **Seed + style/temperature mikro-jitter** — default `jitter 0.3` (cítiť rozdiel), slider `0→1` v trayi, `0` = čistý seed.
3. **Lock granularita?** → **Pre-role (Drums/Bass/Chords/Lead) + Kick/Snare/Hats zvlášť** — dvojúrovňovo: `drums=true` ignoruje sub-locky; inak per-pad-family post-copy.
4. **História perzistovať medzi reloadmi?** → **Nie** — session-only `useState`, žiadny `localStorage`. Jednoduchšie, stačí pre flow "nahádž 100, vyber".
5. **Assist vs Full v dice?** → **Dve dices v jednom paneli** — `[🎲 FULL — nový pattern]` a `[🎲 VARY — mutácia aktívneho]` vedľa seba, zdieľajú seedChain/históriu/locky, líšia sa len cestou (`generatePattern` vs `assistVary`).

---

## 7. Súbory dotknuté (pre implementáciu)

- Nové: `src/shared/dice.ts`, `src/intent/dice.ts`, `src/ui/DiceTray.tsx`, `src/ui/DiceContext.tsx`, `tests/dice.test.ts`, `tests/dice-locks.test.ts`
- Upravované: `src/ui/GenerateDialog.tsx` (1 riadok dice), `src/ui/AssistPanel.tsx` (1 riadok dice), `src/ui/TopBar.tsx` (1 riadok dice), `src/ui/App.tsx` (mount tray + dock), `src/ui/PatternBar.tsx` (quick 🎲), `src/ui/shortcuts.ts` (hotkey `d`), `src/ui/context.ts` (export DiceContext)
- Nedotknuté: `src/intent/types.ts`, `src/ai/generator.ts`, `src/project-model/types.ts` (žiadna migrácia)

---

## 8. Aktualizovaný plán implementácie

### Fáza 0 — Jadro (0.5 dňa)
- `src/shared/dice.ts` + `tests/dice.test.ts` + `src/intent/dice.ts` (createDiceSession, rollSession, applyLocks, jitterControls, pickStyle)
- Nahradiť 3× `Math.random` za `nextSeed`

### Fáza 1 — DiceTray MVP (1–1.5 dňa)
- `src/ui/DiceContext.tsx` + `src/ui/DiceTray.tsx` — FULL/VARY dve dices, jitter slider, seed display, preview mini-grid, history strip 100, Apply → 1 undo
- Integrácia `App.tsx` bottom dock + `PatternBar` quick 🎲 + `shortcuts.ts` hotkey `d`

### Fáza 2 — Locky + Favorites (1 deň)
- Lock chips (Drums/Bass/Chords/Lead + Kick/Snare/Hats) + `applyLocks` post-copy + `tests/dice-locks.test.ts`
- Favorites ★ v history stripe

### Fáza 3 — Polish (voliteľné)
- Style dice vedľa Style selectu, export session, `diceSessionId` v `Pattern.generation`

*Plán schválený 2026-08-30, build spustený. MVP cieľ 1.5–2 dni.*
