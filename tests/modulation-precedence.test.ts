/**
 * Modulation precedence — automation > modulator > macro > midiCC
 * (ADR 0067, audit F-11).
 *
 * An effect parameter has ONE AudioParam, and four sources write it: the
 * automation lane (absolute value), the scheduled modulator
 * (base + halfRange·value), the macro (base + halfRange·bipolar·amount) and
 * the MIDI CC (absolute value). The audible result was decided by the order in
 * which the writes happened to land — the macro's contribution was dropped
 * SILENTLY, and a macro move was audible for one scheduler window (25 ms)
 * before the lane overwrote it.
 *
 * The harness is the bridge + the real DeviceLookup with a fake node map (the
 * pattern `tests/mixer-audit3.test.ts` uses). It runs in the default jsdom
 * suite — the engine-level `OfflineAudioContext` specs never run there, so a
 * gate pinned only at the engine level would be a guard that never fires.
 */
import { describe, expect, it } from "vitest";
import { AutomationBridge } from "../src/audio-engine/automationBridge";
import { DeviceLookup } from "../src/audio-engine/deviceLookup";
import {
  MODULATION_PRECEDENCE,
  modulationOwner,
  modulationOwnership,
  sourceOutranks,
} from "../src/project-model/modulation-precedence";
import { baseDocument } from "../src/project-model/templates";
import type { AutomationTarget, DrumTrack, Lfo, Macro, ProjectDocument } from "../src/project-model/types";

const TRACK_ID = "prec-drum";
const FX_ID = "fx-trem";

/** The one parameter every source in this file fights over. */
function depthTarget(): AutomationTarget {
  return { kind: "fxParam", trackId: TRACK_ID, fxId: FX_ID, paramId: "depth" };
}

/** The tremolo depth: range 0..1, doc base 0.5 → half-range 0.5. */
const BASE = 0.5;
const HALF_RANGE = 0.5;
/** macro at 1.0 → bipolar +1 → the macro composes base + 0.5 = 1.0. */
const MACRO_VALUE = 1;
const LANE_VALUE = 0.3;
const CC_VALUE = 0.8;

function makeDoc(opts: { lane?: boolean; lfo?: boolean; macroValue?: number } = {}): ProjectDocument {
  const doc = baseDocument("Precedence", 120);
  const drum: DrumTrack = {
    id: TRACK_ID,
    kind: "drum",
    name: "Drums",
    gain: 0.9,
    pan: 0,
    mute: false,
    solo: false,
    effects: [
      {
        id: FX_ID,
        type: "tremolo",
        bypassed: false,
        params: { rate: 5, depth: BASE, shape: 0, mode: 0, mix: 1 },
      },
    ],
    sends: {},
    pads: [],
  };
  doc.tracks = [drum];
  const macro: Macro = {
    id: "macro-1",
    name: "M",
    value: opts.macroValue ?? MACRO_VALUE,
    mappings: [
      {
        id: "map-1",
        trackId: TRACK_ID,
        param: "fxParam",
        amount: 1,
        source: "macro",
        target: depthTarget(),
      },
    ],
  };
  doc.macros = [macro];
  if (opts.lane) {
    doc.automation = [{ id: "lane-1", target: depthTarget(), points: [{ tick: 0, value: LANE_VALUE }] }];
  }
  if (opts.lfo) {
    const lfo: Lfo = {
      id: "lfo-1",
      kind: "step",
      trackId: TRACK_ID,
      param: "gain",
      amount: 1,
      rateHz: 2,
      steps: [1, -1],
      seed: "prec",
      target: depthTarget(),
    };
    doc.lfos = [lfo];
  }
  return doc;
}

/** A parameter stub that just remembers the last value written. */
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
  return {
    gain: params.gain ?? param(1),
    pan: params.pan ?? param(0),
    ...params,
  };
}

interface Harness {
  bridge: AutomationBridge;
  /** Every value that reached the effect runtime, in order. */
  writes: number[];
  /** The macro's composed value (base + halfRange·bipolar·amount). */
  macroValue: number;
  doc: ProjectDocument;
}

function harnessFor(doc: ProjectDocument): Harness {
  const writes: number[] = [];
  const runtime = {
    setParameter: (_id: string, value: number) => {
      writes.push(value);
    },
    setParameterAt: (_id: string, value: number, _when: number) => {
      writes.push(value);
    },
  };
  const view = {
    fx: { runtimes: new Map([[FX_ID, runtime]]) },
    modAutoGain: nodeWith({ gain: param(1) }),
    modAutoPan: nodeWith({ pan: param(0) }),
    modMacroGain: nodeWith({ gain: param(1) }),
    modMacroPan: nodeWith({ pan: param(0) }),
    input: {} as unknown as AudioNode,
  };
  const trackMap = new Map([[TRACK_ID, view]]);
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
  return { bridge, writes, macroValue: BASE + HALF_RANGE * MACRO_VALUE, doc };
}

