# Help Overlay V2 — kompletný zoznam skratiek + gestá („všetky straky")

## Zistenie
HelpOverlay už existuje (`?` klávesa aj `?` button v TopBare) a zobrazuje všetkých 33 klávesových skratiek z `SHORTCUTS` tabuľky. Ale má 3 diery:
1. **Alternatívne skratky sa nikdy nezobrazia** — `formatShortcut()` renderuje len primárnu väzbu, hoci komentár v shortcuts.ts tvrdí, že altHint sa v helpi ukazuje (napr. Redo Ctrl+Shift+Z je neviditeľné).
2. **Myšacie/touch gestá úplne chýbajú** — „drag vertically for velocity", „Alt+drag microtiming", „Ctrl+drag probability", „shift+drag multi-select", „right-click/long-press p-locks", amount bar, velocity lane, DragNumber, Dice hotkeys — to všetko žije len rozptýlené v `title` tooltipoch.
3. Žiadne vyhľadávanie — nový užívateľ musí prečítať všetko.

## Zmeny

### 1. `src/ui/shortcuts.ts`
- `formatShortcut(sc)` ostane pre primárnu väzbu; pridám `formatBinding(binding)` (zdieľaná vnútorná logika) tak, že altHints sa dajú renderovať rovnakým spôsobom.

### 2. Nový `src/ui/helpContent.ts`
- `GESTURES: Array<{ area: string; action: string; detail: string }>` — jeden zdroj pravdy pre myšacie/touch gestá, zoskupené po plochách:
  - **Sequencer**: click = toggle; drag vertikálne = velocity; Alt+drag = microtiming ±1; Ctrl/Cmd+drag = probability; Shift+drag = multi-select; right-click / long-press = p-locks editor; spodný amount bar drag = ghost/accent 0–100 %
  - **Piano roll**: click na grid = pridá notu; drag noty = presun; drag pravého okraja = dĺžka; velocity lane drag; Shift+click = multi-select; pravé tlačidlo tahej = marquee výber
  - **Všeobecne**: DragNumber = drag mení hodnotu, dvojklik = reset; DICE hotkeys (D full, Shift+D vary, ←/→ história)
- Presné znenia prevezmem zo existujúcich `title` tooltipov (Sequencer.tsx:1184, PianoRoll, controls.tsx:162, DiceTray:464) — tooltipy ostávajú, help tabuľka musí byť s nimi konzistentná.

### 3. `src/ui/HelpOverlay.tsx` — premenovať obsahovo na „Help & shortcuts"
- Hlavička: „HELP — SHORTCUTS & GESTURES" + **search input** (filtruje skratky aj gestá podľa textu, aria-label).
- Klávesové skratky: rovnaký grid, ale každý riadok zobrazi **primárnu + alternatívne väzby** (`kbd` chipy, „or" medzi nimi).
- Nová sekcia **GESTURES BY AREA** pod skratkami — rovnaký `help-row` štýl: action + detail (detail ako text, nie kbd).
- Pätička ostane (Esc/click outside). `role="dialog"`, aria-label rozšírený na „Help: shortcuts and gestures".

### 4. `src/styles.css`
- `.help-search` (rovnaký recept ako gallery-search), `.help-alt` (sekundárne kbd chipy menej výrazné), `.help-gesture-detail` (text-dim). Znovu použiť `.help-kbd`.

### 5. Testy — `tests/ui/HelpOverlay.test.tsx`
- Existujúce asserty (dialog, CLOSE, Escape, scrim, Transport group) zostávajú.
- Nové: Redo riadok zobrazuje aj `Ctrl+Shift+Z` (alt hint), gestures sekcia renderuje aspoň jedno gesto z každej plochy, search filtruje (napísanie „velocity" skryje nesúvisiace riadky).

### 6. Bonus (drobnosť)
- DiceTray holé `<kbd>` dostane existujúcu `help-kbd` triedu, aby boli keycapy konzistentné.

## Overenie
`npm run typecheck` (filtrovaný), `npx vitest run tests/ui/HelpOverlay.test.tsx` + full suite, `npm run build` (size gate — HelpOverlay je v entry, pridáva ~2 KB, budget 975 má rezervu).

## Nezahŕňa
Vysvetlivky panelov (MIX/FX/ARR…) — tie kryje OnboardingTour; help ostáva zameraný na skratky + gestá podľa requestu.
