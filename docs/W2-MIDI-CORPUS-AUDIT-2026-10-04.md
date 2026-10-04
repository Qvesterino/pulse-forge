# W2 AUDIT — Public-domain MIDI corpus: NEJDE do melodic priora (2026-10-04)

> Verdikt: **FAIL (degree) — korpus NENASADENÝ do `symbolic-melodic-v2`.**
> Pipeline + corpus zostávajú v repo ako tréningový základ pre **W1
> (harmony-aware melodic-features-v3)**, kde chord conditioning je presne to,
> čo klasický korpos poskytuje. Detail W1 hľadá nižšie.

---

## 1. Čo sa postavilo (zostáva v repo)

| Artefakt                                              | Stav                                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `scripts/fetch-midi-corpus.mjs`                       | replayovateľný downloader, **iba `license === "Public Domain"`**, SHA-1 overený                                     |
| `scripts/data/midi-corpus/manifest.json` (tracked)    | **licenčný audit trail** — 345 PD kusov s `license`, `sourceUrl`, `sha1`                                            |
| `scripts/data/midi-corpus/midi/*.mid` (gitignored)    | 345 súborov, regenerovateľné cez fetch                                                                              |
| `scripts/ingest-midi-corpus.mts`                      | MIDI → next-note vzorky: key detekcia (Krumhansl nad MIDI chroma), role split, kvantizácia, pitch→degree inverzia   |
| `scripts/data/midi-melodic-dataset.json` (gitignored) | **29 730 vzoriek / 645 skupín** z 338 kusov                                                                         |
| `scripts/append-classical-embeddings.mts`             | pridáva `classical.{baroque,classical,romantic,impressionist,modern}` do `style-embeddings.json` (194 → 199 štýlov) |
| `scripts/train-symbolic-melodic.py --midi-corpus`     | corpus merge TRAIN-only (rovnaký pattern ako `--augmented`)                                                         |
| `scripts/gate-melodic-retrain.py --midi-corpus`       | gate meria **presne ten istý** merge (zdieľaný kód) — inak by gate klamal                                           |

Ingest determinizmus: pevné poradie (katalóg), žiadny RNG vo feature pipeline,
`buildMelodicFeatureRow` zdieľaný s base generátorom (contract drift nemožný).

## 2. Čo korpus reálne pokryl (d1/d5/duration-8 diery z plánu)

| Trieda           | Knižnica (ds.v3) | MIDI korpus | Akceptácia z plánu W2 |
| ---------------- | ---------------- | ----------- | --------------------- |
| **d1** (class 2) | 0 čestných       | **3 491**   | ✅ zavretá            |
| **d5** (class 6) | 0 čestných       | **2 935**   | ✅ zavrtá             |
| **duration-8**   | 54 vzoriek       | **736**     | ✅ 13× nárast         |

**Tieto diery sa zavreli — ale za cenu, ktorá val zrúšila.**

## 3. Čo hovorí gate (pre-registrovaný, 2 aj 3-fold)

Všetky čísla: `python scripts/gate-melodic-retrain.py --embedding --weight-power 0.5 [--midi-corpus …]`
Baseline = **rovnaký fold split, bez korpusu** (apples-to-apples).

| Recept                              | 2-fold deg | 3-fold deg | 2-fold dur | 3-fold dur |
| ----------------------------------- | ---------: | ---------: | ---------: | ---------: |
| baseline (ds.v3, **bez korpusu**)   |     0.4948 |     0.5447 |     0.5587 |     0.5308 |
| + MIDI korpus (29 730, `classical`) |     0.4506 |     0.4774 |     0.5343 |     0.5517 |
| + MIDI korpus (29 730, `ambient` ¹) |     0.4681 |          — |     0.5273 |          — |
| + MIDI korpus (8 000, bez chord)    |     0.4309 |          — |          — |          — |
| + MIDI korpus (4 000, bass-only)    |          — |          — |          — |          — |

¹ pred opravou conditioning priestoru (korpus zdieľal `ambient` centroid).

**Záver: korpus znižuje degree o 0.02–0.07 robustne, vo všetkých variantoch
a oboch fold počtoch. Gate FAIL je konzistentný.**

