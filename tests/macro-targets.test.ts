import { describe, expect, it, vi } from "vitest";
import { AudioEngine } from "../src/audio-engine/AudioEngine";
import { baseDocument } from "../src/project-model/templates";
import { addMacroTargetMapping, addMacroMapping, setMacroMappingTarget } from "../src/commands/commands";
import type { AutomationTarget, DrumTrack, Macro, ProjectDocument } from "../src/project-model/types";
import { YDocStore } from "../src/collab/YDocStore";

const SR = 44100;

function makeDoc(macroValue: number): { doc: ProjectDocument; macroId: string } {
  const doc = baseDocument("Macro Targets", 120);
  const drum: DrumTrack = {
    id: "macro-drum",
    kind: "drum",
    name: "Drums",
    gain: 0.9,
    pan: 0,
    mute: false,
    solo: false,
    effects: [
      {
        id: "fx-trem",
        type: "tremolo",
        bypassed: false,
        params: { rate: 5, depth: 0.5, shape: 0, mode: 0, mix: 1 },
      },
    ],
    sends: {},
    pads: [
      {
        id: "macro-pad",
        name: "Tone",
        assetId: "test.tone",
        gain: 1,
        pan: 0,
        pitch: 0,
        mute: false,
        solo: false,
        chokeGroup: null,
      },
    ],
  };
  doc.tracks = [drum];
  const macro: Macro = { id: "macro-1", name: "M", value: macroValue, mappings: [] };
  doc.macros = [macro];
  return { doc, macroId: macro.id };
}

type RuntimeWithParams = { setParameter: (id: string, value: number) => void };

function tremoloRuntime(engine: AudioEngine, trackId: string, fxId: string): RuntimeWithParams {
  const nodes = (
    engine as unknown as { trackNodes: Map<string, { fx: { runtimes: Map<string, RuntimeWithParams> } }> }
  ).trackNodes.get(trackId)!;
  return nodes.fx.runtimes.get(fxId)!;
}

/** Tremolo depth (0..1, doc base 0.5) driven by a macro. */
function depthTarget(trackId: string, fxId: string): AutomationTarget {
  return { kind: "fxParam", trackId, fxId, paramId: "depth" };
}

function setupEngine(doc: ProjectDocument) {
  const ctx = new OfflineAudioContext(2, SR, SR);
  const engine = new AudioEngine();
  engine.attachBank({ get: () => ctx.createBuffer(1, SR, SR) } as never);
  engine.useContext(ctx);
  engine.setProject(doc);
  const rt = tremoloRuntime(engine, "macro-drum", "fx-trem");
  const spy = vi.spyOn(rt, "setParameter");
  return { engine, spy };
}

describe.skipIf(typeof OfflineAudioContext === "undefined")(
  "macro generic targets — engine resolution (fxParam)",
  () => {
    it("bipolar midpoint (macro 0.5) resolves to the persisted base", () => {
      const { doc } = makeDoc(0.5);
      doc.macros[0].mappings = [
        {
          id: "map-1",
          trackId: "macro-drum",
          param: "fxParam",
          amount: 0.5,
          source: "macro",
          target: depthTarget("macro-drum", "fx-trem"),
        },
      ];
      const { engine, spy } = setupEngine(doc);
      engine.setProject({ ...doc }); // re-sync with the mapping active
      const depthCalls = spy.mock.calls.filter(([id]) => id === "depth").map(([, v]) => v);
      expect(depthCalls.length).toBeGreaterThan(0);
      expect(depthCalls.at(-1)).toBeCloseTo(0.5, 5);
    });

    it("macro max resolves base + half-range and clamps to the schema max", () => {
      const { doc } = makeDoc(1);
      doc.macros[0].mappings = [
        {
          id: "map-1",
          trackId: "macro-drum",
          param: "fxParam",
          amount: 1,
          source: "macro",
          target: depthTarget("macro-drum", "fx-trem"),
        },
      ];
      const { engine, spy } = setupEngine(doc);
      engine.setProject({ ...doc });
      expect(spy.mock.calls.filter(([id]) => id === "depth").at(-1)?.[1]).toBeCloseTo(1, 5); // 0.5 + 0.5 → max 1
    });

    it("macro min clamps at the schema minimum (never negative)", () => {
      const { doc } = makeDoc(0);
      doc.macros[0].mappings = [
        {
          id: "map-1",
          trackId: "macro-drum",
          param: "fxParam",
          amount: 1,
          source: "macro",
          target: depthTarget("macro-drum", "fx-trem"),
        },
      ];
      const { engine, spy } = setupEngine(doc);
      engine.setProject({ ...doc });
      expect(spy.mock.calls.filter(([id]) => id === "depth").at(-1)?.[1]).toBeCloseTo(0, 5); // 0.5 − 0.5 → 0
    });

    it("changing the base parameter during an active mapping re-resolves (no accumulation)", () => {
      const { doc } = makeDoc(1);
      doc.macros[0].mappings = [
        {
          id: "map-1",
          trackId: "macro-drum",
          param: "fxParam",
          amount: 0.5,
          source: "macro",
          target: depthTarget("macro-drum", "fx-trem"),
        },
      ];
      const { engine, spy } = setupEngine(doc);
      // Base depth 0.5 → resolved 0.75.
      engine.setProject({ ...doc });
      expect(spy.mock.calls.filter(([id]) => id === "depth").at(-1)?.[1]).toBeCloseTo(0.75, 5);
      // Base moves to 0.2 in the doc → resolved 0.45, NOT 0.75 + delta.
      const withNewBase = {
        ...doc,
        tracks: doc.tracks.map((t) =>
          t.kind === "drum"
            ? {
                ...t,
                effects: (t as DrumTrack).effects.map((f) =>
                  f.id === "fx-trem" ? { ...f, params: { ...f.params, depth: 0.2 } } : f,
                ),
              }
            : t,
        ),
      };
      engine.setProject(withNewBase);
      engine.setProject(withNewBase); // repeated syncs must not drift
      expect(spy.mock.calls.filter(([id]) => id === "depth").at(-1)?.[1]).toBeCloseTo(0.45, 5);
    });

    it("unknown fx/param targets are ignored safely", () => {
      const { doc } = makeDoc(1);
      doc.macros[0].mappings = [
        {
          id: "map-1",
          trackId: "macro-drum",
          param: "fxParam",
          amount: 1,
          source: "macro",
          target: { kind: "fxParam", trackId: "macro-drum", fxId: "missing", paramId: "depth" },
        },
        {
          id: "map-2",
          trackId: "macro-drum",
          param: "fxParam",
          amount: 1,
          source: "macro",
          target: { kind: "fxParam", trackId: "macro-drum", fxId: "fx-trem", paramId: "notAParam" },
        },
      ];
      const { engine, spy } = setupEngine(doc);
      expect(() => engine.setProject({ ...doc })).not.toThrow();
      expect(spy).not.toHaveBeenCalled();
    });
  },
);

