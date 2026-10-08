/**
 * Shared delivery-profile data and verdict rules.
 *
 * Profile values are editable starting points, not platform compliance
 * guarantees. The same evaluator is used by the master meter, export report,
 * and MCP mastering tools so those surfaces cannot disagree about thresholds.
 */

export type MasterProfileId = "streaming" | "apple" | "loud" | "vinyl" | "custom";

export type MasterFileFormat = "wav" | "flac" | "mp3";
export type MasterFileBitDepth = 16 | 24 | 32;
export type MasterFlacBitDepth = 16 | 24;

export type MasterFileEncodingSuggestion =
  | { format: "wav"; bitDepth: MasterFileBitDepth }
  | { format: "flac"; bitDepth: MasterFlacBitDepth }
  | { format: "mp3"; bitrateKbps: 192 | 320 };

export interface MasterProfileExportSettings {
  preferred: MasterFileEncodingSuggestion;
  alternatives?: readonly MasterFileEncodingSuggestion[];
}

/** Machine-readable export defaults are kept separate from the profile's display copy. */
const MASTER_PROFILE_EXPORT_SETTINGS: Partial<Record<MasterProfileId, MasterProfileExportSettings>> = {
  streaming: {
    preferred: { format: "flac", bitDepth: 24 },
    alternatives: [{ format: "wav", bitDepth: 24 }],
  },
  apple: { preferred: { format: "wav", bitDepth: 24 } },
};

/** Return a copy so an export panel cannot mutate the shared profile defaults. */
export function masterProfileExportSettings(profileId: MasterProfileId): MasterProfileExportSettings | null {
  const settings = MASTER_PROFILE_EXPORT_SETTINGS[profileId];
  return settings
    ? {
        preferred: { ...settings.preferred },
        ...(settings.alternatives
          ? { alternatives: settings.alternatives.map((alternative) => ({ ...alternative })) }
          : {}),
      }
    : null;
}

function describeMasterFileEncoding(suggestion: MasterFileEncodingSuggestion): string {
  if (suggestion.format === "wav") return `${suggestion.bitDepth}-bit PCM WAV`;
  if (suggestion.format === "flac") return `${suggestion.bitDepth}-bit FLAC`;
  return `${suggestion.bitrateKbps} kbps MP3`;
}

/** Human-facing recommendation copy derived from the same settings used by export actions. */
export function masterProfileRecommendedFormat(profileId: MasterProfileId): string {
  const settings = MASTER_PROFILE_EXPORT_SETTINGS[profileId];
  if (!settings) return "Choose a format for the delivery destination.";
  const preferred = describeMasterFileEncoding(settings.preferred);
  const alternatives = settings.alternatives ?? [];
  if (alternatives.length === 0) return preferred;
  return `${preferred} · ${alternatives.map(describeMasterFileEncoding).join(" · ")} alternative`;
}

export interface MasterProfile {
  id: MasterProfileId;
  label: string;
  targetLufs: number;
  targetToleranceLufs: number;
  warningToleranceLufs: number;
  maxTruePeakDb: number;
  truePeakGraceDb: number;
  note: string;
  /** Human-readable copy only; export behavior uses `masterProfileExportSettings`. */
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
    checkedAt: "2026-10-08",
    reviewIntervalDays: 180,
  },
  apple: {
    label: "Apple Music · Video and Audio Asset Guide",
    url: "https://help.apple.com/itc/videoaudioassetguide/en.lproj/static.html",
    checkedAt: "2026-10-08",
    reviewIntervalDays: 180,
  },
};

interface MasterProfileFileRules {
  acceptedFormats: readonly MasterFileFormat[];
  preferredFormat?: MasterFileFormat;
  minSampleRateHz?: number;
  acceptedSampleRatesHz?: readonly number[];
  channels: number;
  maxBitDepth?: number;
  acceptedBitDepths?: readonly number[];
  unlistedFormatStatus?: "warn" | "fail";
  preserveNativeSampleRate?: boolean;
  preserveNativeBitDepth?: boolean;
  unverifiableCheck?: string;
}

