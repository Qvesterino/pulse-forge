import { describe, expect, it, vi } from "vitest";
import {
  MAX_RECORDING_INPUT_OFFSET_MS,
  MIN_RECORDING_INPUT_OFFSET_MS,
  RECORDING_ALIGNMENT_STORAGE_KEY,
  RecordingAlignmentController,
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
