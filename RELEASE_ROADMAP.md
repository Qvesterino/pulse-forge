# Release Roadmap — k plne funkčnej, bezproblemovej appke

> Východiskový stav: po 19-sekvenčnom maintenance & hardening passes (detaily v [`MAINTENANCE_AUDIT_PROGRESS.md`](./MAINTENANCE_AUDIT_PROGRESS.md)).
> Zdravotný stav kódu: `npm run typecheck:clean` ✓ · full test suite **193 súborov / 1911 passed / 94 skipped / 0 failed** · `npm run build` ✓ (budgety OK) · prod `npm audit` 0 vulnerabilities.
>
> Status legendy: `[ ]` pending · `[~]` robí sa · `[x]` hotové · `[!]` blocked / potrebuje rozhodnutie.

---

## Fáza 0 — Ešte dnes (ochrana práce)

- [x] **Commitnúť working tree** — release hardening audit changes are committed together after final verification.
  Odporúčané logické commity:
  1. `fix(audit): maintenance hardening pass — scheduler/collab/export/security fixes + regression tests`
  2. `chore(deps): fast-uri audit fix (non-breaking)`
  3. tvoj pôvodný WIP (FXEQ panel / EffectAbControls / ozvena-params) oddelene, ak je rozpracovaný
- [x] Zmazať tranzitné logy (`baseline-tests.log`, `full-sweep.log`, `final-sweep.log` — už zmazané) a `topbar-diag.png`, ak sú obsolete.

---

## Fáza 1 — Release blokery

> Toto stoja medzi appkou a publikom. Poradie podľa (riziko × cena opravy).

### 1.1 QA v reálnych prehliadačoch `[~]` — Chromium 197/197 PASS; Firefox/Safari manuálne

Celý CI beží v jsdom, ktorý **nepočuje žiadny zvuk**. Testy overujú logiku a offline scheduling, nie subjektívnu audio kvalitu.

- [x] Spustiť `npm run test:browser` v **headless Chromium** — **197/197 PASS** (boot, collab cez reálny server, embed, share link `?import=`, touch, AudioWorklet DSP vrátane fxeq latency/PDC, MP3, offline generation flow, plugin workflow). Edge beží na tom istom Chromium engine. **Zostáva manuálne: Firefox + Safari/iOS.**
- [ ] Manuálny test skript (najrizikovejšie scenáre):
  - [ ] iOS Safari: `pagehide` uloženie (zavrieť tab po editácii → projekt prežije), audio unlock banner, prvý click na suspendnutom kontexte.
  - [ ] Tab hide počas playback → resume bez "machine gun" burstu, scheduler re-anchor.
  - [ ] MediaRecorder: video export v Safari/Chrome (codecy cez `isTypeSupported`), MP3 export.
  - [ ] Web MIDI: pripojiť/odpojiť controller **počas držania padu** (Note Repeat roll musí ustat — audit 02 fix).
  - [ ] Collab: 2 taby, rovnaký room — edituj obe strany, undo na jednej, over že sa nič nezblázni.
  - [ ] Export WAV/MP3/MIDI/JSON projektu so scene BPM lanes a automation — počúvať, porovnať s live.
