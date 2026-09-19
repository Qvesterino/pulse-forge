# INTENT ENGINE — Master Map (živý dokument)

> Toto je centrálna mapa Intent Engine. Dokument sa bude priebežne dopĺňať.
> Veľký cieľ: **lokálna, offline "SUNO v prehliadači"** — používateľ (aj beatový
> analfabet) popíše zámer textom/klikmi a engine vyrobí kompletnú, kvalitnú
> hudbu: patterny, melódiu, aranžmán — bez cloudu, bez účtu, reprodukovateľne,
> s ONNX modelmi toľkými, koľko sa zmestí do browser budgetu.
>
> Súvisiace dokumenty: `docs/intent-engine-roadmap.md` (Fázy 0–5 hotové),
> `docs/intent-engine-ai-ranker-goal.md` (ONNX ranker goal), `VISION.md`.

---

## 1. Veľký obraz: tri vrstvy produktu

```text
[ PYTANIE ]                [ MOZEK ]                          [ VÝSLEDOK ]
Text / Dice / slidery  →  Intent Engine (tento dokument)  →  Pattern + aranžmán
"dark rolling techno      interpretuje zámer, generuje        → command/undo →
 at 140 with lead…"       kandidátov, rankuje ich             project model →
                          (heuristika + ONNX)                 audio engine
```

Filozofia (platí pre všetky budúce AI modely):

1. **Model nikdy negeneruje priamo do projektu.** Vždy vzniká *proposal*
   (návrh), ktorý prejde rovnakými bránami ako lokálny generator.
2. **Determinizmus je svätý.** Rovnaký seed + intent + verzie → rovnaký obsah
   (content hash). UUID sa nelíšia, obsah áno.
3. **Offline-first.** Chýbajúci model, timeout alebo zlý výstup sa vždy degraduje
   na deterministic fallback (heuristika), nikdy nepadá výnimka do UI/audio.
4. **Inferencia nikdy v audio callbacku.** Všetko ťažké beží vo Web Worker-i,
   načítava sa lazy, má timeouty a circuit breaker.

---

## 2. End-to-end pipeline (aktuálny stav)

```text
TEXT           "dark rolling techno at 140"        (src/intent/text-parser.ts)
  ↓ parseIntentText — keyword parser, EN (SK chýba → medzera)
UI (Dice/GenerateDialog/Assist)                      (src/ui/DiceContext.tsx …)
  ↓ IntentInput (čiastočné/nevierohodné dáta)
NORMALIZE      normalizeIntent()                    (src/intent/normalize.ts)
  ↓ clamp/defaults/validácia → IntentSpec (v1)
PLAN           planGeneration(intent, doc)          (src/intent/plan.ts)
  ↓ resolve seed/groove, sub-seedy, role plans, candidateSeeds
  ↓ mapIntentToOptions: energy/density/complexity/variation → engine parametre
  ↓ = GenerationPlan (pure, serializovateľný, zdieľaný preview+apply)
PROVIDER       LocalDeterministicProvider           (src/intent/providers/local.ts)
  ├─ SYNC  generateSync()  ← TOHTO POUŽÍVA CELÉ UI AJ PRÍKAZY DNES
  └─ ASYNC generate()     ← plná cesta s ONNX rankerom; zatiaľ len browser-smoke
       ↓ pre každý candidate seed (1..8):
       ↓   generatePattern(doc, options)             (src/ai/generator.ts)
       ↓   inspectPatternInvariants — hard gate      (src/ai/invariants.ts)
       ↓   repairGeneratedPattern — deterministic repair (src/intent/quality.ts)
       ↓   quality metrics (style distance, anchors, motif…)  (src/ai/quality.ts)
       ↓ RANKING: heuristic score → ONNX ranker (features.v1, worker) → final
       ↓ bez kandidátov: createFallbackPattern (vždy validný)
RESULT         GenerationResult { status, pattern, diagnostics, provider }
  ↓ statusy: accepted | repaired | fallback | rejected
COMMAND        generatePatternCommand / assist*     (src/commands/commands.ts)
  ↓ jeden undo snapshot; provenance sa zapisuje do pattern.generation
PERSIST        recipe + intent + intentHash + ranker metadata + content hash
```

