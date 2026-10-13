import type { MixHealthReport } from "../analysis/mixDoctor";
import type { BufferSummary } from "../audio-engine/metering";
import type { MasterAssistantStep, MasteringReferenceMeasurement } from "../mcp/master-assistant";
import type { MasterProfile, MasterProfileId } from "./profiles";

export const MASTERING_ANALYSIS_SCHEMA = "kyx.mastering-analysis" as const;
export const MASTERING_ANALYSIS_SCHEMA_VERSION = 1 as const;
export const MASTERING_FEATURE_VERSION = "mastering.features.v1" as const;

const MEASUREMENT_FIELDS = [
  "lufsIntegrated",
  "peakDb",
  "truePeakDb",
  "crestDb",
  "correlation",
  "hfShare",
  "lowEndShare",
] as const;

type MasteringMeasurementField = (typeof MEASUREMENT_FIELDS)[number];
type MeasurementValues = Record<MasteringMeasurementField, number | null>;
type RenderProvenance = Record<MasteringMeasurementField, "rendered-master" | "not-measured">;
type ReferenceProvenance = Record<MasteringMeasurementField, "decoded-reference" | "not-measured">;

export interface MasteringAnalysisSnapshotV1 {
  schema: typeof MASTERING_ANALYSIS_SCHEMA;
  schemaVersion: typeof MASTERING_ANALYSIS_SCHEMA_VERSION;
  featureVersion: typeof MASTERING_FEATURE_VERSION;
  projectRevisionId: string;
  sampleBankRevision: number;
  render: {
    scope: "song";
    sampleRate: number;
    durationSeconds: number;
    channelCount: 1 | 2;
    quality: "studio";
  };
  measurementTap: "master-output/post-limiter/pre-encode";
  delivery: {
    profileId: MasterProfileId;
    targetLufs: number;
    maxTruePeakDb: number;
  };
  measurements: MeasurementValues;
  provenance: {
    measurements: RenderProvenance;
    reference: ReferenceProvenance | null;
  };
  reference: {
    id: string;
    measurements: MeasurementValues;
  } | null;
}

export interface CreateMasteringAnalysisSnapshotInput {
  projectRevisionId: string;
  sampleBankRevision: number;
  sampleRate: number;
  summary: BufferSummary;
  health: MixHealthReport;
  delivery: MasterProfile;
  referenceMeasurement?: MasteringReferenceMeasurement | null;
}

export interface MasteringProposalCandidate {
  /** Stable within this planner result. This ID and the proposal never go to the worker. */
  id: string;
  originalIndex: number;
  step: MasterAssistantStep;
  currentValue: number | null;
  /** Versioned, finite model input. Only this vector is sent to the local worker. */
  featureVector: number[];
}

const DEVICE_FEATURES = ["master", "zenit", "apeks", "sirka"] as const;
const PARAM_FEATURES = [
  "limiterEnabled",
  "ceilingDb",
  "ceiling",
  "limit",
  "drive",
  "preserve",
  "glue",
  "lowWidth",
  "midWidth",
  "highWidth",
  "eqHigh",
  "eqLow",
] as const;
const ADJUSTMENT_FEATURES = ["set", "increase", "decrease", "delta"] as const;
const PROFILE_FEATURES: readonly MasterProfileId[] = ["streaming", "apple", "loud", "vinyl", "custom"];

/** The explicit column order is the complete ONNX input contract. */
export const MASTERING_RANKER_FEATURE_NAMES = Object.freeze([
  "lufs.available",
  "lufs.normalized",
  "truePeak.available",
  "truePeak.normalized",
  "crest.available",
  "crest.normalized",
  "correlation.available",
  "correlation.normalized",
  "hfShare.available",
  "hfShare.normalized",
  "lowEndShare.available",
  "lowEndShare.normalized",
  "targetLufs.available",
  "targetLufsGap.normalized",
  "targetTruePeak.available",
  "truePeakViolation.normalized",
  "reference.available",
  "reference.lufsDelta.normalized",
  "reference.crestDelta.normalized",
  "reference.correlationDelta.normalized",
  "reference.hfShareDelta.normalized",
  "reference.lowEndShareDelta.normalized",
  ...PROFILE_FEATURES.map((profile) => `delivery.${profile}`),
  ...DEVICE_FEATURES.map((device) => `candidate.device.${device}`),
  ...PARAM_FEATURES.map((param) => `candidate.param.${param}`),
  ...ADJUSTMENT_FEATURES.map((adjustment) => `candidate.adjustment.${adjustment}`),
  "candidate.currentValue.available",
  "candidate.currentValue.normalized",
  "candidate.value.normalized",
  "candidate.delta.normalized",
]);

