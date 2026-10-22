/**
 * PHYSICAL CALIBRATION — what "a little" means on a REAL parameter.
 *
 * The first P2 pass calibrated every plugin parameter as a FRACTION OF ITS
 * RANGE, in the parameter's own linear/log domain. That is defensible for a
 * normalized 0..1 mix knob, but it is wrong for wide physical ranges:
 *
 *   compressor.threshold spans 60 dB → "much" (0.32 of range) = 19.2 dB
 *   compressor.attack spans 0.2 ms..500 ms → "much" = ~12× the current time
 *   svFilter.cutoff spans 20 Hz..20 kHz → "much" = ~9× the current frequency
 *
 * Those are not "much"; they are near-extreme. The VocalForge engine's
 * `relativeParam` already uses FAMILY-SPECIFIC PHYSICAL STEPS (dB ladder,
 * proportional time/frequency, Q factor, percentage points), which is the
 * right shape: 1 dB is 1 dB regardless of range, and a time/frequency step is
 * proportional so one step is a similar musical interval at any current value.
 *
 * This module adopts that shape, with the safe bound reserved for degree 7:
 *
 *   degree 1..6 → calibrated family step (below)
 *   degree 7    → the declared bound ("to the limit")
 *
 * The step tables are constants, not derived. They are intentionally
 * conservative; a producer can always ask again for more. The plan/read-back
 * states the physical delta (dB, %, points) so the move is explainable.
 */
import type { ParamDef } from "../../effects/types";
import type { DegreeLevel } from "../degree";
import type { ParamRole } from "./param-registry";

export type CalibrationFamily = "db" | "time" | "frequency" | "q" | "percent" | "normalized";

/**
 * Six ordered steps per family (degree 1..6). Degree 7 is the bound.
 * These mirror the host's `relativeParam` calibration so one spoken degree
 * means the same magnitude family in KYX and VocalForge.
 */
const FAMILY_STEPS: Readonly<Record<CalibrationFamily, readonly [number, number, number, number, number, number]>> = {
  // Absolute dB: 0.25 / 0.5 / 0.75 / 1.5 / 2.5 / 4 dB.
  db: [0.25, 0.5, 0.75, 1.5, 2.5, 4],
  // Fraction of the CURRENT time (seconds or ms), with a floor.
  time: [0.01, 0.05, 0.1, 0.15, 0.25, 0.35],
  // Fraction of the CURRENT frequency; one step is a stable musical interval.
  frequency: [0.03, 0.06, 0.09, 0.12, 0.18, 0.25],
  // Fraction of the CURRENT Q factor, with a floor.
  q: [0.075, 0.15, 0.3, 0.5, 0.8, 1.5],
  // Percentage points on a 0..100 control.
  percent: [0.5, 1, 2, 3, 5, 8],
  // Absolute fraction on a 0..1 control.
  normalized: [0.005, 0.01, 0.02, 0.03, 0.05, 0.08],
};

export function calibrationFamily(param: ParamDef, role: ParamRole): CalibrationFamily {
  const unit = (param.unit ?? "").toLowerCase();
  if (unit === "db") return "db";
  if (unit === "s" || unit === "ms") return "time";
  if (unit === "hz" || unit === "khz") return "frequency";
  // svFilter RESO is a normalized 0..1 control, not a Q factor. A real Q
  // parameter (unitless, wider range) uses the Q-factor family.
  if (role === "q") return param.max <= 1 ? "normalized" : "q";
  if (param.min >= 0 && param.max <= 1) return "normalized";
  if (param.min >= 0 && param.max <= 100 && (unit === "%" || unit === "percent" || unit === "")) return "percent";
  return "normalized";
}

export interface PhysicalStep {
  family: CalibrationFamily;
  degree: DegreeLevel;
  /** Base step as a fraction/absolute for the family (inspectable). */
  baseStep: number;
  /** Signed delta applied to the current value, in the parameter's units. */
  delta: number;
  current: number;
  proposed: number;
  next: number;
  clamped: boolean;
  /** Human delta: "+0.75 dB", "+10%", "+2 pts", "to limit". */
  deltaLabel: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function floorFor(family: CalibrationFamily, unit: string | undefined): number {
  if (family === "time") return (unit ?? "").toLowerCase() === "ms" ? 0.1 : 0.0001;
  if (family === "q") return 0.05;
  return 0;
}

function signed(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(value >= 10 ? 1 : 2)}`;
}

function labelFor(family: CalibrationFamily, baseStep: number, delta: number, atLimit: boolean): string {
  if (atLimit) return "to limit";
  switch (family) {
    case "db":
      return `${signed(delta)} dB`;
    case "time":
    case "frequency":
    case "q":
      return `${delta > 0 ? "+" : "−"}${Math.round(baseStep * 100)}%`;
    case "percent":
      return `${signed(delta)} pts`;
    case "normalized":
      return `${signed(delta * 100)} pts`;
  }
}

/**
 * Resolve one relative move. Pure: no doc, no store. The caller (param
 * preview/apply) owns the current value and the clamp.
 */
export function physicalStep(
  param: ParamDef,
  role: ParamRole,
  degree: DegreeLevel,
  current: number,
  direction: "more" | "less",
): PhysicalStep {
  const family = calibrationFamily(param, role);
  const sign = direction === "more" ? 1 : -1;
  if (degree === 7) {
    const target = direction === "more" ? param.max : param.min;
    const delta = target - current;
    return {
      family,
      degree,
      baseStep: Math.abs(delta),
      delta,
      current,
      proposed: target,
      next: target,
      clamped: false,
      deltaLabel: labelFor(family, Math.abs(delta), delta, true),
    };
  }
  const baseStep = FAMILY_STEPS[family][degree - 1]!;
  let delta: number;
  switch (family) {
    case "db":
      delta = baseStep;
      break;
    case "time":
    case "frequency":
    case "q":
      delta = Math.max(floorFor(family, param.unit), Math.abs(current) * baseStep);
      break;
    case "percent":
    case "normalized":
      delta = baseStep;
      break;
  }
  const proposed = current + sign * delta;
  const next = clamp(proposed, param.min, param.max);
  return {
    family,
    degree,
    baseStep,
    delta: next - current,
    current,
    proposed,
    next,
    clamped: next !== proposed,
    deltaLabel: labelFor(family, baseStep, next - current, false),
  };
}
