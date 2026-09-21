import { describe, it, expect, vi, beforeEach } from "vitest";
import { testDoc } from "./fixtures/doc";
import { generateAsyncResult } from "../src/intent/pipeline";
import { normalizeIntent } from "../src/intent/normalize";
import { applyGenerationResultCommand } from "../src/commands/commands";
import { encodeShareCode, decodeShareCode } from "../src/export/shareCode";
import { intentSnapshotOfDoc, promptFromIntent, freshRegenSeed } from "../src/gallery/intentCarry";

/**
 * ?regen=1 END-TO-END on a REAL engine beat (GOAL 03).
 *
 * The gallery "Regenerate with intent" chain, exercised against actual
 * pipeline output — NOT hand-stamped provenance:
 *   engine generation → apply (USE) → publish (encodeShareCode)
 *   → import (decodeShareCode + normalizeProject) → intentSnapshotOfDoc
 *   → promptFromIntent → fresh-seed regeneration through the same entry
 *   the IntentPanel regen effect calls.
 *
 * The reader/writer seam this guards: the engine stamps provenance at
 * `pattern.generation.intent` (attachProvenance) — a previous regression
 * had every reader looking at a top-level `pattern.intent` nothing wrote,
 * which made REGEN dead on every real generated beat while hand-stamped
 * test fixtures stayed green.
 */

vi.mock("../src/ai/symbolic/prior-client", () => ({
  runPriorGrid: vi.fn(async () => ({ ok: false, probs: [], source: "fallback" as const })),
  runMelodicNext: vi.fn(async () => ({ ok: false, degree: null, duration: null, source: "fallback" as const })),
  priorMode: vi.fn(() => "on" as const),
  resetPriorClient: vi.fn(),
  currentPriorManifest: vi.fn(() => null),
}));

beforeEach(() => {
  localStorage.setItem("pf:intent-ranker", "off");
});

describe("?regen=1 chain on a real engine beat", () => {
  it("survives publish → import → snapshot → fresh-seed regeneration", async () => {
    // 1. REAL generation through the canonical entry, applied via USE.
    const doc0 = testDoc();
    const intent = normalizeIntent({
      genre: "trap",
      seed: "regen-e2e",
      energy: 0.9,
      candidateCount: 1,
      symbolicCandidates: 0,
    });
    const result = await generateAsyncResult(doc0, intent, { mode: "apply" });
    expect(result.proposal).toBeDefined();
    const applied = applyGenerationResultCommand(doc0, result).execute(doc0);

    // 2. The engine stamped provenance at the WRITER location.
    const stamped = applied.patterns.find((p) => p.generation?.intent);
    expect(stamped).toBeDefined();
    expect((stamped!.generation!.intent as Record<string, unknown>).genre).toBe("trap");
    expect(stamped!.generation!.intentHash).toBeTruthy();

    // 3. Publish → import round trip (the gallery/boot path).
    const imported = decodeShareCode(encodeShareCode(applied));
    expect(imported).not.toBeNull();

    // 4. The reader the gallery REGEN link and Boot regen flag rely on.
    const snapshot = intentSnapshotOfDoc(imported!);
    expect(snapshot).not.toBeNull();
    expect((snapshot as Record<string, unknown>).genre).toBe("trap");

    // 5. The IntentPanel field prefill is a usable prompt.
    const prompt = promptFromIntent(snapshot!);
    expect(prompt).toContain("trap");
    expect(prompt.length).toBeGreaterThan("trap".length);

    // 6. Fresh-seed regeneration through the same panel entry — same
    //    character by intent, different take by seed.
    const regenSeed = freshRegenSeed();
    expect(regenSeed).not.toBe((snapshot as Record<string, unknown>).seed);
    const regenIntent = normalizeIntent({
      ...(snapshot as Record<string, unknown>),
      seed: regenSeed,
    });
    const regen = await generateAsyncResult(imported!, regenIntent, { mode: "apply" });
    expect(regen.proposal).toBeDefined();
    const regenApplied = applyGenerationResultCommand(imported!, regen).execute(imported!);
    // The imported doc still carries the ORIGINAL trap pattern — pick the
    // freshly generated one by its provenance seed.
    const regenPattern = regenApplied.patterns.find(
      (p) => (p.generation?.intent as Record<string, unknown> | undefined)?.seed === regenSeed,
    );
    expect(regenPattern).toBeDefined();

    // The provenance seeds differ (fresh take)…
    expect((regenPattern!.generation!.intent as Record<string, unknown>).seed).toBe(regenSeed);
    // …and the content actually differs from the original take.
    expect(regenPattern!.generation!.outputContentHash).not.toBe(stamped!.generation!.outputContentHash);
  });

  it("legacy-shaped provenance (top-level pattern.intent) still triggers REGEN", () => {
    // Beats published BEFORE the reader fix — a hand-stamped top-level
    // snapshot on an otherwise real-shaped doc — must stay regenerable.
    const doc = testDoc();
    const stamped = { ...doc.patterns[0]!, intent: { genre: "house", energy: 0.5 } } as typeof doc.patterns[number];
    const snapshot = intentSnapshotOfDoc({ ...doc, patterns: [stamped, ...doc.patterns.slice(1)] });
    expect(snapshot).not.toBeNull();
    expect((snapshot as Record<string, unknown>).genre).toBe("house");
  });
});
