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
    // The ISOLATED writer every MCP write lands through (`83ed86d5`). A host
    // without it has its write refused — so the harness exposes the real one.
    executeAgentCommand: (command, frameToken) => store.executeAgentCommand(command, frameToken),
    beginOwnedUndoFrame: (label) => store.beginOwnedUndoFrame(label),
    endOwnedUndoFrame: (token) => store.endOwnedUndoFrame(token),
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
    expect(result.data).toMatchObject({
      status: "applied",
      genre: "techno",
      decisionCount: expect.any(Number),
      summary: expect.any(Array),
    });
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
    expect(again.data).toMatchObject({ status: "already_matched", genre: "techno" });

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
    const before = store.doc;
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
    expect(result.data).toMatchObject({
      status: "arranged",
      genre: "house",
      sceneCount: 7,
      clipCount: 7,
      cueMarkerCount: 7,
      totalBars: expect.any(Number),
      undoSteps: 1,
    });
    const data = result.data as {
      scenes: Array<{ id: string }>;
      sections: Array<{ startBar: number }>;
      clips: Array<{ id: string; startBar: number }>;
      markers: Array<{ id: string; tick: number }>;
      totalBars: number;
    };
    expect(data.scenes.every((scene) => !before.scenes.some((item) => item.id === scene.id))).toBe(true);
    expect(data.scenes.every((scene) => doc.scenes.some((item) => item.id === scene.id))).toBe(true);
    expect(data.clips.every((clip) => doc.arrangement.clips.some((item) => item.id === clip.id))).toBe(true);
    expect(data.markers.every((marker) => doc.markers.some((item) => item.id === marker.id))).toBe(true);
    expect(data.sections[0]?.startBar).toBe(1);
    expect(data.clips[0]?.startBar).toBe(0);
    expect(data.markers[0]?.tick).toBe(0);
    expect(data.totalBars).toBe(
      data.clips.reduce((sum, clip) => sum + doc.arrangement.clips.find((item) => item.id === clip.id)!.lengthBars, 0),
    );
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
    expect(mix?.inputSchema.properties.mood).toMatchObject({ maxLength: 128 });
    expect(mix?.outputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["status", "genre", "decisionCount", "summary"],
    });
    expect(arrange?.outputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: [
        "status",
        "genre",
        "sections",
        "scenes",
        "clips",
        "markers",
        "sceneCount",
        "clipCount",
        "cueMarkerCount",
        "placementMismatchCount",
        "totalBars",
        "undoSteps",
      ],
    });
  });

  it("rejects malformed arrangement options before changing the document", async () => {
    const store = cleanStore();
    const ctx = storeCtx(store);
    const before = JSON.stringify(store.doc);
    const invalid = [
      { genre: ["house"] },
      { genre: "house", energy: Number.NaN },
      { genre: "house", energy: -0.01 },
      { genre: "house", energy: 1.01 },
      { genre: "house", length: "unbounded" },
      { genre: "house", length: 123 },
    ];
    for (const args of invalid) {
      const result = await executeMcpToolAsync(ctx, "kyx_arrange", args);
      expect(result.errorCode).toBe("INVALID_ARGUMENTS");
      expect(result.isError).toBe(true);
    }
    expect(JSON.stringify(store.doc)).toBe(before);
  });

  it("rejects malformed optional controls instead of silently ignoring them", async () => {
    const store = cleanStore();
    const ctx = storeCtx(store);
    const before = JSON.stringify(store.doc);
    const invalid = [
      { genre: "techno", mood: "m".repeat(129) },
      { genre: "techno", energy: Number.NaN },
      { genre: "techno", energy: 1.01 },
      { genre: "techno", tone: "neon" },
      { genre: "techno", tone: ["dark"] },
      { genre: "techno", reverb: "maximum" },
      { genre: "techno", punch: "huge" },
      { genre: "techno", pump: "maybe" },
      { genre: "techno", pump: true },
    ];
    for (const args of invalid) {
      const result = await executeMcpTool(ctx, "kyx_mix", args);
      expect(result.errorCode).toBe("INVALID_ARGUMENTS");
      expect(result.isError).toBe(true);
    }
    expect(JSON.stringify(store.doc)).toBe(before);
  });
});
