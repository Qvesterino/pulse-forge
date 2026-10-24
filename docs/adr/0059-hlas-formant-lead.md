# ADR 0059 — HĽAS formant lead (source-filter vocal synthesizer)

Date: 2026-10-18 · Status: Accepted (v1) · Scope: instruments registry, lazy instrument worklets, MPE expression

## Context

The vocal surface had two poles — `vocalchop` (sample chops) and CHORÁL
(ADR 0054, the harmony pad) — with no SOLO VOICE between them. Meanwhile
the pieces for a lead vocal synth all exist: the `spectral` instrument's
`VOWEL_FORMANTS` table ([F1, F2, F3] for A/E/I/O/U, registry lineage), the
CHORÁL v2 per-stream biquad/tilt architecture, the MPE expression contract
(ADR 0049: `polyTimbre`/`polyPressure` per note), and the flagship worklet
pattern (0023/0035/0054/0055 — four precedents).

HĽAS ("Voice") is a formant LEAD: a glottal source (saw/pulse + breath
noise) through three formant bandpasses. Play it like a sax —
portamento, vibrato, breath — and shape vowels per note: MPE timbre (CC74)
drives the A↔I vowel morph, MPE pressure drives the breath. It is the
singer to CHORÁL's choir.

## Decision

1. **New instrument kind `hlas`** (additive; `INSTRUMENT_NAMES` "Hlas",
   Nexus GM 85 — lead, `INSTRUMENT_META`/`INSTRUMENT_ORDER`, TrackTabs
   "HL"). No schema bump (ADR 0035 §5 precedent).
2. **Source-filter synthesis in a typed core**
   (`src/hlas/dsp/hlasProcessor.ts`): a band-limited-enough saw/pulse
   source + deterministic LCG breath noise → three RBJ bandpass biquads at
   the vowel formants (the carried `VOWEL_FORMANTS` table, band gains
   1/0.6/0.38) + a TILT one-pole. The formant table lives in the CORE
   (carried with attribution) — it is fixed data, not a user-editable
   scale, so the harmonyContext "no tables in the worklet" rule does not
   apply.
3. **Vowel morph**: `vowelA`/`vowelB` (0–4 = A/E/I/O/U) with `morph`
   (0–1) interpolating the three formant frequencies linearly (the
   standard two-vowel crossfade). `polyTimbre` (CC74) drives the morph
   per note — vowel sweeps from a modwheel/MPE slider are the instrument's
   signature. `polyPressure` drives the BREATH level per note.
4. **Lead essentials**: GLIDE (portamento), VIBRATO (rate + depth in
   cents, per-voice phase, starts after a fixed 0.25 s delay so attacks
   stay clean), BREATH (static noise level, deterministic LCG), ATTACK/
   RELEASE, LEVEL. 6 voices, oldest-steal. Mono source per voice, stereo
   output mirrors (v1 scope line).
5. **Deterministic by construction**: the only randomness is breath noise,
   from a per-note LCG seeded at noteOn — live and offline identical given
   the same events (`processorOptions.events` seed).
6. **Lazy load + budget row** (32 KB ceiling — source-filter is the
   cheapest flagship DSP yet; measured at implementation), `build:hlas`
   in the predev/prebuild chains.
7. **Fallback without the module**: a detuned saw through one static
   bandpass at the A-vowel F1 — audible, never a dead graph.
8. **No dedicated panel in v1** and **no factory presets in v1** — the
   Inspector param surface + the loudness-harness wave are follow-ups
   (the CHORÁL precedent; both recorded here so the scope line is
   explicit).

## Consequences

- The instrument count moves 26 → 27 (CURRENT-STATE).
- Naive saw aliasing is partially masked by the formant filters; the
  band-limited source is a follow-up if leads expose it.
- Vowel formants are FIXED (A/E/I/O/U); continuous morphing between
  arbitrary formant pairs is the follow-up wave.
