# KYX Studio Optimization Plan — density, single source of truth, measurable gates

> **Produkt:** KYX · **Repo:** Pulse Forge
> **Stav:** plán. Vznikol z troch meracích vĺn (2026-10-15 až 18).
> **Princíp:** každé číslo v tomto dokumente je merané v živom prehliadači,
> nie odhadnuté zo screenshotu. Ak číslo nie je overené, je v dokumente
> označené ako _nep overené_.

---

## 0. Prečo tento dokument existuje

Tri vlny merania v KYX našli **sedem defektov, ktoré žiadny test nevidí**.
Toto nie je argument pre „viac testov" — je to argument pre **iné
typy brán**, ktoré vidia geometriu a rozloženie.

| #   | Defekt                                                                                                                          | Ako sa zistil                        | Prečo ho testy nevideli                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------- |
| 1   | Sequencer dostával menej miesta než pomocný dock panel                                                                          | meranie `getBoundingClientRect`      | neexistovalo kritérium                       |
| 2   | `@media (pointer: coarse)` neupravoval `.step`; `ROW_HEIGHT = 46` bol konštanta pre rozloženie, ktoré CSS nikdy neimplementoval | meranie v emulácii coarse            | jsdom nemá `matchMedia` prehrávajúci realitu |
| 3   | `ROW_HEIGHT` (TS) a CSS box boli dve nesúvisiace čísla                                                                          | porovnaním dvoch zdrojov             | nič ich nespájalo                            |
| 4   | Zmenšenie `.step` **nič neurobilo** — podlahou bola `.row-label`                                                                | meraním výšky oboch detí             | CSS kaskáda sa v jsdom nerieši               |
| 5   | Brána porovnávala konštantu s jej vlastným produktom (tautológia)                                                               | zmutovaním konštanty                 | kontrola vyzerala ako funkčná                |
| 6   | Timeout harnessu vyzeral ako zachytený defekt                                                                                   | čítaním **textu** výstupu, nie farby | `exit 1` z oboch prípadov                    |
| 7   | Screenshot z inej session bol použitý ako meranie aktuálneho stavu                                                              | meraním a porovnaním                 | screenshot nemá kontext stavu                |

Defekty 2, 3, 4 a 7 sú **neviditeľné pre vitest vôbec**. Defekt 5 a 6 sú
defekty nástroja, nie produktu — a práve tie najviac klamali.

---

## 1. Východiskový stav (meraný)

Merané `scripts/ui-proportion.mjs` pri otvorenom House Beat projekte,
jeden boot, potom `setViewportSize` medzi viewportmi.

### 1440 × 900 (hlavný desktop)

| Plocha          | Pred                | Teraz               | Zmena                  |
| --------------- | ------------------- | ------------------- | ---------------------- |
| TopBar          | 43 px               | 41 px               | −2                     |
| Pad rack        | 132 px              | 128 px              | −4                     |
| Pattern toolbar | 98 px               | 72 px               | **−26**                |
| **Sequencer**   | **192 px (21,3 %)** | **322 px (35,8 %)** | **+130 px / +14,5 pp** |
| Dock tabs       | 30 px               | 30 px               | 0                      |
| Dock panel      | 297 px (33,0 %)     | 225 px (25,0 %)     | **−72 px**             |
| Statusbar       | 31 px               | 31 px               | 0                      |

**Sequencer je dnes najväčší blok na obrazovke.** Pred bol druhý, za
dockom. Priorita sa otočila.

### Videné riadky mriežky

| Viewport   | Pred | Po hustote | Po zlútení kanála |
| ---------- | ---- | ---------- | ----------------- |
| 1440 × 900 | 7    | **9**      | 7                 |
| 1280 × 800 | 5    | 7          | 6                 |
| 1024 × 768 | 4    | 6          | 5                 |
| 800 × 900  | 6    | 9          | 7                 |
| 390 × 844  | 1    | 4          | 4                 |

