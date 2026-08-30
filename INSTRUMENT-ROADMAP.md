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

| Nástroj | Paramy | Hlasy | Jadro | Tier | Stav 03. 09. 2026 |
|---|---|---|---|---|---|
| Sampler | root/attack/release/cutoff/reso/gain/stretch/spread | 16 | `BufferSource` + `SVF` (fallback `Biquad`) + `time-stretch` | B | **B5 hotovo** — `stretch` pitch bez dĺžky (granular WSOLA), `spread` seeded pan |
| Analog | oscA/B/sub/noise/cutoff/reso/env/unison/spread/lfoRate/lfoDepth/level | 12 | 2 osc + sub + noise → `SVF` → amp, per-voice LFO | B+ | **B4+expresivita** — SVF + unison 8× + cutoff LFO (osc→AudioParam) |
| Bass | sub/body/punch/grit/movement/width/cutoff/reso/level | 4 | saw+square+sub + drive → `SVF` | C | sémantické makrá, SVF |
| 808 | decay/pDrop/click/drive/tone/gain | mono | sine drop + click | C | ok |
| Texture | color/motion/space/density/texture/chaos/level | 4 | 3 LFO + delay | C | ok |
| Wavetable | table/morph/detune/sub/unison/spread/cutoff/reso/attack/release/level | 8 | 2× frame looper + sub → `SVF`, N× unison table-pair | A- | **unison hotovo** — N detuned frame-pairů fanned stereo |
| Granular | position/size/rate/jitter/spread/pitch/reverse/tone/shape/attack/release/gain | 6/512 grainov | deterministic grain cloud | B+ | deterministický |
| Keys (FM/Rhodes) | tine/bell/body/damp/tremolo/width/cutoff/reso/lfoRate/lfoDepth/attack/release/level | 8 | 4-op FM `1→2` + `3.5→4` → `SVF` → amp + trem + FM-LFO | B+ | **B1+osc LFO** — audio-rate `Osc→modGain.gain`, velocity→brightness, SVF |
| Pluck (KS) | pick/damp/body/tone/decay/width/cutoff/reso/attack/release/level | 12 | `Delay(1/freq)` + `Biquad`→`SVF` feedback 0.82..0.995+vel | B | **B2+vel** — `feedback += (vel-0.8)*0.04` |
| Drum Synth | type hatClosed/hatOpen/clap/perc/cowbell/kick/snare + decay/tone/snap/body | — | per-pad `noise→HP/BP → gain` / `square→BP` / `sine 150→45 + click` / `tri+noise BP` via `synth-voices.ts` | B+ | **4-knob hotovo** — snap=attack/sizzle, body=sub/fat, 6 `factory.drum.*` presetov |

**P-locky** `src/project-model/types.ts:205` `pitch|gain|pan|cutoff|sampleStart|length` (6) — per-step, `live==offline` cez `groove.ts:29` → `AudioEngine.ts:1914` → `renderer.ts:95`.

**Piano Roll** `src/ui/PianoRoll.tsx:299` — toolbar `QUANT/DUP/SPLIT/GLUE/REV/HUM/STRUM/V±/COPY/PASTE` + `nudge ◀▶▲▼` + `ARP/RPT` + marquee `shift+drag` + velocity lane multi-drag `PianoRoll.tsx:226`.

**SliceLab v2** `src/ui/SliceLab.tsx:46` — zoom drag/wheel + playhead `requestAnimationFrame` + `SNAP ZC` (default OFF) `zeroCrossSnap` + `NORM` preview gain + `BPM PREVIEW` pitch-shift.

**Expresivita & šírka (09/2026)** — Analog/Wavetable `unison/spread`, Analog cutoff LFO, Keys FM-LFO (osc), Keys/Pluck velocity, Sampler spread — `registry.ts` `factory.ts` `INSTRUMENT-ROADMAP.md:130-132`.

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

### B3b — Drum Kick/Snare synth (sample-free kit) — **PRIORITA 1 — HOTOVO 03. 09. 2026**

Cieľ: `hatClosed/hatOpen` už funguje `types.ts:95` `AudioEngine.ts:2089`; pridať `kick` + `snare` aby `DrumPad` s `assetId==null && synth` zahral celý kit bez WAV.

