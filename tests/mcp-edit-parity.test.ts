import { describe, it, expect } from "vitest";
import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import { addArrangementClip } from "../src/commands/commands";
import { moveArrangementClip, deleteArrangementClip } from "../src/commands/arrangement";
import { splitAudioClipAtTick, updateAudioClip } from "../src/commands/clipEditing";
import { audioClipDurationSec, slipAudioClip, stretchAudioClip } from "../src/commands/audioClips";
import { setClipsLocked } from "../src/commands/clipGroups";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * MCP EDIT PARITY (objective Phase 4 / deliverable 6).
 *
 * The claim under test: an agent issuing kyx_clips reaches the SAME edit the
 * keyboard/context-menu path reaches - same command, same clamp, same lock,
 * same persistence. The audit fixed the UI side (D8 lock, D9 clipboard) and the
 * command side; it never checked that the THIRD door (MCP) inherits any of it.
 *
 * Method: every spec compares a state read-back, never a dispatch echo. Where
 * the same logical edit exists on both sides, the MCP route and the direct
 * command route are run against identical fixtures and the resulting documents
 * are compared field by field. Controls are present wherever a negative
 * assertion could otherwise be satisfied by a dead code path.
 */

function makeCtx(doc: ProjectDocument, options: { allowDestructive?: boolean } = {}): McpToolContext {
  let current = doc;
  const undoStack: Array<{ undo: () => ProjectDocument; redo: () => ProjectDocument }> = [];
  const redoStack: Array<{ undo: () => ProjectDocument; redo: () => ProjectDocument }> = [];
  const labels: string[] = [];
  return {
    getDoc: () => current,
    execute: (command) => {
      current = command.execute(current);
      labels.push(command.label);
      // Mirrors ProjectStore.undo: the terminal is handed the document CURRENT
      // AT CALL TIME. snapshot() is delta-based, so capturing `prev` makes the
      // inverse ops run against a document that never left that state.
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
    transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
    ...(options.allowDestructive ? { allowDestructive: () => true } : {}),
  };
}

/** Two scene clips at bars 0-3 and 4-7, plus one audio clip on the drum lane.
 * Built on an EMPTY arrangement: the house template ships its own clips, and
 * adding on top of them would make the fixture's geometry depend on the
 * template. The clips under test must be the only ones. */
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
  const audio = {
    id: "audio-clip-1",
    trackId: drum.id,
    bufferId: "factory.kick.main",
    startBar: 0,
    lengthBars: 4,
    offsetSec: 0,
    trimStart: 0,
    trimEnd: 0,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
    stretchRate: 1,
    reverse: false,
    locked: false,
  };
  return { ...doc, arrangement: { ...doc.arrangement, audioClips: [audio] } } as ProjectDocument;
}

