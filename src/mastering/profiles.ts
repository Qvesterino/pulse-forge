/**
 * Shared delivery-profile data and verdict rules.
 *
 * Profile values are editable starting points, not platform compliance
 * guarantees. The same evaluator is used by the master meter, export report,
 * and MCP mastering tools so those surfaces cannot disagree about thresholds.
 */

export type MasterProfileId = "streaming" | "apple" | "loud" | "vinyl" | "custom";

export interface MasterProfile {
  id: MasterProfileId;
  label: string;
  targetLufs: number;
  targetToleranceLufs: number;
  warningToleranceLufs: number;
  maxTruePeakDb: number;
  truePeakGraceDb: number;
  note: string;
  recommendedFormat: string;
  intendedUse: string;
}

export const MASTER_PROFILES: readonly MasterProfile[] = [
  {
    id: "streaming",
    label: "Streaming",
    targetLufs: -14,
    targetToleranceLufs: 1,
    warningToleranceLufs: 2,
    maxTruePeakDb: -1,
    truePeakGraceDb: 0.3,
    note: "Starting point for streaming delivery; check the current distributor requirements.",
    recommendedFormat: "24-bit PCM WAV",
    intendedUse: "General streaming delivery. Loudness normalization and encoding behavior vary by service.",
  },
  {
    id: "apple",
    label: "Quieter / dynamic",
    targetLufs: -16,
    targetToleranceLufs: 1,
    warningToleranceLufs: 2,
    maxTruePeakDb: -1,
    truePeakGraceDb: 0.3,
    note: "A quieter starting point that leaves room for dynamic playback and lossy encoding.",
    recommendedFormat: "24-bit PCM WAV",
    intendedUse: "A lower-loudness alternative; this is not an Apple Music certification profile.",
  },
  {
    id: "loud",
    label: "Club / loud",
    targetLufs: -8,
    targetToleranceLufs: 1,
    warningToleranceLufs: 2,
    maxTruePeakDb: -0.3,
    truePeakGraceDb: 0.3,
    note: "High loudness can increase distortion after encoding and on playback systems.",
    recommendedFormat: "24-bit PCM WAV",
    intendedUse: "A loudness-oriented starting point for club and DJ playback.",
  },
  {
    id: "vinyl",
    label: "Vinyl pre-master",
    targetLufs: -12,
    targetToleranceLufs: 1,
    warningToleranceLufs: 2,
    maxTruePeakDb: -2,
    truePeakGraceDb: 0.3,
    note: "A conservative digital handoff target; the cutting engineer sets final requirements.",
    recommendedFormat: "24-bit PCM WAV",
    intendedUse: "Pre-master handoff for a cutting engineer; this does not replace lacquer-specific checks.",
  },
];

export const CUSTOM_PROFILE: MasterProfile = {
  id: "custom",
  label: "Custom",
  targetLufs: -14,
  targetToleranceLufs: 1,
  warningToleranceLufs: 2,
  maxTruePeakDb: -1,
  truePeakGraceDb: 0.3,
  note: "User-defined loudness and true-peak limits.",
  recommendedFormat: "Choose a format for the delivery destination.",
  intendedUse: "A custom delivery target defined by the user.",
};

export function profileFor(id: string | undefined): MasterProfile | null {
  return MASTER_PROFILES.find((profile) => profile.id === id) ?? null;
}

/** Resolve the project's stored delivery choice without changing the audio graph. */
export function resolveDeliveryTarget(config: {
  deliveryProfileId?: unknown;
  lufsTarget?: unknown;
  deliveryTruePeakDb?: unknown;
  ceilingDb?: unknown;
}): MasterProfile {
  const id = isMasterProfileId(config.deliveryProfileId) ? config.deliveryProfileId : "custom";
  const base = id === "custom" ? CUSTOM_PROFILE : (profileFor(id) ?? CUSTOM_PROFILE);
  const targetLufs =
    typeof config.lufsTarget === "number" && Number.isFinite(config.lufsTarget) ? config.lufsTarget : base.targetLufs;
  const maxTruePeakDb =
    typeof config.deliveryTruePeakDb === "number" && Number.isFinite(config.deliveryTruePeakDb)
      ? config.deliveryTruePeakDb
      : typeof config.ceilingDb === "number" && Number.isFinite(config.ceilingDb)
        ? config.ceilingDb
        : base.maxTruePeakDb;
  return { ...base, targetLufs, maxTruePeakDb };
}

