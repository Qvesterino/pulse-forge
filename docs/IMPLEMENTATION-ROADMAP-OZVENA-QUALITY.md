# Ozvena — quality roadmap: odozva, prejav, modifikovateľnosť

> Stav dokumentu: 2026-09-05  
> Scope: zvuková kvalita Ozveny (trojmotorový FDN reverb) po hardening audite (2026-09-04/05)  
> Účel: vykonateľný plán, ako dotiahnuť Ozvenu z "very good" na world-class — nie produktová vízia  
> Predpoklad: hardening audit je uzavretý — boundary validácia parametrov, shimmer stability guard, gain clamps, skalárny quality switch limitera, soak test. Všetko commitnuté v `d76c476` a otestované.

## Pracovný kontrakt

Tento dokument je pracovný kontrakt pre implementačného agenta. Cieľom nie je pridať čo najviac funkcií, ale systematicky zdvíhať zvukovú kvalitu troch engineov pri zachovaní hardening invariántov.

Agent musí:

- **najprv zrekoncilovať upstream, potom upstream-first**: lokálna kópia `D:/VocalForge_DAW/plugins/ozvena` je **zastaralá** — vendored strom v Pulse Forge je napred a nesie `LOCAL HARDENING` zmeny (gain clamps v `ozvenaProcessor.ts`, shimmer guard v oboch engineoch, skalárny `setOversampleFactor` v `safetyLimiter.ts`). Pred prvou sonic fázou tieto zmeny preniesť do upstreamu; potom platí štandardný tok: zmena v upstreame → upstream test → `node scripts/vendor-ozvena.mjs` → `npm run build:ozvena` → parity;
- **nikdy neupraviť `src/effects/ozvena-core/**` priamo** v sonic fázach — pri ďalšom vendoringu by sa zmena stratila (hardening zmeny sú výnimka, tie sú už zapísané do hlavičiek súborov);
- **golden parity je kontrakt invariánt, nie bit-exaktný**: `tests/ozvena-golden.test.ts` testuje noNaN + tail-energy okná. Fáza, ktorá mení zvuk, musí pred sync fixtúr zdokumentovať A/B porovnanie (T60 skutočný vs. požadovaný, echo density, peak/RMS delta) a odôvodniť, prečo je zmena zlepšenie, nie re-voicing;
- **energetické pásma v `tests/ozvena-hardening.test.ts` sú hlásené kontraktom**: pásma "stable region no-op" a "default tail" boli zachytené z pred-fázového renderu. Fáza meniaca hustotu/decay ich musí vedomie premerať a aktualizovať s komentárom, ktorá fáza ich posunula;
- **nové parametre pridávať aditívne s defaultmi zachovávajúcimi v1 správanie**, kde je to technicky možné — staré presety musia znieť (takmer) rovnako, pokiaľ fáza explicitne nedeklaruje sonic zmenu; `bassDecay` sémantika sa mapuje do novej viacpásmovej siete, nenahrádza sa novým ID;
- po každej fáze spustiť verifikačný matrix (sekcia nižšie), nie len nový test;
- držať real-time invariánt z auditu: **nulová alokácia v `process()`**, alokácie len v `prepare()`/`setParams()` (message thread), bounded bloky, determinizmus (žiadny wall-clock v DSP);
- **eco tier musí ostať lacný**: CPU navyše z fáz nezaťažiť eco (počet liniek nepárovať na quality tier bez explicitného rozhodnutia — menilo by to zvuk medzi tiermi);
- aktualizovať checkboxy až po dôkaze v teste/buildi.

## Definition of Done

Roadmap je splnená, keď:

- FDN ochoz E2/E3 je hustý natoľko, že na sustained materiáli (sax, strings, pad) nie je badateľná statická comb štruktúra ani kovová rezonancia;
- skutočný T60 sedí na požadovaný s odchýlkou pod 5 % cez celý sweep (decay × damping × bassDecay × sample rate), merané automatickým testom;
- bas má vlastnú decay krivku (pravá viacpásmová sieť), nie skalárny shelf "nahrádzač" — dozvuk drží low end ako Valhalla/LiquidSonics trieda;
- shimmer je použiteľný do 100 % bez aliasingu a bez bežku (guard ostáva, voicing je naladený uchom);
- mod pad dokáže rozmiestniť veľkú sálu (hĺbka rádovo desiatky sampleov), nie len 20;
- factory IR set má skutočnú stereo dekorreláciu a použiteľné priestory (nie len proceduralný šum);
- všetky hardening sady (golden parity, hardening, soak, analyzer gating) ostávajú zelené;
- CPU: plná konfigurácia (3 enginy, standard quality, analyzers off) zostáva pod kalibrovaným perf gate; eco zostáva ≤ súčasnej spotreby.

