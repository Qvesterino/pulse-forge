# Intent Engine — implementačná roadmapa

Status: Fáza 5 — quality gates, golden tests a browser verification implementované; Worker boundary zostáva otvorený follow-up
Scope: lokálna deterministická generácia hudobných patternov, Assist operácie a budúce AI providery  
Priorita: offline-first, reprodukovateľnosť, hudobná kvalita, bezpečné rozšírenie

## Cieľ

Vybudovať z aktuálneho seeded groove/pattern generátora robustný Intent Engine, ktorý:

- funguje kvalitne a rýchlo bez siete,
- vytvára reprodukovateľné výsledky podľa seedu a verzie engine,
- rozumie hudobnému zámeru, nie iba žánru a niekoľkým sliderom,
- vie generovať drums, bass, chords, lead a viac-taktové frázy,
- vracia validovaný návrh, ktorý sa aplikuje cez existujúci command/undo systém,
- umožní neskôr pripojiť reálny AI provider bez rozbitia offline workflowu,
- poskytuje diagnostiku, provenance a merateľné quality gates.

## Zásady, ktoré platia počas celej implementácie

- [ ] Lokálny provider musí fungovať bez network requestu a bez AI účtu.
- [ ] Generovanie nesmie bežať v audio callbacku ani meniť audio engine priamo.
- [ ] Každý hudobný random musí byť odvodený od explicitného seedu.
- [ ] Rovnaký `engineVersion + recipe + seed + input` musí dať rovnaký hudobný obsah.
- [ ] Projektové UUID môžu zostať unikátne; deterministický musí byť obsahový hash.
- [ ] Každý výsledok musí prejsť validáciou a deterministic repair krokom.
- [ ] AI provider môže vrátiť iba návrh/proposal, nikdy priamu mutáciu projektu.
- [ ] Každá zmena generátora musí mať test, fixture alebo zdokumentovaný dôvod.
- [ ] Realtime playback a offline export musia naďalej konzumovať rovnaký project model.
- [ ] Vývoj sa nesmie opierať iba o to, že test prejde; musí existovať aj hudobná evaluácia.

## Aktuálny baseline

- [x] Zmapovaný súčasný Intent/AI kód pod `src/ai/` a `src/assist/`.
- [x] Overený dátový tok cez `GenerateDialog`, command systém a project model.
- [x] Overená deterministická PRNG infraštruktúra (`hashString`, `mulberry32`).
- [x] Overený stav testov: typecheck prešiel, celý test suite prešiel.
- [x] Identifikované kritické correctness riziká v Markov a melodic engine.
- [x] Identifikované architektonické medzery pre `IntentSpec`, provenance a AI provider boundary.
- [x] Vytvorené golden fixtures aktuálneho správania pred opravami.
- [x] Zaznamenané aktuálne referenčné výstupy pre 8 reprezentatívnych genre/style kombinácií.
  - [ ] Zaznamenané aktuálne referenčné výstupy pre úplnú genre/style maticu.

---

## Fáza 0 — Freeze baseline a testovací harness

### Cieľ

Zachytiť súčasný stav tak, aby sa dali bezpečne porovnávať opravy kvality s regresiami.

### Implementácia

- [x] Pridať canonical serializer pre generovaný hudobný obsah bez UUID a timestampov.
- [x] Pridať helper na výpočet `contentHash` pre drum rows, notes a step metadata.
- [x] Vytvoriť fixtures pre každý žáner a reprezentatívne style:
  - [x] House
  - [x] Techno
  - [x] Trap
  - [x] Ambient
  - [x] minimálne 2 style varianty na žáner
- [x] Uložiť baseline metriky pre 16, 32 a 64 krokov.
- [x] Pridať test, ktorý vie vypísať recipe, content hash a základné hudobné metriky.
- [x] Zmerať čas generovania v Chromium pre 16/32/64 krokov.

### Acceptance criteria

- [x] Jeden seed sa dá reprodukovať cez test bez závislosti od UUID.
- [x] Každý fixture má čitateľný názov, vstupné options a očakávaný hash/metrics.
- [x] Pred ďalšou fázou existuje porovnanie „pred opravou“ vs. „po oprave“.

Poznámka k overeniu: Intent Engine baseline a correctness testy prešli. Aktuálny pracovný strom má nezávislé rozpracované zmeny v audio/effect vrstve; ich audio-worklet regresie a prípadné integračné zlyhania sa v tejto fáze zámerne nemenia.

