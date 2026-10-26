// The latency probe must measure the microphone the app RECORDS from.
//
// Audit R-3: the probe used to call getUserMedia without a device constraint,
// so it measured the SYSTEM DEFAULT microphone while the offset was filed
// under the SELECTED one. That mismatch is how one interface's calibration
// ended up compensating another interface's takes.
//
// The teeth probe here is to drop the `{ exact: deviceId }` constraint:
// "the probe asks for the selected device" goes RED, and — because the fake
// browser only raises OverconstrainedError for a device it was ASKED for and
// does not have — "a missing device fails the calibration" goes RED too.

import { describe, expect, it, vi } from "vitest";
import { AudioLatencyCalibrationError, measureAudioRoundTrip } from "../src/audio-engine/latencyProbe";

interface RecordedCall {
  constraints: MediaStreamConstraints;
}

/**
 * A fake browser: it only refuses a device it was ASKED for and does not
 * have (OverconstrainedError), and it hands out the system default when no
 * device was asked for — exactly the behaviour the real browser has, and the
 * behaviour that made the old, unconstrained probe measure the wrong mic.
 */
function stubProbeEnvironment(options: { availableDevices?: string[]; abortAfterConstraint?: boolean }) {
  const calls: RecordedCall[] = [];
  const available = new Set(options.availableDevices ?? []);
  const stream = {
    getTracks: () => [{ stop: () => {} }],
  } as unknown as MediaStream;

  const mediaDevices = {
    getUserMedia: async (constraints: MediaStreamConstraints) => {
      calls.push({ constraints });
      const audio = constraints.audio as MediaTrackConstraints | undefined;
      const deviceId = audio?.deviceId;
      const wanted =
        typeof deviceId === "object" && deviceId !== null && "exact" in deviceId && typeof deviceId.exact === "string"
          ? deviceId.exact
          : undefined;
      if (wanted && !available.has(wanted)) {
        throw new DOMException("Requested device not found", "OverconstrainedError");
      }
      if (options.abortAfterConstraint) throw new Error("stop after the constraint was recorded");
      return stream;
    },
  };

  vi.stubGlobal("navigator", { mediaDevices });
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      port = { onmessage: null };
      connect(target: unknown) {
        return target;
      }
      disconnect() {}
    },
  );

  const node = {
    connect: (target: unknown) => target,
    disconnect: () => {},
  };
  const ctx = {
    audioWorklet: { addModule: async () => {} },
    state: "running",
    currentTime: 0,
    sampleRate: 48_000,
    destination: {},
    createMediaStreamSource: () => node,
    createGain: () => ({ gain: { value: 1 }, connect: (target: unknown) => target, disconnect: () => {} }),
    createBuffer: (_channels: number, length: number) => ({
      getChannelData: () => new Float32Array(length),
    }),
    createBufferSource: () => ({
      buffer: null,
      connect: () => {},
      start: () => {},
      stop: () => {},
    }),
  } as unknown as AudioContext;

  return { calls, ctx };
}

describe("latency probe — the measured microphone is the recorded one", () => {
  it("asks the browser for the SELECTED input, not the system default", async () => {
    const { calls, ctx } = stubProbeEnvironment({ availableDevices: ["mic-a"], abortAfterConstraint: true });

    await expect(measureAudioRoundTrip(ctx, undefined, undefined, "mic-a")).rejects.toThrow();

    expect(calls).toHaveLength(1);
    expect(calls[0].constraints.audio).toMatchObject({ deviceId: { exact: "mic-a" } });
  });

  it("keeps the microphone constraints that make the measurement usable", async () => {
    const { calls, ctx } = stubProbeEnvironment({ availableDevices: ["mic-a"], abortAfterConstraint: true });

    await expect(measureAudioRoundTrip(ctx, undefined, undefined, "mic-a")).rejects.toThrow();

    const audio = calls[0].constraints.audio as MediaTrackConstraints;
    expect(audio.echoCancellation).toBe(false);
    expect(audio.noiseSuppression).toBe(false);
    expect(audio.autoGainControl).toBe(false);
  });

  it("FAILS the calibration when the selected device is gone instead of measuring another one", async () => {
    // The browser has only "mic-other"; the calibration asked for "mic-gone".
    const { ctx } = stubProbeEnvironment({ availableDevices: ["mic-other"] });

    const error = await measureAudioRoundTrip(ctx, undefined, undefined, "mic-gone").catch((cause) => cause);

    expect(error).toBeInstanceOf(AudioLatencyCalibrationError);
    expect((error as Error).message).toMatch(/not available/i);
  });

  it("does not constrain the device when the system default input is selected", async () => {
    const { calls, ctx } = stubProbeEnvironment({ availableDevices: ["mic-a"], abortAfterConstraint: true });

    await expect(measureAudioRoundTrip(ctx, undefined, undefined, "")).rejects.toThrow();

    expect(calls).toHaveLength(1);
    expect(calls[0].constraints.audio).not.toHaveProperty("deviceId");
  });
});
