import { describe, expect, it } from "vitest";
import { createDefaultProject, normalizeProject } from "../src/project-model/schema";
import { setSceneBpm } from "../src/commands/commands";
import { buildTempoMap } from "../src/rendering/renderer";
import { Scheduler } from "../src/scheduler/Scheduler";
import { Transport } from "../src/transport/Transport";
import { BAR_TICKS, PPQ } from "../src/project-model/types";
import type { ProjectDocument } from "../src/project-model/types";

function songWithTwoScenes(
  bpmA: number | undefined,
  bpmB: number,
): { doc: ProjectDocument; sceneA: string; sceneB: string } {
  let doc = createDefaultProject();
  const sceneA = doc.scenes[0];
  const patternB = doc.patterns[1] ?? doc.patterns[0];
  const sceneB = { id: "scene-b", name: "Scene B", patternId: patternB.id, intensity: 0.7, bpm: bpmB };
  doc = {
    ...doc,
    scenes: [...doc.scenes, sceneB],
    arrangement: {
      ...doc.arrangement,
      clips: [
        { id: "c1", sceneId: sceneA.id, startBar: 0, lengthBars: 4 },
        { id: "c2", sceneId: "scene-b", startBar: 4, lengthBars: 4 },
      ],
    },
  };
  if (bpmA !== undefined) {
    doc = setSceneBpm(doc, sceneA.id, bpmA).execute(doc);
  }
  return { doc, sceneA: sceneA.id, sceneB: "scene-b" };
}

describe("setSceneBpm", () => {
  it("pins and clears a scene tempo", () => {
    let doc = createDefaultProject();
    const id = doc.scenes[0].id;
    doc = setSceneBpm(doc, id, 140).execute(doc);
    expect(doc.scenes[0].bpm).toBe(140);
    doc = setSceneBpm(doc, id, null).execute(doc);
    expect(doc.scenes[0].bpm).toBeUndefined();
  });

  it("rejects out-of-range tempos", () => {
    const doc = createDefaultProject();
    expect(() => setSceneBpm(doc, doc.scenes[0].id, 10)).toThrow(/out of range/u);
    expect(() => setSceneBpm(doc, doc.scenes[0].id, Number.NaN)).toThrow(/out of range/u);
  });

  it("survives normalization (clamped, not dropped)", () => {
    let doc = createDefaultProject();
    doc = setSceneBpm(doc, doc.scenes[0].id, 150.6).execute(doc);
    const normalized = normalizeProject(doc);
    expect(normalized.scenes[0].bpm).toBe(151);
  });
});

describe("buildTempoMap", () => {
  it("integrates per-window BPM and keeps project tempo in gaps", () => {
    const { doc } = songWithTwoScenes(120, 60); // 4 bars at 120, then 4 bars at 60
    const windows = [
      { from: 0, to: 4 * BAR_TICKS, bpm: 120 },
      { from: 4 * BAR_TICKS, to: 8 * BAR_TICKS, bpm: 60 },
    ];
    const map = buildTempoMap(doc, windows as never);
    // 4 bars at 120 BPM = 8 s; 4 bars at 60 BPM = 16 s → total 24 s.
    expect(map.totalSeconds).toBeCloseTo(24, 3);
    expect(map.timeAt(0)).toBeCloseTo(0, 4);
    expect(map.timeAt(4 * BAR_TICKS)).toBeCloseTo(8, 3); // boundary
    expect(map.timeAt(8 * BAR_TICKS)).toBeCloseTo(24, 3); // end of second window
  });

  it("uses project tempo for the gap before the first window", () => {
    const { doc } = songWithTwoScenes(undefined, 120);
    const map = buildTempoMap(doc, [{ from: 4 * BAR_TICKS, to: 8 * BAR_TICKS, bpm: 120 } as never]);
    // Gap [0, 4 bars) runs at the PROJECT tempo (124): 7.742 s + window 8 s.
    const gapSec = 4 * BAR_TICKS * (60 / (124 * PPQ));
    expect(map.totalSeconds).toBeCloseTo(gapSec + 8, 3);
    expect(map.timeAt(2 * BAR_TICKS)).toBeCloseTo(2 * BAR_TICKS * (60 / (124 * PPQ)), 3);
  });

  it("a single window at project BPM matches the old linear mapping", () => {
    const { doc } = songWithTwoScenes(undefined, 124);
    const map = buildTempoMap(doc, [{ from: 0, to: 4 * BAR_TICKS, bpm: 124 } as never]);
    const spt = 60 / (124 * PPQ);
    expect(map.totalSeconds).toBeCloseTo(4 * BAR_TICKS * spt, 4);
    expect(map.timeAt(2 * BAR_TICKS)).toBeCloseTo(2 * BAR_TICKS * spt, 4);
  });

  it("continues after the last scene from that window's end time", () => {
    const { doc } = songWithTwoScenes(undefined, 60);
    const map = buildTempoMap(doc, [{ from: 0, to: 4 * BAR_TICKS, bpm: 60 } as never]);
    const sceneSeconds = 4 * BAR_TICKS * (60 / (60 * PPQ));
    const projectGapSeconds = 2 * BAR_TICKS * (60 / (doc.bpm * PPQ));

    expect(map.timeAt(6 * BAR_TICKS)).toBeCloseTo(sceneSeconds + projectGapSeconds, 4);
  });

  it("uses project tempo inside gaps between scene windows", () => {
    const { doc } = songWithTwoScenes(120, 60);
    const map = buildTempoMap(doc, [
      { from: 0, to: 2 * BAR_TICKS, bpm: 120 },
      { from: 4 * BAR_TICKS, to: 6 * BAR_TICKS, bpm: 60 },
    ] as never);
    const firstSceneSeconds = 2 * BAR_TICKS * (60 / (120 * PPQ));
    const projectGapSeconds = BAR_TICKS * (60 / (doc.bpm * PPQ));

    expect(map.timeAt(3 * BAR_TICKS)).toBeCloseTo(firstSceneSeconds + projectGapSeconds, 4);
  });
});

describe("Scheduler — scene tempo lane", () => {
  it("applies the scene BPM while inside its clip and clears outside", () => {
    const { doc } = songWithTwoScenes(140, 60);
    const applied: (number | null)[] = [];
    let audioTime = 10;
    const transport = new Transport({ now: () => audioTime }, doc.bpm);
    const scheduler = new Scheduler({
      getProject: () => doc,
      getTransport: () => transport,
      getAudioTime: () => audioTime,
      getMode: () => "song",
      trigger: () => {},
      noteOn: () => {},
      applyAutomation: () => {},
      applyPatternLaunch: () => {},
      applySceneTempo: (bpm) => applied.push(bpm),
    });
    transport.play(0);
    // Tick inside clip 1 (scene A @ 140 BPM).
    scheduler.start();
    scheduler.stop();
    // Tick past clip 1 into a gap (no scene → null).
    audioTime += 10;
    transport.seek(0);
    transport.play(0);
    scheduler.start();
    scheduler.stop();
    const sceneBpmCalls = applied.filter((v) => v === 140);
    expect(sceneBpmCalls.length).toBeGreaterThanOrEqual(1);
    expect(applied[applied.length - 1]).toBeNull();
  });
});
