# HUM A HIT — cesta od wedge ku killer feature

> Implementačná roadmapa pre hum→voice: ako z "nahumuj si hook" spraviť
> killer feature KYX. W1–W3 vokálnej kampane (2026-10-10/12) dodali strojovňu;
> tento dokument je plán, ako z nej spraviť produkt, ktorý si ľudia otvoria zámerne.
>
> Status: PROPOSED · Autor: intent/vocal campaign sessions · Posledná aktualizácia: 2026-10-12

---

## Prečo to je killer feature kandidát

SUNO spieva **cudzím hlasom**, neupraviteľne, v cloude. KYX môže spievať
**tvojím hlasom**, po-notu editovateľne, offline, s nulovým licenčným rizikom.
To je štrukturálny rozdiel, nie rozdiel kvality modelu — a presne preto je to
defendovateľné.

**Produktový príbeh v jednej vete:** _"Nahumuj si melódiu — KYX okolo nej
postaví celú skladbu a zaspieva ju tvojim hlasom."_

## Kde sme dnes (W1–W3, všetko shipped)

| Kus                                 | čo robí                                                                   | commit          |
| ----------------------------------- | ------------------------------------------------------------------------- | --------------- |
| `hum-to-notes.ts`                   | hum nahrávka → NoteEvents (YIN)                                           | existujúce      |
| `src/vocal/analyze.ts` + `adapt.ts` | VocalProfile (tempo/key/frázy) + `applyVocalHookCommand` (vocalchop hook) | V1–V3           |
| `src/vocal/prosody.ts` (W2)         | lyrics → slabiky → spievateľná mriežka; `shapeMelodyToLyrics`             | `2ea5123a`      |
| `src/vocal/voiceify.ts` (W3)        | hum audio → ladený lead (autokorelácia + seamless loop + resample)        | `2efe9a86`      |
| `applyVoiceLeadCommand` (adapt.ts)  | voiceify render → "Voice Lead — hum" track                                | `0b64ff95`      |
| Section development (W1)            | sekcie sa vyvíjajú (hook citácie, lift, dip, thin)                        | `2dbbf100`      |
| Song pipeline                       | formy, transitions, filly, harmony plan, SUNO formát                      | kampaň 10-10/12 |

**Medzery, ktoré ju držia pod killer laťou:**

1. **Nie je JEDEN tlačidlo** — flow je previazané moduly, ale nie jeden user
   gesture. Killer feature sa musí dať odskúšať za 30 sekúnd.
2. **Chipmunk strop** — pitch-shift cez resample posúva formanty s pitchom;
   pri väčších intervaloch znie hum ako veverička. Najpočuteľnejší tell.
3. **Chýba zbor** — jeden hlas z naive resample znie tenko. Vokálne double
   a harmonie sú najlacnejší zvukový skok v celom produkte.

---

## KROK 1 — Vokálny zbor (voiceify orchestrácia)

**Náklad:** nízky (DSP hotové, len orchestrácia) · **Efekt:** obrovský — zbor
z jedného humu

### Čo staviame

`applyVocalEnsembleCommand` (adapt.ts): z JEDNEHO hum nahrávky vyrobí 2–3
voiceify rendre a nainštaluje ich ako súrodenecké tracky:

- **Lead** — čistý voiceify na cieľovú melódiu (pan C, gain 1.0)
- **Double** — ten istý render s malým časovým offsetom (~15–25 ms) a
  pitchom ±0 (pan L/R, gain 0.6) — klasické vocal doubling, zahusťuje
  bez zmeny výšky
- **Harmonia** — rovnaký region, pitch +3 alebo +4 (tercia) pod/na melódiu,
  gain 0.5, pan protiľahlý leadu

Determinizmus: offsety a harmonické intervaly sú KONŠTANTY (nie seed RNG) —
rovnaký hum vždy dá rovnaký zbor. Volume/pan profil ako konštanty v jednom
mieste, aby sa dali ladenie ako pri EN/SK tagoch.

### Detaily

- Voiceify volania zdieľajú jeden region (JEDNO `estimateHumMidi` na nahrávku).
- Harmonický interval: +3 pre molové melódie, +4 pre durové (podľa W2 key
  kontextu alebo `effectiveKey`).
- Double offset: starostlivo mimo jednej periody humu (inak comb filtering) —
  ~20 ms je bezpečné.
- Track meno: "Voice Ensemble — hum" (reuse podľa mena, ako Voice Lead).
- `ensemble?: boolean` option na VoiceLeadOptions; `ensembleSize` 1–3.

### Akceptančné kritériá

- [ ] 3 tracky z jedného humu, každý s notes melódie
- [ ] Pan L/C/R, gainy 1.0/0.6/0.5 (alebo z konštánt)
- [ ] Determinizmus: rovnaký vstup → bytovo rovnaký výstup
- [ ] Re-apply obnovuje všetky tracky (žiadny track spam)
- [ ] `ensemble: false` = presne dnešné správanie (A/B)
- [ ] Testy: počty trackov, pan/gain konštanty, offsets, A/B

---

## KROK 2 — "HUM A HIT" one-button flow

**Náklad:** stredný (UI choreografia z existujúcich kusov) · **Efekt:**
produktizácia — 30-sekundové demo bez manuálu

### Čo staviame

Nový panel flow v IntentPanel (alebo vlastná mini-sekcia): **“🎤 NAHUM A HIT”**

