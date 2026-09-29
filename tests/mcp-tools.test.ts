import { describe, it, expect } from "vitest";
import { executeMcpTool, MCP_TOOLS, type McpToolContext } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { useDeterministicIds, resetDeterministicIds } from "../src/shared/ids";
import { addArrangementClip, createScene, setSceneRole } from "../src/commands/commands";
import { ProjectStore } from "../src/store/ProjectStore";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * MCP TOOLS — headless verification against a real ProjectStore-backed
 * context. The GOLDEN RULE under test: every tool result is a verification
 * read-back of the resulting STATE (not a dispatch echo), mutations go
 * through the deterministic command layer, and failures are honest.
 */

function makeCtx(doc: ProjectDocument): McpToolContext {
  let current = doc;
  const undoStack: Array<() => ProjectDocument> = [];
  const redoStack: Array<() => ProjectDocument> = [];
  return {
    getDoc: () => current,
    execute: (command) => {
      const prev = current;
      current = command.execute(current);
      undoStack.push(() => command.undo(prev));
      redoStack.length = 0;
    },
    undo: () => {
      const restore = undoStack.pop();
      if (restore) {
        redoStack.length = 0;
        current = restore();
      }
    },
    redo: () => {
      const restore = redoStack.pop();
      if (restore) current = restore();
    },
    undoStackLength: () => undoStack.length,
    historyLabels: () => [],
    isMicRecordingActive: () => false,
    transport: {
      play: () => {},
      stop: () => {},
      pause: () => {},
      setLoop: () => {},
      setMetronome: () => {},
    },
  };
}

/** Context whose mutations land in the REAL store (structured tests read
 * store.doc afterwards — the makeCtx holder would hide them). */
function storeCtx(store: ProjectStore): McpToolContext {
  return {
    getDoc: () => store.doc,
    execute: (command) => store.execute(command),
    undo: () => store.undo(),
    redo: () => store.redo(),
    undoStackLength: () => store.undoStackLength,
    historyLabels: () => [],
    isMicRecordingActive: () => false,
    transport: {
      play: () => {},
      stop: () => {},
      pause: () => {},
      setLoop: () => {},
      setMetronome: () => {},
    },
  };
}

function datasetDoc(): ProjectDocument {
  useDeterministicIds();
  resetDeterministicIds();
  let doc = createProjectFromTemplate("house");
  doc = { ...doc, arrangement: { ...doc.arrangement, clips: [] }, markers: [] };
  doc = createScene(doc, "Intro").execute(doc);
  doc = setSceneRole(doc, doc.scenes[doc.scenes.length - 1].id, "intro").execute(doc);
  doc = addArrangementClip(doc, doc.scenes[doc.scenes.length - 1].id, 0, 4).execute(doc);
  doc = createScene(doc, "Drop").execute(doc);
  doc = setSceneRole(doc, doc.scenes[doc.scenes.length - 1].id, "drop").execute(doc);
  doc = addArrangementClip(doc, doc.scenes[doc.scenes.length - 1].id, 4, 4).execute(doc);
  return doc;
}

function withLead(): ProjectDocument {
  const doc = datasetDoc();
  const base = createProjectFromTemplate("house");
  const baseInstrument = base.tracks.find((t) => t.kind === "instrument")!;
  const lead = { ...baseInstrument, id: "track-lead-x", name: "Lead" };
  return { ...doc, tracks: [...doc.tracks, lead] };
}

