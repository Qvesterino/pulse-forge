# DSP-ROADMAP.md

# Pulse Forge — Audio DSP Roadmap

> Implementačná roadmapa zvukovej kvality. Základ: audit engine z 27. 8. 2026.
>
> **Filozofia tohto dokumentu:** Pulse Forge je aplikácia VÝHRADNE na tvorbu inštrumentálov a beatov.
> Žiadny vokál, žiadne nahrávanie, žiadne vokálne mastering reťazce. Každá položka nižšie musí byť
> relevantná pre produkciu beatov / inštrumentálov, inak nepatrí do tohto zoznamu.
>
> Cieľ: **najlepšia možná zvuková kvalita v rámci web browsera** — nie feature-parita s DAW.

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
| Compressor | `DynamicsCompressorNode` + makeup + mix; žiadny sidechain input, žiadne GR metering | C |
| Saturation | `WaveShaper` tanh (2x oversample) + tone LP | B |
| Distortion | `WaveShaper` kubický soft-clip (2x) + tone | B |
| Clipper | `WaveShaper` (4x), hard clip / tanh + ceiling + softness | B |
| **Limiter** *(pridaný 2026-08-27)* | **AudioWorklet** — look-ahead max-deque, soft knee, program-dependent release, safety clamp, GR metering; fallback = transparentný bypass + warning | A |
| Reverb | `ConvolverNode` + procedurálne IR (Web Worker, seeded), predelay + tone | B |
| Delay | `DelayNode` + feedback + damping LP | C |
| Pump | saw → duck-curve shaper → modulácia gainu, BPM-sync | B (clever hack, nie skutočný sidechain) |
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
- [x] Envelope follower ako všeobecný modulátor — 2026-08-27: **v1 rozsah podľa dohody** — worklet `envfollower-processor` (per-sample asym. peak detekcia, tanh sensitivity) → audio-rate signál do **natívnych cielení (Volume/Pan)**; plná determinizmus live==offline; `polarity` DUCK(−1, default)/SWELL(+1); detector vždy tapuje source `nodes.input` (anti-feedback). Generálnosť na FX/inst parametre odložená na „audio-rate modulation bus" (P2). Verifikácia: browser-check „envelope follower: source transients shape host gain (cross-track)" — ducked=0.719 vs plain=0.801
- [x] Random / S&H LFO — 2026-08-27: stateless hash stream `mulberry32(hash(id|seed|k))` → ľubovoľný krok spočítateľný nezávisle ⇒ **bitovo deterministické rendery** (rel=5.9e-9); Hold/Glide režimy; plné AutomationTarget cielenie (Volume/Pan/FX/inst) cez zdieľaný `setParameterAt` kanál; seed 🎲 regen v UI
- [x] Step Modulator — 2026-08-27: bar-aligned uniform grid (absolútne ticky, pattern aj song mód identicky), steps 8/16/32 (drag grid v UI, commit na pointer-up), glideSec, plné AutomationTarget; composícia viacerých zdrojov do rovnakého cieľa sčítava (base + Σ) a koexistuje s audio-rate osc LFO (AC pridávanie). Verifikácia: „step modulator: gain alternates on the division grid" — gate=0.0905/0.0364 vs ctrl=0.0870/0.1604 (normalizované na house backbeat baseline)

### 1.5 Metering (`src/audio-engine/metering.ts`)

- [x] Peak / RMS / dBFS, stereo korelácia, mono-loss, L/R imbalance, peak-hold
- [x] LUFS — **aproximácia**: plochá energia s −0.691 offsetom, K-weighting vynechaný
- [x] True peak — **parabolický odhad**, nie skutočný 4x oversampling
- [ ] Spektrum/FFT analyzátor UI (analyzéry existujú, len sa nekreslia)
- [ ] K-weighted LUFS (ITU BS.1770)
- [ ] Skutočný true-peak (4x oversampled)

### 1.6 Čo je zdravé (nesiahame na to)

- [x] Disciplína live == offline — zachovať za každú cenu
- [x] Worklety sú reálne per-sample DSP (bitcrusher, sidechain, transient, gate) — dokáže to, že vlastné worklety sa oplatia
- [x] Wavetable + granulár — signál, akým smerom ísť (vlastné worklety > natívne wrappery)
- [x] Rozsah: worklety (gate/transient/sidechain) sú 80 % toho, čo by vokálna doména potrebovala — a aj tak ich nepresúvame; VocalForge má svoju doménu

