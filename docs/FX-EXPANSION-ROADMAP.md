# FX EXPANSION ROADMAP — Beatmaking Effects

**Vznik:** 2026-09-19 · **Status:** plán (nezačaté) · **Zameranie:** výlučne beatmaking workflow
**Predpoklad:** 36 existujúcich efektov (5 kategórií) + flagshipy PRISM/Ultina/Ozvena/Kaskada zostáva — tento plán pridáva to, čo beatmaker pozná z FL/Ableton/Maschine a čo tu chýba.

---

## 0. Prečo tento plán existuje

KYX dnes pokrýva dynamics/tone/character/space/movement nad štandard (sidechain s cross-track routingom, drumBuss/bassBuss, transient shaper, stepGate, pump, Kaskada, mastering chain s true-peak limiterom a LUFS). Gap analýza voči FL Studio / Ableton / Maschine však našla efekty, ktoré definujú **beatmaking zvuk** a ktoré tu chýbajú úplne alebo len čiastočne:

1. **Beat Mangler** (Gross Beat štýl) — signatúrny efekt žánru, najväčšia diera,
2. **Pitch Shifter / Vocal Chops FX** — vocal chops a 808 pohyb,
3. **Tape Stop / Spin** — turntable transition,
4. **Multi-tap Delay**, **Vinyl suite**, **Vocoder**, **Ring Mod/Freq Shift**, a menšie upgrady.

Poradie fáz = pomer dopad/efort. Každá položka je **contained unit** (rovnaký pattern ako Kaskada): `EffectDefinition` v registry + prípadný worklet + testy + preset. Žiadny systémový risk, žiadna schema migrácia nad rámec existujúcich kontraktov.

---

## 1. Ako sa nový efekt plug-inuje (registráčný kontrakt — platí pre KAŽDÚ položku)

Checklist, ktorý musí splniť každá implementácia (overené na Kaskade a stepGate):

1. `EffectType` union — pridať id do `src/project-model/types.ts` (union `EffectType`).
2. `EFFECT_DEFS` — `EffectDefinition` v `src/effects/registry.ts`: `params: ParamDef[]` (min/max/default/format), `category` (tone/dynamics/character/movement/space), `factory(ctx, fx, env): EffectRuntime`.
3. Registrácia do zoznamov: `EFFECT_ORDER` (všetky) + `CORE_EFFECT_ORDER` alebo `DEVICE_MENU_EFFECTS` (mixér Add-Effect menu) + prípadne `FLAGSHIP_EFFECT_ORDER` (nie pre tieto).
4. Ak efekt má step/políčkové dáta → `EffectInstance.steps`-style voliteľné pole + **`normalizeEffects` sanitizér** v `src/project-model/schema.ts` (precedent: `stepGate` `steps?: number[]`, `EffectInstance.steps`).
5. Ak worklet → processor `src/audio-worklets/<name>-processor.js`, node wrapper `<name>-node.ts`, registrácia v `src/audio-worklets/loader.ts` (`ensureWorkletsForDoc`) + build script `scripts/build-core-worklets.mjs` + **core worklet budget** (`scripts/check-bundle-size.mjs`, teraz 144/150 KB — každý nový worklet treba počítať).
6. Fallback cesta bez workletov (povinné — `WORKLET_EFFECTS` mapa „critical"/„degraded", `effectProcessorStatus`).
7. Presety — pár charakterovýchsnapshotov do `src/effects/presets.ts` (žáner/mood tagy).
8. Tempo-sync efekt → `syncBpm(bpm)` v runtime (precedent: delay/pump) — live aj offline renderer musia prechádzať rovnakou cestou.
9. **Testy:** unit (factory, params clamp, fallback) + offline-parity test (live vs `renderProject` rovnaký výsledok — pattern `tests/render-event-parity.test.ts`) + browser check v `src/browser-checks.ts` (efekt znie, meter sa hýbe, determinizmus).
10. **Budget gate:** `npm run build` musí ostať zelený (entry/worklet budgety — bump len s komentárom prečo, konvencia existuje).

