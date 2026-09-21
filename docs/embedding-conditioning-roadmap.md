# IMPLEMENTATION ROADMAP — Embedding-Conditioned Generation (#4)

> "Dark rainy Berlin techno" a "sunny Ibiza techno" by mali produkovať
> ROZDIELNÉ patterny. Dnes dávajú rovnaký one-hot vektor — a to je tá medzera.
>
> Status: ROADMAP — pripravený na implementáciu po krokoch.
> Predpoklad: MiniLM embedding model je fetchnutý a beží (§5.8b semantic layer).

---

## 0. VEĽKÝ OBRAZ — prečo one-hot nestačí

Dnes prior model dostáva:

```
drum prior input (44):  [genre_onehot(4) | style_onehot(21) | step(5) | flags(2) + structural(12)]
melodic prior input(29): [genre_onehot(4) | style_onehot(N) | role(3) + position(8) + context(9) + flags(5)]
```

Genre a style sú DISKRÉTNE triedy. "Berlin techno" a "Ibiza techno" sú
obaja `techno` — model medzi nimi nevidí rozdiel. Embedding conditioning
nahrádza binárne žánre/styleStyle KONTINUÁLNYM semantickým vektorom:

```
v2 input (35): [semantic_projection(16) | role(3) | position(8) | context(9)]
```

**Prečo 16 a nie 384?** MiniLM 384-dim embedding je príliš široký pre malý
MLP prior (~20 kB). 384 vstupov by znamenal ~12k parametrov iba v prvej
vrstve. PCA na 16 hlavných komponentov zachytí 90 %+ variance a prior
ostáva malý (~20 kB).

**Prečo je to LEPSIE:** model sa učí z textového priestoru — "dark" a
"aggressive" sú blízko seba v embedding space, takže ich patterny budú
blízke. Nové žánre不需要 nové one-hot dimenzie.

---

## FÁZA A — Text-description generator (~2-3 hod)

### A.1 Čo
Pre každý pattern v knižnici procedurálne vygenerovať 20-50 textových
popisov, ktoré ho POPISUJÚ. Napríklad pre `house.deep`:

```
"deep house groove at 124"
"smooth deep house with rolling bass"
"hlboký house s jemným groove"
"melancholic deep house for late nights"
"dm deep house roller"
```

### A.2 Ako
Šablóny kombinujú:
- Žáner synonyms ("house", "deep house", "four-on-floor")
- Style descriptors ("deep", "smooth", "rolling", "jazzy")
- Mood words ("dark", "uplifting", "melancholic", "euphoric")
- Tempo references ("at 124", "slow groove", "fast peak time")
- Role words ("with heavy 808s", "choppy stabs", "soaring lead")

### A.3 Štruktúra

```
src/intent/descriptions.ts
  DESCRIBE_TEMPLATES: Array<{ pattern: RegExp, templates: string[] }>
  generateDescriptions(genre, style, mood, bpmRange): string[]
```

### A.4 Kombinované s patternami

Každý pattern z groove knižnice dostane N popisov (EN + SK).
Každý popis → MiniLM embedding → uložený ako tréningový príklad.

### A.5 Testy
- Každý groove štýl má aspoň 20 popisov
- Popisy obsahujú kľúčové slová zo svojho štýlu ("acid" pre acid techno)
- EN + SK pokrytie

---

## FÁZA B — Embedding pipeline (~1 hod)

### B.1 Čo
MiniLM embeduje každý popis → 384-dim vektor. Tieto vektory sa uložia
do enriched tréningového datasetu.

### B.2 Ako
Nový skript `scripts/embed-descriptions.mts`:

```
1. Načíta text popisy z Fázy A
2. Načíta MiniLM z public/models/semantic/
3. Pre každý popis: tokenizer → model → mean pooling → L2 normalize
4. Výstup: {text, embedding[384], metadata}
```

### B.3 Výstupný formát

```json
{
  "version": "embedding-conditional-v1",
  "embeddings": [
    { "text": "deep house groove", "vector": [0.1, -0.2, ...], "genre": "house", "style": "deep" }
  ]
}
```

### B.4 Poznámka
MiniLM embedding je deterministický (rovnaký text → rovnaký vektor).
Nemenný — model sa nemení, len číta.

---

## FÁZA C — Projection layer (~1-2 hod)

### C.1 Možnosti

| Prístup | Pros | Cons |
|---------|------|------|
| **PCA (16 komponentov)** | Žiadne tréning, deterministický | Zachytí len lineárnu varianciu |
| **UMAP (16 dims)** | Zachytí nelineárnu štruktúru | Neneterministický, pomalý |
| **Learned projection (MLP 384→16)** | Najlepší fit, trénovaný s prior | Potrebuje tréningové dáta |

### C.2 Odporúčanie pre v1: PCA
PCA na embeddings corpus (500+ popisov) → top-16 komponentov.
Deterministické, žiadne extra tréning, dobre understandované.

Uloženie: PCA matica (16×384) + mean (384) do manifest.json.
Projection: `projected = (embedding - mean) @ components.T` → 16-dim.

### C.3 Pre v2: Learned projection
Keď bude viac dát, natrénovať malý MLP projection (384→64→16) spolu
s prior modelom. To vyžaduje end-to-end tréning — väčší zásah.

---

## FÁZA D — Prior v2 architektúra (~2 hod)

### D.1 Nový feature kontrakt

```
prior-features-v2.ts:
  SEMANTIC_DIMS = 16          // PCA-projected embedding
  STRUCTURAL_DIMS = 19        // role(3) + position(5) + context(9) + flags(2)
  TOTAL_INPUT = 35            // namiesto 44

  buildPriorFeaturesV2(input: {
    embeddingProjection: number[16],  // PCA-projected MiniLM embedding
    role: PadRole,
    step: number,
    stepCount: number,
  }): number[35]
```