---

## 2. Identifikované slabiny (z auditu)

1. ~~**Master limiter bez look-ahead**~~ — **vyriešené 2026-08-27**: `buildMaster()` pripraví look-ahead worklet (`attachMasterWorklet`), natívny `DynamicsCompressorNode` ostáva v reťazi ako neutrálny passthrough + fallback bez workletov; live upgrade po do-loadovaní modulov cez `upgradeMasterDynamics()`; GR metering na MasterMeter ("GR x.x dB"). Verifikácia: browser-check „master limiter: look-ahead brickwall pins export at ceiling" — peak=0.708/ceiling=0.708.
2. **Compressor je natívny wrapper** — bez sidechain inputu, bez GR metering, hlúpy release.
3. **LUFS bez K-weightingu, true-peak len odhad** — metering nie je credible pre „release" workflow.
4. ~~**Gate/Transient fallback = tichý passthrough**~~ — **vyriešené 2026-08-27** (P0.0): transparentný bypass s UI warningom, degraded flagy na všetkých 5 worklet efektoch, auto-rebuild po do-loadovaní modulov.
5. ~~**`monoBassFrequency` v Bass Busse nie je zapojený**~~ — **vyriešené 2026-08-27** (P0.0b); bonus: opravený aj nefunkčný mono súčet v Utility MONO BASS.
6. **Žiadne zero-delay filtre (SVF/TPT)** — všetko legacy biquad; modulovaný cutoff neznie „analogovo".
7. **LFO moduluje len track gain/pan** — nie filtre, nie FX parametre.
8. **Flanger v dokumentoch, v kóde nie je.** Tiež chýba: tremolo ako efekt, autowah, multiband. *(limiter doplnený 2026-08-27)*
9. **Žiadny spektrový analyzátor** — FFT dáta sú, UI nie je.
10. **Žiadne denormal guards** vo workletoch (dlhé tails môžu stáť výkon).
11. **Look-ahead limiter pridá latenciu** → treba PDC/kompenzáciu, inak stems vs. master frázovo nebudú sedieť (offline OK, live so sendami nie).
    * *Update 2026-08-27:* minimálna PDC implementovaná (`syncPdc`) pre insert chainy (track+group); send/return cesty ostávajú nekompenzované (zdokumentované). *Poznámka: master worklet limiter pridáva uniformných ~5 ms latenciu celej mixovej zbernici aj keď je LIMIT vypnutý (mix=0 obchádza limiting, nie delay) — pre produkciu beatov irelevantné, pre live tracking mikrofónu v princípe neexistuje.*

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
    * Poznámka: send/return cesty nie sú kompenzované (difúzne tails, pár ms neaudibilné) — zdokumentované v kóde
  - [x] Aceptačný test: browser-check „limiter: look-ahead worklet limits, meters and anticipates" — peak=ceiling presne (0.501/0.501), gr=5.1 dB, spread=1.017 (žiadne pumping), onset=221/221 vzorky (exaktný look-ahead delay); + „pdc: limiter track stays aligned with dry track (<2 ms)" — skew=0.70–0.88 ms; 2026-08-27
    * Poznámka k ceiling: dBTP je aproximované cez sample-peak + safety clamp; skutočná true-peak limitácia (oversampling) ostáva ako P2 položka
  - [x] **Bonus — master stage swap:** `buildMaster()` pripraví worklet limiter medzi clipper a natívny node (natívny = neutrálny passthrough + bez-workletový fallback); live splice po do-loadovaní (`upgradeMasterDynamics`); MasterMeter zobrazuje „GR x.x dB". Verifikácia: „master limiter: look-ahead brickwall pins export at ceiling" — peak=0.708/ceiling=0.708, a „master chain tames a hot mix" limited=0.891 (= presne -1 dBFS oproti 1.178 s natívnym nodeom); 2026-08-27
- [ ] **P0.2 — Vlastný kompresor (AudioWorklet)** namiesto `DynamicsCompressorNode`
  Sidechain HPF (kľúč je, aby kompresia necítila sub), mix (parallel), GR metering, opto/program release režimy, stereo-link.
  - [ ] Per-sample detektor + RMS/peak prepínač
  - [ ] Sidechain input (2-input node rovnako ako sidechain-processor)
  - [ ] GR metering + transfer curve v UI
  - [ ] Migrácia existujúcich Compressor preset-ov na nový engine (verzované parametre!)
