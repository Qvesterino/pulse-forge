# INSTRUMENT-ROADMAP.md

# Pulse Forge — Instrument Quality Roadmap
> Implementačná roadmapa pre rozmanitosť a editovateľnosť nástrojov. Nadstavba na `DSP-ROADMAP.md` a `VISION.md:187` (20 excelentných > 100 mediocre).

**Filozofia:** Pulse Forge je nástroj **východne na beaty/inštrumentály** — žiadny vokál, žiadne VST. Každý nový nástroj musí pokryť reálnu beatmaking potrebu (kick, snare, keys, pluck, bass, texture) a priniesť **editovateľnosť** (p-lock, automatizácia, preset). Kvantita je zmrazená na 9–10 druhov, rastie kvalita.

---

## 0. Ako používať tento dokument
- Odškrtávame `- [x]` až keď je vec **implementovaná a overená** (`npm run typecheck` + `vitest` + `live==offline` render). Ku odškrtnutej položke doplň dátum + PR.
- Hotové položky **nemažeme** — história.
- Nové nápady pridávame na koniec príslušnej fázy.
- Poradie fáz je záväzné: B1 → B2 → B3 → B3b → B4 → B5.

---

## 1. Audit súčasného stavu (02. 09. 2026)

Inventár `src/instruments/registry.ts:1577` a `src/project-model/types.ts:47`:

| Nástroj | Paramy | Hlasy | Jadro | Tier | Stav |
|---|---|---|---|---|---|
| Sampler | root/attack/release/cutoff/reso/gain | 16 | `BufferSource` + `Biquad` | C | funkčný, bez stretch |
| Analog | oscA/B/sub/noise/cutoff/reso/env/level | 12 | 2 osc + sub + noise → `Biquad` → amp | C | solídny, Biquad strop |
| Bass | sub/body/punch/grit/movement/width/cutoff/reso/level | 4 | saw+square+sub + drive | C | sémantické makrá |
| 808 | decay/pDrop/click/drive/tone/gain | mono | sine drop + click | C | ok |
| Texture | color/motion/space/density/texture/chaos/level | 4 | 3 LFO + delay | C | ok |
| Wavetable | table/morph/detune/sub/cutoff/reso/attack/release/level | 8 | 2× frame looper + sub | B+ | najlepší custom DSP |
| Granular | position/size/rate/jitter/spread/pitch/reverse/tone/shape/attack/release/gain | 6/512 grainov | deterministic grain cloud | B+ | deterministický |
| Keys (FM/Rhodes) | tine/bell/body/damp/tremolo/width/cutoff/reso/attack/release/level | 8 | 4-op FM `1→2` + `3.5→4` → `Biquad` → amp + trem | C | **nový B1** |
| Pluck (KS) | pick/damp/body/tone/decay/width/cutoff/reso/attack/release/level | 12 | `Delay(1/freq)` + `Biquad` feedback 0.82..0.995 | C | **nový B2** |
| Drum Synth (HH) | type hatClosed/hatOpen/clap/perc/cowbell + decay/tone | — | per-pad `noise→HP/BP → gain` alebo `square→BP` | C | **nový B3** `types.ts:95` `AudioEngine.ts:1895` |

**P-locky** `src/project-model/types.ts:205` `pitch|gain|pan|cutoff|sampleStart|length` (6) — per-step, `live==offline` cez `groove.ts:29` → `AudioEngine.ts:1914` → `renderer.ts:95`.

**Piano Roll** `src/ui/PianoRoll.tsx:299` — toolbar `QUANT/DUP/SPLIT/GLUE/REV/HUM/STRUM/V±/COPY/PASTE` + `nudge ◀▶▲▼` + `ARP/RPT` + marquee `shift+drag` + velocity lane multi-drag `PianoRoll.tsx:226`.

**SliceLab v2** `src/ui/SliceLab.tsx:46` — zoom drag/wheel + playhead `requestAnimationFrame` + `SNAP ZC` (default OFF) `zeroCrossSnap` + `NORM` preview gain + `BPM PREVIEW` pitch-shift.

---

## 2. Ciele kvality

1. **Sample-free kit** — kick/snare/hat/clap/perc bez WAV (B3b).
2. **Zvukový strop** — SVF/TPT namiesto `Biquad` pre `analog/keys/pluck` (B4).
3. **Sampler bez chipmunk** — pitch bez zmeny dĺžky pre tonal chopy (B5).
4. **Každý nástroj 5 presetov** `src/presets/factory.ts` — warm/bright/dirty/ambient/score, clampnuté.
5. `live==offline` a `determinizmus` (seeded) — každý nový nástroj musí prejsť `render-event-parity` a `groove.test`.

---

## 3. Guardrails (instrumentály)

- [x] Žiadna vokálna doména — `VocalForge` vlastní.
- [x] 9–10 druhov hotovo — ďalší len ak nahradí slabší.
- [x] 20 excelentných > 100 mediocre — nový nástroj len ak existujúci nevie výsledok.
- [x] Natívne uzly len na utilitu (`gain/pan/splitter`); čo znie → Worklet.
- [x] Determinizmus — každý nový hlas musí byť `mulberry32(hash(trackId:pitch))` a `voice oldest-steal`.

---

## 4. Roadmapa

### B3b — Drum Kick/Snare synth (sample-free kit) — **PRIORITA 1**

