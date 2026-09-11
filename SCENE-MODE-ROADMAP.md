# Scene Mode Roadmap — „hudba ako časový signál pre Qvester"

> Nadstavba na [`VISION.md`](./VISION.md) §10–11 (Scene Mode, Scene Intensity) a §22 (Score Package).
> Cieľ: dotiahnuť Scene Mode na úroveň produktovej identity — kompozícia proti wall-clock času, intenzita ako
> prvoradý editovateľný signál, sample-exact tempo švy.

Status legendy: `[ ]` pending · `[~]` robí sa · `[x]` hotové · `[!]` blocked / potrebuje rozhodnutie.

---

## Vlna 1 — základy `[x]` (2026-09-08)

- [x] **Collab fix: `scene.bpm` sa nesynchronizoval** — `YDocAdapter` nemal `bpm` v `SCENE_SCALARS`, `yMapToScene`
      ani `sceneToYMap` — scene tempo sa v jam session ticho strácalo. Pinned conformance fixture.
- [x] **Tempo seam: notové dĺžky** — v split okne živý scheduler počítal dĺžky not/MIDI note-off/capture ringu
      so STARÝm tempom (`transport.secondsPerTick`) kým offline použil nové — noty začaté pri šve zneli live ~2×
      dlhšie pri 120→240. Fix: lokálny spt z tej istej piecewise mapy, ktorá plánuje `when` (1-tick delta).
      Regression: `tests/tempo-seam.test.ts` (sustained note old/new side == offline, 9/9).
- [x] **Engine efektívne tempo** — `AudioEngine.setEffectiveBpm(bpm | null)`: tempo-synced runtimes (texture SYNC
      delay, granular rate sync, LFO syncy) dostávajú SCÉNOVÉ tempo (dostávali len doc.bpm). Live: services
      `applySceneTempo` + scheduler flip-commit `applyEngineTempo`; offline: renderer per window (live==offline zákon).
- [x] **Intensity lane v ArrangementPaneli** — krivka `scene.intensityCurve` je viditeľná a editovateľná priamo na
      timeline (clip window segmenty, click pridá bod kvantizovaný na step, drag s preview + commit-on-up, right-click
      maže, playhead % readout, INT toggle). Rovnaký undoable command ako ModPanel editor (`setSceneIntensityCurve`).
- [x] **Intensity → parameter authoring** — `addMacroMapping`/`addMacroTargetMapping` akceptujú
      `source: "intensity"`; ModPanel mapping draft má SOURCE voľbu MACRO/SCENE — engine binding
      (`syncMacros` intensity bipolar path) je teraz klikateľný bez ručnej úpravy dokumentu.

**Verifikácia Vlny 1:** `npm run typecheck` ✓ · full vitest ✓ (jediný flaky: fxeq morph perf gate je
environment-citlivý na tomto stroji, 2.34–2.58× okolo 2.4× budgetu — nie je to regresia tejto vlny, fxeq-core
nedotknuté) · `npm run test:browser` ✓ **197/197** · build + size budgety ✓.

## Vlna 2 — wall-clock kompozícia `[x]` (2026-09-10)

- **Rozhodnutie:** sekundy ako VSTUP, uložené zostávajú bar-y (bez zmeny schémy/renderera; determinizmus zachovaný).
  Konverzia `bars = sec · bpm · PPQ / (BAR_TICKS · 60)` používa efektívne tempo scény (`scene.bpm ?? doc.bpm`).
- [x] `src/project-model/scene-time.ts` — `effectiveSceneBpm` / `sceneBarsToSeconds` / `sceneSecondsToBars`
      (unit testy vrátane bars→s→bars round-tripu a NaN/0 pin fallbacku).
- [x] Pole „SECS" v arrangement clip toolbarri (pri vybranom klipe) — Enter/blur commituje
      `resizeArrangementClip` na celé bar-y pri efektívnom tempe scény; kolízia → action error.
- [x] Sekundový ruler je KUMULATÍVNY cez scény: každý clip span beží na svojom efektívnom tempe,
      medzery na projektovom (mark na bare 8 = 4 s @240 + 4 bar-y @124 = 11.7 s — pinned testom).
- [x] ModPanel ScenePanel: `LOOP x.xx s` info (dĺžka pattern loopu pri efektívnom tempe scény).
- [x] Testy: `tests/scene-time.test.ts` (4) + ArrangementPanel SCENE SECS blok (4) + ModPanel LOOP (1).

## Vlna 3 — Texture A-tier `[x]` (2026-09-10)

- **Rozhodnutie:** in-place upgrade (Bass v2 / B4 receptúra) — zlučovanie s granularom zrušené (granular je
  sample-based, bez samplu ticho končí; texture je sample-free drone engine).
- [x] Deterministická LFO fáza: LFO1/LFO2 sa vytvárajú vo factory, ale ŠTARTUJÚ až pri prvej noty (`when`) —
      fáza je ukotvená na note timeline, nie na wall-clock okamih stavby instrumentu. Odomkol render parity.
- [x] Evolving motion: DRIFT param (render-neutrálne 0) — LFO2 chveje delay time (±30 ms), LFO3 ťahá per-voice
      pan (±0.35); pri SYNC > 0 sa LFO rate synchronizuje s (scénovým) BPM cez `setEffectiveBpm` (Vlna 1).
- [x] Unison 1..6 + SPREAD (detune + pan fan), ATTACK/HOLD/RELEASE parametre (defaulty = pôvodné správanie:
      0.5 / 1.5 / 0.6 — render-neutrálne), DIFFUSE (all-pass difúzia v delay feedbacku, default 0), voices 4→8.
- [x] Presety 13→16: Evolution (ambient), Score Bloom (score), Pulse Bed (techno — SYNC-driven rhythmic bed).
- [x] Test gates: instruments.test ids/defaults/poly(8)/new-param render; browser-check „Texture Synth:
      deterministic render" (identické offline rendery, maxDiff < 1e-4 — granular pattern).
- Žiadny `schemaVersion` bump — nové parametre cez `defaultInstrumentParams` backfill.

## Guardrails

- Žiadna zmena `schemaVersion` — nové parametre cez definície + `normalizeProject` backfill.
- Live == offline zákon: každá zmena schedulingu/testovaná v oboch režimoch.
- Determinizmus seeded (žiadna wall-clock fáza v audio-rotume).
- Žiadne nové nástroje/efekty do počtu (VISION: 20 excelentných > 100 mediocre).
