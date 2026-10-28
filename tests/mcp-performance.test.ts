import { describe, expect, it, beforeEach } from "vitest";
import { createHeadlessMcpHost } from "../src/mcp/headless-host";
import { executeMcpTool, resetMcpCheckpoints } from "../src/mcp/tools";
import { createDefaultProject } from "../src/project-model/schema";

/**
 * AS-015 / ADR 0077 — kyx_performance, the performance DOCUMENT surface.
 * Live Sets and macros are agent-executable R1 commands (prepare); pad
 * launches and jam input stay human-only (perform — there is deliberately
 * no launch/trigger op). deleteSet rides the D4 gate with the auto-before
 * checkpoint; macro writes keep their applyToYDoc collab sync.
 */

function host(allowDestructive = false) {
  return createHeadlessMcpHost({ document: createDefaultProject(), allowDestructive });
}

beforeEach(() => {
  resetMcpCheckpoints();
});

describe("kyx_performance — Live Sets (AS-015 / ADR 0077)", () => {
  it("createSet lands active with a read-back id; one undo removes it; list shows the layout", async () => {
    const h = host();
    const created = await h.call("kyx_performance", { op: "createSet", name: "Show A" });
    expect(created.mutated, created.text).toBe(true);
    const setId = (created.data as { setId: string }).setId;
    expect(setId).not.toBe("");
    expect(h.store.doc.liveSets).toHaveLength(1);
    expect(h.store.doc.activeLiveSetId).toBe(setId);

    const listed = await h.call("kyx_performance", { op: "list" });
    // Per-op risk refinement: list is READ even though the tool table says mutate.
    expect(listed.risk).toBe("read");
    const sets = (listed.data as { sets: Array<{ id: string; name: string; active: boolean }> }).sets;
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ id: setId, name: "Show A", active: true, loopBars: 4 });
    expect(listed.text).toContain('"Show A"');
    expect(listed.text).toContain("ACTIVE");

    h.store.undo();
    // The pre-create document never had the field — undo restores it absent
    // (the normalizer keeps optional collections out until first use).
    expect(h.store.doc.liveSets ?? []).toHaveLength(0);
  });

  it("renameSet / selectSet / setOptions shape the layout; bad options refuse without mutating", async () => {
    const h = host();
    const created = await h.call("kyx_performance", { op: "createSet", name: "Show A" });
    const setId = (created.data as { setId: string }).setId;

    const renamed = await h.call("kyx_performance", { op: "renameSet", setId, name: "Encore" });
    expect(renamed.mutated, renamed.text).toBe(true);
    expect(renamed.text).toContain("Encore");

    // A second set makes selectSet observable: the active pointer moves.
    const second = await h.call("kyx_performance", { op: "createSet", name: "Show B" });
    const setIdB = (second.data as { setId: string }).setId;
    const selected = await h.call("kyx_performance", { op: "selectSet", setId });
    expect(selected.mutated, selected.text).toBe(true);
    expect(h.store.doc.activeLiveSetId).toBe(setId);
    expect(selected.text).toContain("human launches a pad");

    const options = await h.call("kyx_performance", { op: "setOptions", setId, loopBars: 8 });
    expect(options.mutated, options.text).toBe(true);
    expect(h.store.doc.liveSets!.find((set) => set.id === setId)!.loopBars).toBe(8);

    const badBars = await h.call("kyx_performance", { op: "setOptions", setId, loopBars: 3 });
    expect(badBars.isError).toBe(true);
    expect(badBars.errorCode).toBe("INVALID_ARGUMENTS");

    const badTrack = await h.call("kyx_performance", { op: "setOptions", setIdB, trackId: "no-such-track" });
    expect(badTrack.isError).toBe(true);
    expect(badTrack.errorCode).toBe("INVALID_ARGUMENTS");

    const unknown = await h.call("kyx_performance", { op: "renameSet", setId: "nope", name: "X" });
    expect(unknown.isError).toBe(true);
    expect(unknown.errorCode).toBe("UNKNOWN_TARGET");
  });

  it("duplicateSet copies pads; assignPad/clearPad fill 1-based slots with honest refusals", async () => {
    const h = host();
    const created = await h.call("kyx_performance", { op: "createSet", name: "Show A" });
    const setId = (created.data as { setId: string }).setId;
    const drums = h.store.doc.tracks.find((track) => track.kind === "drum")!;
    const options = await h.call("kyx_performance", { op: "setOptions", setId, trackId: drums.id, loopBars: 2 });
    expect(options.mutated, options.text).toBe(true);

    const assigned = await h.call("kyx_performance", {
      op: "assignPad",
      setId,
      slot: 3,
      bufferId: "user-buffer-1",
      padName: "Clap Loop",
      padLoop: true,
      padBpm: 124,
    });
    expect(assigned.mutated, assigned.text).toBe(true);
    const pads = h.store.doc.liveSets!.find((set) => set.id === setId)!.pads;
    expect(pads).toHaveLength(1);
    expect(pads[0]).toMatchObject({ slot: 2, bufferId: "user-buffer-1", name: "Clap Loop", loop: true, bpm: 124 });

    const duplicated = await h.call("kyx_performance", { op: "duplicateSet", setId });
    expect(duplicated.mutated, duplicated.text).toBe(true);
    const copy = h.store.doc.liveSets!.find((set) => set.id !== setId)!;
    expect(copy.pads).toHaveLength(1);

    const cleared = await h.call("kyx_performance", { op: "clearPad", setId, slot: 3 });
    expect(cleared.mutated, cleared.text).toBe(true);
    expect(h.store.doc.liveSets!.find((set) => set.id === setId)!.pads).toHaveLength(0);

    const badSlot = await h.call("kyx_performance", { op: "assignPad", setId, slot: 17, bufferId: "b", padName: "n" });
    expect(badSlot.isError).toBe(true);
    expect(badSlot.errorCode).toBe("INVALID_ARGUMENTS");
    const noBuffer = await h.call("kyx_performance", { op: "assignPad", setId, slot: 1, padName: "n" });
    expect(noBuffer.isError).toBe(true);
    expect(noBuffer.errorCode).toBe("INVALID_ARGUMENTS");
    expect(h.store.doc.liveSets!.find((set) => set.id === setId)!.pads).toHaveLength(0);
  });

  it("deleteSet is D4-gated WITH the auto-before checkpoint", async () => {
    const h = host();
    const created = await h.call("kyx_performance", { op: "createSet", name: "Show A" });
    const setId = (created.data as { setId: string }).setId;

    const locked = await h.call("kyx_performance", { op: "deleteSet", setId });
    expect(locked.isError).toBe(true);
    expect(locked.errorCode).toBe("POLICY_REFUSED");
    expect(h.store.doc.liveSets).toHaveLength(1);

    const allowed = host(true);
    const created2 = await allowed.call("kyx_performance", { op: "createSet", name: "Show B" });
    const setId2 = (created2.data as { setId: string }).setId;
    const deleted = await allowed.call("kyx_performance", { op: "deleteSet", setId: setId2 });
    expect(deleted.mutated, deleted.text).toBe(true);
    expect(allowed.store.doc.liveSets).toHaveLength(0);
    const cpList = await allowed.call("kyx_checkpoint", { op: "list" });
    expect(cpList.text).toContain("auto-before-kyx_performance");
  });
});

