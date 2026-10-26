import { describe, expect, it, vi } from "vitest";
import { EMPTY_PREFERENCES } from "../../../src/ai/bridge/types";
import { executeCommandBatch } from "../../../src/ai/bridge/executor";
import { generateBatch } from "../../../src/ai/bridge/mockProvider";
import { testDoc } from "../../fixtures/doc";

/**
 * The ALL-OR-NOTHING contract, proven with a provider stub: a batch whose
 * SECOND command fails validation must leave the caller's document
 * untouched even though its FIRST command validated and applied cleanly.
 *
 * executeCommandBatch generates the batch through the mock provider, so the
 * stub replaces generateBatch for THIS file only (vi.mock is hoisted above
 * the imports); the real provider suites (mock-provider.test.ts) keep the
 * prompt contract covered.
 */
vi.mock("../../../src/ai/bridge/mockProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/ai/bridge/mockProvider")>();
  return { ...actual, generateBatch: vi.fn() };
});

describe("all-or-nothing (stubbed provider)", () => {
  it("a mid-batch validation failure discards the earlier command's mutation", () => {
    const doc = testDoc();
    const track = doc.tracks.find((t) => t.kind === "instrument")!;
    const baselineGain = doc.tracks.find((t) => t.id === track.id)!.gain;
    vi.mocked(generateBatch).mockReturnValue({
      ok: true,
      batch: {
        recipeId: "synthetic",
        label: "synthetic batch",
        rationale: "test",
        estimatedImpact: { peakDeltaDb: 0, rmsDeltaDb: 0, riskLevel: "low" },
        commands: [
          {
            kind: "set-volume",
            label: "volume",
            rationale: "valid first command",
            target: { namePattern: track.name },
            volumeDb: -3,
          },
          {
            kind: "set-track-pan",
            label: "pan",
            rationale: "invalid second command (no such track)",
            target: { namePattern: "bagpipes" },
            pan: 0.5,
          },
        ],
      },
    });

    const result = executeCommandBatch("synthetic", { doc, userPreferences: EMPTY_PREFERENCES });

    if (result.ok) throw new Error("expected the batch to fail");
    expect(result.error.code).toBe("no-track-match");
    expect(result.error.message).toMatch(/Command 2\/2/);
    // THE guarantee, twice over: the failure carries NO document (a
    // half-applied one cannot even be taken by accident — `cur` was a local
    // working copy) and the caller's document object was never mutated.
    expect("doc" in result).toBe(false);
    expect("command" in result).toBe(false);
    expect(doc.tracks.find((t) => t.id === track.id)!.gain).toBe(baselineGain);
  });
});
