import { describe, expect, it } from "vitest";
import {
  estimateRecordingStoragePreflight,
  recordingStorageWarning,
  RECORDING_STORAGE_PREFLIGHT_TARGET_SECONDS,
} from "../src/audio-engine/recordingStorageBudget";

describe("recording storage preflight", () => {
  it("estimates Float32 PCM plus headroom for the 30-minute Studio gate", () => {
    const estimate = estimateRecordingStoragePreflight({ quota: 4_600_000_000, usage: 1_000_000_000 }, 48_000, 8);

    expect(estimate).toMatchObject({
      availableBytes: 3_600_000_000,
      targetSeconds: RECORDING_STORAGE_PREFLIGHT_TARGET_SECONDS,
      channels: 8,
      sampleRate: 48_000,
      sufficientForTarget: true,
    });
    expect(estimate?.requiredBytes).toBe(3_456_000_000);
    expect(estimate?.estimatedAvailableSeconds).toBeGreaterThan(RECORDING_STORAGE_PREFLIGHT_TARGET_SECONDS);
    expect(recordingStorageWarning(estimate)).toBeNull();
  });

  it("warns when estimated free space is below the target but does not reject shorter takes", () => {
    const estimate = estimateRecordingStoragePreflight({ quota: 600_000_000, usage: 200_000_000 }, 48_000, 2);
    const warning = recordingStorageWarning(estimate);

    expect(estimate?.sufficientForTarget).toBe(false);
    expect(warning).toContain("0.4 GiB free");
    expect(warning).toContain("about 13 min at 2 ch");
    expect(warning).toContain("You can record shorter");
    expect(warning).toContain("Committed PCM blocks remain recoverable");
  });

  it("treats malformed or incomplete estimates as unavailable instead of blocking recording", () => {
    expect(estimateRecordingStoragePreflight({}, 48_000, 2)).toBeNull();
    expect(estimateRecordingStoragePreflight({ quota: Number.NaN, usage: 0 }, 48_000, 2)).toBeNull();
    expect(estimateRecordingStoragePreflight({ quota: 10, usage: 11 }, 48_000, 2)?.availableBytes).toBe(0);
    expect(estimateRecordingStoragePreflight({ quota: 10, usage: 1 }, 0, 2)).toBeNull();
    expect(estimateRecordingStoragePreflight({ quota: 10, usage: 1 }, 48_000, 0)).toBeNull();
    expect(recordingStorageWarning(null)).toBeNull();
  });
});
