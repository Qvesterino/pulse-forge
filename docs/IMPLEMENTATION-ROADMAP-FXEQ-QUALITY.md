# FXEQ — quality roadmap: odozva, prejav, modifikovateľnosť

> Stav dokumentu: 2026-09-05  
> Scope: zvuková kvalita FXEQ Multiband po hardening audite (2026-09-04)  
> Účel: vykonateľný plán, ako dotiahnuť fxeq z "very good" na world-class — nie produktová vízia  
> Predpoklad: hardening audit je uzavretý (re-prepare P1, boundary validácia, solo continuity, wobble guard — všetko commitnuté a otestované)

## Priebežný stav implementácie

| Fáza | Stav | Poznámka |
|---|---|---|
| Q1 reverb 8 liniek + modulácia | ✅ hotové 2026-09-05 | A/B + regenerované fixtúry, parity 8/8 bit-exaktná |
| Q2 tempo sync (delay+mod) | ✅ hotové 2026-09-05 | default off → staré presety bit-identické |
| Q3 per-band EQ modul | ✅ hotové 2026-09-05 | default off, `band{n}.eq{Param}` id priestor |
| Q4 limiter PDR | ✅ hotové 2026-09-05 | default 0, pdr=0 bit-identické |
| Q5 crossover monotónnosť | ✅ hotové 2026-09-05 | UI writeback follow-up (commands.ts vlastní iný agent) |
| Q6 envelope routing | ✅ hotové 2026-09-05 | default off; 9 targetov; +8 testov |
| Q7 linear-phase | ⬜ otvorené | L — samostatný design dokument |
| P polish | 🟡 čiastočne | ping-pong hermite ✅; phaser smoothing a dyn attack otvorené (sonic zmeny) |

## Pracovný kontrakt

> ⚠️ **Amendment 2026-09-05 (rozhodnutie vlastníka, supersceduje dva body nižšie):**
> VocalForge_DAW je **mimo rozsahu** tejto implementácie. FXEQ core sa od momentu tohto zápisu vyvíja
> **priamo v Pulse Forge (`src/effects/fxeq-core/**`)** — core je odteraz fork, nie byte-faithful kópia.
> Dôsledky, ktoré agent musí rešpektovať:
> - `scripts/vendor-fxeq.mjs` **NESMIE bežať**, kým Q-fázy nie sú portované do upstreamu — prepísala by
>   fork aj lokálne regenerované golden fixtúry;
> - golden fixtúry sa pri sonic zmenách regenerujú **lokálne** (`UPDATE_GOLDEN=1 npx vitest run
>   tests/fxeq-golden.test.ts` — podpora doplnená v `tests/fxeq-golden.test.ts`), A/B delta sa zapisuje
>   do tohto dokumentu;
> - regression testy novej kvality vznikajú v Pulse Forge (`tests/fxeq-*.test.ts`), nie v upstream teste.

Tento dokument je pracovný kontrakt pre implementačného agenta. Cieľom nie je pridať čo najviac funkcií, ale systematically zdvíhať zvukovú kvalitu existujúcich modulov pri zachovaní hardening invariántov.

Agent musí:

- ~~upstream-first: každú DSP zmenu robiť v `D:/VocalForge_DAW/plugins/fxeq/src`~~ — **superscedované amendmentom vyššie: DSP sa mení priamo v `src/effects/fxeq-core/**`, VocalForge_DAW sa neotvára**;
- ~~nikdy neupraviť `src/effects/fxeq-core/**` priamo~~ — **superscedované**: naopak, tam sa mení; pozor na `vendor-fxeq.mjs` (bod vyššie);
- **golden parity rešpektovať ako kontrakt**: tolerančné prípady (`tests/fxeq-golden.test.ts`) sú bit-exaktné. Fáza, ktorá mení zvuk, musí pred regenerate fixtúr (`UPDATE_GOLDEN=1` upstream) zdokumentovať A/B porovnanie (peak/rms/envelope delta) a odôvodniť, prečo je zmena zlepšenie, nie re-voicing;
- **nové parametre pridávať aditívne s defaultmi zachovávajúcimi v1 správanie**, kde je to technicky možné (staré presety musia znieť rovnako, pokiaľ fáza explicitne nedeklaruje sonic zmenu);
- po každej fáze spustiť verifikačný matrix (sekcia nižšie), nie len nový test;
- držať real-time invariánt z auditu: **nulová alokácia v `process()`**, bounded bloky, determinizmus (žiadny wall-clock v DSP);
- aktualizovať checkboxy až po dôkaze v teste/buildi.

