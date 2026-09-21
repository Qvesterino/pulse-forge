/**
 * Confidence helpers. Ported from audiokey `src/analysis/confidence.ts`.
 * Thresholds live in exactly one place — UI wording keys off these.
 */
export type ConfidenceLevel = "high" | "moderate" | "low";

export const CONFIDENCE_THRESHOLDS = { high: 80, moderate: 55 };

export function confidenceLevel(percent: number): ConfidenceLevel {
  if (percent >= CONFIDENCE_THRESHOLDS.high) return "high";
  if (percent >= CONFIDENCE_THRESHOLDS.moderate) return "moderate";
  return "low";
}

export function confidenceLabel(percent: number): string {
  const level = confidenceLevel(percent);
  return level === "high" ? "High confidence" : level === "moderate" ? "Moderate confidence" : "Low confidence";
}

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

export function toPercent(x: number): number {
  return Math.round(clamp01(x) * 100);
}