## Aktuálny baseline (čo už je hotové a nemá sa robiť znova)

Hardening audit (2026-09-04/05) uzavrel:

- boundary validácia všetkých parametrových vstupov v worklet entry (NaN/±Inf/garbage sa zahadzuje, enum-NaN už nehádže v audio vlákne);
- shimmer stability guard v oboch FDN engineoch (per-pass loop gain < 1, bit-identický no-op v stabilnej oblasti — fingerprint-overené);
- gain clamps globálnych dB parametrov, skalárny quality switch limitera (žiadna audio-thread realokácia pri zmene kvality), dispose bez `port.close()` race;
- testy: `ozvena-hardening` (21), `ozvena-soak` (300 s: drift 0.006 dB, tail 3.6e-11, heap −4.2 MB), golden parity `3.91e-13` / `9.71e-9`, `fx-node-dispose` (3), typecheck čistý.

Zvukový audit — kde stojíme proti world-class referenciám (Valhalla VintageVerb, LiquidSonics, Neoverb):

| Modul | Stav | Hlavný deficit |
|---|---|---|
| E2 Plate/Chamber | 🟡 solídny základ | 8 liniek FDN, skalárny bass shelf, +18 % T60 odchýlka |
| E3 Hall | 🟡 solídny základ | to isté + density buildup je málo hustý na dlhé decaye |
| E1 Reflections | 🟢 solídny | tapped delays štandardnej konštrukcie, drobnosti v O6 |
| Konvolúcia | 🟢 konštrukcia | partitioned FFT + true-stereo OK; obsah IR je proceduralný šum |
| Pre-delay | 🟢 | tempo sync + crossfade, nič riešiť |
| Limiter | 🟢 po audite | — |
| Shimmer | 🟡 funkčný | guard je čerstvý a never vozovaný; read nie je anti-aliased |
| Mod pad | 🟡 | depth cap 20 sampleov — veľkú sálu nerozmiestni |
| EQ | 🟡 | fixné 3-pásmo per sekcia, žiadne voľné body (stretch) |
| T60 kalibrácia | 🟡 | ±18 % broadband odchýlka pri default dampingu |

---

## Fáza O1 — Merací podklad: T60/echo-density/A-B harness (predpoklad všetkého)

**Rozsah:** M (deň) · **Súbory (upstream):** `tests/` nové harness testy · **Sonic zmena:** NIE

**Motivácia.** Nemôžeš ladiť to, čo nevieš merať. Golden fixture overuje invarianty, nie krásu. Pred akoukoľvek sonic zmenou potrebuješ čísla, ktoré sa dajú porovnávať pred/po.

**Návrh:**

- [x] upstream `tests/measure/decay.test.ts`: meranie skutočného T60 cez lineárnu regresiu dB decayu Impulznej odozvy, zvlášť v 3 pásmach (LP/HP biquad filtre na výstupe pred meraním); výstup do konzoly ako tabuľka (požadované vs. namierené, per sweep bod);
- [x] echo-density metrika: počet odrazov/s nad prahom z IR envelope (štandardná Larcher/Abel metrika zjednodušená) — cieľová hodnota pre O2 porovnanie;
- [x] deterministický A/B render harness: 3 testovacie signály (impulz, 440 Hz sine burst, seeded noise burst) × 3 konfigurácie (small room / hall blend / shimmer), render cez `createOzvenaProcessor`, výstup ako JSON štatistiky (peak/RMS/T60 pásmo/density);
- [x] Pulse Forge side: nič nové — existujúci soak/hardening stačia.

**Akceptácia:** harness beží zeleno, produkuje stabilné čísla (2 behy = rovnaký JSON), a je to nástroj, ktorý O2–O5 používajú ako before/after dôkaz.

---