/** Structured file rules are only defined when a current primary delivery brief supports them. */
const MASTER_PROFILE_FILE_RULES: Partial<Record<MasterProfileId, MasterProfileFileRules>> = {
  streaming: {
    acceptedFormats: ["flac", "wav"],
    preferredFormat: "flac",
    minSampleRateHz: 44_100,
    channels: 2,
    maxBitDepth: 24,
    preserveNativeSampleRate: true,
    preserveNativeBitDepth: true,
  },
  apple: {
    acceptedFormats: ["wav", "flac"],
    acceptedSampleRatesHz: [44_100, 48_000, 88_200, 96_000, 176_400, 192_000],
    channels: 2,
    acceptedBitDepths: [16, 24],
    unlistedFormatStatus: "fail",
    unverifiableCheck:
      "The checked source also requires an Apple-qualified encoder; file metadata cannot verify encoder qualification or distributor acceptance.",
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
    recommendedFormat: masterProfileRecommendedFormat("streaming"),
    intendedUse:
      "General starting point, not a universal platform specification. Spotify's conditional peak guidance is shown as an advisory.",
    fileGuidanceNote:
      "Spotify strongly prefers FLAC; WAV is also accepted. Its guidance requires at least 44.1 kHz and advises preserving native rate and bit depth. KYX FLAC supports 16/24-bit output at the selected project or external render rate (44.1/48/96 kHz); external FLAC sources decode at their native rate, while WAV/MP3 sources decode at 44.1 kHz. RATE stays manual.",
  },
  {
    id: "apple",
    label: "Apple Music",
    targetLufs: -16,
    targetToleranceLufs: 1,
    warningToleranceLufs: 2,
    maxTruePeakDb: -1,
    truePeakGraceDb: 0.3,
    note: "−16 LUFS is a KYX quieter starting point; Apple's Music Audio Source Profile defines file delivery, not this loudness target.",
    recommendedFormat: masterProfileRecommendedFormat("apple"),
    intendedUse:
      "Checks the standard Apple Music source-file profile. Apple Digital Masters requires separate source-provenance and Apple AAC audition requirements that KYX does not certify.",
    fileGuidanceNote:
      "For KYX export formats, this profile checks stereo PCM WAV or FLAC at 16/24-bit and 44.1, 48, 88.2, 96, 176.4 or 192 kHz; MP3 is not accepted. KYX checks encoded metadata but cannot verify Apple's qualified-encoder requirement or final distributor acceptance.",
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
    recommendedFormat: masterProfileRecommendedFormat("loud"),
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
    recommendedFormat: masterProfileRecommendedFormat("vinyl"),
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
  recommendedFormat: masterProfileRecommendedFormat("custom"),
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

export interface MasterFileDeliveryMetadata {
  format: MasterFileFormat;
  sampleRate: number;
  channels: number;
  bitDepth?: number;
  wavEncoding?: "pcm" | "ieee-float";
  /** Original external-file header rate and the rate actually decoded for processing. */
  sourceSampleRate?: number;
  decodedSourceSampleRate?: number;
  /** Native integer PCM bit depth, when exposed by an external WAV/FLAC source. */
  sourceBitDepth?: number;
}

export interface MasterFileDeliveryVerdict {
  profileId: MasterProfileId;
  status: DeliveryCheck["status"];
  checks: DeliveryCheck[];
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

/** Check the encoded file against profile file rules only when a current primary source exists. */
export function evaluateMasterFileDelivery(
  file: MasterFileDeliveryMetadata,
  profile: MasterProfile,
  asOf = Date.now(),
): MasterFileDeliveryVerdict | null {
  const rules = MASTER_PROFILE_FILE_RULES[profile.id];
  const source = MASTER_PROFILE_FILE_SOURCES[profile.id];
  if (!rules || !source) return null;
  if (isMasterProfileSourceReviewDue(source, asOf)) {
    const checks: DeliveryCheck[] = [
      {
        status: "not-measured",
        line: `${profile.label} file rules are withheld because their primary source needs review.`,
      },
    ];
    return { profileId: profile.id, status: "not-measured", checks };
  }

  const checks: DeliveryCheck[] = [];
  if (rules.acceptedFormats.includes(file.format)) {
    checks.push({
      status: "pass",
      line:
        rules.preferredFormat == null
          ? `${file.format.toUpperCase()} is accepted by the checked source profile.`
          : file.format === rules.preferredFormat
            ? `${file.format.toUpperCase()} is the preferred delivery format in the checked source.`
            : `${file.format.toUpperCase()} is accepted by the checked source; ${rules.preferredFormat.toUpperCase()} is preferred.`,
    });
  } else {
    checks.push({
      status: rules.unlistedFormatStatus ?? "warn",
      line:
        rules.unlistedFormatStatus === "fail"
          ? `${file.format.toUpperCase()} is not accepted by the checked source profile.`
          : `${file.format.toUpperCase()} is not listed by the checked source; confirm the distributor's delivery brief.`,
    });
  }

  if (file.format === "wav") {
    checks.push(
      file.wavEncoding === "pcm"
        ? { status: "pass", line: "WAV uses integer PCM encoding." }
        : file.wavEncoding === "ieee-float"
          ? {
              status: "fail",
              line: "WAV uses IEEE floating-point encoding; the checked source requires WAVE_FORMAT_PCM.",
            }
          : { status: "not-measured", line: "WAV encoding type could not be confirmed from the file header." },
    );
  }

  if (rules.acceptedSampleRatesHz) {
    checks.push(
      rules.acceptedSampleRatesHz.includes(file.sampleRate)
        ? {
            status: "pass",
            line: `${file.sampleRate.toLocaleString("en-US")} Hz is accepted by the checked source profile.`,
          }
        : {
            status: "fail",
            line: `${file.sampleRate.toLocaleString("en-US")} Hz is not one of the sample rates accepted by the checked source profile (${rules.acceptedSampleRatesHz.map((rate) => rate.toLocaleString("en-US")).join(", ")} Hz).`,
          },
    );
  } else if (rules.minSampleRateHz != null) {
    checks.push(
      file.sampleRate >= rules.minSampleRateHz
        ? {
            status: "pass",
            line: `${file.sampleRate.toLocaleString("en-US")} Hz meets the ${rules.minSampleRateHz.toLocaleString("en-US")} Hz minimum.`,
          }
        : {
            status: "fail",
            line: `Sample rate is below ${rules.minSampleRateHz.toLocaleString("en-US")} Hz; the checked source says this is not eligible for lossless playback.`,
          },
    );
  } else {
    checks.push({ status: "not-measured", line: "The checked source profile has no verifiable sample-rate rule." });
  }
  const sourceSampleRate = file.sourceSampleRate;
  const decodedSourceSampleRate = file.decodedSourceSampleRate;
  if (
    rules.preserveNativeSampleRate &&
    typeof sourceSampleRate === "number" &&
    Number.isSafeInteger(sourceSampleRate) &&
    sourceSampleRate > 0 &&
    typeof decodedSourceSampleRate === "number" &&
    Number.isSafeInteger(decodedSourceSampleRate) &&
    decodedSourceSampleRate > 0
  ) {
    if (decodedSourceSampleRate !== sourceSampleRate) {
      checks.push({
        status: "warn",
        line:
          decodedSourceSampleRate < sourceSampleRate
            ? `The source file is ${sourceSampleRate.toLocaleString("en-US")} Hz but KYX decoded it at ${decodedSourceSampleRate.toLocaleString("en-US")} Hz; source detail above the decoded rate may have been lost before mastering.`
            : `The source file is ${sourceSampleRate.toLocaleString("en-US")} Hz but KYX decoded it at ${decodedSourceSampleRate.toLocaleString("en-US")} Hz; this upsample during decode adds no source detail.`,
      });
    } else if (file.sampleRate === sourceSampleRate) {
      checks.push({
        status: "pass",
        line: `The export preserves the source's ${sourceSampleRate.toLocaleString("en-US")} Hz sample rate.`,
      });
    } else {
      checks.push({
        status: "warn",
        line:
          file.sampleRate < sourceSampleRate
            ? `The ${file.sampleRate.toLocaleString("en-US")} Hz export is below the ${sourceSampleRate.toLocaleString("en-US")} Hz source rate; the checked source advises preserving the original rate.`
            : `The ${file.sampleRate.toLocaleString("en-US")} Hz export is above the ${sourceSampleRate.toLocaleString("en-US")} Hz source rate; this upsample does not add source detail.`,
      });
    }
  }
  checks.push(
    file.channels === rules.channels
      ? { status: "pass", line: `The file has the required ${rules.channels}-channel stereo layout.` }
      : {
          status: "fail",
          line: `The file has ${file.channels} channels; the checked source requires ${rules.channels}-channel stereo delivery.`,
        },
  );

  const sourceBitDepth =
    rules.preserveNativeBitDepth &&
    typeof file.sourceBitDepth === "number" &&
    Number.isSafeInteger(file.sourceBitDepth) &&
    file.sourceBitDepth >= 4 &&
    file.sourceBitDepth <= 32
      ? file.sourceBitDepth
      : null;
  if (rules.acceptedBitDepths) {
    if (file.bitDepth == null) {
      checks.push({ status: "not-measured", line: "The file's bit depth could not be confirmed from metadata." });
    } else if (rules.acceptedBitDepths.includes(file.bitDepth)) {
      checks.push({
        status: "pass",
        line: `${file.bitDepth}-bit is accepted by the checked source profile.`,
      });
    } else {
      checks.push({
        status: "fail",
        line: `${file.bitDepth}-bit is not one of the bit depths accepted by the checked source profile (${rules.acceptedBitDepths.join(", ")}-bit).`,
      });
    }
  } else if (file.bitDepth != null && rules.maxBitDepth != null && file.bitDepth > rules.maxBitDepth) {
    checks.push({
      status: "warn",
      line: `${file.bitDepth}-bit is above the source's ${rules.maxBitDepth}-bit delivery maximum; it says higher-depth files are reduced internally.`,
    });
  } else if (file.bitDepth === 16) {
    const line =
      sourceBitDepth == null
        ? "The source permits 16-bit only when no higher-bit-depth master exists; KYX cannot verify that source condition."
        : sourceBitDepth === 16
          ? "16-bit output matches the imported source depth, but the checked source permits it only when no higher-depth master exists."
          : sourceBitDepth > 16
            ? `16-bit output reduces the imported ${sourceBitDepth}-bit source; the checked source permits 16-bit only when no higher-depth master exists.`
            : `16-bit output is above the imported ${sourceBitDepth}-bit source depth and adds no source detail.`;
    checks.push({ status: "warn", line });
  } else if (file.bitDepth != null) {
    if (sourceBitDepth == null) {
      checks.push({ status: "pass", line: `${file.bitDepth}-bit is within the source's stated maximum.` });
    } else if (file.bitDepth === sourceBitDepth) {
      checks.push({
        status: "pass",
        line: `${file.bitDepth}-bit output preserves the imported source's native PCM depth.`,
      });
    } else if (file.bitDepth < sourceBitDepth) {
      checks.push({
        status: "warn",
        line: `${file.bitDepth}-bit output is below the imported ${sourceBitDepth}-bit source depth; the checked source advises preserving native bit depth.`,
      });
    } else {
      checks.push({
        status: "warn",
        line: `${file.bitDepth}-bit output is above the imported ${sourceBitDepth}-bit source depth and adds no source detail.`,
      });
    }
  }

  if (rules.unverifiableCheck) checks.push({ status: "not-measured", line: rules.unverifiableCheck });

  return { profileId: profile.id, status: worstStatus(checks), checks };
}

/** Legacy MCP API retained while the shared profile contract moves out of MCP. */
export function verdictAgainst(metrics: DeliveryMetrics, profile: MasterProfile): DeliveryCheck[] {
  return evaluateDelivery(metrics, profile).checks;
}
