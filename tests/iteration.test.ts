import { describe, expect, it } from "vitest";
import { testDoc } from "./fixtures/doc";
import { generateAsyncResult } from "../src/intent/pipeline";
import { normalizeIntent } from "../src/intent/normalize";
import { compileIteration } from "../src/intent/iteration";
import { applyGenerationResultCommand } from "../src/commands/commands";
import { rememberGeneration, lastGeneration, type SessionGeneration } from "../src/intent/session-context";
import { contentHash, canonicalizePattern } from "../src/ai/evaluation";
import { hashString } from "../src/shared/rng";
import { briefGateViolations } from "../src/intent/brief-gate";

/**
 * FÁZA 3 (AI-first producer): the follow-up prompt as a targeted edit
 * proposal — "ten druhý je lepší, ale temnejší; nechaj bass a akordy".
 * Scope is explicit (summary), protected content stays content-identical,
 * accept = exactly one undoable command, reject leaves no trace.
 */

beforeEachHook();
function beforeEachHook() {
  localStorage.setItem("pf:intent-ranker", "off");
}

async function sessionWith(length = 16): Promise<{ generation: SessionGeneration; doc: ReturnType<typeof testDoc> }> {
  const doc = testDoc();
  const result = await generateAsyncResult(
    doc,
    normalizeIntent({ genre: "house", seed: "iteration-base", candidateCount: 3, length }),
    { mode: "apply", includeBank: true },
  );
  const generation: SessionGeneration = {
    text: "house beat",
    intent: result.plan.intent,
    candidates: (result.bank ?? []).map((entry, index) => ({
      index,
      pattern: entry.pattern,
      intent: result.plan.intent,
    })),
    appliedIndex: null,
    docId: doc.id,
    at: 0,
  };
  return { generation, doc };
}

const hashOf = (value: unknown): string => hashString(JSON.stringify(value)).toString(16);

describe("compileIteration — proposal shape", () => {
  it("resolves the reference, the patch and the preserve clause", async () => {
    const { generation, doc } = await sessionWith();
    const proposal = compileIteration("ten druhý je lepší, ale temnejší; nechaj bass a akordy", generation, doc);
    expect(proposal).not.toBeNull();
    expect(proposal!.referenceIndex).toBe(1);
    expect(proposal!.patch.mood).toBe("dark");
    expect(proposal!.preserve).toEqual(["bass", "chords"]);
    expect(proposal!.targets).toContain("drums");
    expect(proposal!.result.bank).toHaveLength(1);
    // Scope is stated, not implicit.
    expect(proposal!.summary).toContain("ponechané: bass, chords");
    expect(proposal!.summary).toContain("melodika ponechaná");
  });

  it("a pure reference is not an iteration (instant re-apply stays)", async () => {
    const { generation, doc } = await sessionWith();
    expect(compileIteration("ten druhý", generation, doc)).toBeNull();
  });

  it("no reference → not an iteration", async () => {
    const { generation, doc } = await sessionWith();
    expect(compileIteration("temný techno", generation, doc)).toBeNull();
  });

  it("a fully preserved candidate has nothing to regenerate", async () => {
    const { generation, doc } = await sessionWith();
    // drums preserved + melodic preserved → no regenerable target
    expect(compileIteration("ten druhý, nechaj bicie a basu", generation, doc)).toBeNull();
  });

  it("does not silently re-apply a candidate when every requested role is protected", async () => {
    const { generation, doc } = await sessionWith();
    const iteration = compileIteration("ten druhý, ale temnejší; nechaj bicie a basu", generation, doc);
    expect(iteration).not.toBeNull();
    expect(iteration!.result.status).toBe("rejected");
    expect(iteration!.result.proposal).toBeUndefined();
  });
});

