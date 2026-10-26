import { describe, expect, it } from "vitest";
import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import { addEffectToTracks } from "../src/commands/commands";
import { setEffectParam } from "../src/commands/effectParams";
import { ProjectStore } from "../src/store/ProjectStore";
import { testDoc } from "./fixtures/doc";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * F-08 — kyx_plugin_param must reach the DEEP/structured params, and its
 * discovery must show them.
 *
 * The tool is the MCP surface's "precise control" for inserted instances,
 * but its `set` resolved params ONLY against the rack catalog (top-level
 * EFFECT_META ids), so a dotted path — PRISM's `band1.gainDb`, Ultina's
 * `global.inputGainDb` — was refused with "unknown param" although the
 * command layer and the automation path address exactly those ids (and the
 * PRISM editor UI edits them all day). `setEffectParam` resolved deep ids
 * for Ozvena ONLY — now through the same inventory the automation path
 * uses (targetParamDef). The `list` op shows the deep ids per instance, so
 * the agent can discover them instead of guessing.
 */

function makeCtx(store: ProjectStore): McpToolContext {
  return {
    getDoc: () => store.doc,
    execute: (command) => store.execute(command),
    undo: () => store.undo(),
    redo: () => store.redo(),
    undoStackLength: () => store.undoStackLength,
    historyLabels: () => store.history.map((entry) => entry.label),
    isMicRecordingActive: () => false,
    transport: {
      play: () => {},
      stop: () => {},
      pause: () => {},
      setLoop: () => {},
      setMetronome: () => {},
    },
    allowDestructive: () => true,
  };
}

function docWithPrismAndUltina(): { store: ProjectStore; trackId: string; prismId: string; ultinaId: string } {
  const doc: ProjectDocument = testDoc();
  const trackId = doc.tracks.find((track) => track.kind === "instrument")!.id;
  const withPrism = addEffectToTracks(doc, [trackId], "fxeq").execute(doc);
  const withUltina = addEffectToTracks(withPrism, [trackId], "ultina").execute(withPrism);
  const track = withUltina.tracks.find((candidate) => candidate.id === trackId)!;
  if (track.kind !== "instrument") throw new Error("instrument track expected");
  const prism = track.effects.find((effect) => effect.type === "fxeq")!;
  const ultina = track.effects.find((effect) => effect.type === "ultina")!;
  return { store: new ProjectStore(withUltina), trackId, prismId: prism.id, ultinaId: ultina.id };
}

describe("kyx_plugin_param reaches the deep/structured params", () => {
  it("set: a PRISM band param lands, clamped to the core schema, and undo restores it", async () => {
    const { store, trackId, prismId } = docWithPrismAndUltina();
    const result = await executeMcpTool(makeCtx(store), "kyx_plugin_param", {
      op: "set",
      trackId,
      effect: "fxeq",
      fxId: prismId,
      param: "band1.gainDb",
      value: -6,
    });
    expect(result.isError, String(result.text)).toBeFalsy();
    expect(result.mutated).toBe(true);
    const fx = store.doc.tracks.find((track) => track.id === trackId)!.effects.find((effect) => effect.id === prismId)!;
    expect(fx.params["band1.gainDb"]).toBe(-6);

    store.undo();
    const restored = store.doc.tracks
      .find((track) => track.id === trackId)!
      .effects.find((effect) => effect.id === prismId)!;
    expect(restored.params["band1.gainDb"]).toBe(0); // the core schema default
  });

  it("set: an Ultina engine param lands through the generalized command path", async () => {
    const { store, trackId, ultinaId } = docWithPrismAndUltina();
    const result = await executeMcpTool(makeCtx(store), "kyx_plugin_param", {
      op: "set",
      trackId,
      effect: "ultina",
      fxId: ultinaId,
      param: "global.inputGainDb",
      value: 3.5,
    });
    expect(result.isError, String(result.text)).toBeFalsy();
    expect(result.mutated).toBe(true);
    const fx = store.doc.tracks
      .find((track) => track.id === trackId)!
      .effects.find((effect) => effect.id === ultinaId)!;
    expect(fx.params["global.inputGainDb"]).toBe(3.5);
  });

  it("set clamps a deep param into the core schema's range", async () => {
    const { store, trackId, prismId } = docWithPrismAndUltina();
    const result = await executeMcpTool(makeCtx(store), "kyx_plugin_param", {
      op: "set",
      trackId,
      effect: "fxeq",
      fxId: prismId,
      param: "band2.gainDb",
      value: -999,
    });
    expect(result.isError).toBeFalsy();
    const fx = store.doc.tracks.find((track) => track.id === trackId)!.effects.find((effect) => effect.id === prismId)!;
    expect(fx.params["band2.gainDb"]).toBe(-48); // the core schema min
  });

  it("list: the instance's deep ids are discoverable", async () => {
    const { store, trackId, prismId } = docWithPrismAndUltina();
    const result = await executeMcpTool(makeCtx(store), "kyx_plugin_param", {
      op: "list",
      trackId,
      effect: "fxeq",
    });
    expect(result.isError).toBeFalsy();
    expect(String(result.text)).toMatch(/band1\.gainDb/);
    expect(result.mutated).toBe(false);
    void prismId;
  });

  it("an id neither rack nor deep knows is still refused honestly", async () => {
    const { store, trackId, prismId } = docWithPrismAndUltina();
    const result = await executeMcpTool(makeCtx(store), "kyx_plugin_param", {
      op: "set",
      trackId,
      effect: "fxeq",
      fxId: prismId,
      param: "band9.gainDb",
      value: 1,
    });
    expect(result.isError).toBe(true);
  });

  it("rack params keep their exact existing behaviour (control)", async () => {
    const doc: ProjectDocument = testDoc();
    const trackId = doc.tracks.find((track) => track.kind === "instrument")!.id;
    const withReverb = addEffectToTracks(doc, [trackId], "reverb").execute(doc);
    const fresh = new ProjectStore(withReverb);
    const reverbId = fresh.doc.tracks
      .find((track) => track.id === trackId)!
      .effects.find((fx) => fx.type === "reverb")!.id;
    const result = await executeMcpTool(makeCtx(fresh), "kyx_plugin_param", {
      op: "set",
      trackId,
      effect: "reverb",
      fxId: reverbId,
      param: "mix",
      value: 0.6,
    });
    expect(result.isError).toBeFalsy();
    expect(
      fresh.doc.tracks.find((track) => track.id === trackId)!.effects.find((fx) => fx.type === "reverb")!.params.mix,
    ).toBe(0.6);
  });

  it("command layer: setEffectParam resolves an Ultina deep id (unit)", () => {
    const { store, trackId, ultinaId } = docWithPrismAndUltina();
    const next = setEffectParam(store.doc, trackId, ultinaId, "global.outputGainDb", -2).execute(store.doc);
    const fx = next.tracks.find((track) => track.id === trackId)!.effects.find((effect) => effect.id === ultinaId)!;
    expect(fx.params["global.outputGainDb"]).toBe(-2);
  });
});
