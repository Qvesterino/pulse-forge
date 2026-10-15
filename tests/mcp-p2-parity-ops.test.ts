import { describe, it, expect } from "vitest";
import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import {
  addArrangementClip,
  deleteArrangementClipRipple,
  moveArrangementClipRipple,
  splitArrangementClipAtTick,
} from "../src/commands/commands";
import { cutClips, buildClipClipboard, pasteClips } from "../src/commands/clipClipboard";
import {
  nudgeClips,
  duplicateAudioClip,
  consolidateAudioClips,
  stripSilenceAudioClip,
  sliceAudioClipToArrangement,
} from "../src/commands/clipEditing";
import { setAudioClipsMute } from "../src/commands/audioClips";
import { setClipsLocked } from "../src/commands/clipGroups";
import { normalizeProject } from "../src/project-model/schema";
import type { AudioClip, ProjectDocument } from "../src/project-model/types";

/**
 * WAVE 22 — the P2 MCP parity gaps, closed (owner-approved 2026-10-14).
 *
 * §B2 of the audit listed what an agent could NOT do that a user could. The
 * owner closed the scope to "build the missing ops", so this spec is the other
 * half of that promise: every new op must reach the SAME state as the command
 * the UI gesture commits, must honour the D8 lock and the D4 destructive gate,
 * and must be one undo step.
 *
 * The trap this suite is written against, from wave 18: **a dispatch echo is
 * not a state change.** Every assertion here reads the document back, and each
 * negative assertion is paired with a positive control on the same fixture so
 * it cannot pass by the op being dead.
 */

const TICKS_PER_BAR = 4 * 480;

function makeCtx(
  doc: ProjectDocument,
  options: { allowDestructive?: boolean; position?: number } = {},
): McpToolContext {
  let current = doc;
  const undoStack: Array<{ undo: () => ProjectDocument; redo: () => ProjectDocument }> = [];
  const redoStack: Array<{ undo: () => ProjectDocument; redo: () => ProjectDocument }> = [];
  const labels: string[] = [];
  return {
    getDoc: () => current,
    execute: (command) => {
      current = command.execute(current);
      labels.push(command.label);
      undoStack.push({ undo: () => command.undo(current), redo: () => command.execute(current) });
      redoStack.length = 0;
    },
    undo: () => {
      const entry = undoStack.pop();
      if (entry) {
        current = entry.undo();
        redoStack.push(entry);
      }
    },
    redo: () => {
      const entry = redoStack.pop();
      if (entry) {
        current = entry.redo();
        undoStack.push(entry);
      }
    },
    undoStackLength: () => undoStack.length,
    historyLabels: () => [...labels],
    isMicRecordingActive: () => false,
    transport: {
      play: () => {},
      stop: () => {},
      pause: () => {},
      setLoop: () => {},
      setMetronome: () => {},
      ...(options.position !== undefined ? { position: options.position } : {}),
    },
    ...(options.allowDestructive ? { allowDestructive: () => true } : {}),
  };
}

/** Scene clips at bars 0-3 and 4-7, plus two audio clips on the drum lane. */
function fixture(): ProjectDocument {
  const base = createProjectFromTemplate("house");
  const sceneA = base.scenes[0].id;
  const cleared = {
    ...base,
    arrangement: { ...base.arrangement, clips: [] as ProjectDocument["arrangement"]["clips"], audioClips: [] },
  } as ProjectDocument;
  let doc = addArrangementClip(cleared, sceneA, 0, 4).execute(cleared);
  doc = addArrangementClip(doc, sceneA, 4, 4).execute(doc);
  const drum = doc.tracks.find((t) => t.kind === "drum")!;
  const audio = (id: string, startBar: number, lengthBars: number): AudioClip =>
    ({
      id,
      trackId: drum.id,
      bufferId: "factory.kick.main",
      startBar,
      lengthBars,
      offsetSec: 0,
      trimStart: 0,
      trimEnd: 0,
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
      stretchRate: 1,
      reverse: false,
    }) as AudioClip;
  return {
    ...doc,
    arrangement: { ...doc.arrangement, audioClips: [audio("a1", 0, 2), audio("a2", 4, 2)] },
  } as ProjectDocument;
}