export const MASTERING_RANKER_FEATURE_COUNT = MASTERING_RANKER_FEATURE_NAMES.length;

function finiteInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function measured(value: unknown, minimum: number, maximum: number): number | null {
  return finiteInRange(value, minimum, maximum) ? value : null;
}

function makeProvenance<T extends string>(
  values: MeasurementValues,
  source: T,
): Record<MasteringMeasurementField, T | "not-measured"> {
  return Object.fromEntries(
    MEASUREMENT_FIELDS.map((field) => [field, values[field] === null ? "not-measured" : source]),
  ) as Record<MasteringMeasurementField, T | "not-measured">;
}

function snapshotMeasurements(
  values: Omit<MeasurementValues, "peakDb" | "crestDb" | "correlation"> & {
    peakDb: number | null;
    crestDb: number | null;
    correlation: number | null;
  },
): MeasurementValues {
  return {
    lufsIntegrated: values.lufsIntegrated,
    peakDb: values.peakDb,
    truePeakDb: values.truePeakDb,
    crestDb: values.crestDb,
    correlation: values.correlation,
    hfShare: values.hfShare,
    lowEndShare: values.lowEndShare,
  };
}

/** Capture measured facts and provenance without retaining PCM or the project document. */
export function createMasteringAnalysisSnapshot(
  input: CreateMasteringAnalysisSnapshotInput,
): MasteringAnalysisSnapshotV1 {
  const usableSignal = input.health.durationSec >= 0.4 && input.summary.peak > 1e-5;
  const measurements = snapshotMeasurements({
    lufsIntegrated: measured(input.summary.lufsIntegrated, -119, 24),
    peakDb: usableSignal ? measured(input.summary.peakDb, -120, 24) : null,
    truePeakDb: usableSignal ? measured(input.summary.truePeakDb, -120, 24) : null,
    crestDb: usableSignal ? measured(input.health.crestDb, 0, 120) : null,
    correlation: usableSignal ? measured(input.summary.correlation, -1, 1) : null,
    hfShare: usableSignal ? measured(input.health.bandShares.high + input.health.bandShares.air, 0, 1) : null,
    lowEndShare: usableSignal ? measured(input.health.lowEndShare, 0, 1) : null,
  });
  const referenceValues = input.referenceMeasurement
    ? snapshotMeasurements({
        lufsIntegrated: measured(input.referenceMeasurement.measurement.lufs, -119, 24),
        peakDb: null,
        truePeakDb: null,
        crestDb: measured(input.referenceMeasurement.measurement.crestDb, 0, 120),
        correlation: measured(input.referenceMeasurement.measurement.correlation, -1, 1),
        hfShare: measured(input.referenceMeasurement.measurement.hfShare, 0, 1),
        lowEndShare: measured(input.referenceMeasurement.measurement.lowEndShare, 0, 1),
      })
    : null;

  return {
    schema: MASTERING_ANALYSIS_SCHEMA,
    schemaVersion: MASTERING_ANALYSIS_SCHEMA_VERSION,
    featureVersion: MASTERING_FEATURE_VERSION,
    projectRevisionId: input.projectRevisionId,
    sampleBankRevision: input.sampleBankRevision,
    render: {
      scope: "song",
      sampleRate: input.sampleRate,
      durationSeconds: input.health.durationSec,
      channelCount: input.summary.channelCount === 1 ? 1 : 2,
      quality: "studio",
    },
    measurementTap: "master-output/post-limiter/pre-encode",
    delivery: {
      profileId: input.delivery.id,
      targetLufs: input.delivery.targetLufs,
      maxTruePeakDb: input.delivery.maxTruePeakDb,
    },
    measurements,
    provenance: {
      measurements: makeProvenance(measurements, "rendered-master"),
      reference: referenceValues ? makeProvenance(referenceValues, "decoded-reference") : null,
    },
    reference: input.referenceMeasurement
      ? { id: input.referenceMeasurement.id, measurements: referenceValues! }
      : null,
  };
}

function isMeasurementValues(value: unknown): value is MeasurementValues {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return MEASUREMENT_FIELDS.every((field) => {
    const metric = record[field];
    if (metric === null) return true;
    if (typeof metric !== "number" || !Number.isFinite(metric)) return false;
    if (field === "correlation") return metric >= -1 && metric <= 1;
    if (field === "hfShare" || field === "lowEndShare") return metric >= 0 && metric <= 1;
    if (field === "crestDb") return metric >= 0 && metric <= 120;
    return metric >= -120 && metric <= 24;
  });
}

