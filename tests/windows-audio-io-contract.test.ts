import { describe, expect, it } from "vitest";
import {
  validateWindowsAudioIoNegotiation,
  validateWindowsAudioIoPcmPacket,
  validateWindowsAudioIoRequest,
  type WindowsAudioIoNegotiation,
  type WindowsAudioIoRequest,
} from "../src/audio-engine/windowsAudioIo";

function request(overrides: Partial<WindowsAudioIoRequest> = {}): WindowsAudioIoRequest {
  return {
    backend: "wasapi-shared",
    inputEndpointId: "volt-capture-id",
    outputEndpointId: "volt-render-id",
    sampleRateHz: 48_000,
    periodFrames: 480,
    inputChannelMap: [1, 0],
    outputChannelMap: [0, 1],
    exclusiveAcknowledged: false,
    ...overrides,
  };
}

function negotiation(overrides: Partial<WindowsAudioIoNegotiation> = {}): WindowsAudioIoNegotiation {
  return {
    backend: "wasapi-shared",
    inputEndpointId: "volt-capture-id",
    outputEndpointId: "volt-render-id",
    sampleRateHz: 48_000,
    periodFrames: 480,
    nativeSampleFormat: "f32le",
    ringSampleFormat: "f32le",
    inputChannelCount: 2,
    outputChannelCount: 2,
    inputChannelMap: [1, 0],
    outputChannelMap: [0, 1],
    inputBufferFrames: 1_056,
    outputBufferFrames: 1_056,
    reportedInputLatencyFrames: 1_056,
    reportedOutputLatencyFrames: 1_056,
    sharedPeriods: { minFrames: 480, maxFrames: 480, fundamentalFrames: 48 },
    ...overrides,
  };
}

describe("Windows audio-I/O backend contract", () => {
  it("accepts bounded capture and render packets only for the active session", () => {
    const samples = new Float32Array(480 * 2).buffer;
    const capture = validateWindowsAudioIoPcmPacket(
      { type: "capture", sessionId: "session-1", sequence: 0, frames: 480, channels: 2, samples },
      "capture",
      "session-1",
      2,
    );
    const render = validateWindowsAudioIoPcmPacket(
      { type: "render", sessionId: "session-1", sequence: 8, frames: 480, channels: 2, samples },
      "render",
      "session-1",
      2,
    );
    expect(capture.ok).toBe(true);
    expect(render.ok).toBe(true);
  });

  it("rejects wrong direction, stale session, channel layout and sample-buffer length", () => {
    const result = validateWindowsAudioIoPcmPacket(
      {
        type: "render",
        sessionId: "old-session",
        sequence: -1,
        frames: 480,
        channels: 1,
        samples: new ArrayBuffer(16),
      },
      "capture",
      "current-session",
      2,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("invalid PCM packet unexpectedly passed");
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "PCM packet direction is invalid",
        "PCM packet belongs to a different session",
        "PCM packet sequence is invalid",
        "PCM packet channel count does not match the selected channel map",
        "PCM packet sample buffer length is inconsistent",
      ]),
    );
  });

  it("caps packet dimensions before accepting transferred PCM", () => {
    const result = validateWindowsAudioIoPcmPacket(
      { type: "capture", sessionId: "session-1", sequence: 0, frames: 8193, channels: 2, samples: new ArrayBuffer(0) },
      "capture",
      "session-1",
      2,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("oversized PCM packet unexpectedly passed");
    expect(result.errors).toContain("PCM packet frame count is invalid");
  });

  it("allows the maximum one-megabyte packet at exactly 8192 frames by 32 channels", () => {
    const samples = new ArrayBuffer(8192 * 32 * Float32Array.BYTES_PER_ELEMENT);
    const result = validateWindowsAudioIoPcmPacket(
      { type: "capture", sessionId: "session-1", sequence: 0, frames: 8192, channels: 32, samples },
      "capture",
      "session-1",
      32,
    );
    expect(result.ok).toBe(true);
  });

  it("preserves exact endpoints, period and user channel order", () => {
    const result = validateWindowsAudioIoRequest(request());
    expect(result).toEqual({ ok: true, value: request() });
  });

  it("rejects missing endpoints, duplicate/negative channels and invalid periods", () => {
    const result = validateWindowsAudioIoRequest(
      request({
        inputEndpointId: " ",
        outputEndpointId: "x".repeat(2049),
        inputChannelMap: [0, 0],
        outputChannelMap: [-1],
        periodFrames: 0,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("invalid I/O request unexpectedly passed");
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "inputEndpointId must select an exact endpoint",
        "outputEndpointId must select an exact endpoint",
        "periodFrames must be a positive bounded integer",
        "inputChannelMap must contain unique zero-based channel indexes",
        "outputChannelMap must contain unique zero-based channel indexes",
      ]),
    );
  });

  it("requires explicit acknowledgement before requesting WASAPI exclusive mode", () => {
    const result = validateWindowsAudioIoRequest(
      request({ backend: "wasapi-exclusive", exclusiveAcknowledged: false }),
    );
    expect(result).toEqual({
      ok: false,
      errors: ["WASAPI exclusive mode requires explicit acknowledgement"],
    });
  });

  it("accepts the exact shared-mode negotiation when its period is legal", () => {
    const result = validateWindowsAudioIoNegotiation(request(), negotiation());
    expect(result).toEqual({ ok: true, value: negotiation() });
  });

  it("keeps reported stream latency separate and rejects invalid latency counters", () => {
    const result = validateWindowsAudioIoNegotiation(
      request(),
      negotiation({ reportedInputLatencyFrames: Number.NaN }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("invalid latency counter unexpectedly passed");
    expect(result.errors).toContain("reportedInputLatencyFrames is invalid");
  });

  it("rejects silent endpoint, sample-rate, period or channel-map substitutions", () => {
    const result = validateWindowsAudioIoNegotiation(
      request(),
      negotiation({
        inputEndpointId: "system-default-input",
        sampleRateHz: 44_100,
        periodFrames: 512,
        inputChannelMap: [0, 1],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("substituted negotiation unexpectedly passed");
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "input endpoint was substituted",
        "sample rate was not honored exactly",
        "period was not honored exactly",
        "input channel map was changed",
      ]),
    );
  });

  it("rejects channel maps outside endpoint capacity and shared periods outside the IAudioClient3 grid", () => {
    const badMap = validateWindowsAudioIoNegotiation(request(), negotiation({ inputChannelCount: 1 }));
    expect(badMap.ok).toBe(false);
    if (badMap.ok) throw new Error("out-of-range channel map unexpectedly passed");
    expect(badMap.errors).toContain("input channel map exceeds the negotiated endpoint channel count");

    const misaligned = validateWindowsAudioIoNegotiation(
      request({ periodFrames: 500 }),
      negotiation({ periodFrames: 500, sharedPeriods: { minFrames: 480, maxFrames: 960, fundamentalFrames: 48 } }),
    );
    expect(misaligned.ok).toBe(false);
    if (misaligned.ok) throw new Error("misaligned shared period unexpectedly passed");
    expect(misaligned.errors).toContain(
      "shared-mode period is outside the endpoint's legal range or not fundamental-period aligned",
    );
  });
});
