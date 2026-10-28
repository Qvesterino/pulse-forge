/**
 * Audit F-08 — a write aimed at a SPECIFIC instance either hits it or SAYS
 * it did not.
 *
 * The finding (STATE_DIVERGENCE_HUNTER_REPORT.md §4/F-08): the master A/B
 * restore resolved its target with
 *
 *   matchingDevices.find((fx) => fx.id === device.fxId) ?? matchingDevices[device.instanceIndex ?? 0]
 *
 * — a STALE ORDINAL FALLBACK. When the saved instance was gone (the user
 * deleted the device and added a different one of the same type), the write
 * landed on a DIFFERENT instance, and the acknowledgement named the SAVED
 * ordinal. The AI therefore read a plausible-looking success on the wrong
 * entity: exactly the "one intention, one authoritative transition, consistent
 * observable representations" failure the audit is about.
 *
 * Measured against today's tree, the `?? <ordinal>` fallback existed in
 * EXACTLY ONE place — the A/B restore. The report's claim that the same shape
 * also lived in the effect-instance and automation-target resolvers is not
 * true of today's code: those resolve by id and REFUSE explicitly when the id
 * does not match (`src/mcp/tools.ts` — the reorder resolver, the automation
 * target resolver and the plugin-param resolver). This file pins that
 * contrast so it cannot silently regress into a substitution.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ProjectStore } from "../src/store/ProjectStore";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { addEffectToTracks, removeEffectFromTracks } from "../src/commands/tracks";
import { setEffectParam } from "../src/commands/effectParams";
import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import type { Command } from "../src/commands/types";
import { withAgentWriter } from "./helpers/mcpAgentWriter";

function ctxCapturing(store: ProjectStore, captured: Command[]): McpToolContext {
  return withAgentWriter({
    getDoc: () => store.doc,
    execute: (command: Command) => {
      captured.push(command);
      store.execute(command);
    },
    undo: () => store.undo(),
    redo: () => store.redo(),
    undoStackLength: () => store.undoStackLength,
    historyLabels: () => store.history.map((e) => e.label),
    isMicRecordingActive: () => false,
    transport: { play() {}, stop() {}, pause() {}, setLoop() {}, setMetronome() {} },
  }) as unknown as McpToolContext;
}

describe("F-08 — a substitution is disclosed, never silent", () => {
  it("the A/B restore names the instance it ACTUALLY wrote to", async () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const captured: Command[] = [];
    const ctx = ctxCapturing(store, captured);
    const track = store.doc.tracks[0]!;

    store.execute(addEffectToTracks(store.doc, [track.id], "zenit"));
    const saved = store.doc.tracks.find((t) => t.id === track.id)!.effects[0]!;

    const save = await executeMcpTool(ctx, "kyx_master", {
      op: "ab",
      action: "save",
      name: "snap-f08",
      trackId: track.id,
    });
    expect(save.text).toContain("saved");

    // The saved instance is gone: the user deletes it and adds a DIFFERENT
    // device of the same type. The new instance has a NEW id.
    store.execute(removeEffectFromTracks(store.doc, [track.id], "zenit"));
    store.execute(addEffectToTracks(store.doc, [track.id], "zenit"));
    const replacement = store.doc.tracks.find((t) => t.id === track.id)!.effects[0]!;
    expect(replacement.id).not.toBe(saved.id);
    // Move the replacement away from the saved state, so the restore really
    // writes something (an identical device would leave the document
    // untouched, and the result would be a no-op rather than a substitution).
    store.execute(setEffectParam(store.doc, track.id, replacement.id, "drive", 0.42));

    const restore = await executeMcpTool(ctx, "kyx_master", {
      op: "ab",
      action: "restore",
      name: "snap-f08",
      trackId: track.id,
    });

    // The disclosure must be in the TEXT — that is what the AI reads.
    expect(restore.mutated).toBe(true);
    expect(restore.text).toMatch(/NOTE/);
    expect(restore.text).toContain(saved.id);
    expect(restore.text).toContain(replacement.id);

    // And the structured data carries the substitution too.
    const data = restore.data as { substitutions?: Array<{ savedFxId: string; appliedFxId: string }> } | undefined;
    expect(data?.substitutions).toBeDefined();
    expect(data!.substitutions!.length).toBe(1);
    expect(data!.substitutions![0]!.savedFxId).toBe(saved.id);
    expect(data!.substitutions![0]!.appliedFxId).toBe(replacement.id);
  });

  it("a restore that hits the saved instance discloses nothing", async () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const captured: Command[] = [];
    const ctx = ctxCapturing(store, captured);
    const track = store.doc.tracks[0]!;

    store.execute(addEffectToTracks(store.doc, [track.id], "zenit"));
    const saved = store.doc.tracks.find((t) => t.id === track.id)!.effects[0]!;
    await executeMcpTool(ctx, "kyx_master", {
      op: "ab",
      action: "save",
      name: "snap-f08-clean",
      trackId: track.id,
    });
    // The saved instance is still there, but its state drifted.
    store.execute(setEffectParam(store.doc, track.id, saved.id, "drive", 0.42));

    const restore = await executeMcpTool(ctx, "kyx_master", {
      op: "ab",
      action: "restore",
      name: "snap-f08-clean",
      trackId: track.id,
    });
    expect(restore.mutated).toBe(true);
    expect(restore.text).not.toMatch(/NOTE/);
    const data = restore.data as { substitutions?: unknown[] } | undefined;
    expect(data?.substitutions ?? []).toEqual([]);
  });

  it("the ONE ordinal fallback left in the MCP layer is the A/B restore's, and it discloses", () => {
    const source = readFileSync(path.resolve(process.cwd(), "src/mcp/tools.ts"), "utf8");
    const lines = source.split(/\r?\n/);
    // The F-08 shape: an instance lookup that falls back to an ORDINAL.
    const fallbacks = lines
      .map((line, index) => ({ line, index }))
      .filter(
        ({ line }) => /matchingDevices\s*\[/.test(line) || /effects\.find\([^)]*\)\s*\?\?\s*\w*effects\s*\[/.test(line),
      );
    // Exactly ONE — the A/B restore. The report claimed the same shape also
    // lived in the effect-instance and automation-target resolvers; measured
    // against today's tree it does not (those refuse explicitly), and this
    // pin keeps it from creeping back in.
    expect(fallbacks.length).toBe(1);
    // And that one is DISCLOSED: the substitution is recorded right beside it.
    const window = lines.slice(Math.max(0, fallbacks[0]!.index - 40), fallbacks[0]!.index + 40).join("\n");
    expect(window).toContain("substitutions");
    expect(window).toMatch(/substitutions\.push\(/);
  });

  it("the plugin-param resolver REFUSES when the fxId does not match", async () => {
    // The typed contrast the report names: a resolver that is given an id
    // must not silently pick another instance.
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const captured: Command[] = [];
    const ctx = ctxCapturing(store, captured);
    const track = store.doc.tracks[0]!;
    store.execute(addEffectToTracks(store.doc, [track.id], "zenit"));
    const real = store.doc.tracks.find((t) => t.id === track.id)!.effects[0]!;
    const before = { ...real.params };

    const res = await executeMcpTool(ctx, "kyx_plugin_param", {
      op: "set",
      trackId: track.id,
      effect: "zenit",
      fxId: "fx-does-not-exist",
      param: "drive",
      value: 0.77,
    });
    // No write happened, and the reason is named.
    expect(res.mutated).toBe(false);
    expect(res.text).toContain("fx-does-not-exist");
    const after = store.doc.tracks.find((t) => t.id === track.id)!.effects[0]!;
    expect(after.params).toEqual(before);
  });
});
