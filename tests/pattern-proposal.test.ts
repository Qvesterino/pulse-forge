import { describe, expect, it } from "vitest";
import { applyGenerationResultCommand, applyGenerationResultWithFxCommand } from "../src/commands/aiPattern";
import { generateLocalResult } from "../src/intent/pipeline";
import {
  buildPatternMusicalProposal,
  checkPatternProposalWrite,
  validatePatternMusicalProposal,
} from "../src/intent/pattern-proposal";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";

function fixture() {
  const doc = createProjectFromTemplate("house");
  const source = doc.patterns.find((pattern) => pattern.id === doc.activePatternId)!;
  const drum = doc.tracks.find((track) => track.kind === "drum")!;
  if (drum.kind !== "drum") throw new Error("no drums");
  const result = generateLocalResult(
    doc,
    {
      genre: "house",
      seed: "pattern-contract",
      length: source.stepCount,
      roles: ["bass"],
      preserve: ["drums"],
      candidateCount: 1,
    },
    "preview",
  );
  if (!result.proposal) throw new Error("no candidate");
  return { doc, source, drum, result };
}

describe("protected pattern proposals", () => {
  it("binds evidence and candidate to the project revision and applies with undo", () => {
    const { doc, source, drum, result } = fixture();
    const store = new ProjectStore(doc);
    const proposal = buildPatternMusicalProposal(doc, result, store.getRevision());
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) throw new Error(proposal.reason);
    expect(proposal.value.checks.acoustic).toBe("not_measured");
    expect(validatePatternMusicalProposal(proposal.value, doc, store.getRevision(), result).ok).toBe(true);
    store.execute(applyGenerationResultCommand(doc, result));
    expect(store.getDoc().bpm).toBe(doc.bpm);
    const applied = store.getDoc().patterns.find((pattern) => pattern.id === store.getDoc().activePatternId)!;
    for (const pad of drum.pads) expect(applied.rows[pad.id]).toEqual(source.rows[pad.id]);
    expect(validatePatternMusicalProposal(proposal.value, store.getDoc(), store.getRevision(), result).ok).toBe(false);
    store.undo();
    expect(store.getDoc()).toEqual(doc);
    store.redo();
    expect(store.getDoc().activePatternId).toBe(applied.id);
  });

  it("rejects changed or incomplete contract fields and candidate content", () => {
    const { doc, drum, result } = fixture();
    const proposal = buildPatternMusicalProposal(doc, result, 2);
    if (!proposal.ok) throw new Error(proposal.reason);
    const tampered = structuredClone(proposal.value);
    tampered.evidence = [];
    expect(validatePatternMusicalProposal(tampered, doc, 2, result)).toMatchObject({ ok: false });
    const alteredScope = structuredClone(proposal.value);
    alteredScope.constraints.rules.protect = [];
    expect(validatePatternMusicalProposal(alteredScope, doc, 2, result)).toMatchObject({ ok: false });
    const alteredCandidate = structuredClone(proposal.value);
    alteredCandidate.candidates[0].pattern.name = "changed";
    expect(validatePatternMusicalProposal(alteredCandidate, doc, 2, result)).toMatchObject({ ok: false });
    const alteredPlan = structuredClone(result);
    alteredPlan.plan.options.seed = "different-plan";
    expect(validatePatternMusicalProposal(proposal.value, doc, 2, alteredPlan)).toMatchObject({ ok: false });
    expect(validatePatternMusicalProposal(proposal.value, { ...doc, id: "different" }, 2, result)).toMatchObject({
      ok: false,
    });
    expect(validatePatternMusicalProposal(proposal.value, doc, 3, result)).toMatchObject({ ok: false });
    const changed = structuredClone(result);
    const pad = drum.pads.find((item) => changed.proposal!.pattern.rows[item.id])!;
    changed.proposal!.pattern.rows[pad.id][0] ^= 1;
    expect(validatePatternMusicalProposal(proposal.value, doc, 2, changed)).toMatchObject({ ok: false });
    expect(() => applyGenerationResultCommand(doc, changed)).toThrow(
      /Invalid candidate|Protected drum pattern changed/,
    );
  });

  it("refuses track modifications and stale preserved source content", () => {
    const { doc, source, drum, result } = fixture();
    const changedTrack = structuredClone(doc);
    changedTrack.tracks.find((track) => track.id === drum.id)!.gain = 0.123;
    expect(checkPatternProposalWrite(doc, changedTrack, result)).toMatchObject({ ok: false });
    expect(checkPatternProposalWrite(doc, { ...doc, bpm: doc.bpm + 1 }, result)).toMatchObject({ ok: false });
    const stale = structuredClone(doc);
    const command = applyGenerationResultCommand(doc, result);
    stale.bpm += 1;
    expect(() => command.execute(stale)).toThrow(/project changed/);
    const pad = drum.pads.find((item) => source.rows[item.id])!;
    stale.patterns.find((pattern) => pattern.id === source.id)!.rows[pad.id][0] ^= 1;
    expect(() => applyGenerationResultCommand(stale, result)).toThrow(/Protected drum pattern changed/);
  });

  it("rejects production FX that would alter the protected drum track", () => {
    const { doc, result } = fixture();
    result.plan.intent.fx = { targets: ["drums"], goals: [{ concept: "lofi", amount: 0.9 }], sourceText: "lofi drums" };
    expect(() => applyGenerationResultWithFxCommand(doc, result)).toThrow(/Protected track changed/);
  });

  it("refuses ambiguous drum sources instead of preserving only the first one", () => {
    const { doc, drum, result } = fixture();
    const ambiguous = structuredClone(doc);
    ambiguous.tracks.push({ ...structuredClone(drum), id: "second-drums", name: "Second drums" });
    expect(buildPatternMusicalProposal(ambiguous, result, 0)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Choose one drum track"),
    });
  });
});
