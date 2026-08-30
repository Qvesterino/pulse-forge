import { describe, expect, it } from "vitest";
import { audioClipPlayWindow } from "../src/audio-engine/AudioEngine";
import type { AudioClip } from "../src/project-model/types";

function makeClip(patch: Partial<AudioClip> = {}): AudioClip {
  return {
    id: "clip-1",
    trackId: "track-1",
    bufferId: "buf-1",
    startBar: 0,
    lengthBars: 4,
    offsetSec: 0,
    trimStart: 0,
    trimEnd: 0,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
    stretchRate: 1,
    reverse: false,
    ...patch,
  };
}

describe("audioClipPlayWindow", () => {
  it("uses offsetSec+trimStart as the buffer-time start (resample semantics)", () => {
    const clip = makeClip({ offsetSec: 1, trimStart: 0.5, trimEnd: 1 });
    // 6 s buffer, long requested duration -> capped to buffer minus offset/trim.
    const win = audioClipPlayWindow(clip, 6, 10, 1);
    expect(win.duration).toBeCloseTo(3.5, 5); // 6 - 1.5 - 1
    expect(win.playOffset).toBeCloseTo(1.5, 5);
  });

  it("scales offset and trims into stretched-buffer time (stretch semantics)", () => {
    // offsetSec/trimStart/trimEnd are seconds of the ORIGINAL sample; a clip
    // stretched by rate r plays a pre-stretched buffer whose timeline is
    // original × r. With rate 2: 1.5 s source offset -> 3 s, 1 s trimEnd -> 2 s.
    const clip = makeClip({ offsetSec: 1, trimStart: 0.5, trimEnd: 1, stretchRate: 2, stretchMode: "stretch" });
    const win = audioClipPlayWindow(clip, 6, 10, 2);
    expect(win.duration).toBeCloseTo(1, 5); // 6 - 3 - 2
    expect(win.playOffset).toBeCloseTo(3, 5);
  });

  it("prefers the shorter of requested vs capped duration", () => {
    const clip = makeClip({ offsetSec: 0.5 });
    expect(audioClipPlayWindow(clip, 6, 2, 1).duration).toBeCloseTo(2, 5);
    expect(audioClipPlayWindow(clip, 6, 10, 1).duration).toBeCloseTo(5.5, 5);
  });

  it("mirrors the play offset from the buffer end for reversed clips", () => {
    const clip = makeClip({ offsetSec: 1, trimStart: 0.5, trimEnd: 1, reverse: true });
    const win = audioClipPlayWindow(clip, 6, 10, 1);
    // duration 3.5, offset 1.5 -> start 6 - 1.5 - 3.5 = 1
    expect(win.playOffset).toBeCloseTo(1, 5);
    expect(win.duration).toBeCloseTo(3.5, 5);
  });

  it("never produces a negative or zero duration when trims consume the buffer", () => {
    const clip = makeClip({ offsetSec: 3, trimEnd: 3 });
    const win = audioClipPlayWindow(clip, 6, 10, 1);
    expect(win.duration).toBeCloseTo(0.01, 5);
    expect(win.playOffset).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(win.duration)).toBe(true);
    expect(Number.isFinite(win.playOffset)).toBe(true);
  });

  it("treats missing optional fields as zero", () => {
    const clip = { ...makeClip(), offsetSec: undefined, trimStart: undefined, trimEnd: undefined } as unknown as AudioClip;
    const win = audioClipPlayWindow(clip, 4, 10, 1);
    expect(win.duration).toBeCloseTo(4, 5);
    expect(win.playOffset).toBeCloseTo(0, 5);
  });
});
