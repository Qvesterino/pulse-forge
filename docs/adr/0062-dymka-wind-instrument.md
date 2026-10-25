# ADR 0062 — DYMKA wind instrument (breath-driven MPE synthesizer)

Date: 2026-10-20 · Status: Accepted (v1) · Scope: instruments registry, lazy instrument worklets

## Context

The arsenal's expression story (ADR 0049: per-note pressure + timbre lanes;
HĽAS's live morph/breath; STRUNA's live brightness) reaches its natural
conclusion with a WIND instrument — an instrument whose loudness AND timbre
both come from the breath, per note, live. Wind synthesis needs: a
pitched oscillator (the air column), a noise component (the turbulent jet),
an embouchure model (how hard you blow changes both brightness and pitch
bend — the classic sax/trumpet overblow), and vibrato from the player's
jaw, not an LFO.

## Decision

1. **New instrument kind `dymka`** (additive; `INSTRUMENT_NAMES` "Dymka",
   Nexus GM 67 — baritone sax, TrackTabs "DM"). No schema bump.
2. **Breath model in a typed core** (`src/dymka/dsp/dymkaProcessor.ts`):
   the DRIVER is a per-note breath value (0..1) that sets BOTH the
   amplitude envelope and the brightness (a one-pole LP on the source
   oscillator — more pressure = brighter, like a real reed). A REED NOISE
   layer (bandpassed LCG noise, level follows the breath curve with a
   proportional + offset split) adds the turbulence. A slight PITCH
   LIFT (+n cents per unit of pressure above 0.5 — the overblow lean)
   completes the embouchure.
3. **The oscillator**: saw (a hollow-body wave — brass/reed column) with a
   formant pair (the instrument's bore resonances, scaled by BODY TONE);
   square for the clarinet register (odd-harmonic character).
4. **MPE live events** (the HĽAS/STRUNA contract, no re-attack):
   `polyPressure` → the BREATH itself (the note swells and brightens under
   the finger, live — this is THE instrument); `polyTimbre` → vibrato
   depth (the jaw). Both update running voices in place.
5. **Overblow**: a LEGATO param — glide between notes on the same voice
   (monophonic lead behavior, the acid/808 slide precedent) instead of
   re-attacking each note. Default OFF; the polyphonic default re-attacks.
6. **Voices**: 6 (wind sections are small), oldest-steal. Deterministic
   (reed noise from a per-note LCG); offline via `processorOptions.events`.
7. **Lazy load + budget row** (32 KB ceiling), `build:dymka` in the
   predev/prebuild chains.
8. **Fallback**: a saw through a lowpass with a gain envelope that follows
   velocity — audible, never a dead graph.
9. **Factory bank (4)**: Sax Lead, Clarinet, Trumpet Stack, Breath Pad —
   measured with the browser loudness harness. No dedicated panel v1
   (the Inspector surface).

## Consequences

- The instrument count moves 30 → 31 (CURRENT-STATE).
- The breath curve is linear in v1 (a real embouchure has a threshold and
  a saturation knee — a follow-up if the sound asks for it).
- No growt/multiphonic extended techniques in v1 — honest scope line.