---

## Fáza 1 — Correctness a deterministický základ

Priorita: P0  
Závisí od: Fáza 0

### Cieľ

Odstrániť chyby, ktoré môžu meniť hudobnú logiku alebo znemožniť skutočnú reprodukovateľnosť.

### 1.1 Drum Markov engine

- [x] Opraviť smoothing tak, aby unseen transitions nedostávali neprimerane veľkú pravdepodobnosť.
- [x] Použiť sparse distribution alebo backoff iba na validné transition candidates.
- [x] Vynútiť konzistentný posun pozície `step → step + 1` modulo takt.
- [ ] Oddeliť stav rytmickej aktivity od velocity trendu, ak je to potrebné pre čitateľnejší model.
- [ ] Pridať fallback poradie:
  1. [x] validné transition kandidáty z rovnakého position contextu,
  2. [ ] štýlový referenčný pattern,
  3. [x] bezpečný konzervatívny state anchor.
- [x] Otestovať, že model nevytvára prechody mimo trénovaných alebo explicitne povolených kandidátov.
- [ ] Otestovať, že temperature mení variáciu, nie základnú metriku a timing grid.

### 1.2 Melodic state encoding

- [x] Opraviť encoding/decoding pre `rest`, degree `0..6` a duration.
- [x] Pridať round-trip property test pre všetky validné stavy.
- [ ] Pridať test, že rest ostáva rest aj po generovaní.
- [x] Pridať test, že degree 6 je reprezentovateľný a nikdy nepadá mimo buffer.
- [x] Validovať duration pred vstupom do modelu.

### 1.3 Seed streamy

- [x] Zaviesť root seed pre jednu generation session.
- [x] Odvodiť stabilné sub-seedy:
  - [x] `groove`
  - [x] `drums`
  - [x] `drumMeta`
  - [x] `bass`
  - [x] `chords`
  - [x] `lead`
  - [x] `variation`
- [x] Zabezpečiť, že pridaný random call v drum engine nemení melodický výsledok.
- [x] Otestovať deterministické výsledky pri rovnakom recipe a rôznych execution orderoch.

### 1.4 Content determinism a provenance minimum

- [x] Oddeliť generované UUID od deterministického hudobného obsahu.
- [x] Pridať interný `engineVersion` pre lokálny generator.
- [x] Pridať `GenerationRecipe` s minimálne týmito poliami:
  - [x] `engineId`
  - [x] `engineVersion`
  - [x] `seed`
  - [x] canonical input hash
  - [x] normalized options
  - [x] resolved groove/style ID
  - [x] output content hash
- [x] Zabezpečiť, aby recipe neobsahoval runtime objekty, AudioNodes ani React state.
- [x] Pridať test plného content hash porovnania.

### 1.5 Single owner pre swing

- [x] Rozhodnúť, či swing vlastní project-level groove alebo pattern-local metadata.
- [x] Zamedziť dvojitému aplikovaniu swing offsetu.
- [x] Ak sa používa `applyGrooveSettings`, nesmie sa rovnaký swing zároveň zapisovať do step metadata.
- [x] Pridať correctness test pre kombináciu generated pattern + project groove ownership.

### Acceptance criteria

- [x] Opravené Markov a melodic correctness testy.
- [x] Rovnaký recipe vytvára rovnaký content hash.
- [x] Zmena drum random streamu nemení bass/chord/lead stream.
- [x] Swing sa pri žiadnej kombinácii neaplikuje dvakrát.
- [ ] Všetky existujúce testy naďalej prechádzajú.

---

## Fáza 2 — Lokálna hudobná kvalita

Priorita: P0/P1  
Závisí od: Fáza 1

### Cieľ

Prejsť od „randomized pattern z template“ k riadenému, rýchlemu a hudobne použiteľnému offline generátoru.

### 2.1 Hybridný generation model

- [x] Zachovať silné template anchors pre žáner/style.
- [x] Markov používať iba na kontrolovanú variáciu, nie ako voľný globálny sampler.
- [x] Definovať hard constraints pre každý style:
  - [x] kick anchors
  - [x] backbeat/snare anchors
  - [x] povolené syncopation pozície cez role-aware syncopation budget
  - [x] minimálna/maximálna hustota cez genre/style quality profile
  - [x] povolené ghost/ornament pozície podľa role
