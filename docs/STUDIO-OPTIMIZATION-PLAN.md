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

- `ui-proportion.mjs` **nie je v CI**. Bez dev servera v jobe je mŕtvy.
  Kým sa nezapojí, je to nástroj pre jedného človeka, nie brána pre produkt.
- Chýba **hrubý bod** (`pointer: coarse`) v matici. Dnes sa meria iba myš.
  Defekt 2 je presne to, čo prešlo.

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

| Tvrdenie                | Zmerané                                                       |
| ----------------------- | ------------------------------------------------------------- |
| 74 % textu je 8–11 px   | Pravda, ale **806 z 1543 uzlov je jeden zoznam vzoriek**      |
|                         | (`.sample-name` 270, `.sample-preview` 268, `.sample-fav` 268) |
|                         | + 79 `<option>` v zatvorených `<select>` — neviditeľný text    |
| Panel nadpisy sú ploché | **Nie.** 4× `h2` = 15 px, 4× `h3` = 12 px — rebrík existuje     |
| Chýba vrchol stupnice   | V shelli nie, ale ani v pláne nebolo kam vystúpiť              |

Takže „74 % je ploché" bolo meranie **katalógu**, nie shella. Rozhodnutie:
nemeriť sa priemerom, ale **rolami**.

**Vykonané zmeny** (`58-typography-scale.css`):

| Rola              | bolo  | je    | Prečo                                          |
| ----------------- | ----- | ----- | ---------------------------------------------- |
| Dock tab          | 11 px | 12 px | primárna navigácia spodnej polovice            |
| Názov kanála (riadok)  | 12 px | 13 px | jedna rola — dva nosiče                      |
| Názov kanála (track header) | 12 px | 13 px | **isté slovo, dve veľkosti** — jediný skutočný defekt |
| Index riadka      | 8 px  | 8 px  | metadata, pripnuté zámerne                     |

**Zamietnuté zmeny** (zaznamenané, aby sa nezopakovali na rovnakom dôkaze):

- *Nadpisy panelov na 15 px* — zflattenovalo by h2 aj h3 na jeden stupeň.
  Brána teraz rebrík chráni.
- *Nadpisy skupín na 12 px* — argument „nadpis menší než obsah = prevrátená
  hierarchia" bol merateľný (9 px vs 11 px) ale **záver nebol**. `51` ich
  zámerne volí ako „ALL-CAPS metadata, not primary controls" a kapitón pod
  obsahom je správna konvencia aj vo FL Studiu.
- *Transport tlačidlá na 10 px* — reverzovalo rozloženie: bez toho má
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
horný okraj + 1px tmavý spodok na každom raised povrchu. Dnes KYX má ploché
plochy s tenkými hranicami → číta sa to ako debug dashboard.

Je to jediná položka, ktorá je čisto estetická. Ale je to tá, ktorá dáva
všetkému hĺbku naraz.

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
