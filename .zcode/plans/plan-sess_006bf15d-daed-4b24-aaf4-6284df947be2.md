# Scene Mode na úroveň identity — implementačný plán

Prieskum ukázal, že engineová polovica Scene Mode je hotová a overená (intensity krivky live+offline, tempo seam split+anchor, všetky commandy, schema+collab pre lane dáta). Chýbajú štyri konkrétne veci. Realizujeme vo vlnách — **Vlna 1 teraz**, Vlny 2–3 ako naväzujúce bloky.

---

## VLNA 1 — základy (táto realizácia)

### 1.1 Fix: `scene.bpm` sa nesynchronizuje v collabe (bug, HIGH)
`YDocAdapter.ts`: `SCENE_SCALARS` (:572) neobsahuje `bpm`, `yMapToScene` (:254) ho nečíta, `sceneToYMap` (:1072) ho nezapisuje — scene tempo sa v jam session ticho stráca.
- Pridať `bpm` do všetkých troch ciest (voliteľné pole: zapisovať len keď je definované).
- Test: rozšíriť `tests/collab-hardening.test.ts` conformance fixture o scene bpm round-trip.

### 1.2 Fix: notové dĺžky na tempo šve (bug, audible)
V split okne živý scheduler počíta dĺžky so STARÝm tempom: `Scheduler.ts:792` (`event.note.duration * transport.secondsPerTick`), tiež MIDI note-off (:811) a capture ring (:804). Offline používa nové tempo (`renderer.ts:190,307`) → pri 120→240 BPM noty začaté v prvých ≤120 ms po šve znejú live ~2× dlhšie.
- Použiť spt z oknového split-mapa na štart-ticke noty (mapa už existuje — `songTimeAt`/`buildSplit`), fallback `transport.secondsPerTick`.
- Test: `tests/tempo-seam.test.ts` +1 — sustain nota cez seam má live dĺžku == offline (`toBeCloseTo`), regression padá na starom kóde.

### 1.3 Engine dostane efektívne (scene) BPM
`AudioEngine.syncBpm` sa volá len pri zmene `doc.bpm` (`AudioEngine.ts:1552-1560`) — SYNC delay texture, granular R-SYNC, LFO syncy zostávajú na projektovom tempe, kým transport beží na scene BPM.
- Nový `engine.setEffectiveBpm(bpm)` volaný zo `services.ts` (`applySceneTempo` cesta) aj z offline rendereru per-window (oba — zachová live==offline zákon).
- Rozsah: instrument runtimes `syncBpm`; frozen-align (`AudioEngine.ts:1112`) zdokumentovať ako rezidu (live-only, zvlášť citlivé — neriskovať).
- Test: render-parity test so scene bpm 120→pina 160 a SYNC-ovým efektom.

### 1.4 Intensity lane v ArrangementPaneli (HLAVNÁ položka)
Dnes sa intenzita edituje len v ModPaneli; arrangement nezobrazuje žiadne krivky.
- Nový strip pod `.arr-lane` v tom istom scroll kontajneri (`BAR_WIDTH` matematika): per clip-window polykrivka `scene.intensityCurve` (song mode) / vybranej scény (pattern mode), 0..1 y-os, hranica 0.7 neutrál svetlejšie.
- Interakcie copy-adaptované z `IntensityEditor` (ModPanel:1382): click pridá bod, drag s preview + commit-on-up jedno `setSceneIntensityCurve` (celá krivka, existujúci command), right-click maže. Drag pozície kvantizované na STEP_TICKS v scene-lokálnom ticku (rovnaká sémantika ako ModPanel).
- Playhead čítanie: `usePlayheadBar` + `computeSceneIntensity` → malý readout v lane heade.
- Toggle zobrazenia lane (koli priestoru), stav v dock/layout preferences podľa existujúceho vzoru.
- Testy (`tests/ui/ArrangementPanel.test.tsx` rozšíriť): lane renderuje krivku clipu; drag bodu emituje `setSceneIntensityCurve` s očakávanými points; right-click maže; pattern-mode fallback pre vybranú scénu.

### 1.5 (malé, akostná voľba) Authoring pre `source:"intensity"` makro mapovania
Engine plne podporuje intensity→parameter mapovania (`syncMacros`), ale žiadna UI/command cesta ich nevytvára. Do `MacroPerformanceBar`/makro UI pridať SOURCE voľbu „SCENE“ (command `addMacroMapping` rozšíriť o voliteľný `source`), takže VISION §11 „jeden významový parameter riadi mix“ sa dá kliknúť. Malý test na command.

### Verifikácia Vlny 1
`npm run typecheck` ✓ · full `vitest` ✓ (žiadne nové faily; +~6 nových testov) · `npm run test:browser` ✓ 197/197 · prípadný render-parity golden dotyk pri 1.3.

---

## VLNA 2 — wall-clock kompozícia (následný blok)
- **Rozhodnutie (odporúčané):** sekundy ako VSTUP, uložené zostávajú bar-y — bez zmeny schémy/renderera, determinizmus zachovaný. Konverzia `bars = sec·bpm·PPQ/(BAR_TICKS·60)` používa efektívne tempo scény (`scene.bpm ?? doc.bpm`), takže „32 s“ je vždy 32 sekúnd jej vlastného tempa.
- UI: v ArrangementPanel clip inspektore + ScenePanel pole „SCENE SECS“ (commit cez `resizeArrangementClip`), sekundový ruler už existuje — dorovnať konverziu na efektívne tempo scény (dnes používa len `doc.bpm`).
- Testy: konverzia matematiky + UI commit.

## VLNA 3 — Texture A-tier (následný blok, in-place podľa Bass v2/B4 receptúry)
- **Rozhodnutie:** zlučovanie s granularom odmietnuté z dôvodu dôkazov (granular je sample-based, bez samplu ticho končí; texture je sample-free drone — stratila by sa svoju identitu).
- Deterministická fáza LFO (per-track seeded/tick-anchored, podľa keys vzoru) → odomkne live==offline render test (dnes chýba z dôvodu wall-clock fázy).
- Evolving motion: LFO destície rozšírené (delay time, pan, noise level), tempo-sync rate cez W1.3 `setEffectiveBpm`.
- Unison 1..6 + spread (analog/wavetable vzor), attack/release parametre namiesto pevného 1.5 s flooru, voices 4→8, bohatší space (difúzia na delay loope).
- Presety 13→~16, clamped; normalizácia cez `defaultInstrumentParams` backfill — **žiadny schemaVersion bump**.
- Test gates: render-parity + determinizmus (granular pattern), browser-check poly + deterministický render.

## Guardrails (celý program)
Žiadna zmena `schemaVersion`; live==offline zákon každým krokom; determinizmus seeded; žiadne nové nástroje/efekty do počtu; každá vlna končí zelenou plnou verifikáciou a záznamom v roadmap dokumente.

Po schválení realizujem Vlnu 1 (1.1→1.5) s príslušnými testami a verifikáciou; Vlny 2–3 sú pripravené na následné spustenie.