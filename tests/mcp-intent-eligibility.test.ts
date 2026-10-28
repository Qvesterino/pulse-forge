import { describe, expect, it } from "vitest";
import { createHeadlessMcpHost } from "../src/mcp/headless-host";
import { MCP_INTENT_ELIGIBILITY, mcpIntentEligibilitySnapshot } from "../src/intent/mcp-eligibility";
import { routeIntentText } from "../src/intent/route";
import { createDefaultProject } from "../src/project-model/schema";

/**
 * AS-014 — per-kind MCP eligibility for NL routes. One data table drives the
 * kyx_intent refusals AND the published capability block, so discovery and
 * refusal cannot drift apart. The newly eligible kinds (mix, complaintIntent)
 * run their executors over the same command layer / read-only diagnosis as
 * the Intent Panel; the window-bound kinds still refuse, but with a POINTER
 * at the structured tool that can do the job.
 */

function host() {
  return createHeadlessMcpHost({ document: createDefaultProject() });
}

describe("MCP intent eligibility table (AS-014)", () => {
  it("every RoutedIntent kind has a table entry and the snapshot mirrors it", () => {
    const doc = createDefaultProject();
    // The corpus below is the router's own vocabulary — every kind the
    // router can actually emit must appear in the table. (Not every table
    // entry needs a fixture; the compile-guarded Record covers the rest.)
    const corpus: Array<[string, string]> = [
      ["fader", "make the drums a bit quieter"],
      ["mix", "make the mix darker"],
      ["complaintIntent", "the lead is harsh"],
      ["loudness", "make it louder"],
      ["select", "select the drums"],
    ];
    for (const [expectedKind, text] of corpus) {
      const route = routeIntentText(text, doc);
      expect(route.kind, text).toBe(expectedKind);
      expect(MCP_INTENT_ELIGIBILITY[route.kind], expectedKind).toBeDefined();
    }
    const snapshot = mcpIntentEligibilitySnapshot();
    expect(snapshot.eligibleKinds).toContain("mix");
    expect(snapshot.eligibleKinds).toContain("complaintIntent");
    const refusedKinds = snapshot.refused.map((entry) => entry.kind);
    expect(refusedKinds).toContain("loudness");
    expect(refusedKinds).toContain("select");
  });

  it("a mix ask now executes over MCP as ONE undo step with the profile summary", async () => {
    const h = host();
    const result = await h.call("kyx_intent", { instruction: "make the mix darker" });
    expect(result.isError, result.text).not.toBe(true);
    expect(result.mutated, result.text).toBe(true);
    expect(result.text).toContain("⚡ mix:");
    expect(result.text).toContain("one undo step");
    const depth = h.store.undoStackLength;
    expect(depth).toBeGreaterThanOrEqual(1);
    h.store.undo();
    // The whole profile folds into ONE step — undo returns to the baseline.
    expect(h.store.doc.master.tiltDb ?? 0).toBe(0);
  });

  it("a complaint ask returns the READ-ONLY diagnosis with verified next asks", async () => {
    const h = host();
    const before = h.store.doc;
    // "no punch" is a complaint kind whose proposals are unconditional —
    // the fixture guarantees a non-empty verified list to follow up on.
    const result = await h.call("kyx_intent", { instruction: "the drums have no punch" });
    expect(result.isError, result.text).not.toBe(true);
    expect(result.mutated).toBe(false);
    expect(h.store.doc).toBe(before);
    expect(result.text).toContain("👂");
    expect(result.text).toContain("verified next asks");
    const data = result.data as { status: string; verifiedAsks: string[] };
    expect(data.status).toBe("diagnosis");
    expect(data.verifiedAsks.length).toBeGreaterThan(0);
    // The verified asks are executable: re-sending one actually mutates.
    const followUp = await h.call("kyx_intent", { instruction: data.verifiedAsks[0] });
    expect(followUp.mutated, followUp.text).toBe(true);
  });

  it("window-bound kinds still refuse, now with a POINTER at the structured tool", async () => {
    const h = host();
    const loudness = await h.call("kyx_intent", { instruction: "make it louder" });
    expect(loudness.isError).toBe(true);
    expect(loudness.errorCode).toBe("UNAVAILABLE_ON_TRANSPORT");
    expect(loudness.text).toContain("kyx_loudness");

    const select = await h.call("kyx_intent", { instruction: "select the drums" });
    expect(select.isError).toBe(true);
    expect(select.text).toContain("window state");

    // sectionProduction needs a scene-role doc to route at all (audition-first
    // by design) — the refusal CONTRACT is pinned at the table level here.
    expect(MCP_INTENT_ELIGIBILITY.sectionProduction.eligible).toBe(false);
    if (!MCP_INTENT_ELIGIBILITY.sectionProduction.eligible) {
      expect(MCP_INTENT_ELIGIBILITY.sectionProduction.reason).toContain("audition");
    }
  });

  it("the capability block publishes the same eligibility table", async () => {
    const h = host();
    const result = await h.call("kyx_state", { subject: "capabilities" });
    const capabilities = (
      result.data as {
        capabilities: {
          intentEligibility: { eligibleKinds: string[]; refused: Array<{ kind: string; useInstead?: string }> };
        };
      }
    ).capabilities;
    expect(capabilities.intentEligibility.eligibleKinds).toContain("mix");
    expect(capabilities.intentEligibility.eligibleKinds).toContain("complaintIntent");
    const loudness = capabilities.intentEligibility.refused.find((entry) => entry.kind === "loudness");
    expect(loudness?.useInstead).toContain("kyx_loudness");
    // Snapshot and table cannot disagree (same source).
    const snapshot = mcpIntentEligibilitySnapshot();
    expect(capabilities.intentEligibility.eligibleKinds).toEqual(snapshot.eligibleKinds);
  });
});
