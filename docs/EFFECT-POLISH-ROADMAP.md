# EFFECT POLISH ROADMAP — Wave 4 (dokončenie auditu)

**Vznik:** 2026-09-21 · **Status:** plán (nezačaté)
**Predpoklad:** Waves 1–3 z auditu 47 efektov sú DODANÉ (clipper MIX, shimmer hlas, gate lookahead/hysteresis, charakter engine, bitcrusher drive/tone, multiband comp+solo, haasWidener crossfeed, reverb stereo-in+MOD, comb SPREAD, phaser CENTER/SPREAD dvoj-reťaz). Tento plán pokrýva **poslednú vlnu**: opravné chyby + automatizačnú kvalitu + chýbajúce vône. Po tejto vlne už zoznam „nedotiahnutých" neexistuje.

**Zdroj auditu:** hĺbkové prečítanie každého procesora (2026-09-21) — full 47-effect tier-list, testy Waves 1–3 v `tests/effects-wave{1,2,3}-upgrade.test.ts`.

**Fakty overené v kóde pred písaním (nie z hlavy):** chorus aj tremolo už majú tempo-sync (C2 vlna, `LfoSyncController`) — C fáza teda pridáva IBA feedback/voices/shape; multiTap live-divisions už glide-ujú (10 ms TC) — A2 je len zarovnanie na 20 ms; phaser STAGES rebuild je reálny príčina kliku (overené čítaním `case "stages"`).

---

## 0. Pravidlá platné pre celú roadmapu

1. **Žiadna schema migrácia** — všetky nové parametre sú aditívne do `EffectDefinition.params` (staré projekty dostanú defaulty cez `defaultParamsOf`, nové parametre v starých projektoch sú ignorované). `SCHEMA_VERSION` sa nemení.
2. **Stabilné parametre ID** — nové ID nikdy nepremenovávať; enumy rastú na koniec rozsahu (precedent: charakter engine mode 4 = Tape).
3. **Smoothing pattern** — kopírovať eq (12 parametrov, ~3 ms one-pole glide v procesore). Pre natívne fabriky `smooth(param, v, when)` helper z registry (setTargetAtTime, 20 ms TC).
4. **Tempo-sync pattern** — `createLfoSyncController` z `src/effects/tempo-sync.ts` (tremolo/phaser/chorus/duckDelay wraps). Registry def musí mať `sync` param + factory berie `env.bpm` + runtime `syncBpm(bpm)`.
5. **Test pattern** — `tests/effects-wave4-upgrade.test.ts`: procesory priamo cez stubnutý `AudioWorkletProcessor` (harness z wave-1), registry kontrakty cez `defaultParamsOf`/`EFFECT_DEFS`. **Pozor na dve minulé pasti:** (a) `process()` berie pole vstupov `[[L,R]]`, nie pár kanálov — inak procesor mlčí; (b) RMS nevidí dekorreláciu — použiť normalizovaný sample-diff `Σ|a−b|/Σ(|a|+|b|)`.
6. **Worklet budget** — zmeny v existujúcich `*-processor.js` sú lacné (žiadny nový bundle); po každej zmene `npm run build:core-worklets` + `npm run build` musí ostať zelený.
7. **Registry je horúca** — paralelná session ju edituje; patchovať cez krátke unikátne anchory, po každom priate skontrolovať, že zmeny stále sedia.

---

## FÁZA A — Opravné chyby (bug-tier, malé diffy)

### A1. Phaser: klik pri zmene STAGES

- **Problém:** `case "stages"` v registry (factory phaser) teardown-ne starý reťaz a pripojí nový zaživa → počuteľný pop presne v momente ťahania.
- **Riešenie (crossfade):** pridať `xfade = ctx.createGain()` (gain 0→1) na výstup nového reťazu a `oldXfade` (1→0) na starý; starý reťaz dispose-núť po 60 ms `setTimeout` (main-thread, nie audio-thread — legálne). Prepínanie sa tak stane kratkým crossfade-om.
- **Súbory:** `src/effects/registry.ts` (phaser factory, case `"stages"`).
- **Test:** vitest factory-level nejde (WebAudio); registry kontrakt + ručná POZOROVATEĽNOSŤ v browseri. Minimal test: stages param prežije 3 rýchle zmeny bez výnimky (mock ctx? — nie, nechať na browser-checks).
- **Exit:** zmena STAGES 0→2→4→1 bez počuteľného popu (ucho), žiadna výnimka v konzole.

