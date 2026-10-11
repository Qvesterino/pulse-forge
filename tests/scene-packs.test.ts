import { describe, expect, it, vi } from "vitest";
import { testDoc } from "./fixtures/doc";
import { defaultParamsOf } from "../src/effects/registry";
import { normalizeProject } from "../src/project-model/schema";
import { setScenePack } from "../src/commands/scenes";
import { AutomationBridge } from "../src/audio-engine/automationBridge";
import { DeviceLookup } from "../src/audio-engine/deviceLookup";
import type { TrackOrGroupView } from "../src/audio-engine/deviceLookup";
import { TWIST_SCENE_PACK } from "../src/effects/skrutka-scene-pack";
import { KOREN_SCENE_PACK } from "../src/effects/koren-scene-pack";
import { Scheduler } from "../src/scheduler/Scheduler";
import { Transport } from "../src/transport/Transport";
import { BAR_TICKS } from "../src/project-model/types";
import type { EffectInstance, ProjectDocument } from "../src/project-model/types";

/**
 * Per-scene scene packs (v2.6): a scene carries which pack pair a TWIST/GROW
 * device plays (Scene.packs), the scheduler hands that selection to the
 * engine as scene-intensity points, and the bridge applies it as a live-only
 * override — the doc keeps its applied pair as the stopped-state baseline.
 *
 * Pinned here: the command + its undo, the sanitizer, the scheduler attaching
 * the active scene's packs to the seam points, and the bridge writing the
 * exact pair law (GROW midpoint ± half-span, TWIST slot swap + morph =
 * intensity) while guarding armed doc mappings, restoring on exit, and
 * handing back to the doc on stop.
 */

function param(initial = 0) {
  let value = initial;
  return {
    get value() {
      return value;
    },
    set value(v: number) {
      value = v;
    },
    setTargetAtTime(v: number) {
      value = v;
    },
    setValueAtTime(v: number) {
      value = v;
    },
    linearRampToValueAtTime(v: number) {
      value = v;
    },
  };
}

interface RecordedWrite {
  id: string;
  value: number;
  when: number | null;
}

function fxRuntime(record: RecordedWrite[]) {
  return {
    setParameter: (id: string, value: number) => record.push({ id, value, when: null }),
    setParameterAt: (id: string, value: number, when: number) => record.push({ id, value, when }),
    dispose: () => {},
  };
}

function docWithSceneFx(): { doc: ProjectDocument; trackId: string; twistId: string; growId: string } {
  const doc = testDoc();
  const drum = doc.tracks.find((candidate) => candidate.kind === "drum")!;
  const twist: EffectInstance = {
    id: "sc-fx-twist",
    type: "skrutka",
    bypassed: false,
    params: defaultParamsOf("skrutka"),
  };
  const grow: EffectInstance = {
    id: "sc-fx-grow",
    type: "bassHarmonic",
    bypassed: false,
    params: defaultParamsOf("bassHarmonic"),
  };
  drum.effects = [twist, grow];
  return { doc, trackId: drum.id, twistId: twist.id, growId: grow.id };
}

function bridgeHarness(doc: ProjectDocument) {
  const track = doc.tracks.find((candidate) => candidate.kind === "drum")!;
  const writes: RecordedWrite[] = [];
  const twistWrites: RecordedWrite[] = [];
  const runtimes = new Map<string, unknown>();
  const twistRuntime = {
    ...fxRuntime(twistWrites),
    setCurves: vi.fn(),
  };
  runtimes.set("sc-fx-twist", twistRuntime);
  runtimes.set("sc-fx-grow", fxRuntime(writes));
  const view = {
    fx: { runtimes },
    modAutoGain: { gain: param(1) },
    modAutoPan: { pan: param(0) },
    modMacroGain: { gain: param(1) },
    modMacroPan: { pan: param(0) },
    input: {} as AudioNode,
  };
  const trackMap = new Map([[track.id, view]]);
  const lookup = new DeviceLookup({
    doc: () => doc,
    trackNodes: (id: string) => trackMap.get(id) as unknown as TrackOrGroupView,
    groupNodes: () => undefined,
    returnNodes: () => undefined,
    instrumentStates: () => new Map(),
  } as never);
  const ctx = { currentTime: 0 };
  const bridge = new AutomationBridge(
    {
      ctx: () => ctx as unknown as BaseAudioContext,
      doc: () => doc,
      currentTime: () => 0,
      trackNodes: trackMap as never,
      groupNodes: new Map(),
      returnNodes: new Map(),
    },
    lookup,
  );
  return { bridge, writes, twistWrites, twistRuntime, track };
}