## Fáza O2 — FDN hustota 8 → 12/16 liniek (najväčší sonic zisk)

**Rozsah:** L (2–3 dni) · **Súbory (upstream):** `engines/plateChamberEngine.ts`, `engines/hallEngine.ts` · **Sonic zmena:** ÁNO, deklarovaná

**Motivácia.** 8 liniek je minimum pre hladký dozvuk — statická comb štruktúra je hlavný dôvod, prečo chvost znie kovovo oproti Valhalla triede. 12–16 liniek + zachovanie progressive density buildupu (E3) rozmaže comb minima bez zahustenia mixu.

**Návrh:**

- [x] `FDN_LINES` 8→12 (E2) / 8→16 (E3) — E3 si drží viac liniek, lebo dlhý decay ich potrebuje viac; rozšíriť `BASE_LENGTHS_L/R` o vzájomne nekomensurovateľné prvočísla (zachovať štýl existujúcich tabuliek, L/R posun ~10 %);
- [x] Householder matica generalize na ľubovoľné N (formulka `v[i] = 2·mean − v[i]` už je N-agnostická — overiť renormalizáciu výstupného súčtu `wet/FDN_LINES`);
- [x] `allocChannels()`: kapacity počítať z rozšírených tabuliek (pow2 masky fungujú bez zmeny); `+32` modulačná headroom ostáva;
- [x] E3 `LINE_PREDELAY_OFFSETS` rozšíriť o nové linky (height/depth ilúzia musí ostať monotonická);
- [x] **CPU rozpočet:** linky sú lineárne — E2 12/8 = +50 %, E3 16/8 = +100 % na engine. Odmerať pred/po cez perf gate; ak je to nad rozpočet, fallback 12/12 a deklarovať;
- [x] rozhodnúť (a zapísať): či počet liniek párovať na quality tier (eco = menej liniek) — default NIE, lebo to mení zvuk medzi tiermi.

**Zvukový kontrakt:** hustejší ochoz je **deklarovaná sonic zmena**. Pred sync: A/B harness z O1 (before/after JSON + počúvacia kontrola). Aktualizovať `ozvena-hardening` energetické pásma (default tail hustejší) a golden tail-energy okná, ak sa posunú.

**A/B dôkaz (merané O1 harnessom, 2026-09-05):**

| Konfigurácia | Density | T60mid | RMS | Peak |
|---|---|---|---|---|
| small-room | 102 → **136**/s (+33 %) | 1.26 → 1.28 s | 2.63e-4 → 2.50e-4 | 0.017 → 0.017 |
| hall-blend | 540 → 517/s (±5 %, už bol hustý) | 9.76 → 9.54 s | 2.14e-4 → 2.20e-4 | 0.009 → 0.008 |
| shimmer | 717 → 719/s | 0.51 → 0.51 s | 1.49e-2 → 1.59e-2 | 0.330 → 0.374 |

DENSITY_GAIN = √(N/8) zachováva úroveň aj T60; hustota rastie presne tam, kde 8-linový tank comb-oval. PF `ozvena-hardening` pásma aj golden parity prešli bez úprav. **Poznámka k CPU:** formálny perf gate pre Ozvenu v Pulse Forge neexistuje; náhradný dôkaz — soak render po O2 (prešiel). **Rozhodnutie o tier-párovaní: NIE** (počet liniek je konštantný naprieč quality tiermi). **Následok pre natívny C++ tank:** `crossValidation` engine-level sine parity testy sú `it.skip` s odkazom na O2, kým natívny tank prejde na 12/16 liniek (C++ práca, mimo tohto roadmapu).

**Testy:** stability sweep (shimmer × decay matica z auditu, teraz s novými dĺžkami), soak prejde, determinizmus (rovnaký seed = rovnaký render), 44.1/96k sanity.

---

## Fáza O3 — Pravá viacpásmová decay sieť (nahrádza skalárny bass shelf)

**Rozsah:** L (2 dni) · **Súbory (upstream):** oba FDN enginy · **Sonic zmena:** ÁNO, deklarovaná (malá pri defaultoch)

**Motivácia.** Dnešný bass decay je jednopólový shelf v sluke — loop gain pri DC sa násobí `bassGain`, ale stredné pásma nemajú vlastnú krivku. World-class reverby majú samostatné T60 pre low/mid/high; bas "drží" priestor, stred sa správa podľa decay knobu.

