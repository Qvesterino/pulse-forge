# ADR 0007 — Ozvena: per-frekvenčná decay sieť (kalibrácia T60 pod 5 %)

- Status: proposed (2026-09-05) — čaká na upstream (VocalForge_DAW) architektonické rozhodnutie
- Context: docs/IMPLEMENTATION-ROADMAP-OZVENA-QUALITY.md, Fáza O4
- Dôkazová báza: `plugins/ozvena/tests/measure/decay.test.ts` (O1 harness + O4 solo sweep)

## Context

Fázy O2/O3 (12/16 liniek, komplementárna 3-pásmová decay sieť) dotiahli Ozvenu
na −5.7..−10.4 % T60 odchýlky (solo sweep, merané). Cieľ O4 — **pod 5 %** — sa
skalárnymi prostriedkami nedá dosiahnuť. V sedení 2026-09-05 boli implementované
a odmerané tri prístupy, všetky dokumentované v kóde engineov:

| Prístup | Výsledok | Prečo |
|---|---|---|
| skalár 1/damperLoss@1 kHz v mid band gain | **+27 %** T60 (band-share double-count) | inverz pôsobí na band share, nie na plný signál |
| presný FIR inverz damperu (1 − b·z⁻¹)/a v mid band | **nestabilné** pri dlhých decayoch (loop gain > 1 v upper mid) | rovnaký double-count, zosilnený pri 1/dampMag > 1 |
| skalár 1/loss@80 Hz na low band | **runaway** fb·gLow = 1.09 | frekvenčne závislá strata kompenzovaná konštantou prebije nad referenciou |
| scalar 1/loss@300 Hz + hard gCap (0.995/fb) | **−5.7..−10.4 %, stabilné** | odoslaný kompromis |

Fyzikálny jadro problému: v rámci 250–3500 Hz "mid" pásma damper mení decay rate
o viac ako 2× (0.99 pri 250 Hz vs 0.57 pri 3.5 kHz pri default dampingu). Žiadna
scalárna band gain nemôže spraviť všetky frekvencie pásma na jednej T60 krivke.
Wide-band EDC regresia preto meria mix sklôn — odchýlka je vlastnosťou metódy,
nie chyby kalibrácie.

## Decision (navrhnuté pre upstream)

1. **Per-band damper umiestnenie.** Presunúť HF damper z spoločnej cesty
   (pred Householder) do **high band cesty** O3 siete. Low/mid loop gain sa
   stane presne `fb · bandGain` na každej frekvencii — kalibrácia mid = knob
   bez kompenzácie. Pozor: prvý pokus tohto presunu (2026-09-05) vykazoval
   +127 % T60mid — model sluky je neúplný (podozrenie na interakciu s
   length-crossfade/air-moduláciou cestami); pred prijatím treba ten pokus
   zopakovať izolovane s per-line inžinierskym logovaním.
2. **Metrológia: ISO-style narrow band.** RT60 špecifikovať a meriť v ±1-oktávovom
   pásme na 1 kHz (mid) a 125 Hz (low) — nie wide-band EDC. O1 harness má na to
   `narrowMid()` helper. Wide-band čísla ostávajú ako reportovaná informácia.
3. **Voliteľné per-frekvenčné doladenie.** Ak aj po (1)+(2) high band nechce
   sedieť: auto-kalibračná lookup tabuľka `dampingAmount × dampingFreqHz × SR →
   highBandGain` vygenerovaná z O1 harnessu pri vydaní (build-time skript, nie
   runtime meranie). Runtime auto-kalibrácia renderovaním je zakázaná
   (real-time invariant).

## Consequences

- **Sonic:** damper prestane tlmiať 250–3500 Hz — chvosty budú o niečo jasnejšie
  v strednom pásme pri vysokom dampingu. Deklarovaná zmena, A/B cez O1 harness.
- **Stabilita:** loop gain per frekvencia = fb všade v low/mid (dôkaz analyticky
  aj meraním); shimmer guard (`fbMax = fb·max(1, bassGain, midBandGain)`) ostáva
  platný.
- **Kompatibilita:** žiadne zmeny parameter ID ani schémy; `dampingAmount/FreqHz`
  si zachovajú význam (HF decay), len už nekorumpujú mid kalibráciu.
- **Náklady:** žiadne nové per-sample náklady (presun existujúceho one-polu);
  build-time lookup tabuľka je pár KB.

## Odkazy

- Meracia infraštruktúra: `plugins/ozvena/tests/measure/decay.test.ts`
- Hardening guardy, ktoré musia ostať zelené: shimmer stability sweep,
  `midBandGain` gCap, `tests/ozvena-hardening.test.ts` energetickej pásma
