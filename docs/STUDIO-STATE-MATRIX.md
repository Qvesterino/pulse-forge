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

### Fáza D — kontrast ← hotová (2026-10-21, §7c)

Kontrast sa dnes nikdy nemeral — „nezhoršil sa" bola veta zo screenshotu.
Fáza D pridá výpočet efektívneho kontrastu nad skomponovaným pozadím pre
deklarované textové role a ochráni `26-settings-glass.css`, ktorý si repo
tvrdí, že je kontrastovo overený.

Hotová: meria nad **vyrenderovanými pixelmi** (nie nad tokenom), našla dva
skutočné defekty, opravila ich v novej vrstve `60-contrast-legibility.css` a
brána ich vyzdvihuje.

---

## 7b. Stav fáz A–C (2026-10-20) — čo sa zmenilo oproti plánu

Plán predpokladal, že Fáza A je „zapisovač, nič netvrrdí". Ukázalo sa, že
**zapisovač bol miestami brána, ktorá nič nemerala** — a to v troch
samostatných prípadoch, z ktorých každý dával čistý, plausibilný, zlý
výsledok.

### Čo sa zlomilo

| #   | Chyba                                                                                                                                                                         | Ako sa prejavila                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Štyri skripty mali **vlastnú kopiu bootu**. Trieda `pb-template-start` zmizla z markupu (`8d11f16b`) a vzala všetky štyri brány naraz.                                        | 40 minút „harness je rozbitý" z jedného názvu triedy                                                                                               |
| 2   | Čítač vzal **prvý matchujúci** element role. Pre rolu, ktorej stav sedí na **jednom z mnohých** (256 buniek, 16 riadkov), to znamená, že každý stav vyzerá rovnako.           | šesť stavov s **byte-identickými** čítaniami                                                                                                       |
| 3   | Farby: `rgb()`/`color(srgb …)`/`oklab(…)` — a `color(srgb …)` zložky sú **medzerou** oddelené, nie čiarkou. `oklab` je v shelli **192-krát**, vrátane **prstenca playheada**. | každá plocha s farebnou značkou z `color-mix()` čítala sa ako **bez značky** — 256 buniek aj aktívna chip svietili, ale matica ich videla ako holé |
| 4   | Test chromatickosti: „rozdiel kanálov > 5/255" — prejde aj **neutrálny tmavý bevel** `rgba(18, 22, 27, 0.28)`, ktorý má každý `.track-tab`.                                   | polovica shellu hlásila jantárovú značku, ktorá tam nie je                                                                                         |
| 5   | Fokusový kruh v tomto shelli je **`outline`**, nie shadow. Čítač ho vôbec nečítal.                                                                                            | stav `focus` bol **pixelovo identický** s `idle`                                                                                                   |
| 6   | Stav `selected` klikol na **už vybraný** riadok.                                                                                                                              | výber sa nikdy nepohol; stav bol nerozlišiteľný od `idle`                                                                                          |
| 7   | `Tab` v tejto appke **neposúva fokus** (zmerané: `activeElement` zostáva `BODY`).                                                                                             | stav `focus` sa nedal vstúpiť klávesnicou                                                                                                          |

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
  _Dôsledok:_ `output/state-matrix/*.json` sa pri každom behu brány mierne
  zmení (o dve čísla). To je **očakávané**, nie drift — a je to dôvod, prečo
  brána nedeklaruje presný počet.
- **Farba hlavičky stopy pri prehrávaní.** Zelená znamená „táto stopa znie" —
  je to **údaj o projekte**, nie pravidlo shellu.
- **`focus` cez `Tab`.** Zmerané: `Tab` v tejto appke neposúva fokus. Brána
  preto tlačí `Shift` (klávesnicová modalita, bez ktorej sa `:focus-visible`
  nezapne), potom fokuje transport a **overí, že obrys vznikol**.

---

## 7c. Fáza D — kontrast (2026-10-21)

