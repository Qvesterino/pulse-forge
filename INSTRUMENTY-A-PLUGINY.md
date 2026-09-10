# Pulse Forge — Prehľad instrumentov a pluginov

> Stav k **10. 9. 2026** (main). Zdroje: `src/instruments/registry.ts`, `src/instruments/wavetables.ts`,
> `src/project-model/types.ts`, `src/effects/registry.ts`, `src/effects/presets.ts`, `src/presets/factory.ts`.

Pulse Forge momentálne disponuje:

| Sekcia | Počet | Kde |
| --- | --- | --- |
| Melodické inštrumenty (inštrumentová stopa) | **14** | `src/instruments/registry.ts` |
| Drum syntetizátory (pady bubnovej stopy) | **7** | `src/project-model/types.ts` + `src/audio-engine/synth-voices.ts` |
| Veľké pluginy (vendored DSP rack) | **3** — FXEQ, Ultina, Ozvena | `src/effects/*-core/` |
| Ostatné mixové FX (effect rack) | **32** | `src/effects/registry.ts` |
| Factory presety | **182 inštrumentových + 6 bubnových** | `src/presets/factory.ts` |

---

## 1. Melodické inštrumenty (14)

Všetky inštrumenty sú WebAudio grafy na main threadu s per-voice stateful filterom
(AudioWorklet `svfilter-processor`, fallback biquad LP). Spoločné črty:

- **Voice stealing** — pri prekročení polyfónie sa uvoľňuje najstarší hlas.
- **Deterministické plánovanie** — obálky a grainy sa plánujú dopredu, takže offline render znie identicky ako live playback.
- **Live parametre** — CUTOFF/RESO sa mení plynule (`setTargetAtTime`) aj počas hrania.
- **Glide/portamento** — podpora sliding na Bass, 808, Log Drum (frekvenčný ramp) a Sampler (playbackRate ramp).
- **MPE poly aftertouch** — na 9 inštrumentoch (Analog, Bass, Sampler, Wavetable, Keys, Pluck, Spectral, Log Drum, FM): tlak na notu otvorí **len jej filter** až +50 % nad per-note bázu (vrátane keytracku/V-FLT); FM nemá filter, takže tlak mapuje na INDEX (jas modulácie) s tým istým +50 % stropom. Tlak 0 vracia bázu. Per-voice cez filter→nota mapy, takže akord sa dá „obraľovať" notu po note.
- **Filter je stabilný v celej rovine cutoff × rezonancia** — Chamberlin SVF má numerický stabilita clamp (`f·q`), takže extrémne nastavenia (vysoký cutoff + nízka rezonancia) neprejdú do clamp limit cyklu; len mierne zmenšia efektívnu rezonanciu v tom rohu.
- **Panic/dispose** — okamžité utíšenie všetkých hlasov.

### 1.1 Sampler (`sampler`) — 16 hlasov
Prehrávanie sample z banky s transpozíciou okolo root noty.

