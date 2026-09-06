import { describe, expect, it, vi } from "vitest";
import { scheduleSceneAutomation } from "../../src/rendering/renderer";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { ProjectDocument, SceneAutomation } from "../../src/project-model/types";
import type { AudioEngine } from "../../src/audio-engine/AudioEngine";

/**
 * Export parity (release roadmap 1.2): scene automation lanes must render
 * offline. These tests pin the point-expansion contract of
 * `scheduleSceneAutomation` — absolute ticks, boundary interpolation,
 * scene matching and target routing — without needing an OfflineAudioContext.
 */

function docWithSceneAutomation(lane: SceneAutomation): ProjectDocument {
  const doc = createProjectFromTemplate("scene-score") as ProjectDocument;
  return { ...doc, sceneAutomation: [lane] };
}

/** ClipWindow factory mirroring renderer's collectClipWindows output. */
function windowOf(sceneId: string, base: number, from: number, to: number, stepCount = 16) {
  const doc = createProjectFromTemplate("scene-score");
  const pattern = doc.patterns[0];
  return {
    pattern: { ...pattern, stepCount },
    base,
    from,
    to,
    bpm: 124,
    sceneId,
  };
}

function makeEngine() {
  return {
    scheduleTrackAutomation: vi.fn(),
    scheduleDeviceAutomation: vi.fn(),
  } as unknown as AudioEngine;
}

const LINEAR_LANE: SceneAutomation = {
  id: "lane-1",
  sceneId: "scene-A",
  target: { kind: "trackGain", trackId: "track-1" },
  points: [
    { tick: 0, value: 0.2 },
    { tick: 1920, value: 1.0 },
  ],
};

describe("scheduleSceneAutomation — offline expansion (export parity)", () => {
  const timeAt = (tick: number) => tick / 192;

  it("expands boundary values interpolated from the lane onto the owning window", () => {
    const engine = makeEngine();
    const doc = docWithSceneAutomation(LINEAR_LANE);
    // One bar window starting at the scene start: v(0)=0.2, v(1920)=1.0.
    scheduleSceneAutomation(doc, [windowOf("scene-A", 0, 0, 1920)], timeAt, engine);
    const calls = (engine.scheduleTrackAutomation as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const [, param, points] = calls[0] as [string, string, { tick: number; value: number }[]];
    expect(param).toBe("gain");
    expect(points.map((p) => [p.tick, Number(p.value.toFixed(3))])).toEqual([
      [0, 0.2],
      [1920, 1],
    ]);
  });

  it("interpolates a mid-window boundary value (clip shorter than the lane)", () => {
    const engine = makeEngine();
    const doc = docWithSceneAutomation(LINEAR_LANE);
    // Window covering only the first half of the lane: end value = 0.6.
    scheduleSceneAutomation(doc, [windowOf("scene-A", 0, 0, 960)], timeAt, engine);
    const points = (engine.scheduleTrackAutomation as ReturnType<typeof vi.fn>).mock.calls[0][2] as {
      tick: number;
      value: number;
    }[];
    expect(points[1].tick).toBe(960);
    expect(points[1].value).toBeCloseTo(0.6, 6);
  });

  it("skips windows of other scenes and pattern-mode fallback windows", () => {
    const engine = makeEngine();
    const doc = docWithSceneAutomation(LINEAR_LANE);
    scheduleSceneAutomation(
      doc,
      [windowOf("scene-B", 0, 0, 1920), windowOf("scene-A", 3840, 3840, 5760)],
      timeAt,
      engine,
    );
    // Only the scene-A window schedules; pattern fallback (no sceneId) too.
    const calls = (engine.scheduleTrackAutomation as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const points = calls[0][2] as { tick: number }[];
    expect(points.every((p) => p.tick >= 3840 && p.tick <= 5760)).toBe(true);
  });

  it("includes interior lane points and routes fxParam targets", () => {
    const engine = makeEngine();
    const lane: SceneAutomation = {
      id: "lane-2",
      sceneId: "scene-A",
      target: { kind: "fxParam", trackId: "track-1", fxId: "fx-1", paramId: "decay" },
      points: [
        { tick: 0, value: 0.1 },
        { tick: 960, value: 0.9 },
        { tick: 3840, value: 0.5 },
      ],
    };
    const doc = docWithSceneAutomation(lane);
    scheduleSceneAutomation(doc, [windowOf("scene-A", 0, 0, 1920)], timeAt, engine);
    const calls = (engine.scheduleDeviceAutomation as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const [, kind, fxId, paramId, points] = calls[0] as [
      string,
      string,
      string | undefined,
      string | undefined,
      { tick: number }[],
    ];
    expect(kind).toBe("fx");
    expect(fxId).toBe("fx-1");
    expect(paramId).toBe("decay");
    // Interior point at 960 lands between the two boundary points, sorted.
    expect(points.map((p) => p.tick)).toEqual([0, 960, 1920]);
  });

  it("restarts the lane per clip occurrence (live sceneStartTick semantics)", () => {
    // Live passes the OWNING CLIP's start as sceneStartTick, so every clip
    // using the scene re-runs the lane from its beginning — offline must
    // match that, not chain continuously.
    const engine = makeEngine();
    const doc = docWithSceneAutomation(LINEAR_LANE);
    scheduleSceneAutomation(
      doc,
      [windowOf("scene-A", 0, 0, 1920), windowOf("scene-A", 1920, 1920, 3840)],
      timeAt,
      engine,
    );
    const calls = (engine.scheduleTrackAutomation as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    const first = calls[0][2] as { tick: number; value: number }[];
    const second = calls[1][2] as { tick: number; value: number }[];
    // Clip 1: 0→0.2 … 1920→1.0 (absolute ticks).
    expect(first.map((p) => [p.tick, Number(p.value.toFixed(3))])).toEqual([
      [0, 0.2],
      [1920, 1],
    ]);
    // Clip 2 restarts the lane at its own start: 1920→0.2 … 3840→1.0.
    expect(second.map((p) => [p.tick, Number(p.value.toFixed(3))])).toEqual([
      [1920, 0.2],
      [3840, 1],
    ]);
  });
});
