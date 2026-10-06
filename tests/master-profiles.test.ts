import { describe, expect, it } from "vitest";
import { MASTER_PROFILES, profileFor, verdictAgainst, worstStatus } from "../src/mcp/master-profiles";
import { ProjectStore } from "../src/store/ProjectStore";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import type { ProjectDocument } from "../src/project-model/types";
import { evaluateMasterVerdict } from "../src/audio-engine/metering";
import { CUSTOM_PROFILE, evaluateDelivery } from "../src/mastering/profiles";

/** Minimal local fixtures (the ones in mcp-tools.test.ts are file-local). */
function datasetDoc(): ProjectDocument {
  return createProjectFromTemplate("house") as ProjectDocument;
}

function storeCtx(store: ProjectStore): McpToolContext {
  return {
    getDoc: () => store.doc,
    execute: (command) => store.execute(command),
    undo: () => store.undo(),
    redo: () => store.redo(),
    undoStackLength: () => store.undoStackLength,
    historyLabels: () => store.history.map((entry) => entry.label),
    isMicRecordingActive: () => false,
    transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
  } as McpToolContext;
}

/**
 * MASTERING PROFILES + CLOSED-LOOP LANDING (mastering wave, ADR 0020
 * lineage). Profiles are the delivery contract per platform; op:land closes
 * the loop measure → master loudness trim → RE-MEASURE (the meters are
 * coupled to the store's loudness trim, simulating the engine applying it)
 * until |delta| ≤ 0.3 LU, bounded at 3 steps.
 */

describe("mastering platform profiles", () => {
  it("four contracts with sane targets and ceilings", () => {
    expect(MASTER_PROFILES.map((p) => p.id)).toEqual(["streaming", "apple", "loud", "vinyl"]);
    expect(profileFor("apple")!.targetLufs).toBe(-16);
    expect(profileFor("vinyl")!.maxTruePeakDb).toBe(-2);
    expect(profileFor("nope")).toBeNull();
  });

  it("verdict: within ±1 LU passes, hot true peak fails, vinyl carries the mono note", () => {
    const streaming = profileFor("streaming")!;
    const good = verdictAgainst({ lufs: -14.4, truePeakDb: -1.6 }, streaming);
    expect(good[0]!.status).toBe("pass");
    expect(good[1]!.status).toBe("pass");
    const hot = verdictAgainst({ lufs: -10, truePeakDb: -0.2 }, streaming);
    expect(hot[0]!.status).toBe("fail");
    expect(hot[1]!.status).toBe("fail");
    const vinyl = verdictAgainst({ lufs: -12.2, truePeakDb: -2.4 }, profileFor("vinyl")!);
    expect(vinyl.some((v) => v.line.includes("mono"))).toBe(true);
    expect(worstStatus(hot)).toBe("fail");
    expect(worstStatus(good)).toBe("pass");
  });

  it("uses the same loudness and true-peak thresholds in live meter and profile reports", () => {
    const profile = profileFor("streaming")!;
    const metrics = { lufs: -11.5, truePeakDb: -0.8, correlation: 0.8, monoLossDb: -0.5, lrImbalanceDb: 0 };
    const shared = evaluateDelivery(metrics, profile);
    const live = evaluateMasterVerdict(
      {
        lufsIntegrated: metrics.lufs,
        truePeakDb: metrics.truePeakDb,
        correlation: metrics.correlation,
        monoLossDb: metrics.monoLossDb,
        lrImbalanceDb: metrics.lrImbalanceDb,
      },
      profile.targetLufs,
      -1,
      profile.label.toUpperCase(),
      profile,
    );
    expect(shared.checks[0]?.status).toBe("fail");
    expect(shared.checks[1]?.status).toBe("warn");
    expect(live.level).toBe("bad");

    const custom = evaluateDelivery({ lufs: -14, truePeakDb: -0.5 }, CUSTOM_PROFILE, -14, -0.7);
    expect(custom.checks[1]?.status).toBe("warn");
  });

  it("pins pass, warning, and failure boundaries plus unavailable measurements", () => {
    const profile = profileFor("streaming")!;
    const loudnessStatus = (lufs: number | null) =>
      evaluateDelivery({ lufs, truePeakDb: profile.maxTruePeakDb }, profile).checks[0]?.status;
    expect(loudnessStatus(-13)).toBe("pass");
    expect(loudnessStatus(-12.9)).toBe("warn");
    expect(loudnessStatus(-12)).toBe("warn");
    expect(loudnessStatus(-11.9)).toBe("fail");
    expect(loudnessStatus(-15)).toBe("pass");
    expect(loudnessStatus(-16)).toBe("warn");
    expect(loudnessStatus(-16.1)).toBe("warn");
    expect(loudnessStatus(-16.2)).toBe("fail");
    expect(loudnessStatus(null)).toBe("warn");
    expect(loudnessStatus(-120)).toBe("warn");

    const peakStatus = (truePeakDb: number) =>
      evaluateDelivery({ lufs: -14, truePeakDb }, profile).checks[1]?.status;
    expect(peakStatus(-1)).toBe("pass");
    expect(peakStatus(-0.9)).toBe("warn");
    expect(peakStatus(-0.71)).toBe("warn");
    expect(peakStatus(-0.69)).toBe("fail");
    expect(evaluateDelivery({ lufs: -120, truePeakDb: Number.NaN }, profile).status).toBe("warn");

    const phase = evaluateDelivery(
      { lufs: -14, truePeakDb: -1.5, correlation: -0.1, monoLossDb: -4, lrImbalanceDb: 7 },
      profile,
    );
    expect(phase.status).toBe("fail");
    expect(phase.checks.map((check) => check.line)).toEqual(
      expect.arrayContaining([
        "Phase issues — check mono compatibility",
        "Mono fold-down loses depth — check wide elements",
        "Left/right balance off by more than 6 dB",
      ]),
    );
  });
});

