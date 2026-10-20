# STUDIO-STATE-MATRIX.md — matica interakčných stavov

> Nadväzuje na `STUDIO-OPTIMIZATION-PLAN.md`. Ten plán hovoril o vlne 3
> („mierka") a vlne 4 („materiál"). Tento dokument plánuje **stavovú maticu** —
> meranie a dohľad nad tým, ako má shell vyzerať v jednotlivých
> interakčných stavoch, nie iba v pokoji.

---

## 1. Prečo — najväčšia slepá škvrna

Všetko, čo sa doteraz zmeralo, je **oddychový stav**: nič vybraté, nič nehrá,
nič sa nespieva, nič nie je prekreslené. A to je presne ten stav, v ktorom sa
DAW _nevyznáva_.

Dôkaz z vlastnej práce na tejto codebase:

| Zistenie                                                                           | Čo znamená                                                           |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `.track-tab` 0.32, `.row-pad` 0.08, `.track-header-name` 0.11, `.pattern-chip` 0.2 | Ich svetlo je **stavový signál** — každé nesie jantárový inset vedľa |
| Vlna 4 ich vyňala zo scope, lebo „census vzorkuje prvý element"                    | Rozhodnutie o scope bolo prijaté **na jednej vzorke** — v oslepote   |
| Všetky tri existujúce brány merali len idle                                        | Stavová hierarchia nebola pokrytá vôbec                              |

Teda: matica nie je luxus. Bez nej sa každá ďalšia vizuálna vlna rozhoduje
podľa toho, ako vyzerá prázdny shell.

---

## 2. Čo to je — jedna deklarácia, dva spotrebitelia

```
                  src/ui/stateMatrix.ts
                  (čisto dátový modul, bez Reacta)
                            │
        ┌───────────────────┴───────────────────┐
        │                                       │
  ┌─────▼──────┐                        ┌───────▼────────┐
  │ Diagnostics│                        │ state-matrix   │
  │ panel      │                        │ gate (.mts)    │
  │ "STATE"    │                        │ exit 0/1/2     │
  │ tab        │                        │                │
  └────────────┘                        └────────────────┘
   používateľ vidí                     brána vyhodnocuje
   deklarované + živé                  deklarované
```

Jeden zdroj pravdy. Panel a brána sa nemôžu rozejdenť, lebo čítajú to isté.

**Prečo oba?** Lebo každý zodpovedá inému:

- brána hovorí _"vyhovuješ?"_ — a vie zlyhať;
- panel hovorí _"čo sa má diať?"_ — a to potrebuje človek, ktorý nevie
  prečítať `git diff` a potrebuje vidieť, že „vybraný kanál = jantárový pruh
  vľavo, 13 px názov".

---

## 3. Čo už v repo existuje — nebudeme to stavať nanovo

Tri veci som pri plánovaní našiel a každá z nich mení návrh:

