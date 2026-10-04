# INTENT ENGINE — Killer Feature Plan (2026-10-04)

> **Cieľ dokumentu:** zmapovať, čo s intent enginom ďalej, aby sa stal **killer
> feature tohto DAW** — nie " ďalšia AI veta", ale dôvod, prečo si človek otvorí
> KYX a nie Suno/FL Studio.
>
> **Autor:** coding agent (research cez INTENT_ENGINE.md, docs/CURRENT-STATE.md,
> zdrojáky `src/intent/`, `src/ai/`, `src/generative/`, manifesty `public/models/`
> a dve hĺbkové mapy vrstiev — 2026-10-04).
>
> **Zdroj pravdy pre čísla:** všetky počty v §2 sú overené čítaním zdrojov
> (nie z hlavy). Kde číslo chýba, je to povedané.

---

## 1. Vízia: prečo je intent engine killer feature

Suno vyrobí hotový track, ktorý **nemôžeš dotknúť**. FL Studio dáva nástroje,
ktoré **musíš ovládať**. KYX má jedinečnú pozíciu medzi tým:

```text
          SUNO                KYX                        FL STUDIO
  hotý track, nedotknuteľný    hotý track, plne editovateľný    nástroje, nič hoté
  nepamätá si ťa               učí sa ťa, pamätá si ťa          nepamätá si ťa
  cloud                        100 % lokálne                   lokálne
```

**Killer veta, ktorú má engine dnes už takmer zvládnutú:**
_"Napíš vetu → dostaneš hotovú skladbu. Povedz, čo ti nevyhovuje → engine
si vypočuje svoj výstup, zmeria to, opraví to. Daj mu počúvať svoj WAV →
učí sa tvoj zvuk. A keď sa ti niečo nepáčí, klikáš priamo do project modelu —
lebo to je plnohodnotný DAW projekt, nie MP3."_

Tri pilier, ktoré tento dokument rozvíja:

1. **„Znie to hotovo"** — engine počúva vlastný výstup a meria ho (audio loop).
2. **„Učí sa ma"** — explicitný (A/B hlasovanie) aj implicitný (★) taste
   signal, ktorý sa reálne premietne do generácie.
3. **„Všetko sa dá dotknúť"** — generované = proposal → command → project
   model; žiadna čierna skrinka.

---

## 2. Stav dnes (overené fakty)

### 2.1 Čo už beží (a nerobiť nanovo!)