---

## 3. Mapa súborov

### Jadro `src/intent/`

| Súbor | Riadky | Rola |
|---|---:|---|
| `types.ts` | 149 | **Kontrakty**: `IntentSpec` (v1), `GenerationPlan`, `GenerationResult`, `GenerationProvider`, statusy |
| `schema.ts` | 97 | `validateIntentSpec` / `assertIntentSpec` / `parseIntentSpec` — versionovaná validácia |
| `normalize.ts` | 136 | `normalizeIntent` — untrusted input → kanonický IntentSpec (clamps, defaults); `intentFromGenerateOptions` |
| `hash.ts` | 11 | `canonicalizeIntent` + `intentHash` (8 hex znakov) |
| `mapping.ts` | 98 | `mapIntentToOptions` — intent 4-slider → ghost/micro/velocity/temperature + `_dice*` hinty; `diceHints()` |
| `plan.ts` | 123 | `planGeneration` — pure plan: groove, sub-seedy (groove/drumsCore/drumsVariation/drumsMeta/melodyFallback/bass/chord/lead), rolePlans, resolvedBpm, candidateSeeds; `planRandomStreams()` |
| `pipeline.ts` | 43 | `generateLocalResult` / `generateLocalResultFromOptions` — sync zdieľaná cesta pre príkazy aj UI |
| `providers/local.ts` | 300+ | `LocalDeterministicProvider` — id `pulse-forge.local-groove`, verzia `correctness-1`; sync (heuristika) + async (ONNX ranker + symbolic prior merge) cesta, invariant gates (zdieľaný `evaluateCandidate`), repair, fallback |
| `providers/symbolic.ts` | ~190 | **`SymbolicPriorProvider`** (T2) — ONNX drum prior kandidáty do zdieľaného banku, seeded sampling, kick anchor floor, `source: "symbolic-prior"` |
| `candidate-bank.ts` | 54+ | dedup podľa content hash + heuristic score: `gateFit·0.4 + distanceFit·0.3 + anchorFit·0.2 + motifFit·0.1`; entries nesú `source: template\|symbolic-prior` |
| `quality.ts` | 278 | `repairGeneratedPattern`, `refreshPatternQuality`, `refreshPatternOutputHash`, `createFallbackPattern` |
| `text-parser.ts` | ~290 | `parseIntentText` v2 — EN frázy (genre/style/mood/trait/BPM range/key/bars/roles s negáciami) → IntentInput + `detected[]` |
| `arrangeWords.ts` | 403 | `parseArrangeIntent` + `applyArrangeOps` — NL aranžmán EDiting nad existujúcim beatom, **EN+SK synonymá**, jeden undo command |
| `dice.ts` | 204 | Dice session: seed chain (cap 100), locks (kick/snare/hats/kit/bass/chords/lead), favorites, full/vary mód, jitter, kit dice |

### AI stroj `src/ai/` (motor pod intent vrstvou)

| Súbor | Rola |
|---|---|
| `generator.ts` (266) | `generatePattern` — orchestrátor drums+bass+chords+lead; `resolveGrooveForGeneration`, `resolveEffectiveSeed` |
| `grooves/` (7 súborov) | Groove DSL knižnica: house (319), techno (287), trap (226), ambient (164), hybrid (220), melodic-data (354) — anchors, patterns, swing, style profily |
| `markov.ts` | Markov engine pre drum variations + melodic generáciu (s model cache) |
| `melodic.ts`, `phrase.ts`, `pad-roles.ts` | melodic roly (bass/chord/lead), multi-bar phrase plan (main/variation/drop/fill/outro), semantic pad roles |
| `quality.ts`, `style-quality.ts`, `evaluation.ts` | metriky kvality, style-distance gate, recipe/contentHash/canonicalizácia |
| `invariants.ts` | hard invarianty: pitch/duration/velocity/start, row shape, metadata, scale |
| `features/pattern-features.ts` | **features.v1** — 54 fixných features, poradie je contract, clamp 0..1, finite fallback, presence flags, featureHash |
| `ranking/*` | ONNX ranker: `ranker-types.ts` (manifest+worker API), `ranker-worker.ts` (ORT WASM), `ranker-client.ts` (lazzy worker, timeouty, circuit breaker), `rank-candidates.ts` (kombinácia heuristic+model) |
| `symbolic/prior-features.ts` | **prior-features.v1** (T2) — 44 fixných vstupov drum prioru; dataset skript importuje tento modul (žiadny drift) |
| `symbolic/melodic-features.ts` | **melodic-features.v1** (T2 v2) — 29 fixných vstupov next-note prioru + duration/contour triedy |
| `symbolic/prior-types.ts` / `prior-worker.ts` / `prior-client.ts` | ONNX prior runtime pre OBA modely (drums + melodic) — zrkadlo ranker vzoru (lazy worker, multi-session, hash verifikácia, timeouty, circuit breaker, flag `pf:symbolic-prior`) |
| `intent/favorites.ts` | favorites ledger (localStorage) + `favoritesToDrumSamples` konverter — lokálny feedback loop |
| `performance.ts` | latency harness (`npm run ai:performance`) |