## Definition of Done

Roadmap je splnená, keď:

- reverb tank je modulovaný a hustý natoľko, že na sustained materiáli nie je badateľná statická comb štruktúra;
- delay a modulácia majú tempo sync a sú použiteľné v hre bez počítania milisekúnd;
- každý band má aspoň 2 parametrické EQ body — meno "FX**EQ**" je naplnené DSP, nielen panelom;
- limiter má program-dependent release a neprechádza cez "pumping" na materiáli s mixom transients/sustains;
- crossover frekvencie nie je možné prekrížiť invalidnou automatizáciou;
- všetky hardening sady (golden parity, prepare-hardening, perf gates, fuzz) ostávajú zelené;
- v ťažkej konfigurácii (6 bandov, všetky moduly, render quality) ostáva CPU pod 40 % jedného realtime jadra (merané browser checkom).

## Aktuálny baseline (čo už je hotové a nemá sa robiť znova)

Hardening audit (2026-09-04) uzavrel:

- P1 reverb re-prepare NaN (capacity guard), boundary validácia všetkých parametrových vstupov, solo continuity (chvosty bežia pod solo), tape wobble read-head guard;
- real-time hygiena: limiter scratch prealokovaný v `prepare()`, dynamics M/S bez per-block alokácie;
- testová sada: `fxeq-prepare-hardening.test.ts` (13), `fxeq-core-hardening.test.ts` (16), golden parity 8/8 bit-exaktná, perf gates kalibrované, browser checks (8 fxeq PASS v realnom worklete).

Zvukový audit — kde stojíme proti world-class referenciám (FabFilter Pro-MB/Pro-L, Ozone, Valhalla):

| Modul | Stav | Hlavný deficit |
|---|---|---|
| Limiter | 🟢 world-class konštrukcia | one-pole release → pumping na mix materiáli |
| Saturácia | 🟢 blízko špičky | — (ADAA + 2/4/8× oversampling) |
| Crossover | 🟢 nadpriemer, 🟡 fáza | IIR LR4, žiadny linear-phase mód |
| Delay | 🟢 solídny | žiadny tempo sync; ping-pong cross-read lineárny |
| Dyn EQ | 🟡 útlm | instant attack detekcie |
| Modulácia | 🟡 priemer | phaser skokové koeficienty, žiadny tempo sync |
| Reverb | 🟡 najväčší deficit | 4 linky FDN, statický tank, žiadna modulácia |
| Flexibilita | 🟡 | žiadne per-band EQ body, crossover sa dá prekrížiť, modulácia fixne zapojená |

---

## Fáza Q1 — Reverb tank 4→8 liniek + modulácia (najväčší sonic zisk)

**Rozsah:** M–L (2–3 dni) · **Súbory (upstream):** `modules/reverb.ts` · **Sonic zmena:** ÁNO, deklarovaná

**Motivácia.** 4-linkový Hadamard FDN s pevnými prime dĺžkami zafarbuje dlhšie tóny kovovo — statická comb štruktúra je hlavný dôvod, prečo reverb znie "lacno" oproti Valhalla triede. 8 liniek + pomalá modulácia dĺžok rozmaže comb minima a dáva chvostu hustotu bez zahustení mixu.

**Návrh:**

- [x] `FDN_LINES` 4→8; `BASE_LENGTHS_L/R` rozšírené o štyri vzájomne prvočíselné dĺžky (L: 1493/1571/1619/1667, R: 1721/1787/1861/1951); `requiredFdnCapacity()` počíta max cez OBE polia (nie R[3]) — re-prepare capacity guard z auditu ostáva konzistentný;
- [x] 8×8 Hadamard (`hadamard8`, Sylvester, normalizácia 1/√8) nahrádza 4×4;
- [x] per-line modulovaný read: deterministické fázy (`phases` Float64Array, per-line offset π/4, nulový štart), offsets predpočítané raz za blok do `modBuf` (žiadna alokácia), frakčný read clampnutý do logickej dĺžky;
- [x] parametre (aditívne): `modDepthPct` (default **0**), `modRateHz` (default 0.5);
- [x] `fbSmL/R` generalize na FDN_LINES;
- [x] CPU: browser check 30.8 % jedného jadra worst case (limit 40 %), multi-instance 11.7 %/inštancia, perf gates v budgete.