export function isMasterProfileId(value: unknown): value is MasterProfileId {
  return value === "streaming" || value === "apple" || value === "loud" || value === "vinyl" || value === "custom";
}

export interface DeliveryMetrics {
  lufs: number | null;
  truePeakDb: number;
  correlation?: number | null;
  monoLossDb?: number | null;
  lrImbalanceDb?: number | null;
}

export interface DeliveryCheck {
  status: "pass" | "warn" | "fail";
  line: string;
}

export interface DeliveryVerdict {
  status: DeliveryCheck["status"];
  checks: DeliveryCheck[];
  loudnessDeltaDb: number;
}

/** Evaluate all available measurements against one delivery target. */
export function evaluateDelivery(
  metrics: DeliveryMetrics,
  profile: MasterProfile,
  targetLufsInput = profile.targetLufs,
  maxTruePeakDbInput = profile.maxTruePeakDb,
): DeliveryVerdict {
  const targetLufs = Number.isFinite(targetLufsInput) ? targetLufsInput : profile.targetLufs;
  const maxTruePeakDb = Number.isFinite(maxTruePeakDbInput) ? maxTruePeakDbInput : profile.maxTruePeakDb;
  const checks: DeliveryCheck[] = [];
  let loudnessDeltaDb = 0;
  if (metrics.lufs == null || !Number.isFinite(metrics.lufs) || metrics.lufs <= -119) {
    checks.push({
      status: "warn",
      line: `${profile.label}: LUFS not measurable — play a few seconds for integration to settle`,
    });
  } else {
    loudnessDeltaDb = metrics.lufs - targetLufs;
    const distance = Math.abs(loudnessDeltaDb);
    const status: DeliveryCheck["status"] =
      distance <= profile.targetToleranceLufs ? "pass" : distance <= profile.warningToleranceLufs ? "warn" : "fail";
    const where =
      loudnessDeltaDb > 0 ? `${loudnessDeltaDb.toFixed(1)} LU HOT` : `${(-loudnessDeltaDb).toFixed(1)} LU under`;
    checks.push({
      status,
      line: `${profile.label}: ${metrics.lufs.toFixed(1)} LUFS vs target ${targetLufs} — ${where}`,
    });
  }

  if (!Number.isFinite(metrics.truePeakDb)) {
    checks.push({ status: "warn", line: `${profile.label}: true peak not measurable` });
  } else {
    const tpOver = metrics.truePeakDb - maxTruePeakDb;
    if (tpOver > profile.truePeakGraceDb) {
      checks.push({
        status: "fail",
        line: `true peak ${metrics.truePeakDb.toFixed(1)} dBTP exceeds the ${maxTruePeakDb} dBTP target by ${tpOver.toFixed(1)} dB`,
      });
    } else if (tpOver > 0) {
      checks.push({
        status: "warn",
        line: `true peak ${metrics.truePeakDb.toFixed(1)} dBTP grazes the ${maxTruePeakDb} dBTP target`,
      });
    } else {
      checks.push({
        status: "pass",
        line: `true peak ${metrics.truePeakDb.toFixed(1)} dBTP within the ${maxTruePeakDb} dBTP target`,
      });
    }
  }

  if (metrics.correlation != null && metrics.correlation < 0) {
    checks.push({ status: "fail", line: "Phase issues — check mono compatibility" });
  }
  if (metrics.monoLossDb != null && metrics.monoLossDb < -3) {
    checks.push({ status: "warn", line: "Mono fold-down loses depth — check wide elements" });
  }
  if (metrics.lrImbalanceDb != null && metrics.lrImbalanceDb > 6) {
    checks.push({ status: "warn", line: "Left/right balance off by more than 6 dB" });
  }
  if (profile.id === "vinyl") {
    checks.push({
      status: "warn",
      line: `${profile.note} Check mono compatibility and side-chain/low-frequency behavior with the cutting engineer.`,
    });
  }

  return { status: worstStatus(checks), checks, loudnessDeltaDb };
}

/** Worst status across delivery checks — the one-line summary status. */
export function worstStatus(checks: DeliveryCheck[]): DeliveryCheck["status"] {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "warn")) return "warn";
  return "pass";
}

/** Legacy MCP API retained while the shared profile contract moves out of MCP. */
export function verdictAgainst(metrics: DeliveryMetrics, profile: MasterProfile): DeliveryCheck[] {
  return evaluateDelivery(metrics, profile).checks;
}