### A2. MultiTapDelay: zarovnať delenie-glide so stock-delay precedentom

- **Overený stav (2026-09-21):** live cesta (`when === undefined`) UŽ glide-uje cez `setTargetAtTime` — ale s 10 ms TC; stock-delay používa 20 ms. Plánovaná (automation) cesta korektne používa `setValueAtTime` (presný offline zápis — to nie je bug).
- **Riešenie:** pritiahnuť live TC z 0.01 na 0.05 (stock-delay konvencia) — jedno číslo.
- **Súbory:** `src/effects/registry.ts` (multiTapDelay factory, `setDivision`).
- **Exit:** točenie T1 DIV počas prehrávania znie ako pitch-sweep, nie ako trhnutie.

### A3. Reverb-node: odstrániť mŕtve legacy mapovanie

- **Stav:** už hotové vo Wave 3 (`tone` už nezrkadlí do `damping`) — v tejto fáze len **regresný test**, že `setParameter("tone")` NEzmení damping (wave-3 súbor doplniť o jeden it-blok cez stubnutý node? — nie: node potrebuje WebAudio. Alternatíva: unit test na `createReverbNode` s fake ctx je prekročenie — nechať ako manuálnu poznámku).
- **Exit:** žiadny kód; len vložiť komentár do reverb-node, že mirroring je zámerne preč (je tam).

---

## FÁZA B — Automatizačná kvalita (zipper killer)

### B1. Vowel: glide biquad koeficientov

- **Problém:** `vowel-processor.js` (161 riadkov) prepočíta b0/b1/b2/a1/a2 per block pri pohybe vowel/resonance — koeficienty skáču → zipper.
- **Riešenie:** per-sample one-pole glide NA KOEFICIENTY (nie na parametre): `this.b0[f] += (targetB0 − this.b0[f]) · glideCoef` s glideCoef ≈ 1 − exp(−1/(0.004·sr)) (~4 ms). Štyri polia × 3 filtre = 12 glidov — zanedbateľné CPU.
- **Súbory:** `src/audio-worklets/vowel-processor.js`.
- **Test:** harness probe — vowel parametre automatizované sinusom (0.5 Hz medzi A↔I), assert: žiadny skok > X medzi susednými výstupnými vzorkami (max-delta < 0.15), finitný výstup.
- **Exit:** automatizovaný vowel bez zipperu; staré snaphoty znej rovnako pri statických parametroch (koeficienty po settle = presne target — glide konverguje).

### B2. SVFilter: glide cutoff

- **Problém:** `svfilter-processor.js` — `this.f = 2·sin(π·cutoff/sr)` per block; automatizovaný cutoff zipzuje (a pri velkých skokoch môže stabilizačný clamp `fqMax` trhnúť).
- **Riešenie:** glide na **cutoff parametri** (nie na f): `this.cutoffSmoothed += (cutoff − smoothed) · (1 − exp(−1/(0.005·sr)))` (~5 ms), až potom f + stability clamp. 5 ms je dosť rýchle na wah-role, dostatočne pomalé proti zipperu.
- **Súbory:** `src/audio-worklets/svfilter-processor.js`.
- **Test:** probe — cutoff automatizovaný exp sweep, max sample-delta klesne > 3× oproti ne-smoothnutej verzii; finitný výstup; pri statickom cuttove jednofrekvenčný OUTPUT RMS identický ±0.1 dB.
- **Exit:** automatizovaný filter hladký; whitespace presetov nezmenený.

---

## FÁZA C — Chorus upgrade (najväčší zostávajúci priemer)

### C1. Chorus: FEEDBACK + VOICES + LFO SHAPE