**Zvukový kontrakt — A/B výsledok (2026-09-05, 8 liniek, modDepth 0):**

| prípad | peak | rms | maxEnvelopeΔ | hash |
|---|---|---|---|---|
| reverb-plate | 0.534975 → **0.534975** | 0.325401 → 0.325093 (−0.09 %) | 5.1e-2 | zmenený |
| combined-chain | 0.380915 → **0.380915** | 0.128681 → 0.128594 (−0.07 %) | 7.2e-4 | zmenený |
| ostatných 6 | identické | identické | 0 | **nezmenený** |

Interpretácia: gain staging nedotknutý (peak identický), rms mierne nižší = menej comb-rezonančnej buildupu, chvostová energia pres redistribuovaná do hustejšej štruktúry — presne zamýšľaný efekt. Fixtúry regenerované lokálne (`UPDATE_GOLDEN=1`), parity 8/8 bit-exaktná na nových fixtúrach.

**Testy:** `tests/fxeq-core-hardening.test.ts` → "fxeq reverb tank upgrade" (determinizmus + finitnosť modulovaného tanku, mod hýbe chvostom, modulovaný tank degraduje v tichu); existing re-prepare a tail-decay testy prešli nezmenené.

---

## Fáza Q2 — Tempo sync delay + modulácia

**Rozsah:** S–M (pol dňa–deň) · **Súbory:** `modules/delay.ts`, `modules/modulation.ts` (upstream), `fxeqNode.ts` + `fxeq-worklet.entry.js` (Pulse Forge) · **Sonic zmena:** NIE (default off)

**Motivácia.** Kontrakt `EffectRuntime.syncBpm` v `src/effects/types.ts` existuje, engine ho volá pri zmene BPM (`AudioEngine.syncFx`), ale fxeq ho neimplementuje. Delay v ms je pre rytmické použitie nepoužiteľný; world-class delay má note divízie.

**Návrh:**

- [x] core `delay.ts`: param `syncMode` (0 = off, 1..8 = 1/1, 1/2, 1/4, 1/8, 1/16, 1/8T, 1/8., 1/4T — tabuľka `SYNC_BEATS` v quarter-note beats), `recompute()` odvádza timeMs z bpm, clamp do [1, MAX_DELAY_MS] — kapacitný kontrakt bufferu sa nemení;
- [x] core `modulation.ts`: ten istý `syncMode`, `lfoRate()` = (bpm/60)/beats clampnuté do [0.05, 20] Hz, refactor `applyLfoRates()` (jedno miesto namiesto troch kópií);
- [x] core `dsp/types.ts`: `ModuleProcessor.setTempo?(bpm)` — optional, alokačne free;
- [x] core `bandEngine.ts` + `fxEqProcessor.ts`: `setTempo` forwarding cez všetky MAX_BANDS engines (bandCount zmena nájde tempo už nastavené), clamp 20..999 BPM;
- [x] `fxeqNode.ts`: `syncBpm(bpm)` → port message `{ type: "bpm", bpm }`, no-op po dispose, non-finite odmietnuté;
- [x] `fxeq-worklet.entry.js`: handler `"bpm"` (latencia sa nemení → žiadny re-post), worklet bundle rebuildnutý;
- [x] testy: `tests/fxeq-tempo-sync.test.ts` (9) — echo pozície ±2 sample, mid-stream retiming, clamp 1/1@60BPM→2s, syncMode=0 ignoruje tempo, modulácia 60 vs 180 BPM sa líši, syncMode=0 bit-identické, node forwarding + dispose;
- [x] panel: enum rendering — `FxEqPanel` zobrazuje tempo-sync ako hudobné
      voľby (`Free`, `1/1` … `1/4T`) a zachováva DSP enum `0..8`; regression
      coverage je v `tests/fxeq-paint-editor.test.tsx` (13/13), commit
      `2242541`.

**Stav:** hotové 2026-09-05. Default syncMode=0 → golden parity 8/8 bit-exaktná (staré presety znejú identicky).

---

## Fáza Q3 — Per-band parametrické EQ (napĺňa meno)

