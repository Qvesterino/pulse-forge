/**
 * CORRECTIONS DATASET (learning loop Phase 2) — converts accumulated
 * mastering corrections into a JSONL training dataset for the
 * master-assistant ONNX model (Phase 3).
 *
 * Each row: the measurement context at the time of the assist (LUFS, band
 * shares, correlation, crest) + the parameter delta the user applied
 * (proposed → corrected). The model learns to predict the delta given the
 * context — i.e. "what would THIS user do differently from the rules?"
 *
 * Pure and deterministic. No side effects.
 */

export interface CorrectionDatasetRow {
  /** Measurement context at the time of the assist. */
  context: {
    lufs: number | null;
    crestDb: number | null;
    correlation: number | null;
    hfShare: number | null;
    lowEndShare: number | null;
  };
  /** Profile in use during the assist. */
  profileId: string;
  /** The device + param the correction applies to. */
  device: string;
  paramId: string;
  /** What the assistant proposed. */
  proposedValue: number;
  /** What the user actually set. */
  correctedValue: number;
  /** The delta the model should learn to predict. */
  delta: number;
}

export interface CorrectionsDataset {
  schema: "kyx.mastering-corrections-v1";
  generatedAt: string;
  rowCount: number;
  rows: CorrectionDatasetRow[];
}

export interface CorrectionInput {
  trackId: string;
  device: string;
  paramId: string;
  proposedValue: number;
  actualValue: number;
  contextLufs: number | null;
  contextCrestDb: number | null;
  contextCorrelation: number | null;
  contextHfShare: number | null;
  contextLowEndShare: number | null;
  profileId: string;
}

/** Convert a correction event + measurement context into a dataset row. */
export function toDatasetRow(input: CorrectionInput): CorrectionDatasetRow {
  return {
    context: {
      lufs: input.contextLufs,
      crestDb: input.contextCrestDb,
      correlation: input.contextCorrelation,
      hfShare: input.contextHfShare,
      lowEndShare: input.contextLowEndShare,
    },
    profileId: input.profileId,
    device: input.device,
    paramId: input.paramId,
    proposedValue: input.proposedValue,
    correctedValue: input.actualValue,
    delta: input.actualValue - input.proposedValue,
  };
}

/** Build the full dataset from a list of corrections + their contexts. */
export function buildCorrectionsDataset(inputs: CorrectionInput[]): CorrectionsDataset {
  return {
    schema: "kyx.mastering-corrections-v1" as const,
    generatedAt: new Date().toISOString(),
    rowCount: inputs.length,
    rows: inputs.map(toDatasetRow),
  };
}

/** Serialize to JSONL for the Python trainer (one row per line). */
export function toTrainingJsonl(dataset: CorrectionsDataset): string {
  return dataset.rows.map((row) => JSON.stringify(row)).join("\n");
}

/** Minimum data before training is meaningful (same gate pattern as the ranker). */
export const MIN_TRAINING_ROWS = 50;
