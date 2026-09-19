import { describe, expect, it } from "vitest";
import {
  audioClipPlayWindow,
  buildWarpSegments,
  warpBufferTimeAtTick,
  warpSegmentRenders,
  type WarpSegment,
} from "../src/audio-engine/AudioEngine";
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
    const clip = {
      ...makeClip(),
      offsetSec: undefined,
      trimStart: undefined,
      trimEnd: undefined,
    } as unknown as AudioClip;
    const win = audioClipPlayWindow(clip, 4, 10, 1);
    expect(win.duration).toBeCloseTo(4, 5);
    expect(win.playOffset).toBeCloseTo(0, 5);
  });

  it("exposes the full trimmed content length for loop regions", () => {
    const clip = makeClip({ offsetSec: 1, trimStart: 0.5, trimEnd: 1 });
    const win = audioClipPlayWindow(clip, 6, 2, 1);
    expect(win.contentDur).toBeCloseTo(3.5, 5); // 6 - 1.5 - 1
    expect(win.duration).toBeCloseTo(2, 5); // capped to the requested length
  });
});

describe("buildWarpSegments", () => {
  // 4-bar clip holding exactly 8 s of content (120 BPM): neutral rate is 1.
  const base = {
    clipStartTick: 0,
    clipTicks: 4 * 1920,
    spt: 8 / (4 * 1920),
    contentStartSec: 0,
    contentDurSec: 8,
  };

  it("returns null without markers (legacy straight path)", () => {
    expect(buildWarpSegments({ ...base, markers: [] })).toBeNull();
  });

  it("maps a single end pin to one neutral segment at rate 1", () => {
    const segs = buildWarpSegments({ ...base, markers: [{ timeSec: 8, tick: 4 * 1920 }] })!;
    expect(segs).toHaveLength(1);
    expect(segs[0].rate).toBeCloseTo(1, 5);
    expect(segs[0].startTick).toBe(0);
    expect(segs[0].endTick).toBe(4 * 1920);
    expect(segs[0].bufStartSec).toBeCloseTo(0, 5);
    expect(segs[0].bufEndSec).toBeCloseTo(8, 5);
  });

  it("splits at a mid pin with per-segment rates", () => {
    // First half plays 6 s in 4 s of wall (×1.5), second half 2 s in 4 s (×0.5).
    const segs = buildWarpSegments({ ...base, markers: [{ timeSec: 6, tick: 2 * 1920 }] })!;
    expect(segs).toHaveLength(2);
    expect(segs[0].rate).toBeCloseTo(1.5, 5);
    expect(segs[1].rate).toBeCloseTo(0.5, 5);
    // Segments tile the clip back to back with no gaps.
    expect(segs[1].startTick).toBe(segs[0].endTick);
    expect(segs[1].bufStartSec).toBe(segs[0].bufEndSec);
  });

  it("ignores out-of-range markers (none usable -> null)", () => {
    expect(
      buildWarpSegments({
        ...base,
        markers: [
          { timeSec: 2, tick: -100 },
          { timeSec: 99, tick: 4 * 1920 + 500 },
        ],
      }),
    ).toBeNull();
  });

  it("drops degenerate pins and caps segments for realtime safety", () => {
    const markers = Array.from({ length: 70 }, (_, i) => ({ timeSec: (i + 1) * 0.1, tick: (i + 1) * 100 }));
    const segs = buildWarpSegments({ ...base, markers })!;
    expect(segs.length).toBeLessThanOrEqual(64);
    for (let i = 1; i < segs.length; i++) expect(segs[i].startTick).toBe(segs[i - 1].endTick);
    for (const s of segs) {
      expect(Number.isFinite(s.rate)).toBe(true);
      expect(s.rate).toBeGreaterThan(0);
    }
  });

  it("returns null on degenerate geometry", () => {
    expect(buildWarpSegments({ ...base, markers: [], spt: 0 })).toBeNull();
    expect(buildWarpSegments({ ...base, markers: [], clipTicks: 0 })).toBeNull();
    expect(buildWarpSegments({ ...base, markers: [], contentDurSec: 0 })).toBeNull();
    expect(buildWarpSegments({ ...base, markers: [{ timeSec: NaN, tick: 100 }] })).toBeNull();
  });
});

