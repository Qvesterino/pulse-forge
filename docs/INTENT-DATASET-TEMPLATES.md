# INTENT SFT DATASET — TEMPLATE EXPANSION MANUAL

> Ako rozširovať tréningový korpus intent modelu. Tento dokument je
> príručka pre kohokoľvek (človek aj agent), kto chce pridať nové
> formulácie — anglické aj slovenské.
>
> Súvisiace: `docs/LOCAL-INTENT-MODEL.md` (pipeline a gate),
> `scripts/generate-intent-dataset.mts` (generátor),
> `src/intent/model-decoder.ts` (kanonický dekóder),
> `docs/GENRE-RESEARCH.md` (podobný workflow pre groove katalóg).

---

## 1. Prečo korpus, a čo poháňa

Intent model v1 je malý multi-head klasifikátor trénovaný na dátach, ktoré
**vygeneroval samotný engine**: každá inštrukcia sa prehrá cez
`routeIntentText` (deterministická intent vrstva) a výsledná akcia sa
zkomprimuje cez `compactIntentResponse`. Engine je učiteľ; model je študent.
Kvalita modelu je priamo previazaná na množstve a rozmanitosti templateov —
389 párov dávalo val attempted-exact ~7 %, 1192 párov výrazne viac (hodnoty
v `scripts/data/intent-model-report.json` a gate behu).

```
npm run intent:dataset      # generuje korpus (učiteľ = intent vrstva)
npm run intent-model:all    # train → manifest (grammar pin) → validate (gate)
```

Cieľový stav: gate prejde (`attempted-exact ≥ 95 %`, `wrongKind = 0`,
`abstain ≤ 20 %` na val+golden) → validate zapíše `gatePassed: true` do
manifestu → loader model zaregistruje. Kým gate neprejde, je artifact
inertný a engine beží deterministicky — **to je v poriadku a poctivé**.

---

## 2. Mapa súborov

| Súbor                                              | Rola                                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `scripts/generate-intent-dataset.mts`              | generátor: `corpus()` (kurátorské) + `augmentation()` (kombinatorické rodiny), split, dedup, golden picks |
| `scripts/data/intent-sft/{train,val,golden}.jsonl` | vygenerovaný korpus (NEUPRAVUJ RUČNE — mení sa len generátorom)                                           |
| `scripts/data/intent-sft/manifest.json`            | počty per kind/jazyk + `datasetVersion`                                                                   |
| `scripts/data/intent-model-report.json`            | tréningový report (head accuracy)                                                                         |
| `scripts/train-intent-model.py`                    | tréner (numpy → ONNX); closed triedy hláv sú corpus-odvodené                                              |
| `scripts/write-intent-model-manifest.mts`          | manifest s `grammarSha256 = sha256(toGbnfGrammar())`                                                      |
| `scripts/validate-intent-model.mts`                | release gate (exact/wrongKind/abstain/determinizmus)                                                      |
| `src/intent/model-decoder.ts`                      | kanonický featurizer + decoder — zdieľaný trénerom, validátorom aj runtime                                |
| `tests/intent-sft-golden.test.ts`                  | golden lock: live parser musí golden inštrukcie routovať ROVNAKO ako v súbore                             |
| `tests/intent-model-artifact.test.ts`              | artifact lock: grammar pin, hash piny, gate verdict                                                       |

---

## 3. Ako pridať templaty — krok za krokom

### Krok 1: Vyber miesto

- **Nové formulácie existujúcich akcií** (nové synonymá, nové slovné
  poradia) → `augmentation()` v `scripts/generate-intent-dataset.mts`.
  Kombinatorické rodiny píš ako cykly (verb × target × modifier).
- **Úplne nová jednorazová fráza** → `corpus()` (kurátorská sekcia).
- **Nový jazyk alebo nová rodina akcií** → nová sekcia v `augmentation()`
  s komentárom (pozri existujúce `── FADER ──` bloky).

### Krok 2: Pravidlá (všetky povinné)

1. **Učiteľ je prvý.** Každá inštrukcia sa routuje cez `routeIntentText`.
   Riadok, ktorý padne do `pattern`, sa TICHO VYHODÍ — to je vlastnosť, nie
   bug: do korpusu sa dostane len živá slovná zásoba. Ak tvoj templata
   zmizla, parser ju nepozná.
2. **NIKDY nemen parser, aby templata prešla, v tej istej zmene ako dáta.**
   Parser zmeny sú vlastná vlna so svojimi testami (E2E intent suite,
   SFT golden lock). Dátová vlna = len generátor + regenerácia.
   Adapter-gate pre exact ops. Templaty učiť len exact ops, ktoré dokáže
   `exactFrom` v `src/intent/model-resolver.ts` bezpečne namapovať
   (mute/solo/pan/tempo/key/gainDb/transpose/patternLength/addTrack/
   removeTrack/duplicateTrack/renameTrack). Swing, `gainDbAbsolute` a
   `patternLengthDelta` sú parser-first bez adaptera — dokým nepridá ich
   vetvy v resolveri, do korpusu NEPATRIA (model by sa učil operácie,
   ktoré runtime bezpečne nevykoná).
3. **Žiadne náhodné generovanie.** Žiadny `Math.random`, `Date.now`,
   nechronologické iterácie — korpus musí byť byte-reprodukovateľný
   (generátor má determinizmus double-run check).
4. **Dedup je podľa inštrukcie** (case-insensitive, keep-first). Duplikáty
   medzi `corpus()` a `augmentation()` sú v poriadku — prežije prvý.
