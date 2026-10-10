import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPRESSED_AUDIO_FORMATS,
  COMPRESSED_AUDIO_SAMPLE_RATES,
  canEncodeCompressedAudio,
  compressedAudioUnavailableReason,
  findCompressedAudioFormat,
  isCompressedAudioSampleRateSupported,
  supportedCompressedAudioFormats,
} from "../../src/export/compressed-audio-capabilities";
import { encodeCompressedAudio } from "../../src/export/compressed-audio";

const probeCompressedAudioCodec = vi.hoisted(() => vi.fn());
vi.mock("../../src/export/compressed-audio-probe", () => ({ probeCompressedAudioCodec }));

import { probeCompressedAudioCodec as mockedProbeCompressedAudioCodec } from "../../src/export/compressed-audio-probe";

function fakeBuffer(seconds: number, channels = 2, sampleRate = 48000): AudioBuffer {
  const length = Math.floor(seconds * sampleRate);
  const datas = Array.from({ length: channels }, (_, c) => {
    const d = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      d[i] = 0.5 * Math.sin((i / sampleRate) * 440 * 2 * Math.PI * (c === 1 ? 1.005 : 1));
    }
    return d;
  });
  return {
    duration: seconds,
    sampleRate,
    numberOfChannels: channels,
    length,
    getChannelData: (c: number) => datas[Math.min(c, channels - 1)],
  } as unknown as AudioBuffer;
}

describe("compressed audio capability table", () => {
  it("offers unique ids, extensions and container MIME types", () => {
    expect(COMPRESSED_AUDIO_FORMATS.map((format) => format.id)).toEqual(["ogg-opus", "m4a-aac"]);
    expect(new Set(COMPRESSED_AUDIO_FORMATS.map((format) => format.extension)).size).toBe(
      COMPRESSED_AUDIO_FORMATS.length,
    );
    expect(new Set(COMPRESSED_AUDIO_FORMATS.map((format) => format.mimeType)).size).toBe(
      COMPRESSED_AUDIO_FORMATS.length,
    );
    // OGG must not claim an MP4 MIME type and vice versa — the download
    // filename and the container have to agree.
    expect(findCompressedAudioFormat("ogg-opus").mimeType).toBe("audio/ogg");
    expect(findCompressedAudioFormat("m4a-aac").mimeType).toBe("audio/mp4");
  });

  it("rejects an unknown target id rather than returning undefined", () => {
    expect(() => findCompressedAudioFormat("wav" as never)).toThrow(/Unknown compressed audio target/);
  });

  it("gates sample rates to the MP3 ceiling", () => {
    expect([...COMPRESSED_AUDIO_SAMPLE_RATES]).toEqual([44_100, 48_000]);
    expect(isCompressedAudioSampleRateSupported(44_100)).toBe(true);
    expect(isCompressedAudioSampleRateSupported(48_000)).toBe(true);
    // 96 kHz is valid FLAC/WAV but unsupported here — the gate must not drift
    // open just because a wider FLAC table exists next door.
    expect(isCompressedAudioSampleRateSupported(96_000)).toBe(false);
    expect(isCompressedAudioSampleRateSupported(44_100.5)).toBe(false);
  });

  it("explains *why* a format is unavailable instead of saying 'unsupported'", () => {
    expect(compressedAudioUnavailableReason(findCompressedAudioFormat("m4a-aac"))).toMatch(/Firefox/);
    expect(compressedAudioUnavailableReason(findCompressedAudioFormat("ogg-opus"))).toMatch(/WebCodecs/);
  });
});

describe("compressed audio capability probe", () => {
  // jsdom ships no WebCodecs `AudioEncoder`, which is the same shape as an
  // older Safari or Firefox. The probe must answer `false`, not throw, or the
  // export menu would break the panel instead of just hiding two entries.
  it("reports unsupported instead of throwing when WebCodecs is absent", async () => {
    expect(typeof AudioEncoder).toBe("undefined");
    await expect(canEncodeCompressedAudio("opus")).resolves.toBe(false);
    await expect(canEncodeCompressedAudio("aac")).resolves.toBe(false);
  });

  it("offers no share formats when nothing can be encoded", async () => {
    await expect(supportedCompressedAudioFormats()).resolves.toEqual([]);
  });

  it("checks the selected sample rate, channel count and quality in the lazy probe", async () => {
    vi.stubGlobal("AudioEncoder", class AudioEncoder {});
    vi.mocked(mockedProbeCompressedAudioCodec).mockResolvedValue(true);

    await expect(
      canEncodeCompressedAudio("opus", { sampleRate: 44_100, numberOfChannels: 1, quality: "very-high" }),
    ).resolves.toBe(true);
    expect(mockedProbeCompressedAudioCodec).toHaveBeenCalledWith("opus", {
      sampleRate: 44_100,
      numberOfChannels: 1,
      quality: "very-high",
    });
  });

  it("fails closed before loading the probe for unsupported channels or rates", async () => {
    vi.stubGlobal("AudioEncoder", class AudioEncoder {});

    await expect(canEncodeCompressedAudio("aac", { sampleRate: 96_000 })).resolves.toBe(false);
    await expect(canEncodeCompressedAudio("aac", { numberOfChannels: 0 })).resolves.toBe(false);
    expect(mockedProbeCompressedAudioCodec).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(mockedProbeCompressedAudioCodec).mockReset();
  });
});

describe("encodeCompressedAudio guards", () => {
  // Sample-rate and channel validation run *before* the capability probe, so
  // these assertions describe the same behaviour in every browser.
  it("rejects an unsupported sample rate by name", async () => {
    await expect(encodeCompressedAudio(fakeBuffer(0.1, 2, 96_000), { target: "ogg-opus" })).rejects.toThrow(
      /OGG \(Opus · web\) export does not support 96000 Hz/,
    );
  });

  it("rejects unsupported channel counts before touching the encoder", async () => {
    await expect(encodeCompressedAudio(fakeBuffer(0.1, 16), { target: "m4a-aac" })).rejects.toThrow(
      /between 1 and 8 channels/,
    );
  });

  it("fails with an actionable browser message, not a raw WebCodecs failure", async () => {
    await expect(encodeCompressedAudio(fakeBuffer(0.1), { target: "ogg-opus" })).rejects.toThrow(
      /cannot encode Opus.*Chrome, Edge, Firefox/s,
    );
    await expect(encodeCompressedAudio(fakeBuffer(0.1), { target: "m4a-aac" })).rejects.toThrow(
      /cannot encode AAC.*Firefox cannot/s,
    );
  });

  it("propagates cancellation as an AbortError", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      encodeCompressedAudio(fakeBuffer(0.1), { target: "ogg-opus", signal: controller.signal }),
    ).rejects.toThrow(/Export cancelled/);
  });
});
