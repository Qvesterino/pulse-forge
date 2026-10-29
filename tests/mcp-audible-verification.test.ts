import { describe, expect, it, vi } from "vitest";
import { createHeadlessMcpHost } from "../src/mcp/headless-host";
import { MCP_TOOLS, executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import { createDefaultProject } from "../src/project-model/schema";
import type { AudibleVerificationRequest, AudibleVerificationResult } from "../src/mcp/audible-verification";

function metrics(rmsDb: number, lufs: number | null) {
  return {
    lufs,
    peakDb: rmsDb + 3,
    rmsDb,
    crestDb: 3,
    durationSec: 4,
    sampleRate: 44100,
    bands: { lowDb: -30, midDb: -20, highDb: -35 },
    contentHash: "abc123",
  };
}

function fakeResult(request: AudibleVerificationRequest): AudibleVerificationResult {
  const scope = {
    kind: "track" as const,
    trackId: "track-1",
    trackName: "Lead",
    startBar: 1,
    bars: 2,
    startTick: 0,
    endTick: 3840,
  };
  const before = metrics(-18, -18);
  if (request.op === "capture") {
    return {
      op: "capture",
      token: "aud-test-token",
      scope,
      revisionBefore: 4,
      revisionAfter: 4,
      before,
      after: null,
      comparison: null,
    };
  }
  return {
    op: "compare",
    token: "aud-test-token",
    scope,
    revisionBefore: 4,
    revisionAfter: 5,
    before,
    after: metrics(-24, -24),
    comparison: {
      verified: true,
      audibleChanged: true,
      verdict: "changed",
      deltas: { lufs: -6, rmsDb: -6, peakDb: -6, nullResidualDb: -2.5, durationSec: 0 },
      bands: {
        before: { lowDb: -30, midDb: -20, highDb: -35 },
        after: { lowDb: -32, midDb: -23, highDb: -38 },
        delta: { lowDb: -2, midDb: -3, highDb: -3 },
        dominant: { band: "mid", centerHz: 632, deltaDb: -3 },
      },
      caveats: [],
    },
  };
}

function ctxWithVerify(): { ctx: McpToolContext; verifyEdit: ReturnType<typeof vi.fn> } {
  const host = createHeadlessMcpHost({ document: createDefaultProject() });
  const verifyEdit = vi.fn(async (request: AudibleVerificationRequest) => fakeResult(request));
  return { ctx: { ...host.ctx, verifyEdit }, verifyEdit };
}

describe("kyx_verify_edit — MCP contract", () => {
  it("captures a bounded baseline and returns a token", async () => {
    const { ctx, verifyEdit } = ctxWithVerify();
    const result = await executeMcpTool(ctx, "kyx_verify_edit", {
      op: "capture",
      trackId: "track-1",
      startBar: 1,
      bars: 3,
    });
    expect(result.isError, result.text).not.toBe(true);
    expect(result.stage).toBe("rendered");
    expect(result.mutated).toBe(false);
    expect(result.risk).toBe("runtime");
    expect(result.data).toMatchObject({ token: "aud-test-token", op: "capture" });
    expect(result.text).toContain("captured audible baseline");
    const call = verifyEdit.mock.calls[0]!;
    expect(call[0]).toMatchObject({ op: "capture", trackId: "track-1", startBar: 1, bars: 3 });
    expect(call[1] == null || call[1] instanceof AbortSignal).toBe(true);
  });

  it("compares with the token and flattens the verdict into the receipt", async () => {
    const { ctx } = ctxWithVerify();
    const result = await executeMcpTool(ctx, "kyx_verify_edit", {
      op: "compare",
      token: "aud-test-token",
    });
    expect(result.isError, result.text).not.toBe(true);
    expect(result.stage).toBe("rendered");
    expect(result.data).toMatchObject({ verified: true, audibleChanged: true, verdict: "changed" });
    expect(result.text).toContain("audible check: CHANGED");
    expect(result.text).toContain("632 Hz");
  });

  it("refuses compare without a token before touching the renderer", async () => {
    const { ctx, verifyEdit } = ctxWithVerify();
    const result = await executeMcpTool(ctx, "kyx_verify_edit", { op: "compare" });
    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("INVALID_ARGUMENTS");
    expect(verifyEdit).not.toHaveBeenCalled();
  });

  it("refuses capture without a valid bar/window", async () => {
    const { ctx, verifyEdit } = ctxWithVerify();
    const result = await executeMcpTool(ctx, "kyx_verify_edit", { op: "capture", startBar: 0 });
    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("INVALID_ARGUMENTS");
    expect(verifyEdit).not.toHaveBeenCalled();
  });

  it("is advertised with a declared output schema and refuses honestly without a render host", async () => {
    const tool = MCP_TOOLS.find((candidate) => candidate.name === "kyx_verify_edit");
    expect(tool?.outputSchema).toBeDefined();
    const host = createHeadlessMcpHost({ document: createDefaultProject() });
    const result = await executeMcpTool(host.ctx, "kyx_verify_edit", {
      op: "capture",
      startBar: 1,
    });
    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("UNAVAILABLE_ON_TRANSPORT");
  });
});
