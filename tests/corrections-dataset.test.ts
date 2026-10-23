import { describe, expect, it } from "vitest";
import {
  buildCorrectionsDataset,
  toDatasetRow,
  toTrainingJsonl,
  MIN_TRAINING_ROWS,
  type CorrectionInput,
} from "../src/mastering/corrections-dataset";

/**
 * CORRECTIONS DATASET (learning loop Phase 2) — pins for the export that
 * feeds the Python trainer. Each row = context + proposed + corrected +
 * delta. The trainer learns to predict delta given context.
 */

const input: CorrectionInput = {
  trackId: "t1",
  device: "zenit",
  paramId: "limit",
  proposedValue: 0.4,
  actualValue: 0.6,
  contextLufs: -16,
  contextCrestDb: 9,
  contextCorrelation: 0.7,
  contextHfShare: 0.15,
  contextLowEndShare: 0.3,
  profileId: "streaming",
};

describe("corrections dataset", () => {
  it("toDatasetRow computes delta = corrected − proposed", () => {
    const row = toDatasetRow(input);
    expect(row.delta).toBeCloseTo(0.2, 6);
    expect(row.context.lufs).toBe(-16);
    expect(row.profileId).toBe("streaming");
  });

  it("buildCorrectionsDataset produces a valid v1 dataset with correct row count", () => {
    const dataset = buildCorrectionsDataset([input, { ...input, paramId: "glue" }]);
    expect(dataset.schema).toBe("kyx.mastering-corrections-v1");
    expect(dataset.rowCount).toBe(2);
    expect(dataset.rows).toHaveLength(2);
  });

  it("toTrainingJsonl produces one JSON object per line (the trainer's input format)", () => {
    const dataset = buildCorrectionsDataset([input, { ...input, paramId: "ceiling" }]);
    const jsonl = toTrainingJsonl(dataset);
    const lines = jsonl.split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty("context");
      expect(parsed).toHaveProperty("delta");
      expect(parsed).toHaveProperty("device");
    }
  });

  it("MIN_TRAINING_ROWS is the data-minimum gate (same pattern as the ranker)", () => {
    expect(MIN_TRAINING_ROWS).toBeGreaterThanOrEqual(20);
  });
});
