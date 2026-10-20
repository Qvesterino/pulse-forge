import { describe, it, expect } from "vitest";
import { executeMcpTool, explicitTrackIds, type McpToolContext } from "../src/mcp/tools";
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

function projectStoreCtx(store: ProjectStore): McpToolContext {
  return {
    getDoc: () => store.doc,
    execute: (command) => store.execute(command),
    undo: () => store.undo(),
    redo: () => store.redo(),
    undoStackLength: () => store.undoStackLength,
    historyLabels: () => store.history.map((entry) => entry.label),
    isMicRecordingActive: () => false,
    transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
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
    expect((list.data as { count: number }).count).toBe(2);
  });

  it("add rejects asks with neither pitch nor noteName", async () => {
    const ctx = makeCtx(freshDoc());
    const r = await executeMcpTool(ctx, "kyx_notes", { op: "add", family: "bass", startBeat: 0 });
    expect(r.isError ?? r.mutated === false).toBeTruthy();
    expect(r.text).toContain("noteName");
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
    const del = await executeMcpTool(ctx, "kyx_notes", { op: "delete", family: "chords", index: 0 });
    expect(del.mutated).toBe(true);
    expect(notesOf(ctx, "chords")).toHaveLength(0);
  });

  it("quantize snaps starts to the grid; scale mode runs", async () => {
    const ctx = makeCtx(freshDoc());
    await executeMcpTool(ctx, "kyx_notes", {
      op: "add",
      family: "bass",
      noteName: "A1",
      startBeat: 0.31,
      durationBeats: 0.4,
    });
    await executeMcpTool(ctx, "kyx_notes", { op: "quantize", family: "bass", grid: "1/8" });
    expect(notesOf(ctx, "bass")[0].start % 240).toBe(0);
    const scale = await executeMcpTool(ctx, "kyx_notes", { op: "quantize", family: "bass", key: "A Minor" });
    expect(scale.mutated).toBe(true);
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
