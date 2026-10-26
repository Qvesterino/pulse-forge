// Recording alignment — the recording offset belongs to an INPUT DEVICE.
//
// Audit R-3: the offset used to live under ONE global localStorage key, so a
// calibration on interface A shifted every later take on interface B, in
// every project. The offset is now stored per input device, under
// `pulse-forge:recording-alignment:v2:<deviceId>`.
//
// The specs below are written so that the OLD global behaviour fails them:
// the teeth probe (`recordingAlignmentStorageKey` returning one global key)
// turns "two devices have their own slots" and "the offset does not follow
// the device" RED.

import { describe, expect, it, vi } from "vitest";
import {
  LEGACY_RECORDING_ALIGNMENT_STORAGE_KEY,
  MAX_RECORDING_INPUT_OFFSET_MS,
  MIN_RECORDING_INPUT_OFFSET_MS,
  RECORDING_ALIGNMENT_STORAGE_PREFIX,
  RecordingAlignmentController,
  recordingAlignmentStorageKey,
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

/** A controller whose selected input the test can switch mid-session. */
function controllerFor(storage: RecordingAlignmentStorage, deviceId = "mic-a") {
  let current = deviceId;
  const alignment = new RecordingAlignmentController(storage, () => current);
  return {
    alignment,
    select: (id: string) => {
      current = id;
    },
  };
}

describe("recording alignment preference", () => {
  it("persists bounded integer offsets and restores them", () => {
    const storage = memoryStorage();
    const { alignment } = controllerFor(storage);
    alignment.setOffsetMs(37.6);
    expect(storage.getItem(recordingAlignmentStorageKey("mic-a"))).toBe("38");
    expect(new RecordingAlignmentController(storage, () => "mic-a").getSnapshot()).toBe(38);

    alignment.setOffsetMs(MAX_RECORDING_INPUT_OFFSET_MS + 1);
    expect(alignment.getSnapshot()).toBe(MAX_RECORDING_INPUT_OFFSET_MS);
    alignment.setOffsetMs(MIN_RECORDING_INPUT_OFFSET_MS - 1);
    expect(alignment.getSnapshot()).toBe(MIN_RECORDING_INPUT_OFFSET_MS);
  });

  it("gives every input device its OWN slot", () => {
    const storage = memoryStorage();
    const { alignment, select } = controllerFor(storage);

    alignment.setOffsetMs(38);
    select("mic-b");
    alignment.setOffsetMs(7);

    expect(storage.getItem(recordingAlignmentStorageKey("mic-a"))).toBe("38");
    expect(storage.getItem(recordingAlignmentStorageKey("mic-b"))).toBe("7");
    expect(recordingAlignmentStorageKey("mic-a")).not.toBe(recordingAlignmentStorageKey("mic-b"));
    expect(recordingAlignmentStorageKey("mic-a")).toContain(RECORDING_ALIGNMENT_STORAGE_PREFIX);
  });

  it("NEVER carries one interface's offset over to another interface (audit R-3)", () => {
    const storage = memoryStorage();
    const { alignment, select } = controllerFor(storage);

    alignment.setOffsetMs(38);
    // The user plugs in the built-in microphone and records a take.
    select("mic-b");
    expect(alignment.getSnapshot()).toBe(0);

    // …and the offset written while on mic-b must not leak back into mic-a.
    alignment.setOffsetMs(-11);
    select("mic-a");
    expect(alignment.getSnapshot()).toBe(38);
  });

  it("restores the device's own calibration when the user switches back", () => {
    const storage = memoryStorage();
    const { alignment, select } = controllerFor(storage);

    alignment.setOffsetMs(38);
    select("mic-b");
    expect(alignment.getSnapshot()).toBe(0);
    select("mic-a");
    expect(alignment.getSnapshot()).toBe(38);
  });

  it("gives the system default input a named slot of its own", () => {
    const storage = memoryStorage();
    const { alignment } = controllerFor(storage, "");
    alignment.setOffsetMs(21);
    expect(storage.getItem(`${RECORDING_ALIGNMENT_STORAGE_PREFIX}default`)).toBe("21");
    expect(recordingAlignmentStorageKey("")).toBe(`${RECORDING_ALIGNMENT_STORAGE_PREFIX}default`);
  });

  it("adopts the LEGACY global offset for the selected device once, then drops it", () => {
    const storage = memoryStorage();
    storage.setItem(LEGACY_RECORDING_ALIGNMENT_STORAGE_KEY, "42");

    const { alignment } = controllerFor(storage, "mic-a");

    expect(alignment.getSnapshot()).toBe(42);
    expect(storage.getItem(recordingAlignmentStorageKey("mic-a"))).toBe("42");
    // The global key is gone — it must never apply to a second device again.
    expect(storage.getItem(LEGACY_RECORDING_ALIGNMENT_STORAGE_KEY)).toBeNull();

    // A different device does NOT inherit the legacy value.
    const other = controllerFor(storage, "mic-b");
    expect(other.alignment.getSnapshot()).toBe(0);
  });

  it("keeps a device's own calibration when the legacy value arrives", () => {
    const storage = memoryStorage();
    storage.setItem(recordingAlignmentStorageKey("mic-a"), "10");
    storage.setItem(LEGACY_RECORDING_ALIGNMENT_STORAGE_KEY, "42");

    const { alignment } = controllerFor(storage, "mic-a");

    expect(alignment.getSnapshot()).toBe(10);
    expect(storage.getItem(LEGACY_RECORDING_ALIGNMENT_STORAGE_KEY)).toBeNull();
  });

  it("drops a malformed or zero legacy value without inventing a calibration", () => {
    const storage = memoryStorage();
    storage.setItem(LEGACY_RECORDING_ALIGNMENT_STORAGE_KEY, "not-a-number");
    const { alignment } = controllerFor(storage, "mic-a");
    expect(alignment.getSnapshot()).toBe(0);
    expect(storage.getItem(LEGACY_RECORDING_ALIGNMENT_STORAGE_KEY)).toBeNull();

    const zeroed = memoryStorage();
    zeroed.setItem(LEGACY_RECORDING_ALIGNMENT_STORAGE_KEY, "0");
    const second = controllerFor(zeroed, "mic-a");
    expect(second.alignment.getSnapshot()).toBe(0);
  });

  it("recovers safely from malformed or unavailable storage and notifies subscribers", () => {
    const storage = memoryStorage();
    storage.setItem(recordingAlignmentStorageKey("mic-a"), "not-a-number");
    const { alignment } = controllerFor(storage);
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
    const blocked = new RecordingAlignmentController(blockedStorage, () => "mic-a");
    expect(() => blocked.setOffsetMs(25)).not.toThrow();
    expect(blocked.getSnapshot()).toBe(25);
  });

  it("reset clears the slot of the device that is selected NOW", () => {
    const storage = memoryStorage();
    const { alignment, select } = controllerFor(storage);
    alignment.setOffsetMs(38);
    select("mic-b");
    alignment.reset();
    expect(storage.getItem(recordingAlignmentStorageKey("mic-b"))).toBeNull();
    // The other device keeps its own calibration.
    expect(storage.getItem(recordingAlignmentStorageKey("mic-a"))).toBe("38");
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
    const { alignment } = controllerFor(memoryStorage());
    alignment.setOffsetMs(recordingOffsetFromMeasurement({ roundTripMs: 940.2, stable: true })!);
    expect(alignment.getSnapshot()).toBe(MAX_RECORDING_INPUT_OFFSET_MS);
    alignment.setOffsetMs(recordingOffsetFromMeasurement({ roundTripMs: -940.2, stable: true })!);
    expect(alignment.getSnapshot()).toBe(MIN_RECORDING_INPUT_OFFSET_MS);
  });
});