5. **Žiadne genre prompty.** Vety s genre signálom ("dark techno at 140
   bpm") patria do GENERÁCIE, nie do príkazov — router ich teraz (správne)
   posiela do patternu a generátor ich zahodí.
6. **SK slovenské inflexie.** Parser de-accentuje (NFD) pred matchovaním —
   "zníž" aj "zniz" fungujú. Píš prirodzené tvary; testuj cez generátor,
   nie v hlave.

### Krok 3: Regeneruj a skontroluj

```bash
npm run intent:dataset
# pozri výstup: počty per kind. Chýbajúce rodiny = tiché dropy.
git diff scripts/data/intent-sft/manifest.json   # čo sa posunulo
```

Ak počty kind-ov stúpli tam, kde si pridával — OK. Ak nie, tvoja templata
sa ne Routovala (pozri pravidlo 1).

### Krok 4: Pretrénuj a pusti gate

```bash
npm run intent-model:all
# train (minúty) → manifest → validate: gate čísla na val+golden
```

Gate čísla sa porovnávajú s prechádzajúcim behom — **plus je plus**. Gate
semantically: `attempted-exact ≥ 95 %`, `wrongKind = 0`, `abstain ≤ 20 %`.

### Krok 5: Testy

```bash
npx vitest run tests/intent-sft-golden.test.ts tests/intent-model-artifact.test.ts tests/intent-model-loader.test.ts
```

Golden lock musí ostať zelený — ak ho zmenil route parsera (nie tvoja
vina), je to problém parserovej vlny, nie dáta.

---

## 4. Ako funguje split a golden

- **train/val**: pozícia v poradi (`i % 7 === 3` ide do val). Val je
  prelínaný s train — meria zovšeobecnenie v rámci rodiny (susedné formulácie
  tej istej kombinatorickej gridy), nie úplne nové rodiny. To je zámerné:
  runtime úloha modelu je "blízke formulácie, ktoré deterministic layer
  nechytí úplne presne".
- **golden**: fixný zoznam inštrukcií (`goldenPicks`), ktoré pinujú
  cross-kind/cross-language vzorku. Test ich re-routuje a porovná so
  súborom. **Pri pridaní rodiny pridaj 1–2 zástupcov do goldenPicks.**
  Generátor VARUJE, keď pik neexistuje (typa alebo drop).

---

## 5. Checklist pred commitom

- [ ] `npm run intent:dataset` — počty stúpli očakávane, žiadne varovania o golden pikoch
- [ ] `npm run intent-model:all` — gate čísla rovnaké alebo lepšie
- [ ] golden + artifact + loader testy zelené
- [ ] `manifest.json` má `datasetVersion` bumpnuté, ak štruktúra korpusu zmenila generáciu
- [ ] diff neobsahuje ručné editácie `train/val/golden.jsonl` (len generátor!)

## 6. Časté chyby

| Symptóm                                 | Príčina                                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Počty kind nestúpli                     | templata sa neroutovala (parser ju nepozná) — otestuj `routeIntentText` ručne                                                                                       |
| Golden pick warning                     | preklep v pike alebo parser dropol — oprav piku, nie golden súbor                                                                                                   |
| Gate zhorslil attempted-exact           | nová rodina je v konflikte so starou (rovnaké slová, iná akcia) — rozliš formulácie                                                                                 |
| Trainer varuje "unseen softmax labels"  | nová hodnota unikla do uzavretej triedy mimo derivácie — väčšinou stačí retrain; ak pretrváva, hlás (je to trainer bug)                                             |
| `grammar drift` pri validate            | niekto zmenil `model-schema.ts` — retrain je POVINNÝ (manifest pinuje gramatiku)                                                                                    |
| transpose s číslicami sa nezaregistruje | parser akceptuje len slovné počty (`one`, `two`, `three`, `an`); číslicové formy ticho padnú do patternu — použi slovné tvary alebo doplň parser v SAMOSTATNEJ vlne |
| golden pick warning po regenerácii      | pik neexistuje v korpuse (preklep, alebo parser dropol) — generátor ho vypíše a zo zlatého súboru vynechá; oprav formuláciu, nie zlatý súbor                        |

## 7. Hustota hodnôt vs. rozmanitosť fráz (merané 2026-09-28)

Dve vlny expanzie ukázali nepohodlnú pravdu: **číslicové rebríky nie sú
zadarmo**. Pridanie hustej percent/pan mriežky (pan v 5%-krokoch, percent
po 5) zvýšilo korpus, ale attempted-exact na val KLESOL (39.8 % → 26 %) —
hlavy sa učili rozlišovať takmer identické hodnoty (pan 0.15 vs 0.25) na
úkor frázovej generalizácie. Zároveň wrongKind klesol na 0 — bezpečnosť
sa zlepšila.

Pravidlo: **číslicové gridy drž na deployment-plausible hodnotách**
(pan 15/25/50/75, percent v krokoch ~10–15, bpm v bežných hraniciach),
a objem korpusu buduj FRÁZAMI — synonymá, slovné poradie, wrappers, SK/EN
variety. Frázová rodina pomáha exact aj abstain-rate; číslicová hustota
len prekáža hlávam.

## 8. Worked example — pridanie SK loudness rodiny

Loudness je najchudobnejší kind. Pridaj do `augmentation()`:

```ts
// SK loudness
sk.push("zvučnejšie");
sk.push("tiché to nechaj");
sk.push("loudness na -14");
```

Potom: `npm run intent:dataset` → ak `loudness` počet stúpol, routovanie
funguje. `npm run intent-model:all` → gate. Pridaj `"loudness na -14"` do
`goldenPicks`. Hotovo.
