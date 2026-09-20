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
| `pipeline.ts` | 200+ | `generateAsyncResult` (kanonický async vstup, `includeBank`), `resultForCandidate` (A1), sync fast path |
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
| `intent/favorites.ts` | favorites ledger v2 (localStorage) + konvertory: `favoritesToDrumSamples`, `favoritesToMelodicSamples` (pitch→degree cez key) — lokálny feedback loop pre všetky tri modely |
| `intent/audition.ts` | **A1 candidate audition** — offline render kandidáta (dočasný dokument, mode pattern) + zdieľaný AudioContext playback |
| `intent/song.ts` | **A2 song builder** — per-žáner formy, role-aware delty, `buildSong()` (async + progress) a `applySongCommand` (1 undo) |
| `intent/mix.ts` | **D1 intent → mix chain** — profil plánovač (tone/punch/space/pump) + `applyMixIntent` (1 undo, clamp proti defs) |
| `intent/route.ts` | **D3 unified router** — mix parser + `routeIntentText` (arrange → mix → pattern) |
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
| `scripts/export-favorites-training.mts` | favorites pack → retrain VŠETKÝCH troch modelov (`favorites:retrain` / alias `prior:favorites`) |
| `scripts/generate-intent-ranker-favorites.mts` | C2: pack → preferenčné skupiny pre ranker (favorit=winner, súrodenci=alternatívy, features.v1) |
| `scripts/smoke-symbolic-prior.mts` | end-to-end smoke: reálne modely + reálne features + sampling (10 checks) |
| `package.json` | `ranker:train`, `ranker:golden`, `ranker:activate`, `ranker:ort-sync`, `prior:train`, `prior:melodic`, `favorites:retrain` |

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
  default **shadow** (aktívny stav čaká na nezávislý golden holdout —
  pozri activation status nižšie).
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
- **Retrain (C1+C2, jeden príkaz)**: `npm run favorites:retrain -- <pack.json>`
  pretrénuje VŠETKY TRI naučené modely z jedného packu:
  1. **Drum prior** — pack → weighted per-step vzorky (`favoritesToDrumSamples`)
     → `train-symbolic-prior.py --favorites` (train-only, validácia library-only).
  2. **Melodic prior** — pack → weighted next-note vzorky
     (`favoritesToMelodicSamples`: pitch→degree cez zaznamenaný key + rolový
     octave offset, chord voicings sa zrútia na root) →
     `train-symbolic-melodic.py --favorites`. Pack bez melodic obsahu = krok skip.
  3. **Ranker** — pack → **preferenčné skupiny** (`buildFavoriteRankerGroups`):
     favorit = winner (label 1.0), 3 rovnaké-intent súrodenci s odvodenými
     seedmi = alternatívy, features.v1 cez reálny pipeline →
     `train-intent-ranker.py --favorites` (train-only, oversample ×3,
     validácia ostáva teacher-labeled). Toto je C2: selection sa učí
     PREFERENCIE, nielen heuristic teacher.
- **Ledger v2**: entry nesie aj `length, style, controls (ghost/micro/velocity/
  temperature), key, melodic[]` (C1 cap 128 not) — plná rekonštrukčná vernosť
  pre všetky tri retrainty; v1 packy ostávajú validné (polia optional).
- **Overené end-to-end**: syntetický pack (3 entry + melodic) → drum 2 304
  weighted vzoriek (valAUC 0.918) + melodic 108 weighted vzoriek + ranker 3
  preferenčné skupiny (golden verdict ready-for-active) → všetky tri modely
  nový hash → po dôkaze obnovené pôvodné artifacty (hashy overené validátormi).
- Testy: `tests/favorites-ledger.test.ts` (11 — ledger v2, drum konverzia,
  melodic pitch→degree inverzia, chord-root zrútenie, roleForTrack).

### 5.5 Candidate audition (A1 — počuj všetkých, vyber si, HOTOVÉ)

SUNO-core UX: engin zoberie celý ranked bank a používateľ si **vypočuje a
vyberie** kandidáta namiesto toho, aby dostal len neviditeľný víťaz.