### Ako sa meria

Dve metódy, jedna pravda:

- **Statická** (`readStateMatrix`): skomponuje `background-color` vrstiev od
  elementu hore po prvú nepriehľadnú. Presná, kde je pozadie plná farba; a
  **nevyriešená** (a tak to aj hlási) tam, kde predok paintuje gradient.
- **Pixelová** (`scripts/state-matrix.mts --pixels`): dva snímky celého
  viewportu — jeden s textom, jeden s textom schovaným cez
  `color: transparent`. Kde sa líšia, text bol nakreslený; pixel z druhého
  snímku je **pravé pozadie pod glyfom**, gradient, blur a
  `backdrop-filter` zahrnuté.

Farba textu sa **nerasterizuje cez regex**: prechádza sa canvasom
(`fillStyle` + `getImageData`), lebo prehliadač vie `color(srgb …)` aj
`oklab(…)` a regex by ich musel znovu vymýšľať — presne tie dva formáty,
ktoré shell používa 1160-krát a 192-krát.

Región merania **nie je box roly** — je to presný **rámec textu** (Range nad
textovým uzlom). Box elementu obsahuje border, padding a — čo je tu
rozhodujúce — `::after` pruh, ktorý hlavička stopy kreslí ako značku výberu.
Ten pruh je jantárový, kým je riadok len vybraný, a zelený, keď hrá. Práve
on je falošný nález v §7c.2.

Skríženie: **kde je statické pozadie vyriešené, obe metódy súhlasia na
desiatke** (z jedného behu: `rulerTick` 6.04 = 6.04, `btnSmall` 5.17 = 5.17,
`presetChip` 6.28 = 6.28, `channelNameRow` 12.45 = 12.45, `rowIndex`
4.45 = 4.45). To nie je zhoda, to je **kontrola kompozičnej matematiky** proti
tomu, čo prehliadač naozaj nakreslil.

### Metrika: podiel, nie najhorší pixel

Prvá verzia brány hlásila **najhorší pixel**. To sa ukázalo ako zlý mieridlo,
lebo rovnako hlási dve úplne rozdielne veci:

| Povrch                    | Pixelov pod 4.5:1   | Čo to je                                      |
| ------------------------- | ------------------- | --------------------------------------------- |
| index na čistom riadku    | **100 %** (8 z 8)   | text, ktorý sa nedá čítať                     |
| index na jantárovom pulze | **100 %** (22 z 22) | text, ktorý sa nedá čítať                     |
| label dock tabu           | **18 %** (23 z 125) | text, ktorý sa nedá čítať                     |
| chip vzoru                | 2,5 % (4 z 160)     | okraj glyfu, ktorý si oblizol 1px svietlý roh |

Prvé tri sú defekty. Štvrté je detail vykresľovania. **Minimum ich nerozlišuje
— podiel ich rozlišuje.** Prah je **10 %** (`MAX_BELOW_FLOOR_SHARE = 0.1`) a je
zvolený **v prázdnej medzere, ktorú meranie ukázalo**:

| Podiel | Čo to je                                                                                                                      |
| ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 0 %    | role, ktoré sú jednoducho v poriadku                                                                                          |
| 2,5 %  | **šumová podlaha** — horný rad glyfu, ktorý si oblizol 1px top-light; merané na statusbare a na chipu vzoru, obidva sa čítajú |
| 18 %   | najmenší **skutočný** defekt — label dock tabu, 23 z 125 textových pixelov na povrchu 2.03:1                                  |
| 100 %  | 8px index celý na povrchu 4.45:1                                                                                              |

Niečo sa medzi 2,5 % a 18 % **nameralo nikdy** — a prah 10 % leží presne v tej
medzere. Zároveň to znamená, že **celý** index (8 px) musí spĺňať podlahu: 10 %
z 8 je 0.8 px, takže jeden pixel pod podlahou je už 12.5 % a brána to odmietne.

