import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SESSION_TAPE_CAP,
  SESSION_TAPE_KEY,
  clearTape,
  markTapeAbandonedAfter,
  recordTapeStep,
  resetTapeForTests,
  rewindTargetFor,
  tapeSteps,
} from "../src/intent/session-tape";

/**
 * SESSION TAPE — the journal and its rewind.
 *
 * These specs pin the two promises that make it trustworthy: the journal is
 * bounded and survives a reload (defensively), and a rewind either lands
 * EXACTLY where the step left the session or refuses with a reason — it never
 * silently lands somewhere else.
 */

function record(
  prompt: string,
  outcome: "applied" | "generated" | "applied-candidate" | "clarify",
  undoDepthAfter: number | null,
) {
  return recordTapeStep({
    doc: { id: "doc-1" },
    prompt,
    outcome,
    routeKind: outcome === "applied" ? "fader" : outcome === "applied-candidate" ? "candidateUse" : "generation",
    action: "adjust:trackGain:rel",
    undoDepthAfter,
    at: 1_000 + tapeSteps().length,
  });
}

beforeEach(() => {
  localStorage.clear();
  resetTapeForTests();
});

afterEach(() => {
  localStorage.clear();
});

describe("session tape — journal", () => {
  it("records steps newest-first and carries the honest fields", () => {
    record("turn the drums up", "applied", 4);
    record("dark trap at 142", "generated", null);

    const steps = tapeSteps();
    expect(steps).toHaveLength(2);
    expect(steps[0]!.prompt).toBe("dark trap at 142");
    expect(steps[0]!.undoDepthAfter).toBeNull();
    expect(steps[1]).toMatchObject({
      prompt: "turn the drums up",
      undoDepthAfter: 4,
      abandoned: false,
      docId: "doc-1",
    });
  });

  it("is bounded: a long session cannot grow the journal without limit", () => {
    for (let index = 0; index < SESSION_TAPE_CAP + 5; index += 1) {
      record(`prompt ${index}`, "applied", index + 1);
    }
    const steps = tapeSteps();
    expect(steps).toHaveLength(SESSION_TAPE_CAP);
    expect(steps[0]!.prompt).toBe(`prompt ${SESSION_TAPE_CAP + 4}`);
    expect(steps[steps.length - 1]!.prompt).toBe("prompt 5");
  });

  it("survives a reload (persisted, bounded) and degrades on junk", () => {
    record("kept across reload", "applied", 2);
    // resetTapeForTests drops module state WITHOUT touching storage — a reload.
    resetTapeForTests();
    expect(tapeSteps()).toHaveLength(1);
    expect(tapeSteps()[0]!.prompt).toBe("kept across reload");

    localStorage.setItem(SESSION_TAPE_KEY, "{not json");
    resetTapeForTests();
    expect(tapeSteps()).toEqual([]);

    localStorage.setItem(
      SESSION_TAPE_KEY,
      JSON.stringify([{ id: "x" }, { outcome: "applied" }, { id: "y", at: 5, outcome: "applied", undoDepthAfter: 1 }]),
    );
    resetTapeForTests();
    expect(tapeSteps()).toHaveLength(1);
    expect(tapeSteps()[0]!.id).toBe("y");
  });

  it("clears on request", () => {
    record("x", "applied", 1);
    clearTape();
    expect(tapeSteps()).toEqual([]);
    expect(localStorage.getItem(SESSION_TAPE_KEY)).toBeNull();
  });

  it("bounds the prompt text it stores (a journal, not a transcript)", () => {
    recordTapeStep({
      doc: { id: "doc-1" },
      prompt: "x".repeat(5_000),
      outcome: "applied",
      routeKind: "fader",
      action: "adjust:trackGain:rel",
      undoDepthAfter: 1,
    });
    expect(tapeSteps()[0]!.prompt.length).toBeLessThanOrEqual(240);
  });
});

describe("session tape — rewind targets", () => {
  it("points at the state the step left behind (1-based depth → 0-based index)", () => {
    const step = record("turn the drums up", "applied", 4);
    expect(rewindTargetFor(step, 7)).toEqual({ index: 3 });
  });

  it("is a no-op target for the newest step", () => {
    const step = record("turn the drums up", "applied", 4);
    expect(rewindTargetFor(step, 4)).toEqual({ index: 3 });
  });

  it("REFUSES a step that applied nothing instead of guessing", () => {
    const step = record("dark trap at 142", "generated", null);
    const target = rewindTargetFor(step, 4);
    expect("refusal" in target && target.refusal).toContain("applied nothing");
  });

  it("REFUSES a step the undo window no longer reaches (pruned)", () => {
    const step = record("turn the drums up", "applied", 9);
    const target = rewindTargetFor(step, 3);
    expect("refusal" in target && target.refusal).toContain("no longer reaches");
  });

  it("REFUSES the very first state", () => {
    const step = record("turn the drums up", "applied", 0);
    const target = rewindTargetFor(step, 2);
    expect("refusal" in target && target.refusal).toContain("very first state");
  });
});

describe("session tape — detached branches", () => {
  it("marks every LATER step abandoned and is idempotent", () => {
    record("a", "applied", 1);
    const pivot = record("b", "applied", 2);
    record("c", "applied", 3);

    expect(markTapeAbandonedAfter(pivot.id)).toBe(1);
    const steps = tapeSteps(); // newest first: c, b, a
    expect(steps[0]!.prompt).toBe("c");
    expect(steps[0]!.abandoned).toBe(true);
    expect(steps[1]!.abandoned).toBe(false);
    expect(steps[2]!.abandoned).toBe(false);
    expect(markTapeAbandonedAfter(pivot.id)).toBe(0);
  });

  it("ignores an unknown step id", () => {
    record("a", "applied", 1);
    expect(markTapeAbandonedAfter("tape-999")).toBe(0);
  });
});
