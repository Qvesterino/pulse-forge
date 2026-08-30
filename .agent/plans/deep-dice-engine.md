# Deep Dice Engine — Killer #1 Feature Plan

> Prejsť z “seed randomizéra” na **intent-driven generatívny engine** kde každý hod je muzikálne zmysluplný, nie len náhodný. Cieľ: 100 hodov = 100 použiteľných nápadov, nie 10 použiteľných + 90 odpadu.

---

## 1. Prečo musí byť #1

Súčasný DAW má 883–1029 testov, 6 template, Markov drums + groove knižnicu — solídne, ale **generátor je “black box seed → pattern”**. V dobe kde Suno/Udio/Suno generujú celé tracky za 10s musí Pulse Forge vyhrať na **kontrole + rýchlosti iterácie**: “držím štýl, mením vibe po kliknutí, lockujem kick, do 10 sekúnd mám beat ktorý by som ručne programoval 20 min”.

MVP dice (Fáza 0–2) dal: deterministický chain, jitter, locky post-copy, history. **Chýba mu hĺbka:**
- `energy/density/complexity/variation` v `IntentSpec` skoro neovplyvnia `generateDrumPattern` (len `ghost/micro/temp`).
- Lock = kopírovanie rows po generácii, nie podmienené generovanie → hats nevedia že kick ostal.
- Kit a groove mimo dice.
- Žiadne skóre — 100 hodov musíš ručne ohodnotiť uchom.
- Žiadny zvukový náhľad bez commit.

Tento plán to rieši v 4 fázach, bez breaking migrácie `ProjectDocument`.

---

## 2. Architektúra — čo sa zmení

```
IntentSpec (energy/density/complexity/variation + ghost/micro/temp + genre/style/key)
   │
   ├─► planGeneration() ──► resolveEffectiveSeed + generationSeed
   │        │
   │        └─► diceIntentMapping(intent) ──► GenerateOptions (density→hitCount, energy→vel, complexity→syncopation, variation→temp)
   │
   ├─► kitResolve(intent.kitId / forkRandom) ──► padNames + kitColors
   │
   └─► grooveResolve(genre/style/seed) ──► GrooveData (swing)
          │
          ▼
   generatePattern(doc, options, diceLocks?)
          │
          ├─► forkRandom(generationSeed, "drums.core")     ──► Markov per pad, ALE podmienený lockami
          ├─► forkRandom(..., "drums.variation")            ──► bar variation, ghost, fill
          ├─► forkRandom(..., "drums.meta")                 ──► micro/prob/ratchet
          └─► forkRandom(..., "melody.*")                   ──► bass/chord/lead
          │
          ├─► scoring (anchorCoverage, syncopation, motif, styleDistance)
          └─► audiblePreview (ghost scheduler, no commit)
```

**Princíp:** `IntentSpec` je jediný vstup; dice mení len `seed + jitter`; všetko ostatné je deterministické odvodenie. Žiadne `Math.random` mimo `forkRandom`.

---

## 3. Fázy

### Fáza A — Intent→Engine mapovanie (killer jadro, 1–1.5d)

**Cieľ:** `energy/density/complexity/variation` reálne formujú beat.

**Súbory:**
- Nový `src/intent/mapping.ts` — `diceIntentMapping(intent, jitter): GenerateOptions`:
  - `density (0..1) → targetHitCount` — riedky (0.2 = 6 hits/bar) → hustý (0.9 = 14 hits/bar). V `generateDrumPattern` pridaj `pruneOrDensify(rows, targetHitCount, rand)` po Markovu.
  - `energy (0..1) → velocityVariation + ghostWeight boost` — `energy 0.9` = `velVar +0.2`, `ghost +0.1`; `0.2` = utlmené, menej ghost.
  - `complexity (0..1) → syncopation budget + ratchet chance` — `complexity 0.9` uvoľní `enforceSyncopationBudget` (viac off-beat), `canRatchet` chance 0.04 → 0.12.
  - `variation (0..1) → temperature + bar variation chance` — `0.15 → 0.30` v `generateDrumPattern` bar-loop.
  - `mood (string|null)` → mapuj na `ghostMultiplier` tweak ak je napr. `"dark"`, `"aggressive"` (voliteľné, slovník).
