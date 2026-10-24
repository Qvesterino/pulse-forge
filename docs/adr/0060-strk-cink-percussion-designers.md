# ADR 0060 — ŠTRK & CINK: snare and hi-hat designers (the KOPA family)

Date: 2026-10-18 · Status: Accepted (v1) · Scope: instruments registry, lazy instrument worklets, percussion presets

## Context

KOPA (ADR 0035) proved the percussion-designer pattern: a dedicated
instrument kind whose parameters ARE the drum's anatomy, with a real
fallback, its own lazy bundle and a measured factory bank. The beatmaker's
backbeat still had no designer: the snare lives as 3 fixed types inside
Drum Synth and the hi-hat as 2 more — tuned knobs, not anatomy. The KOPA
family completes: kick (KOPA), snare (ŠTRK), hat (CINK).

## Decision

1. **Two new instrument kinds** (additive; `INSTRUMENT_NAMES` "Štrk"/"Cink",
   Nexus GM 38 acoustic snare / GM 42 closed hi-hat, TrackTabs "ŠT"/"CN",
   `INSTRUMENT_META` + `INSTRUMENT_ORDER`): **ŠTRK** (snare designer) and
   **CINK** (hat designer). One ADR covers both because they share the
   architecture, the loudness wave and the KOPA-family identity; each is a
   separate kind, worklet bundle and budget row (the KOPA §1 precedent —
   never force designers into a shared param surface).
2. **ŠTRK anatomy (4 layers)**: SNAP (click transient: level + decay),
   BODY (pitched osc with a fast pitch drop: tune ±12, level, decay, tone
   triangle/sine), WIRES (bandpassed noise: level, tone 1.5–8 kHz, decay),
   and SNAPPY (how tightly the wires are coupled to the body envelope —
   the acoustic snare's defining behavior; 0 = tom with wires off, 1 = the
   wires ring the moment the head is hit). DRIVE + LEVEL close it.
3. **CINK anatomy**: SIX square partials at deliberately irregular ratio
   multipliers (the 808-style metal stack), a fast CHIRP (pitch envelope
   on the multiplier base), a highpass TONE, and DECAY that spans closed
   (50 ms) to open (1.2 s). DRIVE + LEVEL.
4. **Trigger mode** on both: one-shot (default — noteOff does not cut) or
   gate (the KOPA `NOTE_GATE_OPTIONS` contract), so the designers work in
   the piano roll AND from drum triggers.
5. **Determinism**: noise layers draw from per-note LCGs seeded at noteOn
   (pitch + counter) — live and offline identical given the same events
   (`processorOptions.events` seed). Bounded: 8 voices each (percussion
   polyphony), zero allocation in the render path.
6. **Lazy load + budget rows** (ŠTRK 32 KB, CINK 32 KB ceilings),
   `build:strk`/`build:cink` in the predev/prebuild chains.
7. **Fallbacks are real audible percussion**: ŠTRK — noise burst through a
   bandpass + a short sine body; CINK — a high square through a highpass.
   Never a dead graph.
8. **Factory bank**: 4 ŠTRK + 4 CINK presets (acoustic crack, 808-style
   long body, drill snap, soft lo-fi; closed tight, open wide, sizzle,
   dark), measured with the browser loudness harness.
9. **No dedicated panel in v1** — the Inspector renders the param surface
   generically (the KOPA precedent itself); a drum-designer panel surface
   is a follow-up wave.

## Consequences

- The instrument count moves 27 → 29 (CURRENT-STATE).
- Both kinds join the `drums` preset family in a follow-up wave (with the
  KOPA bank re-measurement — one loudness run covers all new presets).
- DSP naivety note: CINK's partials are square waves (not FM'd metal), so
  extreme open decays sound synth-metallic rather than acoustic — the
  honest v1 scope line; a metallic-FM partial mode is a follow-up.
