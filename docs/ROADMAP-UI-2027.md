# ROADMAP-UI-2027 — "FL-intuitívne, 2027 modern"

> Dizajnový roadmap pre redesign DAW UI, s dôrazom na **bottom dock**.
> Vznikol z live vizuálneho auditu 2026-10-04 (všetky panely preklikané so screenshotmi)
> + kódového štúdia (`src/ui/dockLayout.ts`, `src/ui/App.tsx`, `src/ui/TopBar.tsx`,
> `src/styles/01..18-*.css`, `src/shared/theme-data.ts`).
> Stav: **čaká na GO** — nič z tohto ešte nie je implementované.

---

## 1. Cieľ a non-goaly

**Cieľ:** UI sa riadi podľa FL Studio v *learnability* (všetko nájdeš na prvý
pohľad, myš stačí, systém ťa učí kým hoveruješ) a vizuálne je to 2027 moderná
tmavá konzola na úrovni Abletonu/Bitwigu — "Molten Console 2.0" (evolúcia
súčasnej identity, nie rebrand).

**Non-goaly:**
- **Žiadny floating-window systém** ako FL desktop. FL chaos okien je jeho
  najväčšia UX daň; 2027 moderný DAW je dock-based. Kradneme FL *patterns*,
  nie jeho window manager.
- Nemeníme audio architektúru, command flow ani project model (AGENTS.md
  invarianty zostávajú).
- Landing/embed/gallery sú mimo scope (majú vlastnú identitu, tá funguje).

---

## 2. Čo konkrétne kradneme z FL Studio (a čo nie)

| FL pattern | Ako sa prejaví v KYX | Vlna |
| --- | --- | --- |
| Panely majú vždy viditeľný chrome (title bar / dock strip) | Dock dostane **vlastnú tab row**, ktorá zostáva viditeľná aj v collapsed stave (dnes: 7 px neviditeľný pásik) | 1 |
| Hint bar (ľavý horný roh) — čo je pod kurzorom + hodnota | **Statusbar = live hint**: názov + aktuálna hodnota + čo to robí pre hoverovaný control | 3 |
| Scroll-wheel mení každý control | `useWheelAdjust` na Slider/knob — wheel = normálny krok, Ctrl+wheel = jemný (FL konvencia) | 3 |
| Right-click na controle = menu (zadaj hodnotu, reset, link) | Rozšíriť existujúci `.value-type-popover` (už je!) o **Reset to default** a povedz ho všetkým slidrom | 3 |
| Jednotné klávesové skoky na panely (F5/F6/F7/F9) | Zachovanie **Alt+1..6** + doplnenie Alt+7 INTENT, Alt+8 MIDI (F-klávesy v prehliadači nemôžu — F5 = reload) | 1 |
| Browser vľavo, vždy dostupný, drag&drop | SampleBrowser z dialógu do **permanentného ľavého pruhu** (lazy, collapsible, 240 px) | 4 |
| Farebné kanály, clipy dedia farbu | Máme track colors — dôsledne zdediť do padov/clipov/chipov v celom UI | 2 |
| Pattern/Song prepínač v transporte | Už máme (`playMode`) — len ho vizuálne zdôrazníme | 1 |
| Transport + CPU/voices stále viditeľné | Statusbar: CPU · voices · mini master meter (MasterMeter.tsx už existuje) | 3 |

**Čo zámerne NE:** floating okná, maximalistické menu bary, FL房间 skrývanie
panelov do "internal controllers".

---

## 3. Cieľový layout

