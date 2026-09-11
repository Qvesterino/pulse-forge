# Intent Engine — Feature Extractor v1 a ONNX Ranker

Status: plánovaný implementačný goal  
Priorita: P1  
Scope: offline-first AI-assisted výber najlepšieho kandidáta  
Závisí od: existujúci deterministic generator, candidate bank, quality gates

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
- [ ] Vytrénovať a exportovať `intent-ranker.v1.onnx`.
- [ ] Overiť model proti heuristickému baseline a held-out golden dátam.

Odporúčaný tvar modelu:

```text
input:  [candidateCount, featureCount]
MLP:    featureCount → 64 → 32 → 16 → 1
ops:    Gemm + Relu + Gemm + Relu + Gemm
output: jeden normalizovaný quality score pre každý kandidát
```

Model musí byť malý, CPU/WASM friendly a ľahko nahraditeľný novou verziou. Tréning patrí do development/offline tooling; browser nesmie trénovať model ani vyžadovať network request.

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

- [ ] Definovať `features.v1` ako pevný, verzovaný contract.
- [ ] Definovať nemenné poradie feature-ov; model nesmie používať dynamicky zoradené keys.
- [ ] Definovať rozsah každého feature-u, ideálne `0..1`, s explicitným clippingom.
- [ ] Zabezpečiť, že každý feature je konečné číslo; `NaN`, `Infinity` a missing hodnoty majú deterministický fallback.
- [ ] Použiť fixné normalizačné konštanty, nie normalizáciu podľa aktuálneho candidate batchu.
- [ ] Pridať extractor metadata: `version`, `featureCount`, `names`, `normalizationId`.
- [ ] Zadefinovať `ranker.v1` manifest s model path, input name, output name, feature version a model hash.

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

### Feature groups

- [ ] Intent fit: density, complexity, variation, energy, length, BPM a povolené role.
- [ ] Drum structure: celková hustota, hustota podľa role, downbeat/backbeat coverage, anchor coverage.
- [ ] Drum groove: syncopation, offbeat ratio, style distance, row variation, velocity spread.
- [ ] Drum safety: počet hard violations, ghost ratio, swing usage, metadata coverage.
- [ ] Melodic structure: note density, rest ratio, duration distribution, pitch range, role balance.
- [ ] Melodic motif: motif repetition, interval movement, repeated duration patterns a phrase continuity.
- [ ] Musical validity: scale conformity, timing-grid conformity, note bounds a note overlap indicators.
- [ ] Candidate-relative features: odchýlka od intent targetov a od priemeru referenčného groove.
- [ ] Presence flags: rozlíšiť „track/role absent“ od skutočnej nulovej hodnoty.

Počet feature-ov držať približne v rozsahu 48–64. Každý feature musí mať krátky komentár s významom, rozsahom a dôvodom existencie.

### Implementácia

- [ ] Vytvoriť `src/ai/features/pattern-features.ts`.
- [ ] Extractor musí byť pure function: rovnaký project, pattern, intent a engine version → rovnaký vector.
- [ ] Extractor nesmie volať RNG, audio engine, DOM, React state ani network.
- [ ] Zdieľať existujúce quality metrics tam, kde majú správne vstupy.
- [ ] Neduplikovať generátorovú logiku v extractore.
- [ ] Pridať UUID-free `featureHash` pre diagnostiku a golden fixtures.

## Fáza 2 — Golden dáta a tréningový baseline

- [ ] Vytvoriť deterministic dataset z existujúcej genre/style matice a candidate banku.
- [ ] Ukladať feature vector spolu s pattern content hash, intent hash, engine version a ranker dataset version.
- [ ] Začať s pairwise labels: kandidát A je lepší než B.
- [ ] Použiť heuristický score iba ako bootstrap/teacher signal, nie ako dôkaz hudobnej kvality.
- [ ] Pridať ručne skontrolované golden preferencie pre hlavné genre/style kombinácie.
- [ ] Splitovať train/validation/test podľa seedu a style fixture, aby nedošlo k leakage.
- [ ] Vyhodnotiť pairwise accuracy, Kendall/Spearman koreláciu a top-1 selection accuracy.
- [ ] Porovnať ranker proti aktuálnemu heuristickému candidate score.
- [ ] Pridať tréningový/export script mimo browser runtime.
- [ ] Exportovať model ako `public/models/intent-ranker-v1.onnx` alebo ekvivalent podľa build systému.
- [ ] Exportovať iba model s presným input shape/type a skontrolovať ho ONNX Runtime inference.

Prvý model nesmie byť považovaný za zlepšenie iba preto, že úspešne inferuje. Musí na held-out dátach preukázať aspoň rovnaký výsledok ako heuristika a ideálne ju zlepšiť.

## Fáza 3 — ONNX Worker runtime

- [ ] Pridať lazy-loaded ONNX session vo Worker-i.
- [ ] Session vytvoriť iba raz a reuse-nuť ju pre celý batch kandidátov.
- [ ] Posielať do Worker-a batch `Float32Array`, nie každý kandidát samostatnou request správou.
- [ ] Definovať Worker API:
  - [ ] `load(manifest)`
  - [ ] `score(features)`
  - [ ] `dispose()`
