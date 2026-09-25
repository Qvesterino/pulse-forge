import { describe, expect, it } from "vitest";
import { reviewSongAudio } from "../src/intent/song-audio-review";

function fakeBuffer(channels: Float32Array[], sampleRate = 44_100): AudioBuffer {
  return {
    numberOfChannels: channels.length,
    length: channels[0]?.length ?? 0,
    sampleRate,
    getChannelData: (index: number) => channels[index]!,
  } as unknown as AudioBuffer;
}

describe("whole-song render review", () => {
  it("measures the audition buffer without flagging a healthy signal", () => {
    const review = reviewSongAudio(
      fakeBuffer([new Float32Array(44_100).fill(0.5), new Float32Array(44_100).fill(0.5)]),
    );

    expect(review.durationSeconds).toBe(1);
    expect(review.peakDbfs).toBe(-6);
    expect(review.rmsDbfs).toBe(-6);
    expect(review.crestFactor).toBe(1);
    expect(review.nonFiniteSamples).toBe(0);
    expect(review.findings).toEqual([]);
  });

  it("reports non-finite and near-full-scale evidence without corrupting the input", () => {
    const left = new Float32Array([Number.NaN, 1]);
    const review = reviewSongAudio(fakeBuffer([left, new Float32Array([0, 0])], 2));

    expect(review.peakDbfs).toBe(0);
    expect(review.nonFiniteSamples).toBe(1);
    expect(review.findings.map((finding) => finding.code)).toEqual(["non-finite-samples", "near-full-scale"]);
    expect(left[0]).toBeNaN();
  });

  it("flags a near-silent song so missing signal is visible before USE", () => {
    const review = reviewSongAudio(fakeBuffer([new Float32Array(256).fill(0.0001)]));

    expect(review.findings.map((finding) => finding.code)).toEqual(["near-silence"]);
    expect(review.rmsDbfs).toBeLessThan(-70);
  });
});