const sceneAt = (doc: ProjectDocument, startBar: number) => doc.arrangement.clips.find((c) => c.startBar === startBar)!;

describe("wave 22 — scene split + ripple on MCP", () => {
  it("split matches splitArrangementClipAtTick exactly", async () => {
    const base = fixture();
    const targetId = base.arrangement.clips[0].id;

    const ctx = makeCtx(base);
    const result = await executeMcpTool(ctx, "kyx_clips", { op: "split", bar: 2 });
    expect(result.mutated).toBe(true);

    const direct = splitArrangementClipAtTick(base, targetId, 1 * TICKS_PER_BAR).execute(base);
    // Compared as a GEOMETRY SET, not keyed by id: split mints a fresh id for
    // the right-hand fragment, so the two routes can never share ids. Keying
    // by id would report a difference that is not one.
    const geometry = (doc: ProjectDocument) =>
      doc.arrangement.clips.map((c) => [c.startBar, c.lengthBars]).sort((a, b) => a[0] - b[0]);
    expect(geometry(ctx.getDoc())).toEqual(geometry(direct));
    // The fixture's SECOND scene clip (bar 4) is untouched by the split.
    expect(geometry(ctx.getDoc())).toEqual([
      [0, 1],
      [1, 3],
      [4, 4],
    ]);
    // and it is one undo step
    expect(ctx.undoStackLength()).toBe(1);
    // Ids are still unique across the split (D9's rule).
    expect(new Set(ctx.getDoc().arrangement.clips.map((c) => c.id)).size).toBe(3);
  });

  it("split refuses a locked clip (D8 reaches the new op)", async () => {
    const base = fixture();
    const id = base.arrangement.clips[0].id;
    const locked = setClipsLocked(base, [id], true).execute(base) as ProjectDocument;

    const refused = await executeMcpTool(makeCtx(locked), "kyx_clips", { op: "split", bar: 2 });
    expect(refused.mutated).toBe(false);
    expect(refused.text).toMatch(/locked/i);
    expect(makeCtx(locked).getDoc().arrangement.clips).toHaveLength(2);

    // CONTROL: the same split on the unlocked fixture works.
    expect((await executeMcpTool(makeCtx(base), "kyx_clips", { op: "split", bar: 2 })).mutated).toBe(true);
  });

  it("deleteRipple closes the gap, while delete does not — the UI toggle, for an agent", async () => {
    const base = fixture();

    // Non-ripple delete leaves the gap (bar 4 stays at 4).
    const plain = makeCtx(base, { allowDestructive: true });
    const plainResult = await executeMcpTool(plain, "kyx_clips", { op: "delete", bar: 1 });
    expect(plainResult.mutated).toBe(true);
    expect(sceneAt(plain.getDoc(), 4).startBar).toBe(4);

    // Ripple delete shifts the later clip into the hole.
    const rippled = makeCtx(base, { allowDestructive: true });
    const rippleResult = await executeMcpTool(rippled, "kyx_clips", { op: "deleteRipple", bar: 1 });
    expect(rippleResult.mutated).toBe(true);
    expect(sceneAt(rippled.getDoc(), 0).startBar).toBe(0);

    // Parity with the command the UI's RIPPLE toggle commits.
    const direct = deleteArrangementClipRipple(base, base.arrangement.clips[0].id).execute(base);
    expect(rippled.getDoc().arrangement.clips.map((c) => ({ id: c.id, startBar: c.startBar }))).toEqual(
      direct.arrangement.clips.map((c) => ({ id: c.id, startBar: c.startBar })),
    );
  });

  it("moveRipple / resizeRipple match their commands and stay D4-gated where destructive", async () => {
    const base = fixture();
    const targetId = base.arrangement.clips[0].id;

    const moved = makeCtx(base);
    expect((await executeMcpTool(moved, "kyx_clips", { op: "moveRipple", bar: 1, toBar: 6 })).mutated).toBe(true);
    const directMove = moveArrangementClipRipple(base, targetId, 5).execute(base);
    // Geometry set again: moveRipple preserves ids, but comparing sorted
    // geometry keeps the assertion about POSITION rather than about id
    // bookkeeping that both routes share anyway.
    const movedGeometry = (doc: ProjectDocument) =>
      doc.arrangement.clips.map((c) => [c.startBar, c.lengthBars]).sort((a, b) => a[0] - b[0]);
    expect(movedGeometry(moved.getDoc())).toEqual(movedGeometry(directMove));
    // Ripple semantics: the moved clip lands at bar 5 and the clip that FOLLOWED
    // it is pushed clear of the new end (bar 9, not bar 8). Asserting 8 here
    // would have been the bug — an overlap is exactly what ripple forbids.
    expect(movedGeometry(moved.getDoc())).toEqual([
      [5, 4],
      [9, 4],
    ]);

    const resized = makeCtx(base);
    expect((await executeMcpTool(resized, "kyx_clips", { op: "resizeRipple", bar: 1, bars: 2 })).mutated).toBe(true);
    expect(sceneAt(resized.getDoc(), 0).lengthBars).toBe(2);

    // deleteRipple is a delete: no allowDestructive, no mutation.
    const refused = makeCtx(base);
    const refusedResult = await executeMcpTool(refused, "kyx_clips", { op: "deleteRipple", bar: 1 });
    expect(refusedResult.mutated).toBe(false);
    expect(refused.getDoc().arrangement.clips).toHaveLength(2);
  });
});