- [ ] Validovať model manifest, input feature version, feature count a output shape.
- [ ] Načítať model z lokálneho assetu; žiadny runtime cloud request.
- [ ] Pridať timeout a bezpečné ukončenie Worker-u.
- [ ] Pri load/inference/chybe vrátiť kontrolovaný fallback status.
- [ ] Zaistiť, že ONNX inference nikdy nebeží v audio callbacku ani na hlavnom UI hot path.
- [ ] Model aj session cacheovať, aby sa model nenačítaval pri každom preview kliknutí.
- [ ] Normalizovať/zaokrúhliť output score podľa verzie rankera pred stable sortom.

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

- [ ] Extractovať feature vector pre každý validný alebo deterministic-repaired kandidát.
- [ ] Hard-invalid kandidáty vyradiť ešte pred ONNX callom.
- [ ] Poslať všetky kandidáty do Worker-a v jednom batchi.
- [ ] Zachovať existujúci heuristic score ako baseline a fallback.
- [ ] V shadow mode zaznamenávať ONNX poradie bez zmeny vybraného výsledku.
- [ ] Pridať feature flag pre aktiváciu modelového rankingu.
- [ ] Po validácii definovať deterministic kombináciu scores, napríklad:

```text
finalScore = hardGate × (heuristicWeight × heuristicScore
                       + modelWeight × modelScore)
```

- [ ] `hardGate` nesmie byť modelom override-nutý.
- [ ] Stable sort: score descending, potom candidate index ascending, potom content hash ascending.
- [ ] Pri chýbajúcom modeli, timeout-e alebo neplatnom outpute použiť heuristický ranking.
- [ ] Do provenance uložiť `featureVersion`, `rankerVersion`, model hash a zvolený candidate index.
- [ ] Diagnostics musia rozlišovať `accepted`, `repaired`, `fallback` a `rejected`.

## Fáza 5 — Quality gates a browser verification

### Feature extractor

- [ ] Rovnaký pattern vždy produkuje rovnaký `featureHash`.
- [ ] Žiadny feature nie je `NaN`, `Infinity` alebo mimo definovaného rozsahu po clippingu.
- [ ] Zmena UUID nemení feature vector ani feature hash.
- [ ] Zmena relevantného hudobného obsahu zmení očakávaný feature subset.
- [ ] Golden feature fixtures pokrývajú drums-only, melody-only, full pattern, empty pattern a fallback.

### ONNX ranker

- [ ] Model sa načíta vo Worker-i bez network requestu.
- [ ] Rovnaký input batch dá rovnaké score a rovnaké poradie.
- [ ] Model output má správny počet kandidátov a je konečný.
- [ ] Model artifact má explicitný hash a version.
- [ ] Held-out pairwise accuracy je minimálne na úrovni heuristiky.
- [ ] Model nezhoršuje hard validity ani deterministický fallback.
- [ ] Ranker batch inference ostáva pod definovaným UI preview budgetom.
- [ ] Model artifact ostáva malý; odporúčaný limit pre samotný ranker je do 1 MB.

### Browser flow

- [ ] Offline preview načíta lokálny model alebo korektne aktivuje fallback.
- [ ] Accept aplikuje vybraný pattern cez command systém.
- [ ] Undo/redo obnoví presný predchádzajúci stav.
- [ ] Reload zachová pattern, provenance a ranker metadata.
- [ ] Chyba Worker-u nezablokuje UI ani audio playback.
- [ ] Browser test overí aj režim bez dostupného model assetu.

## Definition of done

- [ ] `features.v1` je zdokumentovaný, testovaný a verzovaný.
- [ ] Candidate bank vie dávkovo pripraviť feature vectors.
- [ ] Tiny MLP ranker je exportovaný do ONNX a načítaný vo Worker-i.
- [ ] ONNX ranker pracuje iba nad validnými kandidátmi.
- [ ] Heuristický ranking zostáva funkčným offline fallbackom.
- [ ] Rovnaký intent, engine version, model version a vstup vytvárajú rovnaké poradie.
- [ ] Diagnostics a provenance pravdivo hovoria, či bol použitý heuristic alebo ONNX ranker.
- [ ] Typecheck, unit/property tests, golden tests, performance testy a browser verification prechádzajú.
- [ ] Žiadny cloud request ani závislosť od používateľského AI účtu nie je potrebná.

## Explicitné non-goals

- [ ] Nenahrádzať deterministic generator generatívnym neural modelom.
- [ ] Nepridávať CLAP/YAMNet iba preto, že ide o známy audio model.
- [ ] Nevkladať model inference do audio callbacku.
- [ ] Neumožniť modelu obísť invarianty, scale constraints alebo intent roles.
- [ ] Netvrdiť, že ranker zlepšuje kvalitu bez held-out evaluácie.
- [ ] Nemeniť existujúci baseline pri `candidateCount = 1` bez explicitnej engine/ranker version zmeny.

## Užitočné referencie

- [ONNX Runtime Web — JavaScript a WASM runtime](https://onnxruntime.ai/docs/get-started/with-javascript/web.html)
- [ONNX Runtime Web — Worker deployment a asset caching](https://onnxruntime.ai/docs/tutorials/web/deploy.html)
- [PyTorch ONNX exporter](https://docs.pytorch.org/docs/stable/onnx)
- [sklearn-onnx converter](https://github.com/onnx/sklearn-onnx)
