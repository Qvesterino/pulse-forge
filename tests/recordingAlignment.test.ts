import { describe, expect, it, vi } from "vitest";
import {
  MAX_RECORDING_INPUT_OFFSET_MS,
  MIN_RECORDING_INPUT_OFFSET_MS,
  RECORDING_ALIGNMENT_STORAGE_KEY,
  RecordingAlignmentController,
  recordingOffsetFromMeasurement,
  type RecordingAlignmentStorage,
} from "../src/audio-engine/recordingAlignment";

function memoryStorage(): RecordingAlignmentStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

describe("recording alignment preference", () => {
  it("persists bounded integer offsets and restores them", () => {
    const storage = memoryStorage();
    const alignment = new RecordingAlignmentController(storage);
    alignment.setOffsetMs(37.6);
    expect(storage.getItem(RECORDING_ALIGNMENT_STORAGE_KEY)).toBe("38");
    expect(new RecordingAlignmentController(storage).getSnapshot()).toBe(38);

    alignment.setOffsetMs(MAX_RECORDING_INPUT_OFFSET_MS + 1);
    expect(alignment.getSnapshot()).toBe(MAX_RECORDING_INPUT_OFFSET_MS);
    alignment.setOffsetMs(MIN_RECORDING_INPUT_OFFSET_MS - 1);
    expect(alignment.getSnapshot()).toBe(MIN_RECORDING_INPUT_OFFSET_MS);
  });

  it("recovers safely from malformed or unavailable storage and notifies subscribers", () => {
    const storage = memoryStorage();
    storage.setItem(RECORDING_ALIGNMENT_STORAGE_KEY, "not-a-number");
    const alignment = new RecordingAlignmentController(storage);
    expect(alignment.getSnapshot()).toBe(0);

    const listener = vi.fn();
    const unsubscribe = alignment.subscribe(listener);
    alignment.setOffsetMs(12);
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    alignment.setOffsetMs(14);
    expect(listener).toHaveBeenCalledOnce();

    const blockedStorage: RecordingAlignmentStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    const blocked = new RecordingAlignmentController(blockedStorage);
    expect(() => blocked.setOffsetMs(25)).not.toThrow();
    expect(blocked.getSnapshot()).toBe(25);
  });
});

describe("measured round-trip → recording placement offset policy", () => {
  it("rounds a stable measurement into the placement offset", () => {
    expect(recordingOffsetFromMeasurement({ roundTripMs: 63.4, stable: true })).toBe(63);
    expect(recordingOffsetFromMeasurement({ roundTripMs: -12.6, stable: true })).toBe(-13);
    expect(recordingOffsetFromMeasurement({ roundTripMs: 0, stable: true })).toBe(0);
  });

  it("refuses unstable or non-finite measurements instead of misplacing takes", () => {
    expect(recordingOffsetFromMeasurement({ roundTripMs: 63.4, stable: false })).toBeNull();
    expect(recordingOffsetFromMeasurement({ roundTripMs: Number.NaN, stable: true })).toBeNull();
    expect(recordingOffsetFromMeasurement({ roundTripMs: Number.POSITIVE_INFINITY, stable: true })).toBeNull();
  });

  it("the controller clamps a huge measurement to the ±500 ms placement limit", () => {
    const alignment = new RecordingAlignmentController(memoryStorage());
    alignment.setOffsetMs(recordingOffsetFromMeasurement({ roundTripMs: 940.2, stable: true })!);
    expect(alignment.getSnapshot()).toBe(MAX_RECORDING_INPUT_OFFSET_MS);
    alignment.setOffsetMs(recordingOffsetFromMeasurement({ roundTripMs: -940.2, stable: true })!);
    expect(alignment.getSnapshot()).toBe(MIN_RECORDING_INPUT_OFFSET_MS);
  });
});
