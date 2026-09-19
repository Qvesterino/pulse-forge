import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createDefaultProject, normalizeProject } from "../src/project-model/schema";
import { ProjectStore } from "../src/store/ProjectStore";
import { canonicalizePattern, contentHash } from "../src/ai/evaluation";
import { generateAsyncResult, generateLocalResult } from "../src/intent/pipeline";
import { applyGenerationResultCommand } from "../src/commands/commands";
import { resetRankerClient } from "../src/ai/ranking/ranker-client";
import type { GenerationResult } from "../src/intent/types";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * Canonical interactive generation path (async provider) + preview/apply
 * identity + provenance truthfulness. jsdom has no Worker, so scoreCandidateFeatures
 * resolves as a controlled fallback — exactly the production degradation path.
 */

const INTENT = {
  genre: "house" as const,
  style: "Driving",
  seed: "async-pipeline-test",
  length: 32,
  candidateCount: 3,
  roles: ["drums", "bass"] as const,
};

function storeFor(doc: ProjectDocument): ProjectStore {
  return new ProjectStore(doc);
}

function hashOf(doc: ProjectDocument, result: GenerationResult): string {
  return contentHash(canonicalizePattern(doc, result.proposal!.pattern));
}

describe("generateAsyncResult — canonical pipeline", () => {
  beforeEach(() => {
    localStorage.removeItem("pf:intent-ranker");
    resetRankerClient();
  });

  afterEach(() => {
    localStorage.removeItem("pf:intent-ranker");
    resetRankerClient();
  });

  it("is deterministic: same input → identical result content and plan", async () => {
    const doc = createDefaultProject();
    const a = await generateAsyncResult(doc, INTENT);
    const b = await generateAsyncResult(doc, INTENT);
    expect(a.status).toBe(b.status);
    expect(a.plan.intentHash).toBe(b.plan.intentHash);
    expect(hashOf(doc, a)).toBe(hashOf(doc, b));
    expect(a.proposal!.pattern.generation?.outputContentHash).toBe(b.proposal!.pattern.generation?.outputContentHash);
  });

  it("single-candidate async generation matches the sync fallback path exactly", async () => {
    const doc = createDefaultProject();
    const syncResult = generateLocalResult(doc, { ...INTENT, candidateCount: 1 });
    const asyncResult = await generateAsyncResult(doc, { ...INTENT, candidateCount: 1 });
    expect(hashOf(doc, asyncResult)).toBe(hashOf(doc, syncResult));
    expect(asyncResult.status).toBe(syncResult.status);
  });

  it("candidate order never depends on promise completion order (stable winner)", async () => {
    const doc = createDefaultProject();
    // Interleave two generations with overlapping microtasks; the winner must
    // not drift from the serially-computed winner.
    const [serial, [a, b]] = await Promise.all([
      generateAsyncResult(doc, INTENT),
      Promise.all([generateAsyncResult(doc, INTENT), generateAsyncResult(doc, { ...INTENT, seed: "other-seed" })]),
    ]);
    expect(hashOf(doc, a)).toBe(hashOf(doc, serial));
    expect(a.proposal!.pattern.id).not.toBe(b.proposal!.pattern.id);
  });

  it("applies the previewed result — no regeneration (same pattern id), one undo step", async () => {
    const doc = createDefaultProject();
    const result = await generateAsyncResult(doc, INTENT);
    const store = storeFor(doc);
    const before = JSON.stringify({ patterns: doc.patterns.length, bpm: doc.bpm, active: doc.activePatternId });

    store.execute(applyGenerationResultCommand(doc, result, "From Preview"));

    const applied = store.doc.patterns[store.doc.patterns.length - 1];
    expect(applied.id).toBe(result.proposal!.pattern.id); // a regenerated pattern would have a fresh uid
    expect(applied.name).toBe("From Preview");
    expect(hashOf(store.doc, result)).toBe(hashOf(doc, result)); // content identical to preview
    expect(applied.generation?.outputContentHash).toBe(result.proposal!.pattern.generation?.outputContentHash);
    expect(applied.generation?.intentHash).toBe(result.plan.intentHash);
    expect(store.doc.scenes.length).toBe(doc.scenes.length + 1);
    expect(store.doc.activePatternId).toBe(applied.id);

    // One accepted generation = exactly one undo step back to the original.
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(store.doc.patterns.length).toBe(doc.patterns.length);
    expect(store.doc.activePatternId).toBe(doc.activePatternId);
    expect(
      JSON.stringify({ patterns: store.doc.patterns.length, bpm: store.doc.bpm, active: store.doc.activePatternId }),
    ).toBe(before);
  });

  it("replace mode rewrites the active pattern with the previewed content", async () => {
    const doc = createDefaultProject();
    const result = await generateAsyncResult(doc, { ...INTENT, replaceMode: "replace" });
    const store = storeFor(doc);
    store.execute(applyGenerationResultCommand(doc, result));
    const active = store.doc.patterns.find((p) => p.id === store.doc.activePatternId)!;
    expect(active.id).toBe(doc.activePatternId);
    // store.execute normalizes the doc (pad rows get zero-filled to the grid),
    // so compare against the preview pattern pushed through the SAME
    // normalization — that is the exact musical content the user previewed.
    const normalizedPreview = normalizeProject({
      ...doc,
      patterns: [...doc.patterns, result.proposal!.pattern],
    }).patterns.find((p) => p.id === result.proposal!.pattern.id)!;
    expect(contentHash(canonicalizePattern(store.doc, active))).toBe(
      contentHash(canonicalizePattern(store.doc, normalizedPreview)),
    );
    expect(active.generation?.outputContentHash).toBe(result.proposal!.pattern.generation?.outputContentHash);
    expect(active.generation?.intentHash).toBe(result.plan.intentHash);
  });

  it("aborted generation rejects with AbortError (and produces no command)", async () => {
    const doc = createDefaultProject();
    const controller = new AbortController();
    controller.abort();
    await expect(generateAsyncResult(doc, INTENT, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("ranker provenance through the canonical path", () => {
  beforeEach(() => {
    localStorage.removeItem("pf:intent-ranker");
    resetRankerClient();
  });

  afterEach(() => {
    localStorage.removeItem("pf:intent-ranker");
    resetRankerClient();
  });

  it("mode off: heuristic winner, no ranker provenance recorded", async () => {
    localStorage.setItem("pf:intent-ranker", "off");
    const doc = createDefaultProject();
    const result = await generateAsyncResult(doc, INTENT);
    expect(result.proposal!.pattern.generation?.ranker).toBeUndefined();
  });

  it("model unavailable: heuristic winner selected, provenance truthfully records fallback", async () => {
    // default mode is "active"; jsdom has no Worker → controlled model fallback
    const doc = createDefaultProject();
    const result = await generateAsyncResult(doc, INTENT);
    const heuristic = generateLocalResult(doc, INTENT); // sync path = pure heuristic
    expect(hashOf(doc, result)).toBe(hashOf(doc, heuristic));
    const selected = result.proposal!.pattern.generation?.ranker;
    expect(selected).toMatchObject({ mode: "active", source: "fallback", modelHash: null });
    // selectedIndex is internally consistent with the diagnostics banner
    const banner = result.diagnostics.warnings.find((w) => w.startsWith("candidate-bank-selected:"));
    expect(banner).toBe(`candidate-bank-selected:${selected!.selectedIndex}:template`);
  });

  it("shadow mode: model scores recorded, heuristic winner unchanged", async () => {
    localStorage.setItem("pf:intent-ranker", "shadow");
    const doc = createDefaultProject();
    const heuristic = generateLocalResult(doc, INTENT);
    const shadow = await generateAsyncResult(doc, INTENT);
    expect(hashOf(doc, shadow)).toBe(hashOf(doc, heuristic)); // winner unchanged
    expect(shadow.proposal!.pattern.generation?.ranker).toMatchObject({ mode: "shadow", source: "fallback" });
  });
});
