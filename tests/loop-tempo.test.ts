import { describe, expect, it } from "vitest";
import { loopPreviewPlaybackRate } from "../src/audio-engine/loopTempo";

describe("loop preview tempo matching", () => {
  it("uses the target/source ratio for AudioBufferSourceNode playback rate", () => {
    expect(loopPreviewPlaybackRate(120, 90)).toBe(0.75);
    expect(loopPreviewPlaybackRate(90, 120)).toBeCloseTo(4 / 3);
    expect(loopPreviewPlaybackRate(120, 120)).toBe(1);
  });

  it("falls back safely for invalid tempos and respects the preview rate bounds", () => {
    expect(loopPreviewPlaybackRate(Number.NaN, 120)).toBe(1);
    expect(loopPreviewPlaybackRate(120, 0)).toBe(1);
    expect(loopPreviewPlaybackRate(240, 20)).toBe(0.25);
    expect(loopPreviewPlaybackRate(40, 400)).toBe(4);
  });
});