- [ ] Definovať soft constraints:
  - [x] velocity contour
  - [x] repetition
  - [ ] variation amount
  - [ ] phrase contrast
- [x] Pridať deterministic repair pass po generovaní.
- [ ] Pri neúspechu validácie vrátiť bezpečný style template namiesto poškodeného patternu.

### 2.2 Pad roles namiesto magic indexov

- [x] Zaviesť semantic pad role, napríklad `kick`, `snare`, `clap`, `closedHat`, `openHat`, `perc`, `tom`, `fx`.
- [x] Odvodiť role z kit metadata alebo bezpečnej klasifikácie názvu.
- [x] Ratchety povoľovať podľa role/capability, nie podľa indexov `7`, `8`, `14`.
- [x] Ghost rules odlíšiť pre kick, snare, hats a percussion.
- [x] Otestovať generovanie s custom kitom a iným poradím padov.

### 2.3 Multi-bar phrase engine

- [x] Definovať phrase length a phrase position.
- [x] Pridať plan pre `main`, `variation`, `drop`, `fill` a `outro`.
- [x] Zabezpečiť, že 16/32/64 krokov vytvára zmysluplný rozdiel, nie iba tile rovnakého taktu.
- [x] Presunúť fills z implicitného náhodného side-effectu do explicitného phrase planu.
- [x] Pridať kontrolu, že fill sa nevyskytuje v patternoch, ktoré naň nemajú dostatočnú dĺžku.
- [ ] Pridať kontrolu energie medzi susednými frázami.

### 2.4 Melodic roles a hudobné vzťahy

- [x] Generovať bass, chord a lead ako samostatné parts.
- [x] Definovať role-specific register, density, duration a velocity range.
- [ ] Zachovať scale/key constraints pred aj po repair kroku.
- [ ] Zlepšiť kick/bass coordination bez náhodného posunu, ktorý môže meniť groove.
- [ ] Zabrániť duplicitnému priraďovaniu rovnakých NoteEvent ID na viac trackov.
- [x] Pridať target mapping podľa role a názvu instrument tracku.

### 2.5 Metriky hudobnej kvality

- [x] Implementovať metrics pre drum pattern:
  - [x] hit density
  - [x] downbeat preservation
  - [x] syncopation
  - [x] velocity contrast
  - [x] repetition vs. novelty
  - [ ] groove/style distance
- [x] Implementovať metrics pre melodiku:
  - [x] rest ratio
  - [x] pitch range
  - [x] scale validity
  - [x] duration distribution
  - [x] role density
  - [x] repeated motif ratio a motif novelty
- [x] Definovať style-distance a syncopation thresholdy pre genre/style profily.
- [x] Pri prekročení syncopation thresholdu spustiť deterministic repair; style gate vracia dôvody pre fallback vrstvu.

### Acceptance criteria

- [x] Generovaný pattern zachováva základné kick/backbeat anchors pri rôznych seedech.
- [x] Variácia je deterministická a viac-taktový výstup nie je iba slepé opakovanie rovnakého taktu.
- [x] Bass/chord/lead sú oddeliteľné a mapovateľné na tracky.
- [x] Každý podporovaný genre/style profil má anchors a základné metrics thresholdy.
- [x] Variácia je vyhodnotená voči style/groove distance thresholdom a provenance nesie quality diagnostiku.

---

## Fáza 3 — Intent contract a generation pipeline

Priorita: P1  
Závisí od: Fáza 1, základ z Fázy 2

### Cieľ

Zaviesť stabilnú doménovú vrstvu medzi UI, lokálnym generatorom a budúcimi AI providermi.

### Navrhovaná štruktúra

```text
src/intent/
  types.ts
  schema.ts
  normalize.ts
  hash.ts
  plan.ts
  result.ts
  repair.ts
  evaluate.ts
  providers/
    local.ts
    remote.ts
```

### 3.1 IntentSpec

- [x] Navrhnúť serializovateľný `IntentSpec`.
- [x] Pridať minimálne:
  - [x] `genre`
  - [x] `style`
  - [x] `mood`
  - [x] `energy`
  - [x] `density`
  - [x] `complexity`
  - [x] `variation`
  - [x] `seed`
  - [x] `key`
  - [x] `bpmRange`
  - [x] `length`
  - [x] požadované role
  - [x] target tracks
  - [x] explicit constraints
