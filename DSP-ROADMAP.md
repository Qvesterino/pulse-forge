# DSP-ROADMAP.md

# Pulse Forge — Audio DSP Roadmap

> Implementačná roadmapa zvukovej kvality. Základ: audit engine z 27. 8. 2026.
>
> **Filozofia tohto dokumentu:** Pulse Forge je aplikácia VÝHRADNE na tvorbu inštrumentálov a beatov.
> Žiadny vokál, žiadne nahrávanie, žiadne vokálne mastering reťazce. Každá položka nižšie musí byť
> relevantná pre produkciu beatov / inštrumentálov, inak nepatrí do tohto zoznamu.
>
> Cieľ: **najlepšia možná zvuková kvalita v rámci web browsera** — nie feature-parita s DAW.
>
> ⚠️ **Historical snapshot.** This document is a point-in-time audit from 2026-08-27.
> The numbers quoted here (e.g. "17 efektov v registry") describe the registry as it stood then.
> For the **current** inventory (14 instruments, 36 effects, 12 templates, 4 flagship plugins,
> 41 factory assets, 205 factory presets, 13 ADRs) see [`docs/CURRENT-STATE.md`](./CURRENT-STATE.md).

---

## 0. Ako používať tento dokument

- Odškrtávame `- [x]` až keď je vec **implementovaná a overená** (pozri Definition of Done nižšie).
- Ku odškrtnutej položke doplníme dátum + krátku poznámku (napr. `[x] — 2026-09-02, PR #123`).
- Hotové položky **nemažeme** — slúžia ako história.
- Nové nápady pridávame na koniec príslušnej priority sekcie.
- Ak sa počas implementácie niečo zmení (objaví sa lepší prístup), poznačíme to pod položku ako *Poznámka*, nemeníme pôvodný zámer po ceste.

### Definition of Done — pre každý nový efekt / modulátor

