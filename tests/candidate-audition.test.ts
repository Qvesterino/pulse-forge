import { describe, it, expect, vi, beforeEach } from "vitest";
import { testDoc } from "./fixtures/doc";
import { generateAsyncResult, resultForCandidate } from "../src/intent/pipeline";
import { normalizeIntent } from "../src/intent/normalize";
import { applyGenerationResultCommand } from "../src/commands/commands";
import { getActivePattern } from "../src/project-model/types";

// Stub the prior clients (deterministic drums, unavailable melodic → template
// melody) exactly like the symbolic test files. The ranker runs through its
// real client; `pf:intent-ranker` is forced per-test below.
vi.mock("../src/ai/symbolic/prior-client", () => ({
  runPriorGrid: vi.fn(async (batch: Float32Array, rowCount: number) => ({
    ok: batch.length === rowCount * 44,
    probs: new Array(rowCount).fill(0.35),
    source: "model" as const,
  })),
  runMelodicNext: vi.fn(async () => ({ ok: false, degree: null, duration: null, source: "fallback" as const })),
  priorMode: vi.fn(() => "on" as const),
  resetPriorClient: vi.fn(),
  currentPriorManifest: vi.fn(() => null),
}));

const INTENT = normalizeIntent({
  genre: "house",
  seed: "audition",
  candidateCount: 3,
  symbolicCandidates: 2,
  length: 16,
});

function setRankerMode(mode: "off" | "shadow" | "active") {
  localStorage.setItem("pf:intent-ranker", mode);
}

beforeEach(() => {
  setRankerMode("off");
});

describe("candidate audition — engine side (A1)", () => {
  it("includeBank returns the full ranked bank with the winner first", async () => {
    const doc = testDoc();
    const result = await generateAsyncResult(doc, INTENT, { mode: "apply", includeBank: true });
    expect(result.bank).toBeDefined();
    expect(result.bank!.length).toBe(5);
    // Winner identity: the default proposal IS the best bank entry.
    expect(result.proposal!.pattern).toBe(result.bank![0].pattern);
    expect(result.selection).toBeDefined();
    // Every candidate passed the shared gates.
    for (const candidate of result.bank!) {
      expect(["accepted", "repaired"]).toContain(candidate.status);
      expect(candidate.source === "template" || candidate.source === "symbolic-prior").toBe(true);
    }
    // Both sources are represented (3 template + 2 prior).
    expect(result.bank!.filter((c) => c.source === "symbolic-prior").length).toBe(2);
  });

  it("without includeBank the result has no bank (backward compatible)", async () => {
    const doc = testDoc();
    const result = await generateAsyncResult(doc, INTENT, { mode: "apply" });
    expect(result.bank).toBeUndefined();
    expect(result.selection).toBeUndefined();
    expect(result.proposal).toBeDefined();
  });

  it("heuristic mode orders the bank by descending heuristic score", async () => {
    setRankerMode("off");
    const doc = testDoc();
    const result = await generateAsyncResult(doc, INTENT, { mode: "apply", includeBank: true });
    const scores = result.bank!.map((candidate) => candidate.score);
    for (let index = 1; index < scores.length; index++) {
      expect(scores[index - 1]).toBeGreaterThanOrEqual(scores[index]);
    }
    expect(result.bank!.every((candidate) => candidate.modelScore === null)).toBe(true);
  });

  it("resultForCandidate wraps ANY bank candidate with truthful provenance", async () => {
    const doc = testDoc();
    const result = await generateAsyncResult(doc, INTENT, { mode: "apply", includeBank: true });
    const pick = result.bank![2];
    const picked = resultForCandidate(result, pick.candidateIndex);
    // Content identity: exactly the auditioned candidate, not a regeneration.
    expect(picked.proposal!.pattern.rows).toEqual(pick.pattern.rows);
    expect(picked.proposal!.pattern.generation?.outputContentHash).toBe(pick.pattern.generation?.outputContentHash);
    // Provenance: human selection recorded.
    expect(picked.diagnostics.warnings).toContain("selection:user-audition");
    expect(picked.diagnostics.warnings).toContain(`candidate-bank-selected:${pick.candidateIndex}:${pick.source}`);
    expect(picked.status).toBe(pick.status);
  });

  it("ranker off keeps the historical no-provenance contract on picked candidates", async () => {
    setRankerMode("off");
    const doc = testDoc();
    const result = await generateAsyncResult(doc, INTENT, { mode: "apply", includeBank: true });
    const picked = resultForCandidate(result, result.bank![1].candidateIndex);
    expect(picked.proposal!.pattern.generation?.ranker).toBeUndefined();
  });

  it("shadow mode stamps the picked candidate with its bank index", async () => {
    setRankerMode("shadow");
    const doc = testDoc();
    const result = await generateAsyncResult(doc, INTENT, { mode: "apply", includeBank: true });
    const pick = result.bank![1];
    const picked = resultForCandidate(result, pick.candidateIndex);
    expect(result.selection?.mode).toBe("shadow");
    const ranker = picked.proposal!.pattern.generation?.ranker;
    expect(ranker?.selectedIndex).toBe(pick.candidateIndex);
    expect(ranker?.mode).toBe("shadow");
  });

  it("resultForCandidate rejects invalid banks and unknown candidates", async () => {
    const doc = testDoc();
    const result = await generateAsyncResult(doc, INTENT, { mode: "apply", includeBank: true });
    expect(() => resultForCandidate(result, 99)).toThrow(/not in the bank/);
    const { bank: _bank, ...withoutBank } = result;
    expect(() => resultForCandidate({ ...withoutBank, bank: undefined } as typeof result, 0)).toThrow(
      /no candidate bank/,
    );
  });

  it("applies exactly the auditioned candidate through one command", async () => {
    setRankerMode("shadow");
    const doc = testDoc();
    const result = await generateAsyncResult(doc, INTENT, { mode: "apply", includeBank: true });
    const pick = result.bank![1];
    const picked = resultForCandidate(result, pick.candidateIndex);
    const command = applyGenerationResultCommand(doc, picked, "Audition pick");
    const next = command.execute(doc);
    const active = getActivePattern(next);
    expect(active).toBeDefined();
    expect(active!.rows).toEqual(pick.pattern.rows);
    expect(active!.name).toBe("Audition pick");
    expect(active!.generation?.ranker?.selectedIndex).toBe(pick.candidateIndex);
    // Undo restores the pre-audition document.
    const undone = command.undo(next);
    expect(undone.patterns.length).toBe(doc.patterns.length);
  });
});