describe("wave 22 — clipboard on MCP", () => {
  it("copy then paste lands the same clips as pasteClips", async () => {
    const base = fixture();

    const ctx = makeCtx(base, { position: 8 * TICKS_PER_BAR });
    const copied = await executeMcpTool(ctx, "kyx_clips", { op: "copy", bar: 1 });
    expect(copied.mutated).toBe(false); // copy is not a mutation
    expect(copied.text).toContain("copied");

    const pasted = await executeMcpTool(ctx, "kyx_clips", { op: "paste" });
    expect(pasted.mutated).toBe(true);
    expect(pasted.text).toContain("playhead");

    // Parity: build the same clipboard by hand and paste at the same tick.
    // Compared as GEOMETRY, not by id — paste mints fresh ids (D9), so the two
    // routes can never share them and an id comparison would always differ.
    const direct = pasteClips(
      base,
      buildClipClipboard(base, [base.arrangement.clips[0].id]!)!,
      8 * TICKS_PER_BAR,
    ).execute(base);
    const pastedGeometry = (doc: ProjectDocument) =>
      doc.arrangement.clips.map((c) => [c.startBar, c.lengthBars]).sort((a, b) => a[0] - b[0]);
    expect(pastedGeometry(ctx.getDoc())).toEqual(pastedGeometry(direct));
    expect(pastedGeometry(ctx.getDoc())).toEqual([
      [0, 4],
      [4, 4],
      [8, 4],
    ]);
    // A pasted clip carries a FRESH id (D9's rule).
    expect(new Set(ctx.getDoc().arrangement.clips.map((c) => c.id)).size).toBe(ctx.getDoc().arrangement.clips.length);
    // One undo step, and it survives a reload.
    expect(ctx.undoStackLength()).toBe(1);
    expect(normalizeProject(ctx.getDoc()).arrangement.clips).toHaveLength(ctx.getDoc().arrangement.clips.length);
  });

  it("cut is a delete: D4-gated, and it keeps the clipboard for the paste", async () => {
    const base = fixture();
    const refused = makeCtx(base);
    const refusedResult = await executeMcpTool(refused, "kyx_clips", { op: "cut", bar: 1 });
    expect(refusedResult.mutated).toBe(false);
    expect(refused.getDoc().arrangement.clips).toHaveLength(2);

    const allowed = makeCtx(base, { allowDestructive: true });
    const cut = await executeMcpTool(allowed, "kyx_clips", { op: "cut", bar: 1 });
    expect(cut.mutated).toBe(true);
    expect(allowed.getDoc().arrangement.clips).toHaveLength(1);
    // The clipboard survived the cut, so a paste still works.
    expect((await executeMcpTool(allowed, "kyx_clips", { op: "paste", bar: 9 })).mutated).toBe(true);

    // Parity with the command Ctrl+X commits.
    const direct = cutClips(base, [base.arrangement.clips[0].id]).execute(base);
    expect(direct.arrangement.clips).toHaveLength(1);
  });

  it("a clipboard captured in another project refuses to paste — honestly, not as a crash", async () => {
    // The MCP clipboard is MODULE scope, so it survives across projects. That
    // is what the UI does too, and the project id on the clipboard is what
    // stops a paste from dragging clips between documents. Earlier this spec
    // tried to assert the "clipboard is empty" branch, which is not
    // deterministic under module state — so it asserts the guarantee that
    // IS: a cross-project paste is refused, and it is refused as an MCP error.
    const first = fixture();
    const copied = await executeMcpTool(makeCtx(first), "kyx_clips", { op: "copy", bar: 1 });
    expect(copied.mutated).toBe(false);

    // A DIFFERENT project: same shape, different id.
    const other = { ...fixture(), id: "a-different-project" } as ProjectDocument;
    const ctx = makeCtx(other, { allowDestructive: true });
    const pasted = await executeMcpTool(ctx, "kyx_clips", { op: "paste", bar: 12 });
    expect(pasted.mutated).toBe(false);
    expect(pasted.text).toMatch(/different project|clipboard/i);
    expect(ctx.getDoc().arrangement.clips).toHaveLength(2);
  });
});

