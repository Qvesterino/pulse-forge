import { describe, it, expect } from "vitest";
import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * LIVE SCENE SWITCHING — kyx_transport launchScene + kyx_sections intensity.
 * The performance loop: kyx_state scenes (what can launch, where) →
 * launchScene (seek + play — runtime state, no undo) → intensity ride
 * (document mutation, one undo). Honest refusals when the transport cannot
 * seek or the scene does not exist.
 */

interface FakeTransport {
  seeks: number[];
  plays: number;
  play: () => void;
  stop: () => void;
  pause: () => void;
  setLoop: (enabled: boolean, start?: number, end?: number) => void;
  setMetronome: (enabled: boolean) => void;
  seek: (tick: number) => void;
}

function makeCtx(doc: ProjectDocument): { ctx: McpToolContext; transport: FakeTransport } {
  let current = doc;
  const transport: FakeTransport = {
    seeks: [],
    plays: 0,
    play: () => {
      transport.plays += 1;
    },
    stop: () => undefined,
    pause: () => undefined,
    setLoop: () => undefined,
    setMetronome: () => undefined,
    seek: (tick: number) => {
      transport.seeks.push(tick);
    },
  };
  const ctx: McpToolContext = {
    getDoc: () => current,
    execute: (command) => {
      current = command.execute(current);
    },
    undo: () => undefined,
    redo: () => undefined,
    undoStackLength: () => 0,
    historyLabels: () => [],
    isMicRecordingActive: () => false,
    transport,
  };
  return { ctx, transport };
}

describe("kyx_transport launchScene", () => {
  it("launches by name: seeks to the scene's first clip bar and plays", () => {
    const doc = createProjectFromTemplate("house");
    const drop = doc.scenes.find((s) => s.role === "drop") ?? doc.scenes[doc.scenes.length - 1];
    const dropClip = doc.arrangement.clips
      .filter((clip) => clip.sceneId === drop.id)
      .sort((a, b) => a.startBar - b.startBar)[0];
    const { ctx, transport } = makeCtx(doc);
    const r = executeMcpTool(ctx, "kyx_transport", { action: "launchScene", scene: drop.name });
    expect(r.mutated).toBe(false); // runtime state, never undo
    expect(transport.seeks).toEqual([dropClip.startBar * 1920]);
    expect(transport.plays).toBe(1);
    expect(r.text).toContain(drop.name);
    expect(r.text).toContain("playing");
  });

  it("launches by role and by 1-based index; play=false jumps stopped", () => {
    const doc = createProjectFromTemplate("house");
    const intro = doc.scenes.find((s) => s.role === "intro") ?? doc.scenes[0];
    const introClip = doc.arrangement.clips.find((clip) => clip.sceneId === intro.id);
    const { ctx, transport } = makeCtx(doc);
    if (intro.role) {
      const byRole = executeMcpTool(ctx, "kyx_transport", { action: "launchScene", scene: intro.role, play: false });
      expect(byRole.text).toContain("transport stopped");
      expect(transport.seeks).toEqual([introClip ? introClip.startBar * 1920 : 0]);
      expect(transport.plays).toBe(0);
    }
    const byIndex = executeMcpTool(ctx, "kyx_transport", { action: "launchScene", index: 1 });
    expect(byIndex.mutated).toBe(false);
    expect(transport.seeks.length).toBeGreaterThanOrEqual(1);
  });

  it("refuses honestly without a seek-capable transport and for unknown scenes", () => {
    const doc = createProjectFromTemplate("house");
    const noSeekCtx = makeCtx(doc).ctx;
    const bare: McpToolContext = {
      ...noSeekCtx,
      transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
    };
    const refused = executeMcpTool(bare, "kyx_transport", { action: "launchScene", scene: "drop" });
    expect(refused.text).toContain("not available over this MCP transport");
    expect(refused.mutated).toBe(false);

    const { ctx } = makeCtx(doc);
    const unknown = executeMcpTool(ctx, "kyx_transport", { action: "launchScene", scene: "nonexistent-groove" });
    expect(unknown.text).toContain("no scene matches");
    expect(unknown.text).toContain("kyx_state");
  });

  it("scenes read-back carries the launch address (@bar N)", () => {
    const doc = createProjectFromTemplate("house");
    const { ctx } = makeCtx(doc);
    const r = executeMcpTool(ctx, "kyx_state", { subject: "scenes" });
    expect(r.text).toMatch(/@bar \d+/);
    expect(r.text).toMatch(/\d+\. "/);
  });
});

describe("kyx_sections intensity", () => {
  it("rides a scene's intensity — document mutation, one undo step", () => {
    const doc = createProjectFromTemplate("house");
    const drop = doc.scenes.find((s) => s.role === "drop") ?? doc.scenes[doc.scenes.length - 1];
    const { ctx } = makeCtx(doc);
    const r = executeMcpTool(ctx, "kyx_sections", { op: "intensity", index: doc.scenes.indexOf(drop) + 1, value: 0.9 });
    expect(r.mutated).toBe(true);
    expect(ctx.getDoc().scenes.find((s) => s.id === drop.id)?.intensity).toBeCloseTo(0.9);
    expect(r.text).toContain("90%");
  });

  it("validates the 0..1 range and unknown scenes", () => {
    const doc = createProjectFromTemplate("house");
    const { ctx } = makeCtx(doc);
    const real = doc.scenes[0];
    const range = executeMcpTool(ctx, "kyx_sections", { op: "intensity", scene: real.name, value: 1.5 });
    expect(range.text).toContain("0..1");
    const ghost = executeMcpTool(ctx, "kyx_sections", { op: "intensity", scene: "phantom-groove", value: 0.5 });
    expect(ghost.text).toContain("no scene matches");
  });
});