describe("targeted regeneration — splice scope", () => {
  it("drums-target iteration keeps melodic content content-identical", async () => {
    const { generation, doc } = await sessionWith();
    const proposal = compileIteration("ten druhý, ale temnejší; nechaj bass a akordy", generation, doc)!;
    const candidate = generation.candidates[1].pattern;
    // Protected melodic block is byte-identical…
    expect(hashOf(proposal.result.proposal!.pattern.notes)).toBe(hashOf(candidate.notes));
    // …while the drum rows regenerated (different seed family).
    expect(hashOf(proposal.result.proposal!.pattern.rows)).not.toBe(hashOf(candidate.rows));
  });

  it("an explicit no-drums iteration removes rows and passes the final hard gate", async () => {
    const { generation, doc } = await sessionWith();
    const proposal = compileIteration("ten druhý, ale temnejší, žiadne bicie", generation, doc)!;
    expect(proposal.result.proposal!.pattern.rows).toEqual({});
    expect(hashOf(proposal.result.proposal!.pattern.notes)).not.toBe(hashOf(generation.candidates[1].pattern.notes));
    expect(briefGateViolations(proposal.result.proposal!.pattern, proposal.result.plan)).toEqual([]);
    expect(proposal.result.diagnostics.warnings).toContain("iteration:removed:drums");
    expect(proposal.summary).toContain("melodika regenerovaná");
  });

  it("a length patch regenerates the whole idea at the new length", async () => {
    const { generation, doc } = await sessionWith(32);
    const proposal = compileIteration("ten druhý na 1 takt", generation, doc)!;
    expect(proposal.result.proposal!.pattern.stepCount).toBe(16);
    expect(proposal.result.plan.intent.length).toBe(16);
    expect(proposal.result.diagnostics.warnings).toContain("iteration:full-regen:length");
    expect(briefGateViolations(proposal.result.proposal!.pattern, proposal.result.plan)).toEqual([]);
  });

  it("a protected drum part survives a length change with rows resized safely", async () => {
    const { generation, doc } = await sessionWith(32);
    const candidate = generation.candidates[1].pattern;
    const proposal = compileIteration("ten druhý na 1 takt; nechaj bicie", generation, doc)!;
    for (const [padId, row] of Object.entries(candidate.rows)) {
      expect(proposal.result.proposal!.pattern.rows[padId]).toEqual(row.slice(0, 16));
    }
    expect(proposal.result.proposal!.pattern.stepCount).toBe(16);
    expect(proposal.preserve).toContain("drums");
    expect(
      briefGateViolations(proposal.result.proposal!.pattern, proposal.result.plan, {
        preservedRoles: proposal.preserve,
      }),
    ).toEqual([]);
  });

  it("a hard no-drums instruction wins over a contradictory keep-drums clause", async () => {
    const { generation, doc } = await sessionWith();
    const proposal = compileIteration("ten druhý, žiadne bicie; nechaj bicie", generation, doc)!;
    expect(proposal.result.proposal!.pattern.rows).toEqual({});
    expect(proposal.preserve).not.toContain("drums");
    expect(proposal.result.diagnostics.warnings).toContain("iteration:conflict:no-drums-overrides-preserve");
    expect(briefGateViolations(proposal.result.proposal!.pattern, proposal.result.plan)).toEqual([]);
  });

  it("iteration is deterministic (same input → same content)", async () => {
    const { generation, doc } = await sessionWith();
    const text = "ten druhý, ale temnejší; nechaj bass a akordy";
    const a = compileIteration(text, generation, doc)!;
    const b = compileIteration(text, generation, doc)!;
    expect(contentHash(canonicalizePattern(doc, a.result.proposal!.pattern))).toBe(
      contentHash(canonicalizePattern(doc, b.result.proposal!.pattern)),
    );
  });

  it("uses the selected candidate's own seed and source content", async () => {
    const { generation, doc } = await sessionWith();
    const first = compileIteration("ten prvý, ale temnejší; nechaj bass a akordy", generation, doc)!;
    const second = compileIteration("ten druhý, ale temnejší; nechaj bass a akordy", generation, doc)!;
    expect(first.result.plan.intent.seed).not.toBe(second.result.plan.intent.seed);
    expect(first.result.plan.intent.sourcePatternId).toBe(generation.candidates[0].pattern.id);
    expect(second.result.plan.intent.sourcePatternId).toBe(generation.candidates[1].pattern.id);
  });

  it("rejects session references from another project", async () => {
    const { generation } = await sessionWith();
    expect(compileIteration("ten druhý, ale temnejší", generation, testDoc())).toBeNull();
  });

  it("refreshes the composite output hash and generation provenance", async () => {
    const { generation, doc } = await sessionWith();
    const proposal = compileIteration("ten druhý, ale temnejší; nechaj bass a akordy", generation, doc)!;
    const pattern = proposal.result.proposal!.pattern;
    expect(pattern.generation?.outputContentHash).toBe(contentHash(canonicalizePattern(doc, pattern)));
    expect(pattern.generation?.intentHash).toBe(proposal.result.plan.intentHash);
    expect(pattern.generation?.intent).toEqual(proposal.result.plan.intent);
    expect(proposal.result.bank?.[0].contentHash).toBe(contentHash(canonicalizePattern(doc, pattern)));
  });

  it("does not duplicate a persisted candidate's pattern or note identities", async () => {
    const { generation, doc } = await sessionWith();
    const candidate = generation.candidates[1].pattern;
    const projectWithCandidate = { ...doc, patterns: [...doc.patterns, candidate] };
    const proposal = compileIteration(
      "ten druhý, ale temnejší; nechaj bass a akordy",
      generation,
      projectWithCandidate,
    )!;
    const next = applyGenerationResultCommand(projectWithCandidate, proposal.result, "iteration identity test").execute(
      projectWithCandidate,
    );
    expect(new Set(next.patterns.map((pattern) => pattern.id)).size).toBe(next.patterns.length);
    const noteIds = next.patterns.flatMap((pattern) =>
      Object.values(pattern.notes ?? {})
        .flat()
        .map((note) => note.id),
    );
    expect(new Set(noteIds).size).toBe(noteIds.length);
  });
});

