import { describe, expect, it } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { expandSceneLaneWindow } from "../src/audio-engine/AudioEngine";
import { computeSceneIntensity } from "../src/project-model/intensity";
import { Scheduler } from "../src/scheduler/Scheduler";
import { Transport } from "../src/transport/Transport";
import { BAR_TICKS, PPQ } from "../src/project-model/types";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * Live/export parity at scene seams (package 1+2, part 1).
 *
 * Before: every 25 ms tick re-issued the intensity macro at the window-start
 * value (`setSceneIntensity` → setTargetAtTime(now)), so the live envelope
 * perpetually chased while the export followed exact points — seams smeared
 * by up to a tick and scene-automation interiors collapsed to straight lines.
 * Now the exact point scheduler owns song-mode windows and scene lanes
 * expand their interior points, exactly like the offline renderer.
 */

const B = 4 * BAR_TICKS; // boundary: bar 4 = 7680 ticks
/** Seconds per tick of the fixture doc (whatever its project tempo is). */
function sptOf(doc: ProjectDocument): number {
  return 60 / (doc.bpm * PPQ);
}

function twoSceneSong(): ProjectDocument {
  let doc = createDefaultProject();
  const sceneA = { ...doc.scenes[0], intensity: 0.3 };
  const patternB = doc.patterns[1] ?? doc.patterns[0];
  const sceneB = {
    id: "scene-b",
    name: "Scene B",
    patternId: patternB.id,
    intensity: 0.9,
    intensityCurve: [
      { offset: 0, value: 0.9 },
      { offset: 960, value: 0.5 },
    ],
  };
  const scenes = doc.scenes.map((s) => (s.id === sceneA.id ? sceneA : s));
  doc = {
    ...doc,
    scenes: [...scenes, sceneB],
    arrangement: {
      ...doc.arrangement,
      clips: [
        { id: "c1", sceneId: sceneA.id, startBar: 0, lengthBars: 4 },
        { id: "c2", sceneId: "scene-b", startBar: 4, lengthBars: 4 },
      ],
    },
  };
  return doc;
}

interface IntensityCall {
  points: Array<{ tick: number; value: number }>;
  timeAt: (tick: number) => number;
}

function makeHarness(doc: ProjectDocument, exact: boolean) {
  let audioTime = 10;
  const transport = new Transport({ now: () => audioTime }, doc.bpm);
  const immediate: number[] = [];
  const scheduled: IntensityCall[] = [];
  const scheduler = new Scheduler({
    getProject: () => doc,
    getTransport: () => transport,
    getAudioTime: () => audioTime,
    getMode: () => "song",
    trigger: () => {},
    noteOn: () => {},
    applyAutomation: () => {},
    applyPatternLaunch: () => {},
    applySceneTempo: () => {},
    setSceneIntensity: (value) => immediate.push(value),
    ...(exact
      ? {
          scheduleSceneIntensity: (points: IntensityCall["points"], timeAt: IntensityCall["timeAt"]) =>
            scheduled.push({ points, timeAt }),
        }
      : {}),
  });
  return {
    transport,
    scheduler,
    immediate,
    scheduled,
    advance: (seconds: number) => {
      audioTime += seconds;
      scheduler["tick"]();
    },
  };
}

describe("scene seam parity — exact intensity owns the window", () => {
  it("never issues immediate control-rate writes when the exact path is wired", () => {
    const h = makeHarness(twoSceneSong(), true);
    h.transport.play(0);
    h.scheduler.start();
    while (h.transport.position < B + 1200) h.advance(0.025);
    h.scheduler.stop();
    expect(h.immediate).toHaveLength(0);
    expect(h.scheduled.length).toBeGreaterThan(0);
  });

  it("schedules the boundary tick at its exact value and musical time", () => {
    const doc = twoSceneSong();
    const h = makeHarness(doc, true);
    h.transport.play(0);
    h.scheduler.start();
    while (h.transport.position < B + 1200) h.advance(0.025);
    h.scheduler.stop();
    const sceneB = doc.scenes.find((s) => s.id === "scene-b")!;
    const atBoundary = h.scheduled.filter((call) => call.points.some((p) => p.tick === B));
    expect(atBoundary.length).toBeGreaterThan(0);
    for (const call of atBoundary) {
      // Offline mirror rule: exactly one point per seam tick, next scene wins.
      const seam = call.points.filter((p) => p.tick === B);
      expect(seam).toHaveLength(1);
      expect(seam[0].value).toBeCloseTo(computeSceneIntensity(sceneB, B, B), 9);
      // Same formula the offline buildTempoMap uses: anchor + tick × spt.
      expect(call.timeAt(B)).toBeCloseTo(10 + B * sptOf(doc), 6);
    }
  });

  it("keeps the immediate write as the fallback without the exact path", () => {
    const h = makeHarness(twoSceneSong(), false);
    h.transport.play(0);
    h.scheduler.start();
    while (h.transport.position < B + 1200) h.advance(0.025);
    h.scheduler.stop();
    expect(h.immediate.length).toBeGreaterThan(0);
    expect(h.immediate[0]).toBeCloseTo(0.3, 6);
    // Past the boundary the fallback tracks scene B (static 0.9 easing along
    // its curve) — strictly above scene A's floor.
    const last = h.immediate[h.immediate.length - 1];
    expect(last).toBeGreaterThan(0.4);
    expect(last).toBeLessThanOrEqual(0.9);
  });
});

describe("expandSceneLaneWindow (offline mirror)", () => {
  const lane = {
    points: [
      { tick: 0, value: 0 },
      { tick: 480, value: 1 },
      { tick: 960, value: 0 },
    ],
  };

  it("emits interpolated boundaries plus strictly-interior points, sorted", () => {
    const expanded = expandSceneLaneWindow(lane, 240, 960, 0);
    expect(expanded).toEqual([
      { tick: 240, value: 0.5 },
      { tick: 480, value: 1 },
      { tick: 960, value: 0 },
    ]);
  });

  it("excludes points on the window edges (endpoints already cover them)", () => {
    const expanded = expandSceneLaneWindow(lane, 0, 480, 0);
    expect(expanded).toEqual([
      { tick: 0, value: 0 },
      { tick: 480, value: 1 },
    ]);
  });

  it("offsets scene-relative points by the scene start", () => {
    const expanded = expandSceneLaneWindow(lane, 1000, 2000, 1000);
    expect(expanded).toEqual([
      { tick: 1000, value: 0 },
      { tick: 1480, value: 1 },
      { tick: 1960, value: 0 },
      { tick: 2000, value: 0 },
    ]);
  });
});
