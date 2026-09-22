import { describe, expect, it } from "vitest";
import {
  audioBufferToMusicCocaAudioReference,
  createMockGenerativeProvider,
  generateGenerativeVariations,
  toMusicCocaAudioReference,
} from "../src/generative";

function input() {
  return {
    bpm: 120,
    frameRateHz: 25 as const,
    startTick: 0,
    style: { kind: "audio" as const, sampleRate: 16_000, channels: [new Float32Array([0.1, 0.2, 0.3, 0.4])] },
    noteFrames: [{ frameIndex: 0, pitchState: new Array<number>(128).fill(0) }],
    drumsMode: "off" as const,
    macros: { energy: 0.5, density: 0.3, variation: 0.2, texture: 0.6 },
  };
}

describe("generative resample", () => {
  it("downmixes, caps and resamples a reference to 16 kHz mono", () => {
    const result = toMusicCocaAudioReference(
      {
        sampleRate: 8_000,
        channels: [new Float32Array([1, 0, 0, 0]), new Float32Array([0, 1, 0, 0])],
      },
      { maxSeconds: 0.0005 },
    );
    expect(result.kind).toBe("audio");
    expect(result.sampleRate).toBe(16_000);
    expect(result.channels).toHaveLength(1);
    expect(result.channels[0]!.length).toBe(8);
    expect(result.channels[0]![0]).toBeCloseTo(0.5, 5);
  });

  it("reads an AudioBuffer without changing the source", () => {
    const buffer = {
      numberOfChannels: 1,
      sampleRate: 8_000,
      getChannelData: () => new Float32Array([0, 0.5, 1]),
    } as unknown as AudioBuffer;
    const reference = audioBufferToMusicCocaAudioReference(buffer);
    expect(reference.sampleRate).toBe(16_000);
    expect(reference.channels[0]!.length).toBe(6);
  });

  it("generates four preview-only variations without persisting them", async () => {
    const provider = createMockGenerativeProvider({ providerId: "mrt2", modelId: "mrt2_small", sampleRate: 48_000 });
    const result = await generateGenerativeVariations(provider, "mrt2_small", input(), { durationSec: 0.02 });
    expect(result.map((item) => item.label)).toEqual(["A", "B", "C", "D"]);
    expect(result.every((item) => item.audio.providerId === "mrt2")).toBe(true);
  });
});