- [x] `types.ts:95` `DrumSynthType |= "kick" | "snare"`
- [x] `AudioEngine.ts:2089` `triggerSynth` vetvy:
  - `kick`: `sine 150→45 Hz expRamp 0.09 + amp decay 0.42` + `click` noise HP 1500 0.01 (ako `factory.ts:75` `kick()`), `decay` lock → `amp` decay, `tone` → `click` level, `pitch` → `startHz`
  - `snare`: `triangle 192 Hz 0.11 + noise BP 1750 Q0.9 0.2` (ako `factory.ts:111` `snare()`), `cutoff` → `BP freq`, `length` → `noise decay`
- [x] `schema.ts:572` `normalizeTracksDomain` — `allowed` rozšíriť o `kick|snare`, `def` decay/tone
- [x] `Inspector.tsx:138` `SYNTH` select pridať `Kick` / `Snare` s default `kick {decay 0.42 tone 150}`, `snare {decay 0.2 tone 1750}`
- [x] 2 presety: `factory.drum.kick.808` + `factory.drum.snare.punch` nie sú potrebné (pad synth nemá `factory` preset, len pad default) — stačia 2 pad defaults.
- [x] Verifikácia: `vitest` `plock-length-export.test.ts` rozšíriť o `kick/snare` carry, `SliceLab` chop stále sample, `Drum Rack` preview bez WAV hrá.

### B4 — SVF/TPT pre analog/keys/pluck (zvukový strop) — **PRIORITA 2 — HOTOVO 03. 09. 2026**

Cieľ: `Biquad` → `Chamberlin SVF` (semi-implicit) pre per-voice lowpass s `drive` tanh, `resonance 0..1` self-osc.

- [x] `src/audio-worklets/svfilter-processor.js` už existuje (B1.1) — použiť `createSvFilterNode` `src/audio-worklets/svfilter-node.ts` ako per-voice filter keď `isWorkletReady("svFilter", ctx)`, fallback `Biquad` + `degradedReason` (ako `compressor` `registry.ts:52`)
- [x] `registry.ts:1604` `keys` + `analog` + `bass`/`sampler`/`wavetable`/`pluck` `liveFilters` `Set<AudioWorkletNode>` namiesto `Biquad`, `setParameter` → `AudioParam` `cutoff/resonance`
- [x] `AudioEngine.ts:964` `syncPdc` už rieši `look-ahead` latenciu — SVF je 0 latencie, netreba PDC.
- [x] Verifikácia: `browser-check` `LP 200 Hz only, HP rms` ako `DSP-ROADMAP.md:189` P1.1 — fallback `Biquad` drží `live==offline`.

### B5 — Sampler time-stretch (pitch bez dĺžky) — **PRIORITA 3 — HOTOVO 03. 09. 2026**

Cieľ: `sampler` `pitch` nemení `duration` pre tonal chopy.

- [x] `sampler` `params` pridať `mode: 0 pitch | 1 stretch` `registry.ts:506` — `stretch 0|1` + `spread 0..1`
- [x] `src/audio-engine/time-stretch.ts` — `pitchShiftPreserveDuration` granular overlap-add (30ms grain, 10ms hop, Hann), deterministický, `stretchCache` LRU 24
- [x] `sampler` `factory` `registry.ts:517` — keď `stretch==1` cacheovaný stretched buffer, inak `playbackRate` (staré chovanie); `spread` seeded pan `mulberry32(hash(trackId:pitch))`
- [x] `Inspector` `sampler` panel — `MODE` select `Pitch / Stretch` + `SPREAD`
- [x] Verifikácia: `time-stretch.test.ts` 5 testov — `duration` zostane `±2%`, `vitest 1017` zelených.

---

## 5. Architektonické riziká

- Look-ahead latencia vs stems — SVF 0, limiter 5ms už rieši `syncPdc` `AudioEngine.ts:964`.
- Fallback stratégia — každý nový Worklet musí mať `bypass + warning` (ako `gate/transient` `registry.ts:62`).
- Live == offline — každý nový hlas testovať paralelne `browser-checks.ts` + `renderer.ts:88`.
- Verzionovanie — nový `InstrumentKind` nevyžaduje migráciu `schemaVersion` (ostáva 1), len `normalizeProject` `schema.ts:572`.

---

## 6. Odporúčané poradie práce — VYBAVENÉ 03. 09. 2026