- [ ] **P0.3 — ITU BS.1770 metering**
  - [ ] K-weighting filter (~20 riadkov: high-shelf + HPF biquad) do `metering.ts`
  - [ ] True-peak cez 4x oversampling (FIR halfband) namiesto parabolickej odhady
  - [ ] Overiť proti referenčným hodnotám (test vectors z EBU)
- [ ] **P0.4 — Trance-gate / Step-gate efekt (AudioWorklet)**
  8–32 krokový pattern, BPM-sync, depth, smooth, mix. Pre beatestov denná spotreba (gated pads, stutter hats).
  - [ ] Pattern editor UI
  - [ ] Transport-phase re-align (rovnako ako Pump)
  - [ ] Presety: gated pad, stutter hats, slow swell
- [ ] **P0.5 — Multiband sidechain pump**
  Duckovanie len pod ~150 Hz (crossover), rýchle recovery nad ním. Moderný low-end management, v browseri to nikto nemá.
  - [ ] Splitter (LP/HP) + 2× duck envelope + merger
  - [ ] Crossover frekvencia ako parameter

### P1 — výrazné zlepšenie zvuku

- [ ] **P1.1 — SVF/TPT zero-delay filter (AudioWorklet)** (Andy Simper topológia)
  Pre Filter efekt aj synth filtre; modulovaný cutoff bez zipperi, s drive-om v rámci.
  - [ ] LP/HP/BP/Notch režimy
  - [ ] A/B test oproti biquadovej verzii (rovnaký preset)
- [ ] **P1.2 — Flanger** (sľúbené v dokumentoch, chýba v kóde)
  Modulated delay + feedback + inversion switch + stereo.
- [ ] **P1.3 — Tremolo (efekt)** — stereo panning variant + amplitude variant, sync.
- [ ] **P1.4 — Autowah** — envelope follower (kód už máme v workletoch) → filter cutoff.
- [x] **P1.5 — Envelope follower ako všeobecný modulátor** — 2026-08-27 dokončené v rámci sekcie 1.4 (v1: natívne cieľe Volume/Pan, worklet, polarity; generálnosť FX/inst → P2 „audio-rate modulation bus"). Pozri §1.4 poznámky.
- [x] **P1.6 — Random / S&H LFO (seeded)** — 2026-08-27 dokončené v rámci sekcie 1.4 (stateless hash stream, Hold/Glide, plné AutomationTarget). Pozri §1.4 poznámky.
- [ ] **P1.7 — Stutter / Glitch (buffer-repeat) efekt** — granulár engine to zvládne s minimom kódu; repeat-rate synced na BPM.
- [ ] **P1.8 — Spektrum analyzátor UI** — EQ + master; kreslenie existujúcich FFT dát, nesmie zasahovať do audio timing (observer-only, pozri VISION §28).
- [ ] **P1.9 — Denormal guards vo workletoch** — FTZ/DAZ pattern (malý DC offset alebo flush pri < 1e-20) v envelope follower-och.

### P2 — až po P0/P1

- [ ] **P2.1 — Tape saturátor s hysterezou** (musicalkejší než tanh)
- [ ] **P2.2 — M/S EQ** — samostatné EQ pre mid/side
- [ ] **P2.3 — Haas widener** pre hats/perkusie (krátky delay na jednu stranu)
- [ ] **P2.4 — Comb filter** (resp. zvýrazniť comb režim vo filtri)
- [ ] **P2.5 — Vowel / formant filter** pre movement (formant gaussians už máme vo wavetable-och)
- [ ] **P2.6 — Multiband processor (2–3 pásma)** — až po tom, čo budú jednotlivé pásma kvalitné
- [ ] **P2.7 — Ducking delay** (v dokumentoch ako #78) — delay duckuje počas dry signálu

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

- [ ] **Look-ahead latencia vs. stems** — limiter s ~5 ms look-ahead posúva signál; offline render je OK, ale live playback so sendami bude frázovo posunutý, pokiaľ nezavedieme kompenzáciu. Riešenie minimalizovať: PDC aspoň pre tento jeden efekt, alebo look-ahead zapnuteľný len v offline režime.
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