describe("per-scene packs — model + command", () => {
  it("sets and clears a scene's pack selection with one undo step", () => {
    const { doc, twistId } = docWithSceneFx();
    const scene = doc.scenes[0]!;
    const command = setScenePack(doc, scene.id, twistId, "trap-center-shimmer");
    const after = command.execute(doc);
    expect(after.scenes[0]!.packs).toEqual({ [twistId]: "trap-center-shimmer" });
    const back = command.undo(after);
    expect(back.scenes[0]!.packs).toBeUndefined();

    const second = setScenePack(after, scene.id, twistId, null);
    const cleared = second.execute(after);
    expect(cleared.scenes[0]!.packs).toBeUndefined();
  });

  it("refuses unknown scenes, non-pack effects and malformed ids", () => {
    const { doc, twistId } = docWithSceneFx();
    expect(() => setScenePack(doc, "nope", twistId, "trap-center-shimmer")).toThrow(/not found/);
    const eqDoc = {
      ...doc,
      tracks: doc.tracks.map((t) => ({
        ...t,
        effects: t.effects?.map((fx) => (fx.id === twistId ? { ...fx, type: "eq" as const } : fx)),
      })),
    };
    expect(() => setScenePack(eqDoc as ProjectDocument, doc.scenes[0]!.id, twistId, "trap-center-shimmer")).toThrow(
      /not a scene-pack effect/,
    );
    expect(() => setScenePack(doc, doc.scenes[0]!.id, twistId, "x".repeat(65))).toThrow(/Invalid scene pair id/);
  });

  it("sanitizes scene.packs through normalizeProject", () => {
    const { doc } = docWithSceneFx();
    const dirty = JSON.parse(JSON.stringify(doc)) as ProjectDocument;
    (dirty.scenes[0] as unknown as { packs: unknown }).packs = {
      "fx-a": "pair-ok",
      bad: 3,
      long: "y".repeat(80),
      "": "empty-key",
    };
    const normalized = normalizeProject(dirty);
    expect(normalized.scenes[0]!.packs).toEqual({ "fx-a": "pair-ok" });
    const hostile = JSON.parse(JSON.stringify(doc)) as ProjectDocument;
    (hostile.scenes[0] as unknown as { packs: unknown }).packs = ["nope"];
    expect(normalizeProject(hostile).scenes[0]!.packs).toBeUndefined();
  });
});

describe("per-scene packs — scheduler hands the scene selection to the engine", () => {
  function songWithPacks(): ProjectDocument {
    const { doc, growId } = docWithSceneFx();
    const sceneA = { ...doc.scenes[0]!, intensity: 0.3 };
    const patternB = doc.patterns[1] ?? doc.patterns[0]!;
    const sceneB = {
      id: "scene-pack-b",
      name: "Scene B",
      patternId: patternB.id,
      intensity: 0.9,
      packs: { [growId]: "drill-phone-growl" },
    };
    return {
      ...doc,
      scenes: [sceneA, sceneB],
      arrangement: {
        ...doc.arrangement,
        clips: [
          { id: "pc1", sceneId: sceneA.id, startBar: 0, lengthBars: 4 },
          { id: "pc2", sceneId: sceneB.id, startBar: 4, lengthBars: 4 },
        ],
      },
    };
  }

  it("attaches the active scene's packs at the seam (and none in gaps)", () => {
    const doc = songWithPacks();
    const seamTick = 4 * BAR_TICKS;
    const scheduled: Array<Array<{ tick: number; value: number; packs?: Record<string, string> | null }>> = [];
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
      applySceneTempo: () => {},
      setSceneIntensity: () => {},
      scheduleSceneIntensity: (points) => scheduled.push(points),
    });
    transport.play(0);
    scheduler.start();
    while (transport.position < seamTick + 1200) {
      audioTime += 0.025;
      scheduler["tick"]();
    }
    scheduler.stop();

    const sceneB = doc.scenes.find((candidate) => candidate.id === "scene-pack-b")!;
    const callsWithSeam = scheduled.filter((points) => points.some((point) => point.tick === seamTick));
    expect(callsWithSeam.length).toBeGreaterThan(0);
    for (const points of callsWithSeam) {
      const seam = points.filter((point) => point.tick === seamTick);
      expect(seam).toHaveLength(1);
      expect(seam[0]!.packs).toEqual(sceneB.packs);
    }
    // Inside scene A (no packs) the points carry none.
    const insideA = scheduled.find((points) => points.some((point) => point.tick < seamTick));
    if (insideA) {
      for (const point of insideA.filter((candidate) => candidate.tick < seamTick)) {
        expect(point.packs).toBeUndefined();
      }
    }
  });
});

