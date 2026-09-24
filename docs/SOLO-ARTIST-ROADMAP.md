# Solo Artist Roadmap — KYX ako producent, ktorý počúva

> Živý dokument. Cieľ: **KYX je svetové DAW pre beatmakerov, ale hlavne parťák pre solo artistov** — intent engine nefunguje ako generátor beatov, ale ako profi producent: najprv počúva interpreta (hlas, flow, energiu, frázovanie) a až potom stavia beat okolo neho.
>
> Súvisiace: `INTENT_ENGINE.md` (generatívny engine), `ARCHITECTURE.md` (vrstvy a invarianty), `docs/CURRENT-STATE.md` (čo ships dnes), `VISION.md` (scope — žiadne VST, žiadne multitrack štúdio).

---

## 1. Prečo práve toto (positioning v jednej vete)

Beatmakerov obsluhuje každý druhý nástroj. **Človek s hlasom a telefónom, bez kapely a bez producenta, nemá dnes v browseri nikoho, kto by ho počúval.** Solo artista nepotrebuje ďalší beat generátor — potrebuje niekoho, kto počuje, že spieva v A minore, tlačí refrén a dýcha po štyroch baroch, a zariadi sa podľa toho. Žiadne browser DAW to dnes nerobí offline. To je strategická diera.

---

## 2. Čo na to už existuje (inventúra, nekupujeme dvakrát)