- **Súčasný stav:** 2 hlasy (12/18 ms) s rate-offsetmi, sine LFO, žiadny feedback, sync už má (LfoSyncController — overené).
- **Nové parametre (aditívne, stabilné ID):**
  - `chorusFeedback` (0..0.85, default 0) — wet výstup hlasu späť do jeho delay inputu (varísi plnosť; ohraničiť ≤ 0.85 bez inner damping — pri 2 hlasoch bezpečné).
  - `voices` (2..4, discrete step 1, default 2) — hlasy 3/4 = ďalšie delay ms (24/29 ms) s LFO offsetmi 0.5/0.75 fázy a panom −0.6/+0.6 (hlasy 1/2 pan ±0.3).
  - `lfoShape` (0=sine, 1=triangle, 2=random-S&H seeded — deterministic mulberry32 so seedom z fxId, precedent vinyl) — S&H drží per-voice sample-counter (vzor bitMangler hash).
- **Súbory:** `src/audio-worklets/chorus-processor.js` (descriptory + DSP), `src/audio-worklets/chorus-node.ts` (aplikácia init), `src/effects/registry.ts` (params).
- **Testy:** probe — voices=4: 4 odlišné delay-tap Energy peaks? (zjednodušiť: výstup finitný, RMS rastie s voices pri rovnakom vstupe ≤ +6 dB); feedback 0.85 + vstupné stop ~3 s: žiadny runaway (max |out| ≤ 1.2); S&H deterministic: dva rendery rovnakého seedu bit-identické.
- **Exit:** chorus má feedback/voices/shape a sync stále funguje (existujúci LfoSync test neprerušený).

---

## FÁZA D — Vône (tier-3, voliteľné položky)

### D1. DuckDelay: tempo sync + ping-pong + loop HPF

- **Sync:** registry def +`sync` param (LFO_SYNC_DIVISIONS), factory berie `env.bpm`, wrap dostane `createLfoSyncController`-ekvivalent pre delay-time (division → ms = beats·60/bpm·1000; `syncBpm` prepíše delay time glidom). Precedent: stock-delay/kaskada.
- **Ping-pong:** `pingpong` toggle (0/1) — v slučke prekrížiť: wL dostane tiež predchádzajúci R-tap·0.7 a naopak (crossfeed v write). Jediné 2 riadky DSP.
- **Loop HPF:** `loopHpfHz` (20..400, default 40) — one-pole HP v spätnej väzbe pred LP (už tam LP je — pridať sériovo HP štát per channel).
- **Súbory:** `src/audio-worklets/ducking-delay-processor.js`, `src/audio-worklets/ducking-delay-node.ts`, registry def + factory (sync wiring).
- **Exit:** delay padne do groovu pri zmene BPM zaživa (syncBpm), ping-pong počuteľný, dlhé ocasy bez blata.

### D2. BassBuss: sub-harmonický generátor

- **Problém:** „SUB" je len low shelf — žiadna oktáva dole.
- **Riešenie:** `subOsc` param (0..100 %) — jednoduchý square-clip sub: LP(120 Hz) signál → zero-crossing frequency divider (÷2 oktáva dole, wave-shaper na sine-ish cez tanh) → gain (subOsc) → zmiešať do výstupu. Detekcia zero-crossings per-channel s holdom (mono-sum). Deterministic. ~40 riadkov.
- **Súbory:** registry def +factory (bassBuss) — natívne nody nestačia (potrebuje waveform manipuláciu): buď malý nový worklet `bassbuss-sub-processor.js` (register do loader CORE_TYPES + budget) alebo JS-side per-block v existujúcom? — bassBuss je natívna fabrika, takže **nový mini-worklet** je čistá cesta (precedent bitcrusher).
- **Test:** 110 Hz sine in → 55 Hz zložka v výstuči (Goertzel pri 55 Hz rastie so subOsc), pri subOsc=0 žiadna.
- **Exit:** SUB krúžok pridáva počuteľnú oktávu dole bez rozbíjania pôvodnej hladiny (master RMS drift ≤ 1 dB).

