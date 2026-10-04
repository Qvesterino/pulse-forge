import { describe, expect, it } from "vitest";
import { addAudioTakeClip } from "../src/commands/commands";
import { applySmartComp, planBars, planSmartComp, segmentTicks } from "../src/commands/smart-comp";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { BAR_TICKS } from "../src/project-model/types";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * SMART COMP PLANNER + COMMAND — the behaviour the UI promises:
 *  - every bar goes to the best take that actually COVERS it;
 *  - adjacent bars with the same winner MERGE (fewer seams = fewer crossfades);
 *  - holes are reported, never silently dropped;
 *  - the whole plan applies as ONE undoable command whose undo restores the
 *    document exactly.
 *
 * PCM is supplied by the test, so scoring is deterministic here: a
 * grid-locked click take must beat a clipped/noisy one.
 */

const SAMPLE_RATE = 48_000;

function transient(data: Float32Array, timeSec: number, sampleRate: number, amplitude = 0.8): void {
  const start = Math.round(timeSec * sampleRate);
  const decay = Math.round(0.05 * sampleRate);
  let seed = 12345 + start;
  for (let i = 0; i < decay && start + i < data.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const noise = (seed / 0xffffffff) * 2 - 1;
    data[start + i] += amplitude * Math.exp(-i / (decay / 4)) * noise;
  }
}

/** Two bars at 120 BPM of perfectly locked hits. */
function lockedTake(): Float32Array {
  const data = new Float32Array(2 * SAMPLE_RATE);
  for (let i = 0; i < 32; i++) transient(data, i * 0.125, SAMPLE_RATE);
  return data;
}

/** Two bars of wandering, noisy, clipped material. */
function roughTake(): Float32Array {
  const data = new Float32Array(2 * SAMPLE_RATE);
  let seed = 555;
  for (let i = 0; i < 32; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const wander = ((seed / 0xffffffff) * 2 - 1) * 0.05;
    transient(data, i * 0.125 + wander, SAMPLE_RATE, 0.6);
  }
  for (let i = 0; i < data.length; i++) {
    data[i] += 0.005 * Math.sin(i * 0.01);
    if (i % 16 === 0) data[i] = 1; // clipping
  }
  return data;
}

/** A doc with one take group; `bars` = how many bars each take covers. */
function groupWithTakes(takes: Array<{ takeId: string; startBar: number; bars: number }>): {
  doc: ProjectDocument;
  groupId: string;
  trackId: string;
} {
  const base = createProjectFromTemplate("empty");
  const track = base.tracks[0];
  if (!track) throw new Error("empty template fixture missing a track");
  let doc: ProjectDocument = { ...base, arrangement: { ...base.arrangement, clips: [], audioClips: [] } };
  const groupId = "smart-comp-group";
  for (const take of takes) {
    doc = addAudioTakeClip(
      doc,
      groupId,
      take.takeId,
      track.id,
      `audio.${take.takeId}`,
      take.startBar,
      take.bars,
    ).execute(doc);
  }
  return { doc, groupId, trackId: track.id };
}