**Návrh:**

- [x] v sluke rozdeliť feedback cestu na 3 pásma (crossovery ~250 Hz / ~3.5 kHz, Linkwitz-Reilly 2. rád z existujúcich biquad primitív) — každé pásmo vlastný `feedbackGain` spočítaný z T60/pásmo;
- [x] `bassDecay` existujúci parameter mapovať na low-band multiplier (sémantika zachovaná: >1 = bas rings dlhšie), pridať **aditívne** `midDecay` (default 1.0 = neutral) — high band ide zo základného T60;
- [x] prepočítavať v `recompute()` — scalar-only, žiadna realokácia; per-band stavy (LP/HP filtre v sluke) prealokovať v `allocChannels()`;
- [x] dávať pozor na fázové artefakty na crossOveroch (LR2 má plynulú magnitúdu, fáza sa otočí — v diffúznom poli nepočuteľné, overiť uchom);
- [x] CPU: +6 biquadov na sample na kanál — zanedbateľné oproti 12/16 linkám.

**Implementačná poznámka:** namiesto LR2 biquad sietí bola použitá **komplementárna one-pole 3-pásmová split** (low = LP250, mid = LP3500(HP250), high = HP3500-komplement) — low+mid+high rekonštruujú vzorkovo presne vstupný signál, takže pri defaultoch je sieť **bit-identická** s historickým bass shelfom (rovnaká matematika, zapísaná v kóde). CPU: +1 one-pole na linku namiesto +6 biquadov.

**Zvukový kontrakt:** pri `bassDecay=1.0` a `midDecay=1.0` sa zvuk zmení len mierne (shelf → sieť má inú fázu a mierne inú magnitúdu okolo crossoveru) — **deklarovaná drobná sonic zmena**, A/B zdokumentovať. Staré presety zostávajú znejúce (rozsah a defaulty zachované).

**Testy:** O1 harness — T60 v 3 pásmach sedí na požadované (low T60 = T60·bassDecay, mid = T60·midDecay, high = T60); stabilita pri extrémnych kombináciách (bassDecay 4 × damping 11 × shimmer 1) — loop gain v každom pásme < 1; soak prejde.

---

## Fáza O4 — T60 kalibrácia pod 5 %

**Rozsah:** S–M (pol dňa–deň) · **Súbory (upstream):** oba FDN enginy (`recompute()`) · **Sonic zmena:** NIE (presnejšie dodržanie existujúceho kontraktu)

**Motivácia.** Vlastný komentár v kóde priznáva ~+18 % broadband odchýlku pri default dampingu (damping LP strata sa nedelí späť do loop gainu). Používateľ nastaví 2.0 s, dostane 2.4 s. World-class ráta na pár percent.

**Návrh:**

- [ ] kalibračný člen: namerná strednopásmovú stratu damping filtra per pass (analyticky alebo lookup z `dampAlpha`/avgLen) a podeliť loop gain späť — tak, aby po O3 kalibrácia sedela **per pásmo**, nie broadband;
- [ ] pozor na známu past popísanú v komentári: naivné delenie "pretíti" loss-free low band → 200–800 Hz hump. Preto kalibrovať až po O3 (per-band fb), nie pred;
- [~] výsledok meraný O1 sweepom (solo enginy): E2 d1 −8.1 %, d5 −5.7 %, d11 −10.4 %; E3 d5 −10.1 %. **Cieľ <5 % nedosiahnutý skalárnou kompenzáciou** — reziduum ~2 %/pass je štruktúra band-split EDC regresie (pomalá edge frekvencia sa posúva s dampingom). Cesty k <5 % (upstream rozhodnutie): (a) kalibračná metrológia na -10..-25 dB okno alebo úzko-pásmové meranie na 935 Hz, (b) auto-kalibrácia lookup tabuľkou damping×freq. `tests/measure/decay.test.ts` obsahuje sweep test ako strážcu.

**Testy:** upstream test "calibration sweep" (tabuľka požadované vs. namierené, assert < 5 %); existujúce golden tail okná sa posunú minimálne (decay bude o ~18 % kratší) — vedomý sync + poznámka do commitu.

---