## 4. Prečo (mechanizmus, nie výhovorka)

1. **Distribúcia je iná.** Melodic prior sa trénuje na **elektronickej** knižnici:
   house bass line má skoky (d0→d4), synkopy, krátke trvanie. Bach/Bartók
   chorál / Chopinov noktúrn: stepwise (d0→d1→d2), dlhé trvanie, legato.
   29 730 klasických riadkov **preplavá** lokálnu distribúciu → elektrónický
   val stráca ~6 pp.
2. **Conditioning kolízia (nájdená a opravená, nestačilo).** Prvá verzia zdieľala
   `ambient` centroid — korpus učil model "ambient = barokový kontrapunkt".
   `classical.*` priestor to vyriešil (`append-classical-embeddings.mts`), ale
   **degree klesol ešte viac** → conditioning nebol hlavná príčina, je to
   **obsah**.
3. **Val je elektronický.** Gate meria na `ds.v3` knižnici (house/techno/trap/
   ambient/dnb). Klasický korpus sa na tejto metrike nedá zlepšiť — zlepšuje
   len to, čo val neobsahuje.

## 5. Čo z plánu W2 sa podarilo a čo nie

| Ciel plánu                                | Stav                                                     |
| ----------------------------------------- | -------------------------------------------------------- |
| Ingest pipeline                           | ✅ hotový (deterministický, testovateľný, license-clean) |
| ≥ 5 000 base riadkov                      | ✅ 29 730                                                |
| d1/d5 čestné príklady                     | ✅ 3 491 / 2 935                                         |
| duration-8 nárast                         | ✅ 736                                                   |
| Manifest s licenciami (audit trail)       | ✅ 345 PD kusov, tracked                                 |
| Gate PASS (predpokladaný — korpus zlepší) | ❌ **FAIL (degree)** — korpus zhoršuje                   |

## 6. Rozhodnutie

1. **Korpus sa NENASADÍ do `symbolic-melodic-v2`** (gate FAIL = stop podľa
   pravidiel projektu).
2. **Pipeline + korpus zostávajú** ako tréningový základ pre **W1
   (melodic-features-v3, chord-aware)**. Klasický korpus je presne to, čo W1
   potrebuje: bohatá harmónia (bass+chord), dlhé trvania, step-wise kontúry
   a voice-leading — a s chord conditioning sa tieto vlastnosti dajú využiť
   bez toho, aby kazili elektronické žánre.
3. **`--midi-corpus` flag ostáva** v tréneri aj gate — defaultne sa nepoužíva
   (bez flagu sa presne zachová dnešné správanie). W1 ho zapne pre reálny
   experiment.
4. **`classical.*` štýly** v `style-embeddings.json` ostávajú — sú to
   _append-only_ prídavky (existujúce vektory dotknuté nie sú), takže
   dnešné artefakty sa nemenia.

## 7. Čo otvoriť pre W1 (konkrétne)

W1 (`melodic-features-v3` — chord-aware) reštartuje rovnakú otázku, ale s
podstatným rozdielom: **klasický korpus bude podmienený AKORDOM, nie žánrom**.
Ak W1 potvrdí, že chord conditioning korpus pomáha, tento korpus sa stane
prvým reálnym tréningovým zdrojom, ktorý nie je procedurálny.

**Honestná poznámka pre plán:** W2 sa nezmenil na "výhru"; zmenil sa na
"dve veci hotové (pipeline, diery) + jeden negatívny výsledok, ktorý
presmeroval korpus do W1". To je to, čo gate má robiť.

---

_Reprodukcia:_

```bash
npm run corpus:fetch        # alebo: node scripts/fetch-midi-corpus.mjs
npx vite-node scripts/ingest-midi-corpus.mts
python scripts/gate-melodic-retrain.py --embedding --weight-power 0.5                      # baseline
python scripts/gate-melodic-retrain.py --embedding --weight-power 0.5 \
  --midi-corpus scripts/data/midi-melodic-dataset.json                                     # s korpusom (FAIL)
```

_Audit: 2026-10-04. Čísla z pre-registrovaného gate; žiadny artefakt nebol
nasadený s FAIL verdiktom._
