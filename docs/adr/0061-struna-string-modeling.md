# ADR 0061 — STRUNA string-modeling instrument (extended Karplus-Strong)

Date: 2026-10-18 · Status: Accepted (v1) · Scope: instruments registry, lazy instrument worklets

## Context

The arsenal covers subtractive, FM, sampling, granular, formant and harmony
synthesis — but no PHYSICAL MODELING. Karplus-Strong (a filtered delay
loop excited by a noise burst) gives plucked strings — nylon, steel, koto,
dulcimer — at trivial CPU cost, fully deterministic when the excitation
noise comes from a seeded LCG. The MPE contract (ADR 0049) gives it
expression: pressure drives brightness (loop damping), timbre drives the
pick position.

## Decision

1. **New instrument kind `struna`** (additive; `INSTRUMENT_NAMES` "Struna",
   Nexus GM 24 — nylon guitar, TrackTabs "ST"). No schema bump.
2. **Extended KS core** (`src/struna/dsp/strunaProcessor.ts`, typed):
   per-note delay line (≤ 2400 samples, pitches ≥ ~30 Hz), excitation =
   LCG noise burst of one period, shaped by a PICK POSITION comb (0–1
   along the string) and a sharpness pre-emphasis; the loop applies a
   one-pole DAMPING filter; loop gain ρ = exp(−ln(1000)/(decaySec·f0)) so
   −60 dB lands at DECAY seconds REGARDLESS of pitch (pitch-consistent
   ring). Body = two resonant biquads (guitar-cavity pair) with
   BODY LEVEL/TONE.
3. **Expression**: `polyPressure` → brightness (live loop-damping override
   — press harder, brighter string) via the `bright` live event;
   `polyTimbre` → pick position via the `pick` live event. Both update the
   running string in place — no re-attack (the HĽAS live-event lesson).
4. **Release = palm mute**: noteOff steepens the loop damping over the
   RELEASE time instead of an envelope — strings stop by damping, not by
   an amplitude wall.
5. **Voices**: 8, oldest-steal; mono source, stereo mirror (v1 scope
   line). Deterministic (per-note LCG); offline via the
   `processorOptions.events` seed.
6. **Lazy load + budget row** (32 KB ceiling — a delay line and three
   biquads per voice).
7. **Fallback**: a saw through a bandpass with a pluck envelope — audible,
   never a dead graph.
8. **Factory bank (4)**: Nylon Pluck, Steel Bright, Koto, Low Drone —
   measured with the browser loudness harness. **No dedicated panel v1**
   (the Inspector surface; a string-visualization panel is a follow-up).

## Consequences

- The instrument count moves 29 → 30 (CURRENT-STATE).
- Naive excitation + heavy damping can sound "dk" at low pitches — the
  damping floor is clamped so the loop never stalls (measured in tests).
- Sustain is natural (no gate-hold): HLVAS/LADIČ-style infinite sustain is
  out of scope for a string.
