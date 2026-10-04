/**
 * kyx_mix_idea preview — the auto-rendered before/after A/B
 * (src/mcp/mix-preview.ts).
 *
 * Contract: the preview never mutates the project (the plan folds over a
 * local doc), the lane carries documents plus a level-match gain — not
 * buffers — and the registry is honest session state (listeners learn about
 * arms AND clears; a dead listener can never break the arm).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { planMixIdea } from "../src/mcp/mix-idea";
import {
  armMixPreviewLane,
  buildMixPreview,
  clearMixPreviewLane,
  currentMixPreviewLane,
  hasMixPreviewListener,
  onMixPreviewLane,
  previewMatchGainDb,
  type MixPreviewLane,
} from "../src/mcp/mix-preview";
import type { ProjectDocument } from "../src/project-model/types";

function fakeRender(doc: ProjectDocument) {
  // Duration encodes WHICH doc rendered: the after doc gains an effect, so
  // the fake returns a slightly longer buffer for it — the builder must be
  // handed both sides exactly once.
  const extra = doc.tracks.some((t) => t.kind === "drum" && t.effects.length > 0) ? 0.5 : 1;
  const length = Math.floor(44100 * extra);
  return Promise.resolve({
    numberOfChannels: 2,
    getChannelData: (channel: number) => new Float32Array(length).fill(channel === 0 ? 0.01 : 0),
    sampleRate: 44100,
    duration: extra,
  });
}

afterEach(() => {
  clearMixPreviewLane();
  vi.restoreAllMocks();
});

describe("mix preview — level-match gain", () => {
  it("pulls the after side down when it is louder and caps at ±12 dB", () => {
    expect(previewMatchGainDb(-14, -11)).toBeCloseTo(-3, 6);
    expect(previewMatchGainDb(-11, -14)).toBeCloseTo(3, 6);
    expect(previewMatchGainDb(-14, -40)).toBe(12); // quieter after side gets boosted, capped
    expect(previewMatchGainDb(-40, -14)).toBe(-12);
  });

  it("stays neutral when either measurement is missing", () => {
    expect(previewMatchGainDb(null, -14)).toBe(0);
    expect(previewMatchGainDb(-14, null)).toBe(0);
    expect(previewMatchGainDb(Number.NaN, -14)).toBe(0);
  });
});

describe("mix preview — lane registry", () => {
  it("notifies listeners on arm and clear, and survives a throwing listener", () => {
    const seen: Array<MixPreviewLane | null> = [];
    const bomb = vi.fn(() => {
      throw new Error("dead listener");
    });
    const stopBomb = onMixPreviewLane(bomb);
    const unsubscribe = onMixPreviewLane((lane) => seen.push(lane));

    expect(hasMixPreviewListener()).toBe(true);
    const lane = { id: "l1" } as unknown as MixPreviewLane;
    expect(() => armMixPreviewLane(lane)).not.toThrow();
    expect(currentMixPreviewLane()?.id).toBe("l1");
    expect(seen).toEqual([null, lane]); // immediate replay + the arm

    clearMixPreviewLane();
    expect(seen[seen.length - 1]).toBeNull();
    stopBomb();
    unsubscribe();
    expect(hasMixPreviewListener()).toBe(false);
  });
});

describe("mix preview — buildMixPreview", () => {
  it("renders both sides, measures and freezes the before doc without mutating the project", async () => {
    const project = createProjectFromTemplate("house");
    const snapshot = JSON.stringify(project);
    const plan = planMixIdea(project, "warmer and glue the drums");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const lane = await buildMixPreview(project, plan, fakeRender);
    expect(JSON.stringify(project)).toBe(snapshot);

    expect(lane.label).toBe(plan.label);
    expect(lane.targets).toEqual(plan.targets);
    expect(lane.goals).toEqual(plan.goals);
    expect(lane.interpreter).toBe(plan.interpreter);
    // The before doc is a frozen COPY, not the live object.
    expect(lane.beforeDoc).not.toBe(project);
    // The after doc really carries the planned chain: its drum track gained effects.
    const drumBefore = lane.beforeDoc.tracks.find((t) => t.kind === "drum")!;
    const drumAfter = lane.afterDoc.tracks.find((t) => t.kind === "drum")!;
    expect(drumAfter.effects.length).toBeGreaterThan(drumBefore.effects.length);
    // Both sides were measured (silent noise floor still yields numbers or null)…
    expect(typeof lane.stats.matchGainDb).toBe("number");
    expect(lane.stats.seconds).toBeGreaterThan(0);
    // …and the stored command still applies the idea later.
    const applied = lane.command.execute(project);
    const drumApplied = applied.tracks.find((t) => t.kind === "drum")!;
    expect(drumApplied.effects.length).toBe(drumAfter.effects.length);
  });
});