- **Engine**: `LocalDeterministicProvider.generateRanked()` vracia
  `{ proposal, ranked, modelScores, ranker }`; `generate()` je teraz thin
  wrapper. Pipeline: `generateAsyncResult(..., { includeBank: true })` dáva na
  výsledku `result.bank: RankedCandidate[]` (best-first, in-memory only — do
  projektu sa serializuje len vybraný proposal) + `result.selection` (meta o
  tom, ako vyhral default).
- **Výber ľubovoľného kandidáta**: `resultForCandidate(result, index)` postaví
  applyable GenerationResult presne z auditionovaného patternu (žiadna
  regenerácia), stampuje `ranker.selectedIndex` + `selection:user-audition`
  warning. Ranker-mode "off" zachováva historický kontrakt (žiadna ranker
  provenance), shadow/active stampujú. Apply = `applyGenerationResultCommand`
  (1 undo krok).
- **Audio**: `src/intent/audition.ts` — kandidát sa renderuje OFFLINE cez reálny
  chain (`renderProject` na dočasnom dokumente, mode "pattern", tail 0.4 s) a
  prehráva cez zdieľaný AudioContext; ničoho sa nedotkne v live engine ani
  transporte. Buffer cache v UI (prvé ▶ renderuje, ďalšie prehrávky instant).
- **UI**: IntentPanel — po generácii zoznam kandidátov (▶/■ audition, TPL/PRIOR
  badge, score (+ ai score), ★ best marker, fixed badge, USE). Apply zruší
  audition aj bank (čistý stav).
- Testy: `tests/candidate-audition.test.ts` (7) — bank obsah/poradie, winner
  identita (`proposal.pattern === bank[0].pattern`), resultForCandidate
  provenance + off/shadow kontrakty, apply-exact-content + undo.
- Follow-up: GenerateDialog dostane audition neskôr (jeho live-preview UX sa
  riesi inak); renderer beží na main thread — pri dlhých patternoch presunúť
  render do workeru.

---

### 5.6 Song builder (A2 — "make it a song", HOTOVÉ)

Jeden intent → celé zaradielovaná pesnička ako jeden undo krok.

- **Forma per žáner** (`planSongForm`): house/techno = intro(8) → build A(4) →
  drop A(8) → break(4) → build B(4) → drop B(8) → outro(8) = 44 barov;
  trap = 6 sekcií; ambient = 5 sekcií s vlastnými labelmi (Emergence → Swell →
  Peak → Stillness → Dissolve). Deterministické (rovnaký intent ⇒ rovnaká forma).
- **Role-aware delty**: každá sekcia má energy/density/complexity delty
  (drop = base +0.3/+0.3/+0.1, break = base −0.35/−0.25, intro/outro nižšie),
  clampované na 0..1 — patterny sú hudobne gradientné, nie kópie.
- **Súvisiace, nie identické**: sekvencia generuje cez kanonický sync path s
  seedmi `baseSeed|song:<i>:<role>` — sekcie zdieľajú seed namespace, takže
  pesnička znie ako JEDEN nápad rozarranžovaný; pattern = celá dĺžka sekcie
  (multi-bar phrase plany + fills), nie tile 16-krokov.
- **applySongCommand**: jeden snapshot inštaluje patterny + scény (rola,
  intensity, label) + kontiguózne klipy + markery (BUILD/DROP/BREAK) +
  prechody (riser do dropov, fill do buildu B) + resolvedBpm + active pattern.
  Generovanie beží v `buildSong()` (async, yield medzi sekciami, progress
  callback) — command negeneruje (etiketa).
- **UI**: IntentPanel "♪ SONG" tlačidlo vedľa GENERATE — build s progress
  statusom, výsledok priamo v arranžmáne.
- Testy: `tests/intent-song.test.ts` (6) — forma determinizmus + per-žáner
  tvary, slider delty + clamp, súvisiace-seedy (rôzne content hash pri rovnakom
  namespace), apply (patterny/scény/klipy/markery/transition/bpm/active),
  one-undo restore.