### D.2 Prior model v2

```
Input [N, 35] → Gemm+Relu → Gemm+Relu → Gemm → sigmoid → [N, 1]
Trunk: 35 → 64 → 32 → 1 (rovnaká architektúra ako v1)
```

### D.3 Kľúčová zmena
Žiadne genre/style one-hot. Namiesto toho **semantic projection** ktorý
kóduje žáner + style + mood + tempo v CONTINUUAálnom priestore.

Model sa učí: "embeddingy v TOMTO regióne semantic space produkujú
TAKTO vyzerajúce patterny." Nové štýly = nové regióny, nie nové one-hot.

### D.4 Spätná kompatibilita
Prior v1 (one-hot) ostáva ako FALLBACK. Prior v2 sa použije len keď:
1. Semantic layer je available (MiniLM beží)
2. Text obsahuje dostatok informácie na embedding
3. Flag `pf:embedding-conditioned` = on

---

## FÁZA E — Tréning + validácia (~1 hod)

### E.1 Tréningové dáta

```
1. Original library data (bežný dataset) — one-hot conditioning
2. Procedurálne augmented data — one-hot conditioning
3. Text-description data — embedding conditioning (nové)
```

Tréning kombinuje 1+2 pre structural features a 3 pre embedding.
Alternatívne: 3 nahradí 1+2 úplne (model sa učí čisto z text space).

### E.2 Validácia
- Held-out: žánre/style ktoré model NEVIDEL v tréningu
- Metriky: valAUC (drum), valDegreeAcc (melodic), semantic generalization
- Kľúčová otázka: **generalizuje model na NOVÉ textové popisy?**
  Test: "dark rainy berlin techno" → mal by generovať tmavé techno patterny
  aj keď "berlin" nevidel v tréningu.

### E.3 Aktivácia
`pf:embedding-conditioned = on|off` — off = one-hot v1, on = embedding v2.
Graduálny rollout: shadow → active (rovnaký vzor ako ranker).

---

## FÁZA F — Integrácia do generácie (~2 hod)

### F.1 Prior client v2

```
prior-client.ts rozšírenie:
  runPriorGridV2(embeddingProjection, structuralFeatures, bank)
  → posieľa PCA-projected embedding + structural features do prior workeru
```

### F.2 Prior worker v2

```
prior-worker.ts: nový model kind "embedding-v2"
  → rovnaký pipeline ako v1 ale s 35-dim vstupom
```

### F.3 Provider integrácia

```
SymbolicPriorProvider.collectCandidates():
  1. Text → MiniLM embedding (už beží)
  2. Embedding → PCA projection → 16-dim conditioning
  3. Conditioning + structural features → prior worker → patterny
  4. Rovnaké invarianty + ranking ako doteraz
```

---

## FÁZA G — Melodic prior v2 (~2 hod)

Rovnaký vzor ako pre drum prior, ale pre melodický model:

- Input: [semantic_projection(16) + melodic_context(13)] = 29 dims
- Output: degree(8) + duration(4) — dve hlavy
- Tréning: text popisy melodických patternov → MiniLM → PCA → tréning

---

## Časový plán

| Fáza | Čo | Effort | Kritická cesta? |
|---|---|---|---|
| A | Text description generator | 2-3 hod | Áno — bez popisov niet dát |
| B | Embedding pipeline | 1 hod | Nie — mechanické |
| C | PCA projection | 1-2 hod | Nie — štandardný math |
| D | Prior v2 architektúra | 2 hod | Áno — nový kontrakt |
| E | Tréning + validácia | 1 hod | Nie — šablóna existuje |
| F | Generácia integrácia | 2 hod | Áno — provider zmeny |
| G | Melodic prior v2 | 2 hod | Paralelne s D-F |

**Celkovo: ~11-13 hodín čistej práce.** Rozdeliť do 2-3 sessions.

---

## Čo NIEJE v scope (a prečo)

- **CLAP-style text-to-audio generation** — to je úplne iný model (niektoré
  CLAP modely generujú audio z textu). Vyžaduje 10× viac parametrov a
  GPU tréning. Far horizon.
- **Fine-tuning MiniLM** — MiniLM sa netrénuje, len používa ako feature
  extractor. Fine-tuning by vyžadoval GPU a hudobný corpus.
- **End-to-end text-to-pattern model** — transformer ktorý berie text a
  generuje pattern. To je MusicGen-tier model. Dokonale možné ale je to
  vlastný výskumný projekt.

---

## Prečo je to HODNOTA

1. **Kontinuálne conditioning** — "medzi trap a house" je reálny bod v space
2. **Neznáme popisy fungujú** — "berlin warehouse techno" bez "berlin" v slovníku
3. **Nové štýly bez pretrénovania** — nový štýl = nové popisy v korpus, nie nový model
4. **User style vector** — priemer embeddingov tvojich ★ rolliek = "tvoj zvuk" ako vektor
5. **Kompozícia** — embedding conditioning + user style vector = "moja verzia travis scott beatu"

## Riziká

1. **PCA zachytí len lineárnu varianciu** — pre nelineárne vzťahy by bolo
   potrebné learned projection (v2)
2. **MiniLM nemusí mať hudobné znalosti** — embedding "travis scott" nemusí
   byť blízko "trap" v MiniLM space. Test: skontrolovať cosine similarity
   medzi "travis scott" a "trap beat" embeddingmi. Ak sú ďaleko, treba
   fine-tuned model alebo pridať hudobné texty do PCA corpus.
3. **Prior model musí byť dostatočne veľký** aby spracoval 16-dim continuous
   input — ak je 35→64→32→1 príliš malý, zvýšiť hidden na 96.
