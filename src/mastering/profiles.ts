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
  /** Verified file-delivery limitations or requirements; never used to auto-change export settings. */
  fileGuidanceNote?: string;
}

export interface MasterProfileSource {
  label: string;
  url: string;
  checkedAt: string;
  reviewIntervalDays: number;
}

/** Current primary references behind platform-specific profile guidance. */
export const MASTER_PROFILE_SOURCES: Partial<Record<MasterProfileId, MasterProfileSource>> = {
  streaming: {
    label: "Spotify for Artists · Loudness normalization",
    url: "https://support.spotify.com/us/artists/article/loudness-normalization/",
    checkedAt: "2026-10-07",
    reviewIntervalDays: 180,
  },
};

/** Primary file-delivery references, kept separate from loudness-target references. */
export const MASTER_PROFILE_FILE_SOURCES: Partial<Record<MasterProfileId, MasterProfileSource>> = {
  streaming: {
    label: "Spotify for Artists · Audio file formats",
    url: "https://support.spotify.com/us/artists/article/audio-file-formats/",
    checkedAt: "2026-10-07",
    reviewIntervalDays: 180,
  },
};

/** Sources older than their review interval must not be presented as current guidance. */
export function isMasterProfileSourceReviewDue(source: MasterProfileSource, now = Date.now()): boolean {
  const checkedAt = Date.parse(`${source.checkedAt}T00:00:00.000Z`);
  const reviewIntervalMs = source.reviewIntervalDays * 24 * 60 * 60 * 1000;
  return (
    !Number.isFinite(checkedAt) ||
    !Number.isFinite(reviewIntervalMs) ||
    reviewIntervalMs <= 0 ||
    checkedAt > now ||
    now - checkedAt >= reviewIntervalMs
  );
}

export interface MasterProfileProvenance {
  basis: "primary-source" | "workflow-baseline" | "user-defined";
  review: "current" | "due" | "not-applicable";
  source: MasterProfileSource | null;
  fileSettingsReview: "current" | "due" | "not-applicable";
  fileSettingsSource: MasterProfileSource | null;
}

/** Stable, report-friendly account of where a profile's guidance comes from. */
export function masterProfileProvenance(profileId: MasterProfileId, asOf = Date.now()): MasterProfileProvenance {
  const fileSettingsSource = MASTER_PROFILE_FILE_SOURCES[profileId] ?? null;
  const fileSettingsReview = fileSettingsSource
    ? isMasterProfileSourceReviewDue(fileSettingsSource, asOf)
      ? "due"
      : "current"
    : "not-applicable";
  if (profileId === "custom") {
    return {
      basis: "user-defined",
      review: "not-applicable",
      source: null,
      fileSettingsReview,
      fileSettingsSource: fileSettingsSource ? { ...fileSettingsSource } : null,
    };
  }
  const source = MASTER_PROFILE_SOURCES[profileId];
  if (!source) {
    return {
      basis: "workflow-baseline",
      review: "not-applicable",
      source: null,
      fileSettingsReview,
      fileSettingsSource: fileSettingsSource ? { ...fileSettingsSource } : null,
    };
  }
  return {
    basis: "primary-source",
    review: isMasterProfileSourceReviewDue(source, asOf) ? "due" : "current",
    source: { ...source },
    fileSettingsReview,
    fileSettingsSource: fileSettingsSource ? { ...fileSettingsSource } : null,
  };
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
    note: "−14 LUFS / −1 dBTP start; Spotify advises < −2 dBTP above −14 LUFS.",
    recommendedFormat: "24-bit PCM WAV · FLAC preferred by Spotify",
    intendedUse:
      "General starting point, not a universal platform specification. Spotify's conditional peak guidance is shown as an advisory.",
    fileGuidanceNote:
      "Spotify strongly prefers FLAC; WAV is also accepted. Its guidance requires at least 44.1 kHz and advises preserving native rate and bit depth. Project renders offer 44.1/48 kHz without a project-native rate; external sessions decode at 44.1 kHz. KYX has no FLAC export, so this workflow cannot promise native-rate delivery. RATE stays manual.",
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
  status: "pass" | "warn" | "fail" | "not-measured";
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
      status: "not-measured",
      line: `${profile.label}: LUFS not measured — render a programme long enough for integrated loudness`,
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
    checks.push({ status: "not-measured", line: `${profile.label}: true peak not measured` });
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

  // Spotify publishes a stricter true-peak recommendation for masters louder
  // than −14 LUFS. Keep this as an advisory beside the general profile check:
  // it is not a universal streaming requirement or a processing instruction.
  if (
    profile.id === "streaming" &&
    metrics.lufs != null &&
    Number.isFinite(metrics.lufs) &&
    metrics.lufs > -14 &&
    Number.isFinite(metrics.truePeakDb) &&
    metrics.truePeakDb >= -2
  ) {
    checks.push({
      status: "warn",
      line: `Spotify guidance: at ${metrics.lufs.toFixed(1)} LUFS, keep true peak below −2 dBTP to reduce lossy-encoding distortion risk`,
    });
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
  const stereoMetrics = [metrics.correlation, metrics.monoLossDb, metrics.lrImbalanceDb];
  if (stereoMetrics.every((value) => value == null)) {
    checks.push({
      status: "not-measured",
      line: "Stereo compatibility not measured — an audible stereo programme is required",
    });
  } else {
    if (metrics.correlation == null) checks.push({ status: "not-measured", line: "Stereo correlation not measured" });
    if (metrics.monoLossDb == null) checks.push({ status: "not-measured", line: "Mono fold-down loss not measured" });
    if (metrics.lrImbalanceDb == null) checks.push({ status: "not-measured", line: "L/R balance not measured" });
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
  if (checks.some((check) => check.status === "not-measured")) return "not-measured";
  return "pass";
}

/** Legacy MCP API retained while the shared profile contract moves out of MCP. */
export function verdictAgainst(metrics: DeliveryMetrics, profile: MasterProfile): DeliveryCheck[] {
  return evaluateDelivery(metrics, profile).checks;
}