/**
 * The engine's project sync: `setProject` → `syncProject` → `syncLfos` +
 * `syncMacros`. The ownership is doc-derived, so it is established here —
 * without it the gate would not know who owns the parameter.
 */
function syncProject(bridge: AutomationBridge, doc: ProjectDocument): void {
  bridge.syncMacros(doc);
}

/** One scheduler window of automation — the lane takes the parameter. */
function driveAutomation(bridge: AutomationBridge): void {
  bridge.applyAutomation(0, 480, (tick) => tick, 0);
}

/** One scheduler window of modulators. */
function driveModulators(bridge: AutomationBridge): void {
  bridge.applyModulators(0, 480, (tick) => tick / 480);
}

describe("the modulation precedence gate (F-11)", () => {
  it("the lane wins over the macro: a macro move does NOT reach the parameter", () => {
    const doc = makeDoc({ lane: true });
    const { bridge, writes } = harnessFor(doc);
    syncProject(bridge, doc);

    driveAutomation(bridge);
    expect(writes.at(-1)).toBeCloseTo(LANE_VALUE, 5);

    const before = writes.length;
    // The macro moves — a document change re-composes the macros. The new
    // macro value composes to 0.75 (bipolar 0.5 → base + 0.25); it must
    // never reach the parameter while the lane holds it.
    bridge.syncMacros({ ...doc, macros: [{ ...doc.macros[0], value: 0.75 }] });

    expect(writes.length).toBe(before);
    expect(writes).not.toContain(0.75);
  });

  it("the lane wins over the scheduled modulator: the modulator does not write", () => {
    const doc = makeDoc({ lane: true, lfo: true });
    const { bridge, writes } = harnessFor(doc);
    syncProject(bridge, doc);

    driveAutomation(bridge);
    const before = writes.length;
    driveModulators(bridge);

    expect(writes.length).toBe(before);
  });

  it("the modulator wins over the macro: the macro does not write", () => {
    const doc = makeDoc({ lfo: true });
    const { bridge, writes } = harnessFor(doc);
    syncProject(bridge, doc);

    driveModulators(bridge);
    expect(writes.length).toBeGreaterThan(0);

    const before = writes.length;
    bridge.syncMacros({ ...doc, macros: [{ ...doc.macros[0], value: 0.75 }] });

    expect(writes.length).toBe(before);
  });

  it("the macro wins over the MIDI CC: the CC does not write", () => {
    const doc = makeDoc();
    const { bridge, writes } = harnessFor(doc);
    syncProject(bridge, doc);

    const before = writes.length;
    bridge.applyMidiCc(depthTarget(), CC_VALUE);

    expect(writes.length).toBe(before);
    expect(writes).not.toContain(CC_VALUE);
  });

  it("without an owner the MIDI CC writes — the lowest source still works", () => {
    const doc = makeDoc();
    doc.macros = [];
    const { bridge, writes } = harnessFor(doc);
    syncProject(bridge, doc);

    bridge.applyMidiCc(depthTarget(), CC_VALUE);

    expect(writes.at(-1)).toBeCloseTo(CC_VALUE, 5);
  });

  it("the stop takeover hands the parameter back: the macro writes again", () => {
    const doc = makeDoc({ lane: true });
    const { bridge, writes } = harnessFor(doc);
    syncProject(bridge, doc);

    driveAutomation(bridge);
    bridge.automationReset();

    // The takeover restores the doc base and re-composes the macro — the
    // macro's value is the last thing written.
    expect(writes.at(-1)).toBeCloseTo(BASE + HALF_RANGE * MACRO_VALUE, 5);
  });

  it("the macro writes when no lane drives the parameter", () => {
    const doc = makeDoc();
    const { bridge, writes } = harnessFor(doc);
    syncProject(bridge, doc);

    expect(writes.at(-1)).toBeCloseTo(BASE + HALF_RANGE * MACRO_VALUE, 5);
  });

  it("a deleted lane hands the parameter back to the macro at once", () => {
    // The ownership is doc-derived: removing the lane releases the parameter
    // on the next composition — no reset needed.
    const doc = makeDoc({ lane: true });
    const { bridge, writes } = harnessFor(doc);
    syncProject(bridge, doc);

    driveAutomation(bridge);
    const withoutLane = { ...doc, automation: [] };
    bridge.syncMacros(withoutLane);

    expect(writes.at(-1)).toBeCloseTo(BASE + HALF_RANGE * MACRO_VALUE, 5);
  });

  it("the track gain bus is NOT gated — the macro still composes into modMacroGain", () => {
    const doc = makeDoc();
    doc.macros[0].mappings[0].target = { kind: "trackGain", trackId: TRACK_ID };
    doc.automation = [
      { id: "lane-1", target: { kind: "trackGain", trackId: TRACK_ID }, points: [{ tick: 0, value: 0.5 }] },
    ];
    const { bridge, writes } = harnessFor(doc);
    const view = (
      bridge as unknown as { deps: { trackNodes: Map<string, { modMacroGain: { gain: { value: number } } }> } }
    ).deps.trackNodes.get(TRACK_ID)!;

    syncProject(bridge, doc);

    // The lane owns the channel gain; the macro still writes its own bus.
    expect(view.modMacroGain.gain.value).toBeGreaterThan(0);
    expect(writes.length).toBe(0);
  });
});

