/**
 * F-09 — the effect parameter's value IN EFFECT.
 *
 * The rack read the DOCUMENT (`values={fx.params}`) while automation writes
 * the ABSOLUTE lane value into the runtime. So during playback the knob read
 * the committed value, the audio played the lane value, and a manual knob
 * edit was overwritten within one scheduler tick (25 ms) while the knob kept
 * displaying the user's number.
 *
 * Two contracts are pinned here:
 *
 *  1. the READ MODEL — the value in effect for a parameter an automation lane
 *     drives is the LANE's value at the tick, and the committed value stays
 *     separately visible;
 *  2. the DSP — the runtime really receives that same number, so the readout
 *     cannot drift from the sound.
 *
 * The second one is the one that matters: a readout that disagrees with the
 * engine is a second source of truth, which is exactly what F-09 is about.
 */
import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import { addAutomationLane, addAutomationPoint } from "../src/commands/automation";
import { effectParamEffectiveValues, effectiveParamValue } from "../src/project-model/effective-values";
import type { ProjectDocument } from "../src/project-model/types";

const FX_ID = "fx-reverb";

function docWithReverb(): { doc: ProjectDocument; trackId: string; track: ProjectDocument["tracks"][number] } {
  const doc = createProjectFromTemplate("house");
  const track = doc.tracks.find((candidate) => candidate.kind === "instrument")!;
  track.effects = [{ id: FX_ID, type: "reverb", bypassed: false, params: { mix: 0.3, decay: 1.8, tone: 9000 } }];
  return { doc, trackId: track.id, track };
}

/** A reverb whose `decay` is automated to `laneValue` at tick 0. */
function docWithLane(paramId: string, laneValue: number) {
  const { doc, trackId } = docWithReverb();
  const store = new ProjectStore(doc);
  store.execute(addAutomationLane(store.doc, { kind: "fxParam", trackId, fxId: FX_ID, paramId }));
  const laneId = store.doc.automation[store.doc.automation.length - 1].id;
  store.execute(addAutomationPoint(store.doc, laneId, 0, laneValue));
  return { doc: store.doc, trackId };
}

describe("the effective value of an effect parameter (F-09)", () => {
  it("an automated parameter plays the LANE's value, not the committed one", () => {
    const { doc, trackId } = docWithLane("decay", 2.4);
    const effective = effectiveParamValue(doc, { kind: "fxParam", trackId, fxId: FX_ID, paramId: "decay" }, 0);

    expect(effective.automated).toBe(true);
    expect(effective.source).toBe("automation");
    // The committed value stays separately visible — the knob shows what the
    // user set, the readout shows what the DSP plays.
    expect(effective.documentValue).toBe(1.8);
    expect(effective.value).toBe(2.4);
  });

  it("a parameter with no lane is the document value, and says so", () => {
    const { doc, trackId } = docWithReverb();
    const effective = effectiveParamValue(doc, { kind: "fxParam", trackId, fxId: FX_ID, paramId: "decay" }, 0);

    expect(effective.automated).toBe(false);
    expect(effective.source).toBe("document");
    expect(effective.value).toBe(1.8);
    expect(effective.laneValue).toBeUndefined();
  });

  it("the map names only the parameters a lane drives", () => {
    const { doc, trackId } = docWithLane("decay", 2.4);
    const effective = effectParamEffectiveValues(doc, trackId, FX_ID, ["mix", "decay", "tone"], 0);

    expect(Object.keys(effective)).toEqual(["decay"]);
    expect(effective.decay).toBe(2.4);
  });

  it("a lane naming a DEPRECATED alias is credited to the canonical parameter", () => {
    // eq.midGain is the legacy alias of eq.lowMidGain; the document stores the
    // canonical id, and an old document can still hold a lane that names the
    // alias. The COMMAND layer refuses to create one (the alias is not a
    // valid target any more), so the lane is planted the way an old document
    // carries it.
    const { doc, trackId, track } = docWithReverb();
    track.effects = [{ id: "fx-eq", type: "eq", bypassed: false, params: { lowMidGain: 0 } }];
    const legacy: ProjectDocument = {
      ...doc,
      automation: [
        {
          id: "lane-legacy",
          target: { kind: "fxParam", trackId, fxId: "fx-eq", paramId: "midGain" },
          points: [{ tick: 0, value: 4 }],
        },
      ],
    };

    const effective = effectiveParamValue(
      legacy,
      { kind: "fxParam", trackId, fxId: "fx-eq", paramId: "lowMidGain" },
      0,
    );
    expect(effective.automated).toBe(true);
    expect(effective.value).toBe(4);
  });
});

describe("the DSP plays what the readout claims (F-09)", () => {
  /** The bridge + a fake effect runtime that records every parameter write. */
  async function bridgeForDoc(doc: ProjectDocument, trackId: string) {
    const { AutomationBridge } = await import("../src/audio-engine/automationBridge");
    const { DeviceLookup } = await import("../src/audio-engine/deviceLookup");
    const written: Array<{ id: string; value: number }> = [];
    const runtime = {
      input: {} as AudioNode,
      output: {} as AudioNode,
      setParameter: (id: string, value: number) => {
        written.push({ id, value });
      },
    };
    const view = {
      modAutoGain: nodeWith({ gain: param(1) }),
      modAutoPan: nodeWith({ pan: param(0) }),
      modMacroGain: nodeWith({ gain: param(1) }),
      modMacroPan: nodeWith({ pan: param(0) }),
      fx: { runtimes: new Map([[FX_ID, runtime]]) },
    };
    const trackMap = new Map([[trackId, view]]);
    const lookup = new DeviceLookup({
      doc: () => doc,
      trackNodes: (id: string) => trackMap.get(id) as never,
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
    return { bridge, written };
  }

  it("the runtime receives the lane's value — the number the readout shows", async () => {
    const { doc, trackId } = docWithLane("decay", 2.4);
    const { bridge, written } = await bridgeForDoc(doc, trackId);

    bridge.applyAutomation(
      0,
      480,
      (tick) => tick,
      0,
      (tick) => tick / 480,
    );

    const decayWrites = written.filter((write) => write.id === "decay");
    expect(decayWrites.length).toBeGreaterThan(0);
    expect(decayWrites[0].value).toBe(2.4);
    // The committed value never reaches the runtime while the lane drives it.
    expect(decayWrites.every((write) => write.value !== 1.8)).toBe(true);

    // And the readout agrees with the engine, number for number.
    const effective = effectiveParamValue(doc, { kind: "fxParam", trackId, fxId: FX_ID, paramId: "decay" }, 0);
    expect(effective.value).toBe(decayWrites[0].value);
  });
});

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

function nodeWith(params: Record<string, ReturnType<typeof param>> = {}) {
  const node = {
    connections: new Set<unknown>(),
    gain: params.gain ?? param(1),
    pan: params.pan ?? param(0),
    ...params,
    connect(destination?: unknown) {
      if (destination !== undefined) node.connections.add(destination);
      return node;
    },
    disconnect(destination?: unknown) {
      if (destination === undefined) node.connections.clear();
      else node.connections.delete(destination);
    },
  };
  return node;
}
