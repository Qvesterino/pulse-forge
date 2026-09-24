# KYX → Qvester audio-profile bus: `pulse_forge` ako live audio kanál ekosystému

**Cieľ:** Kým KYX hrá, periodicky publikuje **ohraničený 10-s analytický profil** (energy/beat/band krivky + bpm + beatPhase + bands) na channel `pulse_forge` cez ich `publishAudioProfile` konvenciu. Konzumenti (canvas-virtuoso ako prvý) krivky loopujú lokálne — vizuály reagujú na KYX playback. Rešpektuje ich doktrínu: žiadne per-frame streamovanie, publish throttle, clear ako sign-out.

## Fáza A — Publisher modul (D:\pulse-forge)

1. `src/interop/qvesterProfileBus.ts` (nový):
   - **Rolling window**: Float32Array okná (300 vzoriek ≈ 10 s @ 30 Hz) pre energy/beat + bandCurves {bass, lowMid, mid, highMid, high}; write-index ring.
   - **Vzorkovanie** (v RAF, gate ~33 ms, len keď `transport.playing`):
     - energy = RMS z `getMasterLevels()` (existujúce, žiadna nová DSP),
     - bands = bin-suma z `getMasterSpectrogramAnalyser()` (`getFloatFrequencyData` dB → [0,1] mapou −90..−10 dB) cez existujúce `createSpectrogramBandMap` (spectrogram.ts:56),
     - beat krivka = 1 na beat gride z transport pozície (positionBeats frakcia × bpm) — presné, nie detekcia.
   - **Publish každé ~3 s** (ak window ≥ 2 s): downsample ≤600 framov → `CanvasAudioAnalysisProfile` {bands (aktuálne), bpm: doc.bpm, beatPhase, duration, sampleRate: 30, curves} → `publishAudioProfile("pulse_forge", profile)`. Tvary podľa ich kontraktu presne (≤600, ≤10 s, clamp [0,1]) — aby ich `sanitizeAudioProfileForBus` nič nerobil.
   - **Životný cyklus**: start = studio mount (App.tsx efekt, idempotentné); stop publishu pri pauze (okno mrazí, posledný profil ostáva — konzumenti loopujú ďalej); `clearAudioProfile("pulse_forge")` pri unmounte (ich sign-out path).
2. wiring v `src/ui/App.tsx`: jeden useEffect → `startQvesterProfileBus(services)`.
3. Testy `tests/qvester-profile-bus.test.ts`: window ring roll, profile builder bounds (600/10 s/clamp), beat grid fázovanie, publish gating + channel/key — s fake localStorage; tvar validovaný zrkadlom ich kontraktu.

## Fáza B — Prvý konzument (QVESTER repa)

4. `apps/canvas-virtuoso/src/services/signals.ts`: pridať subscription `subscribeAudioProfile("pulse_forge", …)` s rovnakým handlerom ako `audio_canvas` (3 riadky — ich last-writer-wins slot už má loop mechaniku). Od tej chvíle **canvas-virtuoso vizuály modulujú z KYX playbacku**.
5. `docs/QVESTER_AUDIO_PROFILE_BUS_V1.md`: follow-up #1 doplniť — pulse_forge je prvý stojaci publisher (okrem plánovaného Audio Canvas).

## Fáza C — Brány + verifikácia

6. KYX: typecheck (filtrovaný), nové testy, `vite build` default (nezmenený) — žiadny SW/bundle dopad okrem nového chunku.
7. QVESTER: ich typecheck, canvas-virtuoso build (`--app canvas-virtuoso`), ich testy canvas-virtuoso interop (audioProfileBus.test), constellation/content-integrity.
8. **Živá E2E**: :4000 → /pulse-forge → House → play → evaluate read `qvester:audio-profile:v1:pulse_forge` (revision rastie, bpm 124, krivky živé) → otvoriť /canvas-virtuoso v druhej karte → vizuály modulované. Screenshot.
9. Commity v oboch repách hneď po fázach (QVESTER session resetuje tracked súbory!).

## Riziká

- localStorage zápis ~5–15 KB JSON každé 3 s — akceptovateľné (ich kontrakt počíta s tým; quota guarded).
- Per-frame join medzi RAF a audio vláknom — len existujúce gettery (žiadne nové DSP/worker).
- canvas-virtuoso diff je malý, ale v ich release repu — commitovať odlišene.