describe.skipIf(typeof OfflineAudioContext === "undefined")("macro generic targets — trackGain audio path", () => {
  async function renderGain(macroValue: number, withMapping: boolean): Promise<number> {
    const dur = 0.5;
    const ctx = new OfflineAudioContext(2, SR * dur, SR);
    const engine = new AudioEngine();
    const tone = ctx.createBuffer(1, SR * dur, SR);
    {
      const d = tone.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR);
    }
    engine.attachBank({ get: () => tone } as never);
    engine.useContext(ctx);
    const { doc } = makeDoc(macroValue);
    if (withMapping) {
      doc.macros[0].mappings = [
        {
          id: "map-1",
          trackId: "macro-drum",
          param: "gain",
          amount: 1,
          source: "macro",
          target: { kind: "trackGain", trackId: "macro-drum" },
        },
      ];
    }
    engine.setProject(doc);
    engine.trigger("macro-drum", (doc.tracks[0] as DrumTrack).pads[0], 0.05, 1);
    const out = await ctx.startRendering();
    const d = out.getChannelData(0);
    let sum = 0;
    const start = Math.floor(SR * 0.15);
    for (let i = start; i < start + Math.floor(SR * 0.2); i++) sum += d[i] * d[i];
    return Math.sqrt(sum / Math.floor(SR * 0.2));
  }

  it("macro full up boosts, full down silences, midpoint is unity", async () => {
    const up = await renderGain(1, true);
    const down = await renderGain(0, true);
    const mid = await renderGain(0.5, true);
    expect(down).toBeLessThan(0.005); // bipolar −1 · amount 1 → gain 0
    expect(up).toBeGreaterThan(mid * 1.3);
    expect(mid).toBeGreaterThan(0.05); // audible unity-ish output
  });
});

describe("macro target commands", () => {
  it("addMacroTargetMapping adds an undoable generic mapping", () => {
    const { doc, macroId } = makeDoc(0.5);
    const cmd = addMacroTargetMapping(
      doc,
      macroId,
      { kind: "fxParam", trackId: "macro-drum", fxId: "fx-trem", paramId: "depth" },
      0.8,
    );
    const next = cmd.execute(doc);
    const mapping = next.macros[0].mappings[0];
    expect(mapping.target).toMatchObject({ kind: "fxParam", paramId: "depth" });
    expect(mapping.amount).toBeCloseTo(0.8, 5);
    expect(cmd.undo(next).macros[0].mappings).toHaveLength(0);
    // Validation errors throw.
    expect(() => addMacroTargetMapping(doc, "nope", { kind: "trackGain", trackId: "macro-drum" })).toThrow(/Macro/);
    expect(() => addMacroTargetMapping(doc, macroId, { kind: "fxParam", trackId: "macro-drum", paramId: "x" })).toThrow(
      /fxId/,
    );
  });

  it("setMacroMappingTarget retargets and back", () => {
    const { doc, macroId } = makeDoc(0.5);
    const withMap = addMacroMapping(doc, macroId, "macro-drum", "gain").execute(doc);
    const mappingId = withMap.macros[0].mappings[0].id;
    const cmd = setMacroMappingTarget(withMap, macroId, mappingId, { kind: "trackPan", trackId: "macro-drum" });
    const next = cmd.execute(withMap);
    expect(next.macros[0].mappings[0].target).toMatchObject({ kind: "trackPan" });
    const undone = cmd.undo(next);
    expect(undone.macros[0].mappings[0].target).toBeUndefined();
  });

  it("generic mapping round-trips through the CRDT store", () => {
    const { doc, macroId } = makeDoc(0.5);
    const store = YDocStore.fromDocument(doc);
    store.execute(
      addMacroTargetMapping(doc, macroId, {
        kind: "fxParam",
        trackId: "macro-drum",
        fxId: "fx-trem",
        paramId: "depth",
      }),
    );
    const mapping = store.doc.macros[0].mappings[0];
    expect(mapping.target).toMatchObject({ kind: "fxParam", fxId: "fx-trem" });
    store.undo();
    expect(store.doc.macros[0].mappings).toHaveLength(0);
  });
});