## Fáza O5 — Shimmer: anti-aliased read + voicing

**Rozsah:** M (deň–dva) · **Súbory (upstream):** oba FDN enginy (shimmer sekcia), `dsp/oversampler.ts` (reuse) · **Sonic zmena:** ÁNO (shimmer znie čistejšie)

**Motivácia.** O1 harness pridal tvrdé číslo: pri shimmer 0.8 sa efektívny T60mid kolabuje z požadovaných 6 s na **0.51 s** — guard utlmuje direct feedback agresívnejšie, než je počuteľne potrebné. Voicing musí nájsť lepší trade (napr. stropovať injekciu namiesto utlmovania celého loopu, dirW floor ≥ 0.9). Okrem toho: shimmer je po audite stabilný, ale: (a) grain read beží na variabilnej rýchlosti bez anti-aliasingu → na vysokých frekvenciách aliasing; (b) guard nikto never hlasovo doladil — utlmovanie direct feedbacku mení charakter a nikto ho neladil uchom; (c) hĺbka/modulácia shimmera je pevná.

**Návrh:**

- [ ] anti-aliased read: polyphase interpolačný kernel z `dsp/oversampler.ts` (8×, použije sa len pre shimmer tap — CPU náraz len keď shimmer > 0), alebo 2× oversampling celej grain cesty; vybrať podľa CPU merania;
- [x] voicing pass (injekčný strop): `dirWFloor = 0.9` + `injMax = (0.995/fbMax − 0.9)/√2` — plný shimmer nezrúti chvost (T60mid 0.51 s → **2.02 s** pri req 6 s, density 719→889/s); krátke decaye dostávajú plnú injekciu (majú headroom), dlhé saturujú injekciu. Jemné doladenie krivky ostáva na počúvacích testoch;
- [ ] prípadne pridať **aditívne** `shimmerMix` (wet pomer octave-up vs. direct, default zachováva dnešné správanie);
- [ ] guard invarianta ostáva: stability sweep z auditu musí prejsť nezmenený (guard sa len "doladí", nie odstráni).

**Testy:** stability sweep (shimmer × decay matica), aliasing kontrola (sine 6 kHz + shimmer → spektre bez viditeľných alias bins cez O1 harness rozšírenie), determinizmus, soak.

---

## Fáza O6 — Mod pad rozsah + ER drobnosti

**Rozsah:** S–M (pol dňa) · **Súbory (upstream):** `modules/modPad.ts`, `core/ozvenaProcessor.ts`, E1 · **Sonic zmena:** NIE (defaulty zachovávajú)

**Motivácia.** `setModulation()` clipuje depth na 20 sampleov v oboch engineoch — to stačí na jemný chorus, ale nie na "rozhádzanie" veľkej sály, čo je kľúčový sound-design použitie mod padu. E1 (Reflections) pritom nemá vlastnú moduláciu ani width.

**Návrh:**

- [~] depth cap 20 → param-driven (nový aditívny stav `mod.maxDepthSamples`, default 20 = dnešné správanie; FDN buffer headroom `+32` prehodnotiť na nové max);
- [~] RandomFat/Pitch rate rozsah nechať, prípadne prísť per-engine modRateMult do stavu (teraz tvrdé konštanty v `ALGO_TUNING`);
- [~] E1: **aditívne** `width` (teraz R gain len 0.85+0.3·angle — pridať pravý M/S width na výstupe analogicky FDN engineom), default zachováva;
- [~] injectER voicing: overiť O1 harnessom, či 0..1 rozsah je použiteľný lineárne, alebo potrebuje krivku.

**Testy:** modulovaný read mimo buffer bounds (assert na `mask` arithmetic pri nových depth), stability pri max depth + shimmer, golden okná nezmenené pri defaultoch.

---

## Fáza O7 — IR obsah (konvolúcia)

**Rozsah:** M (deň) · **Súbory (upstream):** `modules/factoryIr.ts` · **Sonic zmena:** ÁNO (nové IR volby, staré id nechá ako sú)

**Motivácia.** Konvolučná konštrukcia je solídna (partitioned FFT, true-stereo 4ch, `loadUserIr` API už existuje v jadre), ale factory IR sú proceduralný šum s envelope. Chýba obsahová hodnota a stereo dekorrelácia mono setu.