describe("warpBufferTimeAtTick", () => {
  // 4-bar clip, 8 s of content, 120 BPM grid (spt = 8/7680).
  const base = {
    clipStartTick: 0,
    clipTicks: 4 * 1920,
    spt: 8 / (4 * 1920),
    contentStartSec: 0,
    contentDurSec: 8,
  };

  it("straight resample position without markers (rate × wall)", () => {
    // rel 3840 ticks = 4 s wall; rate 2 consumes 8 s of source — clamped to content end.
    expect(warpBufferTimeAtTick({ ...base, markers: [], tick: 1920, stretchRate: 2 })).toBeCloseTo(4, 5);
    expect(warpBufferTimeAtTick({ ...base, markers: [], tick: 3840, stretchRate: 2 })).toBeCloseTo(8, 5);
  });

  it("straight stretch position without markers (wall ÷ rate)", () => {
    // Stretch straight plays a pre-stretched buffer: the original advances
    // at 1/rate per wall second — a pin here reproduces the legacy sound.
    expect(
      warpBufferTimeAtTick({ ...base, markers: [], tick: 3840, stretchRate: 2, stretchMode: "stretch" }),
    ).toBeCloseTo(2, 5);
  });

  it("interpolates neutrally inside an existing warp map", () => {
    const markers = [{ timeSec: 6, tick: 2 * 1920 }];
    // Midpoint of the first span (0→3840 ticks maps 0→6 s): tick 1920 = 3 s.
    expect(warpBufferTimeAtTick({ ...base, markers, tick: 1920 })).toBeCloseTo(3, 5);
    // Exact pin reproduces itself.
    expect(warpBufferTimeAtTick({ ...base, markers, tick: 2 * 1920 })).toBeCloseTo(6, 5);
  });

  it("returns null outside the clip or on degenerate geometry", () => {
    expect(warpBufferTimeAtTick({ ...base, markers: [], tick: -1 })).toBeNull();
    expect(warpBufferTimeAtTick({ ...base, markers: [], tick: 4 * 1920 + 1 })).toBeNull();
    expect(warpBufferTimeAtTick({ ...base, markers: [], tick: 100, spt: 0 })).toBeNull();
    expect(warpBufferTimeAtTick({ ...base, markers: [], tick: 100, contentDurSec: 0 })).toBeNull();
  });
});

describe("warpSegmentRenders", () => {
  // Two segments tiling a 4-bar clip holding 8 s of content (rate 1 each).
  const segs: WarpSegment[] = [
    { startTick: 0, endTick: 2 * 1920, bufStartSec: 0, bufEndSec: 4, rate: 1 },
    { startTick: 2 * 1920, endTick: 4 * 1920, bufStartSec: 4, bufEndSec: 8, rate: 1 },
  ];
  const opts = { clipTicks: 4 * 1920, clipDurSec: 8, contentStartSec: 0, contentDurSec: 8 };

  it("overlaps interior joints into a 3 ms crossfade without moving boundaries", () => {
    const [a, b] = warpSegmentRenders(segs, opts);
    // Outgoing rings 3 ms past the 4 s joint; incoming started 3 ms early.
    expect(a.playDurSec).toBeCloseTo(4.003, 6);
    expect(b.startOffsetSec).toBeCloseTo(3.997, 6);
    expect(b.bufOffsetSec).toBeCloseTo(3.997, 6);
    expect(a.fadeOutAt).toBeCloseTo(4, 6);
    expect(a.fadeOutDur).toBeCloseTo(0.003, 6);
    expect(b.fadeInAt).toBeCloseTo(3.997, 6);
    expect(b.fadeInDur).toBeCloseTo(0.003, 6);
    // Clip edges fade in/out (de-click) instead of overlapping nothing.
    expect(a.fadeInAt).toBe(0);
    expect(a.fadeInDur).toBeCloseTo(0.003, 6);
    expect(b.fadeOutDur).toBeCloseTo(0.003, 6);
    expect(b.fadeOutAt).toBeCloseTo(7.997, 6);
  });

  it("keeps every ramp ordered and every read inside content", () => {
    const out = warpSegmentRenders(segs, opts);
    for (const r of out) {
      // Fade-out never starts before the fade-in finished.
      expect(r.fadeOutAt).toBeGreaterThanOrEqual(r.fadeInAt + r.fadeInDur - 1e-9);
      expect(r.playDurSec).toBeGreaterThan(0);
      expect(r.bufOffsetSec).toBeGreaterThanOrEqual(0);
      expect(r.bufOffsetSec).toBeLessThanOrEqual(8);
      for (const v of [r.startOffsetSec, r.fadeInAt, r.fadeInDur, r.fadeOutAt, r.fadeOutDur]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("caps edge fades at half a tiny segment (no folded ramps)", () => {
    const tiny: WarpSegment[] = [{ startTick: 0, endTick: 10, bufStartSec: 0, bufEndSec: 0.01, rate: 1 }];
    const [r] = warpSegmentRenders(tiny, { ...opts, clipTicks: 10, clipDurSec: 0.004 });
    expect(r.fadeInDur).toBeLessThanOrEqual(0.002 + 1e-9);
    expect(r.fadeOutDur).toBeLessThanOrEqual(0.002 + 1e-9);
    expect(r.fadeOutAt).toBeGreaterThanOrEqual(r.fadeInAt + r.fadeInDur - 1e-9);
  });

  it("returns [] for empty or degenerate input", () => {
    expect(warpSegmentRenders([], opts)).toEqual([]);
    expect(warpSegmentRenders(segs, { ...opts, clipTicks: 0 })).toEqual([]);
    expect(warpSegmentRenders(segs, { ...opts, clipDurSec: 0 })).toEqual([]);
  });
});
