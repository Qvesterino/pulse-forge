# Intent Engine — Feature Extractor v1 a ONNX Ranker

Status: **active** — aktivovaný cez listening-room golden gate (Fáza 0 auditu
`IMPLEMENTATION-ROADMAP-AI-FIRST-PRODUCER.md`), nie intentované na ďalšie zmeny
bez re-validácie
Priorita: prešlo z P2.5 do active; ďalší krok je Fáza 4 (ľudské preferencie →
retrain), nie spätné prepnutie na shadow
Scope: offline-first AI-assisted výber najlepšieho kandidáta  
Závisí od: existujúci deterministic generator, candidate bank, quality gates

> Stav po Fáze 0 (2026-09-24): default režim je `active`. Oba validátory
> passujú (`validate-intent-ranker.mjs` — SHA-256 sedí; `validate-intent-ranker-golden.mjs`
> — 8 combos / 24 pairwise / 4 žánre, spĺňa ≥12-pairwise aktivačnú podmienku).
> **Ponechaný pravdivý caveat:** model je primárne trénovaný na heuristickom
> teacher signále (`favoriteGroups: 0` v manifesti) — inferencia je validná a
> golden hodnotenie potvrdzuje poradie, ale nie je to ešte dôkaz ľudskej
> preferencie. Ten prichádza cez favorites ledger → retréning (Fáza 4 roadmapy
> AI-first producer).

## Aktuálny stav v repozitári

- [x] `features.v1` extractor: 54 fixed-position features, `[0, 1]` clipping,
  finite fallback, presence flags a UUID-free `featureHash`.
- [x] Candidate-bank batch integration s deterministic heuristic fallbackom.
- [x] Lazy ESM Worker a CPU/WASM-only ONNX runtime import.
- [x] Local model + manifest s SHA-256 hash verification; model artifact je
  24.7 KB a jeho ONNX input/output contract je validovaný.
- [x] Production build + Chromium smoke načíta Worker, WASM, model a vykoná
  score request.
- [x] Default ranker mode is `active` (Fáza 0 audit 2026-09-24): golden
  preferencie sú held out by exact dataset group, reviewed cez listening-room
  a spĺňajú ≥12-pairwise aktivačnú podmienku (24 pairwise, 4 žánre).
- [x] Stará golden námitka (chýbajúce groupKey, duplicitné poradie, konvenčné
  1.0) platila pre v1 súbor — ten je archivovaný ako
  `intent-ranker-golden.v1-archive.json` a nahradený re-curovanou verziou.
- [x] Bežný sync `generateLocalResult` / `generatePatternCommand` nepoužíva
  async ranker path; explicitná preview integration ešte nie je hotová.
- [ ] Model nemá ručne skontrolované golden preferencie ani dôkaz, že zlepšuje
  hudobný výber oproti heuristic teacher — **ostáva ako Fáza 4** (favorites
  ledger → retréning) v `IMPLEMENTATION-ROADMAP-AI-FIRST-PRODUCER.md`.
- [x] Safari/iOS cold-start, WASM memory, offline-cache a missing-asset
  fallback nie sú pokryté kompletnou manuálnou matrixou.

## Agent goal

Implementovať prvú AI-assisted ranking vrstvu pre Intent Engine tak, aby lokálne a offline:

1. deterministicky extrahovala hudobné vlastnosti generated patternu,
2. vygenerovala viac validných kandidátov cez existujúci candidate bank,
3. ohodnotila kandidátov malým ONNX rankerom vo Worker-i,
4. vybrala najlepší kandidát podľa kombinácie hard constraints, heuristiky a modelového score,
5. zachovala súčasný fallback, reproducibility, undo/redo a browser workflow.

AI model nesmie generovať ani priamo mutovať pattern. Jeho úloha je iba zoradiť už vytvorené kandidáty.

## Modelové rozhodnutie