describe("mcp tools — headless execution", () => {
  it("tool surface: the 11 documented tools", () => {
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual([
      "kyx_intent",
      "kyx_state",
      "kyx_undo",
      "kyx_transport",
      "kyx_export",
      "kyx_generate",
      "kyx_groove",
      "kyx_fx",
      "kyx_sections",
      "kyx_markers",
      "kyx_tracks",
    ]);
  });

  it("kyx_intent 'mute the drums' mutes the drum track and reports the read-back", () => {
    const doc = datasetDoc();
    const ctx = makeCtx(doc);
    const result = executeMcpTool(ctx, "kyx_intent", { instruction: "mute the drums" });
    expect(result.mutated).toBe(true);
    const drums = doc.tracks.find((t) => t.kind === "drum")!;
    const after = ctx.getDoc().tracks.find((t) => t.id === drums.id)!;
    expect(after.mute).toBe(true);
    expect(result.text).toContain("mute");
  });

  it("kyx_intent 'set tempo to 140' lands 140; kyx_state reads it back", () => {
    const doc = datasetDoc();
    const ctx = makeCtx(doc);
    executeMcpTool(ctx, "kyx_intent", { instruction: "set tempo to 140" });
    expect(ctx.getDoc().bpm).toBe(140);
    const state = executeMcpTool(ctx, "kyx_state", { subject: "tempo" });
    expect(state.text).toContain("140");
    expect(state.mutated).toBe(false);
  });

  it("kyx_intent generation asks are REFUSED honestly (no hallucinated beats over MCP)", () => {
    const doc = datasetDoc();
    const ctx = makeCtx(doc);
    const result = executeMcpTool(ctx, "kyx_intent", { instruction: "dark techno at 140" });
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("inside the KYX app");
  });

  it("kyx_intent SK: 'zníž basu' lowers the bass family via the command layer", () => {
    const doc = datasetDoc();
    const ctx = makeCtx(doc);
    const before = ctx
      .getDoc()
      .tracks.find((t) => t.kind === "instrument" && ["bass", "808"].includes(t.instrument))!.gain;
    executeMcpTool(ctx, "kyx_intent", { instruction: "zníž basu" });
    const after = ctx
      .getDoc()
      .tracks.find((t) => t.kind === "instrument" && ["bass", "808"].includes(t.instrument))!.gain;
    expect(after).toBeLessThan(before);
  });

  it("kyx_undo undoes one step and kyx_state confirms", () => {
    const doc = datasetDoc();
    const ctx = makeCtx(doc);
    executeMcpTool(ctx, "kyx_intent", { instruction: "set tempo to 140" });
    expect(ctx.getDoc().bpm).toBe(140);
    const result = executeMcpTool(ctx, "kyx_undo", { action: "undo", steps: 1 });
    expect(result.mutated).toBe(true);
    expect(ctx.getDoc().bpm).not.toBe(140);
  });

  it("unknown tool and unknown state subject are handled honestly", () => {
    const doc = datasetDoc();
    const ctx = makeCtx(doc);
    expect(executeMcpTool(ctx, "nope", {}).text).toContain("unknown tool");
    expect(executeMcpTool(ctx, "kyx_state", { subject: "quantum" }).text.length).toBeGreaterThan(0);
  });
});

// ─── STRUCTURED TOOLS — generate/groove/fx/sections/markers/tracks ──────────

describe("mcp structured tools", () => {
  it("kyx_generate: deterministic pattern from a spec (same seed reproduces)", () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    executeMcpTool(ctx, "kyx_generate", { genre: "techno", seed: "gen-a", bpm: 132 });
    expect(store.doc.bpm).toBe(132);
    const firstName = store.doc.patterns[store.doc.patterns.length - 1].name;
    const firstRows = JSON.stringify(store.doc.patterns[store.doc.patterns.length - 1].rows);

    const store2 = new ProjectStore(datasetDoc());
    const ctx2 = storeCtx(store2);
    executeMcpTool(ctx2, "kyx_generate", { genre: "techno", seed: "gen-a", bpm: 132 });
    const rows2 = JSON.stringify(store2.doc.patterns[store2.doc.patterns.length - 1].rows);
    expect(rows2).toBe(firstRows);
    expect(store2.doc.patterns[store2.doc.patterns.length - 1].name).toBe(firstName);
  });

  it("kyx_groove global set lands absolute swing (one undo)", () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    executeMcpTool(ctx, "kyx_groove", { direction: "set", percent: 60 });
    expect(store.doc.groove?.swing ?? 0).toBeCloseTo(0.6, 5);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(store.doc.groove?.swing ?? 0).toBe(0);
  });

  it("kyx_fx more reverb on the lead adds the instance; remove deletes it", () => {
    const store = new ProjectStore(withLead());
    executeMcpTool(storeCtx(store), "kyx_fx", { effect: "reverb", family: "lead", action: "more" });
    const withFx = store.doc.tracks.find((t) => t.kind === "instrument" && t.name === "Lead")!;
    expect(withFx.effects.some((fx) => fx.type === "reverb")).toBe(true);
    executeMcpTool(storeCtx(store), "kyx_fx", { effect: "reverb", family: "lead", action: "remove" });
    expect(store.doc.tracks.find((t) => t.name === "Lead")!.effects.length).toBe(0);
    expect(store.undoStackLength).toBe(2);
  });

  it("kyx_sections add/remove named sections through the arrange layer", () => {
    const store = new ProjectStore(datasetDoc());
    const scenesBefore = store.doc.scenes.length;
    executeMcpTool(storeCtx(store), "kyx_sections", { op: "add", role: "build" });
    expect(store.doc.scenes.length).toBe(scenesBefore + 1);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(store.doc.scenes.length).toBe(scenesBefore);
  });

  it("kyx_markers add/remove at 1-based bars", () => {
    const store = new ProjectStore(datasetDoc());
    executeMcpTool(storeCtx(store), "kyx_markers", { op: "add", bar: 9, name: "Outro" });
    expect(store.doc.markers).toHaveLength(1);
    expect(store.doc.markers[0].tick).toBe(8 * 4 * 480);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(store.doc.markers).toHaveLength(0);
  });

  it("kyx_tracks addInstrument/remove round-trip", () => {
    const store = new ProjectStore(datasetDoc());
    const before = store.doc.tracks.length;
    executeMcpTool(storeCtx(store), "kyx_tracks", { op: "addInstrument", instrument: "808" });
    expect(store.doc.tracks.length).toBe(before + 1);
    store.undo();
    expect(store.doc.tracks.length).toBe(before);
  });
});