| Parametre | Rozsah / možnosti |
| --- | --- |
| ROOT | nota 24–84 (default C4) |
| **START** | štartovací offset v sample (0–100 %) — prístup k útokovým transientom, gating loopov z ľubovoľného miesta; v reverse móde sa mapuje od začiatku pôvodnej takeny |
| ATTACK, RELEASE | ms obálky |
| CUTOFF, RESO | per-voice LP filter |
| **FILTER** | režim filtra **LP / BP / HP** (živá zmena; BP na chopoch znie formantovo) |
| **KEY TRK** | keytracking — cutoff sleduje výšku noty (default 0 = neutrálne) |
| **V-FLT** | velocity→filter — tichšie noty stmavujú cutoff až o dve oktávy (pri 100 %); klávesová vyjadrovosť |
| GAIN | 0–100 % |
| **Velocity layers / round-robin** | `velocityLayers` na stope (`SampleLayer[]`): disjunktné okná = velocity vrstvy (napr. factory kick kit soft→punch→deep→sub), **prekrývajúce sa okná sa striedajú round-robin**. Nastaviteľné cez `setVelocityLayersCommand`; žiadna zhoda = fallback na `sampleId`. Hotové beat kitmy v `FACTORY_BEAT_RR_KITS` (kick/snare/hat) — sample library obsahuje RR variácie (`.rr2`, `.rr3`: ±~1,5 % výška/dĺžka, ±4 % úroveň), takže beaty neprehrávajú bitovo rovnaký hit dvakrát
| **Keyzones** | voliteľné `minPitch`/`maxPitch` vo vrstvách — sample podľa výšky noty (Kontakt-lite); helper `keyzoneLayers` + `FACTORY_TONAL_KEYZONES` |
| STRETCH | **Pitch** (rýchlejšie = vyššie) alebo **Stretch** (time-stretch — výška sa mení bez zmeny dĺžky, interný PSOLA-like algoritmus + cache; **stereo** — každý kanál beží na rovnakej deterministickej grain mrie, takže L/R ostáva fázovo zarovnané) |
| LOOP | One-shot / Loop s prerenderovaným seamless bufferom (Hann crossfade na šve, snap na nulovú osu) |
| L-XFADE | dĺžka loop crossfade |
| REVERSE | prehrávanie odzadu (cache obrátenej kópie) |
| SPREAD | deterministický náhodný stereo pan na notu |

### 1.2 Analog Synth (`analog`) — 12 hlasov
Klasické subtraction synth voicovanie: **OSC A + OSC B (detune) + sub osc −12 + noise** → per-voice SVF lowpass → amp.

- OSC A/B: sine / triangle / saw / square, detune OSC B ±50 ct
- CUTOFF, RESO, **FILTER MODE: LP / BP / HP** (živá zmena aj počas hrania), **KEY TRK** (filter sleduje výšku noty — C4 je referencia)
- **DRIVE** — tanh saturovanie v SVF filtri (worklet), pred-filter analógová teplota; **2× oversamplovaná saturation stage** (harmonické nad Nyquistom sa neskladajú späť ako grit — fold ≥40 dB pod fundamentalom), živá zmena aj počas hrania (biquad fallback ho ignoruje)
- **FLT ENV** (velocity-citlivý filter sweep)
- **UNISON 1–8×** so SPREAD — detuned kópie OSC A roztvorené do sterea
- LFO RATE/DEPTH — audio-rate wobble na cutoff + **LFO SYNC** — uzamknutie rýchlosti na notovú divíziu (1/2, 1/4, 1/8D, 1/8, 1/8T, 1/16) podľa tempa projektu
- **DAHDSR obálka** — ENV DELAY + ENV HOLD stage, tvary A/D/R (Exp/Lin/Log) a **D LOOP** (decay sa zopakuje — pulzujúce pady/perkusné obálky). Legacy defaulty = bitovo historické správanie
- LEVEL

### 1.3 Bass Synth (`bass`) — 4 hlasy
Bass-first voicovanie: **saw + detuned square (telo, šíriteľné do sterea) + sine sub −12**.

- SUB / BODY / PUNCH (tight filter env 200–2600 Hz) / GRIT (miera drive)
- **GLIDE** — portamento medzi poznámkami
- **DIST: Soft / Tube / Hard** — per-voice waveshaper 2× oversamplovaný (asymetrická tube krivka, hard clip)
- **DRIVE** — tanh saturovanie v SVF filtri (worklet) — zahrieva harmonické ešte pred rezonanciou filtra; odlišný charakter od GRIT (ktorý je post-shaper za filtrom)
- **FILTER MODE: LP / BP / HP** a **KEY TRK** — rovnaké ako na Analgu (default neutrálne)
- **UNISON 1–6× + SPREAD** — supersaw telo (detuned saw fan do sterea), glide funguje aj v unizóne
- MOVE — LFO wobble na filter (3,2–5 Hz)
- WIDTH, CUTOFF, RESO, LEVEL