```
┌────────────────────────────────────────────────────────────────────────────┐
│ TOPBAR  KYX ▸ transport ▸ BPM ▸ PAT/SONG ▸ project ▸ SAVED ▸ ⌘K ? HIST     │  48 px, vyľahčený
├──────────┬──────────────────────────────────────────────┬──────────────────┤
│ BROWSER  │  workspace                                    │  INSPECTOR       │
│ (Vlna 4, │  track tabs · pattern bar                     │  280 px          │
│ 240 px,  │  SEQUENCER (channel-rack štýl)                │                  │
│ col.)    │                                               │                  │
├──────────┴──────────────────────────────────────────────┴──────────────────┤
│ ▼▼▼▼▼▼▼▼▼▼▼▼▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀ │  resize grip
│ [MIX][DEV][ARR][MOD][DICE][INTENT][EXP][MIDI][REF]        ⇔ split   ▾      │  DOCK TAB ROW — vždy viditeľná
│ ┌ PanelHeader: MIXER — zvýraznený track · [BATCH FX] [SNAPSHOT] ┐          │  unified header
│ │ panel obsah na tokenoch, karty, hierarchia buttonov            │          │
│ └────────────────────────────────────────────────────────────────┘          │
├────────────────────────────────────────────────────────────────────────────┤
│ STATUSBAR  hint: "CEILING −1.0 dB · limiter peak"  · pos  · CPU · ▁▃▅ meter │  26 px
└────────────────────────────────────────────────────────────────────────────┘
```

Kľúčové zmeny oproti dnešku:
1. **Panel prepínače idú z topbaru do docku.** Kde je panel, tam sa aj prepína
   (Ableton/Bitwig vzor). Topbar ostáva transport + globálne. Zmizne aj ⋯
   overflow — všetkých 9 panelov sa zmesti do tab row na 1280+ (taby sú úzke,
   icon+label, pri < 1280 label skráti na ikonu).
2. **Collapsed dock = tab row zostáva** (~36 px). Namiesto dnešného
   neviditeľného 7 px pásika je vždy viditeľná lišta, ktorou dock otvoríš.
3. **Split zachovávame** (FL to nemá — my áno, je to naše plus). Pridáme
   vizuálny divider medzi slotmi a možnosť.tab drag presunúť medzi slotmi.

---

## 4. Vlny

### Vlna 0 — Quick fixes (bugy z auditu, nezávislé, ihneď)
| Fix | Kde |
| --- | --- |
| INTENT action row sa prekrýva v úzkom split slote (DO IT/GENERATE/SONG) | `IntentPanel.tsx` — flex-wrap + min-width |
| Mixer obsah orezaný spodkom (RETURN/metre bez paddingu) | `03-mixer.css` + mixer wall |
| Toggle quirk: panel v slotB → klik v topbare ho presunie namiesto zatvorenia | `App.tsx` `setBottomPanelTab` — klik na už-otvorený panel ho zavrie nezávisle od slotu |
| SK preklepy v IntentPanel ("OSOBNÝ VLHUS", "SEDNÍ NA AKORDY") | `IntentPanel.tsx` copy |
| Nestýlované scrollbary v dock-slote | nové pravidlá v dock CSS |

### Vlna 1 — Tokens 2.0 + Dock Chrome (jadro kampane)
**Tokens 2.0** (additívne do `:root` v `01-base.css`, zaregistrovať v
`theme-data.ts` THEME_VARS, aby fungovali theme presety):
- spacing: `--space-1..6` (4/8/12/16/24/32)
- radius: `--radius-xs..xl` (3/5/8/12/16)
- elevation: `--elev-1..3` (tiene) + `--hairline` (0.5 px border token)
- surface: `--surface-0/1/2` (app/panel/raised — nahradí ad-hoc bg-panel lán)
- controls: `--ctrl-h` 28 px, `--ctrl-h-sm` 24 px
- typografia: `--fs-2xs..lg` + pravidlo "čísla vždy mono" (`tabular-nums` už je)

**Dock Chrome:**
- `DockChrome.tsx` — tab row generovaná z `PANEL_KEYS` (dockLayout.ts je zdroj
  pravdy), `role="tablist"/"tab"/"tabpanel"` + `aria-selected`
- tab = ikona + label, aktívny tab má accent underline/glow (Molten glow len
  na aktívnych — to je 2027 časť, nie na všetkom)
- akcie vpravo: `⇔ split` (toggle slotB), `▾ collapse`
- **resize grip**: 12 px hit area, 3 grip lines, dvojklik = default výška,
  focusovateľný klávesnicou (hore/dole)
- collapsed = len tab row (36 px), FL-style "nikdy nezmizne"
- nový CSS súbor `19-dock-chrome.css` **na koniec** cascade (index.css poradie
  je load-bearing)
- TopBar.tsx: odstrániť panelActions/priority/overflow systém (≥ 200 riadkov
  komplexity zmizne), nechať transport + nástroje