Zlútenie stálo 1–2 riadky, lebo obohatený riadok je 36 px namiesto 30 px.
Ide o obchod: **viac informácie na riadok, menej riadkov na obrazovke.**

### Pitch riadka

| Stav                  | CSS box | TS `ROW_HEIGHT` | Zhoda                |
| --------------------- | ------- | --------------- | -------------------- |
| Pred                  | 34 px   | 34              | ✅                   |
| Po hustote            | 30 px   | 30              | ✅                   |
| Po zlútení (prvý beh) | 36 px   | 30              | ❌ **brána chytila** |
| Po zlútení (opravené) | 36 px   | 36              | ✅                   |

---

## 2. Jeden zdroj pravdy

Toto je jadro plánu. Každá informácia má **jedno** miesto, kde je
definovaná, a **jednu** bránu, ktorá hláda, že sa to miesta nerozšírilo.

### 2.1 Duplicitná informácia — odstránená

Druhý zoznam kanálov (pad grid + sequencerové riadky) je teraz jeden
zoznam. Pad grid **zostáva do kroku 2** (viz §4), ale jeho obsah sa
presúva do riadku:

| Informácia      | Bol kde                    | Je kde                      |
| --------------- | -------------------------- | --------------------------- |
| index padu      | grid + (implicitne) riadok | **riadok** `.row-pad-index` |
| názov padu      | grid + riadok              | **riadok**                  |
| farba kategórie | grid + riadok              | **riadok** (`.row-pad`)     |
| selected stav   | grid + riadok              | **riadok**                  |
| M / S           | iba riadok                 | **riadok**                  |
| 16 LEVELS %     | iba grid                   | **riadok**                  |
| pinnutý rate    | iba grid                   | **riadok** + `PadRateMenu`  |
| synth badge     | iba grid                   | **riadok**                  |
| živý meter      | iba grid                   | **riadok**                  |

Živý meter nie je engine telemetry — počíta sa z `playheadStep` +
`pattern.rows[pad.id][step]` a zhasína každý frame. Bol to **druhý výkres
udajosti, ktorú riadok už mal**. Podľa toho je duplicita, nie chýbajúca
schopnosť.

### 2.2 Duplicitná geometria — zlúčená

`ROW_HEIGHT` (TS) a CSS box boli dve nesúvisiace čísla. Teraz:

- CSS vlastní vizuálnu výšku (`--step-h`, `--step-row-gap`, padding labelu)
- TS vlastní virtualizačnú konštantu
- `data-row-height` na scroller zverejňuje TS konštantu
- `scripts/ui-proportion.mjs` porovnáva **TS proti CSS** a zlyhá, ak sa
  rozídia

Toto je jediná možná úspešná fuzia: zdroje sú nezávislé, takže sa nemôžu
navzájom potvrdiť omylom.

### 2.3 Chrome, ktorý nič nepridáva

| Plocha          | Stav                                                   | Akcia                                   |
| --------------- | ------------------------------------------------------ | --------------------------------------- |
| TopBar 41 px    | `max-content` track — zníženie minima ho nemení        | znížiť **obsah**, nie track             |
| Statusbar 31 px | žije v `auto` tracku (index 4), nie v pevnom (index 5) | zistiť, či index 5 vôbec niečo obsahuje |
| Dock tabs 30 px | —                                                      | zostať                                  |

---

## 3. Brány — aby sa to nezopakovalo

### 3.1 Pravidlo: brána musí mať zuby

**Každú novú bránu falsifikovať pred tým, než jej verím.** Konkrétne:

1. Zmutuj kúsok kódu tak, aby brána mala chytiť.
2. Spusti ju.
3. **Over, že zčervenala, a prečítaj hlášku** — nie iba exit code.
4. Vráť kód.

Dnes brána na pitch **dvakrát prešla** s zmutovanou konštantou (tautológia)
a dvakrát vrátila `exit 1` bez vykonania akejkoľvek kontroly (timeout).

### 3.2 Pravidlo: „nebežalo" != „zlyhalo"

