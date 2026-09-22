import { describe, expect, it } from "vitest";
import {
  DEFAULT_GENERATIVE_LATENCY,
  GENERATIVE_LATENCY_STORAGE_KEY,
  GenerativeLatencyCalibrationController,
  type GenerativeLatencyStorage,
} from "../src/generative/latency";

function memoryStorage(): GenerativeLatencyStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

describe("generative latency calibration", () => {
  it("stores provider measurements outside the project model", () => {
    const storage = memoryStorage();
    const calibration = new GenerativeLatencyCalibrationController(storage);
    calibration.recordWarmup(120);
    calibration.recordControl(20);

    expect(calibration.getSnapshot()).toMatchObject({
      warmupMs: 120,
      controlMs: 20,
      warmupSamples: 1,
      controlSamples: 1,
    });
    expect(storage.getItem(GENERATIVE_LATENCY_STORAGE_KEY)).toContain("warmupMs");
    const restored = new GenerativeLatencyCalibrationController(storage);
    expect(restored.getSnapshot()).toMatchObject({ warmupMs: 120, controlMs: 20 });
  });

  it("ignores invalid measurements and can reset to an empty calibration", () => {
    const calibration = new GenerativeLatencyCalibrationController(memoryStorage());
    calibration.recordWarmup(-1);
    calibration.recordControl(Number.NaN);
    expect(calibration.getSnapshot()).toEqual(DEFAULT_GENERATIVE_LATENCY);
    calibration.reset();
    expect(calibration.getSnapshot()).toEqual(DEFAULT_GENERATIVE_LATENCY);
  });
});