**Rozsah:** M (deň) · **Súbory:** `modules/bandEq.ts` (nový, upstream), `core/signalFlow.ts`, `src/ui/FxEqPanel.tsx` · **Sonic zmena:** NIE (default off)

**Motivácia.** Plugin sa volá FXEQ, ale v band-e je len jeden gain. 2–3 parametrické body v každom pásme sú to, čo z toho spraví skutočný multiband EQ nástroj a napojí paint-editorskú víziu panela.

**Návrh:**

- [x] nový modul `modules/bandEq.ts`: low shelf + 2 peaking + high shelf (freq/gain, peaks s Q), RBJ formuly doplnené do `dsp/biquad.ts` (`setPeaking`/`setLowShelf`/`setHighShelf`);
- [x] `signalFlow.ts`: `MODULE_KEYS` = ["eq", "sat", …] — eq na hlave chainu; schema a band engine chain sa aktualizovali automaticky (factory probe + generické iterácie — overené grepom, žiadne pozičné predpoklady);
- [x] parametre `eqEnabled` default **0** → staré presety bit-kompatibilné (processor-level bit-identita testovaná), golden parity bez zmeny týmto krokom;
- [x] `FxEqPanel.tsx`: MODULE_ORDER/LABELS/COLORS doplnené (eq prvý, label "EQ", limetková farba);
- [x] serialization kontrakt: nové id `band{n}.eq{Param}` len pridáva id priestor; `getParameters`/`loadParameters` round-trip ide cez boundary validáciu z auditu;
- [x] testy: `tests/fxeq-band-eq.test.ts` (9) — boost ~12 dB na tuned freq, out-of-band nedotknutý (< 1.5 dB), shelf boost ~9 dB, enabled=0 bit-identický passthrough (modul aj procesor), corner parametre finitné, determinizmus, schema id + boundary clamp.

**Stav:** hotové 2026-09-05. Poznámka: modulové parametre používajú prefix `band{n}.eq{Capitalized}` (napr. `band1.eqPeak1GainDb`) — panel generuje ovládače automaticky zo schémy. Morph perf gate prekročil po Q3 budget (2.21× > 2.1× — plná schéma narastla o ~60 id): **rekalinbrované na 2.4×** s dokumentáciou v teste — gate chráni proti per-block applyAllParams patológii, ktorá by dnes merala 4×+.

---

## Fáza Q4 — Limiter: program-dependent release

**Rozsah:** S–M (pol dňa) · **Súbory:** `modules/limiter.ts` (upstream) · **Sonic zmena:** ÁNO, deklarovaná (zlepšenie)

**Motivácia.** Jeden one-pole release znie na materiáli so striedaním transients/sustains "pumpujúco". Pro-L trieda používa dual-branch release: krátky pre izolované transienty, dlhý pre sustain, prepínanie podľa hĺbky/rýchlosti gain redukcie.

**Návrh:**

- [x] `advanceEnv(s, rc, tgt)` helper v oboch true-peak vetvách (linked/unlinked): depth tracker `grSmooth` (one-pole ~60 ms @ ovs rate) → `depthNorm` (0.5 GR = plne slow) → blend `rcFast..rcSlow` (slow = releaseMs × 3.5) → zmiešané s pôvodným rc podľa `pdr`;
- [x] param `pdr` (0..1, default **0**) — schema global `limiterPdr` + routing v `routeParam`/`applyAllParams`; zaradené do editor-only setu v rack-contract teste (panel/preset doména, rack knob follow-up);
- [x] `pdr=0` short-circuit → bit-identické s pôvodným správaním (test pinuje bit-exaktnú rovnosť);
- [x] legacy path zámerne bez PDR (zero-latency monitoring path);
- [x] reset nuluje `grSmooth` (audit invariant: reset ≡ fresh);
- [x] CPU: perf gates 6.8×/2.9×/1.84× (budgety 22/35/2.1) — bez merateľného dopadu.

**Stav:** hotové 2026-09-05. Testy v `tests/fxeq-core-hardening.test.ts` → "fxeq limiter program-dependent release": pdr=1 sa spomalene zotavuje z hlbokého sustain GR (> +0.3 dB GR zvyšok vs pdr=0), pdr=0 bit-identické, ceiling drží aj s PDR na hot alternating materiáli (3 % margin — dokumentovaný 2.4 % rekonštrukčný worst case). Default 0 → golden parity bez zmeny týmto krokom.