| Nájdené                         | Čo z toho vyplynie                                                                                                                                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ui/Diagnostics.tsx`        | Tab ide **do existujúceho panelu**. Nový chrome by bol porušenie pravidla 4.1.                                                                                                                                               |
| `src/ui/sessionStateSurface.ts` | **Vzor** drobnej observovateľnej plochy: publish / get / subscribe, notifikácia sa preskočí, keď sa nič nezmenilo. Navyše dáva stav `armed` zadarmo.                                                                         |
| `src/ui/tokenCatalog.ts`        | **Vzor** toho, ako má vyzerať „užívateľ vidí tokeny": explicitný katalóg, nie CSS scrape, hint pre každý riadok, a test pinovaný proti skutočnému `:root`, ktorý padá **oboma smermi** — mŕtvy riadok aj neviditeľný riadok. |

Stavová matica má používať **presne tie isté dva vzory**. A „kontrastovo
overený" `26-settings-glass.css` je zrejme myslený ako pinovaný test
podľa `tokenCatalog`, nie ako brána — to je dôvod, prečo dnes nikto nevie,
či je stále v súlade.

---

## 4. Stavy — a poctivé hranice, čo sa dá zmerať

| Stav        | Ako sa doň dostaneme              | Merateľný headless? | Čo sa mení                       |
| ----------- | --------------------------------- | ------------------- | -------------------------------- |
| `idle`      | štúdio otvorené, nič vybraté      | ✅                  | základ                           |
| `selected`  | klik na padový riadok / stopu     | ✅                  | jantárové značky výberu          |
| `armed`     | označiť stopu na nahravanie       | ✅                  | `armedTrackNames` nie je prázdny |
| `playing`   | klik na tlačidlo prehrávania      | ✅                  | playhead, zelený stav, meter     |
| `paused`    | klik na prehrávanie po hraní      | ✅                  | pozícia stojí                    |
| `hover`     | `page.hover()` na ovládacom prvku | ✅                  | hover zvýraznenie                |
| `focus`     | `page.focus()` (klávesnica)       | ✅                  | fokus prstenec                   |
| `recording` | klik na REC                       | ⚠️ **treba overiť** | červený stav nahrávania          |

**`recording` nie je bežne merateľný, ale možno ho otvoriť.** Chromium vie
falzifikovať zariadenie: `--use-fake-ui-for-media-stream` +
`--use-fake-device-for-media-stream` obída dialóg povolenia mikrofónu. To
treba **overiť**, nie predpokladať — a kým to overené nie je, stav ostáva
v tabuľke označený.

Toto nie je prekážka, ktorú treba obísť hackom, ani dôvod zanedbať stav. Je
to **fakt, ktorý treba oznámiť**.

Konkrétne: `recording` bude v matici **deklarovaný, ale neoverený**, kým sa
nepodarí ho zmerať. Brána nesmie vyhlásiť „STATE PASS" bez toho, aby
povedala, ktoré bunky mala skutočne zmerané a ktoré nie.

Toto je tá istá zásada, ktorá už raz zachránila tento projekt: **brána musí
vedieť rozlíšiť „zlyhalo" od „nikdy nebežalo"**.

---

## 5. Nekorušivosť — tvrdé pravidlá

Toto je explicitná požiadavka. Pravidlá sú záväzné, nie želania.

1. **Žiadna nová plocha v chrome.** Tab je vnútri existujúceho Diagnostics
   panela (`src/ui/Diagnostics.tsx`). Žiadny nový topbar tlačidlo, žiadny nový
   dock slot, žiadny nový prekryv.
2. **Panel je zatvorený predvolene** — otvára ho existujúce topbar tlačidlo
   (`App.tsx:444`, `diagnosticsOpen`). Otvorenie nič nemení v layoute shellu.
3. **Žiadny nový polling.** Tab ENGINE dnes polluje `services.getDiagnostics()`
   každých 400 ms. Nový tab sa **neopakuje** — použije
   `services.transport.subscribePlaying()` a odber selection stavu. Meranie
   prebehne len pri otvorení tabu a pri zmene stavu, nie v slučke.
4. **Merací kód je lazy.** `Diagnostics.tsx` má vlastnú poznámku, že eager
   import „parked the whole measurement harness in the studio boot graph".
   Merací modul sa preto načíta cez `await import(...)` až pri kliknutí na
   tab — inak by sa merací harness vrátil do boot grafu.
5. **Zero impact, kým je zatvorený.** Merací modul sa nedynamicky neimportuje
   a žiadny listener nebeží, kým používateľ tab neotvorí.

---

## 6. Priehľadnosť — používateľ musí vedieť, čo sa deje

1. Tab má **svojpomenujúci nadpis**: `STATE MATRIX` + riadok „how the shell is
   supposed to look in each interaction state".
2. Každá bunka hovorí **obyčajným jazykom** pred číslom: _„13 px · jantárový
   pruh vľavo"_, nie _„13px · rgba(245,158,11) 2px 0 0 inset"_.
3. Keď sa živá hodnota líši od deklarovanej, panel to **povie nahlas** —
   názov role, očakávané, skutočné. Nie ticho.
4. Neoveriteľné stavy sú **označené ako neoverené**, nie vynechané.
5. Brána tiskne **ten istý stĺpec** ako panel. Rovnaké slová, rovnaké poradie.

---

## 7. Fázy — a prečo v tomto poradí

### Fáza A — zapisovač (rekorder) ← najprv

Headless prejde stavy, odmeria typografiu a materiál per rola a **zapíše
tabuľku + JSON**. Nič netvrrdí, nič nepinuje.

_Prečo najprv:_ stavy `selected` / `playing` / `hover` / `focus` som nikdy
nemeral. Deklarovať ich hodnoty by bolo vymýšľanie — presne tá chyba, ktorú
vlna 4 urobila, keď „názov panelu" dostal 15 px z jednej vzorky. Fáza A dáva
**údaje, z ktorých sa dá rozhodnúť**.

### Fáza B — deklarácia

Ľudská, revidovaná tabuľka: čo **má** byť v každom stave. Vzniká z údajov
fázy A, nie z odhadu. Kde hodnota nemá zmysel (napr. hover na padoch), bunka
je prázdna — a to je tiež údaj.

### Fáza C — brána

`scripts/state-matrix.mts` (cez `vite-node`, lebo zdieľa dátový modul
s appkou) bootne štúdio **raz**, prejde stavy, porovná s deklaráciou,
exit 0/1/2. Falsifikácia je povinná: mutovaná deklarácia musí dať červenú.

### Fáza D — kontrast (odložené, ale naplánované)

Kontrast sa dnes nikdy nemeral — „nezhoršil sa" bola veta zo screenshotu.
Fáza D pridá výpočet efektívneho kontrastu nad skomponovaným pozadím pre
deklarované textové role a ochráni `26-settings-glass.css`, ktorý si repo
tvrdí, že je kontrastovo overený.

---

## 7b. Stav fáz A–C (2026-10-20) — čo sa zmenilo oproti plánu

Plán predpokladal, že Fáza A je „zapisovač, nič netvrrdí". Ukázalo sa, že
**zapisovač bol miestami brána, ktorá nič nemerala** — a to v troch
samostatných prípadoch, z ktorých každý dával čistý, plausibilný, zlý
výsledok.

### Čo sa zlomilo

| # | Chyba | Ako sa prejavila |
| - | ----- | --------------- |
| 1 | Štyri skripty mali **vlastnú kopiu bootu**. Trieda `pb-template-start` zmizla z markupu (`8d11f16b`) a vzala všetky štyri brány naraz. | 40 minút „harness je rozbitý" z jedného názvu triedy |
| 2 | Čítač vzal **prvý matchujúci** element role. Pre rolu, ktorej stav sedí na **jednom z mnohých** (256 buniek, 16 riadkov), to znamená, že každý stav vyzerá rovnako. | šesť stavov s **byte-identickými** čítaniami |
| 3 | Farby: `rgb()`/`color(srgb …)`/`oklab(…)` — a `color(srgb …)` zložky sú **medzerou** oddelené, nie čiarkou. `oklab` je v shelli **192-krát**, vrátane **prstenca playheada**. | každá plocha s farebnou značkou z `color-mix()` čítala sa ako **bez značky** — 256 buniek aj aktívna chip svietili, ale matica ich videla ako holé |
| 4 | Test chromatickosti: „rozdiel kanálov > 5/255" — prejde aj **neutrálny tmavý bevel** `rgba(18, 22, 27, 0.28)`, ktorý má každý `.track-tab`. | polovica shellu hlásila jantárovú značku, ktorá tam nie je |
| 5 | Fokusový kruh v tomto shelli je **`outline`**, nie shadow. Čítač ho vôbec nečítal. | stav `focus` bol **pixelovo identický** s `idle` |
| 6 | Stav `selected` klikol na **už vybraný** riadok. | výber sa nikdy nepohol; stav bol nerozlišiteľný od `idle` |
| 7 | `Tab` v tejto appke **neposúva fokus** (zmerané: `activeElement` zostáva `BODY`). | stav `focus` sa nedal vstúpiť klávesnicou |

### Čo vzniklo

- `scripts/lib/studio-boot.mjs` — **jeden** boot pre všetky brány. Pri zlyhaní
  vypíše, čo naozaj bolo na obrazovke (vrátane crash screenu), nie holý
  Playwright timeout.
- `readStateMatrix` meria **distribúciu** cez celú viditeľnú množinu
  (`accentCount`, `ringCount`, `outlineCount`, `accentSample`), nie prvý
  element. Všetky farby sa prevádzajú na **jediný sRGB tvar**, aby sa dali
  porovnávať naprieč formátmi.
- `STATE_EXPECTATIONS` v `src/ui/stateMatrix.ts` — **deklarovaná tabuľka** (17
  riadkov), každý s dôvodom (`because`). Deklarujú sa iba ** pravidlá shellu**:
  nie „hlavička stopy zelenie pri prehrávaní" (to platí len pre stopy, ktoré
  znejú), ale „hrdlo prehrávania je označené".
- `tests/state-matrix-color.test.ts` (10) + `tests/state-matrix-declaration.test.ts` (13)
  — čítač farieb je **pripnutý** proti skutočným vypočítaným reťazcom, lebo
  tri merania po sebe dali každé čistý, plausibilný, zlý číslo.
- `scripts/gate.mjs` — **jeden príkaz** (`npm run gate`) spustí všetky štyri
  brány nad `vite preview` nad `dist`. Zmrazený build, nie živý dev server:
  živý server na zdieľanom strome meral cudziu rozpracovanú prácu (dvakrát
  po sebe spadol na cudzí `const MIN_BPM`, čo je parse error).

### Falsifikácia brány (2026-10-20)

Vypnutý chromatický test (`return s >= 0.35` → `return false`):

```
FAIL  [idle] rowPad: 0 inset marks, expected {"min":1,"max":1}; inset colour none, expected rgb(245, 158, 11)
FAIL  [selected] rowPad — the state was not entered, so the rule was never checked
FAIL  [playing] stepCell: 0 rings, expected {"min":1}
FAIL  [playing] rulerTick: 0 border marks, expected {"min":1,"max":1}
FAIL  [playing] transportBtn: 0 border marks, expected {"min":1}
FAIL  [hover] transportBtn: 0 border marks, expected {"min":1}
FAIL  [recording] transportBtn: 0 border marks, expected {"min":2}
→ 7 očakávaní zlyhalo, exit 1
```

Prebehli oba failure módy naraz: „očakávanie zlyhalo" **aj** „stav nebol
dosiahnutý, takže pravidlo sa nikdy neoverilo". To je ten druhý, ktorý brána
nesmie prehltnúť — ticho preskočené pravidlo vyzerá ako pokrytie.

Po vrátení mutácie: **17/17 očakávaní platí, exit 0**.

### Čo sa NEDEKLAROVALO, a prečo

- **Presný počet prstencov playheada.** Grid animuje `box-shadow`, takže kolónka,
  ktorú playhead práve opustil, si drží zhasinajúci prstenec. Zmerané: 31, 32
  aj 16 v rôznych behoch. Deklarované ako **minimum**, nie číslo.
- **Farba hlavičky stopy pri prehrávaní.** Zelená znamená „táto stopa znie" —
  je to **údaj o projekte**, nie pravidlo shellu.
- **`focus` cez `Tab`.** Zmerané: `Tab` v tejto appke neposúva fokus. Brána
  preto tlačí `Shift` (klávesnicová modalita, bez ktorej sa `:focus-visible`
  nezapne), potom fokuje transport a **overí, že obrys vznikol**.

---

## 8. Čo sa nemení

- **Hierarchia sa nemení.** Toto je nástroj, ktorý zistí, či hierarchia drží.
  Nie nástroj, ktorý ju nanúši.
- **Žiadna nová funkcia prehrávania.** Brána kliká na reálne tlačidlá, nie do
  vnútra.
- **Žiadny nový balík.** Existujúce `playwright` + `vite-node` stačia.
- **`26-settings-glass.css` zostáva posledný import.**

---

## 9. Kritériá hotovosti

| #   | Kritérium                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Diagnostics panel má tab `STATE`; otvorenie/zatvorenie nemení layout shellu                                                                            |
| 2   | Tab nek polleduje — reaguje na `subscribePlaying` a zmenu výberu                                                                                       |
| 3   | Merací modul sa načíta lazy; v boot grafe štúdia nie je                                                                                                |
| 4   | Fáza A: JSON snapshot pre `idle` + `selected` + `playing` + `hover` + `focus`                                                                          |
| 5   | Fáza B: deklarovaná tabuľka schválená, prázdne bunky vysvetlené                                                                                        |
| 6   | Fáza C: brána exit 0/1/2; **falsifikovaná** na každej vetve                                                                                            |
| 7   | Brána rozlišuje „zlyhalo" (1) od „nikdy nebežalo" (2) pre každý stav                                                                                   |
| 8   | `recording` je v matici označený ako neoverený, nie ticho vynechaný                                                                                    |
| 9   | Deklarácia je **explicitný katalóg**, nie CSS scrape — a test ju pinuje **oboma smermi** ako `tokenCatalog.ts`: mŕtva rola padá, neviditeľná rola tiež |
| 10  | Stavová plocha sleduje vzor `sessionStateSurface.ts` (publish/get/subscribe, notifikácia sa preskočí pri nezmenenom stave)                             |

---

## 10. Otvorené otázky pre Daniela

1. **Meno.** Tab v UI potrebuje meno. `STATE` je najpíliňovitejšie; `MATRIX`
   znie ako nástroj; `HIERARCHY` znie ako kritika. Któré?
2. **Prístupnosť.** Má byť tab v Diagnostics (developer-only, otvorený ručne),
   alebo aj viditeľný pre bežného používateľa?
3. **Kto je „užívateľ" v požiadavke.** Panel je pre tých, ktorí štúdio
   používajú; brána je pre tých, ktorí ho menia. Oba sú „neorušivé" inak.