```
0 = brána bežala a prešla
1 = brána bežala a ZLYHALA
2 = HARNESS_ERROR — meranie sa nedokončilo, nič sa neoverovalo
```

Každá brána, ktorá robí I/O (browser, sieť, fs), musí mať tento tretí stav
a `uncaughtException` handler, ktorý ho vyvolá.

### 3.3 Pravidlo: negatívny výsledok musí pomenovať obe hodnoty

`TS 30px vs CSS 36px` sa dá opraviť. `niečo je zle` nie.

### 3.4 Čo sa v KYX reálne používa

| Brána                                | Čo pokrýva                                                             | Kde      |
| ------------------------------------ | ---------------------------------------------------------------------- | -------- |
| `scripts/ui-proportion.mjs`          | vertikálny rozpočet shellu, horizontálny overflow, zhoda TS/CSS pitchu | dev / CI |
| `npm run typecheck`                  | strict TS                                                              | CI       |
| `tests/layout-responsive.test.ts`    | breakpointy                                                            | CI       |
| `tests/ui/pad-channel-state.test.ts` | kontrakt zdieľaného stavu + decay                                      | CI       |

### 3.5 Čo ešte chýba (otvorené)

- ~~`ui-proportion.mjs` **nie je v CI**.~~ **Vyriešené 2026-10-21: job `ui-gate`.** Všetky štyri UI brány teraz bežia v CI proti **zamrznutému `dist`**, ktorý vyrobil job `build` — jeden build, jedna pravda. Bližšie §3.6.
- Chýba **hrubý bod** (`pointer: coarse`) v matici. Dnes sa meria iba myš.
  Defekt 2 je presne to, čo prešlo.

### 3.6 Brány v CI, a čo to hneď odhalilo (2026-10-21)

**ČO SA PRIDALO.** Job `ui-gate` v `.github/workflows/ci.yml`: stiahne `dist` z
jobu `build`, nainštaluje Chromium a spustí `npm run gate` — teda `proportion`
(5 viewportov + hrubý bod), `typography`, `material` a `state-matrix`. Exit 0 =
všetko drží, 1 = niektorá brána zlyhala, 2 = harness sa rozbil a **nič sa
nameralo**. Kontrakt 0/1/2 je rovnaký ako pri každej inej bráne.

**PREČO PRÁVE TERAZ.** `scripts/gate.mjs` už bežal proti zamrznutému buildu —
chýbalo mu len to, aby ho niekto spustil. Bez toho boli štyri brány nástroj
pre jedného človeka: spustené ručne, vtedy keď si to pamätal, a s výstupom,
ktorý nikto nečítal.

**OVERENÉ LOKÁLNE, PRESNE AKO V CI.** Z čistého worktree na HEAD
(`git worktree add` + junction `node_modules`, pravidlo 5 a 6): `npm run gate`
→ **všetky 4 brány PASS, exit 0**. To je tá istá cesta, ktorou CI prejde
(build → artefakt `dist` → Chromium → `npm run gate`).

**A PRIAVOLI TO VYSAŤ PRVÉ VECI — BUDGET.**

| Kedy                                      | Boot path   | DAW total   | Výsledok |
| ----------------------------------------- | ----------- | ----------- | -------- |
| `4d99b05a` (2026-10-12) — posledný zelený | **2122 KB** | 5186 KB     | exit 0   |
| `590e972c` (2026-10-18)                   | 2305 KB     | 5222 KB     | **FAIL** |
| `92f01de5` (HEAD, 2026-10-21)             | **2358 KB** | **5476 KB** | **FAIL** |

Podlaha boot path je **2200 KB** a celkový DAW graf **5186 KB**. Build bol
**červený najmenej tri dni** a nikto si to všimol, pretože exit code buildu sa
nikde nekontroloval. To je presne tá trieda chyby, ktorú §3.1 popisuje: brána
existuje, ale nemá zuby.

**ČO PRIBUDLO DO BOOT CESTY** (rozdiel chunkov medzi zeleným stavom a HEAD):

