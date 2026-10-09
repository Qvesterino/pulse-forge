import { describe, expect, it } from "vitest";
import { collectDevices, diffSnapshots, type AbSnapshot } from "../src/mcp/master-ab";
import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import { ProjectStore } from "../src/store/ProjectStore";
import { createProjectFromTemplate } from "../src/project-model/templates";
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

function docWithDrums(): ProjectDocument {
  const base = createProjectFromTemplate("house");
  return base;
}

describe("A/B snapshot planner", () => {
  it("collectDevices gathers only the mastering family with params + trim", () => {
    const track = {
      id: "t1",
      name: "Drums",
      effects: [
        { id: "z1", type: "zenit", params: { limit: 0.4 }, outputTrimDb: -1.5 },
        { id: "eq1", type: "eq", params: { lowShelfGain: 3 } },
        { id: "a1", type: "apeks", params: { drive: 0.6 } },
      ],
    } as {
      id: string;
      name: string;
      effects: { id: string; type: string; params: Record<string, number>; outputTrimDb?: number }[];
    };
    const devices = collectDevices(track);
    expect(devices.map((d) => d.type)).toEqual(["zenit", "apeks"]);
    expect(devices[0]!.outputTrimDb).toBe(-1.5);
    expect(devices[0]!.params.limit).toBe(0.4);
  });

  it("diff reports every changed param plus the trim, matched by track+device", () => {
    const a: AbSnapshot = {
      name: "A",
      savedAt: "t0",
      devices: [
        {
          trackId: "t1",
          trackName: "Drums",
          fxId: "z1",
          type: "zenit",
          params: { limit: 0.4, glue: 0.2 },
          outputTrimDb: -1.5,
        },
      ],
    };
    const b: AbSnapshot = {
      name: "B",
      savedAt: "t1",
      devices: [
        {
          trackId: "t1",
          trackName: "Drums",
          fxId: "z1",
          type: "zenit",
          params: { limit: 0.6, glue: 0.2 },
          outputTrimDb: 0,
        },
      ],
    };
    const rows = diffSnapshots(a, b);
    expect(rows).toContainEqual({ device: "zenit", track: "Drums", param: "limit", a: 0.4, b: 0.6 });
    expect(rows).toContainEqual({ device: "zenit", track: "Drums", param: "outputTrimDb", a: -1.5, b: 0 });
    expect(rows).not.toContainEqual(expect.objectContaining({ param: "glue" }));
  });
});

describe("kyx_master op:ab — save / list / compare / restore", () => {
  it("save captures the bus, a mutation changes it, compare names the deltas, restore returns as one step", async () => {
    const store = new ProjectStore(docWithDrums());
    const ctx = storeCtx(store);
    await executeMcpTool(ctx, "kyx_master", { op: "add", family: "drums" });
    await executeMcpTool(ctx, "kyx_master", { op: "preset", family: "drums", target: "club" });

    const saved = await executeMcpTool(ctx, "kyx_master", { op: "ab", action: "save", name: "club", family: "drums" });
    expect(saved.mutated).toBe(false);
    expect(saved.text).toContain("club");

    await executeMcpTool(ctx, "kyx_master", { op: "preset", family: "drums", target: "streaming" });
    const compare = await executeMcpTool(ctx, "kyx_master", {
      op: "ab",
      action: "compare",
      name: "club",
      family: "drums",
    });
    expect(compare.mutated).toBe(false);
    expect(compare.text).toContain("limit");

    const restored = await executeMcpTool(ctx, "kyx_master", {
      op: "ab",
      action: "restore",
      name: "club",
      family: "drums",
    });
    expect(restored.mutated).toBe(true);
    const zenit = store.doc.tracks.find((t) => t.kind === "drum")!.effects.find((fx) => fx.type === "zenit")!;
    expect(zenit.params.limit).toBe(0.7); // back to the club shape
    // The restore is ONE undoable step.
    const steps = store.undoStackLength;
    store.undo();
    expect(store.undoStackLength).toBe(steps - 1);
    expect(
      store.doc.tracks.find((t) => t.kind === "drum")!.effects.find((fx) => fx.type === "zenit")!.params.limit,
    ).toBe(0.35);
  });

  it("unknown snapshot name refuses honestly; list shows what is saved", async () => {
    const store = new ProjectStore(docWithDrums());
    const ctx = storeCtx(store);
    const missing = await executeMcpTool(ctx, "kyx_master", {
      op: "ab",
      action: "restore",
      name: "ghost",
      family: "drums",
    });
    expect(missing.mutated).toBe(false);
    expect(missing.text).toContain("no snapshot");
    const listed = await executeMcpTool(ctx, "kyx_master", { op: "ab", action: "list" });
    expect(listed.mutated).toBe(false);
    expect(listed.text).toContain("club"); // the session store persists across ops
  });
});
