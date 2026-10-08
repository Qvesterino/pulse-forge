/**
 * MASTER ASSISTANT planner (ADR 0020 lineage, M3) — pure, deterministic
 * measurement → parameter mapping for the mastering family (ZENIT, APEKS,
 * ŠÍRKA). No neural net: every step is a rule over the measured numbers with
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
}

export interface MasterAssistantStep {
  /** Which mastering device parameter the step writes. */
  device: "zenit" | "apeks" | "sirka";
  param: string;
  value: number;
  /** Audit line: measurement → decision. Shown in the tool read-back. */
  why: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

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
      const ceiling = clamp(truePeakTarget - 0.5, -6, -0.5);
      steps.push({
        device: "zenit",
        param: "ceiling",
        value: ceiling,
        why: `measured true peak ${m.peakDb.toFixed(1)} dBTP exceeds the ${truePeakTarget.toFixed(1)} dBTP delivery limit — ZENIT ceiling set to ${ceiling.toFixed(1)} dB for margin`,
      });
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
        value: clamp(0.25 + delta * 0.06, 0, 0.7),
        why: `${m.lufs.toFixed(1)} LUFS is ${delta.toFixed(1)} LU under the ${target} target — limiting push to ${(clamp(0.25 + delta * 0.06, 0, 0.7) * 100).toFixed(0)}% (trim loop lands the last LU)`,
      });
      steps.push({
        device: "apeks",
        param: "drive",
        value: 0.45,
        why: "moderate maximizer drive feeds the limiting stage",
      });
    } else if (delta < -2) {
      steps.push({
        device: "zenit",
        param: "ceiling",
        value: -1.5,
        why: `${m.lufs.toFixed(1)} LUFS already ${(-delta).toFixed(1)} LU hot — ceiling discipline, let op:trim reduce`,
      });
    } else if (delta >= -2) {
      steps.push({
        device: "zenit",
        param: "limit",
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
      value: 0.75,
      why: `crest ${m.crestDb.toFixed(1)} dB is squashed — PRESERVE up so hits keep their tip`,
    });
    steps.push({
      device: "zenit",
      param: "glue",
      value: 0.15,
      why: "low crest — glue lightened to avoid double compression",
    });
  } else if (m.crestDb > 14) {
    steps.push({
      device: "zenit",
      param: "glue",
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
        value: 0,
        why: `correlation ${m.correlation.toFixed(2)} — bass collapsed to mono for translation`,
      });
      steps.push({ device: "sirka", param: "midWidth", value: 1.25, why: "near-mono mix — mids widened for space" });
      steps.push({ device: "sirka", param: "highWidth", value: 1.35, why: "near-mono mix — highs widened for air" });
    } else if (m.correlation < 0.2) {
      steps.push({
        device: "sirka",
        param: "midWidth",
        value: 0.85,
        why: `correlation ${m.correlation.toFixed(2)} is phasey — mids pulled toward the center`,
      });
      steps.push({ device: "sirka", param: "highWidth", value: 0.95, why: "phasey highs reined in" });
    }
  }

  // 4. TONAL TILT — harsh top gets a high cut; dull top gets air.
  if (m.hfShare != null) {
    if (m.hfShare > 0.32) {
      steps.push({
        device: "zenit",
        param: "eqHigh",
        value: -1.5,
        why: `high band ${(m.hfShare * 100).toFixed(0)}% of energy — AIR eased`,
      });
    } else if (m.hfShare < 0.12) {
      steps.push({
        device: "zenit",
        param: "eqHigh",
        value: 1.5,
        why: `high band only ${(m.hfShare * 100).toFixed(0)}% — AIR opened`,
      });
    }
  }

  return steps;
}

export interface ReferenceSideMeasurement {
  lufs: number | null;
  crestDb: number;
  correlation: number | null;
  /** Energy shares 0..1 (loudness-invariant domain — the MATCH convention). */
  hfShare: number;
  lowEndShare: number;
}

export interface ReferencePair {
  mine: ReferenceSideMeasurement;
  reference: ReferenceSideMeasurement;
  /** Explicit loudness target overrides the reference's own LUFS. */
  targetLufs?: number;
}

const refBandDeltaDb = (mine: number, ref: number): number =>
  10 * Math.log10(Math.max(mine, 1e-6) / Math.max(ref, 1e-6));

/**
 * REFERENCE MASTERING planner — "urob to ako tento track". The reference's
 * own descriptors are NEVER the target (the F2 §2.2 rule): only the measured
 * DIFFERENCE drives steps, and every step stays bounded and reversible.
 * Loudness reuses planMasterSettings with the reference as target; tonal and
 * space steps map the band deltas (dB-of-own-total, the MATCH convention)
 * onto the same bounded macro surface as op:assist.
 */