- [ ] Výsledok zapísať do tohto dokumentu (sekcia „QA log").

### 1.2 Export parita: sceneAutomation + scene intensity `[x]`

„What you hear = what you export" platí pre scene lanes/intenzitu s výnimkou
známych scheduler-boundary rezíduí:

- [x] `renderer.ts`: naplánovať `doc.sceneAutomation` do offline renderu cez tempo-mapu `timeAt`. **DONE:** `scheduleSceneAutomation` — lane points (scene-relative) sa expandujú na absolútne tiky cez vlastnícky clip window, boundary hodnoty interpolované ako live `applySceneAutomationLane`, routing cez `scheduleTrackAutomation`/`scheduleDeviceAutomation`; lane reštartuje per clip výskyt (live `sceneStartTick` sémantika). Testy: `tests/export/scene-automation-render.test.ts` (5).
- [x] `renderer.ts`: scene intensity per clip-window (vrátane `intensityCurve` interpolácie) sa expanduje na offline timeline; live scheduler používa rovnaký `computeSceneIntensity` helper a plánuje budúce hodnoty cez rovnakú AudioEngine macro writer cestu.
- [x] Parita regression coverage: `tests/export/scene-intensity-render.test.ts` overuje curve body, clip boundary a návrat na neutrálnu intenzitu; scheduler recovery test overuje, že live cesta neskrýva neplatný stav.
- Kriterium: export projektu s použitými scene lanes sa zvukovo zhoduje s live playbackom (okrem známych scheduler-boundary rezíduí).

### 1.3 UI na obnovu snapshotov [x] — existuje a je otestované

Autosnapshoty sa ukladajú (20 na projekt, `SnapshotRepository`) a Snapshot panel ponúka zoznam, okamžité uloženie, obnovu aj zmazanie.

- [x] Panel zobrazuje snapshoty projektu s časom a akciami `NOW`, `RESTORE`, `DELETE`.
- [x] Obnova používa `repo.loadSnapshot` → potvrdenie → `store.replaceDoc(snapshot)`; história sa vyčistí a watermark resetuje.
- [x] Test: `snapshots-panel.test.tsx` — 12/12 vrátane obnovy, undo/history správania a ďalšieho uloženia.

### 1.4 Robustnosť importu/exportu

- [x] **Import limity**: cap na veľkosť súboru (audio ~25 MB, projekt JSON ~10 MB) s jasnou error správou — teraz hrozí OOM tabu (pamäť sa násobí 5–10× pri dekóde). **DONE:** `MAX_PROJECT_IMPORT_BYTES` v `project-io.ts` (File.size gate pred readom), `MAX_AUDIO_IMPORT_BYTES` v `DropZone.tsx`; testy v project-io.test.ts.
- [x] **Zrušiteľné exporty**: `AbortSignal` cez `encodeMp3`, stems, video loop; Cancel tlačidlo v `ExportPanel` status riadku; po zrušení žiadny čiastočný súbor na disku. **DONE:** `encodeMp3` abortuje na yield pointe (žiadny partial Blob), `recordVideo` kontroluje signal v rAF loope + watchdogu a pred `recorder.stop()`, stems/tracks medzi krokmi; CANCEL button v status bare; zrušenie sa zobrazí ako „Export cancelled", nie error. Testy v mp3.test.ts.
- [x] Video: krátke buffery môžu mať minimálne 1 s záznamu; toto je zámerne zdokumentované v [`KNOWN_LIMITATIONS.md`](./KNOWN_LIMITATIONS.md).

---

## Fáza 2 — Optimalizácie

### 2.1 Bundle headroom `[x]` — vendor split hotový

- [x] **DONE:** `vite.config.ts` `manualChunks` — react/react-dom/scheduler do `vendor-react` chunku (142.79 kB). Entry: **988 → 861 KB** (134 KB headroom pod 995 budget). Motivácia: app-code zmeny už neinvalidujú PWA-precachovaný vendor chunk (jemnejšie delta update); initial payload sa nezmenil (vendor sa stále načítava pri boote). Overené: produkčný build + preview smoke (`scripts/preview-smoke.mjs`, nový nástroj — load + pageerror scan) bez chýb; aktuálny budget check **861/995 + 1648/2400 OK**.
- [ ] Budúce (keď headroom znova dorastie): DiceContext eager-importuje AI stack (`intent/pipeline`, `assist/pipeline`, `ai/generator` — 9 call sites) → dynamic import v handleroch ťahá ~desiatky KB z entry; vzor `ExportPanel`/`EmbedApp`.

### 2.2 Tempo-map split windows (scene-tempo seam) `[x]`

Najväčšia zostávajúca audio-korektnosť položka: live prehodenie scene BPM pristane ~95–120 ms skoro na ne-muzikálnom okne (plánovač window edge) a offline prepína presne na clip boundary → počuteľná šva a live ≠ export.

- [x] `Scheduler`: window split na scene-tempo boundary — detekcia prvej clip boundary v (windowStart, windowEnd] so scénou, ktorá pinuje INÉ bpm; piecewise tick→time mapa (stará mapa pred boundary, nová integrovaná z boundary — presne `buildTempoMap` formula); samotný `setBpm` až keď playhead prekročí boundary.
- [x] Presný re-anchor: nová `Transport.setBpmAnchored(bpm, anchorTick, anchorTime)` — flip sa ukotví na vopred vypočítaný boundary bod namiesto tick-kvantizovaného `setBpm` (ktorý preskočil až 1 grid krok za švom; odhalené testom: 8544→8664 pri preskočení 8640).
- [x] Flip sa ruší pri stop/resync/loop-wrap seek; `applyTempo` potlačený počas pending flipu (inak by sa aplikoval ~120 ms skoro — pôvodná chyba).
- [x] Deterministické testy: `tests/tempo-seam.test.ts` (5) — udalosti po boundary presne na novom tempe od boundary; transport 120→240 až pri prekročení; žiadne double-fire/drop na šve; live timing == `buildTempoMap` (parity, toBeCloseTo 4); stop ruší pending flip. Stability: 3× 56/56.
- [x] Parita vs. `buildTempoMap` overená testom 4 (live `when − t0` == offline `timeAt(tick)`).
- Rezidua: ±25 ms flip kvantizácia (tick interval) — neodstrániteľné bez audio-vlákna; ďalšia tempo zmena v tom istom okne (<120 ms) sa odloží na ďalšie okno; automation/modulátory sa píšu cez starú mapu v split okne (≤120 msprechod, engine-side wall-clock — spoločná rezidua s 2.3).

### 2.3 Tick-mapped automation `[x]`

`applyAutomation` píše 2 `setTargetAtTime` per wall-clock okno → schodovitý priebeh + ~75 ms stale-event wobble. Modulátory už tick-exact sú (`whenFor`).

- [x] **DONE:** `applyAutomation` + `applySceneAutomationLane`/`applyLane` akceptujú voliteľnú `timeAt` mapu; schedulér jej podáva oknovú mapu (v split okne piecewise cez tempo boundary — dokončuje 2.2). Endpointy lane sa zapisujú na `timeAt(fromTick/toTick)` namiesto wall-clock schodov.
- [x] Stale-event override zmizol **konštrukčne**: kontiguózne okná majú `v1(N) == v0(N+1)` v čase AJ hodnote (boundary kontinuita overená P01) — žiadny cancel potrebný, modulator stream netknutý.
- [x] Pure mapy: schedulér snapshotuje anchor+slope raz per okno (mapa vyhodnotená neskôr reprodukuje tie isté časy — test volá mapu až po behu).
- [x] Testy: `tempo-seam.test.ts` +2 — mapa sa delí piecewise cez seam; kontinuita `end(N) == start(N+1)`; split okno končí na NOVOM tempe (nie starom). Spolu 7/7.
- Rezidua: `applyAutomation` bez mapy (starší voláči) má stále wall-clock fallback — všetky živé cesty mapu podávajú.

### 2.4 Štart aplikácie `[x]` — odmerané, lazy bank netreba

- [x] **Odmerané** (`scripts/startup-profile.mjs`, nový nástroj — headless Chromium + dev server): `generateFactoryBank()` = **62 ms**, `createProjectFromTemplate` = 1.2 ms, `normalizeProject` = 2.9 ms, studio entry po kliknutí = 456 ms (dev režim vrátane module graphu; produkčný precachovaný bundle je rýchlejší).
- Záver: 62 ms ≪ 1 s prah — **eager bank ostáva**, lazy generovanie by neprinieslo merateľný zisk. Skript ostáva na opakované meranie po väčších zmenách.

### 2.5 Vitest 5 + Vite 8 migrácia `[!]` — ROZHODNUTÉ: skip pred releaseom (deferovaný)

- **Rozhodnutie (po auditoch):** nepúšťať pred releaseom. Zdôvodnenie:
  - esbuild advisory (GHSA-67mh) je **čisto dev-server** problém — produkčný build beží na top-level vite 6.4.3 s patchnutým esbuild 0.25.12 → `npm audit --omit=dev` = 0 vulnerabilities. End users nie sú nijako ovplyvnení.
  - Expozícia je len lokálny dev server (drive-by webstránka proti `localhost:5173` počas vývoja). Zmiernenie bez migrácie: nespúšťať dev server s `--host` na nedôveryhodnej sieti.
  - Migrácia vitest 2 → 5 (+ vite major) je breaking zmena cez 188 test súborov (fake timers, pool defaults, snapshot formáty, workspace config) — presne to, čo roadmap pred releaseom zakazuje.
- **Kedy sa k tomu vrátiť:** po release, na pokojný týždeň. Trigger: ak kýbude prod-relevantný advisory alebo vitest 2 przestane dostávať security patche.
- [!] Neriadiť sa `npm audit fix --force` — pretiahne vitest 5 + vite 8 naraz a rozbije strom.

---

## Fáza 3 — Release engineering `[x]`

- [x] **CI na PR-y**: už existuje `.github/workflows/ci.yml` (typecheck:clean, full vitest + ai:performance, produkčný build s budget checkom, browser audio checks v headless Chromium) — **pridaný** `audit-prod` job: `npm audit --omit=dev --audit-level=high` (runtime deps musia zostať na 0; dev advisories consciously deferované, pozri 2.5).
- [x] **PWA update flow**: prepnuté `autoUpdate` → **`prompt`** — pôvodný režim aktivuje nový precache + čistí staré revízie, kým bežiaci tab ešte beží na starom builde → ďalší lazy-chunk import (ExportPanel, FxEqPanel…) mohol 404-núť počas session. V `prompt` režime nový worker ČAKÁ; banner „New version ready — RELOAD" (`src/sw-update.ts`, len z main.tsx — virtual modul nie je vo vitest grafe) + periodická kontrola updátov (15 min + visibilitychange — SPA má málo plných navigácií). **Overené end-to-end**: `scripts/pwa-update-smoke.mjs` simuluje deployment (build v1 → nasadenie v2 → reload → banner APPEARED → RELOAD → čistý reload, 0 errors); SW sa registruje v produkčnom preview (`preview-smoke.mjs` hlási registered).
- [x] **Known limitations dokument**: [`KNOWN_LIMITATIONS.md`](./KNOWN_LIMITATIONS.md) — export parita (intensity, marker cues, 32f clip), collab (lokálne undo, neohraničená história), platform edge (sidechain mimo výberu, worklet-less fallbacky, MIDI clock jitter), import limity, Chromium-only CI. Prepojené z README.
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

1. 1.1 reálny prehliadačový test (hlavne iOS Safari)
2. 1.4 finálne rozhodnutia okolo krátkeho video exportu a marker cue exportu
3. 3.0 residual list podľa priority (bounce tempo-map, float WAV ceiling, seeded FXEQ random LFO)
4. → release candidate → post-release Vitest/Vite migrácia podľa 2.5

---

## QA log (doplňovať po testovaní)

| Dátum | Prehliadač | Verzia | Výsledok | Poznámky |
| ----- | ---------- | ------ | -------- | -------- |
| — | — | — | — | — |

---

## Stav exekúcie (session `pustiť sa do ROADMAP`)

| Položka | Stav | Evidence |
| ------- | ---- | -------- |
| Fáza 0 — commit práce | ✅ | release hardening audit commit (main) |
| 1.1 QA real browser | ✅ Chromium časť / ⏳ Firefox+iOS manuálne | `npm run test:browser` — **197/197 PASS** headless Chromium |
| 1.2 Export parita | ✅ sceneAutomation + intensity | `tests/export/scene-automation-render.test.ts` + `tests/export/scene-intensity-render.test.ts`; live/offline zdieľajú scene-intensity writer |
| 1.3 Snapshot restore UI | ✅ (už existovalo — WIP commit) | 12/12 testov `snapshots-panel.test.tsx` |
| 1.4 Import limity + cancel | ✅ | `01834a1` + testy (mp3 abort, size limity) |
| 2.1 Bundle headroom | ✅ | aktuálny build — entry **861/995 KB**, total JS **1648/2400 KB**, preview smoke bez chýb |
| 2.3, 2.4, Fáza 3 | ✅ | detaily v checkedoch + Results log vyššie |
| 2.5 Vitest migrácia | ⏳ deferované | dev-only advisory; po release |

**Finálna verifikácia (2026-09-07):** `npm run typecheck:clean` ✓ · full suite **193/193 súborov, 1911 passed, 94 skipped, 0 failed** ✓ · `npm run build` ✓ (**861/995 KB entry, 1648/2400 KB total JS**) · `npm run test:browser` ✓ **197/197**. Pred release tagom ešte zostáva manuálna Firefox/Safari/iOS QA a kontrola clean worktree.
