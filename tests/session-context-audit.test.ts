import { beforeEach, describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import {
  applySessionCandidateCommand,
  lastGeneration,
  promptHistory,
  rememberGeneration,
  rememberPrompt,
  resolveSessionReference,
  type SessionCandidate,
  type SessionGeneration,
} from "../src/intent/session-context";
import type { Pattern, ProjectDocument } from "../src/project-model/types";

/**
 * SESSION CONTEXT (vibe-code wave 2): the previous generation's candidate
 * bank stays addressable — "that second one, darker" re-applies candidate
 * #2 without regenerating. Ordinal resolution is word-token based, EN + SK
 * de-accented, and the apply path is ONE undoable snapshot (append-or-
 * activate).
 */

const doc: ProjectDocument = createProjectFromTemplate("house");

// A candidate bank is fresh patterns — the house template ships exactly one,
// so clone it with distinct ids to synthesize an N-candidate bank.
const candidates = (n: number): SessionCandidate[] => {
  const base = doc.patterns[0]!;
  return Array.from({ length: n }, (_, index) => ({
    index,
    pattern: { ...base, id: index === 0 ? base.id : `${base.id}-cand-${index}` },
    intent: {} as SessionCandidate["intent"],
  }));
};

const bank = (n: number): SessionGeneration => ({
  text: "dark drill",
  intent: {} as SessionGeneration["intent"],
  candidates: candidates(n),
  appliedIndex: null,
  docId: doc.id,
  at: 0,
});

beforeEach(() => {
  // The store is module-level — reset by remembering an empty bank.
  rememberGeneration({ ...bank(0), candidates: [] });
});

describe("resolveSessionReference", () => {
  it("empty bank → always null (nothing to refer to)", () => {
    expect(resolveSessionReference("that second one", [])).toBeNull();
  });

  it('"that second one, darker" → index 1, rest re-parsable', () => {
    const hit = resolveSessionReference("that second one, darker", candidates(3))!;
    expect(hit.index).toBe(1);
    expect(hit.rest).toBe("darker");
  });

  it("SK de-accented: 'ten treti ale tvrdsi' → index 2, modifiers kept", () => {
    const hit = resolveSessionReference("ten treti ale tvrdsi", candidates(4))!;
    expect(hit.index).toBe(2);
    expect(hit.rest).toBe("ale tvrdsi");
  });

  it('"prvy" alone resolves to index 0', () => {
    expect(resolveSessionReference("prvy", candidates(2))!.index).toBe(0);
  });

  it("ordinal past the bank → null (no silent wrap to the last candidate)", () => {
    expect(resolveSessionReference("that fourth one", candidates(3))).toBeNull();
  });

  it("no reference phrase → null (flows to generation)", () => {
    expect(resolveSessionReference("darker beat please", candidates(3))).toBeNull();
  });

  it('"that one" fallback → index 0 without an ordinal', () => {
    const hit = resolveSessionReference("that one, harder", candidates(3))!;
    expect(hit.index).toBe(0);
    expect(hit.rest).toBe("harder");
  });
});

describe("prompt history", () => {
  it("dedupes, caps at 24 and returns newest-first", async () => {
    for (let i = 0; i < 30; i++) rememberPrompt(`prompt ${i}`);
    rememberPrompt("prompt 29"); // duplicate → bumped, not re-added
    let history = promptHistory();
    expect(history.length).toBe(24);
    expect(history.filter((e) => e.text === "prompt 29").length).toBe(1);
    expect(history.some((e) => e.text === "prompt 0")).toBe(false);
    await new Promise((r) => setTimeout(r, 2)); // distinct timestamp for the ordering assertion
    rememberPrompt("the newest one");
    history = promptHistory();
    expect(history[0]!.text).toBe("the newest one");
    rememberPrompt("   "); // whitespace-only is ignored
    expect(promptHistory().length).toBe(24);
  });
});

describe("applySessionCandidateCommand", () => {
  it("re-apply of a live pattern id → only activePatternId flips, ONE undo restores", () => {
    const pattern = doc.patterns[0]!;
    const before = doc.activePatternId;
    const cmd = applySessionCandidateCommand(doc, pattern);
    const next = cmd.execute(doc);
    expect(next.patterns.length).toBe(doc.patterns.length); // appended nothing
    expect(next.activePatternId).toBe(pattern.id);
    const undone = cmd.undo(next);
    expect(undone.activePatternId).toBe(before);
    expect(undone).toEqual(doc);
  });

  it("candidate whose id is gone → appended and activated, ONE undo removes it", () => {
    const pattern = doc.patterns[0]!;
    const detached: Pattern = { ...pattern, id: `${pattern.id}-variant` };
    const cmd = applySessionCandidateCommand(doc, detached);
    const next = cmd.execute(doc);
    expect(next.patterns.length).toBe(doc.patterns.length + 1);
    expect(next.activePatternId).toBe(detached.id);
    const undone = cmd.undo(next);
    expect(undone.patterns.length).toBe(doc.patterns.length);
    expect(undone).toEqual(doc);
  });
});

describe("rememberGeneration / lastGeneration", () => {
  it("last generation stays addressable", () => {
    const generation = bank(3);
    rememberGeneration(generation);
    expect(lastGeneration()).toBe(generation);
    expect(lastGeneration()!.candidates[2]!.index).toBe(2);
  });
});
