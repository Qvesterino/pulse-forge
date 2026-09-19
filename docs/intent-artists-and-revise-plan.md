# PLAN: Artist "type beat" references + "more X" routing (C1 + C2)

> Plán implementácie pre dve medzery zistené pri odpovedi na otázku
> "bude to chápať aggressive / more energic / travis scott type beat?".
> Status: **PLÁN — čaká na zelenú.** Súvisí s T1 krok 2 (text embedding),
> ktorý je dlhodobejším riešením; tento plán je rýchly deterministický most.

---

## 0. Research findings (web, 2026-09-19)

Overené charakteristiky pre alias slovník (zdroje na konci):

| Referencia | Žáner | BPM | Charakter |
|---|---|---|---|
| Travis Scott | trap | 130–140 (alebo 65–75 half-time) | dark/psychedelické pads, distorted 808s, spacious reverb |
| Metro Boomin | trap | 130–140 (alebo 73–90 half-time) | dark cinematic, bells/piano loops, moody, measured |
| Rage (Carti/Yeat/Southstar) | trap | 140–170 (typ. ~155) | bright DISTORTED synth leady, punk/hype energ, ethereal pads |
| UK Drill (Central Cee) | trap/drill | ~140–145 | sliding 808s, dark, sparse |
| Boom bap (Kanye) | trap (hip-hop) | 85–95 (typ. 90) | soul chops, swung drums, warm, laid back |
| Fred again | house/UKG | 125–140 (medián ~132), minor | emotívne vocal chops, garage groove |
| Amapiano (Tyla/Rema) | house | 110–115 | log drums, jazzy, laid back |
| Ice Spice | trap | 140–150 | Bronx drill × jersey club |

Dôležité zistenie: **"drill" dnes náš parser mapuje na techno**
(`[/\bdrill\b/, "techno"]`) — to je zvláštne; drill (140–145, sliding 808s)
je bližšie trapu. Plán to opravuje.

---

## 1. C1 — Artist alias slovník (`src/intent/artists.ts`)

### 1.1 Dátový kontrakt

```ts
export interface ArtistPreset {
  /** Match phrases — de-accented lowercase; môžu obsahovať celé "X type beat". */
  names: readonly string[];
  /** Kanonický výstup — LEN existujúca slovná zásoba engine (žiadne nové能力). */
  genre: IntentGenre;
  style?: string;              // musí existovať v groove knižnici pre daný žáner
  mood?: "dark" | "aggressive" | "chill" | "energetic";
  energy?: number;             // 0..1 (override trait defaultov)
  density?: number;
  bpmRange?: [number, number];
  /** Chips v UI. */
  label: string;
}
```

Pravidlá:
- Každý preset mapuje LEN na existujúce genre/style/mood hodnoty — žiadne nové
  schopnosti engine, čistá lookup vrstva. Právne čisté: meno → štýlový popis,
  žiadne kopírovanie obsahu.
- BPM z výskumu idú do `bpmRange` → `resolvedBpm` ich respektuje.

### 1.2 Registry (prvá vlna ~16 presetov, rozšíriteľná)

| names (match) | genre | style | mood | energy | bpm |
|---|---|---|---|---|---|
| travis scott | trap | rolling | dark | 0.7 | [130,140] |
| metro boomin | trap | dark | dark | 0.65 | [130,140] |
| 21 savage | trap | dark | dark | 0.6 | [130,140] |
| playboi carti, rage beat | trap | bouncy | aggressive | 0.9 | [150,165] |
| yeat | trap | bouncy | energetic | 0.85 | [150,160] |
| southstar, kyle beat | trap | bouncy | aggressive | 0.9 | [150,160] |
| pop smoke, drill, uk drill, central cee | trap | sparse | dark | 0.65 | [140,145] |
| ice spice, jersey | trap | bouncy | energetic | 0.8 | [140,150] |
| kanye, kanye west, boom bap, boombap | trap | classic | warm | 0.55 | [86,92] |
| hip hop, hip-hop, hiphop | trap | classic | — | 0.6 | [86,95] |
| phonk | trap | drifting | dark | 0.75 | [130,140] |
| fred again | house | deep | — | 0.75 | [128,136] |
| disclosure, ukg garage (už máme žáner) | house | ukg | energetic | 0.8 | [128,135] |
| fisher, tech house | house | driving | energetic | 0.85 | [124,128] |
| amapiano, rema, tyla, afrobeat | house | afro | chill | 0.6 | [110,115] |
| swedish house mafia, big room, martin garrix | house | driving | energetic | 0.95 | [126,130] |

Poznámky:
- `rage beat` ako samostatná fráza (nie meno) — beatmaker jazyk.
- Boom bap je v engine trap žáner (GENRE_PHRASES už mapuje hip hop → trap);
  klasický style + nízke BPM + warm mood = boom bap feel.
- **Fix existing bug**: `[/\bdrill\b/, "techno"]` → premapovať na trap
  (drill = 140+ sliding 808s; techno mapping bol "tempo proximity" omylom).

### 1.3 Integrácia do `text-parser.ts`

- Nový krok PRED genre detekciou: `matchArtistPreset(lower)` —
  phrase match cez `\b` na deaccentnutom texte (rovnaká konvencia).
- Match nastaví `genre/style/mood/energy/density/bpmRange` — ALE sémantika
  "preset ako base, text ako override": explicitné slová v texte vyhrávajú
  nad presetom ("travis scott type beat bright" → mood energetic namiesto
  dark). Implementačne: preset aplikovať ako PRVÝ, trait/mood/BPM kroky nechá
  prepísať hodnoty ktoré text explicitne spomína (vnested order: artist →
  genre/style z artistu, potom bežné kroky len ak field ešte nie je set).
