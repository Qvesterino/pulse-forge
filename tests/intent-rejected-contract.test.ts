import { describe, expect, it } from "vitest";
import { generateAsyncResult, generateLocalResult } from "../src/intent/pipeline";
import { applyGenerationResultCommand } from "../src/commands/aiPattern";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeIntent } from "../src/intent/normalize";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * D3 contract (docs/INTENT-AUDIT-2026-10.md): a run where EVERY candidate —
 * including the deterministic fallback — fails the gates must expose NO
 * proposal. The old contract attached the FAILED fallback pattern, which the
 * panel (`!result.proposal` guard) and applyGenerationResultCommand happily
 * installed over the user's active pattern.
 *
 * Trigger: a lead-only intent on a document without any instrument track —
 * nothing can legally generate, and that stays true regardless of how well
 * lead-only generation works (the D2 fix).
 */
function drumOnlyDoc(): ProjectDocument {
  const doc = createProjectFromTemplate("house");
  return { ...doc, tracks: doc.tracks.filter((track) => track.kind === "drum") };
}

const input = normalizeIntent({ genre: "house", seed: "d3-reject", candidateCount: 2, roles: ["lead"] });

describe("rejected generation exposes no applyable proposal (D3)", () => {
  it("sync path: rejected + proposal undefined + truthful diagnostics", () => {
    const result = generateLocalResult(drumOnlyDoc(), input, "apply");
    expect(result.status).toBe("rejected");
    expect(result.proposal).toBeUndefined();
    expect(result.diagnostics.errors.length).toBeGreaterThan(0);
  });

  it("async bank path: rejected + proposal undefined + empty bank", async () => {
    const result = await generateAsyncResult(drumOnlyDoc(), input, { mode: "apply", includeBank: true });
    expect(result.status).toBe("rejected");
    expect(result.proposal).toBeUndefined();
    expect(result.bank ?? []).toEqual([]);
  });

  it("applyGenerationResultCommand refuses a rejected result", async () => {
    const doc = drumOnlyDoc();
    const result = await generateAsyncResult(doc, input, { mode: "apply", includeBank: true });
    expect(() => applyGenerationResultCommand(doc, result)).toThrow();
  });
});
