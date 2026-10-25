/**
 * An AI write must not silently overwrite a field a human moved after the AI
 * read it (audit F-25).
 *
 * Measured (probe T2): the human set the fader to 0.9, the AI's older 0.5
 * landed afterwards, and the fader ended at 0.5 — the human's newer value was
 * gone, and the AI's acknowledgement said nothing about it.
 *
 * The document carries no revision counter, so the check uses what the
 * command already carries: the document it was computed against (`base`) and
 * the paths it writes (`ops`). A field whose value differs between the base
 * and the document the write would land on has MOVED — the write is refused,
 * the conflict is reported, and nothing is written.
 *
 * The check is PER FIELD: an edit to another field (or another track) does
 * not block the write.
 */
import { describe, expect, it } from "vitest";
import { ProjectStore } from "../src/store/ProjectStore";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { setTrackParams } from "../src/commands/project";
import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import type { Command } from "../src/commands/types";

const house = () => createProjectFromTemplate("house");

/**
 * The human's edit lands in the window between the tool's read and the
 * write — the race the finding is about.
 */
function ctxRacing(store: ProjectStore, humanEdit: () => void): McpToolContext {
  return {
    getDoc: () => store.doc,
    execute: (command: Command) => {
      humanEdit();
      store.execute(command);
    },
    undo: () => store.undo(),
    redo: () => store.redo(),
    undoStackLength: () => store.undoStackLength,
    historyLabels: () => store.history.map((e) => e.label),
    isMicRecordingActive: () => false,
    transport: {
      play() {},
      stop() {},
      pause() {},
      setLoop() {},
      setMetronome() {},
    },
  } as unknown as McpToolContext;
}

describe("a stale AI write is refused, not applied (F-25)", () => {
  /** Values derived from the base so the test never depends on a template default. */
  const otherThan = (base: number) => (base > 0.5 ? 0.31 : 0.72);

  it("the human's newer value survives and the write is refused with a named conflict", async () => {
    const store = new ProjectStore(house());
    const track = store.doc.tracks[0];
    const baseGain = track.gain;
    const aiGain = otherThan(baseGain);
    const humanGain = otherThan(aiGain);

    const result = await executeMcpTool(
      ctxRacing(store, () => {
        store.execute(setTrackParams(store.doc, track.id, { gain: humanGain }));
      }),
      "kyx_tracks",
      { op: "setGain", trackId: track.id, gain: aiGain },
    );

    expect(result.mutated).toBe(false);
    expect(result.errorCode).toBe("WRITE_CONFLICT");
    expect(result.text).toContain("stale write refused");
    // The conflict NAMES the field and both values.
    expect(result.text).toContain("gain");
    expect(result.text).toContain(String(humanGain));

    // The human's newer value survived.
    expect(store.doc.tracks[0].gain).toBe(humanGain);
    // The refusal left NO dead undo step behind.
    expect(store.undoStackLength).toBe(1);
  });

  it("an edit to a DIFFERENT field does not block the write", async () => {
    const store = new ProjectStore(house());
    const track = store.doc.tracks[0];
    const aiGain = otherThan(track.gain);

    const result = await executeMcpTool(
      ctxRacing(store, () => {
        store.execute(setTrackParams(store.doc, track.id, { pan: 0.4 }));
      }),
      "kyx_tracks",
      { op: "setGain", trackId: track.id, gain: aiGain },
    );

    expect(result.mutated).toBe(true);
    expect(store.doc.tracks[0].gain).toBe(aiGain);
    expect(store.doc.tracks[0].pan).toBe(0.4);
  });

  it("force is the escape hatch — it overwrites regardless", async () => {
    const store = new ProjectStore(house());
    const track = store.doc.tracks[0];
    const baseGain = track.gain;
    const aiGain = otherThan(baseGain);
    const humanGain = otherThan(aiGain);

    const result = await executeMcpTool(
      ctxRacing(store, () => {
        store.execute(setTrackParams(store.doc, track.id, { gain: humanGain }));
      }),
      "kyx_tracks",
      { op: "setGain", trackId: track.id, gain: aiGain, force: true },
    );

    expect(result.mutated).toBe(true);
    expect(store.doc.tracks[0].gain).toBe(aiGain);
  });

  it("a write with nothing moved lands normally (the control)", async () => {
    const store = new ProjectStore(house());
    const track = store.doc.tracks[0];
    const aiGain = otherThan(track.gain);

    const result = await executeMcpTool(
      ctxRacing(store, () => {
        /* no human edit */
      }),
      "kyx_tracks",
      { op: "setGain", trackId: track.id, gain: aiGain },
    );

    expect(result.mutated).toBe(true);
    expect(store.doc.tracks[0].gain).toBe(aiGain);
    expect(store.undoStackLength).toBe(1);
  });
});
