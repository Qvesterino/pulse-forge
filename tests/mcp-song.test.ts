import { describe, it, expect } from "vitest";
import { executeMcpTool, executeMcpToolAsync, type McpToolContext } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { useDeterministicIds, resetDeterministicIds } from "../src/shared/ids";
import { ProjectStore } from "../src/store/ProjectStore";

/**
 * kyx_song — the MEGA producer move (Fáza D completion): generate the genre
 * song form (patterns per section), lay out scenes/clips/markers, apply the
 * measured mix profile — folded into ONE undo step. Async (the transports'
 * executor); the sync path answers honestly. Optional loudness target adds
 * a render-backed trim as a SECOND undo step (skipped honestly without a
 * render context).
 */

function storeCtx(store: ProjectStore, extra: Partial<McpToolContext> = {}): McpToolContext {
  return {
    getDoc: () => store.doc,
    execute: (command) => store.execute(command),
    undo: () => store.undo(),
    redo: () => store.redo(),
    undoStackLength: () => store.undoStackLength,
    historyLabels: () => store.history.map((entry) => entry.label),
    isMicRecordingActive: () => false,
    transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
    ...extra,
  };
}

function emptyArrangementStore(): ProjectStore {
  useDeterministicIds();
  resetDeterministicIds();
  const base = createProjectFromTemplate("house");
  const doc = { ...base, arrangement: { ...base.arrangement, clips: [] }, markers: [], scenes: [] };
  return new ProjectStore(doc);
}

describe("kyx_song (mega producer move)", () => {
  it("builds the whole track: sections land with patterns + mix, ONE undo step", async () => {
    const store = emptyArrangementStore();
    const ctx = storeCtx(store);
    const result = await executeMcpToolAsync(ctx, "kyx_song", { genre: "techno", energy: 0.8 });
    expect(result.mutated).toBe(true);
    expect(result.text).toContain("song 'techno' landed");
    expect(result.text).toContain("ONE undo step");

    const doc = store.doc;
    expect(doc.arrangement.clips.length).toBeGreaterThanOrEqual(5);
    // patterns were GENERATED per section (more than the template shipped)
    expect(doc.patterns.length).toBeGreaterThan(1);
    // scenes carry roles + intensity (the form laid out)
    expect(doc.scenes.filter((s) => s.role != null).length).toBe(doc.arrangement.clips.length);
    // the mix profile landed REAL effects (default mix: true)
    const drumTrack = doc.tracks.find((t) => t.kind === "drum");
    expect(drumTrack?.effects.some((fx) => fx.type === "compressor")).toBe(true);
    // ONE undo step restores the pre-song state
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(store.doc.arrangement.clips.length).toBe(0);
    expect(store.doc.tracks.every((t) => t.effects.length === 0)).toBe(true);
  }, 60_000);

  it("mix: false skips the profile; loudness without render context is skipped honestly", async () => {
    const store = emptyArrangementStore();
    const ctx = storeCtx(store);
    const result = await executeMcpToolAsync(ctx, "kyx_song", {
      genre: "house",
      mix: false,
      loudness: -14,
    });
    expect(result.mutated).toBe(true);
    expect(result.text).toContain("mix skipped");
    expect(result.text).toContain("loudness skipped: no render context bound");
    // the song engine lands its own genre-character FX even without the MCP
    // mix profile — with mix:true there must be MORE instances (the profile
    // decisions ride on top of the song's character)
    const withoutMix = store.doc.tracks.reduce((sum, t) => sum + t.effects.length, 0);
    const withMixStore = emptyArrangementStore();
    await executeMcpToolAsync(storeCtx(withMixStore), "kyx_song", { genre: "house" });
    const withMix = withMixStore.doc.tracks.reduce((sum, t) => sum + t.effects.length, 0);
    expect(withMix).toBeGreaterThan(withoutMix);
  }, 90_000);

  it("loudness target WITH a render context runs the trim as a second undo step", async () => {
    const store = emptyArrangementStore();
    const applied: Array<Record<string, unknown>> = [];
    const ctx = storeCtx(store, {
      measureLoudness: async () => ({ integrated: -20, measured: true }),
      applyLoudness: async (request) => {
        applied.push(request as Record<string, unknown>);
        return {
          ok: true,
          command: { type: "noop", label: "fake trim", execute: (d) => d, undo: (d) => d },
          report: { measuredBefore: -20, measuredAfter: -14, trim: 6, target: -14 },
        };
      },
    });
    const result = await executeMcpToolAsync(ctx, "kyx_song", { genre: "house", loudness: -14 });
    expect(result.mutated).toBe(true);
    expect(result.text).toContain("loudness -20 -> -14 LUFS");
    expect(result.text).toContain("second undo step");
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ targetDb: -14, direction: "louder" });
  }, 60_000);

  it("refuses on a non-empty arrangement; unknown genre is isError", async () => {
    const ctx = storeCtx(new ProjectStore(createProjectFromTemplate("house")));
    const refused = await executeMcpToolAsync(ctx, "kyx_song", { genre: "techno" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("already has clips");

    const bad = await executeMcpToolAsync(storeCtx(emptyArrangementStore()), "kyx_song", { genre: "quantum" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("unknown genre");
  }, 60_000);

  it("the sync path answers honestly instead of silently skipping", () => {
    const ctx = storeCtx(emptyArrangementStore());
    const sync = executeMcpTool(ctx, "kyx_song", { genre: "techno" });
    expect(sync.mutated).toBe(false);
    expect(sync.text).toContain("async executor");
  });
});