describe("the precedence order itself (F-11)", () => {
  it("is automation > modulator > macro > midiCC", () => {
    expect(MODULATION_PRECEDENCE).toEqual(["automation", "modulator", "macro", "midiCC"]);
  });

  it("lets a source write only when it does not lose to the owner", () => {
    expect(sourceOutranks("automation", "modulator")).toBe(true);
    expect(sourceOutranks("modulator", "automation")).toBe(false);
    expect(sourceOutranks("macro", "modulator")).toBe(false);
    expect(sourceOutranks("midiCC", "macro")).toBe(false);
    // The same class never blocks itself (the macro class composes).
    expect(sourceOutranks("macro", "macro")).toBe(true);
  });
});

describe("the declared owner of a parameter (F-11 read model)", () => {
  it("is the automation lane when a lane drives it", () => {
    const doc = makeDoc({ lane: true });
    expect(modulationOwner(doc, depthTarget())).toBe("automation");
  });

  it("is the modulator when a scheduled modulator drives it", () => {
    const doc = makeDoc({ lfo: true });
    expect(modulationOwner(doc, depthTarget())).toBe("modulator");
  });

  it("is the macro when only the macro maps it", () => {
    const doc = makeDoc();
    expect(modulationOwner(doc, depthTarget())).toBe("macro");
  });

  it("is nothing for a track gain — the track bus composes, it does not conflict", () => {
    const doc = makeDoc();
    expect(modulationOwner(doc, { kind: "trackGain", trackId: TRACK_ID })).toBeNull();
    expect(modulationOwner(doc, { kind: "trackPan", trackId: TRACK_ID })).toBeNull();
  });

  it("ignores an empty lane — the automation writer skips it too", () => {
    const doc = makeDoc({ lane: true });
    doc.automation[0].points = [];
    expect(modulationOwner(doc, depthTarget())).toBe("macro");
  });

  it("ignores a muted arrangement clip", () => {
    const doc = makeDoc();
    doc.arrangement.automationClips = [
      {
        id: "clip-1",
        target: depthTarget(),
        startTick: 0,
        lengthTicks: 480,
        points: [{ tick: 0, value: 0.9 }],
        muted: true,
      },
    ];
    expect(modulationOwner(doc, depthTarget())).toBe("macro");
  });

  it("counts a live arrangement clip as the automation owner", () => {
    const doc = makeDoc();
    doc.arrangement.automationClips = [
      {
        id: "clip-1",
        target: depthTarget(),
        startTick: 0,
        lengthTicks: 480,
        points: [{ tick: 0, value: 0.9 }],
      },
    ];
    expect(modulationOwner(doc, depthTarget())).toBe("automation");
  });

  it("resolves a deprecated param alias to the canonical parameter", () => {
    // The lane names the LEGACY id; the macro maps the canonical one. They
    // are the same parameter, so both must resolve to ONE key — otherwise the
    // ownership would split and the lane would not own the macro's parameter.
    const doc = makeDoc();
    const eq = {
      id: "fx-eq",
      type: "eq" as const,
      bypassed: false,
      params: { lowMidGain: 0, midGain: 0, lowMidFreq: 500, midFreq: 1000 },
    };
    doc.tracks = [{ ...(doc.tracks[0] as DrumTrack), effects: [eq] }];
    const target: AutomationTarget = { kind: "fxParam", trackId: TRACK_ID, fxId: "fx-eq", paramId: "lowMidGain" };
    doc.automation = [{ id: "lane-1", target, points: [{ tick: 0, value: 0.5 }] }];
    doc.macros[0].mappings[0].target = target;

    const ownership = modulationOwnership(doc);
    expect(ownership.automation.size).toBe(1);
    expect(ownership.macro.size).toBe(1);
    expect([...ownership.automation][0]).toBe([...ownership.macro][0]);
  });
});