- [x] Rozlíšiť user intent od derived engine parameters cez `IntentSpec.controls` a `GenerationPlan.options`.
- [x] Normalizovať chýbajúce a neplatné hodnoty na deterministic defaults.
- [x] Pridať versionované schema validation.

### 3.2 GenerationPlan

- [x] Implementovať pure `planGeneration(intent, projectContext)`.
- [x] Plan musí obsahovať:
  - [x] normalized intent
  - [x] resolved groove/style
  - [x] role plans
  - [x] sub-seeds
  - [x] constraints
  - [x] expected output shape
  - [x] recipe metadata
- [x] Zabezpečiť, aby preview aj apply používali rovnaký plan.
- [x] Plan nesmie meniť project state.

### 3.3 GenerationResult

- [x] Výsledok rozdeliť na:
  - [x] generated content
  - [x] recipe
  - [x] diagnostics
  - [x] quality metrics
  - [x] warnings
  - [x] provider metadata
- [ ] Rozlíšiť `accepted`, `repaired`, `fallback` a `rejected` výsledok podľa skutočne vykonaných repairov.
- [x] Pridať deterministic repair diagnostics a dôvody quality gate warningov.

### 3.4 Project model a persistence

- [x] Rozhodnúť, že recipe + IntentSpec snapshot budú uložené priamo na `Pattern.generation`.
- [ ] Pridať samostatnú schema migration pre generation metadata, ak budú polia povinné.
- [x] Zachovať kompatibilitu so staršími projektmi bez recipe.
- [x] Zabezpečiť JSON round-trip stabilitu.
- [x] Pridať test provenance, recipe a content hash round-trip.

### Acceptance criteria

- [x] UI nemusí poznať interné Markov/PRNG detaily.
- [x] Local provider sa dá zavolať cez IntentSpec a vráti GenerationResult.
- [x] Preview a Apply pre rovnaký intent používajú rovnaký plan.
- [x] Každý nový pattern má dohľadateľnú provenance.

---

## Fáza 4 — Assist workflow a UI integrácia

Priorita: P1  
Závisí od: Fáza 2, Fáza 3

### Cieľ

Zjednotiť full generation a chirurgické Assist operácie pod rovnaký deterministic contract.

### Implementácia

- [x] Premigrovať `GenerateDialog` na `IntentSpec + GenerationPlan`.
- [x] Odstrániť duplicitné groove resolution z UI.
- [x] Preview musí zobrazovať rovnaký plán, ktorý sa následne aplikuje.
- [ ] Rozšíriť preview o melodické parts alebo krátky offline audio preview.
- [x] Ukladať recipe pri vytvorení nového patternu.
- [x] Pri replace zachovať recipe ako lineage, aktualizovať content hashes a zneplatniť staré quality diagnostics.
- [x] `VARY` musí mať canonical input hash pôvodného patternu.
- [x] `BUILD` musí korektne rozšíriť:
  - [x] drum rows
  - [x] notes
  - [x] step metadata
  - [x] phrase metadata
- [x] `REPLACE` musí vyčistiť metadata cieľovej rodiny, ktoré už neplatia.
- [x] `FILL` musí aktualizovať step metadata konzistentne s novými hitmi.
- [x] Každá operácia musí byť jeden undo krok.

### Acceptance criteria

- [x] Preview a Apply používajú rovnaký normalizovaný request a pure patch builder.
- [x] Surgical `REPLACE` nemení necielené pad families; BUILD/FILL majú explicitne zdokumentovaný širší rozsah.
- [x] Undo/redo obnoví rows, notes, metadata aj recipe ako jeden command snapshot.
- [ ] UI zobrazuje seed, engine version a prípadné repair warnings.
  - [x] Assist preview zobrazuje lokálnu Assist engine verziu; repair diagnostics čakajú na spoločný diagnostics panel.

---

## Fáza 5 — Quality gates, golden tests a browser verification

Priorita: P1  
Závisí od: Fáza 2, Fáza 3

### Test layers