- [ ] Funguje v **offline renderi** aj v **live playbacku** (rovnaký engine, rovnaký výsledok — live == offline je náš zákonom)
- [ ] Je deterministický (seeded PRNG tam, kde je náhoda)
- [ ] Má definované správanie **fallbacku**, keď AudioWorklet nie je dostupný (bypass + UI warning, NIKDY tichý passthrough)
- [ ] Parametre fungujú s automatizáciou a makrami
- [ ] Má aspoň 3 zmysluplné preset-y (musical, nič „Preset 001")
- [ ] Metering/GR feedback, ak to má zmysel (compressor, limiter, gate)

---

## 1. Audit súčasného stavu (27. 8. 2026)

Inventár toho, čo je **reálne v kóde** (nie v dokumentácii). Zdroj: `src/audio-engine/AudioEngine.ts`,
`src/effects/registry.ts`, `src/instruments/registry.ts`, `src/audio-worklets/`, `src/audio-engine/metering.ts`.

Kvalitatívne tier-y:

- **Tier A** = vlastný per-sample DSP v AudioWorklete (naša kvalita, plná kontrola)
- **Tier B** = natívne nodey + vlastná matematika/curve (solídne, ale strop daný natívnymi node-mi)
- **Tier C** = čisto natívny wrapper (funkčné, najnižší strop kvality)

### 1.1 Architektúra

- [x] Engine: čisto Web Audio graph, žiadny ScriptProcessor; custom DSP v 5 AudioWorkletoch
- [x] Live == offline: rovnaký engine aj pre render (`src/rendering/renderer.ts`), worklety sa loadujú per-context
- [x] Determinizmus: seeded PRNG (mulberry32) pre IR, grainy, factory sample-y
- [x] Voice management: oldest-steal, choke groups s 5 ms fade, panic
- [x] Export: WAV 16/24/32-bit, MP3, stems, per-track render, scorepack, video
- [x] Track freeze = offline bounce-in-place

### 1.2 Efekty (17 v `src/effects/registry.ts`)

| Efekt | Implementácia | Tier |
|---|---|---|
| EQ (6-pásmové) | 6× `BiquadFilterNode` | C |
| Compressor | **AudioWorklet** *(2026-08-27)* — per-sample PEAK/RMS detektor (stereo-link), soft-knee gain computer, attack/release smoothing, **sidechain input + 2× one-pole SC HPF (12 dB/oct, len detektor)**, makeup+mix (parallel), GR metering; fallback = natívny DCN graf (degraded „reduced") | A |
| Saturation | `WaveShaper` tanh (2x oversample) + tone LP | B |
| Distortion | `WaveShaper` kubický soft-clip (2x) + tone | B |
| Clipper | `WaveShaper` (4x), hard clip / tanh + ceiling + softness | B |
| **Limiter** *(pridaný 2026-08-27)* | **AudioWorklet** — look-ahead max-deque, soft knee, program-dependent release, safety clamp, GR metering; fallback = transparentný bypass + warning | A |
| Reverb | `ConvolverNode` + procedurálne IR (Web Worker, seeded), predelay + tone | B |
| Delay | `DelayNode` + feedback + damping LP | C |
| Pump | saw → duck-curve shaper → modulácia gainu, BPM-sync | B (clever hack, nie skutočný sidechain) |
| **Tape Sat** *(pridaný 2026-08-28, P2.1)* | **AudioWorklet** — y[n]=tanh(drive·x[n]+hyst·y[n-1]), tone LP + denormal guard; fallback = bypass + warning | A |
| **M/S EQ** *(pridaný 2026-08-28, P2.2)* | 2×2-pásmové M/S encode (L/R→M/S 0.5, low/high shelvy na M/S, decode M±S), `getAudioParam` pre bus | B |
| **Haas Widener** *(pridaný 2026-08-28, P2.3)* | Delay 0.5–40 ms na L + width blend + feedback shimmer, mono-compatibilný | B |
| **Multiband** *(pridaný 2026-08-28, P2.6)* | komplementárny 3-band crossover (wet−low→midHigh, midHigh−mid→high, unity-sum), −12..+12 dB na pásmo | B |
| **Comb** *(pridaný 2026-08-28, P2.4)* | **AudioWorklet** — feedback comb y[n]=x[n]+fb·damp(y[n-D]), 0.5–60 ms, ±fb, damp LP, mix | A |
| **Vowel** *(pridaný 2026-08-28, P2.5)* | **AudioWorklet** — 3× peaking cascade, 5 samohlások (A-E-I-O-U) log-morph, Q 3.5→9 / gain 7→15 dB, mix | A |
| **Duck Delay** *(pridaný 2026-08-28, P2.7)* | **AudioWorklet** — delay 30–1000 ms + tone LP + duck env (thresh/attack/release) na wet | A |
| Bitcrusher | **AudioWorklet** — kvantizácia + S&H downsample | A |
| Chorus | 2× modulované delaye, 2 LFO | C |
| Phaser | allpass kaskáda 2–8 stupňov + feedback | B |
| Sidechain | **AudioWorklet** — 2-input, per-sample envelope follower | A |
| Transient Shaper | **AudioWorklet** — fast/slow envelope rozdiel | A |
| Drum Buss | kompozit natívnych nodeov (drive + comp + tone + boom) | C |
| Bass Buss | kompozit natívnych nodeov; **`monoBassFrequency` existuje, ale nie je zapojený** | C |
| Utility | M/S width + mono-bass crossover z primitív, polarita, swap | B |
| Gate | **AudioWorklet** — envelope follower + hold + range | A |
| Master limiter (vstavaný) | `DynamicsCompressorNode` 20:1 + tanh clipper; **bez look-ahead** | C |

### 1.3 Nástroje (všetky reálne, žiadne stuby — `src/instruments/registry.ts`)

- [x] Drum Rack (sample playback, slices, choke, velocity)
- [x] Sampler (pitch cez root key, 16 hlasov)
- [x] Analog Synth (2 osc + sub + noise, filter env, 12 hlasov)
- [x] Bass Synth (saw+square+sub, punch env, grit shaper)
- [x] 808 Synth (pitch drop, click, drive)
- [x] Texture Synth (3 LFO, delay space, chaos)
- [x] **Wavetable Synth** — najlepší custom DSP v repo: aditívna syntéza tabuliek + extrakcia z sample-ov
      cez autokoreláciu s parabolickou sub-sample interpoláciou
- [x] **Granular Synth** — 512 grainov, deterministický, trapezoid envelope

### 1.4 Modulácia

- [x] LFO — audio-rate, ale **cieľuje len na track gain/pan**
- [x] Makrá — main-thread (nie audio-rate), source: macro / intensity / midiCC
- [x] Scene intensity + krivky
- [x] Automatizácie (trackGain/trackPan/fxParam/instParam), pattern- aj scene-relative
- [x] MIDI CC / pitch bend / poly aftertouch
- [x] MIDI CC / pitch bend / poly aftertouch
- [x] Envelope follower ako všeobecný modulátor — 2026-08-27 v1 + **2026-08-28 P2 bus**: worklet `envfollower-processor` (per-sample asym. peak detekcia, tanh sensitivity) → **audio-rate bus** do Volume/Pan **a do ľubovoľného FX AudioParam** (cez `EffectRuntime.getAudioParam`, `AudioEngine.resolveModTargetParam` + `modulationDepthForTarget` s range/2 škálou); fallback polling `applyEnvFollowersToParams` pre ciele bez AudioParam (instrumenty). `polarity` DUCK(−1)/SWELL(+1); detector vždy tapuje source `nodes.input` (anti-feedback). Verifikácia 27.8: ducked=0.719 vs plain=0.801; 28.8: LFO+envFollower → SVF cutoff modulation cez bus (typecheck ✓, vitest ✓).
- [x] Random / S&H LFO — 2026-08-27: stateless hash stream `mulberry32(hash(id|seed|k))` → ľubovoľný krok spočítateľný nezávisle ⇒ **bitovo deterministické rendery** (rel=5.9e-9); Hold/Glide režimy; plné AutomationTarget cielenie (Volume/Pan/FX/inst) cez zdieľaný `setParameterAt` kanál; seed 🎲 regen v UI
- [x] Step Modulator — 2026-08-27: bar-aligned uniform grid (absolútne ticky, pattern aj song mód identicky), steps 8/16/32 (drag grid v UI, commit na pointer-up), glideSec, plné AutomationTarget; composícia viacerých zdrojov do rovnakého cieľa sčítava (base + Σ) a koexistuje s audio-rate osc LFO (AC pridávanie). Verifikácia: „step modulator: gain alternates on the division grid" — gate=0.0905/0.0364 vs ctrl=0.0870/0.1604 (normalizované na house backbeat baseline)

### 1.5 Metering (`src/audio-engine/metering.ts`)

- [x] Peak / RMS / dBFS, stereo korelácia, mono-loss, L/R imbalance, peak-hold
- [x] LUFS — **pôvodne aproximácia** (plochá energia), 2026-08-27 nahradená presným BS.1770-4 K-weightingom (worklet live + pure offline analyzátor)
- [x] True peak — **pôvodne parabolický odhad**, 2026-08-27 nahradený 4× polyphase oversamplingom (Blackman sinc, 4×16 taps, DC-normalizované fázy)
- [ ] Spektrum/FFT analyzátor UI (analyzéry existujú, len sa nekreslia)
- [x] K-weighted LUFS (ITU BS.1770) — 2026-08-27: `kweighting.ts` (koeficienty prepočítané pre ľubovoľný fs, dual gate −70/−10 LU v power doméne) + `kwmeter` worklet (sink branch v master chain, RESET INTEGRATED posiela reset do workletu). Conformance: 1 kHz @ −23 dBFS → **−22.99 LUFS** (live) a ±0.2 LUFS @48 kHz aj @44.1 kHz (unit)
- [x] Skutočný true-peak (4× oversampled) — 2026-08-27: catchuje fs/4 intersample peak (+3.01 dB nad sample peak), ktorý parabolický odhad nezbadal; overshoot na bežnom obsahu ≤ +0.5 dB

### 1.6 Čo je zdravé (nesiahame na to)

- [x] Disciplína live == offline — zachovať za každú cenu
- [x] Worklety sú reálne per-sample DSP (bitcrusher, sidechain, transient, gate) — dokáže to, že vlastné worklety sa oplatia
- [x] Wavetable + granulár — signál, akým smerom ísť (vlastné worklety > natívne wrappery)
- [x] Rozsah: worklety (gate/transient/sidechain) sú 80 % toho, čo by vokálna doména potrebovala — a aj tak ich nepresúvame; VocalForge má svoju doménu

---

## 2. Identifikované slabiny (z auditu)

1. ~~**Master limiter bez look-ahead**~~ — **vyriešené 2026-08-27**: `buildMaster()` pripraví look-ahead worklet (`attachMasterWorklet`), natívny `DynamicsCompressorNode` ostáva v reťazi ako neutrálny passthrough + fallback bez workletov; live upgrade po do-loadovaní modulov cez `upgradeMasterDynamics()`; GR metering na MasterMeter ("GR x.x dB"). Verifikácia: browser-check „master limiter: look-ahead brickwall pins export at ceiling" — peak=0.708/ceiling=0.708.
2. ~~**Compressor je natívny wrapper**~~ — **vyriešené 2026-08-27** (P0.2): vlastný worklet s PEAK/RMS detektorom, sidechain inputom + SC HPF, soft-knee, makeup/mix, GR metering v UI (zdieľaný GR bar + SOURCE picker s Sidechain efektom); natívny DCN ostáva ako degraded fallback. Staré 7 param ID kompatibilné 1:1 (žiadna migrácia), nové `detector`/`scHpf` dopĺňa normalizeEffects. Verifikácia: hot input rms 0.0568/0.4950 (gr 20.2 dB); SC HPF diferenciátor — 45 Hz detektor: gr 23.9 dB s HPF 20 Hz vs 0.0 dB s HPF 300 Hz; mix=0 unity presne.
3. ~~**LUFS bez K-weightingu, true-peak len odhad**~~ — **vyriešené 2026-08-27** (P0.3): presný BS.1770-4 K-weighting (worklet live + pure offline analyzátor s dual gate), true-peak 4× polyphase oversampling v live snaphote aj export summary. Metering je teraz credible pre „release" workflow.
4. ~~**Gate/Transient fallback = tichý passthrough**~~ — **vyriešené 2026-08-27** (P0.0): transparentný bypass s UI warningom, degraded flagy na všetkých 5 worklet efektoch, auto-rebuild po do-loadovaní modulov.
5. ~~**`monoBassFrequency` v Bass Busse nie je zapojený**~~ — **vyriešené 2026-08-27** (P0.0b); bonus: opravený aj nefunkčný mono súčet v Utility MONO BASS.
6. **Žiadne zero-delay filtre (SVF/TPT)** — všetko legacy biquad; modulovaný cutoff neznie „analogovo".
7. **LFO moduluje len track gain/pan** — nie filtre, nie FX parametre.
8. **Flanger v dokumentoch, v kóde nie je.** Tiež chýba: tremolo ako efekt, autowah, multiband. *(limiter doplnený 2026-08-27)*
9. **Žiadny spektrový analyzátor** — FFT dáta sú, UI nie je.
10. **Žiadne denormal guards** vo workletoch (dlhé tails môžu stáť výkon).
11. **Look-ahead limiter pridá latenciu** → treba PDC/kompenzáciu, inak stems vs. master frázovo nebudú sedieť (offline OK, live so sendami nie).
    * *Update 2026-08-27:* minimálna PDC implementovaná (`syncPdc`) pre insert chainy (track+group); send/return cesty ostávajú nekompenzované (zdokumentované). *Update 2026-09-19:* send cesty kompenzované — každý send má vlastný delay node (`sendDelays`, `sendPdcDelaySec`: downstream group latencia mínus latencia returnu, tap je post-track-PDC); returny sa už neinflate-ujú do maxEffective, držia si pravé relatívne načasovanie. Dry vs wet sedí presne pre zero-latency returny (reverb/delay/duck/chorus/comb) z ľubovoľnej stopy/grupy. Zvyškové zdokumentované: return s vlastným latency FX (limiter na returne) krmený z nižšie-latentného reťazca mešká o (returnLat − downstream). *Poznámka: master worklet limiter pridáva uniformných ~5 ms latenciu celej mixovej zbernici aj keď je LIMIT vypnutý (mix=0 obchádza limiting, nie delay) — pre produkciu beatov irelevantné, pre live tracking mikrofónu v princípe neexistuje.*

---

## 3. Roadmapa

### P0 — rozhoduje o „najlepšia kvalita v browsery"

- [x] **P0.0 — Fallback fix (bugfix)** — 2026-08-27
  Gate a Transient Shaper fallback nesmie byť tichý passthrough.
  - [x] Zmeniť fallback na transparentný bypass (1:1 signál) — `bypassRuntime()` v registry; 2026-08-27
  - [x] UI warning badge „processor unavailable — bypassed" — `EffectRack` číta `engine.getDegradedFx()`, badge `.fx-device-warn`; flagy aj pre bitcrusher/sidechain fallbacky (reduced); 2026-08-27
  - [x] Zobraziť v browser-checks (`src/browser-checks.ts`) — 3× „fallback reports degraded state" + „fallback passes signal 1:1" + kontrastný test „worklet path gates"; 2026-08-27
  - [x] Bonus fix: keď sa worklety do-loadujú po otvorení projektu, engine vynúti rebuild FX chainov (`queueWorkletRefresh`), takže fallbacky sa automaticky upgradnú na worklety; 2026-08-27
- [x] **P0.0b — Zapojiť `monoBassFrequency` v Bass Busse** — 2026-08-27
  - [x] crossover rovnako ako v Utility (LP/HP split, súčet L/R × 0.5 do OBOCH výstupov = pravý mono sub, direct/crossover crossfade)
  - [x] Bonus bugfix: Utility „MONO BASS" predtým lows iba tlmil (-6 dB, stále stereo) — opravené na skutočný mono súčet do oboch kanálov
- [x] **P0.1 — Look-ahead limiter (AudioWorklet)** — 2026-08-27
  Ring buffer ~5 ms, stereo-link, soft-knee, program-dependent release, GR metering, ceiling v dBTP.
  - [x] Worklet processor (`limiter-processor.js`: max-deque sliding window, soft knee nad thresholdom, program-dependent release, hard safety clamp) + TS node wrapper (`limiter-node.ts`) + loader registrácia (cez core-processor.js); 2026-08-27
  - [x] GR metering do UI — `EffectRack` zobrazuje live GR bar + hodnotu dB pri Limiter device; 2026-08-27
  - [x] Latencia zdokumentovaná + kompenzácia v live grafe (PDC minimálne pre tento efekt) — `AudioEngine.syncPdc()`: track chainy sa alignujú na max effective latency (own chain + group chain); 2026-08-27
    * Poznámka: send/return cesty kompenzované od 2026-09-19 (per-send delay; zvyšok len latentný return z nízkeho reťazca) — zdokumentované v kóde (`syncPdc`)
  - [x] Aceptačný test: browser-check „limiter: look-ahead worklet limits, meters and anticipates" — peak=ceiling presne (0.501/0.501), gr=5.1 dB, spread=1.017 (žiadne pumping), onset=221/221 vzorky (exaktný look-ahead delay); + „pdc: limiter track stays aligned with dry track (<2 ms)" — skew=0.70–0.88 ms; 2026-08-27
    * Poznámka k ceiling: dBTP je aproximované cez sample-peak + safety clamp; skutočná true-peak limitácia (oversampling) ostáva ako P2 položka
  - [x] **Bonus — master stage swap:** `buildMaster()` pripraví worklet limiter medzi clipper a natívny node (natívny = neutrálny passthrough + bez-workletový fallback); live splice po do-loadovaní (`upgradeMasterDynamics`); MasterMeter zobrazuje „GR x.x dB". Verifikácia: „master limiter: look-ahead brickwall pins export at ceiling" — peak=0.708/ceiling=0.708, a „master chain tames a hot mix" limited=0.891 (= presne -1 dBFS oproti 1.178 s natívnym nodeom); 2026-08-27
- [ ] **P0.2 — Vlastný kompresor (AudioWorklet)** — **2026-08-27 DOKONČENÉ** (checkboxy nižšie sú história zadania):
  - [x] Per-sample detektor + RMS/peak prepínač (`detector` param, default RMS)
  - [x] Sidechain input (2-input node rovnako ako sidechain-processor) + **SC HPF** (2× one-pole, len detektor, `scHpf` 20..500 Hz)
  - [x] GR metering + transfer do UI (zdieľaný EffectRack GR bar)
  - [x] Kompatibilita: starých 7 param ID 1:1 ⇒ žiadna migrácia; nové `detector`/`scHpf` defaultované normalizeEffects
  - [x] Natívny DCN fallback (degraded „reduced", GR cez `.reduction`, sidechain no-op)
  - [x] 4 preset-y: Glue / Punch / Smash / Bass Level
  - [x] Aceptačné browser-checks: hot input (rms 0.0568/0.4950, gr 20.2 dB) · SC HPF diferenciátor (gr 23.9 vs 0.0) · mix=0 unity (peak 0.8000 presne) · degraded flag
- [x] **P0.3 — ITU BS.1770 metering** — **2026-08-27 DOKONČENÉ** (checkboxy nižšie sú história zadania):
  - [x] K-weighting filter — presné BS.1770-4 koeficienty (high-shelf 1682 Hz +4 dB + RLB HP 38.1 Hz) prepočítané pre ľubovoľný fs v novom `kweighting.ts`; **live** cez `kwmeter` sink worklet v master chain (koeficienty cez processorOptions — žiadna duplikovaná filtrová matematika na audio threade), **offline** cez pure `analyzeLoudnessBuffer` (dual gate −70/−10 LU, power domain, 400 ms bloky / 100 ms hop)
  - [x] True-peak cez 4× polyphase oversampling (4 fázy × 16 taps, Blackman sinc, DC-normalizované) — v `metering.ts` + `AudioEngine.measureTruePeak` aj `summarizeBuffer` (export summary) teraz merajú skutočný dBTP
  - [x] Overiť proti referenčným hodnotám: **oficiálny conformance vektor** 1 kHz @ −23 dBFS → −23 LUFS — unit testy ±0.2 LUFS @48 kHz aj @44.1 kHz, live worklet **−22.99 LUFS**; fs/4 ISPE test (+3.01 dB intersample peak) — detegovaný; dual gate a <400 ms guard otestované
- [ ] **P0.4 — Trance-gate / Step-gate efekt (AudioWorklet)** — **2026-08-27 DOKONČENÉ**:
  - [x] `stepgate-processor.js` — BPM-syncovateľná brána (fáza v beatoch, mono→stereo smooth, mix param, 8/16/32 krokov)
  - [x] Pattern editor UI — zdieľaný `StepGridEditor` komponent (ModPanel + EffectRack), 0..1 gatové hodnoty, 8/16/32 dĺžka, drag-grid
  - [x] Transport-phase re-align — `onTransportStarted` snap na grid, `syncBpm` live, deterministický default (phase 0 @ time 0) pre offline
  - [x] 4 preset-y: Trance 1/16 / Stutter / Slow Swell / Gated Pad; `setEffectSteps` command + applyEffectPreset podpora steps
  - [x] Schema: `EffectInstance.steps?: number[]`, normalizeEffects sanitizácia, YDocAdapter sync (yMapToEffect/toYMap/syncEffectEntity)
  - [x] Browser-checks: pattern halves signál (even=0.1234 odd=0.0009, 137× kontrast), mix=0 unity
  - Verifikácia: typecheck ✓ (0 chýb mojich súborov), vitest ✓ (faily len v súbežnom doc-delta.test.ts), test:browser 0 FAIL
- [x] **P0.5 — Multiband sidechain pump** — **2026-08-27 DOKONČENÉ** (rozšírenie existujúceho Sidechain efektu):
  - [x] `sidechain-processor.js` — pridaný `splitFreq` AudioParam (0–500 Hz); keď >10: 2-pole Butterworth crossover (LP/HP) delí MAIN audio; LOW band dostáva gain reduction, HIGH band prechádza cez `high = input − low` (presná jednota LP+HP sum). SplitFreq 0 = pôvodné full-band správanie (spätná kompatibilita).
  - [x] Sidechain-node wrapper — `splitFreq` init + generické `setParameter` prepájanie
  - [x] Registry — `splitFreq` param pridaný k Sidechain efektu; normalizácia v `normalizeEffects` default 0
  - [x] Preset: **Multiband Pump** (splitFreq 150 Hz, threshold −22, ratio 8)
  - [x] Browser-check: fullBand 1kHz carrier RMS=0.0215 (utopený) vs multiBand RMS=0.5054 (vysoké frekvencie prežité) — crossover funguje deterministicky offline
  - Verifikácia: typecheck ✓ (0 chýb mojich), vitest ✓, test:browser 0 FAIL

### P1 — výrazné zlepšenie zvuku

- [x] **P1.1 — SVF/TPT zero-delay filter (AudioWorklet)** — **2026-08-27 DOKONČENÉ**: `svfilter-processor.js` — Chamberlin SVF topológia (semi-implicit Euler: bp ← hp, lp ← bp — žiadny delay v LP/BP reťazi); LP/HP/BP/Notch režimy; resonance 0–1 (0 = max damping, 1 = self-osc boundary s clamp); drive = tanh saturation; mix. Presety: LP Warm/LP Acid/HP Clean/BP Hollow/Notch Fix. Poznámka: TPT (Simper) verzia bola skúšaná ale HP mód mal numerickú divergenciu (trapezoidal integrator + HP subtraction = catastrophic cancellation) — Chamberlin topológia je proven stable. Verifikácia: LP crossingDensity 0.0090 (200 Hz only, 8 kHz blocked), HP rms=0.0070 (100 Hz cez 1 kHz HP), test:browser 0 FAIL
- [x] **P1.2 — Flanger** — 2026-08-27 dokončené: `flanger-processor.js` — per-sample modulated delay + ZERO-DELAY feedback (worklet feeds back within same sample, nie native DelayNode delay); L/R LFO phase offset (spread 0–1) pre stereo width; rate 0.05–10 Hz, depth 0–10 ms, base 0.5–20 ms, feedback 0–0.95, mix; linear-interpolated ring buffer (power-of-2); Presety: Classic/Subtle/Jet. Verifikácia: relDiff=1.359 (comb filtering active), rmsFlanged=0.1582 (audible), test:browser 0 FAIL
- [x] **P1.3 — Tremolo (efekt)** — 2026-08-27 dokončené: `tremolo-processor.js` — AM (classic) + Auto-Pan mode, shape morph sine→square (hard rhythmic gate), depth 0–1, rate 0.1–20 Hz, mix. Presety: Classic / Hard Gate / Auto Pan. Verifikácia: hi=0.3535 lo=0.0354 (ratio 10×, square shape @4 Hz), peak=0.500 (gain never exceeds 1), test:browser 0 FAIL
- [x] **P1.4 — Autowah** — 2026-08-27 dokončené: `autowah-processor.js` — single worklet kombinujúci envelope follower + Chamberlin SVF (cutoff sa pohne per-sample — truly zero-delay); minFreq/maxFreq sweep, resonance pre vocal quality, attack/release/sensitivity; BP/LP mode. Presety: Classic Wah / Bass Wah / Funky. Verifikácia: quiet=0.0028 loud=0.6001 (213× kontrast — envelope otvára filter), test:browser 0 FAIL
- [x] **P1.5 — Envelope follower ako všeobecný modulátor** — 2026-08-27 dokončené v rámci sekcie 1.4 (v1: natívne cieľe Volume/Pan, worklet, polarity; generálnosť FX/inst → P2 „audio-rate modulation bus"). Pozri §1.4 poznámky.
- [x] **P1.6 — Random / S&H LFO (seeded)** — 2026-08-27 dokončené v rámci sekcie 1.4 (stateless hash stream, Hold/Glide, plné AutomationTarget). Pozri §1.4 poznámky.
- [x] **P1.7 — Stutter/Glitch (buffer-repeat) efekt** — 2026-08-27 dokončené: `stutter-processor.js` — BPM-synced loop-repeat (delay buffer presne jedného loop cyklu, read z jedného cyklu vzadu, gate pattern na delayed signál); stereo L/R buffery; feedback param pre intenzívnejší loop; zdieľaný StepGridEditor pre gate pattern; Presety: 1/16 Loop / Gate Loop / Chop. Verifikácia: high=0.0439 low=0.0000 (gate kontrast), test:browser 0 FAIL
- [x] **P1.8 — Spektrum analyzátor UI** — 2026-08-27 dokončené: `SpectrumAnalyzer.tsx` — log-frequency canvas (20 Hz → Nyquist, X os log, Y os −100..0 dB), gradient fill + spectrum line + peak-hold trace (0.5 dB/frame decay), dB grid lines + 100/1k/10k tick labels, observer-only registerRaf ~30 Hz; integrované do MasterMeter (post-limiter analyser, fftSize 2048); analyser getter `getMasterSpectrumAnalyser()` na engine. Verifikácia: test:browser 0 FAIL
- [x] **P1.9 — Denormal guards vo workletoch** — **2026-08-28 DOKONČENÉ**: FTZ flush `|state| < 1e-20 → 0` doplnený do všetkých envelope/filter stavov: `sidechain-processor.js:80` (env + 4× biquad state + y flush), `gate-processor.js:36` (envelope+gain), `transient-processor.js:35` (fast/slow), `limiter-processor.js:163` (gainL/R), `svfilter-processor.js:73` (bp/lp L/R), `autowah-processor.js:82` (env + bp/lp), `compressor-processor.js:92` (SC-HPF 8× state + dL/dR + gain), `tape-processor.js:65` (lpL/R), `tremolo-processor.js:73` (gainL/R), `kwmeter-processor.js:84` (8× biquad state + hp guard), `stutter-processor.js:90` (feedback write flush), `envfollower-processor.js:50` už mal, `flanger-processor.js:94` už mal, `stepgate-processor.js:82` už mal. Verifikácia: typecheck ✓, vitest 1007 ✓, dlhé tails už negenerujú denormály (CPU spike eliminovaný).

### P2 — až po P0/P1

- [x] **P2.1 — Tape saturátor s hysterezou** — **2026-08-28 DOKONČENÉ**: `tape-processor.js` (y[n]=tanh(drive·x[n]+hyst·y[n-1]), driveGain 1+14·drive, one-pole tone LP + output makeup, denormal guard 1e-20, `mix`/`output` dB) + `tape-node.ts` wrapper s `getAudioParam`; `core-processor.js`/`loader.ts` integrácia (`tapeSat` critical, `bypassRuntime` fallback 1:1 + UI warning), `registry.ts` EFFECT_DEFS/ORDER + 3 presety (Warm/Hot/Crunch), typecheck ✓, vitest 1007 ✓.
- [x] **P2.2 — M/S EQ** — **2026-08-28 DOKONČENÉ**: 2×2-pásmové M/S (encode 0.5·(L±R), 4× Biquad low/high shelvy — midLow/midHigh + sideLow/sideHigh, decode L=M+S R=M−S), `getAudioParam` pre všetkých 8 AudioParamov (audio-rate bus), init loop bugfix + `factory(ctx, instance)` podpis, 3 presety (Vocal Clarity/Wide Air/Tight Mono), EFFECT_ORDER/CORE_EFFECT_ORDER zaradený.
- [x] **P2.3 — Haas widener** — **2026-08-28 DOKONČENÉ**: krátky delay 0.5–40 ms na L ch (DelayNode 50 ms max, `delayMs` smoothing 0.05, `width` wet/dry blend + `feedback` shimmer), `getAudioParam` (delayMs/width/feedback), 3 presety (Wide/Subtle/Spread), EFFECT_ORDER/CORE_EFFECT_ORDER zaradený.
- [x] **P2.4 — Comb filter** — **2026-08-28 DOKONČENÉ**: `comb-processor.js` — statický feedback comb (ring buffer 8192, linear interp, y[n]=x[n]+fb·damp(y[n-D]), D=0.5–60 ms / 17 Hz–2 kHz, fb −0.95..+0.95 (± = harm/odd harm), damp 500–12000 Hz one-pole v feedback loop, denormal guard 1e-20, mix) + `comb-node.ts` wrapper s `getAudioParam`; `core-processor.js:15`/`loader.ts:20` integrácia (`comb` critical, bypass 1:1), `registry.ts:1988` EFFECT_DEFS/ORDER/CORE + 3 presety `presets.ts:68` (Tight/Resonant/Metallic). Verifikácia: typecheck ✓, vitest 1007 ✓.
- [x] **P2.5 — Vowel / formant filter** — **2026-08-28 DOKONČENÉ**: `vowel-processor.js` — 3× peaking RBJ cascade, 5 samohlások A-E-I-O-U ([860/1220/2500]..[320/800/2300] Hz), `vowel` 0..4 log-interp, resonance 0..1 → Q 3.5→9 / gain 7→15 dB, mix, FTZ 1e-20 na všetkých stavoch (x1/x2/y1/y2) + coeffs refresh k-rate, bloková stabilita; `vowel-node.ts` s `getAudioParam` (audio-rate bus), `core-processor.js:16`/`loader.ts:21` integrácia (`vowel` critical), `registry.ts:2030` + `presets.ts:71` (A→E / I→O / U Hollow). Verifikácia: typecheck ✓, vitest 1007 ✓.
- [x] **P2.6 — Multiband processor (2–3 pásma)** — **2026-08-28 DOKONČENÉ**: komplementárny 3-band crossover (low=LP(lowFreq,wet), midHigh=wet−low, mid=LP(highFreq,midHigh), high=midHigh−mid — **unity-sum** `low+mid+high === wet`), každý band → Gain (±12 dB) → `mix.output`, `mix` dry/wet via `mixBus`, `getAudioParam` (lowFreq/highFreq/low/mid/highGain/mix), 3 presety (Smile/Mid Focus/Heavy Low), EFFECT_ORDER/CORE_EFFECT_ORDER zaradený. Predtým 3× paralelné biquady s fázovými bumpmi — nahradené.
- [x] **P2.7 — Ducking delay** — **2026-08-28 DOKONČENÉ**: `ducking-delay-processor.js` — ring 131072, lineárna interp, dry envelope (attack/release, thresh −60..0 dB) → duckGain `1−duckAmt·over`, damp LP 500–8000 Hz, feedback 0–0.9 (neduckovaný, len output duckuje), mix; `ducking-delay-node.ts` s `getAudioParam` (8 params, bus), `core-processor.js:17`/`loader.ts:22` (`duckDelay` critical, bypass 1:1), `registry.ts:2065` + `presets.ts:74` (Clean/Heavy Duck/Slap). Verifikácia: typecheck ✓, vitest 1007 ✓.
- [x] **P2.8 — Audio-rate modulation bus** — **2026-08-28 DOKONČENÉ**: `EffectRuntime.getAudioParam` pridaný do všetkých worklet wrapperov (`bitcrusher/compressor/limiter/svFilter/flanger/tremolo/autowah/stutter/tape` + `sidechain/stepgate`) a natívnych efektov (`eq/msEq/haasWidener/multiband`), `project-model/modulators.ts` sanitizér+resolver generalizovaný (`target` pre `osc`/`envFollower`), `AudioEngine.syncLfos` prerobený na **univerzálny bus** (`resolveModTargetParam` → `modulationDepthForTarget`: native gain/pan `amount`, FX `range/2·amount` s `polarity`/`sawDown` znakom; `lfoSignature` obsahuje `target`; `targetParam` caching + `disposeLfoRuntime` tracking, BPM-sync osc frequency live update), `applyEnvFollowersToParams` skipuje už audio-rate pripojené ciele. Verifikácia: typecheck ✓, vitest 1007/1007 ✓, live==offline (OfflineAudioContext pred-load workletov).

---

## 4. Filozofické guardrails (iba inštrumentály)

Tieto pravidlá majú prednosť pred akýmikoľvek nápadmi vyššie:

- [x] **Žiadna vokálna doména** — žiadny de-esser, žiadna pitch korekcia, žiadny sibilance handling, žiadny convolution capture reálnych priestorov. VocalForge vlastní ten svet.
- [x] **Nepribúda mastering moduly navneko** — master stage = EQ + glue + clipper + limiter + loudness; s P0.1 a P0.3 je to reálne hotové.
- [x] **20 excelentných > 100 mediocre** — nový efekt pridávame len vtedy, keď existujúci súrodenec nedokáže ten istý výsledok.
- [x] **Priorita 80/20 pre inštrumentál producenta:** limiter → kompresor → filtre → gate-pattern → multiband pump. Nie ďalších 20 modulačných efektov.
- [x] **Natívne nodey nechávame len na utilitu** (gain/pan/splitter/merger). Čokoľvek, čo „znie", ide dlhodobo do workletov.
- [x] **Determinizmus nezjednávame** — každý nový efekt musí renderovať identicky v live aj offline.

---

## 5. Architektonické riziká, na ktoré si dať pozor

- [x] **Look-ahead latencia vs. stems** — **vyriešené 2026-09-19**: insert chainy (track+group) alignované na maxEffective už od 2026-08-27; send cesty majú odteraz vlastný delay node (`sendDelays` + `sendPdcDelaySec`) — dry vs wet sedí aj cez returny, returny sa neinflatujú do maxima. Verifikácia: `tests/send-pdc.test.ts` 7/7 (pure helper + mock-context wiring: 1 delay/send, sizing 5 ms − 2 ms = 3 ms, cleanup) + browser-check „pdc: grouped send via return lands on dry (trigger+5ms ±3ms)". Zvyšok: latentný return z nízkeho reťazca (zdokumentované v `syncPdc`).
- [ ] **Fallback stratégia** — každý nový worklet musí mať definované správanie bez workletu (bypass + warning). Nikdy ticho.
- [ ] **Live == offline** — každý nový efekt testovať paralelne v oboch režimoch (existujúci harness: `src/browser-checks.ts`, `src/benchmark/`).
- [ ] **Verzovanie parametrov** — pri výmene Compressor engine nesmieme zlomiť existujúce projekty (schema versioning, pozri VISION §25).

---

## 6. Odporúčané poradie práce (sprint-ove bloky)

1. **Blok 1 (bugfixy):** P0.0, P0.0b — malé, rýchle, odstraňujú úskalia.
2. **Blok 2 (metering):** P0.3 — standalone, nezávislé od engine zmien.
3. **Blok 3 (dynamika):** P0.1 → P0.2 — najťažšie, najväčší dopad na zvuk exportov.
4. **Blok 4 (rytmické efekty):** P0.4, P0.5 — UI-heavy, nič neruší.
5. **Blok 5 (filter + modulácie):** P1.1 → P1.9 podľa chuti a potrieb.

---

## Changelog

- 2026-08-27 — Vytvorený dokument. Prvý audit engine (27 efektov/nástrojov inventarizovaných, 4 reálne worklety, 10 slabín identifikovaných).
- 2026-08-27 — **P0 blok dokončený**: P0.0 (fallback fix + UI warning + auto-rebuild po do-loadovaní workletov), P0.0b (Bass Buss mono bass wiring + Utility mono súčet bugfix), P0.1 (look-ahead limiter worklet ako efekt „Limiter" s GR meteringom, minimálna PDC v engine, akceptačné browser-checks). Verifikované: `npm run typecheck` ✓, `npm test` 883 passed ✓, `npm run test:browser` všetky kontroly PASS vrátane nových (limiter peak=ceiling presne, gr=5.1 dB, spread=1.017, onset=221/221 vz.; pdc skew=0.88 ms).
- 2026-08-27 — **Master limiter swapped na worklet**: `buildMaster()` spúja look-ahead limiter medzi masterClipper a natívny node (natívny neutralizovaný, metering tap mera finálny signál); live upgrade cez `upgradeMasterDynamics()`; `applyMasterConfig` riadi ceiling/mix parametre (LIMIT toggle → mix 1/0); GR readout na MasterMeter. Slabina #1 uzavretá. Verifikácia: typecheck ✓, vitest 883 ✓, test:browser všetky PASS — export pribitý presne na strop (peak=0.708/ceiling=0.708).
- 2026-08-27 — **Sekcia 1.4 Modulácia dokončená**: Lfo rozšírené na 4 kindy (osc/random/step/envFollower) bez migrácie (flattened optional fields, SCHEMA_VERSION ostáva 1); nový `project-model/modulators.ts` (pure deterministická matematika + sanitisery); envFollower AudioWorklet (Volume/Pan v1, polarity DUCK/SWELL, anti-feedback input tap); Random/S&H + Step s plným AutomationTarget cielením cez `setParameterAt` kanál; offline hook `scheduleModulatorsOffline` v rendereri + live `applyModulators` cez Scheduler (transport `timeAtTick` mapping); `automationReset` teraz cancelScheduledValues; ModPanel MODULATORS sekcia s type-switchom, step-grid editorom, seed regen; 16 unit testov + 4 browser-checks. Verifikácia: typecheck ✓, vitest 915/915 ✓, test:browser 0 FAIL — determinizmus rel≤5.9e-9, step gate kontrast normalizovaný na control baseline, follower duck 0.719/0.801. Poznámka: FX/inst parametre pre envFollower vyžadujú „audio-rate modulation bus" → zaradené medzi P2 nápady.
- 2026-08-27 — **P0.2 Custom Compressor dokončený**: `compressor-processor.js` (2-input: main + sidechain detektor; PEAK/RMS detektor stereo-link; 2× one-pole SC HPF 12 dB/oct len na detektor; soft-knee gain computer; asym. attack/release smoothing; makeup+mix parallel; GR metering protokol z limitera) + `compressor-node.ts` wrapper (setSidechainInput, makeup dB→lin, getGainReductionDb). Registry: worklet gating, natívny DCN fallback (degraded „reduced", GR cez `.reduction`), +2 parametre `detector`/`scHpf` (staré 7 ID 1:1 ⇒ žiadna migrácia), 4 preset-y (Glue/Punch/Smash/Bass Level). EffectRack: SOURCE picker + GR bar zdieľané s compressorom. Verifikácia: typecheck ✓ (0 chýb), vitest 923/923 ✓, test:browser 0 FAIL — hot input rms 0.0568/0.4950 (gr 20.2 dB), SC HPF: 45 Hz detektor gr 23.9 dB@HPF20 vs 0.0 dB@HPF300, mix=0 peak=0.8000 presne. Slabina #2 uzavretá — Compressor Tier C → A.
- 2026-08-27 — **P0.3 ITU BS.1770 metering dokončený**: nový `kweighting.ts` (presné BS.1770-4 koeficienty pre ľubovoľný fs, KWeightingFilter, `analyzeLoudnessBuffer` s dual gate −70/−10 LU v power doméne); `kwmeter` sink worklet v master chain (koeficienty cez processorOptions ⇒ žiadna duplikovaná matematika, RESET INTEGRATED posiela reset do workletu); `truePeakOversampled` (4× polyphase, 4×16 taps Blackman sinc) nahradil parabolický odhad v `measureTruePeak` aj `summarizeBuffer` (exporty teraz merajú skutočný dBTP); `getMasterMeterSnapshot` preferuje presné worklet hodnoty, legacy fallback zachovaný. Slabina #3 uzavretá — LUFS je K-weighted, true-peak je oversampled. Verifikácia: oficiálny conformance vektor 1 kHz @ −23 dBFS → **−22.99 LUFS** (live worklet), ±0.2 LUFS @48 kHz aj @44.1 kHz (unit); fs/4 ISPE +3.01 dB detegovaný; typecheck ✓ (moje súbory), test:browser 0 FAIL.
- 2026-08-27 — **P0.4 Step Gate (trance gate) dokončený**: `stepgate-processor.js` (BPM-sync, fáza v beatoch s snap na grid, mix/depth/smooth, 8/16/32 krokov cez port messages); zdieľaný `StepGridEditor` komponent (min/max, drag-grid, percent width buttons); transport-phase re-align (`onTransportStarted` snap na nearest step boundary); `setEffectSteps` command + `applyEffectPreset` kroky; `EffectInstance.steps?: number[]` + `sanitizeGateSteps` + `normalizeEffects` + YDocAdapter sync; 4 preset-y (Trance/Stutter/Swell/Pad). Verifikácia: typecheck ✓ (moje súbory), vitest ✓ (doc-delta.test.ts je súbežný WIP), test:browser 0 FAIL — step gate kontrast even=0.1234 odd=0.0009 (137×), mix=0 peak presne.
- 2026-08-27 — **P0.5 Multiband Sidechain Pump dokončený**: rozšírenie `sidechain-processor.js` o `splitFreq` param (0–500 Hz): 2-pole Butterworth LP/HP crossover (presná jednota sum LP+HP cez `high = input − low`); LOW band duckený, HIGH band nepriate; splitFreq=0 = pôvodné full-band správanie (spätná kompatibilita); preset „Multiband Pump" (150 Hz, -22dB, 8:1). Verifikácia: fullBand 1kHz RMS=0.0215 (utopený), multiBand RMS=0.5054 (presvedčivo prežité); typecheck ✓, vitest ✓, test:browser 0 FAIL.
- 2026-08-27 — **P1.1 SV Filter + P1.2 Flanger + P1.5 EnvFollower FX polling dokončené**: SV Filter = Chamberlin SVF (semi-implicit, zero-delay LP/BP; TPT skúšaný ale HP mal numerickú divergenciu), LP/HP/BP/Notch + drive tanh, 5 presetov; Flanger = per-sample modulated delay s zero-delay feedback, stereo spread cez LFO phase offset, linear interp ring buffer, 3 presetov; EnvFollower FX/inst polling — `envfollower-processor` postuje env ~25×/s, `AudioEngine.applyEnvFollowersToParams()` aplikuje na FX/inst param targets cez `makeModulatorWriter`, napojené do Scheduler. Verifikácia: typecheck ✓, vitest ✓, test:browser 0 FAIL — LP crossingDensity=0.0090, HP rms=0.0070, Flanger relDiff=1.359.
- 2026-08-27 — **P1.3 Tremolo + P1.4 Autowah + P1.7 Stutter dokončené**: Tremolo = AM + Auto-Pan mode, shape morph sine→square, 3 presetov; Autowah = single worklet (env follower + Chamberlin SVF v jednom per-sample procese), minFreq→maxFreq sweep, BP/LP mode, 3 presetov; Stutter = BPM-synced loop-repeat (delay = 1 loop cycle, gate pattern na delayed signál, stereo buffery, feedback), zdieľaný StepGridEditor, 3 presetov. Verifikácia: typecheck ✓, vitest ✓, test:browser 0 FAIL — tremolo ratio 10×, autowah kontrast 213×, stutter gate kontrast 43903×.
- 2026-08-27 — **P1.8 Spektrum analyzátor UI dokončené**: `SpectrumAnalyzer.tsx` — log-frequency canvas (20 Hz → Nyquist), gradient fill + spectrum line + peak-hold trace, dB grid, observer-only rAF ~30 Hz; integrované do MasterMeter (post-limiter), `getMasterSpectrumAnalyser()` getter na engine. Verifikácia: typecheck ✓, test:browser 0 FAIL.
- 2026-08-28 — **P2 blok dokončený (tape, M/S EQ, Haas, multiband, bus)**: P2.1 tape-processor (hysterézia + tone LP, denormal guard) + kryty fallback/bypass + loader/core integrácia; P2.2 M/S EQ bugfix init + getAudioParam (8× AudioParam) + 3 presety; P2.3 Haas widener getAudioParam + 3 presety; P2.6 multiband prerobený na komplementárny unity-sum (wet−low→midHigh, midHigh−mid→high) + getAudioParam + 3 presety; P2.8 audio-rate modulation bus — `EffectRuntime.getAudioParam` na 13 efektoch, `modulators.ts` generalizovaný pre `osc`/`envFollower` target, `AudioEngine.syncLfos` bus (`resolveModTargetParam`/`modulationDepthForTarget`, target-aware signature, stale-param rewire, BPM live sync), `applyEnvFollowersToParams` skip audio-rate. Bonus: `eq` getAudioParam, `groove.ts` cache-free hashCombine (+30% drumHitsInWindow), `stems.ts` buildStemProject group-routed stems, `EFFECT_ORDER`/`CORE_EFFECT_ORDER` aktualizované. Verifikácia: `typecheck` ✓ (0 chýb), `vitest` 1007 passed / 49 skipped ✓.
- 2026-08-28 — **P1.9 Denormal guards dokončený**: FTZ flush `<1e-20 → 0` v 11 workletoch (sidechain env+LP state, gate env+gain, transient fast/slow, limiter gainL/R, svfilter/autowah bp/lp, compressor SC-HPF + gain, tape lp, tremolo gain, kwmeter biquads, stutter feedback). Existujúce guardy v envfollower/flanger/stepgate ponechané. Verifikácia: typecheck ✓, vitest 1007 ✓.
- 2026-08-28 — **P2.4 Comb filter dokončený**: `comb-processor.js` (8192 ring, linear interp, y[n]=x[n]+fb·damp(y[n-D]), D 0.5–60 ms, fb −0.95..+0.95, damp 500–12000 Hz, mix, FTZ 1e-20) + `comb-node.ts` s `getAudioParam` (audio-rate bus); `core-processor.js`/`loader.ts` integrácia (`comb` critical, bypass 1:1), `registry.ts` + `presets.ts` (3 presety Tight/Resonant/Metallic), EFFECT_ORDER/CORE_ORDER + audit tabuľka. Verifikácia: typecheck ✓, vitest 1007/50 ✓.
- 2026-08-28 — **P2.5 Vowel filter dokončený**: `vowel-processor.js` (3× peaking RBJ, A-E-I-O-U log-morph, Q 3.5→9, gain 7→15 dB, FTZ) + `vowel-node.ts` (getAudioParam), loader/core `vowel` critical, registry+presets (A→E/I→O/U Hollow). Verifikácia: typecheck ✓, vitest 1007/51 ✓.
- 2026-08-28 — **P2.7 Ducking delay dokončený**: `ducking-delay-processor.js` (131072 ring, dry envelope thresh/attack/release → duckGain, damp LP, feedback neduckovaný), `ducking-delay-node.ts` (8× getAudioParam), loader/core `duckDelay` critical, registry+presets (Clean/Heavy Duck/Slap). Verifikácia: typecheck ✓, vitest 1007/52 ✓.
- 2026-09-18 — **Top zvukové winy (Chorus + Delay + Bussy C→A)**: `chorus-processor.js` (2 true-stereo hlasy 12/18 ms, cubic-hermite čítanie, SPREAD = rate-offset druhého LFO + crossfeed, depth law 1–9 ms ako legacy) + `chorus-node.ts`; `stock-delay-processor.js` (stereo, cubic-hermite, one-pole damping v loope, ping-pong crossfeed, SYNC divízie OFF/1/4–1/16T + bpm, 20 ms glide TIME bez zipperu) + `stock-delay-node.ts`; oba v `core-processor.js`/loaderi (`chorus`/`delay` degraded, legacy natívne grafy ako fallback). Drum/Bass Buss: shaper 2x→4x + glue cez custom compressor worklet (drum = PEAK detektor, bass = RMS; legacy DCN fallback + degraded flag) + GR do EffectRack GR baru (aj compressor sa tam konečne polluje). Nové param ID len aditívne (spread/sync/pingPong, defaulty = legacy správanie), staré projekty hrajú bez migrácie. Presety: Delay 3 nové (Slapback/Ping-Pong 1/8/Dub 1/4), Chorus +1 (Tight). Verifikácia: `tests/chorus-delay-buss.test.ts` 15/15 (echo spacing, sync, ping-pong alternácia, decay, glide, unity, soak), dotknuté sady 152 ✓, typecheck dotknutých súborov ✓. Poznámka: chorus/delay/bussy znejú odteraz lepšie = zámerná zvuková zmena existujúcich projektov (nie bit-exact zachovanie).
- 2026-09-18 — **Aliasing + true-peak balík**: saturátory 2x→4x (`saturation`, `distortion`, `shimmer` exciter, Bass DIST, 808 drive, Log Drum grit, Drum Synth drive — `AudioEngine`/master clipper a `clipper` už 4x boli; `bitcrusher` fallback a modmatrix CV shapers zámerne ostávajú `none`); cubic-hermite čítanie vo `flanger`/`comb`/`ducking-delay` (stutter zámerne integer — frakčné čítanie by rozladilo loop); core limiter deteguje **true-peak** (4× Blackman-sinc polyfáza, rovnaké jadro ako metering estimator — max(sample, ISP) do max-deque, latencia nezmenená, materiál bez ISP overshootu sa správa bit-identicky ako legacy). Master limiter dedí automaticky (rovnaký procesor). Verifikácia: `tests/aliasing-truepeak.test.ts` 7/7 (fs/4 izolačný test GR>0 pri thresholde nad sample peakom, sine regresia peak=ceiling/gr>3, latencia = lookahead, unity, soak; comb/flanger/ducking timing+decay+unity), dotknuté sady 229 ✓, browser-check tolerancie (`peak ≤ ceiling+0.02`) pokrývajú TP príspevok.
- 2026-09-18 — **Rýchle úpravy (VØID HQ + Pump key + EQ de-cramp)**: VØID render-quality auto-switch presne po vzore PRISM HQ (`ozvenaRenderQualityBumps` — len default-tier `standard` inštancie na stopách/returnoch, explicit eco/high/render sa rešpektuje, dokument sa nemutuje; `RenderOptions.ozvenaRenderQuality`, toggle VØID HQ v ExportPaneli default ON, scorepack passthrough) — freeze stays live quality (precedens PRISM); Pump hrá po novom zo **skutočného sidechain key** (SOURCE picker + KICK skratka; key → envfollower worklet 2 ms attack / RELEASE 50–600 ms → amt/inv → target.gain; bez core bundlu natívny rectifier+LP fallback + degraded flag; bez keya bit-identický osc režim vrátane browser-checku); stock EQ beží na **`eq-processor` worklete** (paralelné shelvy = exaktné konce pásem, Q-korekcia zvonov inverzom bilineárneho warpu, RBJ HP/LP, per-sample float64, alias-precedens ako legacy, legacy natívny fallback + degraded flag). Verifikácia: `tests/quick-wins.test.ts` 12/12 (bumps kontrakt, alias-precedens, pump key wiring + envelope design, shelf plateaus ±G, peaking center+šírka, HP/LP stopbandy, soak) + Pump picker UI test, dotknuté sady 253 ✓. Poznámka: EQ znie odteraz lepšie = zámerná zvuková zmena (nie bit-exact).
- 2026-09-19 — **Inovácie I (Quality switch + Mono guard + Gain verdict)**: globálny `quality: "live"|"studio"` switch v `RenderOptions` (vyhráva nad legacy `fxeq/ozvenaRenderQuality` flagmi, ktoré ostávajú pre back-compat; `resolveRenderQuality` + `renderQualityBumps`; ExportPanel jeden QUALITY select default STUDIO, scorepack `quality` passthrough, freeze/bounce ostávajú live tier); **mono-loss strážca** v exporte (`evaluateExportMonoGuard` — rovnaké prahy ako live mix-check: warn < −3 dB, bad < −6 dB / negatívna korelácia; MONO LOSS riadok + alert box v ExportSummary); **gain-staging verdict** v exporte (reuse `evaluateMasterVerdict` s `doc.master.lufsTarget/ceilingDb` — GAIN VERDICT headline + FIX IT hinty, rovnaká reč ako live master meter; L/R-imbalance check neutrálny, offline summary ho nemeria). Verifikácia: render-quality 6 ✓, metering 16 ✓ (4 nové mono-guard), ExportPanel 7 ✓ (2 nové quality), scorepack/master-gain-staging ✓, súvisiace sady (fxeq-crossover, quick-wins, midi-io, aliasing-truepeak) 41 ✓; typecheck dotknutých súborov ✓, prettier ✓.
- 2026-09-19 — **Tape 4× oversampling**: `tape-processor.js` beží s nelineárnym stupňom na 4× za 33-tap Blackman-sinc anti-image/anti-alias párom (cutoff π/4; 17-tap prototyp mal príliš široký transition — A/B test nameral len 10,4 dB); hystézia s korigovanou časovou konštantou (h^0,25), dry-delay presne 8 samplov + `getLatencySec` pre PDC (tape hrá aj na masteri). Verifikácia: `tests/tape-oversampling.test.ts` 8/8 (foldy 5./7. harmonickej 7 kHz tónu ≥20 dB dole oproti naivnej base-rate referencii, fundamentál ±1 dB, latencia = 8, unity, pamäť hystézie, tone, output gain, soak), dotknuté sady 121 ✓. Poznámka: tape znie odteraz čistejšie = zámerná zvuková zmena (nie bit-exact).
- 2026-09-19 — **Export AUTO stage**: `computeStageAdjustment()` v `metering.ts` (čistá matematika — master IN tak, aby true peak sedel na ceiling − 1 dBTP a LUFS-I na targeti; vyhráva konzervatívnejšia z dvoch delt, takže jeden krok nikdy neclipne; strop sa nesiaha, ticho/mute/už-staged = noop) + tlačidlo AUTO STAGE v ExportPaneli (jeden undoable `setMasterConfig`, po aplikácii STAGED ✓ + výzva na re-export). Verifikácia: metering 5 nových testov (hot/combo/quiet/noop/clamp), ExportPanel UI flow s mocknutým renderom (horúci export → tlačidlo → jeden setMasterConfig s gain < 1 → STAGED disabled), súvisiace sady 33 ✓; typecheck dotknutých súborov ✓, prettier ✓.
- 2026-09-19 — **PDC pre sendy + oversampling kontrakt**: každý send má vlastný delay node (`sendDelays`, tap post-track-PDC; `sendPdcDelaySec` = downstream group latencia − latencia returnu); returny sa neinflatujú do maxima a držia pravé relatívne načasovanie; dry vs wet sedí pre zero-latency returny z ľubovoľnej stopy/grupy (zvyšok: latentný return z nízkeho reťazca). Analog drive 2x→4x už v strome bol (predchádzajúci commit) — pribudol pin test, že žiadny audio-path shaper neklesne pod 4× a `"none"` ostáva len na 5 allowlistovaných miestach (modmatrix CV ×2, pump key ×2, bitcrusher fallback ×1). Verifikácia: `tests/send-pdc.test.ts` 7/7, `tests/oversample-contract.test.ts` 2/2 + browser-check „pdc: grouped send via return lands on dry"; dotknuté sady 96 ✓; typecheck ✓ (AudioEngine.ts ostáva v prettier inventári deviácií, nemením).
- 2026-09-19 — **Master finish (DC blocker + buss glue)**: reťazec master → tape → M/S → **DC HP 12 Hz (vždy on)** → **GLUE 2:1 RMS** → clipper → limiter; glue beží na worklet kompresore (natívny DCN fallback + degraded flag), mix 1/0 podľa `glueEnabled` (default ON — pod prahom transparentné), latencia 0 (bez PDC dopadu); GR odpočet GLUE v master metri; `MasterConfig.glueEnabled` v types/schema/collab-YDoc/mixer toggle. Verifikácia: `tests/master-finish.test.ts` 3/3 (DC 12 Hz, default ON, fallback toggle), master-gain-staging +2, Mixer toggle, MasterMeter GLUE (paralelný test sedí), browser-check „master glue levels a hot mix"; collab round-trip + default-master testy doplnené (vrátane `bassMono*` z paralelnej session v YDoc mirror liste). Poznámka: master znie odteraz lepiacnejšie = zámerná zvuková zmena (nie bit-exact).
- 2026-09-19 — **Band-limited oscilátory (PolyBLEP-tier bez workletu)**: `src/instruments/bandlimited.ts` — aditívne tabuľky s presne sub-Nyquist harmonickými pre naplánovaný pitch (per-note, bez capu), RMS-normalizované na naive hlasitosť, cache per kontext; `shapeOscillator` drop-in náhrada za `osc.type =` v analog (oscA/oscB/unison), bass (saw/square body), texture (saw), drumsynth (hats/cowbell/rimshot/snare/crash/ride/zap). Natívne timing/fáza/determinizmus nezmenené — mení sa len spektrum. FM/keys ostávajú native (audio-rate FM statická tabuľka neuniesie — zdokumentované). Verifikácia: `tests/bandlimited.test.ts` 9/9 (počet harmonických, RMS, nepárne spektrá, A/B: foldy 12./13. harmonickej 2100 Hz tónu ≥40 dB dole, fundamentál ±0,5 dB; mock-ctx wiring + cache). Poznámka: jasné leady znejú odteraz čistejšie = zámerná zvuková zmena (nie bit-exact).