### Nálezy (pred opravou)

| Rola             | Pred                                                            | Čo to bolo                                                                                                                                                             |
| ---------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.row-pad-index` | 4.45:1 na čistom riadku, **3.09:1** na jantárovom pulze         | `--text-faint` bol kalibrovaný na **panel**, nie na zdvihnutý povrch sequencera; pulz (`--kyx-pulse-soft`) začína na ľavom okraji, presne tam kde je stĺpec indexu     |
| `.dock-tab`      | **2.03:1** na neaktívnom labeli, **3.55:1** na aktívnom jantári | label si zostal `--text-faint` z doby **pred** striebornou vlnou, kým povrch sa stal strieborným; jantár sa zmeniť nesmie (je to signál výberu), takže sa hýbal povrch |

Screenshot to potvrdil: číslice 1, 3, 4 a 5 boli v sequenci naozaj ťažko
čitateľné, a „MIX" v docku stál na svetlom konci strieborného prechodu.

### Čo sa opravilo

Nová vrstva `src/styles/60-contrast-legibility.css` (ADR 0036 — aditívna
vrstva, poradie importov zostáva load-bearing, `26-settings-glass.css` je
stále posledný):

- `--text-index: color-mix(in srgb, var(--text-dim) 80%, var(--text))` —
  odvodený z **témových** tokenov, takže sleduje každú paletu. 80/20 je
  najmenší mix, ktorý prejde pulzovaný riadok.
- `.dock-tab` → `--kyx-silver-mid` — striebro, ktoré shell už používa na
  striebornom skle (`.track-tab` meria s `--kyx-silver-bright` 17.38:1).
- `.dock-tabs` — 35 % závoj z farby pozadia nad strieborným prechodom. Prechod
  si drží tvar aj smer, je len **nie svetlejší než text na ňom**.

### Čo sa NEDEKLAROVALO, a prečo

- **Presný počet pixelov.** Podiel je meradlo, nie počet. Hľadá sa
  stabilita: brána má byť zelená na každom stroji.
- **Presná hodnota kontrastu v deklarácii.** Podlaha je **4.5:1 z WCAG
  1.4.3**, nie „to, čo sme zmerali". Deklarácia, ktorá by pinovala
  nameranú hodnotu, by prešla pre čokoľvek — aj pre farbu, ktorú si neprečíta.
- **Farba hlavičky stopy pri prehrávaní.** Zelená znamená „táto stopa znie" —
  je to údaj o projekte. Jej **kontrast** je alebo nie je meradlo shellu, a
  meraný je.

### 7c.2 Tri chyby merania, ktoré odhalila až falsifikácia

Falsifikácia nie je formalita. Pri pokusoch o ňu brána zlyhala **tri razy
a tri razy inak, než sa čakalo** — a všetky tri zlyhania boli chyby
**merania**, nie chyby shellu. Zelené slovo „Drums" v stave prehrávania je
čitateľné; brána tvrdila 1.23:1.

**1. Pruh, ktorý nie je text.**

`.track-header-name` kreslí `::after` pruh — 24 × 2 px — ako značku výberu na
spodnom okraji tlačidla. Je **jantárový**, kým je riadok len vybraný, a
**zelený**, keď hrá.

Trieda `playing` na hlavičke stopy alebo nehrá trvalo: `trackHasHit` znamená
„tento riadok má úder v **aktuálnom kroku**" — prepína sa teda **8-krát za
sekundu** (124 BPM, šestnástinky). Medzi dvoma snímkami merania sa farba
pruhu zmení.

Rozdielovač snímok vie povedať „tu sa niečo zmenilo", ale **nevie, či sa to
zmenilo preto, že sa skryl text, alebo preto, že sa aplikácia hýbala**. Pruh
sa hýbal. Jeho pixely preto skončili v skupine „text" a brána vypočítala
zelený okraj glyfu nad jantárovým pruhom: **1.23:1**.

Riešenie: región merania je **rámec textu** (Range nad textovým uzlom), nie
box elementu — pruh, border aj padding sú mimoň. Po oprave je
`channelNameHeader` **5.05:1 vo všetkých šiestich stavoch**, a to **bez
zmeny v CSS**.

_Pred bránou, ktorá hlási „niečo sa zmenilo" bez toho, aby povedala čo, je
brána, ktorá hlási „niečo sa zmenilo" a MYSLÍ TO text._

**2. Boot, ktorý občas zlyhal.**

Tri z prvých piatich behov proti `5291` skončili **exit 2** (HARNESS_ERROR):
boot nenašiel šablóny projektu do 60 s. Nová diagnostika v
`scripts/lib/studio-boot.mjs` ukázala čosi, čo samotný timeout nikdy neukáže:

```
DIAGNOSIS: readyState=complete .pb-templates=1 .pb-template=17 details=3
#root children=1 html=13352 bytes
```

**Sedemnásť tlačidiel bolo v DOM-e** — a `locator.waitFor` ich neuvidel.
Prechod na `page.waitForFunction` (polling skript sa vklada znova pri každej
navigácii, takže prežije reload service workera) a timeout 180 s to
vyriešili.

**A mal to ešte jeden háčik**, ktorý ukázala až ďalšia chyba:

```
locator.click: Timeout 300000ms exceeded.
  - locator resolved to <button type="button" class="pb-template">…</button>
  - attempting click action
      - element is not visible