### D3. DrumBuss: reálny TRANSIENT stupeň

- **Problém:** TRANSIENT krúžok len mení comp attack.
- **Riešenie:** pridať transient-shaper jadro (fast 4 ms/slow 80 ms envelope difference → gain) PRED comp, TRANSIENT krúžok riadi jeho attack-amount (−100..+100 mapované z 0..100: 0–50 % = s kontrolou, 50–100 % = attack boost). Procesor už existuje — reuse pattern z transient-processor.js vložený do drumBuss factory cez druhý worklet node v reťazi (drumBuss je natívna fabrika — môže inštancovať `transient-processor` node rovnako ako teraz inštantuje comp worklet).
- **Súbory:** registry (drumBuss factory wiring + param re-map).
- **Exit:** TRANSIENT počuteľne tvaruje kick attack nezávisle od comp.

### D4. Menšie vône (každá ≤ 15 riadkov)

- **Autowah:** `direction` toggle (0=up-wah klasika, 1=down-wah — maxFreq/minFreq swap v mapovaní) + `drive` tanh pred SVF (0..100 %).
- **RingMod:** `xmode` toggle — unipolárne násobenie (carrier |c| namiesto c) = „X-mod" robotický charakter.
- **Compressor:** `autoRelease` toggle — release TC sleduje histogram transientov (ak peak-denny hustota > X, skrátiť release 2×) — jednoduchý program-dependent prístup.
- **Utility:** `dcBlock` toggle — one-pole HP 8 Hz na výstup (fight offset zivých samplerov).

---

## Fázy — poradie a rozsah

| Fáza       | Položky                                                       | Efort   | Riziko                    |
| ---------- | ------------------------------------------------------------- | ------- | ------------------------- |
| A (bugy)   | A1 phaser xfade, A2 multitap glide                            | ½ deň   | nízke                     |
| B (zipper) | B1 vowel, B2 svfilter                                         | ½ deň   | nízke                     |
| C (chorus) | C1 feedback/voices/shape                                      | 1 deň   | stredné (nové DSP vetvy)  |
| D (vône)   | D1 duckDelay, D2 bassBuss sub, D3 drumBuss transient, D4 mini | 1–2 dni | stredné (D2 nový worklet) |

**Odporúčané poradie:** A → B → C → D1 → D4 → D2 → D3. A+B sú čisté zisky; C a D2/D3 pridávajú nové DSP povrchy (nové testy povinné).

---

## Definícia hotovo (pre celú roadmapu)

Každá položka: (1) kód + aditívne parametre cez stabilné ID, (2) probe testy v `tests/effects-wave4-upgrade.test.ts` (harness z wave-1/3), (3) `npm run typecheck` + `npm run build` zelené, (4) core-worklet bundle rebuild, (5) súvisiace suit-y (fx-role-presets, slider-taper, preset-normalization, quick-wins) zelené, (6) ak nový worklet → loader CORE_TYPES + budget check + fallback cesta v `WORKLET_EFFECTS`.

---

## Čo sa v tejto roadmap NOVÉ NERIEŠI (vedomé vylúčenia)

- **Compressor look-ahead / auto-makeup** — compressor je označený SOLID; auto-release v D4 pokrýva najväčšiu vôňu.
- **EQ analyser / band solo** — eq je SOLID; PRISM (fxeq) pokrýva power-user prípady.
- **Reverb FDN → full modulation matrix** — MOD z Wave 3 stačí; FDN rebuild by menil zvučnejšie identitu všetkých existujúcich presetov.
- **RingMod pitch-tracking, vocoder 4-pole bands, per-band trim** — skutočne nišové; vocoder je SOLID.

---

## Stav

- [ ] Fáza A — phaser xfade, multitap glide
- [ ] Fáza B — vowel glide, svfilter glide
- [ ] Fáza C — chorus feedback/voices/shape
- [ ] Fáza D — duckDelay sync/pp/hpf, bassBuss sub, drumBuss transient, mini vône
- [ ] Regresný sweep (12+ súitov) + budget gate
