import { describe, expect, it } from "vitest";
import { MASTER_PROFILES, profileFor, verdictAgainst, worstStatus } from "../src/mcp/master-profiles";
import { ProjectStore } from "../src/store/ProjectStore";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import type { ProjectDocument } from "../src/project-model/types";

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
});