```

Tlačidlo sa **našlo** — a bolo neviditeľné. `<details open={!firstRun}>` je
**riadený Reactom**: pri najbližšom prekreslení prehliadača React zapíše
`open` späť zo svojho propu a panel sa **zavrie**. Harness ho otvoril,
prehliadač sa prekreslil, a klik už letel do skrytého prvku. Otvorenie aj
klik sa teraz opakujú spolu (`openDisclosure` + 3 pokusy) — a chyba sa
**povie**, namiesto toho aby ticho stála 300 s.

Brána, ktorá sa bootuje na 60 s, je brána, ktorej zelená je mincou. Exit 2
(„nič sa nezmeralo") je pri tom **správna** odpoveď — ale odpoveď musí byť aj
**vysvetľená**, inak ďalšia session hľadá príčinu naslepo.

**3. Chyba kliku, ktorá sa prehltla.**

Pri záverečnej kontrole na hlavnom `dist`-e brána hlásila:

```
FAIL  [selected] rowPad — the state was not entered, so the rule was never checked
the selection did not move (still "1Kick Deep")
```

Klik na nevybraný riadok bol obalený `.catch(() => {})`. **Klik, ktorý sa
neuskutočnil** (prekreslenie prvku, niečo zachytilo pointer) vyzeral presne
ako aplikácia, ktorá ignoruje výber — a stav bol zapísaný ako „nedosiahnutý"
bez jedinej stopy, že **harness neklikol**. To sú dve rôzne chyby s rôznymi
opravami.

`clickWithRetry` to vyriešil: klik sa zopakuje tri razy, a ak zlyhá, jeho
chyba sa **povie v poznámke stavu**. Ticho prehltnutá chyba nástroja je
tichý klam.

### Falsifikácia

Brána musí **zlyhať**, keď sa do shellu vráti chyba. Nie „vyskúšať to a
vidieť" — vrátiť defekt a ukázať, že ho brána chytí.

**Postup.** Hodnota pred Fázou D (`color: var(--text-faint)`) sa vrátila do
`60-contrast-legibility.css`, projekt sa prebuildoval a **izolovaný build**
sa obslúžil na vlastnom porte.

**Prečo izolovaný build.** `dist/` je zdieľaný. Cudzia session, ktorá medzi
meraním prebuduje `dist/`, by prepísala artefakt pod pätou merania — a brána
by nahlásila výsledok **cudzieho buildu**. Falsifikácia, ktorá meria „hocičo
je práve v `dist`", nie je falsifikácia. `output/_falsify-dist` je pod
`output/_*`, teda gitignorovaný, a nedotkne sa cudzieho buildu.

**Platí až druhý beh.** Falsifikácia sa prebehla **dvakrát**: raz s pôvodnou
metódou (odhalila falošný nález, §7c.2) a raz s finálnou. **Brána, ktorá má v
sebe chybu, nedokazuje nič o shelli — dokazuje len o sebe.**

**Výsledok (defekt vrátený, exit 1):**

```
FAIL  rowIndex: the dominant surface reads 3.28:1, 4.5:1 required
      (5 of 10 pixels on rgb(55, 50, 42)); 100% of the text is below 4.5:1
      (worst 3.28:1 on rgb(55, 50, 42))
