# Release Roadmap — k plne funkčnej, bezproblemovej appke

> Východiskový stav: po 19-sekvenčnom maintenance & hardening passes (detaily v [`MAINTENANCE_AUDIT_PROGRESS.md`](./MAINTENANCE_AUDIT_PROGRESS.md)).
> Zdravotný stav kodu: `npm run typecheck` ✓ · full test suite **186 súborov / 1866 passed / 0 failed** · `npm run build` ✓ (budgety OK) · prod `npm audit` 0 vulnerabilities.
>
> Status legendy: `[ ]` pending · `[~]` robí sa · `[x]` hotové · `[!]` blocked / potrebuje rozhodnutie.

---

## Fáza 0 — Ešte dnes (ochrana práce)

- [ ] **Commitnúť working tree** (~25 súborov: hardening fixy + FXEQ/Ozvena WIP + nové testy).
  Odporúčané logické commity:
  1. `fix(audit): maintenance hardening pass — scheduler/collab/export/security fixes + regression tests`
  2. `chore(deps): fast-uri audit fix (non-breaking)`
  3. tvoj pôvodný WIP (FXEQ panel / EffectAbControls / ozvena-params) oddelene, ak je rozpracovaný
- [ ] Zmazať tranzitné logy (`baseline-tests.log`, `full-sweep.log`, `final-sweep.log` — už zmazané) a `topbar-diag.png`, ak sú obsolete.

---

## Fáza 1 — Release blokery

> Toto stoja medzi appkou a publikom. Poradie podľa (riziko × cena opravy).

### 1.1 QA v reálnych prehliadačoch `[!]` — najväčšie riziko celého releasu

Celý CI beží v jsdom, ktorý **nepočuje žiadny zvuk**. Všetkých 1866 testov overuje logiku, nie audio rendering.

- [ ] Spustiť `npm run test:browser` (`src/browser-checks.ts`) v **Chromium / Edge / Firefox / Safari**.
- [ ] Manuálny test skript (najrizikovejšie scenáre):
  - [ ] iOS Safari: `pagehide` uloženie (zavrieť tab po editácii → projekt prežije), audio unlock banner, prvý click na suspendnutom kontexte.
  - [ ] Tab hide počas playback → resume bez "machine gun" burstu, scheduler re-anchor.
  - [ ] MediaRecorder: video export v Safari/Chrome (codecy cez `isTypeSupported`), MP3 export.
  - [ ] Web MIDI: pripojiť/odpojiť controller **počas držania padu** (Note Repeat roll musí ustat — audit 02 fix).
  - [ ] Collab: 2 taby, rovnaký room — edituj obe strany, undo na jednej, over že sa nič nezblázni.
  - [ ] Export WAV/MP3/MIDI/JSON projektu so scene BPM lanes a automation — počúvať, porovnať s live.