describe("accept / reject semantics", () => {
  it("accept = exactly one undoable command; undo restores the previous document", async () => {
    const { generation, doc } = await sessionWith();
    const proposal = compileIteration("ten druhý, ale temnejší; nechaj bass a akordy", generation, doc)!;
    const command = applyGenerationResultCommand(doc, proposal.result, "iteration test");
    const next = command.execute(doc);
    expect(next.patterns.length).toBe(doc.patterns.length + 1);
    const restored = command.undo(next);
    expect(JSON.stringify(restored)).toBe(JSON.stringify(doc));
  });

  it("rejecting the proposal leaves the project untouched (no command built)", async () => {
    const { generation, doc } = await sessionWith();
    const before = JSON.stringify(doc);
    const proposal = compileIteration("ten druhý, ale temnejší; nechaj bass a akordy", generation, doc)!;
    // The proposal only exists — nothing executed, nothing written.
    expect(JSON.stringify(doc)).toBe(before);
    expect(proposal.result.proposal).toBeDefined();
  });

  it("the proposal carries the iteration provenance in diagnostics", async () => {
    const { generation, doc } = await sessionWith();
    const proposal = compileIteration("ten druhý, ale temnejší; nechaj bass a akordy", generation, doc)!;
    const warnings = proposal.result.diagnostics.warnings;
    expect(warnings).toContain("iteration:source:candidate-1");
    expect(warnings).toContain("iteration:targets:drums");
    expect(warnings).toContain("iteration:preserve:bass+chords");
  });
});

describe("session integration", () => {
  it("the panel-facing store resolves the session generation for chaining", async () => {
    const { generation } = await sessionWith();
    rememberGeneration(generation);
    expect(lastGeneration()?.candidates.length).toBe(3);
  });
});
