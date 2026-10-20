import { describe, it, expect } from "vitest";
import { executeMcpTool, explicitTrackIds, MCP_TOOLS, type McpToolContext } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * kyx_notes + kyx_music — the melodic composition + musical state surface.
 * Real command layer, real template doc: an agent can WRITE a bassline
 * (add/move/velocity/quantize/transpose) and set song state (tempo/key/
 * length) with one-undo steps and honest index addressing.
 */

function makeCtx(doc: ProjectDocument, options: { allowDestructive?: boolean } = {}): McpToolContext {
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
    ...(options.allowDestructive ? { allowDestructive: () => true } : {}),
  };
}

function projectStoreCtx(store: ProjectStore, options: { allowDestructive?: boolean } = {}): McpToolContext {
  return {
    getDoc: () => store.doc,
    execute: (command) => store.execute(command),
    undo: () => store.undo(),
    redo: () => store.redo(),
    undoStackLength: () => store.undoStackLength,
    historyLabels: () => store.history.map((entry) => entry.label),
    isMicRecordingActive: () => false,
    transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
    ...(options.allowDestructive ? { allowDestructive: () => true } : {}),
  };
}

function freshDoc(): ProjectDocument {
  const doc = createProjectFromTemplate("house");
  // the house groove ships with notes — tests start from a CLEAN active
  // pattern so indices are deterministic
  return {
    ...doc,
    patterns: doc.patterns.map((p) => (p.id === doc.activePatternId ? { ...p, notes: {} } : p)),
  };
}

function notesOf(
  ctx: McpToolContext,
  family: string,
): Array<{ id: string; pitch: number; start: number; duration: number; velocity: number }> {
  // resolve EXACTLY like the tool does (family → first matching track)
  const doc = ctx.getDoc();
  const ids = explicitTrackIds(doc, { family });
  const trackId = typeof ids === "string" ? "" : (ids[0] ?? "");
  return doc.patterns.find((p) => p.id === doc.activePatternId)?.notes?.[trackId] ?? [];
}