| Oblast                   | Stav                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Žánre / groovy / artisti | **19 žánrov** (`src/ai/types.ts` Genre union), **194 štýlov** v style-embeddings, **622 artist presetov** (spočítané v `src/intent/artists.ts` 2026-10-04; house 129 · trap 122 · dnb 66 · techno 60 · boombap 43 · ambient 39 …), 19 song formiek + FRED/POP formy (`src/intent/song.ts`)                                 |
| Text → intent            | parser v3 EN (SK čiastočne) + **semantic retrieval** (MiniLM 118 MB opt-in, korpus ~3 100 viet generovaných z 622 artist presetov + 110 žánrovo-moodových parafáz) + artist alias mapa + intent model (ONNX slot-filler `intent-model-v1.onnx` 6,8 MB, `report.gatePassed: true` + Ollama `kyx-intent-v30-q8` probe-gated) |
| Generácia                | template grooves + **drum prior v3** (hybrid 60-dim, valAUC **0,920**) + **melodic prior v2** (41-dim, ds.v3: valDegreeAcc **0,5946** / valDurationAcc **0,5766**) + functional harmony multi-voice (36 progresií, voice leading, motif carry)                                                                             |
| Kandidáti + výber        | candidate bank (safe/personal/experimental lanes) + ONNX ranker **active** (0,6 heuristic + 0,4 model) + MMR diversity + **audio rerank** finalistov (ranking-v3, learned weight) + audition (A1)                                                                                                                          |
| Skladba                  | **SUNO MODE** `composeFullTrack`: veta → sekcie → transitions (reálne zvuky) → mix → loudness (−14 LUFS) v jednom toku, one-undo                                                                                                                                                                                           |
| Mix / produkcia          | mix profil + ~300 artist mix signatúr + 27 produkčných konceptov → FX ops + targeted effects + loudness loop + complaints (meraná diagnóza) + compound intents                                                                                                                                                             |
| Učenie chuti             | ★ → style vector (blend 0,25 do conditioningu) + **Producer DNA** (A/B votes → personal ranker + search bias, cap 128) + audio-fit ledger → `npm run rerank:fit`; taste-probe picker (controlled A/B otázky)                                                                                                               |
| Pamäť                    | producer session (session-scope), session-context („ten druhý ale tvrdší"), brief contract + project brief (persist), iteration compile                                                                                                                                                                                    |
| Referencie               | 🎧 REF (AST + features → patch + 16-dim conditioning), groove extraction (bubny z WAV), voice idea (hmm → key/tempo/YIN melódia → lead hook), vocal-ready mode                                                                                                                                                             |
| MRT2 generatívne tracky  | runtime/protokol/capture hotové; Windows promotion **zlyhal** (p95 35,98 ms, 9 overruns) — experimentálne, default unavailable                                                                                                                                                                                             |
| STT                      | **stub** — manifest/worker infra hotová, runtime nie je shipnutý („stt runtime not available in this build")                                                                                                                                                                                                               |

### 2.2 Kde to dnes skutočne bolí (diagnóza, zoradené podľa dopadu)

| #   | Bolesť                                                                                                                                                                                                          | Dôkaz / miesto                                                                                                                                                                         | Dopad                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| D1  | **Audio rerank meria 15 z 19 žánrov proti house profilu.** `AUDIO_TARGETS` má len house/techno/trap/ambient; ostatní fallbackujú na house                                                                       | `src/intent/audio-feedback.ts:30-86` — dnb/drill/phonk/jersey… kandidáty sa skórujú proti house rozsahom RMS/crest/ZCR/bass → engine „počúva zle" a môže **preradiť víťaza nesprávne** | VYSOKÝ — aktívne pokrúva výber pri zapnutom sound reranku |
| D2  | **Melodic prior nevidí harmóniu.** Model pozná genre/role/position/prev-note, ale NIČ nevie o akordovej progresii, ktorú engine práve hrá                                                                       | `src/ai/symbolic/melodic-features.ts` (29/41-dim kontrakt) — bass netuší, že má nasledovať root, lead že má sadnúť na chord tone; multi-voice to rieši len na template ceste           | VYSOKÝ — hlavný limit „hudobnosti" AI melódií             |
| D3  | **Tréningový korpus melodic priora je 861 riadkov ručne písaných referencií.** Public-domain MIDI korpus neexistuje                                                                                             | `scripts/generate-symbolic-melodic-dataset.mts` (ds.v3), diery d1/d5 = 0 čestných príkladov, duration-8 = 54 vzoriek                                                                   | VYSOKÝ — prior interpoluje knižnicu, nevie generalizovať  |
| D4  | **Personalizácia sa učí, ale sa NEMÔŽE pretretnúť v appke.** Favorites → retrain je CLI python skript (`npm run favorites:retrain`), bežný používateľ ho nikdy nespustí; ranker artifact má `favoriteGroups: 0` | `scripts/export-favorites-training.mts`, INTENT_ENGINE §5.12; personal-ranker residual funguje, ale drobné ONNX modely sa z ★ nikdy v appke nepretretnú                                | VYSOKÝ — „DAW, ktorý sa učí" je dnes napoly pravda        |
| D5  | **Producer DNA nevie merat basu ani harmóniu.** `bass` a `harmony` reason adaptéry sú `null` — features.v1 nemá žiadne bass/chord merania                                                                       | `src/intent/personal-ranker.ts:63-66`; features.v1 = 54 fixných features (`src/ai/features/pattern-features.ts`)                                                                       | STREDNÍ — hlasovania o base/harmónii sa zahodia           |
| D6  | **Session pamäť zomrie s reloadom.** producer-session je module state; project brief persistuje len potvrdené fakty z kontraktu                                                                                 | `src/intent/producer-session.ts` (module state, NOT persisted)                                                                                                                         | STREDNÍ — „pamätá si ťa" platí len v rámci jednej session |
| D7  | **Semantic korpus sa neučí z tvojich favoritov.** Korpus je generovaný (deterministicky ~3 100 viet), ale nezahŕňa ★-nuté patterny ako referenčné vety — retrieval nevie nájsť „moje veci" významom             | `src/intent/semantic.ts` (`buildSemanticCorpus` — 622 presetov × 5 viet + 110 vocab, žiadna favorites vetva), gap tabuľka v INTENT_ENGINE §7.2                                         | STREDNÍ                                                   |
| D8  | **Kapela má 4 roly.** drums/bass/chords/lead — žiadne arpy, pady, perkusie navrch, counter-melódia, mid-phrase filly                                                                                            | `src/intent/types.ts` IntentRole, `src/intent/song.ts` inštrumentácia                                                                                                                  | STREDNÍ — aranžmány znejú „štvorhlasovo"                  |
| D9  | **Song audition > 64 barov nemá chunked render** (OfflineAudioContext je main-thread-only); STT je stub; MRT2 bez podporeného backendu                                                                          | `src/intent/audition.ts`, `src/intent/stt-worker.ts`, ADR 0012/0013                                                                                                                    | NÍZKY-NÍZKY dnes, rastie s dĺžkou foriem                  |
| D10 | Artist profily majú TODO genre sloty (hyperpop→?, grime, dubstep, future-bass, IDM mapované na najbližšie existujúce)                                                                                           | `src/intent/artist-profiles/index.ts`                                                                                                                                                  | NÍZKY — krája presnosť deep profilov                      |

---

## 3. Stratégia: „Engine, ktorý počúva, učí sa a pamätá"

Najlepšia jednotlivá vec („bez debát") pre nasledujúce obdobie:

> **Uzavrieť tri slučky, ktoré sú už postavené, ale nie sú prepojené do
> konca:** (1) engine si VYPOČUJE vlastný výstup pre všetkých 19 žánrov a
> povie ti, čo je zle; (2) tvoj vkus sa premietne do modelov JEDNÝM klikom v
> appke; (3) melodic prior sa naučí harmóniu — aby AI melódie zneli ako
> hudba, nielen ako pravdepodobné noty.

Toto je lepšie pridávať nové modely, pretože: infraštruktúra (workery, manifesty,
gates, bank, audition, brief) je špičková a **podvyužitá**. Marža je v
prepojení a v dáta/conditioningu, nie v nových systémoch.

---

## 4. Plán vlnami

Každá vlna = samostatné PR-éka, prechádzajú cez standing gates
(`npm run typecheck`, `npm run test`, `npm run format:check`, relevantné
validátory). Čísla úsutu sú odhady na jeden agent-session blok.

### W0 — Rýchle výhry (1–2 dni spolu, každá sama o sebe má zmysel)

| ID   | Úloha                                                                                                                                                                                                                                                                                                                                                                | Súbory                                                                                                                                                 | Akceptácia                                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| W0.1 | **Audio target profily pre všetkých 19 žánrov** (D1). Rozšíriť `AUDIO_TARGETS` + vygenerovať hodnoty meraním, nie od oka: `measure-genre-references.mjs` pattern (meria genre loudness) rozšíriť na RMS/crest/ZCR/bass-ratio z referenčných renderov per žáner. Generované čísla do `src/intent/audio-reference.generated.ts`-štýlu súboru, ručné len pre exotiky    | `src/intent/audio-feedback.ts`, `scripts/measure-genre-references.mjs`, nový generated súbor                                                           | 19/19 žánrov má vlastný target; unit testy skórujú dnb beat vyššie proti dnb targetu než house; `npm run test` zelený |
| W0.2 | **Auto-diagnóza na povrchu** — po song audition spustiť `suggestSectionRevivals` + `reviewSongAudio` (existujú!) a zobraziť chips („drop je o 8 dB pod priemerom — +0.15 energy?"), klik = `reviseSection`. Nič sa nespúšťa bez kliku (etiketa)                                                                                                                      | `src/ui/IntentPanel.tsx`, `src/intent/song-audio-review.ts` (čisté funkcie, len wiring)                                                                | Pesnička s tichým dropom ukáže chip; klik opraví jednu sekciu in-place, 1 undo; bez merania chip nesvieti             |
| W0.3 | **STT cez Web Speech API fallback** (D9) — **HOTOVÉ 2026-10-04**: `stt-web-speech.ts` provider (SpeechRecognition, Chromium/Edge; Firefox/Safari честný Whisper-fallback) + wiring v `toggleVoiceCapture`; testy `tests/w03-w04-quick-wins.test.ts` (kumulatívne snapshotty → per-fráza zber, medzera medzi frázami, interim tail pri stop — modulové chyby fixnuté) | — `stt-loader` dostane druhý provider: browser-native reč, `pf:stt-model` runtime ostáva štubom (čestné). Mic capture už existuje (`voice-capture.ts`) | `src/intent/stt-loader.ts`, `src/ui/…` drawer                                                                         | V Chromu funguje „povedz vetu"; bez podpory = dnešný stav, žiadne klamstvo |
| W0.4 | **Artist profile genre TODO sloty** (D10) — **HOTOVÉ 2026-10-04**: `PROFILE_GENRE_SLOTS` (honest nearest + reason; dnes len hiphop/J Dilla → boom-bap) + `ENGINE_GENRE_UNION`; testy: coverage, valid nearest, žiadna mŕtva dokumentácia                                                                                                                             | — doplniť enum mappingy (grime→drill-family? nie: počkať na groove pridanie — aspoň honest TODO→`nearest` komentár + test proti tichému fallbacku)     | `src/intent/artist-profiles/index.ts`                                                                                 | Žiadny slot netichne fallbackuje; test iteruje profily a hlási nezapojené  |

### W1 — Melodic prior v3: harmónia-aware (D2 + D3-časť) — **hlavný hudobný skok**

Cieľ: AI melódie, ktoré **vedia, na akom akorde sú**. To je rozdiel medzi
„pravdepodobnou notou" a „bass linkou".

1. **Feature kontrakt v3** (`melodic-features-v3.ts`): k 41-dim v2 pridať
   - aktuálny chord root one-hot (7) + chord quality (maj/min/dom7/maj7/min7/sus/dim — 7)
   - nasledujúci chord root (7) — „kde sa má resolvnúť"
   - pozícia v akordovom slote (3 sin/cos) — synkopácia voči harmónii
   - **motív memory**: id opakovaného motívu (learnable embedding 8-dim) —
     prior sa naučí vracať tému namiesto random walku
2. **Dataset generátor** natívne importuje progresie z `harmony.ts`
   (`expandProgression` už vie posunúť akord per slot — rovnaký zdroj ako
   multi-voice). Wrap-around + group keys `genre#role#idx` ostávajú.
3. **Retrain + gate**: gate infraštruktúra z audita 2026-09-27 už existuje
   (`gate-melodic-retrain.py`, SemanticLookup) — prepojiť, predregistrovať
   prah (v2 ds.v3: degree 0,5766 / duration 0,5676 shipped-split) a prekonať ho.
4. **Provider**: `runMelodicNextV3` → fallback v2 → v1 (per-call), rovnaký
   vzor ako drums v3→v2→v1.

- **Úsilie:** 4–6 blokov. **Riziko:** feature count rastie (41→~65) — model
  zostáva malý; pri 861 riadkoch base je to OK, ale **W2 (korpus) je prirodzený
  spolujazdec**.
- **Akceptácia:** gate PASS s prekonaným prahom; smoke: bass na i-VI-III-VII
  nasleduje rooty (≥80 % slotov), lead sedí na chord tones (≥70 % silných dôb);
  golden baselines nezmenené pre v1/v2 cesty; `tests/melodic-dialects` zelené.

### W2 — Tréningový korpus: public-domain MIDI ingest (D3) — **ODHADNUTÉ 2026-10-04, korpus presmerovaný do W1**

Plán predpokladal, že klasický korpus zlepší melodic prior. **Gate to vyvrátil.**
Plný audit: `docs/W2-MIDI-CORPUS-AUDIT-2026-10-04.md`.

**Čo sa podarilo (zostáva v repo):** ingest pipeline
(`scripts/ingest-midi-corpus.mts` + `fetch-midi-corpus.mjs`, deterministický,
license-clean, 345 PD kusov s SHA-1 verifikáciou), `classical.*` conditioning
(`append-classical-embeddings.mts`), `--midi-corpus` flag v tréneri aj gate
(zdieľaný merge — gate meria presne to, čo tréner shipne). **29 730 vzoriek**
z 338 kusov — zaviera diery d1 (3 491), d5 (2 935) a duration-8 (736 vs 54).

**Čo zlyhalo (dôvod odmietnutia):** korpus znižuje degree accuracy na
elektronickom val z **0.5447 → 0.4774** (3-fold, rovnaký split) — robustne vo
všetkých variantoch (celý korpus / bass-only / bez chordu, `classical` aj
`ambient` conditioning). Klasický kontrapunkt má iné lokálne distribúcie
(stepwise + legato) než elektronický beat (skoky + synkopa) a 29 730 riadkov
preplaví val o ~6 pp.

**Rozhodnutie:** korpus sa **nenasadí** do `symbolic-melodic-v2` (gate FAIL =
stop). Pipeline zostáva ako **tréningový základ pre W1** — tam sa korpus
podmieni akordom, nie žánrom, a jeho voice-leading/harmónia je presne to, čo
chord-aware model potrebuje. Dnešné správanie je bez zmeny (bez flagu).

### W3 — „Nauč sa ma" tlačidlo: in-app personalizácia (D4) — **JADRO HOTOVÉ 2026-10-04 (WIP)**

Dnes: ★ → ledger → export → CLI python → nový ONNX → ručne nahradiť.
Cieľ: **jeden klik v appke**, bez cloudu, bez Pythonu u používateľa.

Fakt, ktorý to umožňuje: naše modely sú MALÉ (MLP 29/41/60→64→32→hlavy,
18–25 kB). Fine-tune 800 epôch na ~12 000 vzoriek je v plain JS sekundy.

**Rozhodnutie architektúry: personal = fine-tune ZO SHIPPED VÁH, nie od nuly.**
Tri dôvody v poradí dôležitosti: (1) **determinizmus** — bez random initu
zmizne RNG z osobnej cesty úplne (plán vyžadoval „seeded ako python", to je
silnejšie); (2) **regresia je vylúčená konštrukciou** — personal model je
delta na modeli, ktorý už funguje, pár ★ ho nemôže zhoršiť; (3) rýchlosť.

**Hotové (krok 1–2 z plánu):**

- `src/intent/personal-melodic-trainer.ts` — čistý TS port `train_symbolic_melodic_lib.py`
  (Adam, class-weighted CE na oboch hlavách, label smoothing). Duration hlava
  je vážená **presne raz** (regresný guard z auditu 2026-09-27). Bez RNG.
- `src/intent/personal-melodic-onnx.ts` — čítač ONNX inicializátorov
  (hand-rolled protobuf walker, žiadna dependency) + JSON (de)serializácia
  payloadu pre IndexedDB.
- `tests/personal-melodic-trainer.test.ts` (11) — vrátane **finite-difference
  gradient checku** (analytický gradient musí súhlasiť so skutočným
  gradientom hlásenej loss — rovnaký dôkaz, aký odhalil double-weight bug)
  a determinizmus (bit-identické výstupy pre rovnaký vstup).
- `tests/personal-melodic-onnx.test.ts` (8) — reader reprodukuje Gemm
  matematiku **na reálnom shipnutom artefakte** (nesprávna de-transpozícia
  by trénovala na rozbiatej mriežke).

**Ostáva (krok 3–5):** personal-model store (IndexedDB) + inference overlay v
prior workeri, personal > shipped s fallbackom, tlačidlo v IntentPanel,
A/B dôkaz (`rerank:fit` vzor), ranker personal retrain, semantic korpus
rastúci z favoritov.

- **Akceptácia W3:** ★ pack → klik → A/B report v UI; personal prior vyhráva
  nad shipped na užívateľových ★ (top-1 ≥ 70 %); bez ★ tlačidlo hlási
  „potrebujem ≥ 3".

### W4 — Producer DNA 2.0: features.v2 (D5) + proaktívne taste probes

1. **features.v2** — k 54 features pridať bass merania (rhytmická hustota,
   syncopácia, root-coverage voči progresii), chord merania (voicing pohyb,
   harmonic rhythm), arrangement (počet rolí, registra spread) + per-role
   presence flags. Contract bump = nová verzia (pravidlo §9 INTENT_ENGINE);
   ranker/pattern-features konzumenti migrujú cez dual-read (v1 pre staré
   pozorovania — ledger verzie to rieši cez `featureVersion` pin).
2. **Personal ranker bass/harmony adaptéry** prestanú byť `null` — D5 sa
   zatvára; taste-probe picker dostane dve nové osi.
3. **Proaktívne probes**: po N generáciách bez hlasovania panel navrhne
   kontrolovanú A/B otázku (picker `suggestTasteProbePair` existuje) —
   „chcem sa ťa niečo spýtať" moment, ktorý robí DAW živým.

- **Úsilie:** 4–6 blokov. **Akceptácia:** hlasovanie s reason „bass" mení
  bass-related výber; evaluation harness (`preference-evaluation.ts`) hlási
  lift > 0 na held-out; v1→v2 migrácia bez zmeny starých hashov.

### W5 — Kapela rastie: nové roly + song-level motif (D8)

1. **Nové IntentRole**: `arp` (pattern-driven arpeggiator nad progresiou —
   prior v3 z W1 ho vie conditionovať), `pad` (dlhé držané akordy/hlasy —
   existujú vo workletoch aj presetoch), `perc` (top-loop perkusie nad
   drum kitom). Schema additive (rovnaký vzor ako verse/chorus/bridge).
2. **Song inštrumentácia** per sekcia naučí nové roly (drop = +arp+pad,
   break = pad+lead…).
3. **Counter-melódia / call-response** pre lead (dva lead tracky alebo
   striedanie v phrase plane).
4. **Song-level motif**: dnes motif carry replays každý 4. bar v patterne;
   zdvihnúť na pesničku — hook sa vráti v poslednom choruse (identity
   across sections). Deterministicky cez seed namespace `base|motif:<i>`.

- **Úsilie:** 5–7 blokov. **Akceptácia:** „build a song" pre house/trap
  obsahuje pad+arp v drop; A/B test „znie to bohatšie" = ľudský listening
  (golden review pack pattern); determinizmus + golden baselines zelené.

### W6 — Referenčná inteligencia 2.0 (D-ešte-nečíslujeme)

1. **Bass transcription z 🎧 REF** — YIN už beží pre hlas (`voice-idea`);
   oktávovaný dobas + tempo/key existujú → rozšíriť `groove-extraction.ts`
   o bassline → NoteEvents („ukradni aj basovku", nielen bubny).
2. **Mix-match** — reference RMS/crest/LUFS → targety do mix profilu
   („zmieň to ako tento WAV" dnes mení conditioning; pridať mix deltas).
3. **Chunked song audition** (D9) — sekciami po 32 barov render + join.

- **Úsilie:** 3–4 bloky. **Akceptácia:** REF s jasným basom pridá bass track
  s ≥ 70 % onset recall na syntetickom zlatom súbore; audition 100+ barov
  bez zamrznutia UI.

### Explicitne NE (anti-goals)

- **Neural audio syntéza / vocals v browseri** — T5 ostáva ďaleký horizont
  (ADR 0015 plán rešpektovať); MRT2 promotion je samostatná dráha.
- **Cloud čokoľvek** — ani „opcionálny" LLM routing pre generovanie (Ollama
  localhost je hranica, ako dnes).
- **Nové veľké modely** (CLAP/YAMNet tier) pred W0–W4 — budget a marža
  hovoria za prepojenie existujúcich.
- **Rozbíjať determinizmus** pre rýchlosť — žiadna vlna nesmie zmeniť
  `seed → content hash` bez verzie engine.

---

## 5. Prioritná matrica (čo prvé)

| Vlna                     | Dopad na „killer" pocit              | Úsilie     | Závislosť   | Verdict                                                                                                                                                                                                 |
| ------------------------ | ------------------------------------ | ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W0.1 audio targets 19/19 | VYSOKÝ (správny výber ihneď)         | ~0,5 bloku | —           | **HOTOVÉ 2026-10-04** — merané, nie vymyslené: `audio-targets.generated.ts` (19/19 žánrov, RMS/crest/ZCR/bass z referenčných renderov), wiring cez `audioTargetFor()`                                   |
| W0.2 auto-diagnóza UI    | VYSOKÝ („engine mi povie čo je zle") | ~0,5       | W0.1 pomáha | **HOTOVÉ 2026-10-04** — SUNO MODE audition → analyzeSongSections → suggestSectionRevivals → chips; klik = reviseSection → náhľad → 1 undo; testy `tests/intent-song-audio-review.test.ts` (11/11)       |
| W1 melodic v3 (harmónia) | VYSOKÝ (hudobnosť AI)                | 4–6        | —           | **WIP 2026-10-04** — kontrakt v3 ✓, dataset ✓ (9592), trainer ✓ (library-pure val); valDegreeAcc 0.57 vs v2 0.5946 — gate NEPREKONANÝ, provider v3 inert až po gate                                     |
| W2 MIDI korpus           | VYSOKÝ (dlhodobá kvalita)            | 3–5        | —           | **ODHADNUTÉ 2026-10-04** — gate FAIL (degree 0.5447 → 0.4774); pipeline hotová, korpus presmerovaný do W1. Audit: `docs/W2-MIDI-CORPUS-AUDIT-2026-10-04.md`                                             |
| W3 Nauč sa ma (in-app)   | KILLER story                         | 5–8        | —           | **DRUHÁ HLAVNÁ** — jadro hotové 2026-10-04: TS tréner (fine-tune zo shipped váh, bez RNG) + ONNX reader, 19/19 testov vrátane finite-difference gradient checku; ostáva store + UI tlačidlo + A/B dôkaz |
| W4 features.v2 + DNA 2.0 | STREDNÍ-VYSOKÝ                       | 4–6        | —           | tretia štvrť                                                                                                                                                                                            |
| W5 kapela (arp/pad/perc) | STREDNÍ                              | 5–7        | W1 pomáha   | štvrtá štvrť                                                                                                                                                                                            |
| W6 reference 2.0         | STREDNÍ                              | 3–4        | —           | kedykoľvek                                                                                                                                                                                              |

**Odporúčané prvé dve PR-éka (tento týždeň):**

1. W0.1 — audio targets pre 19 žánrov (merané, nie vymyslené).
2. W0.2 — auto-diagnóza chips po song audition (čistý wiring existujúcich
   čistých funkcií).

**Prvý mesiac:** W1+W2 paralelne → gate → ship melodic v3. Potom W3 ako
návratný moment pre komunitu („DAW, ktorá sa naučí TEBÁ za 30 sekúnd —
lokálne").

---

## 6. Ako meriame, že to funguje (KPI, nie vanity)

| Metrika                          | Dnes                                      | Cieľ po vlnách                                                                                   | Meranie                                         |
| -------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| Audio rerack správnosť per žáner | nevieme (house target pre 15 žánrov)      | 19/19 vlastné targety; A/B listening W0.1                                                        | `measure-genre-references` + golden review pack |
| Melodic prior „hudobnosť"        | degree 0,5946 (bez harmónie)              | gate PASS + chord-tone recall ≥ 70 % silných dôb (W1 smoke)                                      | smoke script + gate                             |
| Tréningový korpus                | 861 base riadkov                          | 29 730 hotových (W2) + ≥ 5 000 **proti elektronickej val** s gate PASS (W1 s chord conditioning) | `gate-melodic-retrain.py`                       |
| Personalizácia                   | ranker favoriteGroups: 0; retrain len CLI | klik → A/B dôkaz ≥ 70 % top-1 na ★ (W3)                                                          | A/B harness report v UI                         |
| Producer DNA osi                 | 6 rankable reasons (bass/harmony null)    | 8 reasons (W4)                                                                                   | `preference-evaluation.ts` lift                 |
| Užívateľské „engine mi rozumie"  | —                                         | complaint chip → 1 klik → merateľná zmena (W0.2)                                                 | telemetry-free: test-only (session state)       |

---

## 7. Čo nesmie pri tomto pláne padnúť (invarianty)

1. Každé AI rozhodnutie = proposal → command (1 undo). Netreba pripomínať, ale
   W3/W5 sa dotýkajú providera — kontrakt `GenerationProvider` ostáva.
2. Determinizmus: personal retrain MUSÍ byť seeded; parity test proti python
   tréneru je povinný pred akoukoľvek aktiváciou.
3. Feature kontrakt = verzia. W1 (melodic-features-v3) a W4 (features.v2)
   idú cez nové verzie + manifest, staré artefakty zostávajú fallbackmi.
4. Každý nový dataset zdroj (MIDI pack) má licenčný manifest V TOM ISTOM
   commite ako dáta. **Len `license === "Public Domain"`** sa ingestuje
   (W2: 345 PD kusov, SHA-1 overených; `scripts/data/midi-corpus/manifest.json`
   je tracked audit trail, `.mid` súbory sú gitignored a regenerovateľné).
5. **Gate FAIL = stop.** W2 toto pravidlo uplatnil: korpus sa nenasadil, pretože
   znížil degree accuracy na elektronickom val. Audit
   `docs/W2-MIDI-CORPUS-AUDIT-2026-10-04.md` zdokumentuje meranie aj
   presmerovanie do W1 — plán sa nemení podľa výsledku, výsledok sa zapisuje.
6. Lazy worker + timeout + circuit breaker pre všetko nové (TS trainer beží
   vo Worker-i, nie na main threade).
7. `docs/CURRENT-STATE.md` + `INTENT_ENGINE.md` sa updatujú v rovnakom
   commite ako čísla, ktoré menia (pravidlo AGENTS.md).

---

## 8. Zhrnutie do jednej vety pre landing page (keď to bude pravda)

> **KYX je jediný DAW, ktorý ti vyrobí hotovú skladbu z jednej vety, ktorý si
> ju sám vypočuje a povie ti, čo opraviť — a ktorý sa z tvojich hviezdičiek
> naučí tvoj zvuk priamo v prehliadači. Bez cloudu. Bez účtu. Bez kompromisu
> na editovateľnosť.**

W0 = pravdivé hneď (targets + diagnóza), W1 = „z jednej vety hotová hudobná
skladba" (aj s MIDI korpusom — podmieneným akordom, nie žánrom), W3 =
„naučí sa tvoj zvuk", W4/W5 = „znie to ako kapela".

---

_Plan dokument: `docs/intent-killer-feature-plan.md` — 2026-10-04.
Fakty overené proti working tree; čísla z manifestov a zdrojov citovaných
v §2. Aktualizovať pri každej dokončenej vlne (statusy: PLÁN → WIP → HOTOVÉ)._