- Follow-up: audíció celej pesničky (offline render dlhý — po Worker boundary),
  per-section prior kandidáty, SK labely foriem.

### 5.7 Intent → mix chain (D1) + unified intent bar (D3, HOTOVÉ)

- **Mix profil** (`src/intent/mix.ts`): `planMixProfile(intent, overrides)`
  deterministicky mapuje žáner/mood/energy na mix rozhodnutia — tone tilt
  (EQ low/high shelf + LP), punch (drum kompresor + saturation), space
  (reverb mix/decay/tone na chords+lead; techno/trap = suchšie, ambient/chill
  = lush), pump (sidechain pump na bass+chords kľúčovaný z drums pri
  house/techno energy ≥ 0.55). Konzervatívne: neutrálny intent bez override
  nemení EQ. Overrides z textu ("more reverb", "drier", "punchier",
  "bez pumpy", "huge reverb", "tmavší zvuk").
- **applyMixIntent**: pridá chýbajúce efekty (addEffectToTracks), clampuje
  parametre cez clampEffectParam proti EFFECT_DEFS, wire-uje sidechain
  (setEffectSidechainSource → drum track) — všetko zložené do JEDNÉHO undo
  snapshotu (arrangeWords etiketa). Idempotentný: druhé použitie rovnakého
  profilu hodí "changed nothing". Track targeting cez `roleForTrack`
  (rovnaká heuristika ako generátor; "chords"↔"chord" normalizácia).
- **Mix parser** (`src/intent/route.ts`): mix NOUNS/VERBS + komparatívy
  ("darker/brighter/punchier", "viac dozvuku", "bez pumpy", "tmavší zvuk").
  Dôležité delenie: obyčajné adjektívy ("dark techno") = pattern intent,
  komparatívy ("darker") = mix intent.
- **Unified router** (`routeIntentText`): jeden text → tri executory s
  prioritou 1) ARRANGE (scény existujú + text sa parzuje na ops), 2) MIX
  (explicitná mix slovná zásoba), 3) PATTERN (default). Menej deštruktívna
  interpretácia vyhráva.
- **UI**: IntentPanel "⚡ DO IT" — zrouteruje text sám (status ukazuje čo
  spravil); GENERATE a ♪ SONG ostávajú ako explicitné cesty.
- Testy: `tests/intent-mix-route.test.ts` (14) — profil determinizmus,
  per-mood/genre rozhodnutia, konzervativnosť, overrides, apply (fx + clamp +
  sidechain + one undo) + idempotencia, mix parser EN/SK, router priority.

### 5.8 Songwriting roles (A2 v2 — verse/chorus/bridge, HOTOVÉ)

Odpoveď na "ako má vyzerať intro/verse/chorus/bridge/outro":

- **First-class role**: `SceneRole` rozšírený o `verse | chorus | bridge`
  (additívne — `clampSceneRole` ich prijíma, staré projekty sa načítajú
  nezmenené). `inferSceneRole` rozpozná staré scény pomenované
  "Chorus/VERSE/Bridge" — pozor: scéna "Chorus" sa teraz inferuje ako
  `chorus`, nie `drop` (nová sémantika).
- **Inštrumentácia per sekcia**: `SongSectionSpec.instrumentation` hovorí,
  ktoré roly sa v sekcii VÔBEC vygenerujú — intro/outro = bicí+bas,
  build/verse = bez leadu, drop/chorus = plný set, break/bridge = len
  chords+lead. buildSong intersectuje inštrumentáciu s rolami používateľa
  ("no drums" vyhráva vo všetkých sekciách); skutočné roly sú v provenance
  (`SongBuildSection.roles`).
- **Pop forma pre trap**: intro(4) → verse(8) → chorus(8) → verse(8) →
  chorus(8) → bridge(4) → chorus(8) → outro(4) = 52 barov s CHORUS markermi
  (impact) — beats na vokály majú verse/chorus logiku; house/techno ostávajú
  electronic forms s doplnenou inštrumentáciou.