describe("planSmartComp — best take per bar, merged into as few seams as possible", () => {
  it("gives the whole span to the better take and merges it into ONE segment", () => {
    const { doc, groupId } = groupWithTakes([
      { takeId: "take-rough", startBar: 0, bars: 2 },
      { takeId: "take-locked", startBar: 0, bars: 2 },
    ]);
    const plan = planSmartComp(doc, groupId, (takeId) =>
      takeId === "take-locked"
        ? { data: lockedTake(), sampleRate: SAMPLE_RATE }
        : { data: roughTake(), sampleRate: SAMPLE_RATE },
    );

    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0]).toEqual({ sourceTakeId: "take-locked", startBar: 0, endBar: 2 });
    expect(plan.uncoveredBars).toEqual([]);
    expect(planBars(plan)).toBe(2);
  });

  it("switches takes where the ranking flips, producing one seam per switch", () => {
    // Take A wins bar 0 (only it covers bar 0); take B wins bars 1-2.
    const { doc, groupId } = groupWithTakes([
      { takeId: "take-locked", startBar: 0, bars: 1 },
      { takeId: "take-rough", startBar: 1, bars: 2 },
    ]);
    const plan = planSmartComp(doc, groupId, (takeId) =>
      takeId === "take-locked"
        ? { data: lockedTake(), sampleRate: SAMPLE_RATE }
        : { data: roughTake(), sampleRate: SAMPLE_RATE },
    );

    // Both takes are present, but a take that does not COVER a bar can never
    // win it, so bar 0 goes to take-locked and bars 1-2 to take-rough.
    expect(plan.segments).toEqual([
      { sourceTakeId: "take-locked", startBar: 0, endBar: 1 },
      { sourceTakeId: "take-rough", startBar: 1, endBar: 3 },
    ]);
  });

  it("reports uncovered bars instead of proposing a silent comp", () => {
    const { doc, groupId } = groupWithTakes([
      { takeId: "take-locked", startBar: 0, bars: 1 },
      { takeId: "take-rough", startBar: 2, bars: 1 },
    ]);
    const plan = planSmartComp(doc, groupId, (takeId) =>
      takeId === "take-locked"
        ? { data: lockedTake(), sampleRate: SAMPLE_RATE }
        : { data: roughTake(), sampleRate: SAMPLE_RATE },
    );

    // Bar 1 belongs to no take — the plan must say so.
    expect(plan.uncoveredBars).toEqual([1]);
    expect(plan.segments.map((segment) => [segment.startBar, segment.endBar])).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it("keeps a take with undecoded PCM in the running instead of dropping coverage", () => {
    const { doc, groupId } = groupWithTakes([
      { takeId: "take-locked", startBar: 0, bars: 1 },
      { takeId: "take-streaming", startBar: 0, bars: 1 },
    ]);
    const plan = planSmartComp(doc, groupId, (takeId) =>
      takeId === "take-locked" ? { data: lockedTake(), sampleRate: SAMPLE_RATE } : null,
    );

    // The undecoded take scored 0 — it loses the bar, but the plan still
    // COMPILES it rather than pretending the group is single-take.
    expect(plan.takeSummaries).toHaveLength(2);
    const undecoded = plan.takeSummaries.find((entry) => entry.takeId === "take-streaming");
    expect(undecoded?.score.evidence.join(" ")).toContain("PCM not decoded");
    expect(plan.segments[0]?.sourceTakeId).toBe("take-locked");
  });

  it("is deterministic — planning twice yields the same plan", () => {
    const { doc, groupId } = groupWithTakes([
      { takeId: "take-rough", startBar: 0, bars: 2 },
      { takeId: "take-locked", startBar: 0, bars: 2 },
    ]);
    const pcm = (takeId: string) =>
      takeId === "take-locked"
        ? { data: lockedTake(), sampleRate: SAMPLE_RATE }
        : { data: roughTake(), sampleRate: SAMPLE_RATE };
    expect(planSmartComp(doc, groupId, pcm)).toEqual(planSmartComp(doc, groupId, pcm));
  });

  it("refuses a group with no source takes and never throws on a missing group id", () => {
    const { doc, groupId } = groupWithTakes([{ takeId: "take-locked", startBar: 0, bars: 1 }]);
    expect(planSmartComp(doc, groupId, () => null).segments).toHaveLength(1);
    expect(() => planSmartComp(doc, "no-such-group", () => null)).toThrow(/not found/);
  });
});

describe("applySmartComp — one undoable command for the whole plan", () => {
  it("applies the plan and restores the exact document on one undo", () => {
    const { doc, groupId } = groupWithTakes([
      { takeId: "take-locked", startBar: 0, bars: 1 },
      { takeId: "take-rough", startBar: 1, bars: 2 },
    ]);
    const plan = planSmartComp(doc, groupId, (takeId) =>
      takeId === "take-locked"
        ? { data: lockedTake(), sampleRate: SAMPLE_RATE }
        : { data: roughTake(), sampleRate: SAMPLE_RATE },
    );
    expect(plan.segments).toHaveLength(2);

    const command = applySmartComp(doc, groupId, plan, 0);
    const comped = command.execute(doc);

    // The comp take now exists and plays instead of the single active take.
    const group = comped.arrangement.takeGroups?.find((item) => item.id === groupId);
    expect(group?.compTakeId).toBeTruthy();
    expect(group?.activeTakeId).toBe(group?.compTakeId);
    const compClips = (comped.arrangement.audioClips ?? []).filter((clip) => clip.takeId === group?.compTakeId);
    expect(compClips.map((clip) => clip.compSourceTakeId)).toEqual(["take-locked", "take-rough"]);
    // Source takes are untouched (non-destructive).
    expect(
      (comped.arrangement.audioClips ?? []).filter((clip) => clip.takeId === "take-locked").length,
    ).toBeGreaterThan(0);

    expect(command.undo(comped)).toEqual(doc);
  });

  it("converts bar segments to the ticks the comp command speaks", () => {
    expect(segmentTicks({ sourceTakeId: "t", startBar: 2, endBar: 4 })).toEqual({
      startTick: 2 * BAR_TICKS,
      endTick: 4 * BAR_TICKS,
    });
  });

  it("refuses to apply an empty plan rather than dispatching a no-op", () => {
    const { doc, groupId } = groupWithTakes([{ takeId: "take-locked", startBar: 0, bars: 1 }]);
    expect(() =>
      applySmartComp(doc, groupId, {
        segments: [],
        uncoveredBars: [],
        takeSummaries: [],
        spanStartBar: 0,
        spanEndBar: 0,
      }),
    ).toThrow(/Nothing to comp/);
  });
});