describe("per-scene packs — bridge override", () => {
  const growPair = KOREN_SCENE_PACK.find((pair) => pair.id === "drill-phone-growl")!;
  const twistPair = TWIST_SCENE_PACK.find((pair) => pair.id === "trap-center-shimmer")!;

  it("writes the GROW pair law at each point and restores the doc state on exit", () => {
    const { doc, growId } = docWithSceneFx();
    const { bridge, writes } = bridgeHarness(doc);
    const spt = 1 / 1000;
    bridge.scheduleSceneIntensity(
      [
        { tick: 0, value: 0, packs: { [growId]: growPair.id } },
        { tick: 1000, value: 1, packs: { [growId]: growPair.id } },
        { tick: 2000, value: 0.7 },
      ],
      (tick) => tick * spt,
    );

    const driveA = growPair.a.drive!;
    const driveB = growPair.b.drive!;
    const atZero = writes.find((write) => write.id === "drive" && write.when === 0);
    expect(atZero?.value).toBeCloseTo(driveA, 9);
    const atEnd = writes.find((write) => write.id === "drive" && write.when === 1);
    expect(atEnd?.value).toBeCloseTo(driveB, 9);
    // Exit point: the doc value comes back (no armed mapping on drive here).
    const restored = writes.find((write) => write.id === "drive" && write.when === 2);
    expect(restored?.value).toBeCloseTo(defaultParamsOf("bassHarmonic").drive!, 9);
  });

  it("guards armed doc mappings on pair params while the override is active", () => {
    const { doc, growId, trackId } = docWithSceneFx();
    doc.macros[0]!.mappings.push({
      id: "sc-map",
      trackId,
      param: "fxParam",
      amount: 0.5,
      source: "intensity",
      target: { kind: "fxParam", trackId, fxId: growId, paramId: "drive" },
    });
    const { bridge, writes } = bridgeHarness(doc);
    bridge.scheduleSceneIntensity([{ tick: 0, value: 0, packs: { [growId]: growPair.id } }], (tick) => tick / 1000);
    const driveA = growPair.a.drive!;
    // The armed mapping would compose 0.45 + 0.5·(−1)·0.5 = 0.2 — the guard
    // must keep it out; the pair law owns the param.
    expect(writes.some((write) => write.id === "drive" && Math.abs(write.value - 0.2) < 1e-9)).toBe(false);
    expect(writes.find((write) => write.id === "drive" && write.when === 0)?.value).toBeCloseTo(driveA, 9);
  });

  it("swaps TWIST slots and rides morph = intensity, then re-seeds the doc slots", () => {
    const { doc, twistId } = docWithSceneFx();
    const { bridge, twistWrites, twistRuntime } = bridgeHarness(doc);
    bridge.scheduleSceneIntensity(
      [
        { tick: 0, value: 0.25, packs: { [twistId]: twistPair.id } },
        { tick: 1000, value: 0.7 },
      ],
      (tick) => tick / 1000,
    );
    expect(twistRuntime.setCurves).toHaveBeenCalledWith(twistPair.a, twistPair.b, 0);
    const morphWrite = twistWrites.find((write) => write.id === "morph" && write.when === 0);
    expect(morphWrite?.value).toBeCloseTo(0.25, 9);
    // Exit: the doc has no stored slots, so the override clears and morph
    // returns to the doc base.
    expect(twistRuntime.setCurves).toHaveBeenLastCalledWith(null, null, 1);
    const morphRestore = twistWrites.find((write) => write.id === "morph" && write.when === 1);
    expect(morphRestore?.value).toBeCloseTo(defaultParamsOf("skrutka").morph ?? 0, 9);
  });

  it("hands the override back to the doc on stop (automationReset)", () => {
    const { doc, growId } = docWithSceneFx();
    const { bridge, writes } = bridgeHarness(doc);
    bridge.setSceneIntensity(0.5, { [growId]: growPair.id });
    const mid = (growPair.a.drive! + growPair.b.drive!) / 2;
    expect(writes.some((write) => write.id === "drive" && write.when === null && write.value === mid)).toBe(true);
    bridge.automationReset();
    const lastDrive = [...writes].reverse().find((write) => write.id === "drive");
    expect(lastDrive?.value).toBeCloseTo(defaultParamsOf("bassHarmonic").drive!, 9);
    expect(lastDrive?.when).toBeNull();
  });
});
