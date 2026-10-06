import { describe, expect, it } from "vitest";
import { encodeWav } from "../../src/rendering/wav";
import { separateHPSS } from "../../src/analysis/hpss";
import { goldenTracks, renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "./golden-synth";

/**
 * S2 — stems export determinism: separateHPSS is pinned bit-identical in
 * hpss.test.ts; the WAV encoder is a pure function; therefore the exported
 * bytes for the same input must be byte-identical across runs.
 */
function fakeBuffer(channels: Float32Array[], sampleRate: number) {
  return {
    numberOfChannels: channels.length,
    length: channels[0].length,
    sampleRate,
    getChannelData: (index: number) => channels[index],
  };
}

describe("S2 stems export — encoder + end-to-end determinism", () => {
  it("the encoder is deterministic for the same buffer", () => {
    const pcm = renderGoldenTrack(goldenTracks()[0]);
    const buffer = fakeBuffer([pcm], GOLDEN_SAMPLE_RATE);
    const a = encodeWav(buffer as unknown as AudioBuffer, 16);
    const b = encodeWav(buffer as unknown as AudioBuffer, 16);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("the same input file yields byte-identical stem WAVs across full runs", () => {
    const pcm = renderGoldenTrack(goldenTracks()[1]);
    const encodeStems = (): ArrayBuffer[] => {
      const stems = separateHPSS(pcm, GOLDEN_SAMPLE_RATE)!;
      return (["percussive", "harmonic", "bass"] as const).map((key) =>
        encodeWav(fakeBuffer([stems[key]], GOLDEN_SAMPLE_RATE) as unknown as AudioBuffer, 16),
      );
    };
    const a = encodeStems();
    const b = encodeStems();
    expect(a.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(Buffer.from(a[i]).equals(Buffer.from(b[i]))).toBe(true);
      // valid RIFF/WAVE header
      const head = Buffer.from(a[i]);
      expect(head.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(head.subarray(8, 12).toString("ascii")).toBe("WAVE");
      expect(head.readUInt32LE(24)).toBe(GOLDEN_SAMPLE_RATE);
    }
  });
});
