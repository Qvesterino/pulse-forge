import { describe, expect, it } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { audioLaneOf, audioSpanBars, sceneSpanTicks, withAudioLane } from "../src/project-model/timeline";
import { duplicateTimeRange } from "../src/commands/timeRange";
import type { AudioClip, ArrangementClip, ProjectDocument } from "../src/project-model/types";

/**
 * ADR 0025 decision #5 — the timeline-span/lane write seams. The time-range
 * operations previously repeated the `startBar * barUnit` geometry 13 times
 * and hand-rolled the audio-lane read (`?? []`) + write (`!== undefined`)
 * dance — omitting the write-guard once produced audit-01's silent
 * audioClips loss. These pins hold the seams and the lane-absence contract.
 */

function docWithoutAudioLane(doc: ProjectDocument): ProjectDocument {
  const { audioClips: _omitted, ...rest } = doc.arrangement;
  return { ...doc, arrangement: rest };
}

const sceneClip = (id: string, startBar: number, lengthBars: number): ArrangementClip => ({
  id,
  sceneId: "scene-1",
  startBar,
  lengthBars,
});

const audioClip = (id: string, startBar: number, lengthBars: number): AudioClip =>
  ({
    id,
    trackId: "t1",
    bufferId: "buf-1",
    startBar,
    lengthBars,
    offset: 0,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
    offsetSec: 0,
    trimStart: 0,
    trimEnd: 0,
    stretchRate: 1,
    reverse: false,
  }) as AudioClip;

describe("sceneSpanTicks / audioSpanBars (ADR 0056 meter math)", () => {
  it("4/4: barUnit 1920 — a 2-bar scene clip spans [start, start + 2·1920)", () => {
    const doc = createDefaultProject();
    expect(sceneSpanTicks(sceneClip("s", 4, 2), 1920)).toEqual({ from: 7680, to: 11520 });
    void doc;
  });

  it("6/8: barUnit follows the meter (ADR 0056) — one home for the multiplication", () => {
    // 6/8: 3 quarter notes per bar → 3 × 480 = 1440 ticks per bar.
    expect(sceneSpanTicks(sceneClip("s", 2, 1), 1440)).toEqual({ from: 2880, to: 4320 });
  });

  it("audioSpanBars is float-true (sub-bar geometry is the audio lane's nature)", () => {
    expect(audioSpanBars(audioClip("a", 1.5, 2.25))).toEqual({ fromBar: 1.5, toBar: 3.75 });
  });
});

describe("withAudioLane (the audit-01 silent-loss guard)", () => {
  it("preserves field ABSENCE: a lane-less doc never gains the field", () => {
    const doc = docWithoutAudioLane(createDefaultProject());
    expect(doc.arrangement.audioClips).toBeUndefined();
    const next = withAudioLane(doc, [audioClip("a", 0, 1)]);
    expect(next.arrangement.audioClips).toBeUndefined();
  });

  it("writes when the lane exists (even an explicitly empty one)", () => {
    const doc = createDefaultProject();
    const withLane = { ...doc, arrangement: { ...doc.arrangement, audioClips: [] } };
    const next = withAudioLane(withLane, [audioClip("a", 0, 1)]);
    expect(audioLaneOf(next.arrangement)).toHaveLength(1);
  });
});

describe("duplicateTimeRange on a lane-less document (the audit-01 regression class)", () => {
  it("duplicates scene material WITHOUT inventing the audio lane", () => {
    const doc = docWithoutAudioLane(createDefaultProject());
    const withScene = { ...doc, arrangement: { ...doc.arrangement, clips: [sceneClip("s1", 0, 2)] } };
    const next = duplicateTimeRange(withScene, 0, 3840).execute(withScene);
    // Scene material duplicated; trailing shift applied.
    expect(next.arrangement.clips.filter((c) => c.startBar === 0)).toHaveLength(1);
    expect(next.arrangement.clips.some((c) => c.startBar === 2 && c.lengthBars === 2)).toBe(true);
    // THE pin: the lane stays absent — no empty-lane invention.
    expect(next.arrangement.audioClips).toBeUndefined();
  });

  it("a lane-ful document still duplicates its audio clips (unchanged behavior)", () => {
    const doc = createDefaultProject();
    const withBoth = {
      ...doc,
      arrangement: {
        ...doc.arrangement,
        clips: [sceneClip("s1", 0, 2)],
        audioClips: [audioClip("a1", 0.5, 1)],
      } as ProjectDocument["arrangement"],
    };
    const next = duplicateTimeRange(withBoth, 0, 3840).execute(withBoth);
    const lane = audioLaneOf(next.arrangement);
    // Source at 0.5..1.5 is wholly inside [0,2): source + copy both present.
    expect(lane.filter((c) => c.id === "a1")).toHaveLength(1);
    expect(lane.some((c) => c.id !== "a1" && Math.abs(c.startBar - 2.5) < 1e-9)).toBe(true);
  });
});