describe("wave 22 — the remaining audio verbs on MCP", () => {
  it("audioDuplicate matches duplicateAudioClip and survives a reload", async () => {
    const base = fixture();
    const ctx = makeCtx(base);
    const result = await executeMcpTool(ctx, "kyx_clips", { op: "audioDuplicate", family: "drums", bar: 2 });
    expect(result.mutated).toBe(true);
    const direct = duplicateAudioClip(base, "a1").execute(base);
    expect(ctx.getDoc().arrangement.audioClips!.length).toBe(direct.arrangement.audioClips!.length);
    expect(new Set(ctx.getDoc().arrangement.audioClips!.map((c) => c.id)).size).toBe(3);
    expect(normalizeProject(ctx.getDoc()).arrangement.audioClips).toHaveLength(3);
  });

  it("audioMute silences one clip only, and audioNudge moves without resizing", async () => {
    const base = fixture();
    const muted = makeCtx(base);
    expect((await executeMcpTool(muted, "kyx_clips", { op: "audioMute", family: "drums", bar: 2 })).mutated).toBe(true);
    const byId = (doc: ProjectDocument, id: string) => doc.arrangement.audioClips!.find((c) => c.id === id)!;
    expect(byId(muted.getDoc(), "a1").muted).toBe(true);
    expect(byId(muted.getDoc(), "a2").muted).toBeUndefined(); // neighbour untouched
    // parity
    expect(byId(muted.getDoc(), "a1").muted).toBe(
      byId(setAudioClipsMute(base, ["a1"], true).execute(base), "a1").muted,
    );

    const nudged = makeCtx(base);
    expect(
      (await executeMcpTool(nudged, "kyx_clips", { op: "audioNudge", family: "drums", bar: 2, bars: 1 })).mutated,
    ).toBe(true);
    const direct = nudgeClips(base, ["a1"], 1).execute(base);
    const byId2 = (doc: ProjectDocument, id: string) => doc.arrangement.audioClips!.find((c) => c.id === id)!;
    expect(byId2(nudged.getDoc(), "a1").startBar).toBe(byId2(direct, "a1").startBar);
    expect(byId2(nudged.getDoc(), "a1").lengthBars).toBe(byId2(direct, "a1").lengthBars);
  });

  it("audioSlice and audioStrip match their commands and refuse locked clips", async () => {
    const base = fixture();

    const sliced = makeCtx(base);
    expect(
      (await executeMcpTool(sliced, "kyx_clips", { op: "audioSlice", family: "drums", bar: 2, sliceTimesSec: [1] }))
        .mutated,
    ).toBe(true);
    const directSlice = sliceAudioClipToArrangement(base, "a1", [1]).execute(base);
    expect(sliced.getDoc().arrangement.audioClips!.length).toBe(directSlice.arrangement.audioClips!.length);

    const stripped = makeCtx(base);
    expect(
      (
        await executeMcpTool(stripped, "kyx_clips", {
          op: "audioStrip",
          family: "drums",
          bar: 2,
          segments: [{ startSec: 0, endSec: 1 }],
        })
      ).mutated,
    ).toBe(true);
    const directStrip = stripSilenceAudioClip(base, "a1", [{ startSec: 0, endSec: 1 }]).execute(base);
    expect(stripped.getDoc().arrangement.audioClips!.length).toBe(directStrip.arrangement.audioClips!.length);

    // Both refuse a locked clip, and neither mutates on the refusal.
    const locked = setClipsLocked(base, ["a1"], true).execute(base) as ProjectDocument;
    const lockedSlice = await executeMcpTool(makeCtx(locked), "kyx_clips", {
      op: "audioSlice",
      family: "drums",
      bar: 2,
      sliceTimesSec: [1],
    });
    expect(lockedSlice.mutated).toBe(false);
    const lockedStrip = await executeMcpTool(makeCtx(locked), "kyx_clips", {
      op: "audioStrip",
      family: "drums",
      bar: 2,
      segments: [{ startSec: 0, endSec: 1 }],
    });
    expect(lockedStrip.mutated).toBe(false);
    expect(makeCtx(locked).getDoc().arrangement.audioClips).toHaveLength(2);

    // Bad arguments are refused with a message, never a silent no-op.
    const noTimes = await executeMcpTool(makeCtx(base), "kyx_clips", {
      op: "audioSlice",
      family: "drums",
      bar: 2,
    });
    expect(noTimes.mutated).toBe(false);
    expect(noTimes.text).toMatch(/sliceTimesSec/);
  });

  it("audioConsolidate needs a bufferId and at least two clips, then matches the command", async () => {
    const base = fixture();

    const noBuffer = await executeMcpTool(makeCtx(base), "kyx_clips", {
      op: "audioConsolidate",
      family: "drums",
      bar: 2,
      bars: 8,
    });
    expect(noBuffer.mutated).toBe(false);
    expect(noBuffer.text).toMatch(/bufferId/);

    const tooFew = await executeMcpTool(makeCtx(base), "kyx_clips", {
      op: "audioConsolidate",
      family: "drums",
      bar: 2,
      bars: 1,
      bufferId: "rendered.bounce",
    });
    expect(tooFew.mutated).toBe(false);
    expect(tooFew.text).toMatch(/at least 2 clips/);

    const merged = makeCtx(base);
    const result = await executeMcpTool(merged, "kyx_clips", {
      op: "audioConsolidate",
      family: "drums",
      bar: 2,
      bars: 8,
      bufferId: "rendered.bounce",
    });
    expect(result.mutated).toBe(true);
    const direct = consolidateAudioClips(base, ["a1", "a2"], "rendered.bounce").execute(base);
    expect(merged.getDoc().arrangement.audioClips!.map((c) => [c.startBar, c.lengthBars, c.bufferId])).toEqual(
      direct.arrangement.audioClips!.map((c) => [c.startBar, c.lengthBars, c.bufferId]),
    );
    // A locked member refuses, because consolidate deletes the others.
    const locked = setClipsLocked(base, ["a2"], true).execute(base) as ProjectDocument;
    const lockedMerge = await executeMcpTool(makeCtx(locked), "kyx_clips", {
      op: "audioConsolidate",
      family: "drums",
      bar: 2,
      bars: 8,
      bufferId: "rendered.bounce",
    });
    expect(lockedMerge.mutated).toBe(false);
  });

  it("every new op is advertised, and an unknown op still enumerates the surface", async () => {
    const base = fixture();
    const bogus = await executeMcpTool(makeCtx(base), "kyx_clips", { op: "audioWarp", family: "drums", bar: 2 });
    expect(bogus.mutated).toBe(false);
    for (const op of [
      "split",
      "moveRipple",
      "resizeRipple",
      "deleteRipple",
      "copy",
      "cut",
      "paste",
      "audioDuplicate",
      "audioMute",
      "audioNudge",
      "audioSlice",
      "audioStrip",
      "audioConsolidate",
      "audioCrossfade",
    ]) {
      expect(bogus.text, `kyx_clips no longer advertises ${op}`).toContain(op);
    }
  });
});