describe("MCP edit parity — clip verbs reach the same state as the command layer", () => {
  it("PARITY CONTROL: audioSplit via MCP equals splitAudioClipAtTick on the same fixture", async () => {
    const direct = fixture();
    const directDoc = splitAudioClipAtTick(direct, "audio-clip-1", 2 * 4 * 480).execute(direct);

    const ctx = makeCtx(fixture());
    const result = await executeMcpTool(ctx, "kyx_clips", { op: "audioSplit", family: "drums", bar: 3 });
    expect(result.mutated).toBe(true);

    const viaMcp = ctx.getDoc().arrangement.audioClips!.map((c) => ({
      startBar: c.startBar,
      lengthBars: c.lengthBars,
      offsetSec: c.offsetSec,
      fadeIn: c.fadeIn,
      fadeOut: c.fadeOut,
    }));
    expect(viaMcp).toEqual(
      directDoc.arrangement.audioClips!.map((c) => ({
        startBar: c.startBar,
        lengthBars: c.lengthBars,
        offsetSec: c.offsetSec,
        fadeIn: c.fadeIn,
        fadeOut: c.fadeOut,
      })),
    );
    // The anchor is 1-based, so bar 3 is the SECOND bar of a 4-bar clip at 0.
    expect(viaMcp).toHaveLength(2);
    expect(viaMcp[0].lengthBars).toBe(2);
    expect(viaMcp[1].startBar).toBe(2);
  });

  it("LOCK PARITY: audioMove/audioSplit/audioDelete all refuse a locked clip (D8 contract via MCP)", async () => {
    const lockedDoc = (): ProjectDocument => {
      const doc = fixture();
      const clip = doc.arrangement.audioClips![0];
      return {
        ...doc,
        arrangement: { ...doc.arrangement, audioClips: [{ ...clip, locked: true }] },
      } as ProjectDocument;
    };

    const move = await executeMcpTool(makeCtx(lockedDoc()), "kyx_clips", {
      op: "audioMove",
      family: "drums",
      bar: 2,
      toBar: 8,
    });
    expect(move.mutated).toBe(false);
    expect(move.text).toMatch(/locked/i);

    const split = await executeMcpTool(makeCtx(lockedDoc()), "kyx_clips", {
      op: "audioSplit",
      family: "drums",
      bar: 3,
    });
    expect(split.mutated).toBe(false);
    expect(split.text).toMatch(/locked/i);

    // audioDelete goes through deleteAudioClip, which D8 left guarded.
    const del = await executeMcpTool(makeCtx(lockedDoc(), { allowDestructive: true }), "kyx_clips", {
      op: "audioDelete",
      family: "drums",
      bar: 2,
    });
    expect(del.mutated).toBe(false);
    expect(del.text).toMatch(/locked/i);

    // CONTROL: the same three ops on an UNLOCKED clip must succeed, otherwise the
    // three negatives above are indistinguishable from a dead tool.
    const openMove = await executeMcpTool(makeCtx(fixture()), "kyx_clips", {
      op: "audioMove",
      family: "drums",
      bar: 2,
      toBar: 8,
    });
    expect(openMove.mutated).toBe(true);
    const openSplit = await executeMcpTool(makeCtx(fixture()), "kyx_clips", {
      op: "audioSplit",
      family: "drums",
      bar: 3,
    });
    expect(openSplit.mutated).toBe(true);
    const openDel = await executeMcpTool(makeCtx(fixture(), { allowDestructive: true }), "kyx_clips", {
      op: "audioDelete",
      family: "drums",
      bar: 2,
    });
    expect(openDel.mutated).toBe(true);
  });

  it("audioUpdate cannot write a fade longer than the clip (D1 clamp reaches MCP)", async () => {
    const ctx = makeCtx(fixture());
    // 4 bars at 120 BPM = 8 s of clip; ask for a 60 s fade.
    const result = await executeMcpTool(ctx, "kyx_clips", {
      op: "audioUpdate",
      family: "drums",
      bar: 2,
      fadeIn: 60,
      fadeOut: 60,
    });
    expect(result.mutated).toBe(true);
    const clip = ctx.getDoc().arrangement.audioClips![0];
    // Units: fadeIn/fadeOut are SECONDS; lengthBars is BARS. Comparing them
    // directly is the bug this assertion had on its first run (7.74 <= 4).
    // audioClipDurationSec is the one formula for "how long is this clip".
    const durSec = audioClipDurationSec(ctx.getDoc(), clip.lengthBars, clip.startBar);
    expect(clip.fadeIn).toBeLessThanOrEqual(durSec);
    expect(clip.fadeOut).toBeLessThanOrEqual(durSec);
    // Sanity on the fixture itself: the clamp must be non-vacuous.
    expect(durSec).toBeGreaterThan(1);
    // And the MCP route must agree with the command route exactly.
    const direct = fixture();
    const directDoc = updateAudioClip(direct, "audio-clip-1", { fadeIn: 60, fadeOut: 60 }).execute(direct);
    expect(clip.fadeIn).toBe(directDoc.arrangement.audioClips![0].fadeIn);
    expect(clip.fadeOut).toBe(directDoc.arrangement.audioClips![0].fadeOut);
  });

  it("PERSISTENCE: every MCP-made clip edit survives normalizeProject (save/load)", async () => {
    const ctx = makeCtx(fixture(), { allowDestructive: true });
    await executeMcpTool(ctx, "kyx_clips", { op: "audioUpdate", family: "drums", bar: 2, gain: 0.5, fadeIn: 0.3 });
    await executeMcpTool(ctx, "kyx_clips", { op: "audioSplit", family: "drums", bar: 3 });
    await executeMcpTool(ctx, "kyx_clips", { op: "move", bar: 2, toBar: 9 });

    const saved = normalizeProject(ctx.getDoc());
    // D9's lesson: an edit that "succeeded" but is pruned on load is data loss.
    // The clip count after the split is 2; normalize must not silently drop one.
    expect(saved.arrangement.audioClips).toHaveLength(2);
    expect(saved.arrangement.clips).toHaveLength(2);
    for (const clip of [...saved.arrangement.clips, ...saved.arrangement.audioClips!]) {
      expect(Number.isFinite(clip.startBar)).toBe(true);
      expect(clip.lengthBars).toBeGreaterThan(0);
    }
  });

  it("UNDO: one MCP op is exactly one undo step, and undo restores the document verbatim", async () => {
    const ctx = makeCtx(fixture(), { allowDestructive: true });
    const before = JSON.stringify(ctx.getDoc().arrangement);

    await executeMcpTool(ctx, "kyx_clips", { op: "audioSplit", family: "drums", bar: 3 });
    expect(ctx.undoStackLength()).toBe(1);

    ctx.undo();
    expect(JSON.stringify(ctx.getDoc().arrangement)).toBe(before);

    ctx.redo();
    expect(ctx.getDoc().arrangement.audioClips).toHaveLength(2);
  });

  it("ARRANGEMENT PARITY: an MCP move lands the same geometry as moveArrangementClip", async () => {
    // ONE base document shared by both routes. Calling fixture() twice minted
    // fresh uids, so the two routes addressed different clips and the compare
    // was meaningless - a fixture that measures its own randomness.
    const base = fixture();
    const targetId = base.arrangement.clips[0].id;

    const viaMcp = makeCtx(base);
    const moved = await executeMcpTool(viaMcp, "kyx_clips", { op: "move", bar: 1, toBar: 9 });
    expect(moved.mutated).toBe(true);

    const directDoc = moveArrangementClip(base, targetId, 8).execute(base);

    // Compare by ID, not by index: a move re-sorts the array, so position 0 is
    // a different clip before and after.
    const byId = (doc: ProjectDocument) =>
      Object.fromEntries(doc.arrangement.clips.map((c) => [c.id, { startBar: c.startBar, lengthBars: c.lengthBars }]));
    expect(byId(viaMcp.getDoc())).toEqual(byId(directDoc));
    // and it actually moved (otherwise an all-default doc would pass the compare)
    expect(viaMcp.getDoc().arrangement.clips.find((c) => c.id === targetId)!.startBar).toBe(8);
  });

  it("ARRANGEMENT DELETE PARITY: MCP delete removes the same clip the UI removes", async () => {
    const base = fixture();
    const targetId = base.arrangement.clips[0].id;

    const viaMcp = makeCtx(base, { allowDestructive: true });
    const del = await executeMcpTool(viaMcp, "kyx_clips", { op: "delete", bar: 1 });
    expect(del.mutated).toBe(true);

    const directDoc = deleteArrangementClip(base, targetId).execute(base);

    expect(viaMcp.getDoc().arrangement.clips.map((c) => c.id)).toEqual(directDoc.arrangement.clips.map((c) => c.id));
    expect(viaMcp.getDoc().arrangement.clips.some((c) => c.id === targetId)).toBe(false);
  });

  it("SPLIT POSITION: MCP audioSplit honours the exact-tick contract, not a rounded bar", async () => {
    // The command layer deliberately preserves fractional-tick splits (wave-1
    // finding #8: rounding bars to 0.01 accumulated source-offset drift).
    // MCP can only name a whole bar, so the parity claim here is narrower and
    // is stated as such: what MCP can express must not be rounded further.
    const ctx = makeCtx(fixture());
    await executeMcpTool(ctx, "kyx_clips", { op: "audioSplit", family: "drums", bar: 3 });
    const clips = ctx.getDoc().arrangement.audioClips!;
    expect(clips[0].lengthBars).toBe(2);
    expect(clips[1].lengthBars).toBe(2);
    // Total length is conserved exactly — no rounding drift introduced.
    expect(clips[0].lengthBars + clips[1].lengthBars).toBe(4);
  });

  it("NON-DESTRUCTIVE SAFETY: audioDelete stays D4-gated without allowDestructive", async () => {
    const ctx = makeCtx(fixture());
    const result = await executeMcpTool(ctx, "kyx_clips", { op: "audioDelete", family: "drums", bar: 2 });
    expect(result.mutated).toBe(false);
    expect(ctx.getDoc().arrangement.audioClips).toHaveLength(1);
    // and arrangement delete too
    const arr = await executeMcpTool(ctx, "kyx_clips", { op: "delete", bar: 1 });
    expect(arr.mutated).toBe(false);
    expect(ctx.getDoc().arrangement.clips).toHaveLength(2);
  });
});

