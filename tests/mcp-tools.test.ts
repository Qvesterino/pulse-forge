import { describe, it, expect } from "vitest";
import { executeMcpTool, MCP_TOOLS, type McpToolContext } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { useDeterministicIds, resetDeterministicIds } from "../src/shared/ids";
import { addArrangementClip, createScene, setSceneRole } from "../src/commands/commands";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * MCP TOOLS — headless verification against a real ProjectStore-backed
 * context. The GOLDEN RULE under test: every tool result is a verification
 * read-back of the resulting STATE (not a dispatch echo), mutations go
 * through the deterministic command layer, and failures are honest.
 */

function makeCtx(doc: ProjectDocument): { ctx: McpToolContext; store: ProjectStoreLike } {
  let current = doc;
  const undoStack: Array<() => ProjectDocument> = [];
  const redoStack: Array<() => ProjectDocument> = [];
  const storeLike = {
    get doc() {
      return current;
    },
  };
  const ctx: McpToolContext = {
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
    redo: () => {},
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
  return { ctx, store: storeLike as ProjectStoreLike };
}

interface ProjectStoreLike {
  readonly doc: ProjectDocument;
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

describe("mcp tools — headless execution", () => {
  it("tool surface: exactly the 5 documented tools", () => {
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual([
      "kyx_intent",
      "kyx_state",
      "kyx_undo",
      "kyx_transport",
      "kyx_export",
    ]);
  });

  it("kyx_intent 'mute the drums' mutes the drum track and reports the read-back", () => {
    const doc = datasetDoc();
    const { ctx } = makeCtx(doc);
    const result = executeMcpTool(ctx, "kyx_intent", { instruction: "mute the drums" });
    expect(result.mutated).toBe(true);
    const drums = doc.tracks.find((t) => t.kind === "drum")!;
    const after = ctx.getDoc().tracks.find((t) => t.id === drums.id)!;
    expect(after.mute).toBe(true);
    expect(result.text).toContain("mute");
  });

  it("kyx_intent 'set tempo to 140' lands 140; kyx_state reads it back", () => {
    const doc = datasetDoc();
    const { ctx } = makeCtx(doc);
    executeMcpTool(ctx, "kyx_intent", { instruction: "set tempo to 140" });
    expect(ctx.getDoc().bpm).toBe(140);
    const state = executeMcpTool(ctx, "kyx_state", { subject: "tempo" });
    expect(state.text).toContain("140");
    expect(state.mutated).toBe(false);
  });

  it("kyx_intent generation asks are REFUSED honestly (no hallucinated beats over MCP)", () => {
    const doc = datasetDoc();
    const { ctx } = makeCtx(doc);
    const result = executeMcpTool(ctx, "kyx_intent", { instruction: "dark techno at 140" });
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("inside the KYX app");
  });

  it("kyx_intent SK: 'zníž basu' lowers the bass family via the command layer", () => {
    const doc = datasetDoc();
    const { ctx } = makeCtx(doc);
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
    const { ctx } = makeCtx(doc);
    executeMcpTool(ctx, "kyx_intent", { instruction: "set tempo to 140" });
    expect(ctx.getDoc().bpm).toBe(140);
    const result = executeMcpTool(ctx, "kyx_undo", { action: "undo", steps: 1 });
    expect(result.mutated).toBe(true);
    expect(ctx.getDoc().bpm).not.toBe(140);
  });

  it("unknown tool and unknown state subject are handled honestly", () => {
    const doc = datasetDoc();
    const { ctx } = makeCtx(doc);
    expect(executeMcpTool(ctx, "nope", {}).text).toContain("unknown tool");
    expect(executeMcpTool(ctx, "kyx_state", { subject: "quantum" }).text.length).toBeGreaterThan(0);
  });
});
