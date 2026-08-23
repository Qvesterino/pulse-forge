# Plán: Wavetable Synth + Granular Synth (task 8)

## Zhrnutie
Pridáme **dva nové nástroje** — `wavetable` (badge **WT**) a `granular` (badge **GRN**) — cez existujúci registry pattern v `src/instruments/registry.ts`. Kľúčový záver prieskumu: **architektúra to umožňuje takmer bez zásahov do existujúceho kódu** — `InstrumentTrack.sampleId` + `env.getSample()` + `setSample()` už existujú a sú generické, takže user-import cez DropZone sa napojí bez zmien dátového modelu. Žiadny AudioWorklet nie je potrebný (iba stock node-y → offline render aj freeze fungujú automaticky). Navyše opravíme existujúcu dieru, že importované vzorky po reloade stratia audio.

Netýka sa: AudioEngine, Scheduler, Transport, commands, YDocAdapter, rendering — všetko je generické nad registry. Žiadne nové závislosti. Existujúce necommitnuté zmeny (src/ai/, GenerateDialog, …) zostávajú nedotknuté.

## Fáza 1 — Wavetable engine

**Nový súbor `src/instruments/wavetables.ts`** (čistá matika, testovateľná bez AudioContext):
- `interface Wavetable { name: string; frames: Float32Array[] }` — `FRAME_SIZE = 2048`, max ~16 frames
- `FACTORY_WAVETABLES`: ~5 tabuliek generovaných aditívne (Sine→Saw morph, PWM sweep, Formant, Digital/fold, FM-ish spektrá) — každý frame bez DC komponenty, peak-normalizovaný
- `extractWavetable(data: Float32Array, sampleRate): Wavetable` — detekcia periódy autokoreláciou na centrovanom okne (~50 ms), krájanie početných cyklov, resample na 2048 (lineárna interpolácia), equal-power wrap crossfade na hranách framov, normalizácia. Deterministická čistá funkcia.

**Registrácia v `src/instruments/registry.ts`** (vzor: analog/sampler):
- Parametre (~9): `table` (select z factory tabuliek), `morph` (0–1 pozícia v tabuľke), `detune`, `sub`, `cutoff`, `resonance`, `attack`, `release`, `gain`
- Factory: frame AudioBuffery sa postavia raz (pri výmene tabuľky/sample). Hlas = 2 loopované `AudioBufferSourceNode` (susedné framy podľa morph, `playbackRate = midiToFreq(pitch) * 2048 / sampleRate`) → crossfade gains [+ sub sine] → per-voice lowpass → amp ADSR (vzor zo sampleru, `makeVoiceManager(8)`). `setParameter("morph")` rampuje crossfade gains na živých hlasoch (`setTargetAtTime`). `setSample(id)` → re-extract tabuľky z `env.getSample(id)`; bez sample sa použije factory tabuľka z parametra. Celá envelope sa plánuje upfront v `noteOn` (offline-render safe).

**Typy**: `src/project-model/types.ts:28` rozšíriť `InstrumentKind` o `"wavetable" | "granular"`; `src/project-model/schema.ts:100` `INSTRUMENT_NAMES` (TS Record vynúti doplnenie). Pridať do `INSTRUMENT_DEFS` + `INSTRUMENT_ORDER` — `defaultInstrumentParams` a Inspector UI sa odvodia automaticky (kontroluje `tests/instruments.test.ts:7`).

## Fáza 2 — Granular engine

**Registry `granular`** (vzor: sampler + deterministický PRNG `mulberry32`/`hashString` už v kóde):
- Parametre (~10): `position` (0–1), `size` (20–400 ms), `rate` (1–60 grains/s), `jitter` (0–1 náhodný offset pozície), `spread` (0–1 stereo), `pitch` (±24 st), `reverse` (0–1 pravdepodobnosť), `tone` (lowpass), `shape` (0–1 grain envelope), `gain`
- Factory: `noteOn` naplánuje **všetky grainy upfront** (K = ⌈durationSec × rate⌉, cap 512): každý grain = BufferSource(offset = position ± jitter·rand, playbackRate podľa pitch, start(when + i/rate), stop(+size)) → raised-cosine (Tukey) gain envelope (~5 ramp bodov) → StereoPannerNode(±spread·rand) → per-voice amp (velocity ADSR) → spoločný lowpass → output. Deterministický seed z `hashString(track.id)` → offline render identický s live. `noteOff` zastaví naplánované grainy (sources majú `start()` už zavolaný, takže `stop()` na budúce grainy je legálne). Poly 6 cez `makeVoiceManager`. Bez sample ticho (rovnako ako sampler).

