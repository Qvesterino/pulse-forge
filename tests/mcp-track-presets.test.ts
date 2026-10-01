import { describe, it, expect } from "vitest";
import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * kyx_tracks loadPreset/listPresets — factory preset loading for agents:
 * fuzzy name resolution + family-wide fold (the text layer's etiquette),
 * one undo snapshot, per-track verification read-back, honest suggestions
 * for unknown names, and discovery via listPresets.
 */

function makeCtx(doc: ProjectDocument): McpToolContext {
  let current = doc;
  return {
    getDoc: () => current,
    execute: (command) => {
      current = command.execute(current);
    },
    undo: () => undefined,
    redo: () => undefined,
    undoStackLength: () => 0,
    historyLabels: () => [],
    isMicRecordingActive: () => false,
    transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
  };
}

describe("kyx_tracks preset loading", () => {
  it("loadPreset resolves a fuzzy name and lands the preset on the family's tracks", () => {
    const ctx = makeCtx(createProjectFromTemplate("house"));
    const r = executeMcpTool(ctx, "kyx_tracks", { op: "loadPreset", presetName: "Warm Sub", family: "bass" });
    expect(r.mutated).toBe(true);
    expect(r.text).toContain("Warm Sub");
    expect(r.text).toContain("✓"); // per-track verification read-back
    const instrument = ctx.getDoc().tracks.find((t) => t.kind === "instrument");
    expect(instrument?.presetId).toContain("warmsub");
  });

  it("unknown preset answers with suggestions instead of guessing", () => {
    const ctx = makeCtx(createProjectFromTemplate("house"));
    const before = ctx.getDoc();
    const r = executeMcpTool(ctx, "kyx_tracks", { op: "loadPreset", presetName: "zzzblorp", family: "bass" });
    expect(r.mutated).toBe(false);
    expect(r.text).toContain("unknown preset");
    expect(r.text).toContain("did you mean");
    expect(r.text).toContain("listPresets");
    expect(ctx.getDoc()).toBe(before); // nothing mutated
  });

  it("missing presetName is an honest validation error", () => {
    const ctx = makeCtx(createProjectFromTemplate("house"));
    const r = executeMcpTool(ctx, "kyx_tracks", { op: "loadPreset", family: "bass" });
    expect(r.text).toContain("needs presetName");
    expect(r.mutated).toBe(false);
  });

  it("listPresets lists the factory bank, family-fitting entries ordered first", () => {
    const ctx = makeCtx(createProjectFromTemplate("house"));
    const bass = executeMcpTool(ctx, "kyx_tracks", { op: "listPresets", family: "bass" });
    expect(bass.mutated).toBe(false);
    expect(bass.text).toMatch(/\d+ factory presets/);
    // the fitting count is real: bass-fitting presets exist and lead the listing
    const data = bass.data as { family: string; fitting: number; total: number };
    expect(data.family).toBe("bass");
    expect(data.fitting).toBeGreaterThan(0);
    expect(data.total).toBeGreaterThan(data.fitting);
    // the FIRST listed line is a family-fitting instrument (bass/808/logdrum)
    const first = bass.text.split(": ")[1]?.split(";")[0] ?? "";
    expect(first).toMatch(/\((?:bass|808|logdrum)\)$/);
  });

  it("listPresets query filters the listing", () => {
    const ctx = makeCtx(createProjectFromTemplate("house"));
    const r = executeMcpTool(ctx, "kyx_tracks", { op: "listPresets", family: "bass", query: "warm" });
    expect(r.text.toLowerCase()).toContain("warm");
    expect((r.data as { total: number }).total).toBeGreaterThan(0);
  });
});