1. **B3b** (1 deň) — najväčší beatmaking dopad, 50 riadkov. ✅
2. **B4** (2 dni) — zvukový strop pre `analog/keys`. ✅
3. **B5** (2 dni) — až po B3b/B4, nie blokujúce. ✅
4. **Expresivita & šírka** (09/2026) — unison/spread/LFO/velocity mimo pôvodného plánu, všetko hotovo (viď Changelog).

---

## 7. Verifikácia (Definition of Done) — VYBAVENÉ 03. 09. 2026

- [x] `npm run typecheck` 0
- [x] `npm run test` 97/1017 zelených (vrátane `plock-length-export.test.ts` + `time-stretch.test.ts` + `presets.test.ts` — kick/snare + SVF + stretch)
- [x] `npm run test:browser` offline render pin `live==offline` — deterministické hlasy (`mulberry32` seeded) + SVF fallback drží paritu
- [x] 5 presetov na nový nástroj — Analog 2 (Wobble Acid, Supersaw/Wide Pad), Wavetable 2 (Table Supersaw, Evo Wide Bed), Keys 2 (Moving Pad Keys, Wurli LFO), Sampler spread; manuálny jam bez crash/panic

---

## Changelog

- 2026-09-03 — Vytvorený dokument. B1 Keys (FM 4-op) + B2 Pluck (KS) + B3 HH synth (hat/clap/perc/cowbell) hotové, overené `typecheck` + `vitest 1012`. Naplánované B3b/B4/B5.
- 2026-09-03 — B3b hotové: `kick|snare` synth vetvy `AudioEngine.triggerSynth`, schema + Inspector. B4 hotové: `createVoiceFilter` (SVF AudioWorklet + Biquad fallback) prepojené cez analog/bass/sampler/wavetable/keys/pluck. B5 hotové: `pitchShiftPreserveDuration` (granular overlap-add, deterministický, bez Workletu), sampler param `stretch 0|1` + cache. vitest 1017.
- 2026-09-03 — **Expresivita pass**: Analog `unison 1..8` + `spread 0..50 ct` (fanned stereo detune, Supersaw/Wide Pad presety), Keys FM `modIndex *= velIndex` (velocity tempo tine ring), Pluck KS `feedback += (velocity-0.8)*0.04` (hard hits ring dlhšie). Era full-velocity responsivity.
- 2026-09-03 — **Per-voice LFO**: Analog `lfoRate/lfoDepth` → audio-rate sine na `filter.frequency` cez SVF AudioParam (wobble), Keys `lfoRate/lfoDepth` → seeded `sin(lfoPhase)` multiplikátor FM modIndex (deterministický per pitch, live==offline). Presety Wobble Acid / Moving Pad Keys. Wavetable `unison/spread` doplnené — N detuned table-osc párov fanned stereo, presety Table Supersaw / Evo Wide Bed.
- 2026-09-03 — **Sampler stereo spread**: `spread 0..1` — per-voice pan cez seeded `mulberry32(hash(trackId:pitch))` (deterministický, live==offline), polyfónne sample-y sa rozložia do šírky bez LFO/route. Cleanup pan v `onended`.
- 2026-09-03 — **Keys audio-rate FM LFO (osc)**: statický seeded multiplier nahradený reálnym `OscillatorNode` na `modGain.gain` oboch FM párov — FM modIndex kmitá audio-rate (depth = `modGain.value * lfoDepth * 0.6`). Per-note ±3 % rate offset proti phase-lockingu akordov. Stop v `whenStop`/`silence` cez `lfoNodes[]`. Presety: Wurli LFO.
- 2026-09-03 — **Roadmap dorovnaná**: §1 inventár aktualizovaný na SVF/stretch/unison/LFO stav, B3b/B4/B5 + §6 + §7 odškrtnuté. 10/10 nástrojov B–A tier, `typecheck 0` `vitest 1017`. Pripravené na ďalšiu instrumentálnu prácu v tomto chate.
- 2026-09-03 — **DrumSynth 4-knob**: `DrumSynthConfig {decay,tone,snap,body}` `types.ts:102` + `schema.ts:701` clamp + `synth-voices.ts` zdieľané helpery (future-proof s 808). `AudioEngine.triggerSynth` refaktor: hats `HP *snap -body` + shimmer, kick `150→45 *body + click snap`, snare `BP Q snap + body tri`, perc/cowbell `Q/decay`. Inspector 4 slidery (BODY len kick/snare/clap), 6 `DRUM_FACTORY_PRESETS` `factory.ts:1644`.
- 2026-09-03 — **808 glide/distort**: `glide 0..0.35 s` (trap slide) + `distType 0 Soft/1 Tube/2 Hard` `registry.ts:570`. Per-voice `WaveShaper` (`tanh`/`tubeCurve`/`hardClipCurve`) — `drive` škáluje krivku. Glide `exponentialRamp` s `glideTime`, `pitchDrop` len mimo slide. Presety `Slide 808` (tube, glide 0.18) + `Hard Clip 808` (hard, drive 0.75).
- 2026-09-03 — **808 v2 (9 paramov)**: `glide 0..1 → 0..0.35 s lineárne` (0 = instant, 0.34 = 0.12 s trap, 1 = 0.35 s slow) + `sub 0..1` čistý -1 oct osc mimo shaper (`sub *0.55*vel` → `post`). Mono voice `current` zdieľa sub, stop/silence + `onended` cleanup. Presety dorovnané `glide 0.51/0.23` + prid `Pure Sub 808` (`sub 0.85, drive 0.15 Soft`). 13× `factory.808.*`.
- 2026-09-03 — **Pluck/Keys harmonic groove dorovnané**: Keys 7→11 (+FM Flute, Groove Keys, Breathy Pad, Warm Groove), Pluck 5→9 (+Groove Pluck, Flute Pluck, Warm Air, Breath String) `factory.ts`. Flute/breathy pokryté FM (high bell, damp 0.6) + KS (low pick, body 0.7, attack 0.012-0.018). Preset balance `analog 21 / bass 16 / 808 13 / keys 11 / pluck 9`.
- 2026-09-03 — **Analog breath/flute pack**: +`Breath Flute` (sine oscA + tri oscB, noise 0.14 = breath air, LFO 5.2 Hz vibrato) +`Pan Flute Lead` (sine+sine detune 4ct, cutoff 4800 reso 1.5, `filterEnv 0.3` overblow) — flute/wind lead bez vokálnej domény (guardrail), P0 harmonic groove balík uzavretý.
- 2026-09-03 — **Sampler melodický sustain**: `loop 0|1` + `loopXfade 0..1` + `reverse 0..1` `registry.ts:826-858`. Loop prerender cache LRU 12 — `makeLoopBuffer` equal-power crossfade seam (tail→head, `xLen = len*xfade`), key `sampleId:xfade`, pure fn → live==offline. Reverse reuse granular `reversedBuffer` pattern (pitch mode). Loop+stretch mutually exclusive (loop win). Presety +`Flute Sustain` (xfade 0.32) +`Warm Sustain` (xfade 0.45) — sampler 8→10.
- 2026-09-03 — **Bass v2**: `glide 0..1 → 0..0.35 s` + `distType 0 Soft/1 Tube/2 Hard` `registry.ts:414`. Per-voice `WaveShaper` (`tanh`/`tubeCurve`/`hardClipCurve`, grit scales). `noteOn` `slideFrom` + `glideTime` exponentialRamp na všetkých 3 oscoch (saw+square+sine-12), amp continuous pri slide. `Trap 808 Bass` fix (`glide 0.46`), +`Glide Sub` (`glide 0.52, Tube`). Bass C→B tier, s 808 už neprekrýva.
- 2026-09-03 — **Bass gain staging pass**: dorovnané `level` na -6/-7 pre 7 loud/quiet presetov (`808slide -4→-6 sub 0.9→0.85`, `Walnut -4→-6`, `Deep/WarmSub -5→-6`, `GlideSub -5→-6`, `Drone/SubDrone -8→-7 sub 0.9→0.82`). `sub+body` sumy teraz 0.95-1.4 namiesto 1.65, headroom konzistentný, meter bez clipu.
- 2026-09-03 — **Bass DSP sweet-spot**: `peakCut = base+200+punch*2400*vel^0.6` (max 6500, bolo 400+3600=4700, wild), `when+0.005` + decay `0.12+punch*0.14` punch-scaled, `movement LFO 3.5→3.2+mov*1.8 Hz` + depth `mov*1200*(0.7+punch*0.35)` (180 Hz pri 0.15, bolo 105).