- [ ] Výsledok zapísať do tohto dokumentu (sekcia „QA log").

### 1.2 Export parita: sceneAutomation + scene intensity

„What you hear = what you export" dnes **neplatí**, ak projekt používa scene lanes/intenzitu:

- [ ] `renderer.ts`: naplánovať `doc.sceneAutomation` do offline renderu cez tempo-mapu `timeAt` (rovnaký vzor ako `scheduleTrackAutomation` / `scheduleDeviceAutomation`).
- [ ] `renderer.ts`: scene intensity per clip-window (vrátane `intensityCurve` interpolácie) → `engine.setSceneIntensity()` namiesto zafixovaných 0.7.
- [ ] Parita test: projekt so scene lane + intensity → render-event porovnanie živého okna vs. offline segment.
- Kriterium: export projektu s použitými scene lanes sa zvukovo zhoduje s live playbackom (okrem známej tempo-seam rezidui, fáza 2.2).

### 1.3 UI na obnovu snapshotov

Autosnapshoty sa ukladajú (20 na projekt, `SnapshotRepository`) ale **neexistuje UI na ich obnovu** — polovica recovery príbehu chýba.

- [ ] Jednoduchý panel (napr. v ProjectBrowser alebo TopBar menu): zoznam snapshotov projektu s časom + „Obnoviť".
- [ ] Obnova = `repo.loadSnapshot` → potvrdenie → `store.replaceDoc(snapshot)` (history sa čistí, watermark resetuje — oboje už otestované).
- [ ] Test: restore panel — obnova prepne doc, history prázdna, ďalšie uloženie funguje.

### 1.4 Robustnosť importu/exportu

- [ ] **Import limity**: cap na veľkosť súboru (audio ~25 MB, projekt JSON ~10 MB) s jasnou error správou — teraz hrozí OOM tabu (pamäť sa násobí 5–10× pri dekóde).
- [ ] **Zrušiteľné exporty**: `AbortSignal` cez `encodeMp3`, stems, video loop; Cancel tlačidlo v `ExportPanel` status riadku; po zrušení žiadny čiastočný súbor na disku.
- [ ] Video: nesám pridávať 1 s tichu pre krátke buffery (`Math.max(1, ...)` → `Math.max(0, ...)`) alebo aspoň dokumentovať.

---

## Fáza 2 — Optimalizácie

### 2.1 Bundle headroom `[!]` — skoro release blocker

- Entry chunk: **987 KB z 995 KB budgetu** — 8 KB rezervy. Akákoľvek nová funkcia rozbije build.
- [ ] Audit entry chunku (`vite build` + rollup analyze): čo je eager, čo môže byť lazy (vzor `ExportPanel`/`EmbedApp`).
- [ ] Kandidáti na lazy: väčšie panely, `commands.ts` časti (5 522 riadkov), vendored plugin kedy importovať.
- [ ] Zvážiť prehodnotenie budgetu (ak je 995 zámerný CI limiter, inak návrh: entry ≤ 900 KB).

### 2.2 Tempo-map split windows (scene-tempo seam)

Najväčšia zostávajúca audio-korektnosť položka: live prehodenie scene BPM pristane ~95–120 ms skoro na ne-muzikálnom okne (plánovač window edge) a offline prepína presne na clip boundary → počuteľná šva a live ≠ export.

- [ ] `Scheduler.tick()`: rozdeliť okno na scene-tempo boundary rovnako ako pri quantized pattern launch (vzor už existuje), `transport.setBpm` aplikovať až na boundary.
- [ ] Deterministický test: scene BPM zmena na bar 4 → udalosti po boundary používajú nové tempo presne od boundary.
- [ ] Po landed: overiť vs. `buildTempoMap` (offline) — parity test live↔offline timing.

### 2.3 Tick-mapped automation

`applyAutomation` píše 2 `setTargetAtTime` per wall-clock okno → schodovitý priebeh + ~75 ms stale-event wobble. Modulátory už tick-exact sú (`whenFor`).

- [ ] Prepnúť `applyAutomation`/`applySceneAutomationLane` na `timeAt(fromTick/toTick)` konverzie.
- [ ] Odstrániť 100 ms horizon asumpciu; riešiť stale-event overrides (dnes riešiteľné až s tick-mapped modelom).
- [ ] Pozor: zachovať modulator stream (cancel-based fix by jedol pending modulator kroky — preto sa to neopravovalo v audite).

### 2.4 Štart aplikácie

- [ ] Odmerať `createCoreServices()` (factory bank generácia) → first paint.
- [ ] Ak > ~1 s: lazy generovanie banky len pre assety, ktoré projekt reálne používa; zvyšok na demand.

### 2.5 Vitest 5 + Vite 8 migrácia

- [ ] Rieši esbuild advisory (dev-server) a peer mismatch (`@vitest/mocker` chce vite ^5).
- [ ] Plánovať na pokojný týždeň; full suite (186 súborov) je bezpečnostná sieť.
- [ ] Po migrácii: `npm audit` by mal zostať na 0 (prod) / len zinformované dev položky.

---

## Fáza 3 — Release engineering

- [ ] **CI na PR-y**: full suite + `test:browser` (playwright headless Chromium je v devDeps) + `tsc --noEmit` + build budget check.
- [ ] **PWA update flow**: manuálne overiť, že bežiaci tab po service-worker update nespadne a necommitnutá práca prežije (`autoUpdate` precache je nastavené).
- [ ] **Known limitations dokument**: residual list z `MAINTENANCE_AUDIT_PROGRESS.md` preklopiť do krátkeho user-facing „Known limitations" (marker cues v master WAVe, MIDI master clock jitter, collab neatomické solo zmeny, 32f WAV hard-clip).
- [ ] **Malé fixy zo residual listu** (~pol dna dokopy):
  - [ ] `bounce.ts` head-trim cez tempo-mapu + `stretchRate` scaling.
  - [ ] 32-bit float WAV: soft-knee namiesto hard-clipu pri ±1.0.
  - [ ] Seednúť fxeq „random" LFO (`src/effects/fxeq-core/dsp/lfo.ts` + rebuild `public/fxeq-worklet.js`) pre deterministické exporty.
  - [ ] Rozhodnúť `[!]`: marker cue one-shoty do master WAV exportu (áno/nie — dnes zámerne nie).
  - [ ] Rozhodnúť `[!]`: `bounceStemsToAudioClip` — wire-núť do UI alebo zmazať (je dokumentovaný v EDIT-ROADMAP, ale nikto ho nevolá).

---

## Čo pred releaseom NEROBIŤ

- ❌ Architektonické prepracovanie (YDocAdapter, AudioEngine diff-sync, commands.ts split) — je to po auditoch zdravé, len komplexné.
- ❌ Mass dependency upgrades okrem plánu 2.5.
- ❌ Nové features do prvého releasu — najprv upevniť to, čo je.

---

## Odporúčané poradie (ak sa robí len niečo)

1. Fáza 0 (commit) — **dnes**
2. 1.1 reálny prehliadačový test (hlavne iOS Safari)
3. 1.2 export parita (scene automation + intensity)
4. 1.3 snapshot restore UI
5. 1.4 import limity + cancel exportov
6. 2.1 bundle headroom
7. → release candidate → 2.2+ podľa spätnéj väzby

---

## QA log (doplňovať po testovaní)

| Dátum | Prehliadač | Verzia | Výsledok | Poznámky |
| ----- | ---------- | ------ | -------- | -------- |
| — | — | — | — | — |