- `detected` chips: push `label` ("♪ travis scott").
- "type beat" fráza sa má ignorovať (žiadny zmysel pre engine) — len match.
- `routeIntentText`: artist match = pattern route (default vetva) — nič
  meniť, len parser obohatiť.

### 1.4 Testy
- "travis scott type beat" → trap/rolling/dark/[130,140]
- "travis scott type beat bright with a lead" → mood energetic (text override),
  roles +lead
- "metro boomin type beat" → trap/dark, bpm 130–140
- "rage beat" / "southstar type beat" → aggressive 150–160
- "kanye type beat" → classic/warm/86–92
- SK: "travis scott beat" funguje (type beat nepovinné)
- drill fix: "uk drill beat" → trap (nie techno)
- determinizmus + regression (existujúcich 18 parser testov nezmenených —
  OK, lebo artist match sa spustí len pri mene; "dark rolling techno"
  obsahuje žiadne meno)

---

## 2. C2 — "more X" routing (revise intent)

### 2.1 Sémantika

"more energetic" / "menej husty" = **uprav posledný výsledok, zachovaj
identitu** (rovnaký seed → rovnaký beat, zmenený charakter). To je zásadný
rozdiel oproti dnešku: teraz "more energetic" vygeneruje úplne nový pattern.

### 2.2 Grammar (`route.ts` rozšírenie)

```ts
type ReviseAttribute = "energy" | "density";
type ReviseDirection = "more" | "less";
interface ReviseIntent { attribute; direction; delta: 0.15 }
type RoutedIntent = ... | { kind: "revise"; attribute; direction; detected: string[] };
```

- **energy**: more energetic / more energic / more energy / viac energie /
  energickejšie ; less energy / calmer / menej energie / pokojnejšie
- **density**: busier / denser / more busy / hustejší / viac prvkov ;
  sparser / less busy / menej hustý / redšie
- Delta = ±0.15 na danom slideri (clamp 0..1).
- POZOR na kolízie: "more punch" ostáva MIX (punch = kompresia), nie energy.
  "calmer" dnes nie je v slovníku → pridať do route vocab len pre revise.

### 2.3 Router priorita (aktualizovaná)

1. ARRANGE — scény existujú + čisté ops
2. MIX — mix nouns/verbs + tone comparatívy (zvukové spracovanie)
3. **REVISE — "more/less + energy/density attribute"** (nové; charakter,
   nie zvuk)
4. PATTERN — default (vrátane artist presetov)

Rozhodovacie pravidlo: tone (dark/bright/warm/cold) komparatívy → MIX;
energy/density komparatívy → REVISE. Zdôvodnenie: tón = mixovanie (EQ), energia
/hustosť = obsah (noty).

### 2.4 Exekúcia v IntentPanel

- Panel si drží `lastIntentRef` (intent poslednej GENERATE/SONG generácie +
  base seed). Pri REVISE:
  `generateAsyncResult(doc, { ...lastIntent, energy: clamp01(last.energy ± 0.15) })`
  — rovnaký seed = rovnaký beat, iný charakter; výsledok ide do audition
  zoznamu ako doteraz (používateľ potvrdí USE).
- Bez poslednej generácie → fallback na GENERATE s atribútom aplikovaným na
  parsed intent (dnešné správanie, žiadna chyba).
- Status: "⚡ energy +0.15 (same seed)" — používateľ vidí, že ide o revíziu.

### 2.5 Testy
- router: "more energetic" → revise/energy/more; "menej husty" → revise/
  density/less; "more punch" → MIX (nie revise); "darker" → MIX
- panel-level: buildSong/GENERATE nastaví lastIntentRef; "more energetic"
  vygeneruje pattern s rovnakým generation.seed ale vyšším energy v intent
  snapshot; bez predchádzajúcej generácie → pattern fallback
- determinizmus: rovnaký seed + ±delta ⇒ reprodukovateľný obsah

---

## 3. Implementačné poradie a súbory

1. `src/intent/artists.ts` (nový) — registry + matchArtistPreset
2. `src/intent/text-parser.ts` — artist krok + drill fix
3. `src/intent/route.ts` — revise gramatika + priorita
4. `src/ui/IntentPanel.tsx` — lastIntentRef + revise exekúcia
5. Testy: `tests/intent-artists.test.ts` (nový), rozšíriť
   `tests/intent-text-parser.test.ts` + `tests/intent-mix-route.test.ts`
6. Docs: INTENT_ENGINE.md (§5.9) + work log

Estimate: artists.ts + parser ~1 hod; routing ~45 min; testy ~45 min.

## 4. Validation

- typecheck + full intent-area regression (133+ testov)
- nové testy: artist matching (EN + "type beat" voliteľné + text override
  priorita), revise routing + identity preservation (rovnaký seed),
  drill fix
- browser smoke: "travis scott type beat" do IntentPanelu → trap pattern,
  nie house

## 5. Zdroje (research)

- [Mixed In Key — Travis Scott Type Beat Explained](https://mixedinkey.com)
- [LANDR — How to Make a Travis Scott Type Beat](https://blog.landr.com)
- [Future Producers — trap BPM diskusia (Metro 73/81)](https://www.futureproducers.com)
- [BPM Music — Rage beats (Carti/Yeat) guide](https://blog.bpmmusic.io)
- [Tellingbeatzz — Boom Bap 85–95 BPM](https://tellingbeatzz.com)
- [mixgraph.io — Fred again BPM štatistiky](https://mixgraph.io)
- [Traktrain/BeatStars — trending type beat žánre 2025](https://traktrain.com)
- [Pixabay — Central Cee type beat objem](https://pixabay.com)