1. **Nahraj** — MediaRecorder flow už existuje (voice idea, Fázy 1+2):
   nahraj hum → decode → staged buffer.
2. **Analyzuj** — `analyze.ts` VocalProfile (tempo/key/frázy) + `hum-to-notes`
   → melódia. Zobraz BRIEF potvrdenie: "220 → 124 BPM, A-mol, 4 frázy,
   žánr?" (žánrový chip z existujúcich PRÍZNAKOV).
3. **Postav** — `buildSong(doc, intent, { vocalProfile, ensemble: true })` —
   celý existujúci pipeline (formy, development, hook, filly, transitions),
   hum melodía = lead, voice ensemble = spev.
4. **Prehraj + potvrď** — audition (existujúce), ✓ USE inštaluje jeden undo
   krok; ✗ zahodí.

### Detaily

- Progress bar: existujúca telemetria z W-vlny (`songProgress`) — "3/7 ·
  Chorus 1" počas buildu.
- Token guard: existujúci `songTokenRef` pattern (superseding builds).
- Voice ensemble sa inštaluje ako SÚčasť USE flowu (jeden undo krok so
  skladbou — `applySongCommand` + ensemble command v jednom `snapshot`).
- Voice failsafe: ak je hum príliš tichý/nevydateľný, honest status
  ("hum príliš tichý — skús spievať bližšie k mikrofónu") a pokračuj
  synthesizer leadom (dnešné správanie).

### Akceptančné kritériá

- [ ] Celý flow ≤ 3 kliky: nahraj → potvrď brief → USE
- [ ] Progress telemetria viditeľná počas buildu
- [ ] Jeden undo vráti celú skladbu + ensemble
- [ ] Hum failsafe nespadne — degraduje na synth lead
- [ ] E2E test: hum fixture → skladba s ensemble trackmi

---

## KROK 3 — Formant preservation (PSOLA)

**Náklad:** vysoký (nové DSP + merania) · **Efekt:** kvantitatívny skok
kvality — z chipmunku k spevu

### Problém

Resample posúva formanty s pitchom: +12 st = formanty o oktávu vyššie =
chipmunk. PSOLA (Pitch-Synchronous Overlap-Add) posúva pitch s
formantmi zachovanými — štandard spevu od 90-tych rokov, zvládnuteľný v
čistom TS na monofónnom signáli.

### Čo staviame

`src/vocal/psola.ts`:

1. **Epoch detection** — nájdi periódy humu (peaky autokorelácie po
   oknách; autokoreláciu už máme v voiceify).
2. **TD-PSOLA** — per target note: posun epochy na cieľovú periódu
   (pitch shift), overlap-add s Hann oknami (time stretch na duration).
3. Integrácia do `voiceifyHum` ako `engine: "resample" | "psola"` option
   (resample ostáva fallback a A/B referenciou).

### Merania (bez nich to nie je hotové)

- Spectral centroid drift before/after (cieľ: < 10 % pri +12 st)
- Formant pásma (LPC alebo Welch band shares) — musia ostať na mieste
- ABX ear-pass (owner): PSOLA vs resample na tom istom hume — musí byť
  počuteľne lepší, inak ho nestojí za to
- Soak: žiadne non-finite vzorky, heap stabilný

### Riziká

- PSOLA na šume/negumavom materiály artefaktuje — fallback na resample
- Epoch detection na noisy mikrofóne — možno bude treba YIN (už v
  hum-to-notes) namiesto čistej autokorelácie

---

## KROK 4 — Marketing surface (lacné, po kroku 2)

- **Embed demo**: nahrávka humu → skladba — rovnaký embed flow ako
  Interactive Beats; ľudia počujú SVOJ hlas v produkcii.
- **Gallery**: "nahrané humom" badge — sociálny dôkaz, že to funguje.

---

## KROK 5 — Owner verifikácia

- **Ear-pass**: ABX (listening:abx infra hotová) — PSOLA vs resample,
  ensemble vs single, tvoj hum vs synth lead
- **Benchmark vs SUNO**: rovnaký prompt, slepé porovnanie — owner-gated
  (vyžaduje SUNO prístup), cieľ: "editovateľné + tvoj hlas" vyhrá na
  use-case, nie na hlasovú kvalitu

---

## poradie + závislosti

```
KROK 1 (zbor)           ── nezávislý, môže ísť hneď
KROK 2 (one-button)     ── závisí na kroku 1 (ensemble v USE flowu)
KROK 3 (PSOLA)          ── nezávislý, kedykoľvek; mení vnútro voiceify
KROK 4 (marketing)      ── po kroku 2
KROK 5 (owner ear-pass) ── po krokoch 1+3
```

Odporúčané tempo: **1 → 2 v jednej session**, 3 ako samostatná vlna s
meraniami, 4/5 na záver.

## Čo NIE je v scope

- WebLLM/speech-to-text v prehliadači (kampaň sama o sebe)
- Neurálny vocoder (HiFi-GAN-class) — WebGPU kampaň
- Siri/Google-level SVS modely — W5/ADR 0031 rieši oddelene (owner-gated)

---

## História kampaňa (kontext)

- **2026-10-10/12 — W1–W3 + W4 shipped**: section development (`2dbbf100`),
  lyrics→prosody (`2ea5123a`), hum→voice pure (`2efe9a86`) + wiring
  (`0b64ff95`), SUNO formát + ADR 0031 (`bc9ffd2d`), strengthening
  (`2587cfbb`).
- Tento dokument: rozpis W-cesta ku killer statusu.
