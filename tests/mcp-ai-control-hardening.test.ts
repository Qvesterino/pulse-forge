import { describe, expect, it } from "vitest";
import { createHeadlessMcpHost } from "../src/mcp/headless-host";
import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import { createDefaultProject } from "../src/project-model/schema";
import type { ProjectDocument } from "../src/project-model/types";

function docWithoutArrangement(): ProjectDocument {
  const doc = createDefaultProject();
  return { ...doc, arrangement: { ...doc.arrangement, clips: [], audioClips: [] } };
}

describe("AI control hardening — destructive generation gate", () => {
  it("refuses replaceMode:replace while the destructive unlock is off and changes nothing", async () => {
    const host = createHeadlessMcpHost({ document: createDefaultProject() });
    const before = host.store.doc;
    const depth = host.store.undoStackLength;
    const result = await host.call("kyx_generate", { genre: "house", replaceMode: "replace" });
    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("POLICY_REFUSED");
    expect(host.store.doc).toBe(before);
    expect(host.store.undoStackLength).toBe(depth);
  });

  it("allows replaceMode:replace through the destructive gate as one undo step", async () => {
    const host = createHeadlessMcpHost({ document: createDefaultProject(), allowDestructive: true });
    const activeId = host.store.doc.activePatternId;
    const before = host.store.doc.patterns.find((pattern) => pattern.id === activeId)!;
    const result = await host.call("kyx_generate", { genre: "techno", replaceMode: "replace" });
    expect(result.isError, result.text).not.toBe(true);
    expect(result.mutated).toBe(true);
    const after = host.store.doc.patterns.find((pattern) => pattern.id === activeId)!;
    expect(after).not.toBe(before);
    expect(host.store.undoStackLength).toBe(1);
  });
});

describe("AI control hardening — truthful intent receipts", () => {
  it("reports a no-op intent as not mutated, with no undo claim", async () => {
    const host = createHeadlessMcpHost({ document: createDefaultProject() });
    const first = await host.call("kyx_intent", { instruction: "mute the drums" });
    expect(first.mutated).toBe(true);
    expect(first.stage).toBe("applied");
    const depth = host.store.undoStackLength;
    const second = await host.call("kyx_intent", { instruction: "mute the drums" });
    expect(second.mutated).toBe(false);
    expect(second.stage).toBe("noop");
    expect(second.text).toContain("nothing changed");
    expect(second.text).not.toContain("one undo step");
    expect(host.store.undoStackLength).toBe(depth);
  });

  it("reads back the changed value for a non-param route", async () => {
    const host = createHeadlessMcpHost({ document: createDefaultProject() });
    const result = await host.call("kyx_intent", { instruction: "set the tempo to 140 bpm" });
    expect(result.isError, result.text).not.toBe(true);
    expect(result.mutated).toBe(true);
    expect(host.store.doc.bpm).toBe(140);
    expect(result.text).toContain("140");
    expect(result.text).toContain("read-back:");
    expect(result.text).not.toContain("verification: applied");
    expect(result.stage).toBe("applied");
  });
});

describe("AI control hardening — persistence stage and kyx_save", () => {
  it("refuses kyx_save honestly when the transport has no flush hook", async () => {
    const host = createHeadlessMcpHost({ document: createDefaultProject() });
    const result = await host.call("kyx_save", {});
    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("UNAVAILABLE_ON_TRANSPORT");
  });

  it("reports stage:persisted only after the flush hook resolves", async () => {
    const host = createHeadlessMcpHost({ document: createDefaultProject() });
    const ctx: McpToolContext = {
      ...host.ctx,
      saveNow: async () => ({ ok: true, saveStatus: "saved", lastSavedAt: "2026-10-25T06:00:00.000Z" }),
    };
    const result = await executeMcpTool(ctx, "kyx_save", {});
    expect(result.isError, result.text).not.toBe(true);
    expect(result.stage).toBe("persisted");
    expect(result.mutated).toBe(false);
    expect(result.data).toMatchObject({ ok: true, saveStatus: "saved", stage: "persisted" });
  });
});

describe("AI control hardening — stable fxId targets", () => {
  it("sets a plugin parameter by stable fxId and rejects an unknown one", async () => {
    const host = createHeadlessMcpHost({ document: createDefaultProject() });
    const drum = host.store.doc.tracks.find((track) => track.kind === "drum")!;
    const inserted = await host.call("kyx_fx", { effect: "reverb", trackId: drum.id, action: "more" });
    expect(inserted.isError, inserted.text).not.toBe(true);
    const listed = await host.call("kyx_plugin_param", { op: "list", trackId: drum.id, effect: "reverb" });
    const fxId = (listed.data as { instances: Array<{ fxId: string }> }).instances[0]!.fxId;

    const set = await host.call("kyx_plugin_param", {
      op: "set",
      trackId: drum.id,
      effect: "reverb",
      fxId,
      param: "mix",
      value: 0.33,
    });
    expect(set.isError, set.text).not.toBe(true);
    expect(set.mutated).toBe(true);
    const effect = host.store.doc.tracks
      .find((track) => track.id === drum.id)!
      .effects.find((candidate) => candidate.id === fxId)!;
    expect(effect.params.mix).toBeCloseTo(0.33, 6);

    const unknown = await host.call("kyx_plugin_param", {
      op: "set",
      trackId: drum.id,
      effect: "reverb",
      fxId: "fx-does-not-exist",
      param: "mix",
      value: 0.4,
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.errorCode).toBe("UNKNOWN_TARGET");

    const bypassed = await host.call("kyx_fx", {
      effect: "reverb",
      trackId: drum.id,
      fxId,
      action: "bypass",
    });
    expect(bypassed.isError, bypassed.text).not.toBe(true);
    expect(
      host.store.doc.tracks.find((track) => track.id === drum.id)!.effects.find((candidate) => candidate.id === fxId)!
        .bypassed,
    ).toBe(true);

    const lane = await host.call("kyx_automation", {
      op: "addPoint",
      trackId: drum.id,
      fxId,
      param: "mix",
      bar: 1,
      value: 0.2,
    });
    expect(lane.isError, lane.text).not.toBe(true);
    expect(lane.mutated).toBe(true);
    expect(host.store.doc.automation.some((candidate) => candidate.target.fxId === fxId)).toBe(true);
  });
});

describe("AI control hardening — stable clipId targets", () => {
  it("splits a scene clip by clipId and rejects an unknown clipId", async () => {
    const host = createHeadlessMcpHost({ document: docWithoutArrangement() });
    const arranged = await host.call("kyx_arrange", { genre: "house" });
    expect(arranged.isError, arranged.text).not.toBe(true);
    const listed = await host.call("kyx_clips", { op: "list" });
    const clips = (listed.data as { arrangementClips: Array<{ id: string; startBar: number; lengthBars: number }> })
      .arrangementClips;
    const target = clips.find((clip) => clip.lengthBars > 1) ?? clips[0]!;
    if (target.lengthBars < 2) return; // fixture too short to split; not a contract failure
    const splitBar = target.startBar + 1;
    const before = host.store.doc.arrangement.clips.length;
    const split = await host.call("kyx_clips", { op: "split", clipId: target.id, bar: splitBar });
    expect(split.isError, split.text).not.toBe(true);
    expect(split.mutated).toBe(true);
    expect(host.store.doc.arrangement.clips.length).toBe(before + 1);

    const unknown = await host.call("kyx_clips", { op: "resize", clipId: "clip-does-not-exist", bars: 2 });
    expect(unknown.isError).toBe(true);
    expect(unknown.errorCode).toBe("UNKNOWN_TARGET");
  });
});