describe("kyx_notes", async () => {
  it("discovers exact track targeting and only supported scale names", () => {
    const noteTool = MCP_TOOLS.find((tool) => tool.name === "kyx_notes");
    const schema = noteTool?.inputSchema;
    expect(schema?.properties.trackId).toMatchObject({ type: "string" });
    expect(schema?.properties.key).toMatchObject({ type: "string", enum: expect.arrayContaining(["A Natural Minor"]) });
    expect(schema?.properties.noteId).toMatchObject({ type: "string", maxLength: 128 });
    expect(schema?.properties.offset).toMatchObject({ type: "integer", minimum: 0 });
    expect(schema?.properties.startBeat).toMatchObject({ maximum: 1000000 });
    expect(schema?.properties.durationBeats).toMatchObject({ maximum: 1000000 });
    expect(noteTool?.outputSchema?.properties.status).toMatchObject({
      type: "string",
      enum: expect.arrayContaining(["listed", "added", "partial"]),
    });
  });

  it("list on an empty track reports honestly", async () => {
    const ctx = makeCtx(freshDoc());
    const r = await executeMcpTool(ctx, "kyx_notes", { op: "list", family: "bass" });
    expect(r.text).toContain("no notes");
    expect(r.mutated).toBe(false);
  });

  it("add by noteName lands clamped in the doc; list returns indexed entries", async () => {
    const ctx = makeCtx(freshDoc());
    const added = await executeMcpTool(ctx, "kyx_notes", {
      op: "add",
      family: "bass",
      noteName: "A1",
      startBeat: 0,
      durationBeats: 1,
      velocity: 0.9,
    });
    expect(added.mutated).toBe(true);
    expect(added.text).toContain("A1");
    expect(notesOf(ctx, "bass")).toHaveLength(1);
    expect(added.data).toMatchObject({
      status: "added",
      noteCount: 1,
      undoSteps: 1,
      note: { pitch: 33, noteName: "A1" },
    });

    await executeMcpTool(ctx, "kyx_notes", {
      op: "add",
      family: "bass",
      noteName: "C2",
      startBeat: 1,
      durationBeats: 0.5,
    });
    const list = await executeMcpTool(ctx, "kyx_notes", { op: "list", family: "bass" });
    expect(list.text).toContain("#0");
    expect(list.text).toContain("#1");
    expect(list.text).toContain("C2");
    expect(list.data).toMatchObject({ status: "listed", noteCount: 2, offset: 0, limit: 40, undoSteps: 0 });
    expect((list.data as { notes: Array<{ id: string; index: number }> }).notes.map((note) => note.index)).toEqual([
      0, 1,
    ]);
    expect((list.data as { notes: Array<{ id: string }> }).notes.every((note) => note.id.length > 0)).toBe(true);
  });

  it("list paginates large note sets and preserves stable IDs across pages", async () => {
    const ctx = makeCtx(freshDoc());
    for (let index = 0; index < 45; index += 1) {
      await executeMcpTool(ctx, "kyx_notes", {
        op: "add",
        family: "bass",
        pitch: 36 + (index % 24),
        startBeat: index / 2,
        durationBeats: 0.25,
      });
    }

    const first = await executeMcpTool(ctx, "kyx_notes", { op: "list", family: "bass", limit: 20 });
    const second = await executeMcpTool(ctx, "kyx_notes", { op: "list", family: "bass", offset: 20, limit: 20 });
    const third = await executeMcpTool(ctx, "kyx_notes", { op: "list", family: "bass", offset: 40, limit: 20 });
    const firstIds = (first.data as { notes: Array<{ id: string }> }).notes.map((note) => note.id);
    const secondIds = (second.data as { notes: Array<{ id: string }> }).notes.map((note) => note.id);
    const thirdIds = (third.data as { notes: Array<{ id: string }> }).notes.map((note) => note.id);

    expect(first.data).toMatchObject({ status: "listed", noteCount: 45, offset: 0, limit: 20, nextOffset: 20 });
    expect(second.data).toMatchObject({ status: "listed", noteCount: 45, offset: 20, limit: 20, nextOffset: 40 });
    expect(third.data).toMatchObject({ status: "listed", noteCount: 45, offset: 40, limit: 20 });
    expect(thirdIds).toHaveLength(5);
    expect(new Set([...firstIds, ...secondIds, ...thirdIds]).size).toBe(45);
  });

  it("noteId targets edits stably and structured read-back survives one-step undo", async () => {
    const store = new ProjectStore(freshDoc());
    const ctx = projectStoreCtx(store, { allowDestructive: true });
    await executeMcpTool(ctx, "kyx_notes", {
      op: "add",
      family: "bass",
      noteName: "A1",
      startBeat: 0,
      durationBeats: 1,
    });
    await executeMcpTool(ctx, "kyx_notes", {
      op: "add",
      family: "bass",
      noteName: "C2",
      startBeat: 1,
      durationBeats: 1,
    });
    const first = (
      await executeMcpTool(ctx, "kyx_notes", { op: "list", family: "bass" }).then(
        (result) =>
          result.data as {
            notes: Array<{ id: string; pitch: number }>;
          },
      )
    ).notes[0];
    const undoDepth = store.undoStackLength;

    const moved = await executeMcpTool(ctx, "kyx_notes", {
      op: "move",
      family: "bass",
      noteId: first.id,
      pitchDelta: 2,
    });
    expect(moved.data).toMatchObject({
      status: "moved",
      noteId: first.id,
      note: { id: first.id, pitch: first.pitch + 2 },
      undoSteps: 1,
    });
    expect(store.undoStackLength).toBe(undoDepth + 1);
    store.undo();
    expect(notesOf(ctx, "bass").find((note) => note.id === first.id)?.pitch).toBe(first.pitch);
    expect(store.undoStackLength).toBe(undoDepth);

    const velocity = await executeMcpTool(ctx, "kyx_notes", {
      op: "setVelocity",
      family: "bass",
      noteId: first.id,
      velocity: 0.45,
    });
    expect(velocity.data).toMatchObject({
      status: "velocity_set",
      noteId: first.id,
      note: { velocity: 0.45 },
      undoSteps: 1,
    });
    const deleted = await executeMcpTool(ctx, "kyx_notes", { op: "delete", family: "bass", noteId: first.id });
    expect(deleted.data).toMatchObject({ status: "deleted", noteId: first.id, noteCount: 1, undoSteps: 1 });
    expect(notesOf(ctx, "bass").some((note) => note.id === first.id)).toBe(false);
  });

  it("add rejects asks with neither pitch nor noteName", async () => {
    const ctx = makeCtx(freshDoc());
    const r = await executeMcpTool(ctx, "kyx_notes", { op: "add", family: "bass", startBeat: 0 });
    const oversized = await executeMcpTool(ctx, "kyx_notes", {
      op: "add",
      family: "bass",
      pitch: 60,
      startBeat: 1_000_001,
    });
    expect(r.isError ?? r.mutated === false).toBeTruthy();
    expect(r.text).toContain("noteName");
    expect(oversized.errorCode).toBe("INVALID_ARGUMENTS");
    expect(notesOf(ctx, "bass")).toHaveLength(0);
  });

  it("move by index shifts pitch and start; indices come from list", async () => {
    const ctx = makeCtx(freshDoc());
    await executeMcpTool(ctx, "kyx_notes", {
      op: "add",
      family: "bass",
      noteName: "A1",
      startBeat: 0,
      durationBeats: 1,
    });
    const moved = await executeMcpTool(ctx, "kyx_notes", {
      op: "move",
      family: "bass",
      index: 0,
      pitchDelta: 3,
      startBeat: 2,
    });
    expect(moved.mutated).toBe(true);
    expect(moved.data).toMatchObject({
      status: "moved",
      noteCount: 1,
      undoSteps: 1,
      note: { pitch: 36, startBeat: 2 },
    });
    const note = notesOf(ctx, "bass")[0];
    expect(note.pitch).toBe(33 + 3); // A1 = 33
    expect(note.start).toBe(2 * 480);
  });

  it("move without a valid index teaches the list-first contract", async () => {
    const ctx = makeCtx(freshDoc());
    const r = await executeMcpTool(ctx, "kyx_notes", { op: "move", family: "bass", index: 7, pitchDelta: 1 });
    expect(r.text).toContain("list");
    expect(r.mutated).toBe(false);
  });

  it("setVelocity clamps into range; delete removes by index (destructive-gated, audit 10-06)", async () => {
    // The D4 gate: note delete is a REMOVAL — refused until the user's chip
    // allows destructive ops, with an auto-checkpoint taken when allowed.
    const locked = makeCtx(freshDoc());
    await executeMcpTool(locked, "kyx_notes", {
      op: "add",
      family: "chords",
      noteName: "E4",
      startBeat: 0,
      durationBeats: 2,
    });
    const refused = await executeMcpTool(locked, "kyx_notes", { op: "delete", family: "chords", index: 0 });
    expect(refused.mutated).toBe(false);
    expect(refused.text).toContain("destructive MCP ops are locked");
    expect(notesOf(locked, "chords")).toHaveLength(1);

    const ctx = makeCtx(freshDoc(), { allowDestructive: true });
    await executeMcpTool(ctx, "kyx_notes", {
      op: "add",
      family: "chords",
      noteName: "E4",
      startBeat: 0,
      durationBeats: 2,
    });
    await executeMcpTool(ctx, "kyx_notes", { op: "setVelocity", family: "chords", index: 0, velocity: 5 });
    expect(notesOf(ctx, "chords")[0].velocity).toBe(1);
    const alreadySet = await executeMcpTool(ctx, "kyx_notes", {
      op: "setVelocity",
      family: "chords",
      index: 0,
      velocity: 5,
    });
    expect(alreadySet.data).toMatchObject({ status: "already_set", undoSteps: 0, clamped: true });
    const del = await executeMcpTool(ctx, "kyx_notes", { op: "delete", family: "chords", index: 0 });
    expect(del.mutated).toBe(true);
    expect(del.data).toMatchObject({ status: "deleted", noteCount: 0, undoSteps: 1 });
    expect(notesOf(ctx, "chords")).toHaveLength(0);
  });

  it("quantize snaps starts to the grid; scale mode runs", async () => {
    const store = new ProjectStore(freshDoc());
    const ctx = projectStoreCtx(store);
    await executeMcpTool(ctx, "kyx_notes", {
      op: "add",
      family: "bass",
      noteName: "Bb1",
      startBeat: 0.31,
      durationBeats: 0.4,
    });
    await executeMcpTool(ctx, "kyx_notes", {
      op: "add",
      family: "chords",
      pitch: 61,
      startBeat: 0.37,
      durationBeats: 0.4,
    });
    const chordBefore = notesOf(ctx, "chords")[0];
    const historyBefore = store.undoStackLength;
    await executeMcpTool(ctx, "kyx_notes", { op: "quantize", family: "bass", grid: "1/8" });
    expect(notesOf(ctx, "bass")[0].start % 240).toBe(0);
    expect(notesOf(ctx, "chords")[0].start).toBe(chordBefore.start);
    expect(store.undoStackLength).toBe(historyBefore + 1);
    const repeatedGrid = await executeMcpTool(ctx, "kyx_notes", { op: "quantize", family: "bass", grid: "1/8" });
    expect(repeatedGrid.data).toMatchObject({ status: "already_quantized", changedNotes: 0, undoSteps: 0 });
    expect(repeatedGrid.mutated).toBe(false);
    expect(store.undoStackLength).toBe(historyBefore + 1);
    store.undo();
    expect(notesOf(ctx, "bass")[0].start).toBe(Math.round(0.31 * 480));
    expect(notesOf(ctx, "chords")[0].start).toBe(chordBefore.start);

    const bassPitchBeforeScale = notesOf(ctx, "bass")[0].pitch;
    const bassIds = explicitTrackIds(ctx.getDoc(), { family: "bass" });
    const bassTrackId = typeof bassIds === "string" ? "" : bassIds[0];
    expect(bassTrackId).toBeTruthy();
    const scale = await executeMcpTool(ctx, "kyx_notes", {
      op: "quantize",
      trackId: bassTrackId,
      key: "A Natural Minor",
    });
    expect(notesOf(ctx, "bass")[0].pitch).not.toBe(bassPitchBeforeScale);
    expect(notesOf(ctx, "chords")[0].pitch).toBe(61);
    expect(scale.mutated).toBe(true);
    expect(scale.data).toMatchObject({ status: "quantized", targetNoteCount: 1, changedNotes: 1, undoSteps: 1 });
  });

  it("quantize rejects unsupported, conflicting and missing targets without mutating", async () => {
    const store = new ProjectStore(freshDoc());
    const ctx = projectStoreCtx(store);
    await executeMcpTool(ctx, "kyx_notes", {
      op: "add",
      family: "bass",
      noteName: "Bb1",
      startBeat: 0.31,
      durationBeats: 0.4,
    });
    const before = notesOf(ctx, "bass").map((note) => ({ ...note }));
    const undoDepth = store.undoStackLength;
    const invalidKey = await executeMcpTool(ctx, "kyx_notes", { op: "quantize", family: "bass", key: "A Minor" });
    const conflicting = await executeMcpTool(ctx, "kyx_notes", {
      op: "quantize",
      family: "bass",
      key: "A Natural Minor",
      grid: "1/8",
    });
    const missingTarget = await executeMcpTool(ctx, "kyx_notes", { op: "quantize", family: "bass" });

    expect(invalidKey.errorCode).toBe("INVALID_ARGUMENTS");
    expect(conflicting.errorCode).toBe("INVALID_ARGUMENTS");
    expect(missingTarget.errorCode).toBe("INVALID_ARGUMENTS");
    expect(notesOf(ctx, "bass")).toEqual(before);
    expect(store.undoStackLength).toBe(undoDepth);
  });

  it("transpose shifts the whole line by semitones", async () => {
    const ctx = makeCtx(freshDoc());
    await executeMcpTool(ctx, "kyx_notes", {
      op: "add",
      family: "bass",
      noteName: "A1",
      startBeat: 0,
      durationBeats: 1,
    });
    await executeMcpTool(ctx, "kyx_notes", {
      op: "add",
      family: "bass",
      noteName: "C2",
      startBeat: 1,
      durationBeats: 1,
    });
    await executeMcpTool(ctx, "kyx_notes", { op: "transpose", family: "bass", semitones: -3 });
    const pitches = notesOf(ctx, "bass").map((n) => n.pitch);
    expect(pitches).toEqual([30, 33]);
  });

  it("transpose commits a compound shift as one real-store undo step", async () => {
    const store = new ProjectStore(freshDoc());
    const ctx = projectStoreCtx(store);
    for (const [noteName, startBeat] of [
      ["A1", 0],
      ["C2", 1],
    ] as const) {
      await executeMcpTool(ctx, "kyx_notes", {
        op: "add",
        family: "bass",
        noteName,
        startBeat,
        durationBeats: 1,
      });
    }

    const before = notesOf(ctx, "bass").map((note) => ({ id: note.id, pitch: note.pitch }));
    const undoDepth = store.undoStackLength;
    const result = await executeMcpTool(ctx, "kyx_notes", { op: "transpose", family: "bass", semitones: -3 });

    expect(result.mutated).toBe(true);
    expect(notesOf(ctx, "bass").map((note) => note.pitch)).toEqual([30, 33]);
    expect(store.undoStackLength).toBe(undoDepth + 1);
    expect(store.lastCommandLabel).toContain("transpose");

    store.undo();
    expect(notesOf(ctx, "bass").map((note) => ({ id: note.id, pitch: note.pitch }))).toEqual(before);
    expect(store.undoStackLength).toBe(undoDepth);
  });

  it("transpose reports boundary clamps and keeps any partial edit in one undo step", async () => {
    const store = new ProjectStore(freshDoc());
    const ctx = projectStoreCtx(store);
    for (const [pitch, startBeat] of [
      [60, 0],
      [127, 1],
    ] as const) {
      await executeMcpTool(ctx, "kyx_notes", {
        op: "add",
        family: "bass",
        pitch,
        startBeat,
        durationBeats: 1,
      });
    }
    const undoDepth = store.undoStackLength;

    const result = await executeMcpTool(ctx, "kyx_notes", { op: "transpose", family: "bass", semitones: 1 });

    expect(result.errorCode).toBe("PARTIAL_FAILURE");
    expect(result.mutated).toBe(true);
    expect(result.text).toContain("1/2 notes");
    expect(notesOf(ctx, "bass").map((note) => note.pitch)).toEqual([61, 127]);
    expect(store.undoStackLength).toBe(undoDepth + 1);
    store.undo();
    expect(notesOf(ctx, "bass").map((note) => note.pitch)).toEqual([60, 127]);
    expect(store.undoStackLength).toBe(undoDepth);
  });

  it("transpose rejects fractional semitones and does not add history for a fully clamped shift", async () => {
    const fractionalCtx = makeCtx(freshDoc());
    const fractional = await executeMcpTool(fractionalCtx, "kyx_notes", {
      op: "transpose",
      family: "bass",
      semitones: 1.5,
    });
    expect(fractional.errorCode).toBe("INVALID_ARGUMENTS");
    expect(fractional.mutated).toBe(false);

    const store = new ProjectStore(freshDoc());
    const ctx = projectStoreCtx(store);
    await executeMcpTool(ctx, "kyx_notes", {
      op: "add",
      family: "bass",
      pitch: 127,
      startBeat: 0,
      durationBeats: 1,
    });
    const before = notesOf(ctx, "bass").map((note) => note.pitch);
    const undoDepth = store.undoStackLength;
    const clamped = await executeMcpTool(ctx, "kyx_notes", { op: "transpose", family: "bass", semitones: 1 });

    expect(clamped.errorCode).toBe("PARTIAL_FAILURE");
    expect(clamped.mutated).toBe(false);
    expect(notesOf(ctx, "bass").map((note) => note.pitch)).toEqual(before);
    expect(store.undoStackLength).toBe(undoDepth);
  });

  it("transposeAll (kyx_music) hits every instrument track with one undo step", async () => {
    const ctx = makeCtx(freshDoc());
    await executeMcpTool(ctx, "kyx_notes", {
      op: "add",
      family: "bass",
      noteName: "A1",
      startBeat: 0,
      durationBeats: 1,
    });
    await executeMcpTool(ctx, "kyx_notes", {
      op: "add",
      family: "chords",
      noteName: "E4",
      startBeat: 0,
      durationBeats: 1,
    });
    const r = await executeMcpTool(ctx, "kyx_music", { op: "transposeAll", semitones: 5 });
    expect(r.mutated).toBe(true);
    expect(r.data).toMatchObject({
      status: "transposed",
      op: "transposeAll",
      target: "all",
      requestedSemitones: 5,
      targetNoteCount: 2,
      transposedNotes: 2,
      partialNotes: 0,
      undoSteps: 1,
    });
    expect(notesOf(ctx, "bass")[0].pitch).toBe(33 + 5);
    expect(notesOf(ctx, "chords")[0].pitch).toBe(64 + 5);
  });

  it("transposeAll reports boundary-clamped notes as a partial result", async () => {
    const ctx = makeCtx(freshDoc());
    await executeMcpTool(ctx, "kyx_notes", {
      op: "add",
      family: "bass",
      pitch: 127,
      startBeat: 0,
      durationBeats: 1,
    });
    const result = await executeMcpTool(ctx, "kyx_music", { op: "transposeAll", target: "bass", semitones: 1 });
    expect(result.errorCode).toBe("PARTIAL_FAILURE");
    expect(result.data).toMatchObject({
      status: "partial",
      targetNoteCount: 1,
      transposedNotes: 0,
      partialNotes: 1,
      undoSteps: 0,
    });
    expect(notesOf(ctx, "bass")[0].pitch).toBe(127);
  });

  it("transposeAll reports an empty target without creating an undoable mutation", async () => {
    const ctx = makeCtx(freshDoc());
    const result = await executeMcpTool(ctx, "kyx_music", { op: "transposeAll", target: "bass", semitones: -2 });
    expect(result.data).toMatchObject({ status: "no_notes", target: "bass", targetNoteCount: 0, undoSteps: 0 });
    expect(result.mutated).toBe(false);
  });
});

