import { describe, expect, it } from "vitest";
import { attachMusicalContextRenderEvidence } from "../src/mcp/musical-context-evidence";
import type { MusicalContextSnapshotV1 } from "../src/analysis/musical-context";
import type { RenderSummaryData } from "../src/mcp/render-summary";

function fixtures() {
  const snapshot = {
    project: { id: "song", revision: 4 },
    scope: { startTick: 0, endTick: 1920 },
    evidence: [],
    limitations: [],
    analysis: { requestedScope: "all" },
  } as unknown as MusicalContextSnapshotV1;
  const summary = {
    scope: "range",
    master: null,
    strips: [],
    range: {
      window: { startTick: 0, endTick: 1920 },
      projectRevision: 4,
      revisionAfterRender: 4,
      freshness: "current",
    },
    mixVerification: {
      projectId: "song",
      status: "measured",
      freshness: "current",
      appliedRevision: 4,
      revisionAfterRender: 4,
      window: { startTick: 0, endTick: 1920 },
      actualAfterLufs: -15,
    },
  } as unknown as RenderSummaryData;
  return { snapshot, summary };
}

describe("post-apply evidence in musical context", () => {
  it("cites matching measurements with an explicit subjective-quality limitation", () => {
    const { snapshot, summary } = fixtures();
    const result = attachMusicalContextRenderEvidence(snapshot, summary, "song", 4);
    const evidence = result.evidence.find((item) => item.id === "analysis.mix-verification");
    expect(evidence?.provenance.path).toBe("mixVerification");
    expect(evidence?.uncertainty).toContain("LUFS measures loudness only");
    expect(evidence?.value).toEqual(summary.mixVerification);
    expect(evidence?.value).not.toBe(summary.mixVerification);
  });

  it.each(["project", "range", "revision", "stale", "unavailable", "full-project"])(
    "excludes a receipt with incompatible %s",
    (mismatch) => {
      const { snapshot, summary } = fixtures();
      const receipt = summary.mixVerification!;
      if (mismatch === "project") receipt.projectId = "other";
      if (mismatch === "range") receipt.window!.endTick = 3840;
      if (mismatch === "revision") receipt.appliedRevision = 3;
      if (mismatch === "stale") receipt.freshness = "stale";
      if (mismatch === "unavailable") receipt.status = "unavailable";
      if (mismatch === "full-project") receipt.window = null;
      const result = attachMusicalContextRenderEvidence(snapshot, summary, "song", 4);
      expect(result.evidence.some((item) => item.id === "analysis.mix-verification")).toBe(false);
    },
  );
});