- [x] Unit tests pre encoding, decoding, RNG streamy a normalization (`tests/ai-correctness.test.ts`, `tests/ai-markov.test.ts`, `tests/intent-pipeline.test.ts`).
- [x] Property-style seed matrix tests pre validné hodnoty a invarianty patternov (`tests/quality-gates.test.ts`).
- [x] Golden content fixtures pre hlavné genre/style kombinácie (`tests/fixtures/ai-baseline.*`, 8 kombinácií × 16/32/64 krokov).
- [x] Regression tests pre generator version `correctness-1` (`tests/ai-baseline.test.ts`).
- [x] Integration tests pre command, undo/redo a persistence (`tests/assist-pipeline.test.ts` + existujúce command/store/export testy).
- [x] Browser tests pre offline generation flow (`scripts/verify-browser.mjs`, accept → undo/redo → export → reload).
- [x] Offline audio render tests pre reprezentatívne generated patterns (`src/browser-checks.ts`, valid WAV gate).

### Povinné invariants

- [x] Žiadny note nemá neplatný pitch, duration, velocity alebo start (`src/ai/invariants.ts`).
- [x] Žiadny drum row nemá nesprávny počet krokov.
- [x] Žiadne metadata neodkazujú na neaktívny alebo neexistujúci hit.
- [x] Všetky generated melodic notes rešpektujú key/scale, ak je key zadaný.
- [x] Výstup má deterministický content hash.
- [x] Fallback je vždy validný a prehrateľný.
- [x] Offline render je konzistentný s realtime event plánom (`src/project-model/events.ts`, `tests/render-event-parity.test.ts`).

### Performance gates

- [x] Zmerať generation latency pre 16/32/64 krokov (`scripts/ai-performance.mts`).
- [x] Nastaviť maximálny synchronný čas pre UI preview na 250 ms.
- [ ] Pri väčších generáciách presunúť výpočty do Worker boundary.
- [x] Zamedziť zbytočnej alokácii veľkých Markov matíc pri každom kliknutí (`src/ai/markov.ts` model cache).
- [x] Cacheovať immutable groove models a derived distributions.

### Acceptance criteria

- [x] CI spúšťa correctness aj quality testy (`npm test` + `npm run ai:performance` + browser job).
- [x] Zmena výsledku je buď očakávaná zmena engine version, alebo regresia (`correctness-1` golden hashes).
- [x] Browser verification pokrýva accept, undo, export a reload.

---

## Fáza 6 — Provider boundary a budúce AI requesty

Priorita: P2  
Závisí od: Fáza 3, Fáza 5

### Cieľ

Pridať AI ako voliteľný zdroj návrhov bez závislosti lokálneho workflowu od siete.

### Provider interface

- [ ] Definovať provider-neutral interface:

```ts
interface GenerationProvider {
  id: string;
  version: string;
  capabilities: readonly string[];
  generate(
    intent: IntentSpec,
    context: GenerationContext,
    signal?: AbortSignal,
  ): Promise<GenerationProposal>;
}
```

- [ ] Implementovať `LocalDeterministicProvider` ako default.
- [ ] Implementovať remote provider iba za explicitným feature/config flagom.
- [ ] Pridať timeout, cancellation a retry policy.
- [ ] Pridať cache podľa canonical intent/context hash.
- [ ] Neprenášať celý project, ak provider potrebuje iba relevantný context.
- [ ] Pridať privacy boundary a používateľské upozornenie pred network requestom.

### AI output handling

- [ ] AI odpoveď validovať proti strict schema.
- [ ] Zamietnuť neplatné notes, roly, pitch, duration a timing.
- [ ] Spustiť deterministic repair pass.
- [ ] Po repairi znovu spustiť quality metrics.
- [ ] Pri neúspechu použiť local provider fallback.
- [ ] Výsledok aplikovať až po user accept alebo explicitnom auto-accept nastavení.
- [ ] Uložiť provider ID, model ID, model version a request recipe.

### Acceptance criteria

- [ ] Aplikácia funguje úplne bez AI provideru.
- [ ] Neúspešný request nezablokuje audio ani projekt.
- [ ] Remote návrh sa dá undo-núť ako jeden command.
- [ ] Rovnaký AI návrh je dohľadateľný cez provenance, aj keď samotný provider nie je dostupný.

---

## Fáza 7 — Stabilizácia, migrácie a dokumentácia

Priorita: P2  
Závisí od: všetky predchádzajúce fázy

