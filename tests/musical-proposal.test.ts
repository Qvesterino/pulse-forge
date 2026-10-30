import { describe, expect, it, vi } from "vitest";
import { mixPreviewProposal, type MixPreviewLane } from "../src/mcp/mix-preview";
import { executeMcpToolAsync } from "../src/mcp/tools";
import { withAgentWriter } from "./helpers/mcpAgentWriter";

function lane(): MixPreviewLane {
  return {
    id: "preview-1",
    beforeDoc: { id: "project-1" },
    revisionAfterRender: 7,
    freshness: "current",
    label: "Tighten bass",
    goals: ["tight"],
    interpreter: "production",
    steps: [
      {
        trackId: "bass",
        device: "Compressor",
        changes: [{ param: "release", before: 0.3, after: 0.1 }],
        params: "shorter release",
        reason: "tight",
      },
    ],
    stats: { beforeLufs: -14, afterLufs: -15, matchGainDb: 1, seconds: 2 },
    window: {
      startTick: 0,
      endTick: 1920,
      startSec: 0,
      endSec: 2,
      durationSec: 2,
      startSample: 0,
      endSample: 88200,
      sampleRate: 44100,
    },
    warnings: [],
  } as unknown as MixPreviewLane;
}

describe("musical proposal from mix preview", () => {
  it("separates audition range, unconstrained writes, measurements and subjective judgment", () => {
    const source = lane();
    const proposal = mixPreviewProposal(source);
    expect(proposal.base).toEqual({ projectId: "project-1", revision: 7, freshness: "current" });
    expect(proposal.scope).toEqual({
      audition: { startTick: 0, endTick: 1920 },
      writeScope: "unrestricted",
      targetTrackIds: ["bass"],
    });
    expect(proposal.constraints.status).toBe("not_declared");
    expect(proposal.candidates[0].changes[0].parameterChanges[0]).toEqual({
      param: "release",
      before: 0.3,
      after: 0.1,
    });
    expect(proposal.evidence.map((item) => item.value)).toEqual([-14, -15]);
    expect(proposal.checks).toEqual({
      structural: "not_checked",
      acoustic: "preview_measured",
      subjective: "not_judged",
    });
    proposal.candidates[0].changes[0].parameterChanges[0].after = 0.9;
    expect(source.steps[0].changes[0].after).toBe(0.1);
  });

  it("reports unavailable measurement and unknown freshness without inventing evidence", () => {
    const source = lane();
    source.stats.afterLufs = null;
    source.revisionAfterRender = null;
    source.freshness = undefined;
    source.window = null;
    const proposal = mixPreviewProposal(source);
    expect(proposal.base.freshness).toBe("unknown");
    expect(proposal.scope.audition).toBeNull();
    expect(proposal.evidence[1].value).toBeNull();
    expect(proposal.checks.acoustic).toBe("unavailable");
  });

  it("exposes the proposal through the existing mix preview tool without applying it", async () => {
    const source = lane();
    let writes = 0;
    const ctx = withAgentWriter({
      getDoc: () => source.beforeDoc,
      execute: () => {
        writes += 1;
      },
      undo: () => undefined,
      redo: () => undefined,
      undoStackLength: () => 0,
      historyLabels: () => [],
      isMicRecordingActive: () => false,
      transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
      mixPreview: async () => ({ ok: true as const, lane: source, studioBound: true }),
    });
    const result = await executeMcpToolAsync(ctx, "kyx_mix_idea", { idea: "tighten bass", preview: true });
    expect(result.mutated).toBe(false);
    expect(writes).toBe(0);
    expect(result.data).toMatchObject({
      proposal: { schema: "kyx.musical-proposal", version: 1, constraints: { status: "not_declared" } },
    });
  });

  it("passes declared constraints to the preview and rejects them on direct apply", async () => {
    const source = lane();
    source.constraints = { protect: [["tracks", { id: "kick" }]] };
    const preview = vi.fn(async () => ({ ok: true as const, lane: source, studioBound: true }));
    const ctx = withAgentWriter({
      getDoc: () => source.beforeDoc,
      execute: () => undefined,
      undo: () => undefined,
      redo: () => undefined,
      undoStackLength: () => 0,
      historyLabels: () => [],
      isMicRecordingActive: () => false,
      transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
      mixPreview: preview,
    });
    const rules = { protect: [["tracks", { id: "kick" }]] };
    const result = await executeMcpToolAsync(ctx, "kyx_mix_idea", {
      idea: "tighten bass",
      preview: true,
      constraints: rules,
    });
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ constraints: rules }), expect.anything());
    expect(result.data).toMatchObject({ proposal: { constraints: { status: "declared", rules } } });
    const refusal = await executeMcpToolAsync(ctx, "kyx_mix_idea", {
      idea: "tighten bass",
      apply: true,
      constraints: rules,
    });
    expect(refusal.isError).toBe(true);
    expect(refusal.text).toContain("constraints require preview");
  });
});