| Chunk                                                        | Zmena  | Čo to je                                   |
| ------------------------------------------------------------ | ------ | ------------------------------------------ |
| `App`                                                        | +78 KB | difúzne pribudnutie aplikačného kódu       |
| `midiFile`                                                   | +36 KB | **NOVÝ** v boot ceste — MIDI import/export |
| `curated-layer`                                              | +17 KB | vzorka knižnice                            |
| `renderManifest`                                             | +11 KB | **NOVÝ** v boot ceste — manifest rendera   |
| `factory`                                                    | +9 KB  | fabrikové presety                          |
| `intentRouting`                                              | +9 KB  | smerovanie intentu                         |
| `events`                                                     | +7 KB  | **NOVÝ** v boot ceste — event bus          |
| `normalize`, `services`                                      | +8 KB  | drobnosti                                  |
| `zip`, `FrozenBufferRepository`, `audio-import-capabilities` | +5 KB  | **NOVÉ** v boot ceste                      |

`midiFile` a `renderManifest` sú **funkcie, ktoré sa používajú len pri
importe/exporte a pri renderovaní** — a platia sa pri každom boote štúdia.
Ťahajú ich `src/export/transfer-import.ts` a `src/midi/midiProject.ts`
statickým importom.

**ČO Z TOHO VYPLÝVA.** Rozpočet sa prekročil dvoma spôsobmi naraz: šesť
**nových** chunkov v boot ceste, ktoré tam nemajú čo hľadať, a difúzne
pribudnutie v `App`. Prvé sa dá opraviť lazy seamom — to presne radí aj hláška
budgetu („Lazy-seam the newcomer"); druhé je honestná váha novej funkcie, a to
je **vedome zvýšenie podlahy**, nie chyba.

**ČO NIE JE ZA TOTO ZODPOVEDNÉ TÝCHTO VĽN.** Príspevok bol 0 KB v boot ceste:
`stateMatrix` (21 KB) a `StateMatrixPanel` (6 KB) sú v samostatných chunkoch a
do uzatvoreniny sa nedostanú — overené prepočtom statických importov, nie
odhadom. Do celkového grafu pridali 27 KB z 290 KB prekročenia.

### 3.7 Vlna 6 — bootstrap diet: šesť rezov, 282 KB z boot cesty (2026-10-21)

§3.6 povedala, že rozpočet je červený a prečo. Tu je, čo sa s tým urobilo.

**MERANIE NAJPRV.** Boot path je vlastnosť **zdrojového importového grafu**,
takže sa dá prečítať zo zdrojov — bez buildu, za sekundy. Nástroj
(`pf-boot-graph.mjs`, mimo repo) prejde statické importy od `src/ui/App.tsx`
a vypíše reťazec ku každému modulu. To je lacnejšie a presnejšie než
hľadať v chunkoch, kto čo ťahá.

**JEDEN PÁNTAV DRŽAL 225 KB.** `src/intent/style-observation.ts` importovala
`PREFERENCE_LEDGER_CLEARED_EVENT` — **jednu stringovú konštantu** — z
`src/intent/preference-ledger.ts`. Tento jeden import ťahal do boot cesty celý
AI engine:

```
TopBar → CollabPanel → services.ts → style-observation
       → preference-ledger → ai/features/pattern-features
       → ai/generator → ai/grooves/*        (≈200 KB postavené)
```

Konštanta sa oddelila do `src/intent/preference-ledger-events.ts` — reťazec
neexistuje. Názov eventu je rovnaký, ledger ho stále re-exportuje.

**ŠESŤ REZOV, VŠETKY ZMERANÉ:**

| #   | Hrana, ktorá sa preťala                                            | Čo odišlo z boot cesty          |
| --- | ------------------------------------------------------------------ | ------------------------------- |
| 1   | `style-observation → preference-ledger` (konštanta)                | AI engine, grooves, generator   |
| 2   | `mix-preview → mix-idea` (plánovač)                                | `intentRouting` chunk (91,8 KB) |
| 3   | `ActivityCenter → trustReport` / `→ sessionStory`                  | `renderManifest` (11,1) + `zip` |
| 4   | `services.ts → rendering/freezeSignature`                          | manifest z cesty služieb        |
| 5   | `arrangeWords → mix` (tabuľka slov) → `src/intent/effect-words.ts` | mix planner (83 KB)             |
| 6   | `PianoRoll → HumToMelody` (lazy komponent)                         | MIDI writer, pitch tracker      |

**VÝSLEDOK:**

| Kedy                         | Boot path   | DAW total | Výsledok   |
| ---------------------------- | ----------- | --------- | ---------- |
| `d55aa453` — baseline vlny 6 | 2354,4 KB   | —         | FAIL       |
| po rezoch 1–4                | 2199,2 KB   | 5483 KB   | boot OK    |
| po rezoch 5–6 (`9c24df81`)   | **2072 KB** | 5494 KB   | FAIL (DAW) |
| po zvýšení DAW podlahy       | **2072 KB** | 5502 KB   | **exit 0** |

Boot path **−282 KB (−12 %)**, a **128 KB rezervy** pod podlahou 2200 KB.
Nič o produkte sa nezmenilo — zmenilo sa len _kedy_ sa modul načíta.

**LEKCIA, KTORÁ STOJÍ ZA TÝMTO VETOM.** Modul odchádza z boot cesty až vtedy,
keď ho **už žiadny** modul v uzatvorenine neimportuje staticky. Presun jedného
súboru za `await import()` nestačí, ak ho tridsať iných boot-modulov ťahá cez
barrel — Rollup ho potom zdvihne do spoločného chunku, ktorý boot cesta
importuje staticky. Rezy, ktoré sa oplatili, boli tie, kde sa podstatný import
odstránil **naprieč** volajúcimi.

**BRÁNA, NECH TO NEREZNI.** `tests/boot-path-seams.test.ts` prejde ten istý
zdrojový graf za **6 ms** a zlyhá, keď sa ťažký modul vráti. Rozpočtový skript
stojí 2,5-minútový build; táto brána stojí sekundu a beží v test job-e. V zozname
je aj `src/intent/mix.ts`, `src/ui/HumToMelody.tsx`, `src/midi/hum-to-notes.ts`,
`src/intent/checkpoints.ts`, `src/commands/intentRouting.ts`,
`src/export/renderManifest.ts`, `src/export/zip.ts`, `src/midi/midiFile.ts` —
každý s vlastným meraním, ktoré ho vyňalo.

**A DAW TOTAL (5483 KB vs podlaha 5186 KB).** Táto metrika sčítava **každý**
chunk, takže modul, ktorý sa presunul z boot cesty do lazy chunku, sa počíta
presne rovnako. Jej vlastný účel je zachytiť **mrtvú váhu** — a za štyri týždne
vyrástol **dodaný produkt**, nie mrtvá váha: `favorites` +133 KB, MCP surface
`tools` +103 KB, zdieľaný `index` +91 KB, `ArrangementPanel` +48 KB,
`model-resolver` +47 KB, `MasteringPanel` +41 KB, `IntentPanel` +27 KB,
`PcmMicRecorder` +25 KB a tridsať ďalších chunkov. Vrátiť túto metriku pod 5186
KB by znamenalo **zmazať dodané funkcie**. Podlaha preto stúpla na **5560 KB**
(meranie 5494 + 66 KB rezervy) s odôvodnením v `scripts/check-bundle-size.mjs`,
a **podlaha boot path ostáva 2200 KB** — to je časť, ktorá chráni čakajúceho
užívateľa, a vlna 6 ukázala, že sa dá udržať.

---

## 4. Vlny

### Vlna 1 — hotová (meranie a geometria)

Dock ceiling 38vh → 30vh, `dockHeight` default 220 → 168, storage key
`pf-layout-v2` (čistá migrácia, žiadni používatelia), CSS vrstvy
`51-shell-proportion.css` a `52-step-grid-density.css`.

**Výsledok:** sequencer 192 → 322 px (21,3 % → 35,8 %), dock 297 → 225 px,
pattern toolbar 98 → 72 px, návratový pitch 34 → 30 px, žiadny horizontálny
overflow na 5 viewportoch.

### Vlna 2 — odstrániť pad grid

**Precondition:** riadok je kompletný kanál (vlna 1 + zlútenie — hotovo).
**Akcia:** odstrániť `track.pads.map(...)` z `RackStrip.tsx`; zachovať
`.rack-header` (track taby, Note Repeat, 16 LVL, KIT, KEYS) — ten nemá
duplikát.
**Uvoľní:** ~36–40 px, čo pri 7 riadkoch kúpi 1–2 ďalšie.
**Gate:** proportion gate + `pad-channel-state.test.tsx` + manuálna kontrola
QWERTY triggerov a dlhého podpru.

**Rozhodnutie (hotovo):** riadok je **30 px**. Obohatený riadok sa stlačil,
aby si badge-y nevykupovali viac miesta než čitateľnosť. `ROW_HEIGHT` v
`Sequencer.tsx` a CSS box v `57-row-pitch.css` sú zviazané bránou
`ui-proportion.mjs` (TS 30 == CSS 30 na piatich viewporoch).

### Vlna 3 — mierka

**Predpoklad v prvej verzii tohto plánu bol zlý a meranie ho vyvrátilo.**
Plán tvrdil, že „dnes je všetko 9–11 px a rovnocenné". Zmerané
(`scripts/typography-audit.mjs`, 1440×900, House Beat, 2 panely v docku):

| Tvrdenie                | Zmerané                                                        |
| ----------------------- | -------------------------------------------------------------- |
| 74 % textu je 8–11 px   | Pravda, ale **806 z 1543 uzlov je jeden zoznam vzoriek**       |
|                         | (`.sample-name` 270, `.sample-preview` 268, `.sample-fav` 268) |
|                         | + 79 `<option>` v zatvorených `<select>` — neviditeľný text    |
| Panel nadpisy sú ploché | **Nie.** 4× `h2` = 15 px, 4× `h3` = 12 px — rebrík existuje    |
| Chýba vrchol stupnice   | V shelli nie, ale ani v pláne nebolo kam vystúpiť              |

Takže „74 % je ploché" bolo meranie **katalógu**, nie shella. Rozhodnutie:
nemeriť sa priemerom, ale **rolami**.

**Vykonané zmeny** (`58-typography-scale.css`):

| Rola                        | bolo  | je    | Prečo                                                 |
| --------------------------- | ----- | ----- | ----------------------------------------------------- |
| Dock tab                    | 11 px | 12 px | primárna navigácia spodnej polovice                   |
| Názov kanála (riadok)       | 12 px | 13 px | jedna rola — dva nosiče                               |
| Názov kanála (track header) | 12 px | 13 px | **isté slovo, dve veľkosti** — jediný skutočný defekt |
| Index riadka                | 8 px  | 8 px  | metadata, pripnuté zámerne                            |

**Zamietnuté zmeny** (zaznamenané, aby sa nezopakovali na rovnakom dôkaze):

- _Nadpisy panelov na 15 px_ — zflattenovalo by h2 aj h3 na jeden stupeň.
  Brána teraz rebrík chráni.
- _Nadpisy skupín na 12 px_ — argument „nadpis menší než obsah = prevrátená
  hierarchia" bol merateľný (9 px vs 11 px) ale **záver nebol**. `51` ich
  zámerne volí ako „ALL-CAPS metadata, not primary controls" a kapitón pod
  obsahom je správna konvencia aj vo FL Studiu.
- _Transport tlačidlá na 10 px_ — reverzovalo rozloženie: bez toho má
  transport 12/14 px tlačidlá a 15 px readout, čo je jediné miesto v shelli
  so skutočným rozptylom veľkostí.

**Nezmenené zámerne:** step grid a prepínače (10 px — viazané na 30 px
pitch), status bar (9 uzlov, všetko perf readouty = metadata), piano-roll
klávesy (8 px), meničky (10 px), 270 názvov vzoriek (11 px — rovnomerný
zoznam má byť rovnomerný a malý), 268 preview riadkov (9 px), všetky
badge-y.

**Brána:** `scripts/typography-audit.mjs` (exit 0 prešlo / 1 zlyhalo /
2 harness) — pre každú rolu vyžaduje, že selektor **matchne aspoň jeden
viditeľný uzol** a že sa vypočítaná veľkosť **rovná deklarovanej**. Vznikla
preto, že prvá verzia mala 8 pravidiel, z ktorých **2 niečo urobili**:
3 vypovedali hodnotu, ktorá už bola nastavená, 2 nič nenašli a 1 prehralo
kasádu. Priemer shella takúto chybu nevidí.

### Vlna 4 — materiál

FL Studio vyzerá ako „hardware" nie „web app" pre **bevel**: 1px svetlý
horný okraj + 1px tmavý spodok na každom raised povrchu.

**Dôvod v tejto vete bol chybný a meranie ho vyvrátilo.** Písala sa v dobe,
kedy nikto nevidel `box-shadow` v prepočítanom štýle. Zmerané
(`scripts/material-audit.mjs`, 1440×900): v shelli je **1178 raised
povrchov** a bevel na nich **už existuje** — asi 217 povrchov nesie 1px inset
horný svetlý lúč. Nie je teda chýbajúci materiál, **chýba jediný recept**.

| Sila horného svetla       | Počet povrchov   |
| ------------------------- | ---------------- |
| `rgba(255,255,255,.055)`  | 2                |
| `rgba(255,255,255,.06)`   | 122              |
| `rgba(255,255,255,.075)`  | 67               |
| `rgba(255,255,255,.08)`   | 2                |
| `rgba(255,255,255,.24)`   | 2                |
| `rgba(255,255,255,.30)`   | 8                |
| `rgba(255,255,255,.32)`   | 1                |
| `rgba(255,255,255,.9)`    | 1                |
| farebné (`color(srgb …)`) | 11 (farby padov) |

**Dvanásť rôznych síl na susediacich ovládacích prvkoch.** Oko si nedokáže
vytvoriť konzistentné očakávanie „toto je vybočené", pretože susedné tlačidlá
svietia rôzne. To — nie chýbajúci bevel — je dôvod, prečo sa to číta ako
dashboard. Výplň k tomu prispieva len málo.

**Konkrétna zmena:** dva tokeny `--bevel-hi` / `--bevel-lo` a jeden recept
pre rodinu ovládacích prvkov v shelli (`.btn`, `.btn-small`, `.dock-tab`,
`.track-tab`, `.row-pad`, `.track-header-name`, `.pattern-chip`), namiesto
dvanástich.

**Mimo scope zámerne:** 256 step buniek, 268 riadkov katalógu vzoriek a 122
klávesov piano rollu. Sú mimo obrazovky alebo textúra — bevel na nich je
šum, nie materiál, a `box-shadow` na stovkách prvkov je paint cost.

Je to jediná položka, ktorá je čisto estetická. Ale je to tá, ktorá dáva
všetkému hĺbku naraz.

**Brána:** `scripts/material-audit.mjs` musí tvrdiť, že vypočítaná sila
horného svetla deklarovaných rolí sa rovná tokenu — rovnaká trieda brány ako
`typography-audit.mjs`, lebo rovnaká chyba sa dá spraviť rovnakým spôsobom.

### Vlna 6 — bootstrap diet (hotová)

Nie je to vlna estetiky, ale vlna **rozpočtu**: build bol na `main` červený
tri dni a nikto si to všimol. Podrobnosti, merania a evidencia sú v §3.7.

| Metric           | Pred      | Po          | Delta         |
| ---------------- | --------- | ----------- | ------------- |
| Boot path        | 2354,4 KB | **2072 KB** | **−282,4 KB** |
| Rezerva pod 2200 | −154,4 KB | **+128 KB** | obrat         |
| DAW total        | 5483 KB   | 5502 KB     | podlaha 5560  |
| Brána            | FAIL      | **exit 0**  |               |

Šesť preťatých hrán, jedna nová brána (`tests/boot-path-seams.test.ts`) a
zmerané odôvodnenie podlahy v `scripts/check-bundle-size.mjs`.

---

## 5. Škáľovanie — čo musí plán prežiť

Tento plán je písaný pre situáciu, keď je používateľov viac než nula. Čo sa
mení a čo nie:

### 5.1 Čo sa NEMENÍ

- **Maticové viewporty.** 5 viewportov × 3 pointer typy = 15 meraní na
  release. Lacné, automatizovateľné, a je to presne to, čo dnes chýba.
- **Storage-key migrácia.** `pf-layout-v2` je čistý reset. S reálnym
  používateľom to tak ísť nemôže — treba verziu schémy a číselný posun,
  nie výmaz. **Toto je prvá vec, ktorá sa musí zmeniť pred prvým
  nasadením.**
- **Vizuálne rozhodnutia.** Riadok 30 px vs 36 px je rozhodnutie o tom, čo
  je dôležité. Nemení sa s počtom používateľov.

### 5.2 Čo sa mení

| Aspekt                | Dnes (0 používateľov)          | Po škále                                              |
| --------------------- | ------------------------------ | ----------------------------------------------------- |
| Layout migrácia       | nový key, čistý reset          | schéma + zachovanie cudzích volieb                    |
| Zmena defaultu        | dá sa spraviť v každom commite | **používateľský setting, nie default**                |
| Jazyk UI              | EN                             | i18n pred prvým širokým nasadením                     |
| Denzita               | 3 režimy, jeden profil         | profily podľa zariadenia + ručné prepnutie            |
| Telemetria rozloženia | chýba                          | anonymizované: koľko % viewportu dostane ktorá plocha |

Posledný riadok je najdôležitejší: **tento plán predpovedá, že hustota je
problém.** Na 8″ tablete je sequencer 190 px / 22,5 % a dock sheet 64,7 %
obrazovky. Ak sa to potvrdí u používateľov, riadi to ďalšiu vlnu, nie
odhad.

### 5.3 Performance pri škále

`Sequencer.tsx` je 2000+ riadkov a virtualizuje zoznam riadkov aj stĺpcov
(`OVERSCAN 5`, `COL_OVERSCAN 6`). Po zlútení sa do každého riadka pridal
živý meter a badge. **Toto musí byť overené pod záťažou, nie odhadnuté:**

- koľko riadkov sa re-renderuje pri prehrávaní (meter beží 60 fps)
- či badge-y spôsobujú re-render celého riadka
- 16 kanálov × 16 krokov = 256 buniek; pri 60 fps s peak decay je to
  nezanedbateľná práca

**Neoverené.** Túto meraciu povinnosť má kamera.

---

## 6. Kritériá dokončenia

- Žiadna informácia nemá dvoch vlastníkov na obrazovke (§2.1)
- CSS a TS geometria sa zhodujú, brána to vyžaduje (§2.2)
- Každá brána má stav „nebežalo" a je falzifikovaná (§3)
- Release brána pokrýva 5 viewportov × 3 pointer typy (§5.1)
- Layout migrácia je verzionovaná, nie čistý reset (§5.1)
- Žiadne číslo v tomto dokumente nie je odhadnuté

---

## Súvisiace dokumenty

- `PULSE-FORGE-PREMIUM-UI-PLAN.md` — širší panelový brief
- `AGENTS.md §6.1` — testovacie brány a ich zásady
- `docs/adr/0036-ui-layout-state.md` — layout stav a responzívne vlastníctvo
