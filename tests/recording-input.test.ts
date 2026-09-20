import { describe, expect, it } from "vitest";
import {
  listRecordingInputDevices,
  loadRecordingInputDeviceId,
  saveRecordingInputDeviceId,
} from "../src/audio-engine/recordingInput";

function fakeDevice(kind: MediaDeviceKind, deviceId: string, label = ""): MediaDeviceInfo {
  return { kind, deviceId, label } as MediaDeviceInfo;
}

describe("recording input selection", () => {
  it("persists the selected device as a user preference and safely resets to system default", () => {
    const values = new Map<string, string>();
    const storage: Storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
      clear: () => values.clear(),
      key: () => null,
      get length() {
        return values.size;
      },
    };

    saveRecordingInputDeviceId("interface-input-2", storage);
    expect(loadRecordingInputDeviceId(storage)).toBe("interface-input-2");
    saveRecordingInputDeviceId("", storage);
    expect(loadRecordingInputDeviceId(storage)).toBe("");
  });

  it("lists only distinct named audio inputs and gives anonymous devices stable labels", async () => {
    const devices = await listRecordingInputDevices({
      enumerateDevices: async () =>
        [
          fakeDevice("audioinput", "default", "System default"),
          fakeDevice("audioinput", "interface-1", "Studio interface · Input 1"),
          fakeDevice("audioinput", "interface-1", "Duplicate entry"),
          fakeDevice("audioinput", "interface-2"),
          fakeDevice("audiooutput", "speaker-1", "Speakers"),
          fakeDevice("videoinput", "camera-1", "Camera"),
        ] as MediaDeviceInfo[],
    });

    expect(devices).toEqual([
      { deviceId: "interface-1", label: "Studio interface · Input 1" },
      { deviceId: "interface-2", label: "Microphone 2" },
    ]);
  });

  it("degrades to the system default when enumeration is unavailable", async () => {
    await expect(listRecordingInputDevices(null)).resolves.toEqual([]);
  });
});