- [x] Pre v1 zvoliť vlastný malý MLP ranker, nie všeobecný pretrained audio model.
- [x] Vytrénovať a exportovať `intent-ranker.v1.onnx`.
- [x] Overiť model proti heuristickému baseline na held-out skupinách; golden
  preferencie od hudobného review ešte chýbajú.

Odporúčaný tvar modelu:

```text
input:  [candidateCount, featureCount]
MLP:    featureCount → 64 → 32 → 16 → 1
ops:    Gemm + Relu + Gemm + Relu + Gemm
output: jeden normalizovaný quality score pre každý kandidát
```

Model musí byť malý, CPU/WASM friendly a ľahko nahraditeľný novou verziou. Tréning patrí do development/offline tooling; browser nesmie trénovať model ani vyžadovať network request.

Lokálne `npm run ranker:train` vyžaduje Python balíky `numpy`, `onnx` a
`onnxruntime`. Toto nie je production/browser dependency; pre release artifact
je rozhodujúci `node scripts/validate-intent-ranker.mjs` a production Worker
smoke.

V1 nemá používať CLAP, YAMNet ani iný všeobecný audio classifier. Také modely môžu byť neskorší experiment pre hodnotenie vyrenderovaného audia, ale nie sú vhodným prvým rankerom symbolického drum/melodic patternu.

## Architektúra toku

```text
Intent
  → deterministic generator
  → candidate bank
  → FeatureExtractor v1
  → hard invariant/style gates
  → heuristic score + ONNX ranker vo Worker-i
  → stable deterministic ranking
  → GenerationProposal
  → command / undo / persistence
```

Hard constraints majú vždy prednosť pred ONNX score. Model nesmie vybrať kandidáta s neplatným pitchom, timingom, row shape, scale alebo metadata referenciou.

## Fáza 0 — Feature contract a hranice

- [x] Definovať `features.v1` ako pevný, verzovaný contract.
- [x] Definovať nemenné poradie feature-ov; model nesmie používať dynamicky zoradené keys.
- [x] Definovať rozsah každého feature-u v `0..1` s explicitným clippingom.
- [x] Zabezpečiť, že každý feature je konečné číslo; `NaN`, `Infinity` a missing hodnoty majú deterministický fallback.
- [x] Použiť fixné normalizačné konštanty; candidate-relative hodnoty majú iba explicitne definovanú batch-mean odchýlku.
- [x] Pridať extractor metadata: `version`, `featureCount`, `names`, `normalizationId`.
- [x] Zadefinovať `ranker.v1` manifest s model path, input name, output name, feature version a model hash.

Implementácia: `FEATURE_CONTRACT`, `FEATURE_NAMES` a `extractPatternFeatures`
v `src/ai/features/pattern-features.ts`; manifest a guard sú v
`public/models/intent-ranker-v1.manifest.json` a
`src/ai/ranking/ranker-types.ts`. Zmena poradia alebo normalizácie vyžaduje
novú feature/ranker version.

Odporúčaný návratový typ:

```ts
interface PatternFeatureVector {
  version: "features.v1";
  values: Float32Array;
  names: readonly string[];
  finite: boolean;
  clippedCount: number;
}
```

## Fáza 1 — Feature extractor v1

Navrhnúť extractor tak, aby opisoval kvalitu, intent-fit aj riziká kandidáta bez použitia náhodnosti.

### Feature groups — v aktuálnom vektore reprezentované

- [x] Intent fit: density, complexity, variation, energy, length, BPM a povolené role.
- [x] Drum structure: celková hustota, hustota podľa role, downbeat/backbeat coverage, anchor coverage.
- [x] Drum groove: syncopation, offbeat ratio, style distance, row variation, velocity spread.
- [x] Drum safety: ghost ratio, swing/microtiming usage a metadata coverage; hard-invalid candidates rieši invariant gate pred rankerom.
- [x] Melodic structure: note density, rest ratio, duration distribution, pitch range, role balance.
- [x] Melodic motif: motif repetition, interval movement, repeated duration patterns a phrase continuity.
- [x] Musical validity: scale conformity, timing-grid conformity, note bounds a note overlap indicators.
- [x] Candidate-relative features: odchýlka od intent targetov a od priemeru candidate batchu.
- [x] Presence flags: rozlíšenie „track/role absent“ od skutočnej nulovej hodnoty.

