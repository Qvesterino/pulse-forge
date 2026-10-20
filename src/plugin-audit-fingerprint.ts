/**
 * AUDIT FINGERPRINT — the state the host probe puts an effect into.
 *
 * Node-pure on purpose: this module holds the rule that decides which knob
 * the plugin audit turns, and it has to be unit-testable without a browser.
 * The audit itself (src/plugin-audit-checks.ts) does the measuring; this
 * module only decides.
 *
 * WHY THE RULE IS NOT "the biggest change"
 *
 * A fingerprint has to satisfy TWO conditions, and they are different
 * questions:
 *
 *   1. it must DIFFER from the default — otherwise the automation lane
 *      drives the parameter to the value it already had and nothing moves;
 *   2. it must still PROCESS — otherwise the probe compares the dry signal
 *      with the dry signal and reports a working effect as dead.
 *
 * Ranking parameters by the change against the DEFAULT render satisfies (1)
 * and breaks (2) for every parameter whose default sits on an extreme.
 * MEASURED on `pitchCorrect`: `amount` defaults to 1 (full retune) and its
 * minimum is 0 (no retune) — the largest change against the default AND a
 * perfect passthrough. The old rule picked exactly that state, and the host
 * probe read 6.9e-9 while the same effect at its defaults read 0.108 on the
 * same material.
 *
 * So the ranking is filtered by `dryDelta` — the change against the DRY
 * render, which is zero exactly when the effect does nothing in that state.
 */

import { EFFECT_META } from "./effects/definitions";
import type { ParamDef } from "./effects/types";
// `EffectType` is declared in ONE place — src/project-model/types.ts. The
// effects module only imports it, so importing it from there asked for an
// export that does not exist and broke the typecheck gate.
import type { EffectType } from "./project-model/types";

/**
 * Host delta below this still counts as processing (jitter floor ~1e-7).
 *
 * The threshold the host verdict uses AND the threshold the fingerprint rule
 * uses, defined once so the two can never drift apart: a fingerprint that
 * passes the gate but not the verdict would be a state the audit picks and
 * then cannot see.
 */
export const HOST_EPS = 0.005;

/** Params whose dry extreme silences the effect (mix/wet classes). */
export const MIX_CLASS_IDS = new Set(["mix", "global.mix", "global.dryWet", "globalMix", "level"]);

/** One measured extreme of a parameter. */
export interface ParamExtreme {
  extreme: "min" | "max";
  value: number;
  /** Change against the default render of the same stimulus. */
  delta: number;
  /** Change against the DRY render of the same stimulus — zero means the effect is a passthrough here. */
  dryDelta: number;
}

/** The part of a swept parameter the fingerprint rule reads. */
export interface FingerprintParam {
  id: string;
  /** The strongest change this parameter reached against the default render. */
  delta: number;
  bestExtreme: "min" | "max";
  extremes?: ParamExtreme[];
}

/** The part of a sweep result the fingerprint rule reads. */
export interface FingerprintSweep {
  type: EffectType;
  params: FingerprintParam[];
}

/**
 * Per-effect fingerprint overrides where the strongest sweep extreme is not
 * the most host-audible one (out-of-window delay times, mono-invisible
 * ping-pong).
 */
export const FINGERPRINT_OVERRIDES: Partial<Record<EffectType, { id: string; value: number }[]>> = {
  // The swell needs to CAPTURE time seconds before replaying it reversed:
  // time@max (8 s) can never complete inside any audit window.
  reverseSwell: [
    { id: "engaged", value: 1 },
    { id: "time", value: 0.25 },
  ],
  delay: [
    { id: "feedback", value: 0.85 },
    { id: "tone", value: 500 },
  ],
  duckDelay: [
    { id: "feedback", value: 0.85 },
    { id: "duckAmount", value: 1 },
  ],
  stepGate: [
    { id: "division", value: 3 },
    { id: "depth", value: 1 },
  ],
  pump: [
    { id: "amount", value: 1 },
    { id: "rate", value: 4 },
  ],
  tremolo: [
    { id: "mode", value: 1 },
    { id: "rate", value: 20 },
  ],
};

/**
 * The fingerprint: the strongest state that still processes.
 *
 * A state whose `dryDelta` is zero IS the dry signal — the effect is a
 * passthrough in that state, so no probe can see it. Such states are dropped
 * before the ranking, which is the whole difference between a probe that
 * measures the effect and a probe that measures the silence around it.
 */
export function fingerprintOf(sweep: FingerprintSweep): { id: string; value: number }[] {
  const override = FINGERPRINT_OVERRIDES[sweep.type];
  if (override) return override;
  const paramsDef: ParamDef[] = EFFECT_META[sweep.type].params;
  const candidates: { id: string; value: number; delta: number; dryDelta: number }[] = [];
  for (const p of sweep.params) {
    if (MIX_CLASS_IDS.has(p.id)) continue;
    for (const e of p.extremes ?? []) {
      candidates.push({ id: p.id, value: e.value, delta: e.delta, dryDelta: e.dryDelta });
    }
  }
  // Only states that still process can serve as a fingerprint. A state whose
  // dryDelta is zero IS the dry signal, and no host probe can see it.
  const engaged = candidates.filter((c) => c.dryDelta > HOST_EPS);
  const pool = engaged.length > 0 ? engaged : candidates;
  // One extreme per parameter — two extremes of the same knob say less than
  // two different knobs, and the host probe applies them together.
  const bestPerParam = new Map<string, { id: string; value: number; delta: number }>();
  for (const c of pool) {
    const current = bestPerParam.get(c.id);
    if (!current || c.delta > current.delta) bestPerParam.set(c.id, { id: c.id, value: c.value, delta: c.delta });
  }
  const ranked = [...bestPerParam.values()].sort((a, b) => b.delta - a.delta);
  // Fallback when the only responsive params are mix-class: use the
  // strongest non-default param extreme regardless.
  if (ranked.length === 0) {
    return [...sweep.params]
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 2)
      .map((p) => {
        const def = paramsDef.find((d: ParamDef) => d.id === p.id)!;
        return { id: p.id, value: p.bestExtreme === "min" ? def.min : def.max };
      });
  }
  return ranked.slice(0, 2).map((c) => ({ id: c.id, value: c.value }));
}