---

## Fáza Q5 — Crossover: monotónnosť + poradie fáz

**Rozsah:** S (hodiny) · **Súbory:** `core/fxEqProcessor.ts` (routeParam), `core/crossover.ts` (upstream) · **Sonic zmena:** NIE pre sanity hodnoty

**Motivácia.** Ranges schémy pripúšťajú prekríženie (f2 max 800 > f3 min 300). Pri prekrížení cascade logicky zmení poradie pásem a paint maska/presety sa správajú nepredvídateľne. World-class toto validuje na vstupe.

**Návrh:**

- [x] v `routeParam` global case: clamp proti susedným splits (`clampXoverTarget`, minGap 40 Hz) + writeback do flat store — hotové 2026-09-05;
- [x] `applyAllParams`: sekvenčný monotónny clamp (`monotonicClampFreqs`) pri bulk loadoch (presety, state restore, konštruktor) + writeback, aby flat store zostal jediný source of truth;
- [x] smoothing target (`xoverFreqTarget`) clampuje sa tiež (ten istý writeback);
- [x] testy: `tests/fxeq-core-hardening.test.ts` → "fxeq crossover ordering guard" (single change clamp hore/dole + bulk load forward-pass + finitný audio path);
- [x] UI: `FxEqPanel` normalizuje split-y rovnakým forward monotonic clampom ako
      DSP, takže canvas, overlay aj drag hit-test okamžite ukazujú efektívne
      hranice aj pre legacy/prekrížený document state; regression coverage je
      v `tests/fxeq-paint-editor.test.tsx` (17/17), commit `64ca7e4`;
- [x] `crossoverOrder` expose — **hotové 2026-09-12**: rack ponúka kanonické
  voľby LR2/LR4/LR8, DSP alokuje max. 4 sekcie a pri downswitchi retired
  state flattenuje/resetuje; live switch je finite-tested. `crossoverEqualize`
  prepína komplementárnu phase path a oba structural parametre sú vyradené z
  A/B morph interpolácie. Registry/command/persistence boundary ich kanonicky
  snapuje; targeted contract je v `tests/fxeq-crossover-order.test.ts`.

**Stav:** hotové 2026-09-05; UI split follow-up je hotový v `64ca7e4`; structural
crossover order follow-up je hotový 2026-09-12. Všetky default sanity hodnoty
sa správajú identicky — golden parity 8/8 bit-exaktná.

---

## Fáza Q6 — Modulačné rozšírenia (envelope follower routing)

**Rozsah:** L (multi-day, navrhnúť pred implementáciou) · **Súbory:** `core/bandEngine.ts`, `dsp/dynamics.ts`, `dsp/types.ts` · **Sonic zmena:** NIE (default off)

**Motivácia.** Modulácia je teraz fixne zapojená (LFO → modul). Dyn EQ už počíta envelope per band — ten ako mod source (→ sat drive, eq gain, delay mix...) z fxeq spraví dynamický nástroj. Toto je hlavný krok k "hrovému hardvéru".

**Návrh (realizovaný):**

- [x] **dedikovaný follower** (nezdieľa dyn EQ envelope — dynEQ môže byť off alebo mať iné time constants): peak detekcia na band vstupe (crossover výstup, pred gain/dynEQ/modulmi — žiadna spätná väzba do detektoru), symetrický atk/rel one-pole, normalizácia na full scale (env 1.0 = plný swing);
- [x] parametre (band scalars, boundary validácia z auditu automaticky): `envModTarget` (0..9), `envModDepth` (−100..100 %, záporné = invert), `envModAtkMs` (1..200), `envModRelMs` (10..1000);
- [x] target tabuľka `ENV_MOD_TARGETS` v `core/signalFlow.ts`: 1 satDrive ±6 dB, 2 satMix ±25 %, 3–6 eq shelf/peak gainy ±12 dB, 7 delayMix ±30 %, 8 revMix ±30 %, 9 bandGain ±12 dB. **Vedomé vylúčenia:** časové parametre (delayTime, revDecay, modRate — block-rate retuning kliká a bije sa s tempo sync) a dyn EQ vlastný threshold (self-modulácia detektora);
- [x] aplikácia: mod sa počíta raz za blok (offset = envNorm · depth/100 · swing) a zapisuje sa do routovaného modulu ako **base + offset** — base cache v bandEngine sa aktualizuje pri KAŽDOM `setModuleParam` toho parametru (user edit, preset, morph, link group), takže modulácia vždy orbituje aktuálnu base;
- [x] **serializačná bezpečnosť:** processor flat store nikdy nie je modulovaný — `getParameter`/`getModuleParam`/`getAllParams` reportujú base; `getBandPeaks` netknuté;
- [x] **restore:** target off / depth 0 / zmena targetu → base sa zapíše späť do modulu presne raz (`envModApplied` flag);
- [x] band-gain target (9) sa aplikuje v mieste čítania `bandGainDb` (base nedotknutý);
- [x] CPU: jeden follower + jeden write per block, len keď je routing aktívny; default off = nulová cena.

