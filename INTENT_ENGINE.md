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
| `providers/local.ts` | 274 | `LocalDeterministicProvider` — id `pulse-forge.local-groove`, verzia `correctness-1`; sync (heuristika) + async (ONNX) cesta, invariant gates, repair, fallback |
| `candidate-bank.ts` | 54 | dedup podľa content hash + heuristic score: `gateFit·0.4 + distanceFit·0.3 + anchorFit·0.2 + motifFit·0.1` |
| `quality.ts` | 278 | `repairGeneratedPattern`, `refreshPatternQuality`, `refreshPatternOutputHash`, `createFallbackPattern` |
| `text-parser.ts` | 202 | `parseIntentText` — EN keyword parser (genre/style/BPM/character/roles) → IntentInput + `detected[]` |
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
| `package.json` | `ranker:train`, `ranker:golden`, `ranker:activate`, `ranker:ort-sync` |

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

## 5. ONNX ranker v1 — stav

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

---

## 6. Kvalita, testy, determinizmus

- **Testy**: `tests/intent-pipeline.test.ts`, `intent-mapping.test.ts`,
  `intent-binding.test.ts`, `tests/intent/arrangeWords.test.ts`, `dice.test.ts`,
  `dice-subseed.test.ts`, `dice-locks.test.ts`, `ranker-client.test.ts`,
  `pattern-features.test.ts`, golden baselines (`tests/ai-baseline.test.ts`,
  8 genre/style kombinácií × 16/32/64 krokov), quality gates, render-event parity,
  browser verification (`scripts/verify-browser.mjs`).
- **Perf budget**: UI preview ≤ 250 ms synchronne (16/32/64 krokov merané,
  `npm run ai:performance`). Worker boundary pre väčšie generácie = otvorený
  follow-up.
- **Determinizmus**: `hashString`/`mulberry32`, forkRandom sub-seedy, content
  hash bez UUID, engine version `correctness-1` v golden fixtures.

---

## 7. Gap analýza voči cieľu "local SUNO"

### 7.1 Nájdené medzery v zapojení (rýchle výhry)

1. **ONNX ranker nie je na interaktívnej ceste.** Celé UI aj príkazy idú cez
   `generateLocalResult → generateSync` (heuristika). Async `generate()` s
   modelom volá dnes len browser smoke. Ranker je v `active` režime, ale
   fakticky neběží pre používateľa. → Zapojiť async path do
   GenerateDialog/Dice/IntentPanel (preview budget 400 ms to drží).
2. **IntentPanel generuje dvakrát** — raz ručne `generatePattern`+invariants na
   kontrolu, potom `generatePatternCommand` znova vnútri commandu. → Zjednotiť
   cez `generateLocalResult`.
3. **Sync path = vždy heuristika.** Kým všetko nie je na async path, príkazy
   (accept) môžu vybrať iného kandidáta než async preview. → Jedna cesta pre
   preview aj apply (zásada Fázy 4).

### 7.2 Schopnostné medzery voči SUNO

| Oblast | Dnes | Chýba do SUNO-tieru |
|---|---|---|
| Text understanding | ~40 EN keywordov, first-match, žiadna SK podpora, žiadne frázy/negácie mimo "no drums" | viacjazyčný (SK!) parser/embedding → IntentSpec vrátane key, nálady, referencií |
| Žánre/style | 4 žánre + style profily | desiatky štýlov; style embeddingy namiesto ručných keyword map |
| Generatívny model | template anchors + constrained Markov (deterministický, rýchly, spoľahlivý) | malý neurónový symbolický generátor ako *ďalší provider/kandidát zdroj* |
| Štruktúra pesničky | phrase plan na úrovni patternu (16–256 krokov) + `arrangeWords`/autoArrange | dlhý form (intro→build→drop→break→outro), section-aware generácia, transition fill |
| Audio dimenzia | sample kity, grooves; žiadne audio AI | audio embeddingy (tagovanie sample lib, audio ranker rendered výstupu) |
| Vocals | — | v prehliadači realisticky až neskôr (pozri §8 T5) |
| Feedback loop | ranker trénovaný na heuristic teacher | učenie z používateľských preferencií (dice favorites → golden dataset) |

---

## 8. Roadmapa: ONNX expanzia (návrh tierov)

> Zásady z §1 platia pre každý model: manifest + SHA-256, lazy worker, timeouty,
> kontrolovaný fallback, proposal-only, žiadna inferencia v audio callbacku.
> Veľkosti sú hrubé odhady pre int8/wasm; potvrdiť meraním.

### T0 — existujúce (hotové)
- intent-ranker v1 (25 kB, WASM, active) — pattern kandidáty.

### T1 — Zapojenie a prehĺbenie porozumenia zámeru
1. **Async ranker path do UI** (gap §7.1) — bez nového modelu, najväčší okamžitý efekt.
2. **Intent parser v2**: SK+EN, frázy, negácie, key/detect, "similar to X".
   Krok 1: rozšíriť deterministický parser. Krok 2: ONNX text encoder
   (multilingual MiniLM-tier, ~20–90 MB int8) → embedding → malé head-y
   (genre/style/energy/…). Beží vo workeri, fallback = parser v1.
3. **features.v2 + ranker v2**: viac kandidátov (8→16?), učenie z dice favorites.

### T2 — Symbolická generácia (prvé generujúce modely)
- Malý decoder (2–10 M parametrov int8) trénovaný na našich groove/melodic
  dátach → generuje drum/melodic sekvencie podmienené intent embeddingom.
- Ako **nový GenerationProvider** (`local-neural-v1`): kandidáty pridáva do
  rovnakého banku, prechádza rovnakými invariantmi/rankom. Fallback = template
  engine. Determinizmus: seed → sampling (temperature) musí byť seedovaný.

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

*Posledná úplná revízia mapy: 2026-09-18 ( úvodný audit ). Dokument sa dopĺňa
pri každej zmene Intent Engine; fakty boli overené čítaním zdrojov uvedených v §3.*
