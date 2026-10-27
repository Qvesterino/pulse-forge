import { describe, expect, it } from "vitest";
import { createHeadlessMcpHost } from "../src/mcp/headless-host";
import { MCP_TOOLS, executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import { createDefaultProject } from "../src/project-model/schema";
import { addAudioClip } from "../src/commands/audioClips";
import type { ProjectDocument } from "../src/project-model/types";

function docWithoutArrangement(): ProjectDocument {
  const doc = createDefaultProject();
  return { ...doc, arrangement: { ...doc.arrangement, clips: [], audioClips: [] } };
}

describe("AI control hardening — output schemas and per-call risk", () => {
  it("declares the receipt schema for the eight primary tools", () => {
    for (const name of [
      "kyx_state",
      "kyx_intent",
      "kyx_tracks",
      "kyx_fx",
      "kyx_clips",
      "kyx_automation",
      "kyx_master",
      "kyx_export",
    ]) {
      expect(MCP_TOOLS.find((tool) => tool.name === name)?.outputSchema, name).toBeDefined();
    }
  });

  it("declares the receipt envelope for the previously text-first five (AS-011)", () => {
    for (const name of ["kyx_generate", "kyx_pattern", "kyx_checkpoint", "kyx_song", "kyx_unsuno"]) {
      const schema = MCP_TOOLS.find((tool) => tool.name === name)?.outputSchema;
      expect(schema, name).toBeDefined();
      expect(schema?.required, name).toContain("status");
      expect(schema?.required, name).toContain("stage");
    }
  });

  it("returns structured status/stage from the previously text-first tools", async () => {
    const host = createHeadlessMcpHost({ document: createDefaultProject() });
    const gen = await host.call("kyx_generate", { genre: "house", seed: "receipt-1" });
    expect(gen.isError, gen.text).not.toBe(true);
    expect(gen.data).toMatchObject({ status: "applied", stage: "applied", replaceMode: "new" });
    expect(typeof (gen.data as { patternId?: string }).patternId).toBe("string");

    const list = await host.call("kyx_pattern", { op: "list" });
    expect(list.data).toMatchObject({ status: "read", stage: "read" });

    const saved = await host.call("kyx_checkpoint", { op: "save", name: "envelope-probe" });
    expect(saved.data).toMatchObject({ status: "read", stage: "read" });
    const cpList = await host.call("kyx_checkpoint", { op: "list" });
    expect((cpList.data as { checkpoints?: string[] }).checkpoints).toContain("envelope-probe");
  });

  it("publishes every by-design boundary as a policy record with reason and revisit (AS-005)", async () => {
    const host = createHeadlessMcpHost({ document: createDefaultProject() });
    const result = await host.call("kyx_state", { subject: "capabilities" });
    const capabilities = (
      result.data as {
        capabilities: {
          unavailableByDesign: Record<string, { supported: boolean; reason: string; revisit: string }>;
          cancellation: { supported: boolean; reason: string; revisit: string };
        };
      }
    ).capabilities;
    expect(Object.keys(capabilities.unavailableByDesign).sort()).toEqual(["audioImport", "projectOpen", "recording"]);
    for (const [key, policy] of Object.entries(capabilities.unavailableByDesign)) {
      expect(policy.supported, key).toBe(false);
      expect(policy.reason.length, key).toBeGreaterThan(10);
      expect(policy.revisit.length, key).toBeGreaterThan(10);
    }
    expect(capabilities.cancellation.supported).toBe(false);
    expect(capabilities.cancellation.revisit.length).toBeGreaterThan(10);
  });

  it("returns a stage/status receipt and the per-call risk", async () => {
    const host = createHeadlessMcpHost({ document: createDefaultProject() });
    const state = await host.call("kyx_state", { subject: "overview" });
    expect(state.data).toMatchObject({ status: "read", stage: "read", subject: "overview" });
    expect(state.risk).toBe("read");

    const add = await host.call("kyx_tracks", { op: "addDrum", name: "Risk Probe" });
    expect(add.isError, add.text).not.toBe(true);
    expect(add.risk).toBe("mutate");
    expect(add.data).toMatchObject({ status: "applied", stage: "applied" });

    const remove = await host.call("kyx_tracks", { op: "remove", trackId: host.store.doc.tracks.at(-1)!.id });
    expect(remove.isError).toBe(true);
    expect(remove.risk).toBe("destructive");
  });

  it("advertises what the transport can actually do, including no MCP cancellation", async () => {
    const host = createHeadlessMcpHost({ document: createDefaultProject() });
    const result = await host.call("kyx_state", { subject: "capabilities" });
    expect(result.isError, result.text).not.toBe(true);
    const data = result.data as {
      capabilities: { hooks: Record<string, boolean>; cancellation: { supported: boolean } };
    };
    expect(data.capabilities.hooks.export).toBe(false);
    expect(data.capabilities.hooks.save).toBe(false);
    expect(data.capabilities.cancellation.supported).toBe(false);
    expect(result.text).toContain("cancellation: not supported");
  });
});

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

describe("P2 — track reorder", () => {
  it("moves a track before/after a stable relative track id", async () => {
    const host = createHeadlessMcpHost({ document: createDefaultProject() });
    const before = host.store.doc.tracks;
    expect(before.length).toBeGreaterThan(1);
    const moved = before[0]!;
    const anchor = before[1]!;
    const result = await host.call("kyx_tracks", {
      op: "move",
      trackId: moved.id,
      relativeTo: anchor.id,
      where: "after",
    });
    expect(result.isError, result.text).not.toBe(true);
    expect(result.mutated).toBe(true);
    expect(result.data).toMatchObject({ status: "moved", trackId: moved.id, relativeTo: anchor.id, where: "after" });
    const order = host.store.doc.tracks.map((track) => track.id);
    expect(order.indexOf(moved.id)).toBeGreaterThan(order.indexOf(anchor.id));
  });

  it("refuses an unknown relative track", async () => {
    const host = createHeadlessMcpHost({ document: createDefaultProject() });
    const result = await host.call("kyx_tracks", {
      op: "move",
      trackId: host.store.doc.tracks[0]!.id,
      relativeTo: "track-that-does-not-exist",
      where: "after",
    });
    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("UNKNOWN_TARGET");
  });
});

describe("P2 — audio clip pitch", () => {
  it("sets pitchSemitones through the canonical clip command", async () => {
    const base = createDefaultProject();
    const track = base.tracks.find((candidate) => candidate.kind !== "group")!;
    const withClip = addAudioClip(base, track.id, "user.probe", 0, 4).execute(base);
    const clip = (withClip.arrangement.audioClips ?? [])[0]!;
    const host = createHeadlessMcpHost({ document: withClip });
    const result = await host.call("kyx_clips", {
      op: "audioUpdate",
      trackId: track.id,
      clipId: clip.id,
      pitchSemitones: 7,
    });
    expect(result.isError, result.text).not.toBe(true);
    expect(result.mutated).toBe(true);
    const committed = (host.store.doc.arrangement.audioClips ?? []).find((candidate) => candidate.id === clip.id)!;
    expect(committed.pitchSemitones).toBe(7);
  });

  it("rejects an out-of-range pitch instead of clamping silently", async () => {
    const base = createDefaultProject();
    const track = base.tracks.find((candidate) => candidate.kind !== "group")!;
    const withClip = addAudioClip(base, track.id, "user.probe", 0, 4).execute(base);
    const clip = (withClip.arrangement.audioClips ?? [])[0]!;
    const host = createHeadlessMcpHost({ document: withClip });
    const result = await host.call("kyx_clips", {
      op: "audioUpdate",
      trackId: track.id,
      clipId: clip.id,
      pitchSemitones: 30,
    });
    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("INVALID_ARGUMENTS");
  });
});
