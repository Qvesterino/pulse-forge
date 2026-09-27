import { describe, expect, it, vi } from "vitest";

import {
  diffAudioDevices,
  normalizeDevices,
  readStoragePressure,
  shouldShowSuspendedChip,
  type AudioDeviceInfo,
} from "../src/services/deviceMonitor";

/**
 * DEVICE MONITOR + audio status chips — the studio's "something is off with
 * sound" surface. The diff must speak only when it matters (a device
 * DISAPPEARED or a new one appeared after the baseline) and stay silent on
 * the first snapshot; the suspended chip fires only for the contradictory
 * "playing but suspended" state; storage pressure reports a clamped
 * fraction or null without the API.
 */

function dev(id: string, kind: AudioDeviceInfo["kind"], label: string): AudioDeviceInfo {
  return { deviceId: id, kind, label };
}

function fakeNavigatorStorage(estimate: { usage?: number; quota?: number } | null): void {
  vi.stubGlobal("navigator", {
    ...globalThis.navigator,
    storage: estimate ? { estimate: async () => estimate } : undefined,
  });
}

describe("diffAudioDevices", () => {
  it("is silent when nothing changed", () => {
    const devices = [dev("1", "audiooutput", "Speakers"), dev("2", "audioinput", "Mic")];
    expect(diffAudioDevices(devices, devices)).toEqual([]);
  });

  it("warns when an output device disappears (fallback is silent in the browser)", () => {
    const before = [dev("1", "audiooutput", "Headphones"), dev("2", "audioinput", "Mic")];
    const after = [dev("2", "audioinput", "Mic")];
    const messages = diffAudioDevices(before, after);
    expect(messages).toEqual([
      { level: "warn", message: "Headphones disconnected — audio moved to the remaining output" },
    ]);
  });

  it("warns when the microphone disappears (record panel keeps a dead selection)", () => {
    const before = [dev("1", "audiooutput", "Speakers"), dev("2", "audioinput", "USB Mic")];
    const after = [dev("1", "audiooutput", "Speakers")];
    expect(diffAudioDevices(before, after)).toEqual([{ level: "warn", message: "USB Mic disconnected" }]);
  });

  it("announces new devices after the baseline snapshot", () => {
    const before = [dev("1", "audiooutput", "Speakers")];
    const after = [dev("1", "audiooutput", "Speakers"), dev("3", "audioinput", "Studio Mic")];
    expect(diffAudioDevices(before, after)).toEqual([{ level: "info", message: "New input device: Studio Mic" }]);
  });

  it("never messages on the very first snapshot (baseline warm-up)", () => {
    const after = [dev("1", "audiooutput", "Speakers"), dev("3", "audioinput", "Studio Mic")];
    expect(diffAudioDevices([], after)).toEqual([]);
  });
});

describe("normalizeDevices", () => {
  it("drops non-audio kinds and fills empty permission labels with the kind", () => {
    const normalized = normalizeDevices([
      { deviceId: "1", kind: "videoinput", label: "Camera", groupId: "g", toJSON: () => "" },
      { deviceId: "2", kind: "audiooutput", label: "", groupId: "g", toJSON: () => "" },
    ] as unknown as MediaDeviceInfo[]);
    expect(normalized).toEqual([{ deviceId: "2", kind: "audiooutput", label: "Output" }]);
  });
});

describe("shouldShowSuspendedChip", () => {
  it("fires only for the contradictory playing-but-suspended state", () => {
    expect(shouldShowSuspendedChip("suspended", true)).toBe(true);
    expect(shouldShowSuspendedChip("suspended", false)).toBe(false);
    expect(shouldShowSuspendedChip("running", true)).toBe(false);
    expect(shouldShowSuspendedChip(null, true)).toBe(false);
    expect(shouldShowSuspendedChip("interrupted", true)).toBe(false);
  });
});

describe("readStoragePressure", () => {
  it("returns a clamped fraction from the estimate API", async () => {
    fakeNavigatorStorage({ usage: 850, quota: 1000 });
    const pressure = await readStoragePressure();
    expect(pressure).toBeCloseTo(0.85, 5);
  });

  it("returns null without the storage API or a usable quota", async () => {
    fakeNavigatorStorage(null);
    expect(await readStoragePressure()).toBeNull();
    fakeNavigatorStorage({ usage: 5, quota: 0 });
    expect(await readStoragePressure()).toBeNull();
  });
});
