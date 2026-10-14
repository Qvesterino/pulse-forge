/**
 * CLOSED-LOOP TONAL ITERATOR — "apply → measure → compare → adjust" as a
 * pure, deterministic function. The transport layer calls this in a bounded
 * loop (render → measure → plan → apply), the same pattern as op:land but
 * for TONE (band shares, correlation, crest) rather than just loudness.
 *
 * Every iteration takes the MEASURED result of the previous iteration and
 * produces bounded adjustments. The loop converges when all deltas are
 * within tolerance or the iteration cap is reached. The planner NEVER
 * overshoots: each step is clamped to the param's registry range and the
 * per-iteration adjustment is capped so the loop converges smoothly.
 */

export interface IterateMeasurement {
  lufs: number | null;
  crestDb: number;
  correlation: number | null;
  /** dB-of-own-total per band (the MATCH convention, 7 bands). */
  bandSharesDb: Record<string, number>;
  /** Target: the same shape as mine (reference or profile defaults). */
  target: {
    lufs: number | null;
    crestDb: number;
    correlation: number | null;
    hfShare: number;
    lowEndShare: number;
  };
}

export interface IterateStep {
  device: "zenit" | "apeks" | "sirka";
  param: string;
  /** The DELTA from the current value (the executor adds it to the current). */
  delta: number;
  why: string;
}

export interface IterateTolerances {
  loudnessLu: number;
  bandDb: number;
  correlation: number;
  crestDb: number;
}

export const DEFAULT_TOLERANCES: IterateTolerances = {
  loudnessLu: 0.5,
  bandDb: 0.75,
  correlation: 0.1,
  crestDb: 1.5,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** One iteration: measured result → bounded adjustments toward the target. */
export function iterateTowardTarget(
  measured: IterateMeasurement,
  tolerances: IterateTolerances = DEFAULT_TOLERANCES,
): IterateStep[] {
  const steps: IterateStep[] = [];
  const t = measured.target;

  // 1. Loudness — same bounded logic as op:land but as deltas.
  if (measured.lufs != null && t.lufs != null) {
    const delta = t.lufs - measured.lufs;
    if (Math.abs(delta) > tolerances.loudnessLu) {
      const capped = clamp(delta, -3, 3);
      steps.push({
        device: "zenit",
        param: "limit",
        delta: clamp(delta * 0.1, -0.15, 0.15),
        why: `${Math.abs(delta).toFixed(1)} LU ${delta > 0 ? "under" : "over"} target — limiting ${delta > 0 ? "push" : "ease"}`,
      });
      steps.push({
        device: "zenit",
        param: "ceiling",
        delta: delta < -2 ? -0.25 : 0,
        why: delta < -2 ? "hot mix — ceiling discipline" : "",
      });
      void capped;
    }
  }

  // 2. Band deltas — air and low end.
  const airDelta = bandDelta(measured, "air", t.hfShare);
  if (Math.abs(airDelta) > tolerances.bandDb) {
    const capped = clamp(-airDelta, -1.5, 1.5);
    steps.push({
      device: "zenit",
      param: "eqHigh",
      delta: capped,
      why: `air ${airDelta > 0 ? "+" : ""}${airDelta.toFixed(1)} dB vs target — adjust`,
    });
  }
  const lowDelta = bandDelta(measured, "low", t.lowEndShare);
  if (Math.abs(lowDelta) > tolerances.bandDb) {
    const capped = clamp(-lowDelta, -1.5, 1.5);
    steps.push({
      device: "zenit",
      param: "eqLow",
      delta: capped,
      why: `low end ${lowDelta > 0 ? "+" : ""}${lowDelta.toFixed(1)} dB vs target — adjust`,
    });
  }

  // 3. Correlation — width family.
  if (measured.correlation != null && t.correlation != null) {
    const corrDelta = t.correlation - measured.correlation;
    if (Math.abs(corrDelta) > tolerances.correlation) {
      const dir = corrDelta > 0 ? 1 : -1;
      steps.push({
        device: "sirka",
        param: "midWidth",
        delta: dir * 0.15,
        why: `correlation ${measured.correlation.toFixed(2)} vs target ${t.correlation.toFixed(2)} — ${dir > 0 ? "widen" : "focus"} mids`,
      });
    }
  }

  // 4. Crest — preserve/glue.
  const crestDelta = t.crestDb - measured.crestDb;
  if (crestDelta > tolerances.crestDb) {
    steps.push({
      device: "apeks",
      param: "preserve",
      delta: 0.1,
      why: `crest ${crestDelta.toFixed(1)} dB under target — PRESERVE up`,
    });
  } else if (crestDelta < -tolerances.crestDb) {
    steps.push({
      device: "zenit",
      param: "glue",
      delta: 0.1,
      why: `crest ${(-crestDelta).toFixed(1)} dB over target — GLUE up`,
    });
  }

  return steps.filter((s) => s.why.length > 0);
}

/** Band delta in dB (loudness-invariant). Returns 0 when either side is silent. */
function bandDelta(m: IterateMeasurement, band: string, targetShare: number): number {
  const mine = m.bandSharesDb[band];
  if (mine == null) return 0;
  // The measured is in dB-of-own-total; the target is a linear share 0..1.
  const targetDb = 10 * Math.log10(Math.max(targetShare, 1e-6));
  return mine - targetDb;
}

/** Convergence check: all deltas within tolerance → the loop is done. */
export function isConverged(m: IterateMeasurement, tolerances: IterateTolerances = DEFAULT_TOLERANCES): boolean {
  if (m.lufs != null && m.target.lufs != null && Math.abs(m.lufs - m.target.lufs) > tolerances.loudnessLu) return false;
  if (Math.abs(bandDelta(m, "air", m.target.hfShare)) > tolerances.bandDb) return false;
  if (Math.abs(bandDelta(m, "low", m.target.lowEndShare)) > tolerances.bandDb) return false;
  if (
    m.correlation != null &&
    m.target.correlation != null &&
    Math.abs(m.target.correlation - m.correlation) > tolerances.correlation
  )
    return false;
  if (Math.abs(m.target.crestDb - m.crestDb) > tolerances.crestDb) return false;
  return true;
}