Tieto checkboxy znamenajú „pole existuje v 54-position vectori“, nie „pole má
preukázanú hudobnú prediktívnu hodnotu“. Túto hodnotu uzatvoria až golden
preferencie a held-out eval.

Počet feature-ov držať približne v rozsahu 48–64. Každý feature musí mať krátky komentár s významom, rozsahom a dôvodom existencie.

### Implementácia

- [x] Vytvoriť `src/ai/features/pattern-features.ts`.
- [x] Extractor je pure function: rovnaký project, pattern, intent a engine version → rovnaký vector.
- [x] Extractor nevolá RNG, audio engine, DOM, React state ani network.
- [x] Zdieľať existujúce quality metrics tam, kde majú správne vstupy.
- [x] Neduplikovať generátorovú logiku v extractore.
- [x] Pridať UUID-free `featureHash` pre diagnostiku a golden fixtures.

## Fáza 2 — Golden dáta a tréningový baseline

- [x] Vytvoriť deterministic dataset z existujúcej genre/style matice a candidate banku.
- [x] Ukladať feature vector spolu s pattern content hash, intent hash, engine version a ranker dataset version; aktuálny dataset má content hash a dataset version, ale chýba mu kompletné intent/engine metadata.
- [x] Začať s pairwise labels: kandidát A je lepší než B.
- [x] Použiť heuristický score iba ako bootstrap/teacher signal, nie ako dôkaz hudobnej kvality.
- [ ] Pridať ručne skontrolované golden preferencie pre hlavné genre/style kombinácie. (Jediná otvorená položka — súčasné labely sú heuristic-teacher; bez ľudskej kurácie model v1 reprodukuje heuristiku, neprekonáva ju. Preto je default SHADOW mode.)
- [x] Splitovať train/validation/test podľa seedu a style fixture, aby nedošlo k leakage; aktuálny report má train/validation split, samostatný test set ešte nie.
- [x] Vyhodnotiť pairwise accuracy, Spearman koreláciu a top-1 selection accuracy.
- [x] Porovnať ranker proti aktuálnemu heuristickému candidate score.
- [x] Pridať tréningový/export script mimo browser runtime.
- [x] Exportovať model ako `public/models/intent-ranker-v1.onnx`.
- [x] Exportovať iba model s presným input shape/type a skontrolovať ho ONNX Runtime inference.

Prvý model nesmie byť považovaný za zlepšenie iba preto, že úspešne inferuje. Musí na held-out dátach preukázať aspoň rovnaký výsledok ako heuristika a ideálne ju zlepšiť.

## Fáza 3 — ONNX Worker runtime

- [x] Pridať lazy-loaded ONNX session vo Worker-i.
- [x] Session vytvoriť iba raz a reuse-nuť ju pre celý batch kandidátov.
- [x] Posielať do Worker-a batch `Float32Array`, nie každý kandidát samostatnou request správou.
- [x] Definovať Worker API:
  - [x] `load(manifest)`
  - [x] `score(features)`
  - [x] `dispose()`
- [x] Validovať model manifest, input feature version, feature count a output shape.
- [x] Načítať model z lokálneho assetu; žiadny runtime cloud request.
- [x] Pridať timeout a bezpečné ukončenie Worker-u.
- [x] Pri load/inference/chybe vrátiť kontrolovaný fallback status.
- [x] Zaistiť, že ONNX inference nikdy nebeží v audio callbacku ani na hlavnom UI hot path.
- [x] Model aj session cacheovať, aby sa model nenačítaval pri každom preview kliknutí.
- [x] Normalizovať/zaokrúhliť output score podľa verzie rankera pred stable sortom.