Cieľ: `hatClosed/hatOpen` už funguje `types.ts:95` `AudioEngine.ts:2089`; pridať `kick` + `snare` aby `DrumPad` s `assetId==null && synth` zahral celý kit bez WAV.

- [ ] `types.ts:95` `DrumSynthType |= "kick" | "snare"`
- [ ] `AudioEngine.ts:2089` `triggerSynth` vetvy:
  - `kick`: `sine 150→45 Hz expRamp 0.09 + amp decay 0.42` + `click` noise HP 1500 0.01 (ako `factory.ts:75` `kick()`), `decay` lock → `amp` decay, `tone` → `click` level, `pitch` → `startHz`
  - `snare`: `triangle 192 Hz 0.11 + noise BP 1750 Q0.9 0.2` (ako `factory.ts:111` `snare()`), `cutoff` → `BP freq`, `length` → `noise decay`
- [ ] `schema.ts:572` `normalizeTracksDomain` — `allowed` rozšíriť o `kick|snare`, `def` decay/tone
- [ ] `Inspector.tsx:138` `SYNTH` select pridať `Kick` / `Snare` s default `kick {decay 0.42 tone 150}`, `snare {decay 0.2 tone 1750}`
- [ ] 2 presety: `factory.drum.kick.808` + `factory.drum.snare.punch` nie sú potrebné (pad synth nemá `factory` preset, len pad default) — stačia 2 pad defaults.
- [ ] Verifikácia: `vitest` `plock-length-export.test.ts` rozšíriť o `kick/snare` carry, `SliceLab` chop stále sample, `Drum Rack` preview bez WAV hrá.

### B4 — SVF/TPT pre analog/keys/pluck (zvukový strop) — **PRIORITA 2**

Cieľ: `Biquad` → `Chamberlin SVF` (semi-implicit) pre per-voice lowpass s `drive` tanh, `resonance 0..1` self-osc.

- [ ] `src/audio-worklets/svfilter-processor.js` už existuje (B1.1) — použiť `createSvFilterNode` `src/audio-worklets/svfilter-node.ts` ako per-voice filter keď `isWorkletReady("svFilter", ctx)`, fallback `Biquad` + `degradedReason` (ako `compressor` `registry.ts:52`)
- [ ] `registry.ts:1604` `keys` + `analog` `liveFilters` `Set<AudioWorkletNode>` namiesto `Biquad`, `setParameter` → `AudioParam` `cutoff/resonance`
- [ ] `AudioEngine.ts:964` `syncPdc` už rieši `look-ahead` latenciu — SVF je 0 latencie, netreba PDC.
- [ ] Verifikácia: `browser-check` `LP 200 Hz only, HP rms` ako `DSP-ROADMAP.md:189` P1.1.

### B5 — Sampler time-stretch (pitch bez dĺžky) — **PRIORITA 3**

Cieľ: `sampler` `pitch` nemení `duration` pre tonal chopy.

- [ ] `sampler` `params` pridať `mode: 0 pitch | 1 stretch` `registry.ts:506`
- [ ] `src/audio-workers/time-stretch.ts` (nový) — `WSOLA` 30ms grain, 10ms hop, `OfflineAudioContext` offline path, `AudioWorklet` `stretch-processor.js` live path s `3×` grain crossfade, fallback `playbackRate` (chipmunk) + `degraded`.
- [ ] `sampler` `factory` `registry.ts:517` — keď `mode==stretch` a `isWorkletReady`, pošli buffer do Workletu s `pitchRatio`, inak `playbackRate` (staré chovanie).
- [ ] `Inspector` `sampler` panel — `MODE` select `Pitch / Stretch`.
- [ ] Verifikácia: `sampler.test` — `C4` transpozícia +12 st, `duration` zostane `±2%`.

---

## 5. Architektonické riziká

- Look-ahead latencia vs stems — SVF 0, limiter 5ms už rieši `syncPdc` `AudioEngine.ts:964`.
- Fallback stratégia — každý nový Worklet musí mať `bypass + warning` (ako `gate/transient` `registry.ts:62`).
- Live == offline — každý nový hlas testovať paralelne `browser-checks.ts` + `renderer.ts:88`.
- Verzionovanie — nový `InstrumentKind` nevyžaduje migráciu `schemaVersion` (ostáva 1), len `normalizeProject` `schema.ts:572`.

---

## 6. Odporúčané poradie práce

1. **B3b** (1 deň) — najväčší beatmaking dopad, 50 riadkov.
2. **B4** (2 dni) — zvukový strop pre `analog/keys`.
3. **B5** (2 dni) — až po B3b/B4, nie blokujúce.

---

## 7. Verifikácia (Definition of Done)

- [ ] `npm run typecheck` 0
- [ ] `npm run test` 96/1012 zelených (vrátane `plock-length-export.test.ts` rozšíreného o `kick/snare`)
- [ ] `npm run test:browser` offline render pin `live==offline` pre nový hlas
- [ ] 5 presetov na nový nástroj, manuálny jam 10 min bez crash/panic

---

## Changelog

- 2026-09-03 — Vytvorený dokument. B1 Keys (FM 4-op) + B2 Pluck (KS) + B3 HH synth (hat/clap/perc/cowbell) hotové, overené `typecheck` + `vitest 1012`. Naplánované B3b/B4/B5.