### UI povrchy

| Súbor | Rola | Poznámka |
|---|---|---|
| `src/ui/IntentPanel.tsx` (119) | **TEXT → beat**: textarea, live detekcia keywordov, Ctrl+Enter generuje | volá `generatePattern` + `generatePatternCommand` — sync path, ONNX sa tu nedostane (pozri §7) |
| `src/ui/GenerateDialog.tsx` (424) | plný dialog: genre/style/slidery/seed/length/candidates | migr na IntentSpec hotový (Fáza 4) |
| `src/ui/DiceContext.tsx` (568) + `DiceTray.tsx` (514) | Dice: roll full/vary, seed history, locks, favorites, kit dice, score badge | sync preview ~0.5 s |
| `src/ui/AssistPanel.tsx` | chirurgické operácie (VARY/BUILD/FILL/REPLACE) nad rovnakým contractom | |

### Artefakty a tooling

| Vec | Detail |
|---|---|
| `public/models/intent-ranker-v1.onnx` | **25 338 B**, MLP 54→64→32→16→1, Gemm+Relu |
| `public/models/intent-ranker-v1.manifest.json` | ranker.v1, features.v1, norm.fixed.v1, input `features`, output `score`, sha256 hash, **goldenVerdict: ready-for-active** |
| `public/models/ort/` | ORT WASM binárky (`npm run ranker:ort-sync`) |
| `scripts/generate-intent-ranker-dataset.mts` | deterministický dataset (genre×style×seed matica) |
| `scripts/train-intent-ranker.py` | numpy RankNet (pairwise logistic loss, heuristic teacher) + ONNX export |
| `scripts/validate-intent-ranker.{py,mjs}` | inferenčná validácia (tvary, determinizmus, hash, <1 MB) |
| `scripts/generate-intent-ranker-golden.mts` + `render-golden-review-pack.mjs` | golden preferencie + audio review pack |
| `scripts/activate-intent-ranker.mjs` | `npm run ranker:activate` — flip shadow→active po golden gate |
| `public/models/symbolic-prior-v1.onnx` | **19.9 kB**, MLP 44→64→32→1, valAUC 0.916 |
| `public/models/symbolic-prior-v1.manifest.json` | prior.v1, prior-features.v1, sha256 hash + tréning report |
| `public/models/symbolic-melodic-v1.onnx` | **17.7 kB**, trunk 29→64→32 + 2 hlavy (degree 8 / duration 4) |
| `public/models/symbolic-melodic-v1.manifest.json` | melodic-prior.v1, melodic-features.v1, sha256 hash + report |
| `scripts/generate-symbolic-prior-dataset.mts` | deterministický dataset z groove knižnice (87 552 vzoriek; gitignore-nutý, regeneruje sa) |
| `scripts/train-symbolic-prior.py` | numpy MLP (weighted BCE, Adam) + ONNX export; `--favorites` pre weighted user vzorky |
| `scripts/validate-symbolic-prior.mjs` | ORT-web validácia (tvary, determinizmus, hash, <1 MB) |
| `scripts/generate-symbolic-melodic-dataset.mts` | next-note dataset z MELODIC_BY_GENRE (vrátane wrap-around) |
| `scripts/train-symbolic-melodic.py` | numpy dvojhlavý tréner (class-weighted CE) + ONNX export |
| `scripts/validate-symbolic-melodic.mjs` | ORT-web validácia oboch hláv |
| `scripts/export-favorites-training.mts` | favorites pack → weighted samples → retrain (`prior:favorites`) |
| `scripts/smoke-symbolic-prior.mts` | end-to-end smoke: reálne modely + reálne features + sampling (10 checks) |
| `package.json` | `ranker:train`, `ranker:golden`, `ranker:activate`, `ranker:ort-sync`, `prior:train`, `prior:melodic`, `prior:favorites` |

