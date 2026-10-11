/**
 * MASTER ASSISTANT planner (ADR 0020 lineage, M3) — pure, deterministic
 * measurement → parameter mapping for the mastering family (ZENIT, APEX,
 * SPAN). No neural net: every step is a rule over the measured numbers with
 * an explicit WHY line, so the agent (and the user) can audit each move.
 * The executor (kyx_master op:assist) applies the plan through the normal
 * command layer as ONE snapshot — the planner never touches the doc.
 *
 * With an explicit delivery contract, production callers receive only an
 * evidence-backed true-peak ceiling suggestion; LUFS, crest, stereo and band
 * shares remain report-only because they do not reveal a safe correction by
 * themselves. The legacy no-contract planner path remains for existing API
 * consumers. The loudness loop (op:trim) stays the loudness authority.
 */

export interface MasterMeasurement {
  /** Integrated LUFS; null = not measurable (assistant skips loudness rules). */
  lufs: number | null;
  /** True peak in dBTP when available; legacy MCP callers may pass peak hold. */
  peakDb: number;
  /** crest = peak − rms in dB; low crest = squashed, high = peaky. */
  crestDb: number;
  /** Stereo correlation −1..1; null = not measurable. */
  correlation: number | null;
  /** High-band energy share 0..1 (harshness-prone); null = unknown. */
  hfShare?: number | null;
  /** Target integrated loudness (default −14 LUFS streaming). */
  targetLufs?: number;
  /** Target true peak in dBTP; when present, ceiling advice follows this delivery contract. */
  targetTruePeakDb?: number;
  /** `master` routes delivery advice to the final project limiter; default `insert` is for MCP track targets. */
  targetScope?: "insert" | "master";
  /** Current state of the final master limiter when targetScope is `master`. */
  masterLimiterEnabled?: boolean;
}

export type MasterAssistantDevice = "master" | "zenit" | "apeks" | "sirka";

