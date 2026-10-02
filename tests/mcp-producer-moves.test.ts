import { describe, it, expect } from "vitest";
import { executeMcpTool, executeMcpToolAsync, MCP_TOOLS, type McpToolContext } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { useDeterministicIds, resetDeterministicIds } from "../src/shared/ids";
import { ProjectStore } from "../src/store/ProjectStore";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * PRODUCER MOVES (Fáza D, docs/AGENTIC-DAW-PLAN.md) — kyx_mix and
 * kyx_arrange: one-call, whole-gesture operations over the measured mix
 * engine and the song-form planner. ONE undo step each; honest refusals.
 */

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
  };
}

function cleanStore(): ProjectStore {
  useDeterministicIds();
  resetDeterministicIds();
  const doc: ProjectDocument = {
    ...createProjectFromTemplate("house"),
    arrangement: { ...createProjectFromTemplate("house").arrangement, clips: [] },
    markers: [],
  };
  return new ProjectStore(doc);
}

describe("kyx_mix (producer move)", async () => {
  it("applies the dark techno profile: eq/pump decisions land, ONE undo step", async () => {
    const store = cleanStore();
    const ctx = storeCtx(store);
    const result = await executeMcpTool(ctx, "kyx_mix", { genre: "techno", energy: 0.8 });
    expect(result.mutated).toBe(true);
    expect(result.text).toContain("mix applied");
    expect(result.text).toContain("one undo step");
    // the measured profile lands REAL effects (drums compressor + saturation,
    // instrument EQ, sidechain pump — the D1 mix wave contract)
    const drumTrack = store.doc.tracks.find((t) => t.kind === "drum")!;
    expect(drumTrack.effects.some((fx) => fx.type === "compressor")).toBe(true);
    const instruments = store.doc.tracks.filter((t) => t.kind === "instrument");
    expect(instruments.some((t) => t.effects.some((fx) => fx.type === "pump"))).toBe(true);
    expect(store.undoStackLength).toBe(1);
  });

  it("overrides steer the profile (huge reverb, pump off)", async () => {
    const store = cleanStore();
    const ctx = storeCtx(store);
    const result = await executeMcpTool(ctx, "kyx_mix", { genre: "house", reverb: "huge", pump: "off" });
    expect(result.mutated).toBe(true);
    expect(result.text.toLowerCase()).toContain("reverb");
    const instruments = store.doc.tracks.filter((t) => t.kind === "instrument");
    expect(instruments.some((t) => t.effects.some((fx) => fx.type === "pump"))).toBe(false);
  });

  it("second identical apply is an honest no-op; unknown genre is isError", async () => {
    const store = cleanStore();
    const ctx = storeCtx(store);
    await executeMcpTool(ctx, "kyx_mix", { genre: "techno", energy: 0.8 });
    const again = await executeMcpTool(ctx, "kyx_mix", { genre: "techno", energy: 0.8 });
    expect(again.mutated).toBe(false);
    expect(again.isError).toBeUndefined();
    expect(again.text).toContain("changed nothing");

    const bad = await executeMcpTool(ctx, "kyx_mix", { genre: "quantum" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("unknown genre");
  });

  it("undo restores the pristine mix (zero effects)", async () => {
    const store = cleanStore();
    const ctx = storeCtx(store);
    await executeMcpTool(ctx, "kyx_mix", { genre: "drill" });
    store.undo();
    expect(store.doc.tracks.every((t) => t.effects.length === 0)).toBe(true);
  });
});

describe("kyx_arrange (producer move)", async () => {
  it("lays out the house form as scenes + clips + markers in ONE undo step", async () => {
    const store = cleanStore();
    const ctx = storeCtx(store);
    const result = await executeMcpToolAsync(ctx, "kyx_arrange", { genre: "house" });
    expect(result.mutated).toBe(true);
    expect(result.text).toContain("arranged 'house' form");
    expect(result.text).toContain("one undo step");

    const doc = store.doc;
    // the house form is 7 sections (the template may ship its own scene)
    expect(result.text).toContain("7 scenes");
    expect(doc.arrangement.clips.length).toBe(7);
    // every scene has a role; every section got a clip + a cue marker
    expect(doc.scenes.filter((s) => s.role != null).length).toBeGreaterThanOrEqual(7);
    const starts = doc.arrangement.clips.map((c) => c.startBar).sort((a, b) => a - b);
    expect(starts[0]).toBe(0);
    expect(doc.markers.length).toBe(7);
    expect(store.undoStackLength).toBe(1);
    expect(result.text).toContain("intro");
  });

  it("length scaling: 'short' yields fewer total bars than 'extended'", async () => {
    const shortStore = cleanStore();
    const longStore = cleanStore();
    await executeMcpToolAsync(storeCtx(shortStore), "kyx_arrange", { genre: "techno", length: "short" });
    await executeMcpToolAsync(storeCtx(longStore), "kyx_arrange", { genre: "techno", length: "extended" });
    const barsOf = (store: ProjectStore): number =>
      store.doc.arrangement.clips.reduce((sum, clip) => sum + clip.lengthBars, 0);
    expect(barsOf(longStore)).toBeGreaterThan(barsOf(shortStore));
  });

  it("refuses on a non-empty arrangement (surgical tools own that case)", async () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const ctx = storeCtx(store);
    const refused = await executeMcpToolAsync(ctx, "kyx_arrange", { genre: "house" });
    expect(refused.mutated).toBe(false);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("already has clips");
    expect(refused.text).toContain("kyx_sections");
  });

  it("unknown genre is an honest isError", async () => {
    const ctx = storeCtx(cleanStore());
    const bad = await executeMcpToolAsync(ctx, "kyx_arrange", { genre: "quantum" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("unknown genre");
  });
});

describe("producer moves surface", async () => {
  it("both tools are documented in MCP_TOOLS with genre enums", async () => {
    const mix = MCP_TOOLS.find((tool) => tool.name === "kyx_mix");
    const arrange = MCP_TOOLS.find((tool) => tool.name === "kyx_arrange");
    expect(mix?.inputSchema.required).toEqual(["genre"]);
    expect(arrange?.inputSchema.required).toEqual(["genre"]);
    const mixGenre = mix?.inputSchema.properties.genre as { enum?: string[] };
    expect(mixGenre.enum).toContain("techno");
    expect(mixGenre.enum).toContain("amapiano");
  });
});
