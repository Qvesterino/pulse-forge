/**
 * TWIST CURVE SNAPSHOTS (v2.3) — two stored parameter curves (A/B) plus a
 * continuous MORPH position that blends between them.
 *
 * The snapshots live on the effect's `deviceState` blob (kind
 * "twist-curves-v1", sanitized in project-model/schema.ts) — they are editor
 * state, not audio params. The `morph` rack parameter stays a REAL effect
 * param, so an automation lane or a macro with `source: "intensity"` can
 * drive it: intro = curve A (center gulp) → drop = curve B (sides shimmer).
 *
 * Interpolation semantics (matches the node wrapper's `applyEffective`):
 *   - no slot stored        → morph is a no-op (the rack params are the sound)
 *   - only A (or only B)    → morph blends A ↔ the live/base params
 *   ─ both stored           → morph blends A → B
 * Per-parameter fallback keeps partial snapshots (older captures, imported
 * projects) musical: a missing side falls back to the live/base value.
 */

export const TWIST_CURVES_KIND = "twist-curves-v1";

export type TwistCurveSlot = "A" | "B";

export const TWIST_CURVE_SLOTS: readonly TwistCurveSlot[] = ["A", "B"];

export interface TwistCurvesState {
  slots: Partial<Record<TwistCurveSlot, Record<string, number>>>;
}

/**
 * The morphable parameter surface — every rack param except `morph` itself.
 * A drift-guard test asserts this equals `skrutkaParams` minus morph, so a
 * new DSP param can never silently fall out of the snapshot capture.
 */
export const TWIST_CURVE_PARAM_IDS = [
  "dispersion",
  "punch",
  "punchHz",
  "punchMix",
  "focusHz",
  "shape",
  "spread",
  "field",
  "dyn",
  "dynPunch",
  "keyMode",
  "lfoRate",
  "lfoSync",
  "lfoShape",
  "lfoDepth",
  "mix",
  "output",
] as const;

const LOG_MORPH_PARAM_IDS = new Set(["focusHz", "lfoRate"]);
const STEPPED_MORPH_PARAM_IDS = new Set(["shape", "keyMode", "lfoSync", "lfoShape"]);

/** Extract the snapshot subset from a full rack parameter map. */
export function pickTwistCurveParams(params: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of TWIST_CURVE_PARAM_IDS) {
    const value = params[id];
    if (typeof value === "number" && Number.isFinite(value)) out[id] = value;
  }
  return out;
}

/** Read the sanitized deviceState blob into the panel's curve model. */
export function readTwistCurvesState(
  deviceState?: { kind: string; data: Record<string, unknown> } | null,
): TwistCurvesState | undefined {
  if (!deviceState || deviceState.kind !== TWIST_CURVES_KIND) return undefined;
  const raw = deviceState.data.slots;
  if (typeof raw !== "object" || raw === null) return undefined;
  const slots: TwistCurvesState["slots"] = {};
  for (const slot of TWIST_CURVE_SLOTS) {
    const value = (raw as Record<string, unknown>)[slot];
    if (typeof value === "object" && value !== null) {
      slots[slot] = value as Record<string, number>;
    }
  }
  return { slots };
}

/**
 * The effective parameter map for a curve state at position `morph`:
 * A/B when both are stored, a stored side vs the live base otherwise.
 * Frequencies with log tapers use geometric interpolation, enum controls and
 * the `punchHz = 0` AUTO sentinel switch at the midpoint, and other controls
 * interpolate linearly. Pure and shared by the node (audio) and panel.
 */
export function morphTwistParams(
  base: Record<string, number>,
  curves: TwistCurvesState | null | undefined,
  morph: number,
): Record<string, number> {
  const a = curves?.slots.A;
  const b = curves?.slots.B;
  if (!a && !b) return base;
  const t = Math.min(1, Math.max(0, Number.isFinite(morph) ? morph : 0));
  const out: Record<string, number> = { ...base };
  for (const id of TWIST_CURVE_PARAM_IDS) {
    const from = a?.[id] ?? base[id];
    const to = b?.[id] ?? base[id];
    if (from === undefined && to === undefined) continue;
    const fromValue = from ?? to!;
    const toValue = to ?? from!;
    if (t === 0) {
      out[id] = fromValue;
      continue;
    }
    if (t === 1) {
      out[id] = toValue;
      continue;
    }
    if (STEPPED_MORPH_PARAM_IDS.has(id) || (id === "punchHz" && (fromValue <= 0 || toValue <= 0))) {
      out[id] = t < 0.5 ? fromValue : toValue;
    } else if (LOG_MORPH_PARAM_IDS.has(id) && fromValue > 0 && toValue > 0) {
      out[id] = Math.exp(Math.log(fromValue) + (Math.log(toValue) - Math.log(fromValue)) * t);
    } else {
      out[id] = fromValue + (toValue - fromValue) * t;
    }
  }
  return out;
}