---

## 4. Kľúčové kontrakty

### IntentSpec v1 (normalizovaný, serializovateľný)

```ts
{
  version: 1,
  genre: "house" | "techno" | "trap" | "ambient",   // 4 žánre dnes
  style: string | null,        // napr. "rolling", "acid", "dark"…
  mood: string | null,         // "dark" | "aggressive" | "chill" | …
  energy: 0..1,                // default 0.7  → velocityVariation + ghost boost
  density: 0..1,               // default 0.5  → ghostWeight + hustota
  complexity: 0..1,            // default 0.5  → microWeight + temperature
  variation: 0..1,             // default 0.3  → temperature + bar variation
  seed: string (≤128 znakov),
  key: MusicalKey | null,
  bpmRange: [lo, hi] | null,   // 20..300, resolvedBpm = midpoint v range groove
  length: 16|32|…|256,         // násobky 16
  candidateCount: 1..8,
  roles: ["drums","bass","chords","lead"],
  targetTracks: { drumTrackId, instrumentTrackIds },
  constraints: { preserveAnchors, allowGhosts, allowSwing },
  controls: { ghostWeight, microWeight, velocityVariation, temperature 0.2..2 },
  sourcePatternId,             // pre VARY (content-hash seed derivácia)
  replaceMode: "new" | "replace",
  applyGrooveSettings: boolean
}
```

Rozdelenie zodpovedností: **user zámer** (energy/density/…/mood) vs.
**engine parametre** (`controls`, `GenerationPlan.options`) — zámerne oddelené,
mapping je čistá funkcia `mapIntentToOptions` s fast-path (default intent =
nezmenené options → golden rendery ostávajú stabilné).

### GenerationPlan / Result

- Plan = intent + resolved groove + `effectiveSeed` + `inputContentHash` +
  `intentHash` + 8 pomenovaných sub-seedov (izolované RNG streamy — drum random
  nikdy nemôže ovplyvniť melódiu) + rolePlans + `candidateSeeds` + recipe.
- Result statusy: `accepted` (prišiel invariant gate) / `repaired` (repair pass
  ho zachránil) / `fallback` (bezpečný groove template) / `rejected`.
- Provenance v `pattern.generation`: recipe, intent snapshot, intentHash,
  resolvedBpm, candidateCount, `ranker {featureVersion, rankerVersion, modelHash,
  selectedIndex, mode, source}`, quality metriky, outputContentHash.

### GenerationProvider (budúca AI boundary, Fáza 6 — OTVORENÁ)

```ts
interface GenerationProvider {
  id: string; version: string; capabilities: readonly string[];
  generate(plan, context, signal?): Promise<GenerationProposal>;
}
```

`LocalDeterministicProvider` je jediná implementácia. Remote/neural providery
sa pripojať ako *proposal source* — žiadne priame mutácie projektu.

---

## 5. AI modely — stav

### 5.1 ONNX ranker v1 (kandidáty)

- **Features.v1**: 54 čísel popisujúcich kandidáta — intent fit, drum štruktúra
  (hustota, anchors, syncopation, ghost ratio…), melodic štruktúra a motívy,
  hudobná validita, candidate-relative odchýlky, presence flags. Pevné poradie =
  contract; zmena vyžaduje novú feature version.
- **Model**: MLP 54→64→32→16→1, sigmoid normalizácia, round 4 decimálne miesta
  pred stable sortom. 25 kB. Trénovaný ako RankNet na heuristic teacher signále;
  golden gate prešiel (`goldenPairwiseAccuracy: 1.0`, verdict ready-for-active).
