# KYX → Audio Canvas: stemy + mapa nástrojov (world-class upgrade)

**Cieľ:** "Send to Qvester Visualizer" pošle **master + per-track stemy** (každý KYX track ako izolované WAV v shared IDB) + **source map artifact** (track name → rola drums/bass/chords/lead). Audio Canvas review karta zobrazí mapu nástrojov a umožní bindnúť master (default) alebo ľubovoľný stem — "drums only" vizualizácia jedným klikom. Vizuálová analýza ostáva ich vlastná (bindAudioFile reťaz).

## Fáza A — KYX sender (D:\pulse-forge)

1. `src/interop/qvesterHandoff.ts` rozšírenie:
   - `buildSourceMapEntries(doc)` (pure, testovateľné): non-group tracks → `{ trackName, role: roleOfTrack(track) ?? "lead", }` — roly z existujúceho `roleOfTrack` (role-presets.ts:27, FxTrackRole drums/bass/chords/lead).
   - `prepareBeatHandoff` rozšírenie: po masteri renderuje **per-track stemy** (max 6, `buildStemProject(doc, t => t.id === id)` + `renderProject(..., { masterProcessing: false })` — konzistentné s ich stems exportom), každý → IDB záznam + `sourceMap` pole v pakete: nový artifact `{ type: "kyx_source_map", value: JSON(entries) }`.
   - Záznamy zdieľajú ten istý IDB store + 24 h prune; `BeatHandoffRecord` dostane `role`/`trackName` polia.
2. Testy: source map builder (roly podľa inštrumentu aj name-fallback), paket so 2 artifactmi, IDB multi-record round-trip.

## Fáza B — AC receiver (QVESTER repa)

3. `kyxBeatHandoff.ts`: `extractKyxSourceMap(context)` — nájde `kyx_source_map` artifact, parsuje entries; `bindKyxStem(hash)` — IDB read → File → `bindAudioFileWithLegacyPrompt`.
4. `KyxBeatHandoffCard.tsx`: pod hlavným BIND tlačidlom zoznam **"Nástroje"** — riadky `♪ Drums · House Drums.wav [BIND]` — každý binduje ten stem; master BIND ostáva primárny (default akcia, zvýraznený).
5. Test: source map extraction (valid/junk/missing) v ich node-test štýle + registrácia do AC test scriptu.

## Fáza C — Registrácia + gates

6. `verify-kyx-handoff.mjs`: pridať check na source map (receiver + sender stringy). Docs: HANDOFF_MAP H53 payload riadok doplnený o stemy/mapu.
7. Gates: KYX typecheck+testy+sync; QVESTER typecheck+AC testy+build AC; commity oddelene (KYX → QVESTER), hneď po fázach.

## Fáza D — Verifikácia

8. Živá E2E (ak prostredie dovolí — inak manuálny návod): send → karta ukáže mapu nástrojov → bind master hrá mix → bind "Drums" hrá sólo bubny. Screenshot.
9. Produkčná poznámka: IDB ~8–10 MB na send (master + 3 stemy House), 24 h prune — OK.

## Riziká

- IDB veľkosť ×4 — rieši prune + TTL.
- roleOfTrack pre "Chords" (analog) ide cez name-fallback — priznané v mede (role "chords" cez regex \bchord\b ✓ pre House).
- AC multi-source PLAYBACK (všetky stemy naraz) je zámerne v1 nie — to je ich produktové rozhodnutie; v1 = master hrá, stemy sú bindovateľné zdroje + mapa.