**Presety v `src/presets/factory.ts`**: ~6 na druh podľa konvencie `factory.wavetable.<genre>.<name>` / `factory.granular.<genre>.<name>` (napr. granular: Cloud Pad, Stutter, Timestretch, Cathedral Dust).

## Fáza 3 — Persistencia user vzoriek (oprava diery)

- `src/persistence/db.ts`: `DB_VERSION 4→5`, nový store `user-sample-audio` (id → ArrayBuffer; IDB structured clone zvláda bajty natívne). Aditívna zmena, existujúce storey nedotknuté.
- `src/persistence/UserSampleRepository.ts`: `save(asset, data?)` zapíše originálne enkódované bajty, `loadAudio(id)`, `listAudio()`; DropZone (`src/ui/DropZone.tsx`) prepojí `file.arrayBuffer()` do save.
- Boot v `src/services.ts`: po inite načítať audio záznamy a dekóduj cez `engine.context.decodeAudioData` (lazy per-record Promise → do `services.bank`), app funguje aj pred dokončením.
- Testy rozšíriť v `tests/persistence/UserSampleRepository.test.ts` (fake-indexeddb).

## Fáza 4 — UI

- `src/ui/TrackTabs.tsx`: options „Wavetable Synth“ / „Granular Synth“ + badge `WT`/`GRN` v `KIND_BADGE`.
- `src/ui/Inspector.tsx`: `SampleBrowser` (TONAL_ASSETS + DropZone) zobrazovať pre `sampler | wavetable | granular`; pre wavulator malé tlačidlo na zmazanie user source (návrat na factory tabuľku cez `setInstrumentSample(doc, id, null)`).
- **Nový `src/ui/WavetablePreview.tsx`**: canvas ~240×64 v Inspectore — wavetable: min/max obálky framov + amber morph kurzor; granular: waveform zdroja + pozíčné okno + grain indikátor. Prerender pri zmene parametrov (žiadny rAF beh). Helper `getWavetableData(track, bank)` s cachovaním extrakcie podľa sampleId.
- `src/styles.css`: `.wt-preview` v duchu design systemu (CSS vars, `.inspector` panel).

## Fáza 5 — Testy a docs

- `tests/wavetable.test.ts`: čistá matika (detekcia periódy na syntetickej 220 Hz sine, wrap kontinuita framov, DC ≈ 0), registry metadata, offline render cez reálne `OfflineAudioContext` (vzor `tests/instruments.test.ts:62`): audible peak, morph extrémy sa líšia v energii vysokých frekvencií, noteOff/panic/poly-steal/dispose.
- `tests/granular.test.ts`: počet grainov podľa duration×rate, offline render audible + ticho pred `when`, determinizmus (dva rovnaké rendery → identické peaky), noteOff strihá chvost, metadata.
- UI testy (`tests/ui/`): TrackTabs nové options, Inspector zobrazí SampleBrowser + parametre pre obe kindy (helper `mockServices`).
- `README.md` (5→7 nástrojov) + `FEATURES.md`.

## Overenie
`npm run typecheck:clean && npm test`; voliteľne `npm run dev` na manuálny test (upload WAV do WT, morph slider, granular cloud) a `npm run test:browser`.

## Riziká / mitigácie
- Počet node-ov pri dlhých granular notách → cap 512 grainov + poly limit.
- `exponentialRampToValueAtTime` vyžaduje nenulové hodnoty → držať sa existujúcich vzorov (0.0001 floor).
- Staré projekty s novými kindmi: `normalizeProject` merguje params s defaultmi (`schema.ts:398`), takže spätná kompatibilita je automatická.