describe("kyx_music", async () => {
  it("setTempo lands on the doc and reports the read-back", async () => {
    const ctx = makeCtx(freshDoc());
    const r = await executeMcpTool(ctx, "kyx_music", { op: "setTempo", bpm: 140 });
    expect(r.mutated).toBe(true);
    expect(ctx.getDoc().bpm).toBe(140);
    expect(r.text).toContain("140");
    expect(r.data).toMatchObject({ status: "set", op: "setTempo", bpm: 140, undoSteps: 1 });
    const repeated = await executeMcpTool(ctx, "kyx_music", { op: "setTempo", bpm: 140 });
    expect(repeated.data).toMatchObject({ status: "already_set", bpm: 140, undoSteps: 0 });
  });

  it("setKey accepts a supported musical key and rejects unsupported aliases", async () => {
    const ctx = makeCtx(freshDoc());
    const r = await executeMcpTool(ctx, "kyx_music", { op: "setKey", key: "F# Natural Minor" });
    expect(r.mutated).toBe(true);
    expect(ctx.getDoc().key).toBe("F# Natural Minor");
    expect(r.data).toMatchObject({ status: "set", op: "setKey", key: "F# Natural Minor", undoSteps: 1 });
    const invalid = await executeMcpTool(ctx, "kyx_music", { op: "setKey", key: "not a key" });
    expect(invalid.errorCode).toBe("INVALID_ARGUMENTS");
    expect(ctx.getDoc().key).toBe("F# Natural Minor");
  });

  it("setPatternLength resizes the active pattern", async () => {
    const ctx = makeCtx(freshDoc());
    const r = await executeMcpTool(ctx, "kyx_music", { op: "setPatternLength", steps: 32 });
    expect(r.mutated).toBe(true);
    const active = ctx.getDoc().patterns.find((p) => p.id === ctx.getDoc().activePatternId);
    expect(active?.stepCount).toBe(32);
    expect(r.data).toMatchObject({
      status: "set",
      op: "setPatternLength",
      patternId: active?.id,
      steps: 32,
      undoSteps: 1,
    });
    const repeated = await executeMcpTool(ctx, "kyx_music", { op: "setPatternLength", steps: 32 });
    expect(repeated.data).toMatchObject({ status: "already_set", patternId: active?.id, steps: 32, undoSteps: 0 });
  });

  it("setTimeSignature reports committed state and skips same-value writes", async () => {
    const ctx = makeCtx(freshDoc());
    const changed = await executeMcpTool(ctx, "kyx_music", { op: "setTimeSignature", numerator: 7, denominator: 8 });
    expect(changed.data).toMatchObject({
      status: "set",
      op: "setTimeSignature",
      numerator: 7,
      denominator: 8,
      undoSteps: 1,
    });
    expect(ctx.getDoc().timeSignature).toEqual({ numerator: 7, denominator: 8 });
    const repeated = await executeMcpTool(ctx, "kyx_music", { op: "setTimeSignature", numerator: 7, denominator: 8 });
    expect(repeated.data).toMatchObject({ status: "already_set", numerator: 7, denominator: 8, undoSteps: 0 });
  });

  it("strict numeric validation rejects fractions and lengths above the canonical command cap", async () => {
    const ctx = makeCtx(freshDoc());
    const tempo = await executeMcpTool(ctx, "kyx_music", { op: "setTempo", bpm: 140.5 });
    const meter = await executeMcpTool(ctx, "kyx_music", { op: "setTimeSignature", numerator: 4.5, denominator: 4 });
    const length = await executeMcpTool(ctx, "kyx_music", { op: "setPatternLength", steps: 256 });
    expect(tempo.errorCode).toBe("INVALID_ARGUMENTS");
    expect(meter.errorCode).toBe("INVALID_ARGUMENTS");
    expect(length.errorCode).toBe("INVALID_ARGUMENTS");
    expect(ctx.getDoc().bpm).not.toBeNaN();
    expect(ctx.getDoc().timeSignature.numerator).toBe(4);
  });

  it("unknown op and missing bpm answer honestly without mutating", async () => {
    const ctx = makeCtx(freshDoc());
    const junk = await executeMcpTool(ctx, "kyx_music", { op: "vibes" });
    expect(junk.text).toContain("unknown op");
    const noBpm = await executeMcpTool(ctx, "kyx_music", { op: "setTempo" });
    expect(noBpm.text).toContain("bpm");
    expect(ctx.getDoc().bpm).not.toBeNaN();
  });
});
