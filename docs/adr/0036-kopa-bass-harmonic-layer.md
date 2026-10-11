# ADR 0036 — KOPA kick-harmonic layer

Date: 2026-10-10 · Status: Accepted · Scope: KOPA DSP, instrument parameters, fallback voice

## Context

KOREŇ (ADR 0034) is a general bass exciter: it estimates the fundamental of
an incoming audio signal, checks the harmonic deficit, and adds partials. KOPA
already owns the kick's fundamental and its pitch envelope. Running another
pitch detector inside that voice would add delay and tracking failure modes
without providing new information. The kick needs its own upper-harmonic layer
that stays locked to the designed pitch sweep and renders identically in live
and offline paths. This layer is source-synchronous kick synthesis; KOREŇ stays
the general-purpose effect for arbitrary bass audio. They can be used together
when the KOPA kick needs additional tracked processing after synthesis.

## Decision

1. Add a kick-specific harmonic layer inside the existing KOPA instrument.
   The generated stack starts at the 2nd partial and omits the fundamental,
   so the KOPA body remains the sole owner of the root.
2. Derive each partial from KOPA's tuned body phase and instantaneous pitch.
   This is deterministic and follows the same exp/lin/snap/hold envelope in
   the worklet's one shared live/offline processor. Skip partials at or above
   45% of sample rate to keep high notes from aliasing back into the bass.
3. Expose `harmonicLevel`, `harmonicTone` (2nd↔3rd balance),
   `harmonicRange` (1–4 octaves, capped at the 16th partial),
   `harmonicDecay`, and `harmonicCharacter` (CLEAN / SAT / FOLD). The new
   instrument default gives the layer a modest audible amount; setting level
   to zero restores the prior worklet sound exactly.
4. Keep the no-worklet fallback useful: it schedules the same partial stack
   from the native body's pitch ramp and applies the selected character only
   to the generated layer.
5. No project schema bump: the change adds instrument parameters to the
   existing serializable `params` map and does not change the project shape.

## Consequences

- New KOPA instances have a recognizable upper-harmonic layer without an
  inserted effect or a second pitch tracker. Existing KOPA instances that
  already store parameter defaults remain controllable through the same
  instrument UI.
- The kick-specific partial layer can extend a kick's audibility on small
  speakers while preserving the body fundamental and allowing independent
  level, spectrum, decay, and saturation/folding control.
- The additional per-sample work is bounded by 15 upper partials per active
  voice, with phase/weight scratch storage allocated once per processor.

## Validation contract

- `tests/kopa/engine.test.ts` verifies that the layer adds upper partials but
  leaves the root unchanged, and that level, 2nd/3rd balance, range, decay,
  and character each change a measurable audio feature.
- `tests/kopa/fallback.test.ts` keeps the native graph audible with generated
  partial oscillators routed through the optional harmonic character shaper.
- `tests/kopa/offline-parity.test.ts` continues to pin bit-identical output
  for the shared seeded-event and live-style event paths.