/** Strict runtime validator for snapshots restored from JSON or worker-adjacent code. */
export function isMasteringAnalysisSnapshot(value: unknown): value is MasteringAnalysisSnapshotV1 {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  if (
    snapshot.schema !== MASTERING_ANALYSIS_SCHEMA ||
    snapshot.schemaVersion !== MASTERING_ANALYSIS_SCHEMA_VERSION ||
    snapshot.featureVersion !== MASTERING_FEATURE_VERSION ||
    typeof snapshot.projectRevisionId !== "string" ||
    snapshot.projectRevisionId.length === 0 ||
    !Number.isSafeInteger(snapshot.sampleBankRevision) ||
    !snapshot.render ||
    typeof snapshot.render !== "object" ||
    !snapshot.delivery ||
    typeof snapshot.delivery !== "object" ||
    !isMeasurementValues(snapshot.measurements) ||
    !snapshot.provenance ||
    typeof snapshot.provenance !== "object"
  ) {
    return false;
  }
  const render = snapshot.render as Record<string, unknown>;
  const delivery = snapshot.delivery as Record<string, unknown>;
  if (
    render.scope !== "song" ||
    render.quality !== "studio" ||
    (render.channelCount !== 1 && render.channelCount !== 2) ||
    !finiteInRange(render.sampleRate, 8000, 384000) ||
    !finiteInRange(render.durationSeconds, 0, 86400) ||
    snapshot.measurementTap !== "master-output/post-limiter/pre-encode" ||
    typeof delivery.profileId !== "string" ||
    !["streaming", "apple", "loud", "vinyl", "custom"].includes(delivery.profileId) ||
    !finiteInRange(delivery.targetLufs, -36, 0) ||
    !finiteInRange(delivery.maxTruePeakDb, -24, 6)
  ) {
    return false;
  }
  const provenance = snapshot.provenance as Record<string, unknown>;
  if (!provenance.measurements || typeof provenance.measurements !== "object") return false;
  const renderProvenance = provenance.measurements as Record<string, unknown>;
  const measurementValues = snapshot.measurements as MeasurementValues;
  if (
    !MEASUREMENT_FIELDS.every(
      (field) => renderProvenance[field] === (measurementValues[field] === null ? "not-measured" : "rendered-master"),
    )
  ) {
    return false;
  }
  if (snapshot.reference === null) return provenance.reference === null;
  if (!snapshot.reference || typeof snapshot.reference !== "object") return false;
  const reference = snapshot.reference as Record<string, unknown>;
  if (typeof reference.id !== "string" || reference.id.length === 0 || !isMeasurementValues(reference.measurements))
    return false;
  if (!provenance.reference || typeof provenance.reference !== "object") return false;
  const referenceProvenance = provenance.reference as Record<string, unknown>;
  const referenceValues = reference.measurements as MeasurementValues;
  return MEASUREMENT_FIELDS.every(
    (field) => referenceProvenance[field] === (referenceValues[field] === null ? "not-measured" : "decoded-reference"),
  );
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const unitRange = (value: number, low: number, high: number) => clamp((value - low) / (high - low), 0, 1);
const signedRange = (value: number, scale: number) => clamp(value / scale, -1, 1);

function metricPair(value: number | null, low: number, high: number): [number, number] {
  return value === null ? [0, 0] : [1, unitRange(value, low, high)];
}

function normalizedCandidateValue(step: MasterAssistantStep): number {
  switch (step.param) {
    case "limiterEnabled":
      return clamp(step.value, 0, 1);
    case "ceilingDb":
    case "ceiling":
      return clamp(step.value / 12, -1, 0);
    case "limit":
    case "preserve":
    case "glue":
      return clamp(step.value, 0, 1);
    case "drive":
      return clamp(step.value / 6, 0, 1);
    case "lowWidth":
    case "midWidth":
    case "highWidth":
      return clamp(step.value / 2, 0, 1);
    case "eqHigh":
    case "eqLow":
      return clamp(step.value / 6, -1, 1);
    default:
      return 0;
  }
}

function candidateScale(param: string): number {
  switch (param) {
    case "ceilingDb":
    case "ceiling":
      return 12;
    case "drive":
      return 6;
    case "lowWidth":
    case "midWidth":
    case "highWidth":
      return 2;
    case "eqHigh":
    case "eqLow":
      return 6;
    default:
      return 1;
  }
}

function candidateFeatures(
  snapshot: MasteringAnalysisSnapshotV1,
  step: MasterAssistantStep,
  currentValue: number | null,
): number[] {
  const measurements = snapshot.measurements;
  const reference = snapshot.reference?.measurements ?? null;
  const lufs = metricPair(measurements.lufsIntegrated, -36, 0);
  const truePeak = metricPair(measurements.truePeakDb, -24, 6);
  const crest = metricPair(measurements.crestDb, 0, 24);
  const correlation = metricPair(measurements.correlation, -1, 1);
  const hfShare = metricPair(measurements.hfShare, 0, 1);
  const lowShare = metricPair(measurements.lowEndShare, 0, 1);
  const targetLufsAvailable = Number.isFinite(snapshot.delivery.targetLufs);
  const targetPeakAvailable = Number.isFinite(snapshot.delivery.maxTruePeakDb);
  const lufsGap =
    targetLufsAvailable && measurements.lufsIntegrated !== null
      ? signedRange(snapshot.delivery.targetLufs - measurements.lufsIntegrated, 24)
      : 0;
  const peakViolation =
    targetPeakAvailable && measurements.truePeakDb !== null
      ? clamp((measurements.truePeakDb - snapshot.delivery.maxTruePeakDb) / 12, 0, 1)
      : 0;
  const referenceAvailable = reference !== null;
  const referenceLufs =
    reference && reference.lufsIntegrated !== null && measurements.lufsIntegrated !== null
      ? signedRange(reference.lufsIntegrated - measurements.lufsIntegrated, 24)
      : 0;
  const referenceCrest =
    reference && reference.crestDb !== null && measurements.crestDb !== null
      ? signedRange(reference.crestDb - measurements.crestDb, 24)
      : 0;
  const referenceCorrelation =
    reference && reference.correlation !== null && measurements.correlation !== null
      ? signedRange(reference.correlation - measurements.correlation, 2)
      : 0;
  const referenceHf =
    reference && reference.hfShare !== null && measurements.hfShare !== null
      ? signedRange(reference.hfShare - measurements.hfShare, 1)
      : 0;
  const referenceLow =
    reference && reference.lowEndShare !== null && measurements.lowEndShare !== null
      ? signedRange(reference.lowEndShare - measurements.lowEndShare, 1)
      : 0;
  const adjustment = step.adjustment ?? "set";

  return [
    ...lufs,
    ...truePeak,
    ...crest,
    ...correlation,
    ...hfShare,
    ...lowShare,
    Number(targetLufsAvailable),
    lufsGap,
    Number(targetPeakAvailable),
    peakViolation,
    Number(referenceAvailable),
    referenceLufs,
    referenceCrest,
    referenceCorrelation,
    referenceHf,
    referenceLow,
    ...PROFILE_FEATURES.map((profile) => Number(snapshot.delivery.profileId === profile)),
    ...DEVICE_FEATURES.map((device) => Number(step.device === device)),
    ...PARAM_FEATURES.map((param) => Number(step.param === param)),
    ...ADJUSTMENT_FEATURES.map((name) => Number(adjustment === name)),
    Number(currentValue !== null),
    currentValue === null ? 0 : normalizedCandidateValue({ ...step, value: currentValue }),
    normalizedCandidateValue(step),
    currentValue === null ? 0 : clamp((step.value - currentValue) / candidateScale(step.param), -1, 1),
  ];
}

/** Build bounded model candidates. Project identity, filenames, explanations and PCM stay out of feature vectors. */
export function buildMasteringProposalCandidates(
  snapshot: MasteringAnalysisSnapshotV1,
  steps: readonly MasterAssistantStep[],
  currentValues: readonly (number | null)[] = [],
): MasteringProposalCandidate[] {
  if (!isMasteringAnalysisSnapshot(snapshot)) return [];
  const seenIds = new Map<string, number>();
  return steps.map((step, originalIndex) => {
    const valueKey = Number.isFinite(step.value) ? step.value.toFixed(4) : "invalid";
    const baseId = `${step.device}/${step.param}/${step.adjustment ?? "set"}/${valueKey}`;
    const occurrence = seenIds.get(baseId) ?? 0;
    seenIds.set(baseId, occurrence + 1);
    const currentValue = measured(currentValues[originalIndex], -120, 120);
    const featureVector = candidateFeatures(snapshot, step, currentValue);
    if (
      featureVector.length !== MASTERING_RANKER_FEATURE_COUNT ||
      featureVector.some((feature) => !Number.isFinite(feature))
    ) {
      return { id: `${baseId}/${occurrence}`, originalIndex, step, currentValue, featureVector: [] };
    }
    return { id: `${baseId}/${occurrence}`, originalIndex, step, currentValue, featureVector };
  });
}

/** Fixed helper for client/worker boundaries that must reject corrupt serialized batches. */
export function isMasteringFeatureVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === MASTERING_RANKER_FEATURE_COUNT &&
    value.every((feature) => typeof feature === "number" && Number.isFinite(feature) && feature >= -1 && feature <= 1)
  );
}