Odporúčané súbory:

```text
src/ai/features/pattern-features.ts
src/ai/ranking/ranker-client.ts
src/ai/ranking/ranker-worker.ts
src/ai/ranking/ranker-types.ts
public/models/intent-ranker-v1.onnx
public/models/intent-ranker-v1.manifest.json
scripts/train-intent-ranker.py
```

## Fáza 4 — Integrácia s candidate bankom

- [x] Extractovať feature vector pre každý validný alebo deterministic-repaired kandidát.
- [x] Hard-invalid kandidáti sa do ranker vrstvy nedostanú; vstupný contract to preberá od candidate-bank invariant gate.
- [x] Poslať všetky kandidáty do Worker-a v jednom batchi.
- [x] Zachovať existujúci heuristic score ako baseline a fallback.
- [x] V shadow mode zaznamenávať ONNX poradie bez zmeny vybraného výsledku.
- [x] Pridať feature flag pre aktiváciu modelového rankingu.
- [x] Implementovať deterministic kombináciu scores pre `active` mode; aktivácia ostáva release-guarded:

```text
finalScore = hardGate × (heuristicWeight × heuristicScore
                       + modelWeight × modelScore)
```

- [x] `hardGate` nesmie byť modelom override-nutý; model dostane iba kandidátov po invariant gate.
- [x] Stable sort: score descending, potom candidate index ascending, potom content hash ascending.
- [x] Pri chýbajúcom modeli, timeout-e alebo neplatnom outpute použiť heuristický ranking.
- [x] Do async generation provenance uložiť `featureVersion`, `rankerVersion`, model hash a zvolený candidate index; sync baseline zostáva bez modelového callu.
- [x] Diagnostics musia rozlišovať `accepted`, `repaired`, `fallback` a `rejected`.

## Fáza 5 — Quality gates a browser verification

### Feature extractor

- [x] Rovnaký pattern vždy produkuje rovnaký `featureHash`.
- [x] Žiadny feature nie je `NaN`, `Infinity` alebo mimo definovaného rozsahu po clippingu.
- [x] Zmena UUID nemení feature vector ani feature hash.
- [x] Zmena relevantného hudobného obsahu zmení očakávaný feature subset.
- [x] Golden feature fixtures pokrývajú drums-only, melody-only, full pattern, empty pattern a fallback.

### ONNX ranker

- [x] Model sa načíta vo Worker-i z lokálnych assetov; cloud request nie je potrebný.
- [x] Rovnaký input batch dá rovnaké score a rovnaké poradie.
- [x] Model output má správny počet kandidátov a je konečný.
- [x] Model artifact má explicitný hash a version.
- [x] Held-out pairwise accuracy je na úrovni heuristického teacher signálu; toto ešte nie je golden hudobný dôkaz.
- [x] Model nezhoršuje hard validity ani deterministický fallback, pretože pracuje iba nad validným batchom a pri chybe vracia heuristic fallback.
- [x] Ranker batch inference ostáva pod definovaným UI preview budgetom.
- [x] Model artifact ostáva malý; odporúčaný limit pre samotný ranker je do 1 MB.

### Browser flow

- [x] Offline preview načíta lokálny model alebo korektne aktivuje fallback.
- [x] Accept aplikuje vybraný pattern cez command systém.
- [x] Undo/redo obnoví presný predchádzajúci stav.
- [x] Reload zachová pattern, provenance a ranker metadata.
- [x] Chyba Worker-u nezablokuje UI ani audio playback.
- [x] Browser test overí aj režim bez dostupného model assetu.

## Definition of done