- **Worker**: `onnxruntime-web/wasm`, single-threaded, `env.wasm.wasmBinary`
  fetchnutý z `/models/ort/`, session cache, SHA-256 verifikácia modelu proti
  manifestu. Timeouty: score 400 ms, load 3 s, manifest 1.5 s. Circuit breaker:
  3 zlyhania → worker vypnutý na session. Všetky chyby = kontrolovaný fallback.
- **Režimy**: `off | shadow | active`, flag `localStorage["pf:intent-ranker"]`,
  default **active** (po golden gate).
- **Kombinácia (active)**: `finalScore = 0.6·heuristic + 0.4·model`, stable sort
  (score desc → candidateIndex asc → contentHash asc). Hard gate má vždy
  prioritu — model vidí len validných kandidátov.
- **Zapojenie (T1, hotové)**: kanonický interaktívny vstup je
  `generateAsyncResult()` (`src/intent/pipeline.ts`) — preview aj apply idú
  cez ňu; apply commituje presne previewovaný `GenerationResult` cez
  `applyGenerationResultCommand` (žiadna regenerácia, abort/supersede chránené).
  Sync `generateLocalResult` ostáva len pre single-candidate toky (Dice),
  priame generate-and-apply toky (AI Flip) a offline tooling.

### 5.2 Symbolic drum prior v1 (T2 — druhý generujúci zdroj, HOTOVÉ)

Malý natrénovaný ONNX prior nad groove knižnicou: naučená distribúcia
P(hit | style, role, pozícia), z ktorej provider sampluje **nové** drum gridy,
ktoré sú štýlovo konzistentné, ale nie sú kópie templateov.

- **Kontrakt**: `prior-features.v1` (`src/ai/symbolic/prior-features.ts`) —
  44 vstupov: genre one-hot (4) + style one-hot (21 groove ids) + pad role
  one-hot (9) + pozícia v takte (5) + pozícia v frame (3) + flags (2).
  Dataset skript IMPORTUJE tento modul → layout nemôže driftovať; test stráži,
  že style vocab == GROOVE_LIBRARY.