- **Synonymá**: arrangeWords — chorus/refren/hook, verse/zloha (stem, padá
  aj "zlohu"), bridge/most/mostik; chorus už NIE je alias dropu. autoArrange
  nové roly folduje do najbližších bucktov (chorus→drop, verse→build,
  bridge→break). Bandmate etiquette: verse = 85 % density bez fill,
  chorus = full + fill na konci, bridge = 40 % bez kicku/snáru.
- **UI**: ArrangementPanel role picker má VERSE/CHORUS/BRIDGE.
- Testy: song 11 (inštrumentácia, pop forma, intersection, clamp/infer),
  arrangeWords 13 (nové synonymá EN+SK).

### 5.8b SEMANTIC LAYER (T1 krok 2 — embedding porozumenie, HOTOVÉ)

Multilingual sentence-embedding model v prehliadači — sémantické porozumenie
NAD keyword parserom:

- **Model**: `Xenova/paraphrase-multilingual-MiniLM-L12-v2` q8 (**118 MB**,
  EN+SK 50+ jazykov) cez `@huggingface/transformers` v4 vo Web Worker-i.
  **Nie je v gite** — `npm run semantic:fetch` ho raz stiahne do
  `public/models/semantic/` (HF layout); `env.allowRemoteModels = false`
  zakáže CDN fallback (offline-first po prvom fetchnutí; PWA precache ho
  vylučuje, runtime cache len prehliadača).
- **Prístup: retrieval namiesto trénovania hláv** — curated korpus
  (`buildSemanticCorpus`, ~80 referencií: artist presety EN+SK + žáner×mood
  slovná zásoba) sa raz zembeduje a text sa matchuje kosínovou
  najbližším susedom. Match donuje intent patch (rovnaký mechanizmus ako
  artist slovník, ale dosiahnutý VÝZNAMOM, nie slovami) — preto pochopí
  aj neznáme frázy/mená ("beat in the style of the rapper from astroworld"
  → trap 0.685 bez jediného keywordu).
- **Integration**: IntentPanel GENERATE — keď je keyword parse SLABÝ (žiadny
  žáner, žiadny ♪ preset), spýta sa semantic vrstvy; chip
  "🧠 label (score %)". Confident keyword parse = nulová latencia (semantic
  sa nespustí). Threshold 0.5; zlyhanie modelu/flag `pf:semantic-embed` =
  okamžitý null → keyword fallback bez zmeny správania.
- **Worker/client**: `src/ai/semantic/` — rovnaké garancie ako prior/ranker
  (lazy spawn, timeouty, circuit breaker, availabilita probe cez manifest
  404).
- **Overenie**: `scripts/smoke-semantic.mts` s REÁLNYM modelom — 4/4:
  neznáma trap fráza → trap (0.685), SK ambient fráza → ambient (0.835),
  party groove → house (0.661), nesúvisiaci nonsense → null.
- Testy: `tests/intent-semantic.test.ts` (7) — korpus integrita, kNN s
  mock embed (genre klastre, threshold, fallback, cache).

### 5.9 Artist "type beat" references + "more X" routing (C1+C2, HOTOVÉ)

Odpoveď na "bude to chápať aggressive / more energic / travis scott type
beat?": aggressive ✓ (mood), "more energetic" ✓ (C2 revise), artist
referencie ✓ (C1 slovník) — predtým "travis scott type beat" padol do
default house patternu (najhorší možný fallback pre trap request).

