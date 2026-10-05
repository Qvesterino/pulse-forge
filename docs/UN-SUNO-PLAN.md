# UN-SUNO — Track → editovateľný KYX projekt (plán, 2026-10-04)

> **Pitch:** hodíš akúkoľvek MP3/WAV → KYX ju rozloží na plný projekt: tempo,
> key, sekcie, drum patterny, bassline, akordy — plus mix-doctor sedne vedľa
> teba („chorus je o 3 dB tichší než verse, basa maskuje kick na 60 Hz —
> opravím?"). Všetko lokálne, žiadny cloud. Výstup NIE je MP3, ale plnohodnotný
> DAW projekt, ktorý môžeš remixovať — to je naše UX proti RipX/Samplab.
>
> **Autor:** coding agent. Rešerš: `D:\beat_modifier` (predchádzajúci pokus,
> Python — recepty sa portujú, aplikácia nie), `src/reference/` (F1–F5),
> `src/intent/groove-extraction.ts`, `src/audio-workers/pitch-tracker.ts`,
> `src/analysis/mixDoctor.ts`.

---

## 1. Čo už máme (a netreba robiť nanovo)

Toto je prekvapivo veľa — polovica UN-SUNO už existuje ako Referenčná mapa:

| Kameň                                          | Kde                                                                                         | Stav                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Tempo + beat grid + kandidáti + stability      | `src/reference/analysis/{tempoCandidates,beatGrid}.ts` (worker)                             | hotové, F1                                                                                |
| Key + chroma + Camelot + kandidáti             | `src/reference/analysis/tonal.ts`, `dsp/{chroma,fft,keyProfiles}.ts` (worker)               | hotové, F1                                                                                |
| Energy curve → sekcie → markery                | `src/reference/structure.ts` (role intro/drop/breakdown/…, sec+beat dvojito)                | hotové, F2                                                                                |
| Spektrál/loudness/stereo/groove deskriptory    | `src/reference/descriptors.ts`                                                              | hotové, F2                                                                                |
| Celý worker pipeline + progress                | `src/reference/workers/reference.worker.ts`, `reference-client.ts`                          | hotové — nové štágy sa pridávajú do tej istej schémy                                      |
| Apply seam (mapa → commands, 1 undo)           | `src/reference/apply.ts` (`bpmCommand`, `keyCommand`, `markerCommand`, `grooveCommand`)     | hotové pre bpm/key/markery/groove                                                         |
| Drum onsety → 16-step rows → pady              | `src/intent/groove-extraction.ts` (`extractGrooveGrid`, `grooveRowsForPads`)                | hotové, wired v IntentPanel REF flow; limit: jeden hit/step, jeden pattern pre celý súbor |
| Microtiming (swing/humanize/step offsets)      | `src/audio-engine/groove-extract.ts` (`extractGroove`: timing/accent/swing)                 | hotové, čaká na zapojenie do UN-SUNO groove inštalácie                                    |
| YIN pitch tracker (worker, anti-subharmonic)   | `src/audio-workers/pitch-tracker.ts` (`trackPitch`, 70–1050 Hz, clarity gate)               | hotové; na bass treba parametrizovať fmin/fmax                                            |
| Mix doctor (LUFS, 7 pásiem, stereo, flagy)     | `src/analysis/mixDoctor.ts` + `deriveMixAutoFix`                                            | hotové na buffery; chýba per-sekcia + „maskovanie kick↔basa" heuristika                   |
| Per-sekcia RMS/peak                            | `src/intent/song-audio-review.ts` (`analyzeSongSections`, `suggestSectionRevivals`)         | hotové                                                                                    |
| MP3/WAV decode + 25 MB cap + persistence       | `src/ui/DropZone.tsx`, `src/ui/sample-import.ts`, `src/persistence/UserSampleRepository.ts` | hotové                                                                                    |
| Warp (audio na projektové BPM, pitch-preserve) | `src/audio-engine/warpManager.ts` + `src/audio-workers/warp-render.ts`                      | hotové (live==export parita)                                                              |
| Patterns/notes model + commands                | `src/commands/patterns.ts` (`createPattern`), `src/commands/notes.ts` (`addNote`)           | hotové                                                                                    |

## 2. Čo portíme z `D:\beat_modifier` (recepty, nie aplikácia)

beat_modifier (Python, librosa) má overené presne tie tri chýbajúce kúsky.
Portujeme **algoritmy do TS workerov**, nič iné (žiadny FastAPI/numpy_synth/
inspiration planner — intent engine túto rolu už má):

1. **`_band_onsets_to_pattern`** — bandpass (FFT mask) → onset strength →
   quantize na 16-step grid → **median-prune** (ak >75 % krokov svieti, odrež
   slabé onsety pod median×threshold). Bandy: kick 40–120 Hz, snare 150–800 Hz,
   hat 6 k+. Naše `extractGrooveGrid` robí podobné, ale bez median-prune a bez
   separácie snare vs hat podľa pásma (má ZCR heuristiku). Port = robustnejšie
   patterny v mixe.
2. **`_extract_bass_line`** — bandpass 30–300 Hz → pyin (fmin 40, fmax 200) →
   skupinovanie framov do nôt (`min_note_frames` ≈ 40 % doby, re-clamp do
   basového rozsahu MIDI 24–60) → velocity z voiced_prob. **Scale-snap robíme
   ako voliteľné** (vypnuté default — poctivosť: transkripcia, nie oprava).
3. **`_extract_chords`** — chroma per bar (priemer framov baru) → template
   skóre cez 7 stupňov × {maj, min, dom7, min7, sus4}: súčet chromy akordových
   pitch classes **− 0,3 × súčet ne-akordových** (tlmí overtone šum) → merge
   opakujúcich → `ChordSpec{degree, function, quality}`. Presne sedí na náš
   `ChordEvent` shape (`src/ai/harmony.ts`) — generátor/progresie ostávajú,
   pribúda rozpoznávanie.
4. **`_extract_groove`** — odchýlka onsetov od gridu → per-step push/pull ms,
   swing (priemer nepárnych krokov, normalizovaný na ±1), humanize (σ). Naše
   `audio-engine/groove-extract.ts` robí to isté — **skontrolujeme paritu a
   necháme jedno** (preferujeme existujúce KYX).

Čo portovať **nechceme**: celú Python appu, render backend, similarity
diagnostics (odložené — možno neskôr ako advisory), inspiration-spec planner.

## 3. Čo CHÝBA (gap analyýza)

| Gap                                                          | Riešenie                                                                                                                                                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Chord transcription** (chroma → ChordEvent[] per bar)      | nový `src/reference/analysis/chords.ts` (pure) + štág vo workeri; výstup do `ReferenceMap.tonal.chords?`                                                                                            |
| **Bass transcription** (→ NoteEvent[])                       | bandpass + parametrizovaný pitch-tracker (fmin 30) + segmentácia (reuse `src/midi/hum-to-notes.ts` logiky) → `ReferenceMap` nový field `melodic?`                                                   |
| **Drum patterny PER SEKCIA** (dnes 1 pattern pre celý súbor) | `extractGrooveGrid` volať po oknách sekcií zo `structure.sections`; + median-prune z beat_modifieru; multi-hit per step cez band separáciu                                                          |
| **Rekonštrukcia do projektu** (mapa → tracks/patterns/lanes) | nový `src/reference/unsuno.ts`: pure `(doc, map, options) → Command` (compound, 1 undo): bpm/key/tracky/patterny per sekcia/arrangement/audio lane originálu/markery/groove                         |
| **Mix-doctor na ZDROJ** (per-sekcia + kick↔bass masking)     | rozšíriť `mixDoctor` o per-sekcia band shary (máme `analyzeSongSections` + 7-band) + masking heuristiku (bass-band energia v sekcii vs kick transient) → findings + `deriveMixAutoFix` fix tlačidlá |
| **UX flow** (import → potvrdenie → BUILD PROJECT)            | Confirm dialog (tempo reading half/double, key correction, sekcie editovateľné — UI už v ReferenceMapPanel má Corrections tab) + progress + honest degradation                                      |

## 4. Vlny (každá = samostatné PR-éko, standing gates)

### U0 — Golden transkripčný harness (meranie PRED features) — **HOTOVÉ 2026-10-04**

Postav testovaciu základňu skôr než jeden riadok feature kódu (lekcia z
W0.1 „merané, nie vymyslené"):

- `scripts/gen-unsuno-golden.mjs`: vezme známe KYX projekty/patterny (syntetické:
  kick pattern X + bassline Y + progresia Z, 3–5 žánrov), **renderuje cez
  `renderProject`** do `tests/unsuno-golden/*.wav` + uloží ground-truth JSON
  (patterny, nóty, akordy, bpm, key).
- `tests/unsuno/golden-set.test.ts`: metriky — drums step F1, bass onset recall
  - pitch accuracy, chords per-bar accuracy, tempo error, key top-1.
- Tolerancie cieľov (nižšie v §5) sa **locknú do testu** — každá vlna ich smie
  len zlepšovať.
- **Úsilie:** ~0,5 bloku. **Riziko:** žiadne (čisté testy + render).

**Ako to dopadlo (SHIPPED, 26 testov):** dizajnová zmena — syntetizátor je
on-the-fly pure TS (`tests/unsuno/golden-synth.ts`, 5 žánrov: house 126/am,
techno 130/em, boombap 90/cm, trap 140/f#m, dnb 174/gm), nie `renderProject`
(jsdom nemá WebAudio; binaries by neboli deterministické naprieč strojmi).
WAV export ostáva ako `npm run unsuno:golden` pre owner ear-pass.
Metriky = `src/reference/unsuno-metrics.ts` (self-testy), kontrakt =
`src/reference/transcribe.ts` (`transcribeTrack`, pending vrstvy
`implemented:false` + warning — nikdy vymyslený obsah). U1/U2/U3 KPI bloky sú
v teste dormantné cez `skipIf` — aktivujú sa samé, keď vrstva flipne
`implemented:true`. **Live baseline zamknutý per-track:**

| track   | tempo (truth)       | key                |
| ------- | ------------------- | ------------------ |
| house   | 118 vs 126 (err 8)  | A Natural Minor ✓  |
| techno  | null vs 130         | E Natural Minor ✓  |
| boombap | null vs 90          | C Natural Minor ✓  |
| trap    | 110 vs 140 (err 30) | **A** ✗ (truth F#) |
| dnb     | null vs 174         | G Natural Minor ✓  |

**Key KPI (≥0,8) splnené dnes: 4/5 exact vrátane modu.** Tempo NESPLNENÉ —
`estimateTempo` dáva null na 3/5 (detectTransients nachádza len 2–11 z ~100
udalostí na polyfónnom materiáli → riedky envelope) a miss 8/30 BPM na
zvyšku (20 ms bin autokorelácia bez interpolácie).

### U0.5 — Tempo/onset floor (nová vlna z U0 nálezov, PRED U1) — **HOTOVÉ 2026-10-04**

- `detectTransients`: adaptívny threshold na polyfónii (abs+rel mix alebo
  band-limited flux) — cieľ ≥ 60 % drum udalostí na golden sete.
- `estimateTempo`: parabolic interpolation okolo autokorelačného peaku +
  envelope hustejší ako 20 ms — cieľ fold error ≤ 1 BPM na 5/5.
- Trap key miss: chroma cez prvých 6 s vs trap progresia — skúmať region
  výber (tonalRegion middle?) — cieľ 5/5 exact.
- **Akceptácia:** re-lock baseline testu (zlepšenie = zámerný re-lock commit).

**Ako to dopadlo (SHIPPED):** `estimateTempo` je prestavaný na multi-band
spectral flux + `estimateTempoCandidates` (parabolic + prior) — tú istú
overenú F1 DSP, ktorú už má Reference Map; zdieľaný `detectTransients`
(11 konzumentov) zostal nedotknutý. **Fixture bug namiesto estimátorového**:
trap key miss spôsoboval zlatý synth — jeho progresie mali všetky akordy
`min`, ale D/A/E vo F#-mol sú MAJOR (F natural v Dm otrávil chromu); opravené
na diatonickú pravdu (house F/C/G maj, trap D/A/E maj, dnb Eb/Bb/F maj,
boombap Bb/Eb maj7). Výsledok: **tempo 5/5 fold error ≤ 0,2 BPM** (126.0 /
130.0 / 89.9 / 139.8 / 86.9 half-time) a **key 5/5 exact vrátane modu** —
obe KPI splnené, baseline re-locked. `estimateTempo` teraz vracia 0,1 BPM
presnosť (float), konzumenti (audio-reference patch, groove-extraction,
voice-idea) prešli bez zmeny — ich testy 34/34 zelené.

### U1 — Chord transcription (chroma → ChordEvent[]) — **HOTOVÉ 2026-10-04**

- `src/reference/analysis/chords.ts` (pure): per-bar chroma segment → template
  skóre (beat_modifier recept vrátane −0,3 penalty) → degree/quality mapované
  proti **detegovanému** key z F1 → merge opakov → confidence (separácia
  best/2nd + bass-pitch-class prior, ak U2 už beží — inak bez neho).
- Worker štág `chords` za `tonal`; `ReferenceMap.tonal.chords?:
{degree, quality, bars, confidence}[]` + `warning` pri nízkej confidence.
- **Akceptácia:** per-bar accuracy ≥ 0,90 na golden sete; na drums-only
  rendroch prázdne + warning (nie vymyslené akordy); determinizmus (rovnaký
  WAV → rovnaké akordy).
- **Úsilie:** ~1 blok.

**Ako to dopadlo (SHIPPED, `transcribeTrack` wiring + KPI gate ACTIVE):**
recept z beat_modifier sa po zlatom ladení zmenil na hybrid — tri lekcie,
ktoré dal U0/U1 kalibračný cyklus:

1. **Raw in-chord share nevie rooty** (F maj ≡ Dmin7 zdieľa 3/4 tónov;
   4-tónové šablóny podvádzajú zbieraním kick-sweep tónov) → ROOT/TONALITA =
   KK korelácia (rovnaké profily ako key lane) na full-weight chrome.
2. **Sevenths bez voicingu neexistujú** — kick sweep fake-uje 7. tón →
   QUALITY decision beží na oct1+ chrome (kick je oct0) a seventh musí
   prekročiť OBA prahy: 0,6× najslabší triádny tón a 0,25× root.
3. **Bbmaj7 ≡ Dm6 chromaticky** — jediný poctivý rozlišovač je basa:
   `BASS_ROOT_SHARE 0.2` + bonus 0,12 (dnb sub-basa 58 Hz žije pod oct0,
   hlasuje cez 2. harmoniku — preto threshold 0,2).

Výsledok na golden sete: **exact (root+quality) 36/36** (house 8/8, techno
8/8, boombap 4/4 vrátane min7+maj7, trap 8/8, dnb 8/8 cez half-time grid
konverziu `expandChordSpans`), drums-only → prázdne + warning (corr gate
0,55; drums max 0,487), silence → skip s warningom. Kontrakt: `TranscribedChordSpan`
(špan + degree/func proti detegovanému key), determinizmus zamknutý.

**Key floor re-lock (poctivý downgrade 5/5 → 3/5):** diatonické basy odhalili
KK rotačnú ambivalenciu — trap progresia je diatonická v D major aj F#-mol;
plain chroma nevie vybrať rotáciu bez tonic-hintu. Misy (trap→D maj,
dnb→Eb maj) sú diatonicky príbuzné škály (rovnaký PC set). **U1.5 SHIPPED — key
z chord-sekvencie:** `deriveKeyFromChords` skóruje všetkých 24 rotácií (diatonic fit +
tonic-presence bonus + first chord ×3 + last ×1.5 + mode-match 0.25) a `transcribeTrack`
ho používa PRIMÁRNE — estimateKey zostáva fallbackom pre materiál bez čitateľnej harmónie
(drums-only → derived null). Key floor späť na **5/5 exact** (trap F# minor, dnb G minor —
rotácie správne). Tempo floor nezmenený (5/5, err ≤ 0,2).

- Pitch-tracker parametrizácia: `trackPitch(data, sr, {fminHz, fmaxHz})`
  (default dnešný 70–1050; UN-SUNO volá 30–250). Worker ostáva jeden.
- `src/reference/analysis/bass.ts` (pure): bandpass 30–300 Hz (FFT mask ako v
  beat_modifier, ale v referenčnom DSP — `dsp/fft.ts` už je) → trackPitch →
  segmentácia (min duration ~40 % doby, clarity gate) → NoteEvent (ticks od
  beat gridu, velocity z RMS/clarity) → scale-snap **opt-in**.
- Per-sekcia coverage + confidence; sekcia pod gate → prázdna + poznámka.
- **Akceptácia:** onset recall ≥ 0,70 a pitch accuracy ≥ 0,90 na golden sete
  (číslo 0,70 je už zadané v W6 pláne pre bass transcription); 808 sub-bass aj
  walking bass golden; výkon: 3-min track analyzovaný vo workeri < ~10 s.
- **Úsilie:** ~1 blok. **Riziko:** polyfonný mix — rieši bandpass + clarity
  gate + honest empty.

### U2 — Bass transcription (→ NoteEvent[]) — **HOTOVÉ 2026-10-04 (honest-partial, floors locked, KPI čaká U2.5)**

- Pitch-tracker parametrizácia: `trackPitch(data, sr, {fminHz, fmaxHz, hopMs})`
  (default dnešný 70–1050; UN-SUNO volá 40–250). Worker ostáva jeden.
- `src/reference/analysis/bass.ts` (pure): bandpass 30–300 Hz (FFT mask ako v
  beat_modifier, ale v referenčnom DSP — `dsp/fft.ts` už je) → trackPitch →
  segmentácia (min duration ~40 % doby, clarity gate) → NoteEvent (ticks od
  beat gridu, velocity z RMS/clarity) → scale-snap **opt-in**.
- Per-sekcia coverage + confidence; sekcia pod gate → prázdna + poznámka.
- **Akceptácia:** onset recall ≥ 0,70 a pitch accuracy ≥ 0,90 na golden sete
  (číslo 0,70 je už zadané v W6 pláne pre bass transcription); 808 sub-bass aj
  walking bass golden; výkon: 3-min track analyzovaný vo workeri < ~10 s.
- **Úsilie:** ~1 blok. **Riziko:** polyfonný mix — rieši bandpass + clarity
  gate + honest empty.

**Ako to dopadlo (SHIPPED):** `src/reference/analysis/bass.ts` — 24 dB/oct RBJ
low-pass 300 Hz + decimácia ×8 (YIN nad zvyškom beží 8× lacnejšie) →
parametrizovaný pitch-tracker (`{fminHz: 40, fmaxHz: 250, hopMs: 20}`; 30 Hz
z receptu povolovalo subharmonické oktávy) → segmentácia (median-pitch runy,
min ~1/3 16th) → gap-merge → velocity z mean clarity. **CHORD-TONE PRIOR** =
U1 zbraň proti kicku: per-bar rooty z chord lane filtrujú framy mimo
root/third/fifth/seventh; bez čitateľnej harmónie bass lane **odmietne hádať**
(honest skip). Clean-material unit testy 8/8: dve noty / pitch zmena / 808 sub
F#1 46 Hz / snap shortest-shift / low-pass atenuačné piny — 100 %.

**U2.5 SHIPPED — kick-tail mask (2026-10-04):** `kickTailMask` v bass.ts —
low-band (≤120 Hz) energia per 10 ms frame; frame je UNVOICED kým decayuje z
transientného spike. Spike signatúra TRIACKO: >1,6× track medián + strmý
rising edge (>1,45× predchádzajúceho frame) + **look-ahead decay** (energia
180 ms neskôr < 55 % spike — bass onset SUSTAINUJE ~90 %, kick chvost
decayuje — clean material tak ostáva netknutý, overené: 808 nota 0.00+0.69 s
celá). Plus: hop 20→10 ms, re-anchor (nota začína NA maske, cap 200 ms),
merge len pre skutočné gapy (re-anchored prekryvy sa neglujú). Trade-off
zamknutý do floors: **precision/pitch-class výrazne hore** (house prec
0.37→0.70, techno/dnb/trap pc → 100 %), recall dole kde maska odstránila
phantom-matchy (techno 0.50→0.09 — synth kick sedí V 16th-bounce base a
YIN subharmonický bleed cez E1/E2 sloty je dokumentovaný U2.6 problém, nie
mask). Drums-only zostáva honest-empty.

**Známa medzera (U2.5 vlna, ďalšia):** syntetický kick je čistá sínusová
sweep niekoľko dB HLASNEJŠIA ako bass — jeho chvost (48–52 Hz) má VYŠŠIU
YIN clarity než bass fundamental a prejde priorom, keď terminálna výška =
akordový tón. Diag: house recall 0.50 / pc 100 %, techno 0.50, boombap 0.42,
trap 0.69, dnb 0.25 — pitch-class accuracy vysoká (house 100, trap 82),
presná oktáva trpí. Plán U2.5: transient-gated voicing (kick onsety z flux
envelope maskujú ~80 ms okolo seba) + bass-vs-kick energetický diskriminátor
per frame. Floors zamknuté do golden-set.test.ts (zlepšenie = zámerný
re-lock). `transcribeTrack` wiring: bass implemented od U2, warnings honest
(no chord context / no pitched bass / no bar grid).

### U3 — Drum map per sekcia + robustizácia

- `extractGrooveGrid` dostane `windowSec?` a volá sa po sekciách; pridá
  median-prune; snare/hat separácia cez band onsets (beat_modifier bandy) namiesto
  len ZCR heuristiky; multi-hit per step (kick+hat na jeden step = dva riadky).
- Microtiming per sekcia z `audio-engine/groove-extract` → do groove inštalácie.
- **Akceptácia:** step F1 ≥ 0,85 na golden sete per sekcia; žánrové pokrytie
  (four-on-floor vs breakbeat vs half-time goldeny).
- **Úsilie:** ~1 blok.

### U3 — Drum map per sekcia + robustizácia — **HOTOVÉ 2026-10-04 (core, honest-partial floors; U3.5 zostáva)**

`src/reference/analysis/drums.ts` (štart od paralelnej session, dokončené a
doladené touto vlnou): FFT band energy envelopes (kick 40–120, snare 150–800,
hat 6k+ Hz) → per-step okná. **Kick = percussiveness diskriminátor** (attack/
sustain ratio ≥ 2.2 — bassa v tom istom pásmu SUSTAINUJE, kick decayuje; band
alone chytil každý bass onset). **Snare = broadband gate** (snare noise siaha
do hat bandu, bass harmonics nie — magnitude threshold zlyháva, bass 2./3.
harmoniky sú v snare band rovnako loud). **Phase 0 pre obe bandy** — count
sweep nevie fázu na hustom materiáli (60 ms okno chytí každý hit pri každej
fáze) a mass tie-break vybral pol-krok shift. KPI pattern-level (truth =
union slotov cez bary, ±1 krok): kick recall 1.00 všade, F1 house 0.91 /
techno 0.94 (±1); snare EXACT 1.00 na techno/boombap/trap; hat aligned
(house 0.80). **Floors zamknuté** do golden-set.test.ts.

**Wiring:** `transcribeTrack` → `drums.implemented: true` s
`TranscribedDrums {kick,snare,hat: number[]}` (pattern slots); `unsunoCommand`
inštaluje drum track + rows cez **inferPadRole** (nikdy index): kick/snare/hat
na prvé resolved pady, rows[padId][step] = velocity.

**U3.5 zostáva:** snare↔hat cross-talk (hat noise svieti v snare band ~1:1 —
per-step dominance ratio zlyhal, ratia na parite) a dnb half-time grid
reconciliation (86.9 vs 174 — dnb floors nízke). Taktiež per-section mapy
(teraz jeden pattern foldovaný cez track).

### U5 — Mix-doctor vedľa teba — **HOTOVÉ 2026-10-04**

`src/analysis/sectionMixDoctor.ts` — pure `analyzeSectionMix(channels, sr,
sections)` s DVOMI konzervatívnymi heuristikami: **section balance**
(sekcia ≥3 dB pod mediánom sekcií → „„drop" je o 3.2 dB tichšia než medián
sekcií", report-only — fix je hudobný, nie master) a **low-end masking**
(low band ≤120 Hz > 55 % energie sekcie + transient contrast < 1.7 → „basa
môže maskovať kick okolo 60–120 Hz", report-only; prahy kalibrované na
golden sete — reálny kick mix NESPÚŠŤA heuristiku, bass-only drone áno).
Master mechanické fixy (tilt / master trim na −1 dBFS) ostávajú v
`mixDoctor.deriveMixAutoFix` — panel po BUILD PROJECT meria oboje a renderuje
chips (`unsuno-mix-findings`): report chips + voliteľný „🔧 Opraviť" chip
(Sk `setMasterConfig` patch, jedno ďalšie undo). **Etiketa W0.2 zamknutá
testom**: čistý mix → prázdne findings → chips NESVIECIA; UI test to pinuje
na golden house renderi. Testy 6/6 pure + etiketa v UI suite.

### U6.5 / U3.5-maps / worker / U7 — štyri vlny po dokončení kampane — **HOTOVÉ 2026-10-06**

- **U6.5 (`4504033a`)** — source lane cez UX: `pf:unsuno-analyze` event nesie
  `{ file, sampleId }`, panel si ho pamätá, `unsunoCommand` dostáva
  `sourceSampleId` a po executne zohreje clip cez `warmWarpForClip`. Celý
  príbeh (drop → analyze → BUILD → originál na lane, warped) je klikateľný.
- **Per-section drum mapy (`af304e6d`)** — `transcribeTrack` prijíma
  `{ sections }` a re-transcribuje drum mapu v každom okne (≥1 s; kratšie sa
  preskočia, nikdy nevymyslia). `unsunoCommand` preferuje section mapu
  pokrývajúcu chunk midpoint, fallback = whole-track fold (rows nikdy
  prázdne preto, že okno minulo). Drop a break môžu mať rôzne bubny.
- **Worker (`d1a9fc91`)** — `transcribeTrackAsync` dispatchuje
  `TRANSCRIBE_TRACK` do reference workera (PCM kópiou, sync fallback pod
  2 s / bez module workerov); panel await-uje async klienta — 3-minútový
  track už nezamrzne UI. Parita so sync jadrom zamknutá testom.
- **U7 (`ee88e525`)** — lead/vocal melody layer: HP 120 Hz (bass LP +
  subtract) → pitch tracker 150–1050 Hz → prísne gatey (clarity 0.65+,
  stabilné runy, min coverage) → inak honest-empty. `transcription.melody`
  - sampler lead track v rekonštrukcii (pluck default, noty 36–96).

### U6 — UX flow — HOTOVÉ 2026-10-04

- **ReferenceMapPanel „🎛 BUILD PROJECT"** (vedľa Export JSON): dvojkrokový
  confirm → transcribeTrack na analyzovaný signál (yield frame pred sync
  behom) → unsunoCommand s panel corrections (user korekcie vyhrávajú; bez
  nich vedie chord-sequence key z transkripcie) → jeden store.execute →
  applied status s honest summary + „(one undo step)". Sekcie z
  map.structure.sections.
- **DropZone shortcut**: po importe jedného súboru ponuka „🎛 UN-SUNO:
  analyzovať → projekt" — pf:unsuno-analyze CustomEvent s File; panel si ho
  vyzdvihne (ak je pripojený) a pustí vlastný analyze flow.
- **Testy** tests/ui/reference-unsuno-build.test.tsx (3): reálny reťazec
  file → decodeAudioData mock → analyze → BUILD → confirm → PRÁVE JEDEN
  store.execute s type unsuno; neighbors 81/81.

### U4 — Rekonštrukcia: `unsunoCommand` (mapa → projekt, 1 undo)

- `src/reference/unsuno.ts` (pure, apply.ts style):
  - bpm/key cez existujúce `bpmCommand`/`keyCommand` (rešpektujú confirmed
    corrections z panelu);
  - tracky: drum kit (žáner hint z AST labelu ak je `pf:audio-tag` on, inak
    default kit), bass nástroj (presets/factory pick podľa žánru), chord/pad
    nástroj — **recyklujeme template starters** (`src/project-model/templates.ts`);
  - patterny per sekcia (rows z U3, bass notes z U2, chords z U1 → pad akordy
    cez existujúci `expandProgression`-kompatibilný zápis);
  - arrangement: sekcie → lanes/scenes + markery (structure.ts mapovanie už je);
  - **audio lane originálu**: AudioClip track so zdrojovým WAV (user sample
    persistence), voliteľne warp na projektové BPM cez WarpManager (default
    ON pri odchylke >1 %, čestné upozornenie pri veľkej chybe gridu);
  - groove microtiming inštalácia (swing/humanize z U3).
- Celé = jeden compound command → **jedno Ctrl-Z odstráni rekonštrukciu**.
- **Akceptácia:** round-trip test — vygenerovaný doc prejde schema validáciou,
  offline `renderProject` exituje bez chýb (znie = ear pass na userovi),
  1 undo = čistý pôvodný doc; bundle budget netknutý (žiadny nový model).
- **Úsilie:** ~1–1,5 bloka. **Riziko:** rozsah — držať sa apply.ts vzoru
  (pure + commands), žiadna logika v UI.

### U4 — Rekonštrukcia: `unsunoCommand` — **HOTOVÉ 2026-10-04 (core; audio lane = U4.5)**

`src/reference/unsuno.ts` — pure `(doc, input, options) → UnsunoResult` v apply.ts
kontrakte: jeden reduce cez plain commands + JEDEN `snapshot()` (jedno Ctrl-Z).
Inštaluje: BPM (+ confirmed override, half/double reading), project key
(musicalKeyFor konverzia, confirmed override), **tracky len keď vrstva nesie
obsah** (drum track — zatiaľ skip s honest warningom kým U3 nedodá rows
kontrakt; bass `"bass"`; chords `"keys"`), **1 pattern per section chunk**
(≤ 8 barov = 128-step ceiling; dlhšie sekcie chunkované `<role> pt N`),
pattern obsahuje chord voicingy (voiceLead, multi-voice konvencia, spans →
NoteEventy), bass noty (sekundy → ticky v sekciinom okne), scény per pattern,
markery na section starts. Deep-frozen dokument: pattern sa REBUILDuje spread-om
(snapshot kontrakt — in-place mutácia padá na "object is not extensible").

**Testy (tests/unsuno/reconstruct.test.ts, 5):** reálna transkripcia golden
house tracku → BPM 126 + A Natural Minor + bass/keys tracky + 2 patterny
(stepCount ≤ 128) + scény + markery + undoStackLength 1 + undo = bit-exact
restore; confirmed overrides; half/double reading; no-tempo → null command +
poctivý summary; determinizmus (uid sa líšia by design — porovnáva sa hudobná
štruktúra: names/stepCounts/note shapes/scenes).

**U4.5 SHIPPED — source-audio lane (2026-10-04):** `unsunoCommand` options
`sourceSampleId` (bank id importovaného originálu — caller importuje cez
user-sample flow PRED rekonštrukciou) → sampler carrier track + JEDEN
arrangement AudioClip (gain 0.9, fadeOut 0.01). **stretchRate = čistý BPM
ratio** (projekt grid / detected tempo, clamp 0.25–4) — length-fit rate by
fractional bary potichu absorboval tempo rozdiel; ratio spôsobí warp poctivo
a `result.needsWarpWarm` povie calleru zohriať WarpManager po execute
(command ostáva pure). Testy 7/7: clip inštalovaný (8.26 barov, rate 1 pri
126/126, sampler carrier), undo bit-exact, warp warm flag pri 128/126 →
1.016 (> 1 — rýchlejší grid prehrá originál rýchlejšie).

### U5 — Mix-doctor vedľa teba (per-sekcia + masking)

- Rozšírenie `mixDoctor`: per-sekcia LUFS/band shary (7 pásiem už sú) →
  „chorus −3 dB vs verse" finding; masking heuristika: bass-band (60–120 Hz)
  energia v sekcii vs kick transient energia → „basa maskuje kick na 60 Hz".
- Findings → chips s fix tlačidlami cez existujúci `deriveMixAutoFix`
  (tilt/master IN — report-only ostatné, ako dnes).
- **Akceptácia:** syntetický render s tichým chorusom → finding svieti; fix =
  1 undo; bez merania chip nesvieti (etiketa z W0.2).
- **Úsilie:** ~0,5–1 blok.

### U6 — UX flow + entry point

- ReferenceMapPanel: „→ 🎛 BUILD PROJECT" CTA (mapa musí byť hotová = aspoň
  rhythm+structure; chords/bass s warningmi sú dobrovoľné);
- confirm dialog: tempo reading (as-detected/half/double — UI Corrections už
  existuje), key, sekcie editovateľné, voľby (audio lane on/off, warp on/off,
  scale-snap off);
- progress stage labely (worker už streamuje štágy);
- honest degradation: „bass nejasný v sekcii 2 — pattern ostáva prázdny";
- DropZone shortcut: drop MP3 → ponuka „analyzuj / importuj ako sample".
- **Akceptácia:** E2E smoke — drop synthetic golden WAV → projekt sa otvorí s
  trackmi; Playwright scenár do `tests/e2e/`.
- **Úsilie:** ~0,5–1 blok.

**Celkom ≈ 6–7 agent-blokov.** Poradie U0→U1→U2→U3→U4→U5→U6 je lineárne
(U4 potrebuje 1–3; U5/U6 paralelizovateľné s U4).

## 5. KPI (nie vanity)

| Metrika                  | Cieľ (golden synthetic)                               | Poznámka                                      |
| ------------------------ | ----------------------------------------------------- | --------------------------------------------- |
| Drums step F1 per sekcia | ≥ 0,85                                                | U3                                            |
| Bass onset recall        | ≥ 0,70                                                | číslo prebraté z W6 akceptácie                |
| Bass pitch accuracy      | ≥ 0,90                                                | U2                                            |
| Chords per-bar accuracy  | ≥ 0,90                                                | U1                                            |
| Tempo                    | ±0,5 BPM (synthetic); half/double správne na reálnych | F1 už existuje, len meriame                   |
| Key top-1                | ≥ 0,80                                                | F1 existuje                                   |
| Rekonštrukcia            | renderuje offline, 1 undo čistý                       | U4                                            |
| Owner ear-pass           | 5 reálnych CC trackov                                 | sekcie majú hudobný zmysel (subjectívny gate) |

## 6. Poctivosť a hranice (anti-goals z beat_modifier preberáme)

- **Nie je to stem extractor ani bit-exact dekonštrukcia.** Výstup je
  _transkripčný štartovací bod na remix/learning_ — povieme to v UI explicitne.
- **Lokálne navždy** — žiadny upload, žiadny cloud, žiadny YouTube downloader;
  používateľ hodí súbor, ktorý má (DropZone 25 MB cap zostáva).
- **Nič sa nevymýšľa**: sekcia pod confidence gate = prázdny pattern +
  poznámka, nikdy generovaný obsah vydávaný za transkripciu (rovnaké pravidlo
  ako apply.ts honesty rules #1).
- **Detected ≠ confirmed** — rekonštrukcia vždy konzumuje hodnoty z obrazovky
  (corrections), nie surovú detekciu.
- **Žiadne nové veľké modely** v MVP — čistý DSP; AST žánrový hint zostáva
  opt-in (`pf:audio-tag`). ONNX refinements (napr. chord model) až keď DSP
  verzia nedorazí na KPI — a až potom s manifest+gate ritualom.

## 7. Architektúra (invarianty, ktoré nesmieme porušiť)

- Ťažká analýza **vo workeri** (`reference.worker.ts` štágy; pitch-tracker
  worker pre bass) — main thread nikdy.
- **Pure analysis + commands** — `unsuno.ts` je `(doc, map, options) → Command`,
  testovateľné bez Reactu; UI len opisuje intent (AGENTS #1/#2).
- **Jedno undo** pre celú rekonštrukciu (compound/snapshot — vzor apply.ts #3).
- **Live == offline parita** — audio lane/warp ide cez WarpManager (rovnaká
  cesta pre scheduler aj renderer).
- **Determinizmus** — rovnaký WAV + rovnaké options → rovnaký projekt (žiadný
  RNG v transkripcii; `seed`-ované len generatívne doplnky, ak nejaké pribudnú).
- **Schema**: ak rekonštrukcia pridá do projektu čokoľavo nové (napr. metadata
  o pôvode), bump `SCHEMA_VERSION` + migrácia. MVP: nič nové do schémy.

## 8. Otvorené otázky (rozhodnúť pred U4)

1. **Vokály a lead** — MVP ich nerozkladá (originál zostáva na audio lane);
   melody transcription (YIN 300–2 kHz) je kandidát na vlnu U7 ak budú KPI.
2. **Pattern granularity** — 1 pattern per sekcia vs per N barov (opakujúce sa
   2-barové frázy). Začať per sekcia, dedup merge ako follow-up.
3. **Kit mapping bez AST** — default kit stačí? Alebo groove family
   (four-on-floor/breakbeat/half-time z deskriptorov) → kit pick.
4. **Similarity advisory** (beat_modifier to má) — zatiaľ NE; po U6 rozhodnúť.