### 1.4 808 Synth (`808`) — monofónny
Trap/808 basa: **sine s pitch dropom** na transiente + čistý **sub osc o oktávu nižšie** (mimo shapera).

- DECAY (0,05–4 s), P-DROP (hĺbka pitch dropu), CLICK (noise transient cez HP)
- DRIVE + **DIST: Soft / Tube / Hard** — drive len na hlavnom signáli
- TONE — lowpass farba
- **GLIDE** — 808 slides (priebežný portamento bez nového attacku)

### 1.5 Texture Synth (`texture`) — 4 hlasy
Pad / drone / atmosférický engine. Signálová cesta na hlas:
**OSC1 + OSC2 (detuned, sine alebo saw podľa TEXTURE) + filtrovaný noise → bandpass (modulovaný) → amp s tremolom → sum → dry + delay so spätnou väzbou**.

- COLOR — centrum bandpass filtra (200 Hz–3 kHz)
- MOTION — hĺbka zdieľaných LFO (filter + detune)
- SPACE — feedback delay „space" (tónovaný, LP 4 kHz)
- **SYNC** — uzamknutie delay času na notovú divíziu (1/2…1/16) podľa tempa; OFF = klasických 0,42 s
- DENSITY — balans osc vs. noise
- TEXTURE — plynulý prechod sine → saw + rezonancia filtra
- CHAOS — deterministické rozšírenie LFO rýchlostí (seed z ID stopy)

### 1.6 Wavetable Synth (`wavetable`) — 8 hlasov
Morphing wavetable: každý hlas prehráva dve framy tabuľky crossfaded podľa MORPH, zdvojené ako detuned pár + voliteľný sub.

- **5 factory tabuliek: Sine Grow, PWM, Formant, Digital, FM Drive** (aditívne syntetizované)
- **Import z sample** — keď je stope priradený sample, tabuľka sa extrahuje autokoreláciou (detekcia periódy)
- MORPH (pozícia v tabuľke), DETUNE páru, SUB
- **M RATE / M DEPTH — per-note crossfade LFO**: morph pozícia „dýcha" okolo MORPH bázy (LFO tlačí +wobble na frame A a −wobble na frame B — súčet gains konštantný, žiadna amplitude pumpa; hĺbka sa clampne na priestor dvojice fám, takže gainty nikdy nepodtečú pod nulu). Default OFF — existujúce projekty znejú nezmenene
- **Mipmapped playback** — každá tabuľka má band-limited úrovne (FFT, ~polovica harmonických na oktávu); hlas si vyberie úroveň podľa výšky noty, takže harmonické nad Nyquistom neskĺznu ako grit. Level 0 = pôvodná tabuľka (nízke pitchy bitovo identické)
- **Voice-worklet engine (`wtvoice-processor`)** — keď je worklet načítaný, celý hlas (unison osc bank, morph/scan, sub, SVF filter, obálka, mod matrica) beží per-sample vo worklete s 8 hlasmi, oldest-steal a sample-accurate event queue; fallback = historický main-thread graf nižšie
- **Mod matrica (per-voice, per-sample)** — 2 slobodné routy: zdroj (Env / LFO / Velocity / MPE Pressure) → cieľ (Morph / Cutoff / Detune / Amp), ±100 % amount; LFO fáza je per-voice dekorrelovaná. Parametre MOD A/B (SRC/DST/AMT) + MOD LFO RATE
- **S RATE — scan engine, skutočné prechádzanie tabuľkou**: pozícia sa počas noty posúva celou tabuľkou dopredu s wrapom. Nota sa delí na segmenty po pároch fám, blend v segmente rampuje lineárne a hranice sa striedajú pod ~6 ms equal-power crossfade (žiadne klicky). Segmenty sú capované (14) — po cap sa hlas „zamrzne" na poslednom páre. Pri zapnutom SCAN berie S RATE veli M RATE/M DEPTH
- **FILTER MODE: LP / BP / HP** a **KEY TRK** — rovnaké ako na Analgu (default neutrálne)
- UNISON 1–8× + SPREAD, CUTOFF/RESO, ATTACK/RELEASE, LEVEL