- [ ] Pridať ADR pre IntentSpec a GenerationProvider boundary.
- [ ] Pridať ADR pre engine versioning a golden fixture policy.
- [ ] Zdokumentovať local generation semantics.
- [ ] Zdokumentovať rozdiel medzi pattern-local timing a project groove.
- [ ] Pridať migration path pre staré patterns bez recipe.
- [ ] Otestovať staršie projekty po reload/export/import.
- [ ] Pridať diagnostics panel pre:
  - [ ] provider
  - [ ] engine version
  - [ ] seed
  - [ ] content hash
  - [ ] repair warnings
  - [ ] quality metrics
  - [ ] generation latency
- [ ] Aktualizovať README a feature dokumentáciu.
- [ ] Pridať release checklist pre zmenu generation algorithm.

---

## Prioritizovaný backlog

### P0 — pred ďalším rozširovaním

- [x] IE-001: opraviť melodic state encoding.
- [x] IE-002: opraviť Markov smoothing a position transition.
- [x] IE-003: vyriešiť dvojité aplikovanie swing.
- [x] IE-004: zaviesť content canonicalization a hash.
- [x] IE-005: pridať golden fixtures a correctness invariants.
- [x] IE-006: oddeliť PRNG streamy podľa role/subsystému.

### P1 — lokálna produkčná kvalita

- [x] IE-010: pad roles a odstránenie magic indexov.
- [x] IE-011: hybrid template + constrained variation engine.
- [x] IE-012: multi-bar phrase plan.
- [x] IE-013: role-aware melodic parts a track mapping.
- [x] IE-014: IntentSpec, GenerationPlan, GenerationResult.
- [x] IE-015: unified preview/apply pipeline.
- [x] IE-016: Assist metadata/notes correctness.
- [x] IE-017: metrics a deterministic repair pass.

### P2 — AI readiness a hardening

- [ ] IE-020: provider interface.
- [ ] IE-021: remote AI proposal adapter.
- [ ] IE-022: AI schema validation, repair a fallback.
- [ ] IE-023: provenance, privacy, cancellation a cache.
- [ ] IE-024: project migration a diagnostics UI.
- [ ] IE-025: ADR, README a release checklist.

---

## Gate medzi fázami

Do ďalšej fázy sa ide až vtedy, keď platí:

- [ ] všetky testy predchádzajúcej fázy prechádzajú,
- [ ] existuje krátky manuálny listen-check reprezentatívnych výstupov,
- [ ] content hash a recipe sú stabilné,
- [ ] nie je otvorený P0 correctness bug,
- [ ] zmena je zdokumentovaná v changelogu alebo ADR podľa rozsahu.

## Mimo scope tejto roadmapy

- [ ] Tréning vlastného veľkého hudobného modelu.
- [ ] AI requesty v realtime audio callbacku.
- [ ] Povinná cloudová závislosť pre základné generovanie.
- [ ] Nahradenie lokálneho engine remote AI providerom.
- [ ] Neobmedzené promptovanie bez schema a quality kontroly.

## Odporúčané poradie implementácie

1. [x] Fáza 0 — baseline fixtures a hash harness.
2. [x] Fáza 1 — correctness, determinism a swing ownership.
3. [x] Fáza 2 — lokálna hudobná kvalita a role-aware generovanie.
4. [x] Fáza 3 — IntentSpec a provider-neutral pipeline.
5. [x] Fáza 4 — UI/Assist integrácia.
6. [x] Fáza 5 — quality gates a browser verification (Worker boundary zostáva follow-up).
7. [ ] Fáza 6 — voliteľný AI provider.
8. [ ] Fáza 7 — stabilizácia, migrácie a dokumentácia.

## Definition of Done

Intent Engine je pripravený na produkčné prototypovanie vtedy, keď:

- [ ] offline local provider vie vytvoriť kvalitný pattern podľa IntentSpec,
- [ ] výsledok je reprodukovateľný cez recipe a content hash,
- [ ] output prejde validáciou, repair krokom a quality gates,
- [ ] drums, bass, chords a lead majú jasné role a target mapping,
- [ ] preview, apply, undo, redo, save, reload a export fungujú konzistentne,
- [ ] AI provider sa dá pripojiť ako proposal source bez zmeny audio engine,
- [ ] sieťový request môže zlyhať bez straty lokálneho workflowu,
- [ ] engine version a provenance umožnia spätne vysvetliť každý generated pattern.