- Úprava `src/intent/dice.ts` — `jitteredIntentForSeed` po novom volá `diceIntentMapping` a `jitterControls` s `amount=jitter`.
- Úprava `src/ai/drums.ts` — pridaj `pruneOrDensify`, zmeň `addGhostNotes` a `addStepMeta` aby akceptovali odvodené váhy, nie len `options.ghostWeight` z `GenerateOptions` ale odvodené z intent.
- Úprava `src/intent/plan.ts` / `generateOptionsFromIntent` — nech prechádza cez mapping.

**Verifikácia:**
- `tests/intent-mapping.test.ts` — density 0.2 vs 0.9 → hitCount delta ≥ 4; energy 0.2 vs 0.9 → avg velocity delta; complexity → syncopation delta.
- Existujúce `ai/*` testy zelené (mapping je opt-in, default intent → default mapping = staré hodnoty).

### Fáza B — SubSeed podmienené locky (1d)

**Cieľ:** Lock ≠ kopírovanie; lock = “negeneruj túto rodinu”.

**Súbory:**
- `src/ai/generator.ts` — `generatePattern(doc, options, locks?: DiceLocks)` — ak `locks.kick`, preskoč generovanie pre `padIndices` patriace kicks (z `classifyPads` + `padNames`), namiesto toho vezmi `prevPattern.rows[kickPadId]` (prev musí byť dodaný — `options.sourcePatternId` už nesie `inputContentHash`, reuse). Potrebuje `prevPattern` param alebo ho vie načítať z `doc` via `doc.patterns.find(p=>p.id===options.sourcePatternId)`. Pre Dice FULL s lockami nastav `sourcePatternId = activePatternId` automaticky.
- `src/intent/dice.ts` — `applyDiceLocks` sa stane tenkou vrstvou; skutočné locky sa dejú v generátore (zachová `subSeed` pre zamknuté pady). Ponechaj post-copy ako fallback pre rýchly preview keď `prev` nie je k dispozícii.
- `src/ai/drums.ts` — `generateDrumPattern` dostane `lockedPadIndices: Set<number>` — pre tie preskočí Markov, len skopíruje `prevRows`.

**Alternatíva zamietnutá:** Udržať post-copy — funguje, ale hats/kick korelácia chýba. SubSeed je čistejšie a testovateľné.

**Verifikácia:**
- `tests/dice-subseed.test.ts` — lock kick → kick rows identické, hat rows rôzne, ale hat pattern rešpektuje kick anchor (anchorCoverage nepadne).

### Fáza C — Kit-aware + Groove-aware dice (0.75d)

**Kit-aware:**
- `IntentSpec` už má `targetTracks`; pridaj `kitId?: string` (alebo `kitSeed?: string`) — voliteľné, bez migrácie: ak chýba, ber `doc.tracks.find(drum).kitId` ako default. `normalizeIntent` ho povolí ako `string|null`.
- `src/intent/mapping.ts` — `resolveKit(intent, seed)` — `forkRandom(seed, "dice.kit")` vyberie kit zo `src/project-model/kit-presets.ts` (alebo len zamieša pad sampleIds v rámci drum tracku).
- `DiceTray` — select `KIT` vedľa `GENRE` (alebo 🎲 vedľa kitu).

**Groove-aware:**
- `src/intent/dice.ts` — `jitteredIntentForSeed` už jitteruje `style`; pridaj `swingJitter` — `forkRandom(seed,"dice.swing") → swing ±0.2* jitter`, ulož do `controls` alebo priamo do `intent` (nové pole `grooveSwing?: number` voliteľné). `generateDrumPattern` už má `streams.swing` — prepoj.
- `DiceTray` — slider `SWING` alebo aspoň lock `Swing`.