### 1.7 Granular Synth (`granular`) — 6 hlasov
Granulárny sampler — každá nota naplánuje celý grain cloud dopredu (deterministický PRNG zo seedu stopy + noty).

- POSITION — čítacia pozícia v sample
- GRAIN — dĺžka zrna 20–400 ms
- RATE — 1–60 grainov/s (overlap kompenzácia hlasitosti) + **R SYNC** — grain rate uzamknutý na notovú divíziu (rytmické cloudy)
- JITTER — náhodná odchýlka pozície
- **SCAN — drift čítacej hlavy cez sample** (zlomky dĺžky sampleu za sekundu, wrapuje okolo koncov, negatívne = dozadu; HOLD pri 0). Deterministické — každé zrnko číta pozíciu svojho času
- SPREAD — náhodný pan zrna
- PITCH — transpozícia ±24 st
- **P RAND — per-grain pitch spray ±0–12 st** (klasická granulárna „mrak" rozsypanka)
- REVERSE — pravdepodobnosť prehrania zrna odzadu
- TONE — LP filter; SHAPE — tvar trapezoidnej obálky zrna
- MAX 512 grainov na notu; ATTACK/RELEASE/GAIN
- Obe nové makrá sú default vypnuté a PRNG poradie ťahov ostáva zachované — staré presety znejú bitovo rovnako

### 1.8 Keys (`keys`) — 8 hlasov
4-op FM elektrické piano: **dva paralelné FM páry** — A: 1:1 (telo/tine), B: nastaviteľný pomer 1–7 (bell) — sčítané cez spoločný lowpass.

- TINE / BELL — modulačný index (jas FM)
- BODY — mix nosiča páru A
- DAMP — tlmenie sustainu a release (muted Rhodes)
- TREM — amp tremolo 4,8 Hz + jemné filter wobble
- RATIO — pomer bell modulátora
- WIDTH, CUTOFF/RESO, **FILTER MODE: LP / BP / HP**, **KEY TRK**, LFO RATE/DEPTH (audio-rate sweep FM jasu) + **LFO SYNC** (notové divízie), ATTACK/RELEASE
- **UNISON 1–3× + SPREAD** — FM-friendly unison: detuned kópie telového páru A pri zníženej úrovni
- Velocity riadi FM jas — mäkšie údery = okrúhlejší zvuk

### 1.9 FM Synth (`fm`) — 10 hlasov
Klasické **2-operačné DX-style FM**: modulátor → modGain → `carrier.frequency`, voliteľná self-feedback modulátora (128-vzorkové oneskorenie láme WebAudio cyklus) pre growl. Deviácia škáluje s frekvenciou nosiča → rovnomerná hustota bočných pásov po klávesnici.

- RATIO — pomer modulátora (0,25–16), INDEX — hĺbka modulácie
- M-DECAY / M-SUS — obálka indexu (plná pri ataku → sustain zlomok)
- FEEDBK / FB-DECAY / FB-SUS — growl spätná väzba s vlastnou obálkou
- M-WAVE — SIN / TRI / SQR, amp ADSR, LEVEL
- **Live tonové parametre** — RATIO/INDEX/M-DECAY/M-SUS/FEEDBK/FB-DECAY/FB-SUS retunujú bežiaci hlas naživo (živý krúžok aj automation); M-WAVE a amp obálka platia pre nové noty
- Velocity riadi INDEX (`0,45 + vel·0,55`, rovnaká krivka ako Keys) — mäkký úder = okrúhlejší zvuk

### 1.10 Pluck Synth (`pluck`) — 12 hlasov
**Karplus-Strong fyzikálny model** — ladené oneskorenie (1/f) s tónovanou spätnou väzbou, excite krátkym noise burstom.

- PICK — jas excitácie (soft = LP, bright = HP)
- DAMP — množstvo spätnej väzby / dĺžka dozvuku
- BODY — úroveň excitácie
- TONE — filter vo feedback loope
- DECAY, WIDTH (pan podľa noty), CUTOFF/RESO, ATTACK/RELEASE, LEVEL

### 1.11 Log Drum (`logdrum`) — 4 hlasy
Amapiano log drum: **3 inharmonické sine partiale** (pomer 1 / ~2,15 / ~3,8, driftujúci s výškou) → tanh grit → notch (HOLLOW) → SVF lowpass.

- DECAY, DROP (pitch drop na transiente, velocity-citlivý)
- **D SPLAY — per-partial pitch drop**: vyššie partialy dropujú ďalej a rýchlejšie sa ladía — „drevené" zabelnutie režimov pri údere (0 = uniformné)
- TONE, BODY, HOLLOW (notch „dutosti"), GRIT
- WIDTH, **GLIDE**, LEVEL

### 1.12 Spectral Pad (`spectral`) — 6 hlasov
Aditívny pad: až **8 sine partialov** na hlas, každý s vlastnou amplitúdou, decayom a priestorom.

- PROFILE — amplitúdová krivka partialov: **Harmonic / Bright / Odd / Formant / Bell**
- PARTIALS — počet partialov (2–8), hlasitosť je RMS-normalizovaná (zmena profilu neskáče v hlasitosti)
- **SPACING — predĺženie/komprimácia harmonickej rady `k^spacing`** (0,5× = organ flue, 2× = roztiahnuté zvonové bordóny; 1 = presne harmonická)
- INHARM — inharmonické rozťahovanie (stiff-string `k·√(1+Bk²)`), zvonové charaktery
- SHIMMER — deterministický per-partial detune (glassy rozjašenie)
- SKEW — vyššie partialy doznievajú rýchlejšie (teplý tail)
- ATTACK (do 4 s) / TAIL (do 8 s), CUTOFF/RESO, WIDTH (partialy roztvorené do sterea), LEVEL

### 1.13 Vocal Chop (`vocalchop`) — 8 hlasov
Sampler ladený na vocal chopy a talkboxové leady: sample hrá cez **paralelnú trojpásmovú formantovú banku** (F1/F2/F3 volené samohlásky).

- VOWEL — samohláska **A / E / I / O / U** (Peterson–Barney formanty)
- COLOR — suchý sample ↔ plná formantová farba
- SHIFT — škálovanie formantov 0,7–1,5× (mužský ↔ chipmunk hlas)
- SHARP — rezonancia formantových pásem (Q 4–13)
- **VIB — vibrato**: playbackRate LFO (≈5,2–5,7 Hz) s oneskoreným nástupom ~100 ms po ataku (ako skutočný spevák), hĺbka do ±60 centov
- **CONS — souhláskový transiant**: krátky širokopásmový HP noise burst na štarte noty (mimo formantovej banky) — psychicky zásadne posilní „vocálnosť" chopov
- **Glide** — prekrývajúce sa noty portamento (playbackRate ramp na žijúcom hlase, vibrato pokračuje navrchu)
- **MORPH** — automatická prechádzka formantov cez tabuľku samohlások počas noty („hovoriace" chopy)
- TONE (LP), REVERSE, ATTACK/RELEASE, GAIN, ROOT
- Defaultne dostane `factory.tonal.stab` sample, po pridaní stopy ihneď znie

### 1.14 Drum Synth (`drumsynth`) — 8 hlasov
Analógovo modelované bicie na inštrumentovej stope — **hrateľné chromaticky z piano rollu**. TYPE prepína 7 modelov:

- **Kick** — sine s pitch envelope (TONE = začiatočná výška, BODY = dĺžka dropu), SNAP = click
- **Snare** — 2 tónové osc (185/330 Hz) + noise cez ladený bandpass
- **Hat C / Hat O** — 6 square osc v klasickom kovovom pomere 808 → bandpass + steep HP; **choke** — closed hat pristrihne znejúci open hat (a open haty sa navzájom), klasické drum machine správanie
- **Clap** — noise bandpass s 3 pre-burstmi a telom
- **Perc** — ladený sine s pitch dropom (bongo typ)
- **Cowbell** — 2 square v klasickej racii 1 : 1,485
- Spoločné: TUNE (±12 st), DECAY, TONE/SNAP/BODY (normalizované makrá reinterpretované každým modelom), DRIVE (tanh shaper), LEVEL — one-shot voicovanie, gates ignoruje

---

## 2. Bubnová stopa — 7 syntetizovaných bicí

Drum track obsahuje pady; každý pad je buď **sample** (so slice, reverse, fade) alebo **syntetizovaný hlas** — keď nie je priradený asset, pad sa syntetizuje:

| Typ | Popis |
| --- | --- |
| `kick` | kopák so pitch envelope a sub body |
| `snare` | snare s body + snap |
| `hatClosed` | uzavretý hi-hat |
| `hatOpen` | otvorený hi-hat (dlhší decay) |
| `clap` | clap |
| `perc` | percusný hlas |
| `cowbell` | cowbell |

Každý syntetizovaný pad má 4 zdieľané parametre: **DECAY** (0,05–1,5 s), **TONE** (200–12 000 Hz), **SNAP** (attack/click/sizzle), **BODY** (low/sub/fat). Factory presetov pre bicie: 6 (`DrumSynthPreset`).

---

## 3. Veľké pluginy (3)

Všetky tri majú DSP v **AudioWorklete** a ich jadrá sú *vendored* z projektu **VocalForge_DAW** — bit-exact / parity-validované voči golden fixture (`tests/fxeq-golden.test.ts`, `tests/ultina-vectors.test.ts`, `tests/ozvena-golden.test.ts`). Ak worklet nie je dostupný, plugin spraví transparentný bypass (1:1 signál) — nikdy ticho nezlyhá.

### 3.1 FXEQ Multiband (`fxeq`) — kategória *character*
Multiband character/saturation rack.

- **2–6 pásem**, LR4 crossover
- Na každé pásmo reťazec 5 kreatívnych modulov: **Saturation → LoFi → Modulation → Delay → Reverb** + band gain/mix
- Master **safety limiter** (CEIL −6…0 dB), IN/OUT gain, MIX
- Rack expozízia: IN, BANDS, MIX, OUT, LIM, CEIL (per-band editácia príde s EQ-paint panelom)

### 3.2 Ultina Suite (`ultina`) — kategória *dynamics*
Neutron-class modulárna mixing suite.

- **10 modulov:** EQ, Comp, Gate, Exciter, Transient, Clipper, Density, Sculptor, Phase, Unmask
- **LUFS meter + autogain**, masking meter, spectrum analyzer, EQ learn / crossover learn
- Rack expozízia: IN, MIX, OUT + quick toggles **COMP / ATTACK (transient) / EDGE (exciter) / UNMASK**
- Factory presety: Vocal Air, Vocal Warmth, Vocal Presence, De-Ess (Dynamic), Low Cut 80 Hz, Tilt Bright, Vocal Glue, Vocal Punch, Master Bus Glue, Multiband Wide, Parallel Squash a ďalšie

### 3.3 Ozvena Reverb (`ozvena`) — kategória *space*
Neoverb-class tri-engine reverb.

- **E1 Reflections** — ranné odrazy
- **E2 Plate/Chamber** — platňa/komora
- **E3 Hall** — sála
- **Convolution engine** s generovanými factory IR (partitioned FFT konvolúcia)
- Reťazec: pre-delay → pre-EQ → enginy → reverb-EQ → mod (mod pad) → duck (s masking meterom) → safety limiter
- **XY Blend Pad** — krížové miešanie engineov
- Rack expozízia: IN, PAD X/Y, MIX, OUT, toggly E1/E2/E3

---

## 4. Ostatné mixové FX (32)

Okrem troch veľkých pluginov disponuje effect rack každého tracku (aj drum) týmito efektmi, rozdelenými do 5 kategórií:

| Kategória | Efekty |
| --- | --- |
| **Tone (5)** | EQ, M/S EQ, Multiband, SV Filter, Utility |
| **Dynamics (5)** | Compressor, Limiter, Gate, Sidechain, Transient Shaper |
| **Character (8)** | Saturation, Tape Sat, Clipper, Distortion, Bitcrusher, Shimmer, Drum Buss, Bass Buss |
| **Movement (11)** | Chorus, Flanger, Phaser, Tremolo, Autowah, Pump, Stutter, Step Gate, Comb, Vowel, Haas Widener |
| **Space (3)** | Reverb, Delay, Duck Delay |

K tomu per-track sends do return stôp (`ReturnTrack`) a mute/solo/freeze (render do AudioBufferu šetriaci CPU).

---

## 5. Factory presety (188)

Presety sú čisté dáta (žiadne volania do audio engine) — idú cez command do project modelu. Filtrované podľa **žánru** (house, techno, trap, ambient, score) a **mood** (dark, bright, warm, aggressive, clean, deep, atmosphere).

| Inštrument | Počet presetov |
| --- | --- |
| Analog Synth | 26 |
| Bass Synth | 20 |
| Keys | 17 |
| 808 Synth | 13 |
| FM Synth | 13 |
| Texture Synth | 13 |
| Drum Synth | 12 |
| Wavetable Synth | 15 |
| Sampler | 11 |
| Granular Synth | 10 |
| Vocal Chop | 10 |
| Pluck Synth | 9 |
| Spectral Pad | 9 |
| Log Drum | 4 |
| **Spolu inštrumenty** | **182** |
| Drum bicie (kick, snare, hat, clap…) | 6 |

---

## 6. Editačná vrstva (Fáza 3)

- **WavetablePanel** (vo floating plugine pri wavetable stope): canvas vizualizácia všetkých fám tabuľky stacked front-to-back, zvýraznený morph pár, blended aktuálna fáma jasne navrchu, pri zapnutom S RATE animovaný scan marker. Pod displejom **mod matrica** — MOD A/B: zdroj (Env/LFO/Vel/Press) → cieľ (Morph/Cutoff/Detune/Amp) s ±100 % amount, + MOD LFO RATE; riadi per-voice mod routes vo wtvoice worklete
- **EnvEditor** (Analog, PROFI mód): draggable DAHDSR — delay/attack/hold/decay/release handles (x = čas), decay roh ťahá aj sustain level (y), tvary A/D/R klipom cik-cak (Exp/Lin/Log), D LOOP badge cyklí OFF/2×/4×/8×; commity cez setInstrumentParam (jeden undo na ťah)
- **Randomize** — MUT (±12 % rozsahu okolo súčasných hodnôt) a DEEP (celý patch, log-distribuované cutoffy, options re-roll) priamo v hlavičke pluginu; level/gain a sampler root sa nikdy nemenia; seedované → undo/redo presné

## 7. Export — mastering-safe kvantizácia

MP3 aj WAV 16-bit export prechádzajú cez spoločný kvantizátor (`src/export/quantize.ts`):

- **Soft-knee clip** — obsah pod ≈ −0,45 dBFS prechádza bez zmeny; intersample overy sa zholia tanh kolenom namiesto hard-clipu (žiadne clip krížence na horúcom masteri),
- **TPDF dither ±1 LSB** — tiché pasáže a reverb tail-y fadesujú do korelovaného šumu namiesto digitálneho ticha,
- **Deterministické seedy** (per-kanál v MP3) — rovnaký render = byte-rovnaký súbor; 24-bit WAV dostane soft-knee bez ditheru, 32-bit float zostáva bez zásahu.