| Máš                                                                                        | Kde                                                                       | Ako to V-roadmap použije                                                         |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Nahrávanie vokálu na arrangement track (Float32 PCM bloky, recoverable z IndexedDB)        | `src/audio-engine/` recorder + arrangement recorder                       | **ucho** — vstup pre analýzu (V1), bez nového nahrávacieho stacku                |
| Verse/chorus/bridge role + inštrumentácia per sekcia                                       | `src/intent/song.ts` (`SongSectionSpec`)                                  | kostra, do ktorej V2 dosadí štruktúru odvodenú z hlasu                           |
| Audio referencia („sprav to ako tento WAV") + 16-dim conditioning                          | `src/ui/IntentPanel.tsx` (🎧 REF), `src/intent/semantic-conditioning.ts`  | vzor pre „vokál ako vstup" tok (V1 kopíruje UX)                                  |
| Mix profil (tone/punch/space/pump) + targeted FX + per-section FX lanes                    | `src/intent/mix.ts`, `src/intent/production.ts`, `applySongCommand`       | V2 pridá `vocalPocket` rozhodnutia (unmask, ducking) tým istým slovníkom         |
| VLYX unmask stage, sidechain pump, master tilt/trim, loudness loop na −14 LUFS             | `src/effects/ultina-core/`, `src/intent/mix.ts`, `src/intent/loudness.ts` | technika na uvoľnenie miesta vokálu — netreba nové DSP                           |
| Song audition, revise („more energetic" + C3 targeted section revise), SUNO MODE draft→USE | `src/intent/audition.ts`, `src/intent/route.ts`, `src/intent/compose.ts`  | V3 dialóg stojí na rovnakých command cestách, len ho kŕmi analýza namiesto textu |
| Transpozícia notových štruktúr                                                             | `src/project-model/transform.ts`                                          | V1 key adaptácia bez regenerácie                                                 |
| Deterministický offline renderer (rovnaký engine ako live)                                 | `src/rendering/renderer.ts`                                               | meranie hlasitosti/fráz s vokálom = rovnaký chain ako export                     |

---

## 3. Invarianty (dedia sa z Intent Engine, platia aj tu)

1. **Analýza je návrh, nie mutácia.** Vokálna analýza nikdy nemení projekt priamo — vyrobí `VocalProfile` (proposal), aplikuje sa až cez command systém (1 undo krok).
2. **Determinizmus.** Rovnaký take + seed → rovnaký `VocalProfile` (hashovaný). Heuristické DSP prvé, modely (ak niekedy) len za timeoutom + fallbackom.
3. **Žiadny audio thread.** Analýza beží vo Web Worker-i (príp. AudioWorklet→worker handoff), nikdy v playback callbacku ani v UI hot path.
4. **Offline-first.** Všetko v V1/V2 je klasické signálové DSP bez siete a bez sťahovania modelov. Žiadny účet, žiadny cloud.
5. **Nevymýšľa si.** Keď je take tichý/krátky/nezrozumiteľný, engine povie „nepočujem ťa, daj mi dlhší take" — nikdy nehalucinuje key/tempo z ničoho.

---

## 4. Fáza V1 — „Počujem ťa" (vstup: vokálny take, výstup: karta + one-click adaptácia)

**Sľub pre speváka:** dropneš vokál → KYX ti ukáže kartu _čo počuje_ (key, tempo, energia, frázy) → jedným klikom sadne beat do tvojho key a tempa.

### V1.1 Vokálny analyzér (nový modul `src/vocal/`)

- `src/vocal/types.ts` — `VocalProfile { keyEstimate, keyConfidence, tempoEstimate, energyCurve[per-bar], phrases[{startBar, endBar, peakEnergy}], snr, measured: boolean }` + `vocalProfileHash`.
- `src/vocal/analyzer-worker.ts` + `analyzer-client.ts` — lazy worker, timeouty + circuit breaker (kópia ranker/prior vzoru):
  - **pitch → key**: YIN (alebo autokorelačný) pitch tracker na mono downmixe → histogram pitch classes → Krumhansl-Schmuckler key profily (major/minor) → key + confidence. Pod confidence prahom → `measured: false` pre key (engine to prizná).
  - **tempo flow**: onset envelope (energy flux) → autokorelácia periodicity → BPM v hudobnom rozsahu, snap na polovicu/dvojnásobok ambiguity (hlasový flow vs. beatové BPM — reportovať obe, default beatové).
  - **energia/frázy**: RMS na bar grid (aktuálny project BPM) → energy curve; frázy = súvislé nadprahové úseky s min. dĺžkou; pauzy = priestor pre budúce pocket aranžmány.
- Vstup: PCM/bloky arrangement nahrávky (rovnaký zdroj ako export), resample na 16 kHz mono v main threade (vzor: audio-index), analýza vo workeri.
- Testy: `tests/vocal-profile.test.ts` — syntetické signály (sínus A4 → A; akordový drone C dur → C major; klik 100 BPM → 100; ticho → `measured: false`; determinizmus 2× rovnako).

### V1.2 Adaptačné commandy (žiadne nové UI paradigmy)

- `setProjectKeyFromVocal` — `VocalProfile.keyEstimate` → `doc.key` + voliteľná transpozícia existujúcich not cez `transform.ts` (user si vyberie: _Transpose_ vs _Regenerate in key_ cez existujúce generovanie s `key`).
- `matchTempoToVocal` — `tempoEstimate` → transport BPM (so schedulerom zadarmo; time-stretch samplov mimo scope V1 — priznaná limitácia).
- Oba ako jeden undo krok, s provenance (`appliedFromVocal: profileHash`).
- Testy: key transpose round-trip, tempo set + scheduler tick consistency, undo restore.

### V1.3 UI: vokálna karta (kopíruje 🎧 REF vzor)

- Po výbere arrangement take: „🎤 ANALYZE" → karta: **Key A minor (82%) · Flow 96 (beat 96) · 6 fráz · peak v baroch 9–16** + tlačidlá _Sadni key_ / _Sadni tempo_ / _Obe_.
- Slabý signál → úprimná hláška, nie fallback do defaultu („Take je príliš tichý — skús bližšie k mikrofónu").
- E2E: jeden Playwright scenár (import WAV → analyze → karta → apply → undo).

**Done keď:** spevák bez hudobnej teórie dostane beat v svojej tónine a tempe na 3 kliky; `npm run test` zelená; nové testy ≥ 15.

---

## 5. Fáza V2 — „Staviam okolo teba" (beat sa prispôsobí hlasu)

**Sľub:** SONG postavená na tvojom hlase znie ako vyrobená pre ten hlas — štruktúra z frázovania, aranžmán s pocketmi, mix s miestom pre vokál.

### V2.1 Štruktúra z frázovania

- `planVocalForm(profile, genreForm)` — energetické a hustotné klastre fráz → mapovanie na verse/chorus/bridge (vysoká susteinená energia = chorus, riedke = verse, pauza = break). Fallback: existujúce per-žáner formy (nikdy nie prázdna forma).
- `buildSong` dostane voliteľný `vocalProfile`: sekcie sa časujú na frázy (drop pod refrén, break do pauzy), inštrumentácia rešpektuje „hlas potrebuje priestor" (redšie delty v exponovaných miestach).
- Testy: syntetický profil (2 energetické bloky) → chorus markery sedia na blokoch; determinizmus; bez profilu = dnešné správanie bit-identicky.

### V2.2 Pocket mix (hlas má vždy miesto)

- `planMixProfile` rozšírenie o `vocalPocket`: VLYX unmask na music buse v pásme vokálu (z `keyEstimate` + formantového odhadu), ducking music/drums pod vokálnu stopu (sidechain zdroj = vokálny track — rovnaký pattern ako drum-keyed pump), reverb kratší v exponovaných sekciách.
- Všetko v existujúcom slovníku rozhodnutí (nový `MixDecision.target: "vocal"` + pocket params), clamp proti `EFFECT_DEFS`, jeden undo krok, idempotentné.
- Testy: profil obsahuje pocket rozhodnutia pri `vocalProfile`; bez profilu = dnešný profil bit-identicky; apply/undo; FX Cues a vokálna stopa nedostanú pumpu určenú pre drums.

### V2.3 Loudness s vokálom

- `applyLoudnessIntent` meria render **vrátane** vokálnej stopy (dnes ju zámrene obchádza cue logika — overiť a explicitne zahrnúť); target zostáva −14 LUFS, trim ±6 dB.
- Song audition prehráva mix s vokálom (preview==USE sa rozširuje na hlas).

**Done keď:** A/B blind test — ten istý take na (a) neutrálnom beate vs (b) V2 beate; (b) má počuteľne voľnejší stred a štruktúru sediacu na frázy; `tests/song-auto-produce.test.ts` rozšírená o vocal vetvu.

---

## 6. Fáza V3 — „Dialóg" (producent hovorí)

**Sľub:** engine ti povie, čo počuje a čo spravil — a revise cieliš hlasom, nie textom.

### V3.1 Producentove poznámky (deterministické NL šablóny, SK+EN)

- `src/vocal/notes.ts` — `producerNotes(profile, appliedActions): string[]`: „Počujem ťa v A minore (82%). Refrén tlačíš v baroch 9–16 — dal som mu plnú zostavu a uvoľnil stredy. Sloha je šepkaná — nechal som ju riedku." Žiadne LLM, čisté šablóny z meraní (pravdivé alebo nič).
- Poznámky sa zapisujú do provenance buildu (auditovateľné: ktoré číslo viedlo ku ktorému rozhodnutiu).

### V3.2 Hlasom riadený revise

- C3 targeted revise (`reviseSection`) dnes berie cieľ z textu („bridge"); V3 pridá zdroj z profilu: klik na frázu v karte → „toto je bridge" → revise s rovnakým seed patternom. Rovnaká `replacePatternInPlaceCommand` cesta, nový spúšťač.
- Energetické delty sekcií sa kalibrujú z `energyCurve` (refrénová sekcia dostane energiu nameranú v refréne, nie z textu).

### V3.3 Session pamäť (bez cloudu)

- Ledger prossima (`pf:vocal-sessions`, localStorage/IndexedDB): profil + aplikované akcie + ★/✗ feedback na poznámky → váhy pre budúce defaulty (rovnaký ledger vzor ako `pf:intent-favorites`). Nič neopúšťa stroj.

**Done keď:** nový user bez sprievodcu prejde take → karta → SONG → „aha, on ma fakt počul" moment do 5 minút (merané na 3 testovacích spevákoch, nie na nás).

---

## 7. Testovacie brány (povinné pred každou fázou ďalej)

| Brána                             | Príkaz                                         | Očakávané                                                    |
| --------------------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| Typecheck čistý v nových moduloch | `npm run typecheck`                            | 0 chýb v `src/vocal/**` (zvyšok stromu riešia vlastníci)     |
| Unit + property testy fázy        | `npm run test` (cielené súbory)                | PASS, determinizmus 2× rovnako, `measured:false` cesty kryté |
| Golden nemennosť                  | `tests/ai-baseline`, `tests/song-auto-produce` | PASS bez zmien (V-roadmap nesmie pohnúť neutrálnym zvukom)   |
| Real-browser smoke                | `npm run test:browser` (vocal scenár od V1.3)  | render s vokálom = live playback                             |
| Ušný gate (V2+)                   | blind A/B na 3 reálnych takeoch                | V2 vyhráva u 2 z 3 testerov                                  |

---

## 8. Vedome mimo scope (nebudovať, iba sledovať)

- **Syntéza/replace hlasu** (vokálne modely, T5 horizont) — KYX hlas nenahrádza, aranžuje okolo neho.
- **Real-time pitch correction** (Auto-Tune štýl) — defer; až po V3 a len ako voliteľný insert s vlastným ADR.
- **Cloud čokoľvek** — analýza, profily aj ledger ostávajú lokálne; zdieľanie maximálne ako exportovateľný `vocal-profile.json` vedľa `.scorepack`.
- **Multitrack kapely** — solo artista a jeho take; VISION scope sa nemení.

## 9. Otvorené otázky — ROZHODNUTÉ 2026-11-04 (kód + testy nižšie)

1. **Kľúč vs. škála → dur/mol stačí.** Krumhansl na krátkom take spoľahlivo rozlíši práve dur/mol; jemné módy by boli hádanie. Módy až s väčším overovacím datasetom. (Bez zmeny kódu.)
2. **Flow vs. beat → ukázať obe, defaultne sadne merané.** `VocalProfile.tempoAltBpm` (oktávový súrodenec, len ak padne do 70..180, inak absent) + `applyVocalTempoCommand(…, {useAlt})` + ALT button na karte. Vedome NElabelované flow/beat v engine (závisí od žánru — protiklad: boom-bap 80); karta píše „Tempo X · alt Y". Dôkaz že nejde o teóriu: 140 BPM kliky estimátor vrátil ako 70 — pár 70/140 drží pravdu aj pri zlej oktáve (uzamknuté testom).
3. **Transpose default, regenerate sekundárne.** `transpose !== false` je default (nedestruktívne, hneď počuteľné); po KEY apply nesie `doc.key` a SONG/GENERATE generujú v ňom (uzamknuté: `build.key === "D Major"` po apply). `transpose:false` pre regenerate flow.
4. **Karta v IntentPanely.** Vlastný dock panel až po ustálení voice-idea UI vedľa; dnes nie je brzdou.
5. **Persistencia = ledger, nie project JSON.** Žiadna schema zmena: `pf:vocal-sessions` drží kompaktné záznamy (key/tempo/frázy/applied/rating, bez energyCurve); po reload re-analýza cez `resolveVocalTake` (rýchla, deterministická).

---

## 10. Stav implementácie (2026-11-04, sekvenčný goal task)

- **V1 engine HOTOVÉ** (`src/vocal/` — 18 testov zelených):
  - `types.ts` (VocalProfile + hash), `analyze.ts` (buildVocalProfile: Goertzel/Krumhansl key + transient tempo z `ai/audio-tempo-key.ts`, vlastné energy/frázy/SNR + honesty gates), `analyzer-worker.ts` + `analyzer-client.ts` (lazy worker, timeout, breaker, sync fallback — DSP je pure),
  - `adapt.ts` (key transpose shortest-path + tempo cez kanonický `setBpm`, 1 undo krok, drums imunné).
- **V1.4 UI HOTOVÉ:** 🎤 TAKE button + karta v `IntentPanel.tsx` (vedľa 🎧 VOCAL, štýly v `17-effect-intent.css`): longest-clip analyze → card riadky → KEY / TEMPO / ♪ SONG (potrebuje textový prompt — take ho ohýba) / ×. Každý SONG draft automaticky nesie meraný profil.
- **PCM resolver HOTOVÝ:** `vocal/resolve.ts` (clip → bank buffer → mono PCM + trim window + gain, pure, 6 testov) — karta číta priamo arrangement take; file drop netreba.
- **`composeFullTrack` vocal-wiring HOTOVÉ:** `ComposeOptions.vocalProfile` (efekt má len meraný profil) → `buildSong` bend + pocket mix; nemenaný profil stavia legacy song (uzamknuté testom).
- **V2 engine HOTOVÉ:** `vocal/form.ts` (span energy + section adjust, identita pri 0.5) + `buildSong({vocalProfile})` (append-only, bez profilu bit-identicky); pocket mix (`planMixProfile(…, {vocalPresent})` — high-mid dip 2.8 kHz na chords/lead); loudness meria song mód vrátane audioClipov (overené seam testom s injektovaným renderom). Testy `vocal-form` (4) + `vocal-produce` (4).
- **V3 engine HOTOVÉ:** `notes.ts` (SK+EN šablóny, len merané polia), `revise.ts` (phrase→role + delegácia na C3 `reviseSection`, `song.ts` nemenene), `sessions.ts` (lokálny ledger `pf:vocal-sessions`, cap 50). Testy `vocal-dialog` (8).
- **VLYX-unmask pocket HOTOVÝ:** `unmask.ecosystemEnabled` + `unmask.amount` v `ultinaParams` (clamp + rack/panel metadata); pocket = statický high-mid dip (univerzálny floor) + VLYX ecosystem unmask na chords/lead + default ultina publisher na take tracku (žiadny sidechainTrackId — single-input node, ecosystem JE bus). Bez workletov sedí unmask inertne a nesie to dip; bez takeov publisher no-op. Testy vo `vocal-produce` (+5).
- **Zostáva:** blind A/B ušný gate, roadmap otázky Q1–Q5.

_Založené: 2026-11-04 (z P1–P5 auditov a vízie „producent, ktorý počúva"). Revidovať po každej V-fáze; fakty o existujúcich moduloch overené čítaním zdrojov v §2._
