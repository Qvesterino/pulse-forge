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
- [ ] Envelope follower ako všeobecný modulátor (existuje len vnútri workletov)
- [ ] Random / S&H LFO
- [ ] Step Modulator (v dokumentoch, nie v kóde)

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

1. **Master limiter bez look-ahead** — `DynamicsCompressorNode` s 2 ms attack. Najväčšia diera medzi nami a „production-ready export".
2. **Compressor je natívny wrapper** — bez sidechain inputu, bez GR metering, hlúpy release.
3. **LUFS bez K-weightingu, true-peak len odhad** — metering nie je credible pre „release" workflow.
4. **Gate/Transient fallback = tichý passthrough** — používateľ bez workletov dostane ticho bez varovania. Bug čakajúci na staťie.
5. **`monoBassFrequency` v Bass Busse nie je zapojený** (mŕtvy parameter).
6. **Žiadne zero-delay filtre (SVF/TPT)** — všetko legacy biquad; modulovaný cutoff neznie „analogovo".
7. **LFO moduluje len track gain/pan** — nie filtre, nie FX parametre.
8. **Flanger v dokumentoch, v kóde nie je.** Tiež chýba: tremolo ako efekt, limiter ako insert efekt, autowah, multiband.
9. **Žiadny spektrový analyzátor** — FFT dáta sú, UI nie je.
10. **Žiadne denormal guards** vo workletoch (dlhé tails môžu stáť výkon).
11. **Look-ahead limiter pridá latenciu** → treba PDC/kompenzáciu, inak stems vs. master frázovo nebudú sedieť (offline OK, live so sendami nie).

---

## 3. Roadmapa

### P0 — rozhoduje o „najlepšia kvalita v browsery"

- [ ] **P0.0 — Fallback fix (bugfix)**
  Gate a Transient Shaper fallback nesmie byť tichý passthrough.
  - [ ] Zmeniť fallback na transparentný bypass (1:1 signál)
  - [ ] UI warning badge „processor unavailable — bypassed"
  - [ ] Zobraziť v browser-checks (`src/browser-checks.ts`)
- [ ] **P0.0b — Zapojiť `monoBassFrequency` v Bass Busse** (mŕtvy parameter → zapojiť crossover rovnako ako v Utility)
- [ ] **P0.1 — Look-ahead limiter (AudioWorklet)**
  Ring buffer ~5 ms, stereo-link, soft-knee, program-dependent release, GR metering, ceiling v dBTP.
  - [ ] Worklet processor + TS node wrapper + loader registrácia
  - [ ] GR metering do UI
  - [ ] Latencia zdokumentovaná + kompenzácia v live grafe (PDC minimálne pre tento efekt)
  - [ ] Aceptančný test: export materiálu s beatmi dosiahne cieľovú hlasitosť bez audible pumping
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
- [ ] **P1.5 — Envelope follower ako všeobecný modulátor** — audio signál → ľubovoľný param (FX aj inštrument).
  Detekcia existuje, chýba len vystavenie + UI mapping.
- [ ] **P1.6 — Random / S&H LFO (seeded)** — mulberry32, determinizmus máme v krvi.
  Pre textúry, arpeggiá, movement.
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