export interface MasterAssistantStep {
  /** Which mastering device parameter the step writes. */
  device: MasterAssistantDevice;
  param: string;
  /** How to interpret value against the parameter's current value. */
  adjustment?: "increase" | "decrease" | "delta";
  /** Requested bound or offset; resolveMasterAssistantStepValue produces the actual target. */
  value: number;
  /** Audit line: measurement → decision. Shown in the tool read-back. */
  why: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Resolve a recommendation monotonically against the setting that is active now. */
export function resolveMasterAssistantStepValue(
  step: MasterAssistantStep,
  current: number,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
): number {
  const requested =
    step.adjustment === "increase"
      ? Math.max(current, step.value)
      : step.adjustment === "decrease"
        ? Math.min(current, step.value)
        : step.adjustment === "delta"
          ? current + step.value
          : step.value;
  return clamp(requested, min, max);
}

export function planMasterSettings(m: MasterMeasurement): MasterAssistantStep[] {
  const steps: MasterAssistantStep[] = [];
  const target = m.targetLufs ?? -14;

  // 1. DELIVERY CONTRACT. With an explicit target, only a measured true-peak
  // violation is strong enough evidence for an automatic insert change.
  // Loudness, crest, correlation and band shares stay advisory; they cannot
  // identify whether a master-bus correction is safer than fixing the mix.
  const truePeakTarget = m.targetTruePeakDb;
  if (truePeakTarget != null) {
    if (m.peakDb > truePeakTarget + 0.3) {
      if (m.targetScope === "master") {
        if (!m.masterLimiterEnabled) {
          steps.push({
            device: "master",
            param: "limiterEnabled",
            value: 1,
            why: "the final master limiter is disabled — enable it before applying a delivery ceiling",
          });
        }
        const reductionDb = clamp(m.peakDb - truePeakTarget + 0.5, 0.5, 12);
        steps.push({
          device: "master",
          param: "ceilingDb",
          adjustment: "delta",
          value: -reductionDb,
          why: `measured true peak ${m.peakDb.toFixed(1)} dBTP exceeds the ${truePeakTarget.toFixed(1)} dBTP delivery limit — lower the final master limiter by ${reductionDb.toFixed(1)} dB, including 0.5 dB margin`,
        });
      } else {
        const ceiling = clamp(truePeakTarget - 0.5, -6, -0.5);
        steps.push({
          device: "zenit",
          param: "ceiling",
          adjustment: "decrease",
          value: ceiling,
          why: `measured true peak ${m.peakDb.toFixed(1)} dBTP exceeds the ${truePeakTarget.toFixed(1)} dBTP delivery limit — ZENIT insert ceiling set to ${ceiling.toFixed(1)} dB for margin`,
        });
      }
    }
    return steps;
  }

  // Legacy no-contract callers retain their shape heuristics for compatibility.
  if (m.lufs != null) {
    const delta = target - m.lufs; // >0 = needs loudness
    if (delta > 2) {
      steps.push({
        device: "zenit",
        param: "limit",
        adjustment: "increase",
        value: clamp(0.25 + delta * 0.06, 0, 0.7),
        why: `${m.lufs.toFixed(1)} LUFS is ${delta.toFixed(1)} LU under the ${target} target — limiting push to ${(clamp(0.25 + delta * 0.06, 0, 0.7) * 100).toFixed(0)}% (trim loop lands the last LU)`,
      });
      steps.push({
        device: "apeks",
        param: "drive",
        adjustment: "increase",
        value: 0.45,
        why: "moderate maximizer drive feeds the limiting stage",
      });
    } else if (delta < -2) {
      steps.push({
        device: "zenit",
        param: "ceiling",
        adjustment: "decrease",
        value: -1.5,
        why: `${m.lufs.toFixed(1)} LUFS already ${(-delta).toFixed(1)} LU hot — ceiling discipline, let op:trim reduce`,
      });
    } else if (delta >= -2) {
      steps.push({
        device: "zenit",
        param: "limit",
        adjustment: "increase",
        value: 0.15,
        why: `loudness within ±2 LU of target — light limiting only`,
      });
    }
  }

  // 2. PUNCH — squashed crest asks the maximizer to keep transients alive and
  // the glue to loosen; peaky crest gets gentle glue.
  if (m.crestDb < 8) {
    steps.push({
      device: "apeks",
      param: "preserve",
      adjustment: "increase",
      value: 0.75,
      why: `crest ${m.crestDb.toFixed(1)} dB is squashed — PRESERVE up so hits keep their tip`,
    });
    steps.push({
      device: "zenit",
      param: "glue",
      adjustment: "decrease",
      value: 0.15,
      why: "low crest — glue lightened to avoid double compression",
    });
  } else if (m.crestDb > 14) {
    steps.push({
      device: "zenit",
      param: "glue",
      adjustment: "increase",
      value: 0.35,
      why: `crest ${m.crestDb.toFixed(1)} dB is peaky — moderate glue to steady the bus`,
    });
  }

  // 3. STEREO FIELD — near-mono mixes widen mids/highs and mono the bass;
  // narrow/phasey content gets pulled back toward the center.
  if (m.correlation != null) {
    if (m.correlation > 0.95) {
      steps.push({
        device: "sirka",
        param: "lowWidth",
        adjustment: "decrease",
        value: 0,
        why: `correlation ${m.correlation.toFixed(2)} — bass collapsed to mono for translation`,
      });
      steps.push({
        device: "sirka",
        param: "midWidth",
        adjustment: "increase",
        value: 1.25,
        why: "near-mono mix — mids widened for space",
      });
      steps.push({
        device: "sirka",
        param: "highWidth",
        adjustment: "increase",
        value: 1.35,
        why: "near-mono mix — highs widened for air",
      });
    } else if (m.correlation < 0.2) {
      steps.push({
        device: "sirka",
        param: "midWidth",
        adjustment: "decrease",
        value: 0.85,
        why: `correlation ${m.correlation.toFixed(2)} is phasey — mids pulled toward the center`,
      });
      steps.push({
        device: "sirka",
        param: "highWidth",
        adjustment: "decrease",
        value: 0.95,
        why: "phasey highs reined in",
      });
    }
  }

  // 4. TONAL TILT — harsh top gets a high cut; dull top gets air.
  if (m.hfShare != null) {
    if (m.hfShare > 0.32) {
      steps.push({
        device: "zenit",
        param: "eqHigh",
        adjustment: "delta",
        value: -1.5,
        why: `high band ${(m.hfShare * 100).toFixed(0)}% of energy — AIR eased`,
      });
    } else if (m.hfShare < 0.12) {
      steps.push({
        device: "zenit",
        param: "eqHigh",
        adjustment: "delta",
        value: 1.5,
        why: `high band only ${(m.hfShare * 100).toFixed(0)}% — AIR opened`,
      });
    }
  }

  return steps;
}

export interface ReferenceSideMeasurement {
  lufs: number | null;
  crestDb: number | null;
  correlation: number | null;
  /** Energy shares 0..1 (loudness-invariant domain — the MATCH convention). */
  hfShare: number | null;
  lowEndShare: number | null;
}

export interface ReferencePair {
  mine: ReferenceSideMeasurement;
  reference: ReferenceSideMeasurement;
  /** Explicit loudness target overrides the reference's own LUFS. */
  targetLufs?: number;
}

/** Measured, file-backed reference passed from the MASTER comparison to its assistant. */
export interface MasteringReferenceMeasurement {
  id: string;
  fileName: string;
  measurement: ReferenceSideMeasurement;
}

const refBandDeltaDb = (mine: number, ref: number): number =>
  10 * Math.log10(Math.max(mine, 1e-6) / Math.max(ref, 1e-6));

const isFiniteNumber = (value: number | null | undefined): value is number => value != null && Number.isFinite(value);

const isEnergyShare = (value: number | null | undefined): value is number =>
  isFiniteNumber(value) && value >= 0 && value <= 1;

const isCorrelation = (value: number | null | undefined): value is number =>
  isFiniteNumber(value) && value >= -1 && value <= 1;

/**
 * REFERENCE MASTERING planner — "urob to ako tento track". Reference values
 * alone never produce a step: each recommendation needs a measured pair (or
 * an explicit loudness target), and every step stays bounded and reversible.
 * Tonal and space steps map band deltas (dB-of-own-total, the MATCH
 * convention) onto the bounded macro surface shared with op:assist. A
 * reference that is louder than the current master does not lower the
 * limiter ceiling; level reduction belongs to an explicit trim decision.
 */
export function planReferenceMastering(pair: ReferencePair): MasterAssistantStep[] {
  const steps: MasterAssistantStep[] = [];

  // Loudness is comparable only when both LUFS readings (or an explicit
  // target) exist. A master that is already louder than its reference is not
  // reduced by lowering its limiter ceiling; only a clear quieter-side gap
  // can justify a bounded density suggestion.
  const explicitTarget = isFiniteNumber(pair.targetLufs);
  const targetLufs = explicitTarget ? pair.targetLufs : pair.reference.lufs;
  const loudnessTargetLabel = explicitTarget ? "target" : "reference";
  if (isFiniteNumber(pair.mine.lufs) && isFiniteNumber(targetLufs)) {
    const loudnessDelta = targetLufs - pair.mine.lufs;
    if (loudnessDelta > 2) {
      const limit = clamp(0.25 + loudnessDelta * 0.06, 0, 0.7);
      steps.push({
        device: "zenit",
        param: "limit",
        adjustment: "increase",
        value: limit,
        why: `your master is ${loudnessDelta.toFixed(1)} LU below the ${loudnessTargetLabel} — bounded LIMIT push to ${(limit * 100).toFixed(0)}%`,
      });
      steps.push({
        device: "apeks",
        param: "drive",
        adjustment: "increase",
        value: 0.45,
        why: "moderate APEX drive supports the measured loudness move; compare transients in preview",
      });
    } else if (loudnessDelta >= 1) {
      steps.push({
        device: "zenit",
        param: "limit",
        adjustment: "increase",
        value: 0.15,
        why: `your master is ${loudnessDelta.toFixed(1)} LU below the ${loudnessTargetLabel} — light limiting only`,
      });
    }
  }

  if (isEnergyShare(pair.mine.hfShare) && isEnergyShare(pair.reference.hfShare)) {
    const airDelta = refBandDeltaDb(pair.mine.hfShare, pair.reference.hfShare);
    if (airDelta > 1.5) {
      steps.push({
        device: "zenit",
        param: "eqHigh",
        adjustment: "delta",
        value: clamp(-airDelta, -6, -0.5),
        why: `your air sits ${airDelta.toFixed(1)} dB above the reference — AIR eased toward it`,
      });
    } else if (airDelta < -1.5) {
      steps.push({
        device: "zenit",
        param: "eqHigh",
        adjustment: "delta",
        value: clamp(-airDelta, 0.5, 6),
        why: `your air sits ${(-airDelta).toFixed(1)} dB under the reference — AIR opened toward it`,
      });
    }
  }

  if (isEnergyShare(pair.mine.lowEndShare) && isEnergyShare(pair.reference.lowEndShare)) {
    const lowDelta = refBandDeltaDb(pair.mine.lowEndShare, pair.reference.lowEndShare);
    if (lowDelta > 1.5) {
      steps.push({
        device: "zenit",
        param: "eqLow",
        adjustment: "delta",
        value: clamp(-lowDelta, -6, -0.5),
        why: `low end ${lowDelta.toFixed(1)} dB heavier than the reference — LOW eased`,
      });
    } else if (lowDelta < -1.5) {
      steps.push({
        device: "zenit",
        param: "eqLow",
        adjustment: "delta",
        value: clamp(-lowDelta, 0.5, 6),
        why: `low end ${(-lowDelta).toFixed(1)} dB thinner than the reference — LOW strengthened`,
      });
    }
  }

  if (isCorrelation(pair.mine.correlation) && isCorrelation(pair.reference.correlation)) {
    if (pair.reference.correlation < pair.mine.correlation - 0.15) {
      steps.push({
        device: "sirka",
        param: "midWidth",
        adjustment: "increase",
        value: 1.2,
        why: `reference correlation is lower (${pair.reference.correlation.toFixed(2)} vs yours ${pair.mine.correlation.toFixed(2)}) — audition a wider mid setting; correlation is not a direct width measurement`,
      });
    } else if (pair.reference.correlation > pair.mine.correlation + 0.15) {
      steps.push({
        device: "sirka",
        param: "midWidth",
        adjustment: "decrease",
        value: 0.9,
        why: `reference correlation is higher (${pair.reference.correlation.toFixed(2)} vs yours ${pair.mine.correlation.toFixed(2)}) — audition a tighter mid setting; correlation is not a direct width measurement`,
      });
    }
  }

  if (isFiniteNumber(pair.mine.crestDb) && isFiniteNumber(pair.reference.crestDb)) {
    const crestDelta = pair.reference.crestDb - pair.mine.crestDb;
    if (crestDelta > 2) {
      steps.push({
        device: "apeks",
        param: "preserve",
        adjustment: "increase",
        value: 0.7,
        why: `reference keeps ${crestDelta.toFixed(1)} dB more crest — PRESERVE up, dynamics respected`,
      });
    } else if (crestDelta < -2) {
      steps.push({
        device: "zenit",
        param: "glue",
        adjustment: "increase",
        value: 0.4,
        why: `reference is ${(-crestDelta).toFixed(1)} dB denser — GLUE toward its steadiness`,
      });
    }
  }

  return steps;
}

/** The slice of ReferenceMatchReport (src/reference/match.ts) the planner needs. */
export interface MatchReportForAssistant {
  bands: { band: string; mixDb: number; refDb: number; empty: boolean }[];
  loudness: { mixLufs: number | null; refLufs: number | null; deltaLu: number | null };
  stereo: { mixCorrelation: number | null; refSideRatio: number };
}

/** Convert a mix-doctor band share (dB of own total) to a 0..1 share. */
const shareFromDb = (db: number): number | null => (Number.isFinite(db) ? clamp(Math.pow(10, db / 10), 0, 1) : null);

/**
 * Bridge: a buildReferenceMatch report becomes the planner's ReferencePair.
 * Shares come from the report's dB-of-own-total (converted back to linear
 * shares — the planner compares them in the same loudness-invariant domain).
 * Crest is not in that report, so dynamics comparisons are skipped unless
 * both crest readings are supplied by the caller.
 */
export function referencePairFromMatchReport(
  report: MatchReportForAssistant,
  options: { mineCrestDb?: number; referenceCrestDb?: number } = {},
): import("./master-assistant").ReferencePair {
  const combinedShare = (names: string[], side: "mixDb" | "refDb"): number | null => {
    const rows = report.bands.filter((row) => names.includes(row.band) && !row.empty);
    if (rows.length === 0) return null;
    let total = 0;
    for (const row of rows) {
      const share = shareFromDb(row[side]);
      if (share == null) return null;
      total += share;
    }
    return clamp(total, 0, 1);
  };
  return {
    mine: {
      lufs: report.loudness.mixLufs,
      crestDb: isFiniteNumber(options.mineCrestDb) ? options.mineCrestDb : null,
      correlation: report.stereo.mixCorrelation,
      hfShare: combinedShare(["high", "air"], "mixDb"),
      lowEndShare: combinedShare(["sub", "low"], "mixDb"),
    },
    reference: {
      lufs: report.loudness.refLufs,
      crestDb: isFiniteNumber(options.referenceCrestDb) ? options.referenceCrestDb : null,
      correlation: null,
      hfShare: combinedShare(["high", "air"], "refDb"),
      lowEndShare: combinedShare(["sub", "low"], "refDb"),
    },
  };
}