**Verifikácia:** `tests/kit-dice.test.ts` — rovnaký seed + iný kit → iné `padIdMap` rows, ale rovnaký rytmický skeleton (groove id rovnaké).

### Fáza D — Scoring + Audible preview + Melodic dice (1d)

**Scoring (auto-ranking):**
- Reuse `measureDrumQuality` + `evaluateStyleDistance` už v `generatePattern`. V `DiceContext` preview vyrátaj composite score `0..100`:
  ```
  score = 40*anchorCoverage + 30*(1-styleDistance) + 15*syncopationNorm + 15*melodicMotif
  ```
  History dot farba: zelená `>75`, žltá `50-75`, sivá `<50`. Top 3 zvýrazni. Pridaj `Sort by score` toggle.
- Žiadny nový engine, len agregácia.

**Audible preview:**
- `DiceTray` tlačidlo `▶ Preview` — použije `services.scheduler` / `AudioEngine` na prehratie ghost patternu (nie `doc`!) v loope 1 bar bez commit. Implementuj ako `previewTransport` s `AudioContext` — prehraje `preview.fullPattern.proposal.pattern` rows cez `drumHitsInWindow` bez zápisu. `Stop` na ďalší roll alebo `Apply`.
- Najväčší UX win, ale vyžaduje audio plumbing — preto až po jadre.

**Melodic dice:**
- `DiceTray` doplň preview riadky pre bass/chords/lead (už máš `notesRecord` v patterne). `MiniPreview` zobraz aj klavírne notes (piano roll mini). Locky `Bass/Chords/Lead` už fungujú — pridaj jitter pre melodickú `temperature`/`density`.

**Verifikácia:** manuálne + `tests/dice-scoring.test.ts` — score deterministické, ranking stabilný na rovnakom seede.

---

## 4. Súbory dotknuté

- Nové: `src/intent/mapping.ts`, `tests/intent-mapping.test.ts`, `tests/dice-subseed.test.ts`, `tests/kit-dice.test.ts`, `tests/dice-scoring.test.ts`
- Upravované: `src/intent/dice.ts`, `src/intent/plan.ts`, `src/intent/normalize.ts` (kitId), `src/intent/types.ts` (voliteľné kitId), `src/ai/generator.ts` (locks param), `src/ai/drums.ts` (pruneOrDensify, lockedPadIndices), `src/ui/DiceTray.tsx`, `src/ui/DiceContext.tsx`, `src/project-model/kit-presets.ts` (ak kit-aware)
- Nedotknuté (v1): `src/project-model/schema.ts` (žiadna DB migrácia), `src/collab/*`, `src/persistence/*`

**Celkom ~3.5–4.5d** pre kompletný deep engine. Samotná Fáza A (intent mapping) dá 60% “killer pocitu” za 1.5d.

---

## 5. Riziká a mitigácie

- **Mapovanie rozbije existujúce patterne** — mitigácia: `diceIntentMapping` má `if (intent.energy===0.7 && intent.density===0.5 /* default */) return baseOptions` fast-path → default intent = staré správanie; test `golden-render` chráni.
- **SubSeed lock vyžaduje prevPattern** — ak chýba (prvý pattern), fallback na post-copy.
- **Kit zmena mimo undo** — preview kit nesmie mutovať `doc`; len `preview.rows` s inými sampleIds.
- **Audible preview kolízia s transportom** — ghost scheduler musí bežať na samostatnom `AudioContext` gain 0.3, stopne sa na `Apply` / roll.

---

## 6. Otvorené otázky

1. Má `density` ovplyvniť aj melodiku (počet notes), alebo len drums?
2. Kit-aware: má dice meniť celý kit (sample set), alebo len per-pad sample v rámci kitu?
3. Scoring: chceš aj “like/dislike” tréning (uložiť obľúbené a nabudúce preferovať podobné), alebo stačí statické skóre?

*Plán pripravený 2026-08-30. Ďalší krok: schváľ a spúšťame Fázu A.*