- shortcuts.ts: doplniť Alt+7 (intent), Alt+8 (midi) — panel ids už existujú
- update testov: TopBar priority testy vymenia za DockChrome testy,
  dockLayout.test.ts doplniť o tab-row kontrakt

**Aceptačná kritéria:** collapsed dock je viditeľný a klikateľný; každý panel
dosiahnuteľný 1 klikom z hociaľ; Alt+1..8 prepína panely; F-keys sa nedotknú;
e2e smoke zelený; screenshot verifikácia 1680×1000 + 1280×800.

### Vlna 2 — Control kit + panel konsolidácia (koniec button soup)
- Control kit v `controls.tsx`/CSS: `.btn-primary` (accent fill), `.btn-secondary`
  (raised), `.btn-ghost`, `.btn-icon`, `.chip` (toggle), `.seg` (segmented) —
  dedia `--ctrl-h`, konsistentný focus-visible
- **DEV/ARR reorganizácia**: dnešných ~30 rovnako ťažkých text buttonov →
  nástrojové lišty s ikonami + tooltipmi, zoskupené (Pattern tools |
  Humanize | Song tools | Clipboard), sekcie ako karty s `PanelSection`
- `PanelHeader` komponent (title + kicker + actions slot) nasadený vo
  VŠETKÝCH paneloch (mixer, devices, arr, mod, dice, intent, exp, midi,
  reference) — jeden formát hlavičky
- Farebná disciplina: accent = interaktívne, play = transport, semantic farby
  len status; DICE slidre preč z modrej; track color dedí do padov/clipov/chipov

### Vlna 3 — FL interakcie (myš a hint ako učiteľ)
- `useWheelAdjust` — wheel na hover nad Slider/knob mení hodnotu, Ctrl+wheel
  = jemný krok; rešpektuje disabled + text inputy (nesmie kolidovať so
  scrollom gridu — wheel-braked len nad samotným controlom)
- right-click na slidroch: existujúci value popover + **Reset to default**
  (potrebné default hodnoty v parameter metadátach)
- **Hint statusbar**: komponenty dodajú `data-hint="CEILING — limiter peak"`;
  statusbar ho zobrazí pri hoveri + aktuálnu hodnotu; fallback = dnešné
  statické hinty
- mini master meter do statusbaru (MasterMeter.tsx reuse, reduced), CPU +
  voices už sú

### Vlna 4 — Browser panel + polish
- ľavý strip SampleBrowser (lazy, collapsible 240 px; grid sa stane
  `auto 1fr 280px`); drag&drop do sequenceru cez existujúci DropZone infra
- empty states pre prázdne panely
- motion pass: 120–180 ms transitions, `prefers-reduced-motion` rešpekt
- density toggle napojený na existujúci theme density (compact/normal)
- finálny focus-visible + kontrast audit (WCAG AA na textoch)

---

## 5. Riziká a invarianty

- **CSS cascade order je load-bearing** (`src/styles/index.css`) — všetko
  additívne, nové súbory výhradne na koniec; nič nereorderovať.
- **TopBar priority/overflow testy** (existujú) sa pri Vlne 1 prestávajú týkať
  — nahradiť DockChrome ekvivalentmi v tom istom commite.
- **Bundle budget** (entry 1070 KB): DockChrome je súčasť App chunku, malý;
  browser strip lazy. Meranie v `npm run build` pred merge.
- **Multi-agent strom**: každá vlna = vlastný commit (guardrails), screenshot
  verifikácia vždy pred commitom.
- **Test gates**: typecheck + vitest + e2e smoke po každej vlne; format:check.

## 6. Metriky úspechu ("FL-intuitiveness checklist")

1. Nový používateľ otvorí ktorýkoľvek panel bez hľadania (tab row vždy viditeľná).
2. Hover nad akýmkoľvek controlom → statusbar povie čo to je + hodnotu.
3. Každý spojitý control sa dá meniť kolieskom bez kliku (Ctrl = jemne).
4. Zbalený dock je viditeľný, klikateľný a jasne vizuálne oddelený.
5. K akémukoľvek panelu max 2 kliky z hociakej obrazovky.
6. Všetky panely zdieľajú jeden header/control/spacing jazyk (screenshot diff
   proti golden setu).
