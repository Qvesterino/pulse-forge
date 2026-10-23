import { describe, expect, it } from "vitest";
import {
  detectCorrections,
  boundCorrections,
  type AssistProposedParam,
  type MasteringCorrectionEvent,
} from "../src/mcp/master-assistant-corrections";

/**
 * LEARNING LOOP CAPTURE pins — the correction detector compares the assist
 * proposal against the ACTUAL doc state. A delta means the user corrected
 * the AI's suggestion. Privacy: only param ids and numbers, no prompts.
 */

function track(id: string, effects: Array<{ id: string; type: string; params: Record<string, number> }>) {
  return { id, name: id, effects };
}

function proposal(trackId: string, device: string, paramId: string, proposedValue: number): AssistProposedParam {
  return { trackId, device, paramId, proposedValue };
}

describe("detectCorrections", () => {
  it("detects a correction when actual ≠ proposed", () => {
    const doc = { tracks: [track("t1", [{ id: "z1", type: "zenit", params: { limit: 0.6 } }])] };
    const corrections = detectCorrections([proposal("t1", "zenit", "limit", 0.4)], doc as never);
    expect(corrections).toHaveLength(1);
    expect(corrections[0]!.delta).toBeCloseTo(0.2, 6);
    expect(corrections[0]!.proposedValue).toBe(0.4);
    expect(corrections[0]!.actualValue).toBe(0.6);
  });

  it("no correction when actual matches proposed (the user accepted the AI's suggestion)", () => {
    const doc = { tracks: [track("t1", [{ id: "z1", type: "zenit", params: { limit: 0.4 } }])] };
    const corrections = detectCorrections([proposal("t1", "zenit", "limit", 0.4)], doc as never);
    expect(corrections).toHaveLength(0);
  });

  it("skips missing tracks and devices silently (no crash on partial state)", () => {
    const doc = { tracks: [track("t1", [])] };
    const corrections = detectCorrections(
      [proposal("t1", "apeks", "drive", 0.5), proposal("t-missing", "zenit", "limit", 0.4)],
      doc as never,
    );
    expect(corrections).toHaveLength(0);
  });

  it("outputTrimDb is detected via the instance's own field", () => {
    const doc = {
      tracks: [track("t1", [{ id: "z1", type: "zenit", params: {}, outputTrimDb: -2.5 }])],
    };
    const corrections = detectCorrections([proposal("t1", "zenit", "outputTrimDb", -1)], doc as never);
    expect(corrections).toHaveLength(1);
    expect(corrections[0]!.actualValue).toBe(-2.5);
    expect(corrections[0]!.delta).toBeCloseTo(-1.5, 6);
  });
});

describe("boundCorrections", () => {
  it("caps at the limit, keeping the newest entries", () => {
    const events: MasteringCorrectionEvent[] = Array.from({ length: 300 }, (_, i) => ({
      trackId: `t${i}`,
      device: "zenit",
      paramId: "limit",
      proposedValue: i,
      actualValue: i + 1,
      delta: 1,
      detectedAt: i,
    }));
    const bounded = boundCorrections(events, 256);
    expect(bounded).toHaveLength(256);
    expect(bounded[0]!.trackId).toBe("t44"); // oldest kept = index 300-256
  });

  it("does not trim when under the cap", () => {
    const events: MasteringCorrectionEvent[] = Array.from({ length: 10 }, (_, i) => ({
      trackId: `t${i}`,
      device: "zenit",
      paramId: "limit",
      proposedValue: i,
      actualValue: i,
      delta: 0,
      detectedAt: i,
    }));
    expect(boundCorrections(events, 256)).toHaveLength(10);
  });
});