describe("MCP edit parity — verbs the command layer has and the tool surface does not", () => {
  /**
   * A gap is not a defect by itself. This spec pins the SURFACE so the backlog
   * line is falsifiable: if an op is added, this goes red and the report must
   * be updated rather than left stale.
   *
   * **This pin has now fired once, which is the point of writing it.** It
   * originally probed `op: "audioStretch"` as a deliberately bogus op. A
   * concurrent session added real `audioStretch` and `audioSlip` ops, the probe
   * stopped being bogus, and this spec went red - correctly. The probe was moved
   * to an op that is still absent, and the two NEW ops were added to the pinned
   * surface below so the drift becomes coverage instead of just noise.
   */
  it("kyx_clips exposes exactly the ops it advertises", async () => {
    // The unknown-op message only exists on the path that gets PAST target
    // resolution, so the probe must supply a valid address. An earlier version
    // omitted `family` and measured the "need trackId or family" guard instead
    // of the op whitelist - a test that passed for the wrong reason.
    const ctx = makeCtx(fixture());
    const bogus = await executeMcpTool(ctx, "kyx_clips", { op: "audioWarp", family: "drums", bar: 2 });
    expect(bogus.mutated).toBe(false);
    // The unknown-op message enumerates the real surface; pin it IN FULL, so
    // the next op that lands shows up as a failure rather than as drift.
    for (const op of [
      "list",
      "audioList",
      "audioMove",
      "audioSplit",
      "audioUpdate",
      "audioStretch",
      "audioSlip",
      "audioDelete",
    ]) {
      expect(bogus.text, `kyx_clips no longer advertises ${op}`).toContain(op);
    }
  });

  it("PARITY: the audioStretch / audioSlip ops added after wave 18 match their commands", async () => {
    // These two ops did not exist when §B1 was written. The report's parity
    // table listed slip and stretch as ABSENT from MCP; that row is now stale
    // and this spec is what keeps it honest.
    const base = fixture();

    // SLIP: offsetSec moves, position and length do not.
    const slipCtx = makeCtx(base);
    const slipped = await executeMcpTool(slipCtx, "kyx_clips", {
      op: "audioSlip",
      family: "drums",
      bar: 2,
      offsetSec: 0.5,
    });
    expect(slipped.mutated).toBe(true);
    const viaMcpSlip = slipCtx.getDoc().arrangement.audioClips!.find((c) => c.id === "audio-clip-1")!;
    const directSlip = slipAudioClip(base, "audio-clip-1", 0.5).execute(base).arrangement.audioClips![0]!;
    expect(viaMcpSlip.offsetSec).toBe(directSlip.offsetSec);
    expect(viaMcpSlip.startBar).toBe(directSlip.startBar);
    expect(viaMcpSlip.lengthBars).toBe(directSlip.lengthBars);

    // STRETCH: length and rate change together, position does not.
    const stretchCtx = makeCtx(base);
    const stretched = await executeMcpTool(stretchCtx, "kyx_clips", {
      op: "audioStretch",
      family: "drums",
      bar: 2,
      bars: 8,
      rate: 0.5,
    });
    expect(stretched.mutated).toBe(true);
    const viaMcpStretch = stretchCtx.getDoc().arrangement.audioClips!.find((c) => c.id === "audio-clip-1")!;
    const directStretch = stretchAudioClip(base, "audio-clip-1", 8, 0.5).execute(base).arrangement.audioClips![0]!;
    expect(viaMcpStretch.lengthBars).toBe(directStretch.lengthBars);
    expect(viaMcpStretch.stretchRate).toBe(directStretch.stretchRate);
    expect(viaMcpStretch.startBar).toBe(directStretch.startBar);

    // Both still honour the lock, like every other audio verb (D8).
    const locked = setClipsLocked(base, ["audio-clip-1"], true).execute(base) as ProjectDocument;
    const lockedSlip = await executeMcpTool(makeCtx(locked), "kyx_clips", {
      op: "audioSlip",
      family: "drums",
      bar: 2,
      offsetSec: 0.5,
    });
    expect(lockedSlip.mutated).toBe(false);
    const lockedStretch = await executeMcpTool(makeCtx(locked), "kyx_clips", {
      op: "audioStretch",
      family: "drums",
      bar: 2,
      bars: 8,
      rate: 0.5,
    });
    expect(lockedStretch.mutated).toBe(false);
  });

  it("the arrangement lane names its own op surface", async () => {
    const ctx = makeCtx(fixture());
    const bogus = await executeMcpTool(ctx, "kyx_clips", { op: "explode", bar: 1 });
    expect(bogus.mutated).toBe(false);
    expect(bogus.text).toContain("list");
    expect(bogus.text).toContain("move");
    expect(bogus.text).toContain("resize");
    expect(bogus.text).toContain("duplicate");
    expect(bogus.text).toContain("delete");
  });

  it("audio ops address by family and refuse an ambiguous / missing address", async () => {
    const ctx = makeCtx(fixture());
    const noAddress = await executeMcpTool(ctx, "kyx_clips", { op: "audioUpdate", gain: 1 });
    expect(noAddress.mutated).toBe(false);
    expect(noAddress.text).toContain("need trackId or family");

    const badBar = await executeMcpTool(ctx, "kyx_clips", { op: "audioUpdate", family: "drums", bar: 0, gain: 1 });
    expect(badBar.mutated).toBe(false);
    expect(badBar.text).toContain("1-based anchor bar");
  });
});