- **Model**: `public/models/symbolic-prior-v1.onnx`, MLP 44→64→32→1 (Gemm+Relu),
  **19.9 kB**, sha256 v manifeste. Tréning: `npm run prior:train`
  (dataset z groove knižnice → numpy RankNet-style tréner s class weighting
  pos_weight≈11 → ONNX export → ORT-web validácia). Metriky v1:
  **valAUC 0.916** (held-out groove#pattern skupiny), 87 552 vzoriek.
- **Worker/client**: `prior-worker.ts` + `prior-client.ts` — zrkadlo ranker
  vzoru (lazy ORT WASM, hash verifikácia, timeouty run 500 ms/load 3 s,
  circuit breaker 3, flag `localStorage["pf:symbolic-prior"]` on|off).
- **Provider**: `SymbolicPriorProvider` (`src/intent/providers/symbolic.ts`),
  id `pulse-forge.symbolic-prior` v `prior.v1`. Sampling: seeded
  `forkRandom(seed|drums.neural)` okolo naučených pravdepodobností,
  density/energy ako runtime gainy (model je čistá štýl×rola×pozícia
  distribúcia), kick downbeat floor pri `preserveAnchors`. Melodic parts
  generuje existujúci melodic engine **bez bubnov** (adaptujú sa na prior grid).
- **Rovnaké brány**: prior kandidáty vstupujú do TIEHOŽ candidate banku ako
  template kandidáty (`source: "symbolic-prior"`), prechádzajú tými istými
  invariantmi, repairom aj heuristickým + ONNX rankingom. Zlyhanie prioru iba
  ZMENŠÍ bank — nikdy nezablokuje generáciu.
- **IntentSpec**: `symbolicCandidates?: number` (0..4, default 0 — sync path
  a golden baselines sa nemenia). IntentPanel "ťahák" posiela 2.
- **Overenie**: `scripts/smoke-symbolic-prior.mts` (reálny model + reálne
  features): house 4/4 kick 0.69–0.86, trap rozbitý kick (downbeat 0.95,
  off-quarter 0.23 vs house 0.79), sampling deterministický — 10/10 PASS
  (vrátane melodic prioru, §5.3).

### 5.3 Symbolic melodic prior v1 (T2 v2 — next-note model, HOTOVÉ)

Melódiu neplánujeme ako mriežku hitov, ale ako **sekvenciu not**: model je
next-note prediktor — "given žáner, rola, rytmická pozícia, predchádzajúca
nota (degree + duration) a kontúra, čo príde ďalej?"

- **Kontrakt**: `melodic-features.v1`
  (`src/ai/symbolic/melodic-features.ts`) — 29 vstupov: genre (4) + rola
  (bass/chord/lead) + pozícia štartu v takte (5) + prev degree one-hot
  (rest + 0..6) + prev duration one-hot (1/2/4/8) + kontúra (5 tried).
  Dve hlavy: **degree 8-tried** (rest + stupnice 0..6) a **duration 4-tried**.
- **Key-safe by construction**: stupne sú scale-relatívne; provider mapuje
  degree → pitch cez ten istý math ako template engine (exportované
  `degreeToPitch`/`expandChord` z `src/ai/melodic.ts` + `snapToScale`). Akýkoľvek
  samplovaný ton je v tónine, aj pri custom key.
- **Model**: `public/models/symbolic-melodic-v1.onnx`, **17.7 kB**, dve hlavy.
  Tréning: `npm run prior:melodic` (dataset z MELODIC_BY_GENRE vrátane
  wrap-around prechodov → class-weighted CE na oboch hlavách → ONNX).
  Metriky v1: **valDegreeAcc 0.714** (majority baseline 0.370),
  **valDurationAcc 0.607** (baseline 0.469), 190 vzoriek / 27 skupín —
  malý dataset je úprimnýlimit: model interpoluje knižnicu, favorites ho
  naučia viac.
- **Provider**: `SymbolicPriorProvider` v2 — pri dostupnom modeli NAHRADZuje
  template melódiu prior-samplovanými notami (autoregresívne po rolách,
  roly bežia paralelne; `controls.temperature` tvaruje distribúcie).
  Pri nedostupnom modeli ostáva template melódia — zmena len zmäkne, nikdy
  nezablokuje. Chord rola sa expanduje cez existujúce voicings.
- **Overenie**: smoke 10/10 — house classic bass odpočíva po koreni na
  off-and (P(rest|step2,prev=root)=1.00), preferuje osminové noty (P=1.00),
  žánre sa diferencujú. Testy: `tests/symbolic-melodic.test.ts` (7).

### 5.4 Favorites feedback loop (T2 v2 — učenie z tvojich roliek, HOTOVÉ)

- **Ledger**: `src/intent/favorites.ts` + `localStorage["pf:intent-favorites"]`
  — ★-nutie previewovanej rolky v Dice uloží intent + drum content (cap 200,
  dedupe, best-effort storage). Nič neopúšťa stroj.
- **Export**: tlačidlo "⬇ ★" v dice tray stiahne pack JSON
  (`pulse-forge-favorites-<dátum>.json`).
- **Retrain**: `npm run prior:favorites -- <pack.json>` skonvertuje pack cez
  zdieľaný konverter (`favoritesToDrumSamples`, rovnaký features kontrakt →
  žiadny drift) a spustí `train-symbolic-prior.py --favorites` — weighted
  vzorky (weight 3) vstupujú LEN do train splitu (validácia ostáva
  library-only), pretrénuje a validuje drum prior.
- **Overené end-to-end**: syntetický pack 3 entry → 768 weighted vzoriek →
  2 304 tréningových riadkov → nový model hash (valAUC 0.918); čistý
  library-only model bol po dôkaze obnovený.
- Testy: `tests/favorites-ledger.test.ts` (7).

---

## 6. Kvalita, testy, determinizmus

- **Testy**: `tests/intent-pipeline.test.ts`, `intent-async-pipeline.test.ts`,
  `intent-async-fallback.test.ts`, `intent-mapping.test.ts`,
  `intent-binding.test.ts`, `intent-text-parser.test.ts` (parser v2),
  `symbolic-prior.test.ts` (drum prior provider, stub inferencia),
  `symbolic-melodic.test.ts` (melodic prior provider + key-safe noty),
  `favorites-ledger.test.ts` (ledger + konverter),
  `tests/intent/arrangeWords.test.ts`, `dice.test.ts`,
  `dice-subseed.test.ts`, `dice-locks.test.ts`, `ranker-client.test.ts`,
  `ranker-active.test.ts`, `pattern-features.test.ts`, golden baselines
  (`tests/ai-baseline.test.ts`, 8 genre/style kombinácií × 16/32/64 krokov),
  quality gates, render-event parity, browser verification
  (`scripts/verify-browser.mjs` — offline generation flow PASS).
- **Perf budget**: UI preview ≤ 250 ms synchronne (16/32/64 krokov merané,
  `npm run ai:performance`). Worker boundary pre väčšie generácie = otvorený
  follow-up.
- **Determinizmus**: `hashString`/`mulberry32`, forkRandom sub-seedy, content
  hash bez UUID, engine version `correctness-1` v golden fixtures.

---

## 7. Gap analýza voči cieľu "local SUNO"

### 7.1 Zapojenie (pôvodné medzery — zatvorené)

1. ~~**ONNX ranker nie je na interaktívnej ceste.**~~ **HOTOVÉ (T1):**
   `generateAsyncResult()` je kanonický vstup; IntentPanel aj GenerateDialog
   cez neho idú; apply commituje previewovaný výsledok; abort/supersede
   chránené; testy `intent-async-pipeline` / `intent-async-fallback`.
2. ~~**IntentPanel generuje dvakrát.**~~ **HOTOVÉ:** panel iba orchestruje
   (parse → generateAsyncResult → applyGenerationResultCommand).
3. ~~**Sync path = vždy heuristika.**~~ **Vyriešené rozdelením zodpovedností:**
   sync ostáva len pre single-candidate toky (Dice — tam je to provable no-op)
   a offline tooling; všetky preview/apply toky idú async.

### 7.2 Schopnostné medzery voči SUNO

| Oblast | Dnes | Chýba do SUNO-tieru |
|---|---|---|
| Text understanding | **parser v2 (EN)**: frázy, BPM range, key (flats→sharps, minor default), moods, bars, roly s negáciami | SK jazyk; embedding-based porozumenie (T1 krok 2) |
| Žánre/style | 4 žánre + 21 groove štýlov v prior vocab | desiatky štýlov; style embeddingy namiesto ručných keyword map |
| Generatívny model | template anchors + constrained Markov **+ ONNX symbolic prior v1 (drums)** | prior v2: melodic role, učenie z favoritov, väčší dataset |
| Štruktúra pesničky | phrase plan na úrovni patternu (16–256 krokov) + `arrangeWords`/autoArrange | dlhý form (intro→build→drop→break→outro), section-aware generácia, transition fill |
| Audio dimenzia | sample kity, grooves; žiadne audio AI | audio embeddingy (tagovanie sample lib, audio ranker rendered výstupu) |
| Vocals | — | v prehliadači realisticky až neskôr (pozri §8 T5) |
| Feedback loop | ranker trénovaný na heuristic teacher + golden gate prešiel | učenie z používateľských preferencií (dice favorites → golden dataset) |

---

## 8. Roadmapa: ONNX expanzia (návrh tierov)

> Zásady z §1 platia pre každý model: manifest + SHA-256, lazy worker, timeouty,
> kontrolovaný fallback, proposal-only, žiadna inferencia v audio callbacku.
> Veľkosti sú hrubé odhady pre int8/wasm; potvrdiť meraním.

### T0 — existujúce (hotové)
- intent-ranker v1 (25 kB, WASM, active) — pattern kandidáty.

### T1 — Zapojenie a prehĺbenie porozumenia zámeru — ✅ HOTOVÉ (2026-09-19)
1. ~~**Async ranker path do UI**~~ — hotové: `generateAsyncResult()` +
   preview==apply cez `applyGenerationResultCommand`.
2. **Intent parser v2 (EN)** — hotové: frázy, BPM range, key, mood, bars,
   roly s negáciami (`tests/intent-text-parser.test.ts`, 12 testov).
   Ostáva: SK jazyk + embedding-based understanding (krok 2).
3. **features.v2 + ranker v2**: viac kandidátov (8→16?), učenie z dice favorites.
   *(otvorené)*

### T2 — Symbolická generácia — ✅ v1 aj v2 HOTOVÉ (2026-09-19)
- **v1**: symbolic drum prior (44→64→32→1, 19.9 kB, valAUC 0.916) — detail §5.2.
- **v2**: melodic next-note prior (29→64→32→{8,4}, 17.7 kB) + favorites
  feedback loop — detail §5.3, §5.4.
- v3 návrhy: prior podmienený embeddingom namiesto one-hot vocab, väčší
  tréningový korpus (public-domain MIDI), pairwise preference head učený
  priamo z favoritov (A > B), melodic prior trénovaný aj z favoritov.

### T3 — Štruktúra a dlhá forma
- Section planner (song form) ako model alebo rozšírený phrase plan;
  aranžmán cez `arrangeWords`/scenes; transition/fill model medzi sekciami.

### T4 — Audio dimenzia
- Audio embedding model (YAMNet/CLAP-audio tier, ~10–60 MB int8) nad sample
  library: tagovanie, "najdi sample do tohto kitu", audio ranker nad
  vyrenderovaným výstupom (goal-dokument to explicitne spomína ako neskorší
  experiment).

### T5 — Neural audio syntéza / vocals (ďaleký horizont)
- Textúry/one-shot syntéza (RAVE/DDSP-tier) cez WebGPU EP — veľké modely,
  vlastný budget, pravdepodobne iba na desktop prehliadačoch. Vocals: REALISTICKY
  mimo browser krátkodobo; náhrada: sample-based formant tricks / deferral.

### Budget rámec (odhad, potvrdiť meraním)

| Tier | Model | Veľkosť | Runtime | Spustenie |
|---|---|---:|---|---|
| T0 | ranker v1 | 25 kB | ORT WASM (worker) | lazy, po generácii |
| T1 | text encoder | ~20–90 MB | ORT WASM/WebGPU (worker) | lazy po 1. textovom zámere |
| T2 | symbolic decoder | ~5–30 MB | ORT WASM/WebGPU (worker) | lazy, len na požiadanie |
| T4 | audio encoder | ~10–60 MB | ORT WASM (worker) | lazy pri Sample browsery |

Spoločné: manifest + hash pre každý model, cache v `public/models/`, prípadne
IndexedDB/Cache API cache po prvom stiahnutí, PWA precache len pre T0.

---

## 9. Pravidlá, ktoré prežijú expanziu (invarianty architektúry)

- [ ] Každý AI model = proposal source; aplikuje sa až cez command systém (1 undo krok).
- [ ] Invarianty (`inspectPatternInvariants`) sú nadradené každému modelu.
- [ ] Chýbajúci/zlyhaný model = deterministic fallback, nikdy výnimka v UI/audio.
- [ ] Rovnaký seed + intent + verzie engine/modelu → rovnaký obsah; provenance
      pravdivo hovorí, čo model sa na výsledku podieľal.
- [ ] Inferencia mimo audio callbacku a mimo UI hot path (worker + timeouty).
- [ ] Feature/manifest zmeny = nová verzia, nie in-place edit.
- [ ] Zmena výsledku = očakávaná zmena engine/model verzie alebo regresia
      (golden fixtures to zachytia).

## 10. Otvorené otázky

1. Kedy preskočiť sync→async path úplne (aj v príkazoch), aby preview==apply?
2. Kam uložiť väčšie modely: `public/models/` vs. Cache API on-demand?
3. Text encoder: ktorý konkrétny multilingual model sa zmestí do budgetu
   (SK jazyk!) a ako trénovať head-y bez veľkého datasetu?
4. Učenie z favoritov: ako zbierať pairwise preferencie bez cloudu (lokálny
   export datasetu / opt-in telemetry)?
5. Vocals: deferm, alebo skúsiť sample-hybrid skoro?

---

*Posledná úplná revízia mapy: 2026-09-19 (T1 overený, parser v2, drum prior v1,
melodic prior v1 + favorites feedback loop). Dokument sa dopĺňa pri každej
zmene Intent Engine; fakty boli overené čítaním zdrojov uvedených v §3.*