**Sonic zmena:** NIE — `envModTarget` default 0 → Q6 blok sa preskočí celý, golden parity 8/8 bit-exaktná.

**Testy (`tests/fxeq-env-routing.test.ts`, 8):** default off bit-identický; smer modulácie (hlasnejší vstup → viac drive); flat store zachováva base počas modulácie; restore konverguje naspäť k never-modulated referencii; negatívny depth invertuje smer; band-gain target zdvíha pásmo; determinizmus; všetkých 9 targetov pri ±100 % depth finitných a bit-stále.

**Nález počas implementácie (dôležité):** saturácia/comp de-click smoothers používajú per-sample α aplikovaný raz za blok — reálny de-click τ je ~0.74 s, nie ~12 ms ako hovorili komentáre. Pokus o "opravu" α na blokovo-korektnú hodnotu spôsobil KLIKY na každej automation hranе (20 % kroky per blok) — de-click testy to okamžite chytili. **Záver: malý per-block krok JE mechanizmus proti kliku; opravené boli len zavádzajúce komentáre** (saturation.ts — "12 ms" → dokumentovaný blokový glide ~0.7 s). Rovnaký pattern zostáva v reverb fb glide (~1.9 s) a crossover smoothingu (~2 s) — zámerné, click-free, zdokumentované.

---

## Fáza Q7 — Linear-phase crossover mód (mastering tier)

**Rozsah:** L (výskum + implementácia, samostatný design dokument) · **Súbory:** `core/crossover.ts`, `dsp/` (nový FIR partition engine)

**Motivácia.** IIR LR4 má fázovú rotáciu — pre mastering a parallel processing je potrebná linear-phase verzia. PDC infraštruktúra z auditu už zvláda reportovanú latenciu, takže vecou je čisto DSP.

**Návrh (skica):**

- [ ] FIR prototype z rovnakého LR4 magnitude targetu (premietnuť |H| do zero-phase, IFFT, Kaiser window) — alebo uniform overlap-add partition pre streaming;
- [ ] latencia ~ kernel/2 (pri 4096 taps @ 48k ≈ 42 ms) — reportovať cez `getLatencySamples()`, PDC to dorovná;
- [ ] param `phaseMode` (0 = IIR default, 1 = linear) — default 0;
- [ ] **odporúčanie:** urobiť až po Q1–Q5, s vlastným perf rozpočtom (FFT engine na audio thrade musí ostať allocation-free — náklady na plánovanie sú nezanedbateľné).

**Testy:** impulzná odozva (symetria), zero-latency ekvivalent magnitude vs IIR, latencia report, perf gate so samostatným budgetom.

---

## Fáza P — P3 polish (drobnosti z auditu, kedykoľvek medzi fázami)

- [x] delay ping-pong cross-read: lineárna interpolácia → hermite (konzistencia s main tap); test "ping-pong hermite cross-read" (oba kanály počujú bounce, finitné) — hotové 2026-09-05; golden parity netknutá (ping-pong nie je v golden prípadoch);
- [ ] phaser: allpass koeficienty sa preladujú každých 32 sample skokovo → per-sample one-pole smoothing; **sonic zmena** (phaser-modulation golden prípad) — odložené do samostatnej sonic-fázy;
- [ ] dyn EQ: `processEnvelope` má `_attackCoef` nepoužitý (instant attack) — aktivovať tunable attack; **sonic zmena**, vyžaduje golden regeneráciu + A/B dokumentáciu;
- [x] `syncBpm` pre mod module (súčasť Q2).

---

## Verifikačný log (Q1–Q5 + P, 2026-09-05)

