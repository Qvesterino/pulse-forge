# ADR 0055 — LADIČ FM flagship (6-operator phase-modulation synthesizer)

Date: 2026-10-18 · Status: Accepted (v1) · Scope: instruments registry, lazy instrument worklets, presets

## Context

The instrument family covered subtractive, sampling, wavetable, granular and
hybrid (TSAR), kick design (KOPA) and harmony timbres (CHORÁL) — but FM was a
2-operator toy (`fm`: carrier + one modulator + feedback). No browser DAW
ships a real DX-class FM engine; that is the last big synthesis gap in the
KYX arsenal (the "LADIČ" proposal, instrument-arsenal wave 1).

Everything the flagship pattern needs is proven four times over (TSAR ADR
0023, KOPA ADR 0035, CHORÁL ADR 0054): typed DSP core, thin chunked worklet
entry, lazy load with its own budget row, an audible native fallback, the
Inspector's generic param surface, and the browser loudness harness for the
factory bank.

## Decision

1. **New instrument kind `ladic`** (additive to `InstrumentKind`,
   `INSTRUMENT_NAMES` "Ladič", Nexus GM 6 — electric piano, the DX
   signature sound; `INSTRUMENT_META` + `INSTRUMENT_ORDER`, TrackTabs badge
   "LD"). No schema bump (ADR 0035 §5 precedent).
2. **Six sine operators, phase modulation** (the technically correct name
   for what DX calls FM). Per operator: RATIO (0.25–16), DETUNE (±50 ct),
   LEVEL, ADSR (attack/decay/sustain/release). Sine-only is authentic DX and
   keeps v1 lean — waveforms are a follow-up.
3. **Eight curated algorithms** (0–7, a discrete param): additive stack,
   3×2 pairs, 1←(2+3) + 4←5 + 6, two 3-chains, the full 6-chain, one
   carrier with five mods, feedback-trio, three carrier/mod pairs. Routing
   is a static table evaluated per sample: `modIn[carrier]` lists its
   modulators; operators are evaluated highest-index-first so modulators
   are always fresh. Phase deviation = modulator level × 4π (level 1 = the
   full bright DX range).
4. **Global FEEDBACK** applies to the algorithm's feedback operator (the
   highest non-carrier; op 6 in the all-carrier algorithm) via a one-sample
   delay — the classic DX op feedback.
5. **Voices: 12, oldest-steal.** Per-voice preallocated per-op phase/env/
   feedback state; zero allocation in the render path. GLIDE (portamento)
   and a one-pole LP cutoff (TONE shaping) close the globals. Output is
   mono (mirrored to both channels) — v1 scope line; stereo detune spread
   is a follow-up.
6. **Deterministic by construction**: no RNG anywhere (drift/arp are
   follow-ups), so live and offline render identically given the same
   events — the offline `processorOptions.events` seed (Chromium does not
   pump worklet message queues during offline renders).
7. **Lazy load + budget row**: `INSTRUMENT_WORKLET_TYPES` gains `"ladic"`;
   `scripts/build-ladic-worklet.mjs` emits `public/ladic-worklet.js`;
   48 KB budget row. A project with no LADIČ track never fetches it.
8. **Fallback without the module is real audible FM**: a native 2-op voice
   (modulator osc → gain → carrier.frequency — frequency modulation ≈ phase
   modulation for sine at small index). Never a dead graph.
9. **Factory bank (4 presets)**: DX Keys (the EP), Glass Bells, FM Sub,
   Velvet Pad — synthesized, no samples, measured with the browser loudness
   harness like every factory preset.
10. **No dedicated panel in v1** — the Inspector renders the param surface
    generically (KOPA/CHORÁL v1 precedent); an algorithm-visualization
    panel is a follow-up wave. Patch Mutations axes for LADIČ are the
    Tier-3 generalization wave's first consumer.

## Consequences

- The instrument count moves 25 → 26 (CURRENT-STATE).
- The `fm` kind stays as the compact learner instrument (the drumsynth/
  KOPA split precedent).
- Known v1 scope lines: sine-only operators, mono output, no drift/arp/
  harmony follow, no per-op key scaling / velocity curves (DX depth) — all
  follow-up waves, none block the flagship sound.