---

## 2. FÁZA 1 — Quick wins ( malý efort, veľký počuteľný dopad)

### 2.1 TAPE STOP / SPIN (`tapeStop`)

**Prečo:** turntable stop je signatúrny transition moment beatu. Dnes sa dá len napodobiť clip pitch automation.

**Zvuková podstata:** varispeed — write head do kruhového buffera beží stále 1.0×, read-head rate sa easingom spomalí na 0 (STOP) alebo prepne smer/rozhýbe (SPIN). Pitch padá prirodzene s rýchlosťou — to je ten žiadaný efekt.

**Implementácia:**
- **AudioWorklet** (native Web Audio nemá varispeed na živom streame): ring buffer 2 s, read pointer `rate` param s per-sample easing; interpolácia linear (stačí, FM-artefakty sú súčasťou šarmu).
- Params: `mode` (stop / spin / restart), `time` 0.1–8 s, `curve` (exp / lin / smooth), `direction` (fwd/rev spin), `mix` (dry/wet pre momentárne použitie), `retrigger` (gate/stepGate-style trigger neskôr).
- Momentárny charakter: tlačidlo v UI nastaví `engaged=1` a runtime easing spraví zvyšok (param `engaged` 0/1 — rovnaký pattern ako bypass).
- **Fallback bez workletu:** bypass (degraded) — nie je free DSP ekvivalent.
- **Runtime:** ~250 riadkov worklet DSP + param table + registry factory.