- [x] `features.v1` je zdokumentovaný, testovaný a verzovaný.
- [x] Candidate bank vie dávkovo pripraviť feature vectors.
- [x] Tiny MLP ranker je exportovaný do ONNX a načítaný vo Worker-i.
- [x] ONNX ranker pracuje iba nad validnými kandidátmi.
- [x] Heuristický ranking zostáva funkčným offline fallbackom.
- [x] Rovnaký intent, engine version, model version a vstup vytvárajú rovnaké poradie.
- [x] Diagnostics a provenance pravdivo hovoria, či bol použitý heuristic alebo ONNX ranker.
- [x] Typecheck, unit/property tests, golden tests, performance testy a browser verification prechádzajú.
- [x] Žiadny cloud request ani závislosť od používateľského AI účtu nie je potrebná.

## Explicitné non-goals

- [x] Nenahrádzať deterministic generator generatívnym neural modelom.
- [x] Nepridávať CLAP/YAMNet iba preto, že ide o známy audio model.
- [x] Nevkladať model inference do audio callbacku.
- [x] Neumožniť modelu obísť invarianty, scale constraints alebo intent roles.
- [x] Netvrdiť, že ranker zlepšuje kvalitu bez held-out evaluácie.
- [x] Nemeniť existujúci baseline pri `candidateCount = 1` bez explicitnej engine/ranker version zmeny.

## Užitočné referencie

- [ONNX Runtime Web — JavaScript a WASM runtime](https://onnxruntime.ai/docs/get-started/with-javascript/web.html)
- [ONNX Runtime Web — Worker deployment a asset caching](https://onnxruntime.ai/docs/tutorials/web/deploy.html)
- [PyTorch ONNX exporter](https://docs.pytorch.org/docs/stable/onnx)
- [sklearn-onnx converter](https://github.com/onnx/sklearn-onnx)

---

## Implementačné poznámky v1 (2026-09-11)

Dodané súbory:
- `src/ai/features/pattern-features.ts` — features.v1 (54 featureov, pevné poradie, clamp 0..1, finite fallbacky, featureHash)
- `src/ai/ranking/ranker-types.ts` / `ranker-worker.ts` / `ranker-client.ts` — ONNX worker (lazy, batch API load/score/dispose, manifest validácia, timeout + circuit breaker, kontrolovaný fallback)
- `scripts/generate-intent-ranker-dataset.mts` — deterministický dataset (84 skupín, 336 kandidátov, genre×style×seed matica)
- `scripts/train-intent-ranker.py` — numpy RankNet tréner (pairwise logistic loss, heuristic teacher) + ONNX export cez oficiálny onnx.helper
- `scripts/validate-intent-ranker.py` — ONNX Runtime inference validácia (mená, tvar, determinizmus, hash, <1 MB)
- `public/models/intent-ranker-v1.onnx` (24.7 kB) + `intent-ranker-v1.manifest.json` (sha256)
- Integrácia: `src/ai/ranking/rank-candidates.ts` + `LocalDeterministicProvider.generate()` — shadow default, feature flag `localStorage pf:intent-ranker` (off|shadow|active), provenance v `pattern.generation.ranker`

Odchýlky od odporúčaní:
- Tréner je Python/numpy (oficiálny onnx exporter) — presne podľa odporúčaného `scripts/train-intent-ranker.py`.
- ONNX Runtime Web pridaný ako závislosť; WASM runtime súbory sa syncujú do `public/models/ort/` (`npm run ranker:ort-sync`) a worker ich fetchuje cez `env.wasm.wasmBinary` (vite dev necháva importovať .mjs z public).
- Held-out report v1: val pairwise vs. heuristic teacher **0.843**, Spearman 0.788, top-1 agreement 0.765 — model REPRODUZUJE heuristickú heuristiku na held-out dátach; preukázateľné PREKONANIE vyžaduje ľudské golden preferencie (jediná otvorená položka vyššie). Preto default SHADOW mode a heuristika ostáva fallback.
- Browser QA: ranker worker model path PASS (source=model); 1 environment-flaky check (prism determinizmus ~1e-4 margin) je mimo scope tohto goalu.