export function planReferenceMastering(pair: ReferencePair): MasterAssistantStep[] {
  const steps = planMasterSettings({
    lufs: pair.mine.lufs,
    peakDb: -1,
    crestDb: pair.mine.crestDb,
    correlation: pair.mine.correlation,
    targetLufs: pair.targetLufs ?? pair.reference.lufs ?? undefined,
  });

  const airDelta = refBandDeltaDb(pair.mine.hfShare, pair.reference.hfShare);
  if (airDelta > 1.5) {
    steps.push({
      device: "zenit",
      param: "eqHigh",
      value: clamp(-airDelta, -6, -0.5),
      why: `your air sits ${airDelta.toFixed(1)} dB above the reference — AIR eased toward it`,
    });
  } else if (airDelta < -1.5) {
    steps.push({
      device: "zenit",
      param: "eqHigh",
      value: clamp(-airDelta, 0.5, 6),
      why: `your air sits ${(-airDelta).toFixed(1)} dB under the reference — AIR opened toward it`,
    });
  }

  const lowDelta = refBandDeltaDb(pair.mine.lowEndShare, pair.reference.lowEndShare);
  if (lowDelta > 1.5) {
    steps.push({
      device: "zenit",
      param: "eqLow",
      value: clamp(-lowDelta, -6, -0.5),
      why: `low end ${lowDelta.toFixed(1)} dB heavier than the reference — LOW eased`,
    });
  } else if (lowDelta < -1.5) {
    steps.push({
      device: "zenit",
      param: "eqLow",
      value: clamp(-lowDelta, 0.5, 6),
      why: `low end ${(-lowDelta).toFixed(1)} dB thinner than the reference — LOW strengthened`,
    });
  }

  if (pair.mine.correlation != null && pair.reference.correlation != null) {
    if (pair.reference.correlation < pair.mine.correlation - 0.15) {
      steps.push({
        device: "sirka",
        param: "midWidth",
        value: 1.2,
        why: `reference is wider (corr ${pair.reference.correlation.toFixed(2)} vs yours ${pair.mine.correlation.toFixed(2)}) — mids opened`,
      });
    } else if (pair.reference.correlation > pair.mine.correlation + 0.15) {
      steps.push({
        device: "sirka",
        param: "midWidth",
        value: 0.9,
        why: `reference is tighter (corr ${pair.reference.correlation.toFixed(2)} vs yours ${pair.mine.correlation.toFixed(2)}) — mids focused`,
      });
    }
  }

  const crestDelta = pair.reference.crestDb - pair.mine.crestDb;
  if (crestDelta > 2) {
    steps.push({
      device: "apeks",
      param: "preserve",
      value: 0.7,
      why: `reference keeps ${crestDelta.toFixed(1)} dB more crest — PRESERVE up, dynamics respected`,
    });
  } else if (crestDelta < -2) {
    steps.push({
      device: "zenit",
      param: "glue",
      value: 0.4,
      why: `reference is ${(-crestDelta).toFixed(1)} dB denser — GLUE toward its steadiness`,
    });
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
const shareFromDb = (db: number): number => Math.pow(10, db / 10);

/**
 * Bridge: a buildReferenceMatch report becomes the planner's ReferencePair.
 * Shares come from the report's dB-of-own-total (converted back to linear
 * shares — the planner compares them in the same loudness-invariant domain);
 * crest is not in the report, so the dynamics rules fall back to the mix's
 * own crest when the caller supplies it (optional).
 */
export function referencePairFromMatchReport(
  report: MatchReportForAssistant,
  options: { mineCrestDb?: number; referenceCrestDb?: number } = {},
): import("./master-assistant").ReferencePair {
  const band = (name: string) => report.bands.find((row) => row.band === name && !row.empty);
  const air = band("air");
  const low = band("low");
  return {
    mine: {
      lufs: report.loudness.mixLufs,
      crestDb: options.mineCrestDb ?? 11,
      correlation: report.stereo.mixCorrelation,
      hfShare: air ? shareFromDb(air.mixDb) : 0.2,
      lowEndShare: low ? shareFromDb(low.mixDb) : 0.25,
    },
    reference: {
      lufs: report.loudness.refLufs,
      crestDb: options.referenceCrestDb ?? 11,
      correlation: null,
      hfShare: air ? shareFromDb(air.refDb) : 0.2,
      lowEndShare: low ? shareFromDb(low.refDb) : 0.25,
    },
  };
}
