# Fáza 2: KYX → Audio Canvas (SIQ) audio handoff — "beat drives the visualizer"

**Cieľ:** V KYX Export panele akcia **"Send to Qvester Visualizer"**: renderuje beat na WAV, uloží ho do shared IndexedDB a prenesie používateľa do Audio Canvasu (`/audio-canvas?handoff=<id>`), kde jedna akcia nabinduje beat do ich audio engine — ich vlastná deterministická analýza (bpm/key/Camelot/beatGrid cez `@qvester/audio-analysis`) naháňa beat-reactive vizuály. Metadáta (bpm/key z projektu KYX) idú v packetе ako hint.

**Kľúčové zistenia z prieskumu (všetko existuje, nič nevynachávame):**
- Packet konvencia: V1/V2 envelope, `InputArtifact.value` je vždy string — **binárka sa nikdy nevkladá**; sanctioned pattern pre veľké payloady je `qvester-blob:<hash>` pointer (SPEC V2 §2.2, imageSource.ts:45 + IDB `qvester-image-source-library` premoska).
- Bounded audio profil už cestuje medzi appkami: `AUDIO-CANVAS/src/interop/sendAudioAnalysisToCanvas.ts` (intent `apply_audio_to_canvas`, `?handoff=` + `?handoffIntent=`, sessionStorage+localStorage `qvester:handoff:<id>`, TTL 30 min, MAX_FRAMES=600).
- AC receiver reťaz: `bindAudioFile(file)` (audioProjectBinding.ts:109) = fingerprint → `engine.loadFile` → session update → vlastná analýza → reactive visuals. Receiver pattern: `readSiqHandoff.ts` (peek-then-consume, source/target/intent match) + `interopBanner.tsx` (explicitná akcia — rešpektuje ich `previewRequired/requiresExplicitCommit` konvenciu).
- Audio Canvas je mountnutý na `/audio-canvas` (config :298); `getRouteForApp` má route mapu pre return results.

## Fáza A — KYX sender (D:\pulse-forge)

1. `src/interop/qvesterHandoff.ts` (nový modul):
   - `keyToCamelot(key: MusicalKey)` — parse "<Root> <Scale>" → {key, mode, camelot} (12 roots; Major=8B… mapa podľa Camelot kruhu; mimo major/minor mode podľa treťej).
   - `storeBeatHandoff(blob, meta)`: IDB `qvester-audio-handoff` / store `blobs`, kľúč = SHA-256 hash (crypto.subtle), záznam {blob, name, bpm, key, mode, camelot, durationSec, sampleRate, createdAt} + prune >24h.
   - `sendBeatToAudioCanvas()`: render buffer (renderProject) → WAV blob (encodeWavAsync → Blob) → store → V2-style packet (`sourceApp:"pulse_forge"`, `targetApp:"audio_canvas"`, intent **`send_beat_to_audio_canvas`**, TTL 30 min) s artifactom `{type:"audio_master", label, uri:"qvester-blob:<hash>", value: JSON metadata}` + ArtifactPassport `{transport:"local-reference", privacy:"local-only"}` → persist `qvester:handoff:<id>` (session+local) → `location.assign(<origin>/audio-canvas?handoff=<id>&handoffIntent=send_beat_to_audio_canvas)`.
2. ExportPanel: nová akcia **"Send to Qvester Visualizer"** (render → send), zobrazená len keď `import.meta.env.BASE_URL !== "/"` (mounted context — cross-origin standalone nedáva zmysel; inline vysvetlenie).
3. Testy: `tests/qvester-handoff.test.ts` — camelot mapa, packet tvar (validovateľný), IDB write/read round-trip (fake-indexeddb alebo min stub), metadata bounds.

## Fáza B — Audio Canvas receiver (QVESTER repa, apps/atoma-visualizer/AUDIO-CANVAS)

4. `src/interop/kyxBeatHandoff.ts`: `readKyxBeatHandoff()` — `?handoff=` → `readHandoffPacket` (existujúci inboundHandoff) → validácia source=pulse_forge, intent, TTL → artifact `audio_master` → IDB read blob.
5. `StudioRoute.tsx` mount effect (vedľa existujúcich receiverov :921-949): keď príde KYX handoff → banner (interopBanner pattern) **"KYX beat: <name> — BPM <bpm> · <key> · Bind & visualize"** → akcia = `new File([blob], name)` → `bindAudioFile(file)` (celá ich reťaz: engine + analýza + reactive) → consume packet.
6. `returnResult.ts` `getRouteForApp`: `pulse_forge: "/pulse-forge"`.
7. Test: `src/interop/__tests__/kyxBeatHandoff.test.ts` (packet validácia + IDB round-trip + File wrap) v ich test štýle.

## Fáza C — Registrácia + certifikácia (QVESTER repa)

8. KG: `audio_canvas.handoffIn` += `pulse_forge/send_beat_to_audio_canvas`; `pulse_forge.handoffOut` += `audio_canvas/send_beat_to_audio_canvas`.
9. `docs/ECOSYSTEM_HANDOFF_MAP.md`: registry riadok + H-entry (Status | Priority | Rationale | Intent | Payload | Consumer logic | Monetization | QMR trigger) + `docs/QMR_HANDOFF_CERTIFICATION_REPORT.md` riadok (status packet-verified po overení).
10. `scripts/verify-kyx-handoff.mjs` (mirror verify-siq-interop-truth): AC receiver existuje, intent v AC zdroji, KG edge, dokandida; KYX sender strana = external (poznámka). npm script `verify:kyx-handoff`.
11. AGENTS.md riadok do interop sekcie.

## Fáza D — Verifikácia

12. Brány oboch rep: KYX (typecheck filtr., nové testy, build), QVESTER (typecheck, AC testy, constellation/content-integrity, drift — očakávam rovnaký pred-existujúci baseline 96).
13. **Živá E2E**: dev :4000 → `/pulse-forge` → template → Export → Send to Qvester Visualizer → AC sa otvorí s bannerom → Bind → beat hrá, analýza ready, vizuály reagujú. Screenshot.
14. Commity v oboch repách (len moje súbory — v QVESTER repu funguje ich session, ktorá resetuje tracked súbory → commitovať ihneď po každej fáze).

## Riziká

- Veľkosť WAV (master stereo 44.1k, ~10 MB/min) — IDB zvládne; packet ostáva malý (len pointer+metadata).
- Funguje len same-origin (mounted kontext) — v standalone KYX sa akcia nezobrazí; zdokumentované v UI.
- Ich session v QVESTER repu resetuje tracked súbory → po každej fáze commit len mojich súborov.
- Žiadne zmeny ich AudioEngine — receiver skladá existujúce API (bindAudioFile + banner pattern).