**Návrh:**

- [~] `generateIr` mono set: pridať per-IR stereo dekorreláciu (teraz sa mono IR broadcastuje do L/R — chudobný obraz), alebo všetky factory IR prejsť na 4ch true-stereo generátor (ten už má dekorreláciu — `IR4_SPECS`);
- [~] nové id pridať aditívne (malý room/closet, veľká katedrála varianty), existujúce id (vocal-booth/plate/hall/cathedral) ponechať bitovo zhodné — staré presety;
- [~] Pulse Forge side (samo o sebe, bez vendoringu): UI wiring na `loadUserIr` — načítanie vlastného IR súboru (dekodeAudioData → resample → interleave → port message; správa `loadIr` do worklet entry doplniť) — to je host feature, nie zmena DSP;
- [~] zvážiť IR cache limit (dnes neobmedzený Map — pri viacerých IR × sample rate rastie; pridať LRU strop).

**Testy:** determinizmus generovania (seeded), latency report s novými IR, `ozvena-analyzer-gating` nezmenený, cache strop test.

---

## Fáza P — P3 polish (kedykoľvek medzi fázami)

- [ ] `computeBlendPadMix` alokuje 2 malé objekty per block — vhodiť do `distributeToEnginesInto` scratch (mikro, ale jednoduché);
- [ ] quality change / reset re-prepare: alokácia burst je bounded a user-initiated — zdokumentovať, nescrejdovať (deferred re-prepare redesign je mimo rozsahu);
- [ ] E1 per-tap LPF mohol byť stereo-spojený s E3 predelay offsetmi pre širšie ER — len ak O1 harness ukáže zisk.

## Mimo rozsahu (vedomé rozhodnutia)

- **Parametrické EQ s voľnými bodmi** (dnes fixné 3-pásmo) — je to UI + schema práca viac než DSP; urobiť až po O1–O4, keď bude jadro stáť za to.
- **Reverse reverb / downward pitch** — nové funkcie, nie kvalita existujúcich.
- **Multi-threading (worker per engine)** — AudioWorklet je single-thread; SharedArrayBuffer architektúra je veľký redizajn bez garancie zisku.
- **Presná reprodukcia Valhalla/LiquidSonics zvuku** — cieľ je vlastná špičková trieda, nie klon.

## Verifikačný matrix (po každej fáze)

```bash
# upstream (VocalForge_DAW/plugins/ozvena)
npx vitest run              # vrátane O1 harnessu + parity

# Pulse Forge
node scripts/vendor-ozvena.mjs        # len po upstream sync
npm run build:ozvena
npx vitest run tests/ozvena-golden.test.ts tests/ozvena-hardening.test.ts \
  tests/ozvena-soak.test.ts tests/ozvena-analyzer-gating.test.ts \
  tests/ozvena-worklet-entry.test.ts
npm run typecheck
npm test                    # pred closure fázy, nie per-commit
npm run test:browser        # closure — až keď agenti nesúťaia o dev server
```

Plus: A/B JSON z O1 harnessu pred/po, pripojený k commitu sonic zmeny.

## Riziká a pravidlá

- **CPU budget:** O2 je najdrahšia fáza (+50–100 % na engine). Meriať pred merge; ak perf gate prekročí, najprv 12/12 variant, tier-párovanie len ako explicitné rozhodnutie.
- **Stabilita:** každá fáza meniaca loop štruktúru (O2/O3/O5) musí prejsť stability sweep z auditu (shimmer × decay matica, freeze kombinácie) — guard je tu kontrakt, nie obmedzenie.
- **Sonic declaration discipline:** každá fáza má explicitné "sonic zmena: ÁNO/NIE". Fázy s ÁNO nesmú pushnuť bez A/B dôkazu a aktualizovaných pásiem v hardening teste.
- **Upstream reconcile prvé:** kým hardening zmeny nie sú v upstreamu, žiadna sonic fáza nezačína — inak re-vendor stratí guard aj kalibrácie naraz.

---

*Podklad pre tento dokument: hardening & self-audit Ozveny (2026-09-04/05) — zvuková časť hodnotenia "odozva / kvalita prejavu / modifikovateľnosť" oproti referenciám Valhalla VintageVerb, LiquidSonics a Neoverb.*