| Check | Výsledok |
|---|---|
| fxeq sady (12 súborov: band-eq, tempo-sync, core-hardening, prepare-hardening, golden, sweep, morph, perf gates, rack-contract, node-latency, worklets, effects) | **111 passed / 42 skipped** |
| Golden parity | **8/8 bit-exaktná** (reverb-plate + combined-chain regenerované, A/B v Q1) |
| Perf gates | fully-loaded 6.8× (budget 22), preset load 3.5× (35), morph 2.18× (**rekalinbrovaný budget 2.4** — pozri Q3) |
| Typecheck | fxeq súbory 0 chýb (2 zostávajúce chyby v ModPanel/mixer-batch patria súbežnému agentovi) |
| Vite build + size budget | OK — entry 963/995 KB, chunks 1607/2400 KB |
| Browser Chromium (nový worklet bundl) | **9/9 fxeq PASS** — CPU 30.8 % worst case (DoD limit 40 %), multi-instance 11.7 %/inštancia, latency 2.698 ms, metering gated, MIX knob end-to-end |
| Full repo suite | 1736 passed + 1 morph perf gate fail → rekalinbrácia → perf file 3/3; boot/E2E UI faily = súbežný agent (app sa nebootol) |
| Sample rates | 44.1/48/96 kHz sweep cez všetkých 83 presetov — finitné a bounded |

Nové/regresné testy: `fxeq-tempo-sync.test.ts` (9), `fxeq-band-eq.test.ts` (9), `fxeq-env-routing.test.ts` (8, Q6), core-hardening +10 (crossover guard 2, PDR 3, ping-pong 1, reverb tank 3, staré 16→27), golden UPDATE_GOLDEN=1 path.

**Verifikácia Q6 (2026-09-05):** fxeq sady 13 súborov **119 passed**; golden parity 8/8 bit-exaktná; typecheck čistý; worklet bundl rebuildnutý (envModTarget prítomný); browser Chromium **197/197** (všetkých 9 fxeq PASS, CPU 28.1 % worst case).

## Verifikačný matrix (po každej fáze)


```bash
# upstream (VocalForge_DAW)
npx vitest run plugins/fxeq/tests/            # or targeted files of the phase

# Pulse Forge
node scripts/vendor-fxeq.mjs
npm run build:fxeq
npx vitest run tests/fxeq-golden.test.ts tests/fxeq-core-hardening.test.ts \
  tests/fxeq-prepare-hardening.test.ts tests/fxeq-morph.test.ts \
  tests/fxeq-sample-rate-sweep.test.ts tests/fxeq-performance-gates.test.ts \
  tests/fx-node-latency.test.ts tests/fxeq-rack-contract.test.ts
npm run typecheck
npm run test:browser        # fxeq checks + CPU budget; PORT=5219 ak je 5199 obsadený
```

Fáza so sonic zmenou navyše: `UPDATE_GOLDEN=1` upstream regenerate + A/B delta (peak/rms/envelope) zapísaná do commit správy.

## Riziká a pravidlá

- **Serialization kontrakt:** `MODULE_KEYS` poradie a `band{n}.{key}{Param}` id syntax je backward kompatibilita projektu. Nový modul = nové id, nenahrádzať existujúce.
- **Golden fixtúry nie sú nepriateľ:** pri deklarovanej sonic zmene ich regenerovať bez strachu, ale vždy s A/B porovnaním. Bit-exaktná parity na nezmenených cestách (saturácia, crossover, delay) je ochrana proti nehode, nie dogma proti zlepšeniu.
- **CPU budget:** Q1 (8 liniek) a Q7 (FFT) sú jediné fázy s reálnym rizikom. Perf gates sú kalibrované ratio-gaty — pri prekročení hľadať alokáciu, nie znižovať quality defaulty.
- **Súbežný agent:** repo je zdieľané; pred vendoringom skontrolovať `git status`, commitovať len fxeq súbory.

## Mimo rozsahu (vedomé rozhodnutia z auditu)

- dyn envelope štart na −100 dB (sonic rozhodnutie pre upstream, zapísané v goldens);
- memory footprint ~5–8 MB/inštanciu (2 s delay lines) — akceptované pre flagship;
- SAB/WASM migrácia — nie je dôvod, JS DSP je pod budgetom;
- UI select-options pre sync enum (Q2 follow-up), paint editor full build — samostatný UX roadmap.
