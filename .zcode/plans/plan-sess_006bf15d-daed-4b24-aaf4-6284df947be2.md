# Kurátorská factory zvuková vrstva — implementačný plán

**Cieľ (VISION §5 „factory content is part of the product"):** malá kurátorská vrstva nahraných/excelentných zvukov, ktorá preberie kľúčové factory sloty, so syntetizovaným kitom ako garantovaným fallbackom. Prieskum potvrdil najnižšie riziko: **same-id override** — kurátorské WAV-y sa registrujú pod existujúcimi `factory.*` id; `SampleBank.add` prepisuje, syntéza sa staví prvá (62 ms), fallback je teda konštrukčný. Nulové zmeny kitov/presetov/šablón/projektov.

## Rozhodnutia (odporúčané, používateľ môže zmeniť)
- **Seed obsah:** 6 seed WAVov vygenerovaných cez vlastný mastering chain (tape + limiter) — pipeline testovateľná dňa 1; používateľ nahrádza súbory reálnymi nahrávkami (rovnaké mená, nulový kód).
- **Export parita:** live = progresívny override; offline export/scorepack/embed = `await` kurátorskej vrstvy s timeoutom ~2 s → syntetizovaný fallback.

## Implementácia

### 1. `src/sample-library/curated.ts` (nový modul)
- `CURATED_SAMPLES: { id: string; file: string; gain?: number }[]` — explicitný manifest (6 slotov: `factory.kick.deep`, `factory.kick.punch`(alias existujúceho id), `factory.snare.punch`, `factory.hat.closed`, `factory.clap.tight`, `factory.tonal.keys`; finálny zoznam dorovnám k existujúcim id v BUILDERS).
- `loadCuratedLayer(bank, { signal, timeoutMs }): Promise<{ loaded: number; failed: string[] }>` — fetch `/samples/<file>`, decode cez throwaway `OfflineAudioContext` (vzor `UserSampleRepository.defaultDecodeAudioBytes`), `bank.add(id, buffer × gain)`. Per-file error izolácia (404 = skip, ostatné id nezastaví), konkurencia cap 4, celkový limit ~30 MB.
- `curatedReady(): Promise<void>` — jednorázová (memoized) promise pre export paths s timeoutom.

### 2. Wiring
- `services.ts createCoreServices`: `void loadCuratedLayer(bank)` hneď vedľa `restoreUserSampleAudio` (fire-and-forget) + počet do diagnostics.
- `renderer.renderProject` + `scorepack.renderCueAsset` + `EmbedApp`: `await curatedReady()` pred renderom (timeout 2 s → syntetizovaný fallback; determinizmus per-inštalácia zachovaný — po prvom načítaní je vrstva v pamäti vždy).

### 3. PWA / offline (local-first podľa VISION §24)
- `src/pwa.ts`: `globPatterns` + `"samples/*.wav"`; `maximumFileSizeToCacheInBytes` explicitne (napr. 4 MB/súbor — workbox default 2 MB by väčšie ticho vynechal).
- `tests/pwa.test.ts`: assertion update.

### 4. `public/samples/` + README kontrakt
- `README.md`: formát (WAV 44.1/48 kHz, mono aj stereo), pomenovanie = id mapping v `curated.ts`, loudness odporúčanie (~-6 dBFS peak, krátky tail), fungovanie fallbacku, ako nahradiť seedy.

### 5. `scripts/render-curated-seeds.mjs` (nový generátor)
- Playwright bridge (vzor `startup-profile.mjs`): otvorí app v headless Chromium, cez `page.evaluate` vyrenderuje 6 zvolených assetov z reálnej syntézy **cez mastering chain** (tape + limiter), `encodeWav` 24-bit, node zapíše do `public/samples/`. Seed = zlepšený zvuk (glue) + demonštrácia pipeline; npm script `curated:seeds`.

### 6. Testy
- Unit: `tests/curated-samples.test.ts` — mock fetch (404 → fallback zostáva, syntetizovaný buffer prežije; 200 → bank override; gain aplikovaný; timeout cesta).
- Browser-check: „curated layer overrides factory synth after load" (po seedoch: bank.get(id) !== synth render / alebo URL fetch + decode reálne prebehne a id sa zmení).
- PWA test update; existujúce `browser-checks.ts` bank-size assertion zostáva zelený (same-id, žiadne nové id).

### 7. Verifikácia + dokumentácia
- typecheck · vitest (curated/pwa/instruments) · `npm run curated:seeds` · build + budgety (WAVy mimo JS budgetov) · browser QA full.
- KNOWN_LIMITATIONS/README poznámka: kurátorská vrstva = drop-in, seedy = placeholder na nahradenie.
- Commit.

## Trvanie / riziko
Stredné; najriskantnejší kus je playwright generátor (browser bridge) — fallback: seedy vyrenderovať cez dev-time `page.evaluate` manuálne a commitnúť binárky. Žiadne zmeny schémy ani audio engine.