- **C1 Artist alias slovník** (`src/intent/artists.ts`): 14 presetov /
  ~40 match fráz — travis scott (trap/rolling/dark/130–140), metro boomin,
  21 savage, rage (carti/yeat/southstar: bouncy/aggressive/150–165), drill
  (pop smoke/central cee: sparse/140–145), ice spice jersey, boom bap
  (kanye: classic/86–92), fred again, disclosure ukg, fisher tech house,
  amapiano (rema/tyla: afro/chill/110–115), big room. BPM priorita z web
  researchu (Mixed In Key/LANDR/producent fóra — zdroje v pláne).
  **Sémantika: preset = base, explicitný text vyhráva** ("travis scott type
  beat bright" → energetic). detected chip "♪ travis scott".
- **Fix**: "drill" mapovalo na techno (tempo-proximity omylom) → trap.
- **C2 Revise routing** (`route.ts`): "more energetic/energic/energy",
  "calmer", "busier/denser", "menej husty" → `revise` route: ±0.15
  (REVISE_DELTA) na energy/density + re-generácia s ROVNAKÝM SEEDOM — beat
  si zachová identitu, zmení charakter. Panel drží `lastIntentRef` a
  re-runuje cez rovnaký audition tok; bez poslednej generácie = fallback na
  čerstvý pattern s atribútom. Router priorita: arrange → mix (ZVUK: tón/
  reverb/punch) → revise (OBSAH: energy/density) → pattern.
- **T1 krok 2 HOTOVÉ (§5.8b)**: semantic retrieval pochopí neznáme frázy a
  mená; alias mapa ostáva ako rýchly offline fallback a korpusový zdroj.
- Testy: `tests/intent-artists.test.ts` (11) — presety + text override +
  drill fix + revise parser EN/SK + router priority + same-seed identity
  (rovnaký seed, iný content hash, determinizmus).

### 5.10 Real transition sounds (T3 zvyšky — HOTOVÉ)

Transitions prestali byť len metadáta — **odchádzajúca sekcia nesie skutočný
transition zvuk** v svojom patternu:

- **fill** → celý posledný bar: 16tinový snare/clap roll s crescendom
  (0.3→0.9), tom run na posledných 4 krokoch, kick anchor na dobe
- **riser** → posledné 2 bary: štvrťový snare pulse stúpajúci → 16tinový
  roll crescendo + otvorené hi-haty na osminách stúpajúce (sekcie < 2 barov
  fallbackujú na fill)
- **break** → dropout: posledný bar ODCHÁDZAJÚCEJ sekcie úplne tichý —
  medzera JE zvuk pred nasledujúcou sekciou
- **drop/impact/custom** → bez zmeny patternu

`src/intent/transitions.ts` — `applyTransitionToPattern(doc, pattern, type,
{ allowDrums })`: deterministické velocity rampy (žiadne RNG), role-aware
pad výber (snare+clap = roll voice, toms = run, openHat = sparkle), output
hash refresh. **allowDrums = false** (bridge inštrumentácia alebo user
"no drums") potláča bicie-based filly — user roly režú cez transitions;
dropout vždy platí (len odoberá). Song builder pečie treatments pri
buildSong (jedna undo, reprodukovateľné hashe).

- Testy: `tests/intent-transitions.test.ts` (8) — typ→treatment mapa,
  crescendo/densita pravidlá, 2-bar riser, dropout silence, nezmenené skoršie
  bary, determinizmus, reálny kit, song integrácia (Build A riser, Drop A
  dropout, Break fill suppressed pre drum-free inštrumentáciu).
- Ostáva (T4/far horizon): syntetizované riser WAV assety cez sample bank
  (potrebné bank/persist infra), audio embedding pre transition výber.

### 5.11 TARGETED SECTION REVISE (C3 — "make bridge more energic", HOTOVÉ)

Revise dostal CIEL: rola v texte zvolí konkrétnu sekciu aranžmánu.

- **Router**: `parseReviseIntent` rozpozná rolu (bridge/most, chorus/refren/
  hook, verse/zloha, intro, outro, build, break/brejk, drop) →
  `revise` route nesie `targetRole`. Bez roly = global revise (posledný
  výsledok, C2správanie).
- **Exekúcia** (`reviseSection` v song.ts): scéna s rolou → jej pattern
  nesie **plný intent snapshot v provenancii** (ukladá ho engine od Fázy 3)
  → posun slidera ±0.15 v TOM intsne → re-generácia s ROVNAKÝM SEEDOM
  (identita sekcie zachovaná) → `replacePatternInPlaceCommand` vymení
  pattern IN-PLACE (id zachované — scény aj klipy ostanú naviazané),
  jeden undo krok.
- **Chyby ako správy**: "no bridge section — build a song first",
  "pattern has no intent provenance" (ručne kreslené patterny sa
  ne-revizujú, nechá sa im ich obsah).
- **Známe mapping obmedzenie**: energy slider ovplyvňuje len drum vrstvu
  (velocityVariation/ghostWeight); na melodic-only sekcii (bridge) je
  energy revise obsahovo no-op — engine v2 kandidát (melodic velocity
  scaling). density prejaví sa všade (ghost notes).

- Testy: intent-artists 13 (rola v routeri, global vs targeted), song 13
  (in-place regenerácia: id/seed/scene väzba, undo, friendly error).

### 5.12 RANKER ACTIVATION STATUS — shadow je KOREKTNÝ, activation čaká na tvoje uši

Forenza (git + dáta): default bol flipsnutý active→shadow v commite "uha",
ktorý tiež pridal nezávislý golden validátor. **Dôvod bol methodologicky
správny**: pôvodný "ready-for-active" verdikt stál na in-sample golden fit
(prefix matching, starý dataset) — nový režim to odmietol
(`invalid-golden-data`), lebo tvoje staré počúvanie (7 combos, reviewed by
KYX) referencovalo dataset skupiny, ktoré po regenerácii už neexistujú.

**Pripravené pre re-aktiváciu** (human-in-the-loop, ~15 min počúvania):
1. `npm run ranker:golden-template` — čerstvý nereviewovaný template
   viazaný na AKTUÁLNY dataset (7 combos: house Afro/Deep, techno Acid/
   Ambient Techno, trap Bouncy/Classic, ambient Drifting; exaktné groupKeys)
2. `node scripts/render-golden-review-pack.mjs` — 28 WAVov (4 kandidáti ×
   7 combos) cez reálny engine → `golden-review/` (mimo public/ — bez
   precache balastu) + LISTENING.md s heuristickým poradím
3. **TY**: prepočuj, prepíš `order` per combo (indexy, najlepší prvý),
   `reviewed: true` + meno + dátum
4. `npm run ranker:train` → nový prísny režim (exaktné groupKeys, golden
   skupiny s position labels) → verdikt
5. `npm run ranker:activate` → flip na "active" + typecheck + testy

Poznámka: C2 favorites retraining je DRUHÝ, silnejší signál — preferenčné
skupiny z tvojich ★ idú priamo do tréningu (GOAL 08); golden holdout ostáva
nezávislou metrikou.

### 5.13 TARGETED EFFECT INTENTS (D1 v2a — "viac delayu na leade", HOTOVÉ engine-side)

- **Gramatika** (`parseEffectIntent` v mix.ts): efekt stem (delay/reverb/
  saturation/chorus/flanger/phaser/tremolo/bitcrusher/compressor/pump/eq —
  prefixové, padajú SK/EN skloňovania "delayu/reverbu/filtra") × cieľ
  (track roly + scene roly expandované cez inštrumentačnú mapu — "na
  bridge" = chords+lead) × smer (more/less/remove; "bez X", "remove X")
  × amount (subtle/medium/huge).
- **Dôležité pravidlo**: bez explicitného cieľa ⇒ NIE je targeted effect
  (generic "more reverb" patrí mix profilu — inak by hijackol mix route).
- **applyEffectIntent**: add-if-missing + turn KNOB (primary param per
  efekt: mix/drive/ratio/amount/highShelf) ± delta scaled by amount,
  clamp proti EFFECT_DEFS; "remove" = removeEffectFromTracks; jeden undo
  snapshot; idempotentný ("changed nothing").
- **Router**: effectIntent má prioritu NAD mix profilom (targeted > generic).
- **Panel wiring čaká na koordináciu** — paralelná session aktívne
  prerába IntentPanel (section-parse + FX ride-along); engine API je
  hotové a otestované, wiring je 10-riadková úprava keď sa ich storm
  ustáli. v2b per-section mix: paralelná session to implementuje
  komplexnejšie (FX track + sceneAutomation lanes + cue clips) —
  NEDEDUPLIKOVAL som.

- Testy: `tests/intent-effect-targets.test.ts` (11) — gramatika EN+SK,
  scene-role expand, amount scaling, remove, router priorita, exekúcia
  (add/knob/undo/remove), user-role respect.

## 6. Kvalita, testy, determinizmus

- **Testy**: `tests/intent-pipeline.test.ts`, `intent-async-pipeline.test.ts`,
  `intent-async-fallback.test.ts`, `intent-mapping.test.ts`,
  `intent-binding.test.ts`, `intent-text-parser.test.ts` (parser v3, EN regresia + SK blok),
  `symbolic-prior.test.ts` (drum prior provider, stub inferencia),
  `symbolic-melodic.test.ts` (melodic prior provider + key-safe noty),
  `favorites-ledger.test.ts` (ledger + konverter),
  `candidate-audition.test.ts` (A1 bank + resultForCandidate + apply),
  `intent-song.test.ts` (A2 forma + delty + apply/undo + A2 v2 inštrumentácia),
  `intent-mix-route.test.ts` (D1 mix profil/parser/apply + D3 router),
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
| Text understanding | **parser v3 + C1 artist slovník + T1 krok 2 SEMANTIC LAYER** (multilingual MiniLM embedding kNN nad curated korpusom — rozumie neznámym frázam a menám, SK vrátane) | väčší embedding model, korpus rastúci s favoritmi |
| Žánre/style | 4 žánre + 21 groove štýlov v prior vocab | desiatky štýlov; style embeddingy namiesto ručných keyword map |
| Generatívny model | template anchors + constrained Markov **+ ONNX symbolic prior v1 (drums)** | prior v2: melodic role, učenie z favoritov, väčší dataset |
| Štruktúra pesničky | **HOTOVÉ (A2 v2 + T3)**: song builder s verse/chorus/bridge, inštrumentáciou per sekciu a REÁLNYMI transition zvukmi (fill roll/riser/dropout pečené do odchádzajúcich sekcií) | section-aware prior kandidáty, audíció celej pesničky, syntetizované riser WAV |
| Intent → mix | **HOTOVÉ (D1)**: mix profil z intentu (tone/punch/space/pump) ako jeden undo krok | loudness target (limiter), per-section mix v song builderi |
| Unified bar | **HOTOVÉ (D3)**: ⚡ router arrange→mix→pattern v IntentPaneli | vzor/pattern z audio referencie (T4) |
| Audio dimenzia | sample kity, grooves; žiadne audio AI | audio embeddingy (tagovanie sample lib, audio ranker rendered výstupu) |
| Vocals | — | v prehliadači realisticky až neskôr (pozri §8 T5) |
| Feedback loop | **HOTOVÉ (C1+C2)**: favorites → retrain drum+melodic prioru aj rankera (preferencie), jeden príkaz | dlhodobejšie: cloud-free zdieľanie packov, implicitné signály (apply bez audition) |

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
  tréningový korpus (public-domain MIDI). ~~pairwise preference head učený
  priamo z favoritov~~ **HOTOVÉ (C2)** — ranker sa učí z preferenčných skupín;
  ~~melodic prior trénovaný aj z favoritov~~ **HOTOVÉ (C1)**.

### T3 — Štruktúra a dlhá forma — ✅ HOTOVÉ (2026-09-19, A2 + v2 + transition sounds)
- ~~Section planner (song form)~~ **HOTOVÉ**: song builder (§5.6) + songwriting
  role verse/chorus/bridge s inštrumentáciou per sekciu (§5.8).
- ~~Fill/transition generovanie~~ **HOTOVÉ (§5.10)**: reálne transition zvuky
  (fill roll/riser build/dropout) pečené do odchádzajúcich sekcií.
- Ostáva: syntetizované riser WAV assety (bank infra), section-aware prior,
  audíció celej pesničky po Worker boundary.

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

*Posledná úplná revízia mapy: 2026-09-19 (T1 + krok 2 semantic layer, parser v3
EN+SK, drum+melodic prior v1, C1+C2 favorites→retrain + artist slovník + revise
routing, A1 audition, A2 song builder + v2 roles + transition sounds, D1 mix
chain, D3 unified bar, C3 targeted section revise). Dokument sa dopĺňa pri
každej zmene Intent Engine; fakty boli overené čítaním zdrojov uvedených v §3.*
