# ADR 0061 — The primary knob is declared on the effect: one owner for what "more X" turns

Date: 2026-10-24 · Status: Accepted (shipped) · Scope: effects registry, intent engine, MCP plugin catalog, param layer

## Context

ADR 0058 made the intent layer a semantic layer with one registry, one plan and one mutation
boundary. It kept the parameter facts in `src/effects/definitions.ts` — bounds, taper, unit, label —
and derived everything from there. One fact did not follow the rule.

**Which knob does a "more/less X" ask turn?** That lived in a second hand-written table,
`EFFECT_KNOB` in `src/intent/mix.ts`. Two things were wrong with it, and both were measured:

- **It was a second copy of the truth.** The MCP plugin catalog imported it — the catalog, whose
  whole job is to tell an agent what a plugin can do, read the intent layer's private table to
  answer "which knob will the intent layer turn?". Two layers had to agree, and the catalog's
  answer was only as good as the intent layer's memory.
- **It was a partial copy.** It named **15 of the 57 registered effects**. For the other 42 — every
  flagship, every character effect, every recently added plugin — a "more X" ask was understood and
  then declined with `no knob mapped for effect "X" — intent understood, effect unsupported`. The
  intent layer could name those effects (R-01 derived the vocabulary from this same registry) but
  could not turn them.

The refusal was not a bug in the effect layer; it was the honest consequence of a table that had
never heard of 42 of its effects. And it was invisible: the catalog reported `primaryKnob: null`
for them and moved on.

## Decision

**The primary knob is declared on the effect, and the map is derived from the registry.**

1. `EffectDefinitionMeta` gains `primaryKnob?: string` — the knob a "more/less X" ask turns.
   The declaration sits next to the params it names, so it cannot drift away from them.
2. `EFFECT_PRIMARY_KNOB` is **derived** from `EFFECT_META` in `src/effects/definitions.ts`. The
   intent layer, the param registry, the intent plan and the MCP catalog all read that one map.
   The old `EFFECT_KNOB` table is deleted; there is no second map to drift.
3. **The knob is the effect's CHARACTER control where it has one, and the wet/dry mix where it
   does not.** "More saturation" turns the drive — the knob the producer already dialled to taste —
   not the wet/dry, which is how much of the effect sits in the mix. "More reverb" turns the mix,
   because the reverb has no character knob. The character knobs: `saturation.drive`,
   `distortion.drive`, `tapeSat.drive`, `clipper.drive`, `autowah.drive`, `zenit.drive`,
   `apeks.drive`, `bassHarmonic.drive`, `skrutka.dispersion`, `rezonans.formant`,
   `compressor.ratio`, `pump.amount`, `sidechain.amount`, `shimmer.amount`, `vinyl.amount`,
   `pitchCorrect.amount`, `transient.sensitivity`, `stepGate.depth`, `duckDelay.duckAmount`,
   `drumBuss.boomAmount`, `bassBuss.subEnhance`.
4. **A knob-less effect is a declaration too.** `eq`, `msEq` (every knob is a musical quantity),
   `haasWidener` (the width role owns `width`), `utility` (a toolbox), `prud` (no fractional knob)
   and the namespaced flagships `ultina`, `ozvena`, `morphdynamics` have no primary knob, and their
   ask is declined — honestly, and with the reason written down.
5. **A knob is a share of its own range** (0..1), so "more X" is a nudge and not a leap. The two
   exceptions are the knobs whose range IS a musical quantity: `compressor.ratio` (1..20) and
   `rezonans.formant` (−12..12).

## Consequences

- **34 effects became turnable.** 49 of 57 now declare a knob; the 8 knob-less ones are the
  documented set. The intent layer answers "more drift on the vocals" instead of declining it.
- **The catalog stopped lying by omission.** `primaryKnob` in `kyx_catalog subject:effect` is now
  the registry's answer, so an agent knows which knob it can ask for — and that the ask will land.
- **A new effect is turnable the moment it is registered.** The guard
  (`tests/effect-primary-knob.test.ts`) is a census: every effect with a fractional knob must
  declare one, and the knob-less set must match the documented list exactly. Adding an effect
  without a knob decision fails the suite instead of silently declining every ask about it.
- **The knob map has exactly one owner.** The guard scans `src/` and fails if a second
  effect→knob table appears anywhere else.

## What was measured

- The guard was falsified first: with the declarations removed and everything else in place,
  **3 of its 8 cases went red** — the knob-less census named all 57 effects instead of 8, and the
  "established knobs do not move" pin failed on `delay`.
- The regression surface (intent, MCP, param, creative-task, rezonans goldens) is green, including
  the 276-case intent router corpus and the 114-case intent e2e audit — none of them moved, because
  no corpus sentence asks to turn one of the newly-knobbed effects.
- The MCP catalog's `primaryKnob` now equals the registry's answer for every one of the 57 effects
  (asserted, not assumed).