**Súbory:** `types.ts` (union), `registry.ts` (def+factory, category `movement`), `audio-worklets/tapestop-processor.js` + node wrapper + loader + build script, `presets.ts` („Turntable Stop 8th", „Slow Stop 4 bars", „Rev Spin"), browser-checks blok.

**Testy:** offline parity (rovnaký render dvakrát = bit-identický), easing priebeh (rate(t) monotónne), fallback degraded status, budget.

**Effort:** 1 deň. **Riziko:** nízke (izolovaný worklet, žiadna schema zmena okrem union id).

---

### 2.2 RING MODULATOR (`ringMod`)

**Prečo:** metalické/robotické percusie, RS-232 textúry na hi-hate — klasika, ktorá sa nedá dosiahnuť filtrom.

**Implementácia v1:** worklet `out = in × sin(2π·f·t)` (ring mod = násobenie; native GainNode s oscilátormi na gain param má DC-offset a krosstalk problémy — worklet je čistejší a lacnejší).
- Params: `frequency` 0.1–2000 Hz (log), `mix`, `feedback` (output späť do modulácie pre metallic ring).
- v2 (neskôr, oddelene): **Frequency Shifter** cez Hilbert allpass pair — single-sideband posun (neprelieva harmonické, „iný" zvuk než pitch shift).

**Súbory:** rovnaký checklist; category `movement`; presets („Steel Perc", „Robot Hat", „Arc Ring").

**Testy:** unity at carrier=0 mix=0 (passthrough), spektrálny sanity (sidebandy na f±carrier), clamp, budget.

**Effort:** pol dňa. **Riziko:** minimálne.

---

### 2.3 BASS MONO-MAKER (upgrade `utility`)

**Prečo:** klubový master štandard — pod zvolenou frekvenciou zmixovať mono (M/S side lowpass). Máme utility s M/S? — dostupné obežne cez `haasWidener`/`msEq` kusy, ale jeden otočný parameter „BASS MONO 120 Hz" na mastri je to, čo beatmaker skutočne použije.

**Implementácia:** **master-only upgrade** — do master chain (za tape, pred clipper) M/S split: `side` kanál cez lowpass(`bassMonoFreq` 60–400 Hz, default 120) → merge. Native Web Audio (splitter + biquad + merger), žiadny worklet.
- Params na MasterConfig: `bassMonoEnabled`, `bassMonoFreq`.
- UI: master strip prepínač + drag číslo (rovnaký pattern ako IN/CEIL).

**Súbory:** `AudioEngine.ts` (buildMaster), `schema.ts` (MasterConfig voliteľné polia + clamp), `TopBar`/Mixer UI, testy master-gain-staging.

**Effort:** pol dňa. **Riziko:** nízke (master chain sa mení pridávaním vetvy — pozor na offline parity, test je povinný).

---

## 3. FÁZA 2 — Staples (stredný efort, bežné reťazce)

### 3.1 PITCH SHIFTER / VOCAL CHOP FX (`pitchShift`)

**Prečo:** vocal chops a 808 posuny bez zmeny dĺžky — druhá najväčšia diera.

**Implementácia (dva stupne, jeden efekt):**
- **v1 — granulárny shifter (worklet):** dva prekrývajúce sa grain voices na kruhovom bufferi s modulovaným read-rate a krížovým fade (klasický real-time pitch shifter). Artifacts = charakter, pre FX prijateľné. Params: `semitones` ±12, `fine` ±50 centov, `grain` 20–120 ms, `mix`, `width` (dva nezávislé grain voices L/R).
- **v2 — formant mód:** recykluje `src/audio-engine/phase-vocoder.ts` (už máš phase-vocoder jadro z time-stretch!) — formant preserve pre vokály. Až po v1, oddelený parameter `formant` 0/1.
- **Offline parity:** povinný test — pitch shift musí byť deterministický (seedovaná fáza grainov z track id, pattern `hashString(track.id:pitch)` z texture synthe).

**Effort:** v1 2 dni (worklet + testy), v2 +2 dni. **Riziko:** stredné (latencia grainov ~grain size; dokumentovať).

### 3.2 MULTI-TAP DELAY (`multiTapDelay`)

**Prečo:** filly, call-and-response, ping-pong hy hi-hatu — jednoduchý delay+feedback nestačí.

**Implementácia: NATIVE Web Audio (žiadny worklet)** — 4× `DelayNode`+`Gain`+`StereoPanner` paralelne z inputu.
- Params: `taps` 1–4, per-tap `division` (1/16…1/1, sync — `syncBpm`), `gain`, `pan`; globálne `feedback`, `tone`, `mix`, `pingpong`.
- Data model: per-tap parametre ako ploché params (`tap1Div`, `tap1Gain`, …) — žiadne polia, žiadna schema zmena.

**Effort:** 1–1,5 dňa. **Riziko:** minimálne (najjednoduchší z celého plánu; syncBpm precedent hotový).

### 3.3 VINYL / LO-FI SUITE (`vinyl`) — HOTOVO (profesionálny suite, nie one-knob)

**Prečo:** lo-fi/phonk/boom-bap žánre; kúsky existujú (PRISM lofi modul, bitcrusher, tapeSat) — ale beatmaker chce jeden nástroj, ktorý vie aj rýchlo (AGE) aj hlboko (moduly).

**Implementácia (worklet) — finálna podoba:**
- **crackle**: Poisson-timed pop stream (nie fixná mriežka) — `crackle` (densita), `crackleTone` (400 Hz–9 kHz klik), `crackleDecay` (tight click ↔ dlhý chvost); každý pop pristane na jednom kanáli deterministicky.
- **hiss**: spojitý filtrovaný noise floor — `hiss` + `hissTone`.
- **rumble**: motor/turntable low-end — `rumble` + `rumbleTone` (30–120 Hz).
- **wow**: `wowRate` 0.2–4 Hz + `wow` hĺbka (až ~2 ms delay read).
- **flutter**: `flutterRate` 4–30 Hz + `flutter` hĺbka (~0.25 ms).
- **year**: 1920–2020 band-limit kontúra (LP 9 k→1.5 k, HP 120→820 Hz).
- **drive**: tube-ish saturácia (Padé tanh) mokrého signálu.
- **toneLp / toneHp**: master wet band trim.
- **width**: šírka mokrého signálu (0 = mono record).
- **amount**: AGE makro — škáluje artefaktové moduly (crackle/hiss/rumble/wow/flutter); drive/tone/year sú zámerné nastavenia, nie šum.
- **Stereo integrita**: všetky filtre per-kanálový stav, wow/flutter čítajú **proti sebe** (anti-phase wobble) — mokrý signál si drží (a vie rozšíriť) stereo obraz namiesto kolapsu do mona.
- Determinizmus: seed z projektu/track/instance (`env.seed`, fallback id hash), offline parity test povinný.
- **6 presetov**: 78 RPM Shellac, Dusty Lo-Fi, Club Clean, Tape Wobble, Phonk Crush, Radio 1930.
- **Editor**: prvá stránka MAIN = AGE + CRACKLE + HISS + WOW; modulové detaily na ďalších stránkach (využíva existujúci paging v EffectRacku).

**Effort:** 1,5–2 dni. **Riziko:** nízke-stredné. **Stav:** hotové vrátane testov (`tests/vinyl-suite.test.ts`, 9 testov: per-modul kontrola, tone/decay charakter, wow pohyb, drive boundy, year band-limit, width stereo, determinizmus, back-compat).

---

## 4. FÁZA 3 — Signatúrny kus

### 4.1 BEAT MANGLER (`beatMangler`) — Gross Beat štýl

**Prečo:** HALFTIME, scratch fill, repeat bridge, 2× speed — najrozpoznateľnejší beatmaking efekt dekády a najväčšia diera tohto DAW. stutter/pump/stepGate sú fragmenty; tento ich zjednotí pod jednu beat-synced obálku.

**Zvuková podstata (worklet):** kruhový buffer 1 bar (kapacita pre 300 BPM @ 48 kHz ≈ 2 s → 2-bar buffer), write beží vždy; read head číta podľa **priebežných obálok** normalizovaných na bar:
- `volumeSteps[]` — 16/32 krokov 0..1 (gain obálka),
- `pitchSteps[]` — 16/32 krokov ±24 st (read-rate multiplikátor),
- `playMode`: normal / **half** (read rate 0.5 = halftime) / **double** (2×) / **reverse**,
- `repeatFill` N (posledná 1/N bar sa repeatuje — fill bridge),
- `mix` (dry/wet pre A/B porovnanie).

**Data model (schema):** `EffectInstance` dostane voliteľné `volumeSteps?: number[]`, `pitchSteps?: number[]` — **rovnaký pattern ako `stepGate.steps`**, `normalizeEffects` ich sanitizuje (dĺžka 16/32, hodnoty clamp). Union id + regulácia ako zvyčajne.

**BPM sync:** runtime `syncBpm(bpm)` prepíše buffer window (precedent delay/pump); live scheduler aj offline renderer volajú tú istú cestu → parity.

**UI (dôležitá časť hodnoty):** editor obálok priamo v racku — precedent existuje: `fxeq` paint editor + `EnvEditor`. 16/32-step grid, dve vrstvy (VOL/TAG), drag kriviek, preset shelf („Halftime", „2× Fast", „Scratch In", „Fill 1/4", „Wobble 8th"). Fáza 3a: DSP + numeric params; **Fáza 3b: vizuálny editor** (sám o seba ≈ 1 deň, pattern hotový).

**Effort:** 3a DSP+params+testy 2–3 dni; 3b editor 1–1,5 dňa. **Riziko:** najvyššie z plánu (najzložitejší DSP, buffer-BPM sync, UI) — preto zámerne posledný. **Mitigácie:** worklet pattern z Kaskady, envelope data model zo stepGate, editor pattern z fxeq paint.

---

## 5. FÁZA 4 — Nice-to-have (podľa chuti / dát z používania)

| Položka | Podstata | Effort |
|---|---|---|
| **Vocoder** (`vocoder`) | filterbank 8–16 pásiem, modulator = vokálny track (sidechain-style routing z `sidechainTrackId` precedensu!), carrier = vlastný track; worklet | 3–4 dni |
| **Frequency Shifter** (Hilbert SSb) | rozšírenie ringMod v2 | 1 deň |
| **Reverse-swell FX** | live reverse envelope namiesto statického sampleu | 0,5 dňa |
| **Granular Freeze send** | texture engine zapuzdrený ako send-efekt | 1–2 dni |
| **Telephone preset pack** | SVF + distortion presety (žiadny kód) | 2 hodiny |

---

## 6. Sekvencia a milné kamene

```
FÁZA 1 (týždeň 1)
  tapeStop (1d) → ringMod (0,5d) → bassMono (0,5d) → sweep + commity
FÁZA 2 (týždeň 2–3)
  multiTapDelay (1,5d) → pitchShift v1 (2d) → vinyl (2d) → sweep
FÁZA 3 (týždeň 4–5)
  beatMangler 3a DSP (2–3d) → 3b editor (1,5d) → sweep + browser verifikácia
FÁZA 4 (podľa dát)
  vocoder → freqShifter → drobnosti
```

Každý efekt = samostatný commit (`feat(fx): <name> — <one-liner>`), každá fáza končí zeleným `npm run build` + browser suite.

---

## 7. QA politika pre každý nový efekt (povinné minimum)

1. **Unit:** factory vytvorí runtime, params clamp (NaN → default), `defaultParamsOf` konzistentný, fallback bez workletu = degraded (nie crash).
2. **Offline parity:** rovnaký projekt renderovaný dvakrát = bit-identický; tempo-sync efekty prežijú BPM zmenu cez `syncBpm`.
3. **Browser check** (`src/browser-checks.ts`): efekt v reálnom reťazci znie (peak nad noise floor), meter sa hýbe, determinizmus dvoch inštancií.
4. **Budget:** worklet + entry pod limitmi; bump len s komentárom (konvencia).
5. **Soak:** 30 s linka s efektom neleaku (node count stabilný) — pattern `tests/fx-node-dispose.test.ts`.

---

## 8. Riziká a mitigácie

| Riziko | Mitigácia |
|---|---|
| Core worklet budget (144/150 KB) | Tape stop/ring mod/vinyl sú malé (~2–4 KB každý); beatMangler ~6 KB — bump s komentárom, alebo rozdeliť bundle (rozhodnutie v čase fázy 3) |
| Latencia grain-based shiftu | Dokumentovaná (~grain size), mix default wet<1 |
| beatMangler BPM sync na hranici bar | Rovnaká seam-matematika ako scene-tempo v schedulery (piecewise map) — testy na seamoch povinné |
| Schema growth (políčka na EffectInstance) | `normalizeEffects` sanitizér + round-trip test (pattern stepGate) |
| Entry budget (registry je core) | Každý efekt ~3–8 KB; po fáze 2 zvážiť lazy registry chunk pre „MORE" efekty |

---

## 9. Explicitné NE-ciele

- **Nie** full Ableton Echo/Delay M4G (per-tap modulácie) — multiTap v1 drží jednoduchosť.
- **Nie** Spectral processing beyond Kaskada (Kaskada má svoj roadmap).
- **Nie** amp/cab simulácia pre gitary (nie je to beatmaking nástroj).
- **Nie**own reverb algorithm — Ozvena funguje a je golden-locked.

---

## 10. Definícia done (celý plán)

- 8 nových efektov v registry so presetmi a fallbackmi,
- offline-parity + browser checky pre všetky,
- beatMangler s vizuálnym editorom obálok,
- full suite zelený, build zelený, worklety pod budgetom,
- žiadna schema migrácia (všetko voliteľné polia s normalizáciou).
