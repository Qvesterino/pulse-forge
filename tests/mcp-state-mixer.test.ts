import { describe, it, expect } from "vitest";
import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * kyx_state subject:"mixer" — the ONE-CALL mix board for mixing agents:
 * every strip's fader (linear + dB), pan, mute/solo, preset, FX chain, send
 * levels, group membership, master and return faders in one read — plus the
 * structured `data` twin so an agent can diff numbers without parsing text.
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

describe("kyx_state mixer snapshot", () => {
  it("lists every strip with fader, pan and id in one call", () => {
    const ctx = makeCtx(createProjectFromTemplate("house"));
    const r = executeMcpTool(ctx, "kyx_state", { subject: "mixer" });
    expect(r.mutated).toBe(false);
    const doc = ctx.getDoc();
    for (const track of doc.tracks) {
      if (track.kind === "group") continue;
      expect(r.text).toContain(track.name);
    }
    expect(r.text).toMatch(/gain -?[\d.]+ dB/);
    expect(r.text).toContain("pan C");
  });

  it("reflects mutations — a setGain then setMute show up in the next read", () => {
    const ctx = makeCtx(createProjectFromTemplate("house"));
    executeMcpTool(ctx, "kyx_tracks", { op: "setGain", family: "bass", gainDb: -6 });
    executeMcpTool(ctx, "kyx_tracks", { op: "setMute", family: "bass", value: true });
    const r = executeMcpTool(ctx, "kyx_state", { subject: "mixer" });
    expect(r.text).toMatch(/-6\.0 dB/);
    expect(r.text).toContain("MUTED");
  });

  it("carries the structured data twin with numbers, not text", () => {
    const ctx = makeCtx(createProjectFromTemplate("house"));
    const r = executeMcpTool(ctx, "kyx_state", { subject: "mixer" });
    const data = r.data as {
      master: { gainDb: number } | null;
      returns: Array<{ id: string; gainDb: number }>;
      tracks: Array<{ id: string; gainDb: number; pan: number; mute: boolean; sends: Record<string, number> }>;
    };
    expect(data.master).not.toBeNull();
    expect(typeof data.master!.gainDb).toBe("number");
    expect(Array.isArray(data.returns)).toBe(true);
    expect(data.tracks.length).toBeGreaterThan(0);
    for (const track of data.tracks) {
      expect(typeof track.gainDb).toBe("number");
      expect(typeof track.mute).toBe("boolean");
      expect(typeof track.sends).toBe("object");
    }
  });

  it("shows presets on strips that carry one", () => {
    const ctx = makeCtx(createProjectFromTemplate("house"));
    executeMcpTool(ctx, "kyx_tracks", { op: "loadPreset", presetName: "Warm Sub", family: "bass" });
    const r = executeMcpTool(ctx, "kyx_state", { subject: "mixer" });
    expect(r.text).toContain("preset=Warm Sub");
    const data = r.data as { tracks: Array<{ presetId?: string | null }> };
    expect(data.tracks.some((t) => t.presetId !== null && t.presetId !== undefined)).toBe(true);
  });
});
