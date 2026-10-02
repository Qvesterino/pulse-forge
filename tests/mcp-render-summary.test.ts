import { describe, it, expect } from "vitest";
import { executeMcpToolAsync, executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import {
  analyzeBufferMetrics,
  buildRelativeLines,
  formatRenderSummary,
  type RenderSummaryData,
} from "../src/mcp/render-summary";

/**
 * kyx_render_summary — the agent's EARS. Pins the pure evidence layer
 * (peak/RMS/crest over a fake buffer, relative deltas, the streaming-
 * reference verdict), the transport contract (honest refusal without the
 * render hook, async intercept, sync-path notice) and the data passthrough.
 */

/** A minimal fake AudioBuffer: one channel from `samples`. */
function fakeBuffer(samples: number[], sampleRate = 48000) {
  const data = new Float32Array(samples);
  return {
    length: data.length,
    sampleRate,
    numberOfChannels: 1,
    getChannelData: (channel: number) => (channel === 0 ? data : new Float32Array(data.length)),
  };
}

function makeCtx(hook?: NonNullable<McpToolContext["renderSummary"]>): McpToolContext {
  return {
    getDoc: () => ({}) as never,
    execute: () => undefined,
    undo: () => undefined,
    redo: () => undefined,
    undoStackLength: () => 0,
    historyLabels: () => [],
    isMicRecordingActive: () => false,
    transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
    ...(hook ? { renderSummary: hook } : {}),
  };
}

const SUMMARY: RenderSummaryData = {
  scope: "all",
  referenceLufs: -14,
  strips: [
    { id: "t1", name: "Drums", kind: "drum", lufs: -8.3, peakDb: -2.1, crestDb: 9.4, durationSec: 9.6 },
    { id: "t2", name: "808", kind: "instrument", lufs: -11.2, peakDb: -3.4, crestDb: 7.1, durationSec: 9.6 },
  ],
  master: { lufs: -13.9, peakDb: -1.2, crestDb: 8.8, durationSec: 9.8 },
};

describe("render summary evidence layer", () => {
  it("analyzeBufferMetrics: peak and crest from known samples; silence is unmeasurable LUFS", () => {
    const loud = analyzeBufferMetrics(fakeBuffer([0, 0.5, -0.5, 0.25, 0, -0.25, 0.1]));
    expect(loud.peakDb).toBeCloseTo(-6.02, 1); // 0.5 peak
    expect(loud.crestDb).toBeGreaterThan(0);
    expect(loud.durationSec).toBe(0); // round1: a 7-sample buffer is 0.0 s

    const silence = analyzeBufferMetrics(fakeBuffer(new Array(96000).fill(0)));
    expect(silence.lufs).toBeNull(); // BS.1770 gate: silence is never "−inf LUFS"
    expect(silence.peakDb).toBe(-80);
  });

  it("buildRelativeLines: every other strip gets its delta vs the loudest", () => {
    const lines = buildRelativeLines(SUMMARY);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("808 is -2.9 LU vs loudest (Drums)");
  });

  it("formatRenderSummary: strips, deltas and the streaming-target verdict", () => {
    const text = formatRenderSummary(SUMMARY);
    expect(text).toContain("Drums — -8.3 LUFS");
    expect(text).toContain("808 is -2.9 LU vs loudest (Drums)");
    expect(text).toContain("on the -14 streaming target (within 1 LU)"); // -13.9 within 1 LU
    const loud = { ...SUMMARY, master: { ...SUMMARY.master!, lufs: -8 } };
    expect(formatRenderSummary(loud)).toContain("6.0 LU louder than the -14 streaming target");
  });
});

describe("kyx_render_summary transport contract", () => {
  it("refuses honestly without the render hook", async () => {
    const r = await executeMcpToolAsync(makeCtx(), "kyx_render_summary", {});
    expect(r.text).toContain("not available over this MCP transport");
    expect(r.mutated).toBe(false);
  });

  it("calls the hook with the scope and returns the evidence as data + text", async () => {
    const seen: Array<{ scope?: string }> = [];
    const ctx = makeCtx(async (request) => {
      seen.push(request);
      return SUMMARY;
    });
    const r = await executeMcpToolAsync(ctx, "kyx_render_summary", { scope: "tracks" });
    expect(seen[0]).toEqual({ scope: "tracks" });
    expect(r.text).toContain("Drums");
    expect((r.data as { referenceLufs: number }).referenceLufs).toBe(-14);
    expect(r.mutated).toBe(false);
  });

  it("hook failures surface as tool errors", async () => {
    const ctx = makeCtx(async () => {
      throw new Error("audio engine not ready");
    });
    const r = await executeMcpToolAsync(ctx, "kyx_render_summary", {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain("audio engine not ready");
  });

  it("sync path answers with the async-intercept notice", () => {
    const r = executeMcpTool(makeCtx(), "kyx_render_summary", {});
    expect(r.text).toContain("async executor");
    expect(r.mutated).toBe(false);
  });
});
