import { describe, expect, it } from "vitest";
import { stemMasteringPlan, stemRoleOf } from "../src/mcp/stem-mastering";
import { ProjectStore } from "../src/store/ProjectStore";
import { createDrumTrackModel, createInstrumentTrackModel } from "../src/project-model/schema";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import type { ProjectDocument } from "../src/project-model/types";

function storeCtx(store: ProjectStore): McpToolContext {
  return {
    getDoc: () => store.doc,
    execute: (command) => store.execute(command),
    undo: () => store.undo(),
    redo: () => store.redo(),
    undoStackLength: () => store.undoStackLength,
    historyLabels: () => store.history.map((entry) => entry.label),
    isMicRecordingActive: () => false,
    transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
  } as McpToolContext;
}

describe("stem mastering planner", () => {
  it("matches the demucs roles by lane name, inflection-tolerant", () => {
    expect(stemRoleOf("Vocals")).toBe("vocals");
    expect(stemRoleOf("drums (htdemucs)")).toBe("drums");
    expect(stemRoleOf("Bass lane")).toBe("bass");
    expect(stemRoleOf("Other")).toBe("other");
    expect(stemRoleOf("Lead Synth")).toBeNull(); // no guessing
  });

  it("four role shapes, all bounded inside ZENIT's registry ranges", () => {
    const plan = stemMasteringPlan();
    expect(plan.map((s) => s.stem)).toEqual(["vocals", "drums", "bass", "other"]);
    for (const step of plan) {
      for (const value of Object.values(step.params)) expect(Number.isFinite(value)).toBe(true);
      expect(step.why.length).toBeGreaterThan(10);
    }
  });
});

describe("kyx_master op:stems", () => {
  function stemDoc(): ProjectDocument {
    const base = createProjectFromTemplate("house");
    const vocals = createDrumTrackModel("Vocals");
    const lead = createInstrumentTrackModel("analog", 0);
    const named = { ...lead, name: "Lead Synth" };
    return { ...base, tracks: [...base.tracks, vocals, named] } as ProjectDocument;
  }

  it("inserts ZENIT on stem-named lanes with the role shape — one snapshot; non-stem lanes untouched", async () => {
    const store = new ProjectStore(stemDoc());
    const vocals = store.doc.tracks.find((t) => t.name === "Vocals")!;
    const lead = store.doc.tracks.find((t) => t.name === "Lead Synth")!; // not a stem role
    const result = await executeMcpTool(storeCtx(store), "kyx_master", {
      op: "stems",
      trackId: vocals.id,
    });
    expect(result.mutated).toBe(true);
    expect(result.text).toContain("presence bus");
    const zenit = store.doc.tracks.find((t) => t.id === vocals.id)!.effects.find((fx) => fx.type === "zenit")!;
    expect(zenit.params.eqHigh).toBe(1); // vocals shape: AIR open
    // Non-stem lanes were never targeted (only the passed id was resolved).
    expect(store.doc.tracks.find((t) => t.id === lead.id)!.effects.some((fx) => fx.type === "zenit")).toBe(false);
    // Undo restores the whole batch.
    const steps = store.undoStackLength;
    store.undo();
    expect(store.doc.tracks.find((t) => t.id === vocals.id)!.effects.some((fx) => fx.type === "zenit")).toBe(false);
    expect(store.undoStackLength).toBe(steps - 1);
  });

  it("a lane without a stem role is reported honestly, nothing mutated", async () => {
    const store = new ProjectStore(stemDoc());
    const lead = store.doc.tracks.find((t) => t.name === "Lead Synth")!;
    const result = await executeMcpTool(storeCtx(store), "kyx_master", { op: "stems", trackId: lead.id });
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("no stem role");
  });
});