→ 1 očakávanie zlyhalo, exit 1
```

Zlyhala **presne jedna** rola — tá, ktorá bola rozbitá. Ostatných 15
kontrastných podlah a všetkých 17 stavových očakávaní stálo prešlo, takže
brána nefailuje „všetko naraz" — ona hlási **konkrétnu** rolu a jej dôvod.

**Po vrátení opravy: exit 0**, 90 meraní, 1 NOTE (`panelTitleLocal` pod
zástenkou — podlaha je deklarovaná, ale na 1440×900 sa nevykonáva).

**Pozor na čísla.** Nález pred opravou bol **3.09:1**, falsifikácia namerala
**3.28:1**. Rozdiel je anti-aliasing jantárového pulzu medzi behmi. Brána
hlási **čo zmerala**, nie vopývané číslo — a preto zlyháva na **podlahe
4.5:1**, ktorá je deklarovaná. Deklarovať nameranú hodnotu by znamenalo, že
brána prejde aj pre farbu, ktorú si neprečíta.

### Čo sa počas falsifikácie ukázalo navyše

Dve veci: meranie bolo opravené a boot dostal 180 s + `waitForFunction` +
diagnostiku — obojie je opísane v §7c.2. A merací nástroj, ktorý pri zlyhaní
nevie povedať, čo videl, posiela ďalšiu session hľadať príčinu naslepo.

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
| 11  | Fáza D: kontrast sa meria nad **vyrenderovanými pixelmi**, nie nad tokenom; gradientové pozadie sa hlási ako nevyriešené, nie odhaduje                 |
| 12  | Fáza D: podlaha je **4.5:1 z WCAG 1.4.3** — nikdy „to, čo sme zmerali"                                                                                 |
| 13  | Fáza D: brána vyzdvihuje **podiel textu pod podlahou** (≤ 10 %), nie najhorší pixel; 10 % z 8 px znamená nula tolerancie                               |
| 14  | Fáza D: rola, ktorá sa nikde nezobrazila, je **FAIL**; rola pod zástenkou je **NOTE** — otvorená priezor nie je zelená pokrytie                        |
| 15  | Fáza D: región merania je **rámec textu** (Range), nie box elementu — inak sa značka výberu (`::after`) pomieša s textom a vyrobí falošný FAIL         |
| 16  | Fáza D: boot je **odolný** (180 s, `waitForFunction`) a pri zlyhaní **hovorí, čo videl** (počty v DOM-e + screenshot), namiesto tichej prázdniny       |

---

## 10. Otvorené otázky pre Daniela

1. ~~**Meno.**~~ **Vyriešené 2026-10-21: `MATRIX`.** Tab v Diagnostics sa bude
   volať `MATRIX` — znie ako nástroj a nie ako kritika.
2. **Prístupnosť.** Má byť tab v Diagnostics (developer-only, otvorený ručne),
   alebo aj viditeľný pre bežného používateľa?
3. **Kto je „užívateľ" v požiadavke.** Panel je pre tých, ktorí štúdio
   používajú; brána je pre tých, ktorí ho menia. Oba sú „neorušivé" inak.