describe("kyx_master op:land — the closed loudness loop", () => {
  /** Meters coupled to the store: source sits at baseLufs; the master trim
   * shifts the measurement exactly like the real engine does. */
  function landingCtx(store: ProjectStore, baseLufs: number, truePeakDb = -1.6): McpToolContext {
    const inner = storeCtx(store);
    return {
      ...inner,
      meters: () => ({
        master: {
          lufsIntegrated: baseLufs + (store.doc.master.loudnessTrimDb ?? 0),
          truePeakDb: truePeakDb + (store.doc.master.loudnessTrimDb ?? 0),
        },
      }),
    } as McpToolContext;
  }

  it("lands a −16.8 LUFS source at −14 in bounded steps and reports the trim", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = landingCtx(store, -16.8);
    const result = await executeMcpTool(ctx, "kyx_master", { op: "land", profile: "streaming" });
    expect(result.mutated).toBe(true);
    expect(result.text).toContain("LANDED");
    expect(store.doc.master.loudnessTrimDb).toBeCloseTo(2.8, 1);
    expect(result.text).toContain("LUFS vs target");
  });

  it("already-landed master needs no trim (mutated: false); no meters refuses honestly", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = landingCtx(store, -14.1);
    const result = await executeMcpTool(ctx, "kyx_master", { op: "land", profile: "streaming" });
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("LANDED");
    expect(store.doc.master.loudnessTrimDb ?? 0).toBe(0);

    const bare = storeCtx(new ProjectStore(datasetDoc()));
    const refused = await executeMcpTool(bare, "kyx_master", { op: "land", profile: "streaming" });
    expect(refused.mutated).toBe(false);
    expect(refused.text).toContain("needs live audio meters");
  });

  it("op:platform is a read-only verdict; profile drives op:assist's target", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = landingCtx(store, -12.5);
    const verdict = await executeMcpTool(ctx, "kyx_master", { op: "platform", profile: "apple" });
    expect(verdict.mutated).toBe(false);
    expect(verdict.text).toContain("HOT");

    // assist targets the APPLE contract when given the profile (−16, quieter
    // than the measured −12.5+trim domain): the plan must carry ceiling
    // discipline, not limiting push.
    const assisted = await executeMcpTool(ctx, "kyx_master", {
      op: "assist",
      family: "drums",
      profile: "apple",
      insert: true,
    });
    expect(assisted.mutated).toBe(true);
    expect(assisted.text).toContain("ceiling discipline");
  });

  it("MCP platform report includes the same stereo checks as the live verdict", async () => {
    const store = new ProjectStore(datasetDoc());
    const base = landingCtx(store, -11.5, -0.8);
    const ctx = {
      ...base,
      meters: () => ({
        master: {
          lufsIntegrated: -11.5,
          truePeakDb: -0.8,
          correlation: -0.2,
          monoLossDb: -4,
          lrImbalanceDb: 7,
        },
      }),
    } as McpToolContext;
    const report = await executeMcpTool(ctx, "kyx_master", { op: "platform" });
    expect(report.text).toContain("FAIL");
    expect(report.text).toContain("Phase issues");
    expect(report.text).toContain("Mono fold-down loses depth");
    expect(report.text).toContain("Left/right balance off by more than 6 dB");
  });
});