describe("kyx_performance — macros (AS-015 / ADR 0077)", () => {
  it("setMacro moves a value with a clamped read-back; renameMacro renames; unknown ids refuse", async () => {
    const h = host();
    const listed = await h.call("kyx_performance", { op: "listMacros" });
    const macros = (listed.data as { macros: Array<{ id: string; name: string }> }).macros;
    expect(macros.length, "createDefaultProject ships macros").toBeGreaterThan(0);
    const macro = macros[0];

    const moved = await h.call("kyx_performance", { op: "setMacro", macroId: macro.id, value: 0.75 });
    expect(moved.mutated, moved.text).toBe(true);
    expect((moved.data as { value: number }).value).toBe(0.75);
    expect(h.store.doc.macros.find((candidate) => candidate.id === macro.id)!.value).toBe(0.75);
    h.store.undo();
    expect(h.store.doc.macros.find((candidate) => candidate.id === macro.id)!.value).not.toBe(0.75);

    const renamed = await h.call("kyx_performance", { op: "renameMacro", macroId: macro.id, name: "Energy" });
    expect(renamed.mutated, renamed.text).toBe(true);
    expect(h.store.doc.macros.find((candidate) => candidate.id === macro.id)!.name).toBe("Energy");

    const unknown = await h.call("kyx_performance", { op: "setMacro", macroId: "nope", value: 0.5 });
    expect(unknown.isError).toBe(true);
    expect(unknown.errorCode).toBe("UNKNOWN_TARGET");
    const badValue = await h.call("kyx_performance", { op: "setMacro", macroId: macro.id, value: 4 });
    expect(badValue.isError).toBe(true);
    expect(badValue.errorCode).toBe("INVALID_ARGUMENTS");
  });
});

describe("kyx_performance — the R4 boundary (ADR 0077)", () => {
  it("there is no launch/trigger op — the surface refuses it as UNKNOWN_REQUEST", async () => {
    const h = host(true);
    const launched = await executeMcpTool(h.ctx, "kyx_performance", { op: "launchPad", setId: "x", slot: 1 });
    expect(launched.isError).toBe(true);
    expect(launched.errorCode).toBe("UNKNOWN_REQUEST");
    expect(launched.text).not.toContain("launchPad |"); // never advertised as a valid op
  });
});
