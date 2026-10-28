import { beforeEach, describe, expect, it } from "vitest";
import { reactionReportForAgent } from "../src/mcp/reaction-report";
import { ReactionLedger, setActiveReactionLedger, setReactionLedgerEnabled } from "../src/intent/reaction-ledger";
import { executeMcpToolAsync } from "../src/mcp/tools";
import type { McpToolContext } from "../src/mcp/tools";
import type { ReactionEntry } from "../src/intent/reaction-ledger";
import { withAgentWriter } from "./helpers/mcpAgentWriter";

/**
 * F2 — the report as an agent sees it, on kyx_diagnose_mix.
 *
 * The silence specs carry the weight here: a report that always speaks teaches
 * an agent to ignore the section, so "nothing resolved yet" must be
 * indistinguishable from "F1 does not exist".
 */

function row(overrides: Partial<ReactionEntry> & { id: string }): ReactionEntry {
  return {
    createdAt: 1_000,
    routeKind: "effectIntent",
    action: "adjust:effect:rel",
    trackIds: [],
    beforeHash: "aaaabbbb",
    afterHash: "ccccdddd",
    outcome: "kept",
    resolvedAt: 2_000,
    ...overrides,
  };
}

/** A ledger stand-in: the reporter only ever calls entries(). */
function fakeLedger(rows: ReactionEntry[]): ReactionLedger {
  return { entries: () => rows } as unknown as ReactionLedger;
}

beforeEach(() => {
  setReactionLedgerEnabled(true);
  setActiveReactionLedger(null);
});

describe("F2 agent report", () => {
  it("says nothing when the ledger is off", () => {
    setReactionLedgerEnabled(false);
    expect(reactionReportForAgent()).toBeNull();
  });

  it("says nothing when nothing has been decided yet", () => {
    setActiveReactionLedger(fakeLedger([row({ id: "rx-1", outcome: "pending", resolvedAt: null })]));
    expect(reactionReportForAgent()).toBeNull();
  });

  it("says nothing when the ledger is empty", () => {
    setActiveReactionLedger(fakeLedger([]));
    expect(reactionReportForAgent()).toBeNull();
  });

  it("reports counts, the least welcome descriptors and the gate", () => {
    setActiveReactionLedger(
      fakeLedger([
        ...Array.from({ length: 2 }, (_, index) => row({ id: `k-${index}`, outcome: "kept" })),
        ...Array.from({ length: 6 }, (_, index) => row({ id: `u-${index}`, outcome: "undone" })),
        row({ id: "p-1", outcome: "pending", resolvedAt: null }),
      ]),
    );
    const section = reactionReportForAgent();
    expect(section).not.toBeNull();
    expect(section!.text).toContain("8 decided");
    expect(section!.text).toContain("keep 25%");
    expect(section!.text).toContain("effectIntent 8");
    expect(section!.text).toContain("reorder only, do not treat as a ban");
    expect(section!.text).toContain("adjust:effect:rel");
    expect(section!.text).toContain("model gate: not eligible");
    expect(section!.data.retrain.eligible).toBe(false);
  });

  it("a 50/50 descriptor is NOT reported as rejected", () => {
    // Evenly split history shrinks to weight 0 = "no opinion". Naming it as
    // "least welcome" would be a claim the data does not support.
    setActiveReactionLedger(
      fakeLedger([
        ...Array.from({ length: 4 }, (_, index) => row({ id: `k-${index}`, outcome: "kept" })),
        ...Array.from({ length: 4 }, (_, index) => row({ id: `u-${index}`, outcome: "undone" })),
      ]),
    );
    expect(reactionReportForAgent()!.text).not.toContain("least welcome");
  });

  it("never claims a retrain it cannot justify", () => {
    setActiveReactionLedger(fakeLedger(Array.from({ length: 120 }, (_, index) => row({ id: `r-${index}` }))));
    const section = reactionReportForAgent();
    // 120 reactions is well past the count gate — but no validation split has
    // been measured, so the gate must still say no.
    expect(section!.text).toContain("not eligible — no validation split measured");
    expect(section!.data.retrain.eligible).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* the transport contract                                               */
/* ------------------------------------------------------------------ */

function makeCtx(): McpToolContext {
  return withAgentWriter({
    getDoc: () => ({}) as never,
    execute: () => undefined,
    undo: () => undefined,
    redo: () => undefined,
    undoStackLength: () => 0,
    historyLabels: () => [],
    isMicRecordingActive: () => false,
    transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
    diagnoseMix: async () =>
      ({
        scope: "master",
        referenceLufs: -14,
        master: null,
        strips: [],
        findings: [],
        attributions: [],
        suggestedActions: [],
      }) as never,
  });
}

describe("F2 on kyx_diagnose_mix", () => {
  it("adds nothing to a diagnose call when the ledger is quiet", async () => {
    const result = await executeMcpToolAsync(makeCtx(), "kyx_diagnose_mix", {});
    expect(result.mutated).toBe(false);
    expect(result.text).not.toContain("proposals the owner reacted to");
    expect((result.data as { reactions?: unknown }).reactions).toBeUndefined();
  });

  it("attaches the report as text and as machine-readable data", async () => {
    setActiveReactionLedger(fakeLedger(Array.from({ length: 3 }, (_, index) => row({ id: `k-${index}` }))));
    const result = await executeMcpToolAsync(makeCtx(), "kyx_diagnose_mix", {});
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("proposals the owner reacted to");
    const data = result.data as { reactions?: { decided?: number; totals?: { kept?: number } } };
    expect(data.reactions?.totals?.kept).toBe(3);
  });

  it("stays silent — and stays honest — when the transport has no render context", async () => {
    const ctx = makeCtx();
    delete (ctx as { diagnoseMix?: unknown }).diagnoseMix;
    const result = await executeMcpToolAsync(ctx, "kyx_diagnose_mix", {});
    expect(result.text).toContain("not available over this MCP transport");
  });
});
