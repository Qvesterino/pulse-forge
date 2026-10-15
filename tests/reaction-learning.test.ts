import { describe, expect, it } from "vitest";
import {
  MIN_DECIDED_FOR_WEIGHT,
  RETRAIN_MIN_REACTIONS,
  applyReactionBias,
  buildReactionReport,
  reactionKey,
  reactionWeight,
  reactionWeights,
  retrainGate,
  topRejections,
} from "../src/intent/reaction-learning";
import { sanitizeReactionEntry } from "../src/intent/reaction-ledger";
import type { ReactionEntry, ReactionOutcome } from "../src/intent/reaction-ledger";

/**
 * F2 — reactions → learning. The report, the shrunk rerank weight, the
 * bias guard, and the model gate.
 *
 * The bias-guard specs are the load-bearing ones: the plan pre-registered
 * "reactions REORDER gated candidates, never create actions outside the
 * scheme". A sort-based implementation satisfies that by construction, and
 * every spec here asserts the membership invariant rather than a specific
 * order — because a future "small improvement" that filters or appends would
 * keep the ordering specs green while violating the actual contract.
 */

function entry(overrides: Partial<ReactionEntry> = {}): ReactionEntry {
  return {
    id: "rx-1",
    createdAt: 1_000,
    routeKind: "effectIntent",
    action: "adjust:effect:rel",
    trackIds: ["track-1"],
    beforeHash: "aaaabbbb",
    afterHash: "ccccdddd",
    outcome: "kept",
    resolvedAt: 2_000,
    ...overrides,
  };
}

function entriesWith(
  action: string,
  outcome: ReactionOutcome,
  count: number,
  routeKind = "effectIntent",
): ReactionEntry[] {
  return Array.from({ length: count }, (_, index) => entry({ id: `rx-${index}`, action, outcome, routeKind }));
}

describe("F2 report", () => {
  it("counts outcomes and computes the keep-rate over decided proposals only", () => {
    const report = buildReactionReport([
      ...entriesWith("adjust:effect:rel", "kept", 3),
      ...entriesWith("adjust:effect:rel", "undone", 1),
      entry({ id: "rx-p", outcome: "pending", resolvedAt: null }),
    ]);
    expect(report.totals).toEqual({ kept: 3, undone: 1, tweaked: 0, pending: 1, decided: 4, keepRate: 0.75 });
  });

  it("a pending proposal never votes", () => {
    // The false positive F1 exists to prevent: an unresolved proposal must
    // not be counted as "kept".
    const withPending = buildReactionReport([entry({ id: "rx-1", outcome: "pending", resolvedAt: null })]);
    expect(withPending.totals.decided).toBe(0);
    expect(withPending.totals.keepRate).toBe(0);
    expect(withPending.byAction).toEqual([]);
  });

  it("tweaked counts as survival — the direction was accepted, then edited", () => {
    const report = buildReactionReport([
      ...entriesWith("a:b:abs", "tweaked", 2),
      ...entriesWith("a:b:abs", "undone", 2),
    ]);
    expect(report.totals.keepRate).toBe(0.5);
  });

  it("groups per route kind AND per descriptor", () => {
    const report = buildReactionReport([
      ...entriesWith("adjust:effect:rel", "kept", 2, "effectIntent"),
      ...entriesWith("adjust:effect:rel", "undone", 2, "paramIntent"),
    ]);
    expect(Object.keys(report.byRouteKind).sort()).toEqual(["effectIntent", "paramIntent"]);
    // Same descriptor, two route kinds → two independent opinions.
    expect(report.byAction).toHaveLength(2);
    const byKind = Object.fromEntries(report.byAction.map((stat) => [stat.routeKind, stat.weight]));
    expect(byKind.effectIntent).toBeGreaterThan(0);
    expect(byKind.paramIntent).toBeLessThan(0);
  });

  it("orders the most-rejected descriptor first", () => {
    const report = buildReactionReport([
      ...entriesWith("b:trackGain:rel", "kept", 8),
      ...entriesWith("a:effect:rel", "undone", 8),
    ]);
    expect(report.byAction[0].action).toBe("a:effect:rel");
    expect(report.byAction[0].weight).toBeLessThan(0);
  });

  it("carries no prose — and no track ids either", () => {
    const report = buildReactionReport([entry({ trackIds: ["track-42"] })]);
    const serialized = JSON.stringify(report);
    expect(serialized).toContain("adjust:effect:rel");
    // The report is an AGGREGATE: it drops track ids as well as every string
    // the user typed. The per-row detail stays in the ledger behind the
    // export button, where the user asked for it.
    expect(serialized).not.toContain("track-42");
    expect(serialized).not.toMatch(/[a-z]{4,}\s+[a-z]{4,}/); // no free-form words
  });
});

describe("F2 weight — shrinkage", () => {
  it("one undo earns no opinion at all — the floor holds", () => {
    expect(MIN_DECIDED_FOR_WEIGHT).toBe(2);
    expect(reactionWeight(0, 1, 0)).toBe(0);
    expect(reactionWeight(1, 0, 0)).toBe(0);
    expect(reactionWeight(0, 0, 0)).toBe(0);
  });

  it("two undos form an opinion, ten weigh far harder", () => {
    const two = Math.abs(reactionWeight(0, 2, 0));
    const ten = Math.abs(reactionWeight(0, 10, 0));
    expect(two).toBeCloseTo(0.3333, 3);
    expect(ten).toBeGreaterThan(two * 2);
    expect(ten).toBeLessThan(1);
  });

  it("mixed history settles between the extremes", () => {
    const weight = reactionWeight(5, 5, 0);
    expect(weight).toBeCloseTo(0, 5);
  });

  it("stays inside [-1, 1] even with hostile counts", () => {
    expect(reactionWeight(0, -100, 0)).toBe(0);
    expect(reactionWeight(1_000, 0, 0)).toBeLessThanOrEqual(1);
    expect(reactionWeight(0, 1_000, 0)).toBeGreaterThanOrEqual(-1);
  });

  it("the weights map is keyed per route kind", () => {
    const report = buildReactionReport([...entriesWith("adjust:effect:rel", "undone", 4, "effectIntent")]);
    const weights = reactionWeights(report);
    expect(weights.get(reactionKey("effectIntent", "adjust:effect:rel"))).toBeLessThan(0);
    expect(weights.get(reactionKey("paramIntent", "adjust:effect:rel"))).toBeUndefined();
  });
});

describe("F2 bias guard — reorder only, never create", () => {
  const items = ["alpha", "beta", "gamma", "delta"];

  it("returns the same members, in a different order", () => {
    const weights = new Map([
      ["beta", 1],
      ["delta", -1],
    ]);
    const biased = applyReactionBias(items, (item) => item, weights);
    expect(biased).toHaveLength(items.length);
    expect([...biased].sort()).toEqual([...items].sort());
    expect(biased).toEqual(["beta", "alpha", "gamma", "delta"]);
  });

  it("an unknown key leaves the order untouched", () => {
    expect(applyReactionBias(items, (item) => item, new Map())).toEqual(items);
  });

  it("is stable — equal weights keep their original order", () => {
    const weights = new Map([
      ["alpha", 0.5],
      ["beta", 0.5],
      ["gamma", 0.5],
    ]);
    expect(applyReactionBias(items, (item) => item, weights)).toEqual(items);
  });

  it("never adds or drops a candidate, whatever the weights", () => {
    const extremes = new Map<string, number>([
      ["alpha", 1],
      ["beta", -1],
      ["gamma", 1],
      ["delta", -1],
    ]);
    for (const order of [items, [...items].reverse(), ["beta"], items.slice(1, 3)]) {
      const biased = applyReactionBias(order, (item) => item, extremes);
      expect(biased).toHaveLength(order.length);
      expect([...biased].sort()).toEqual([...order].sort());
    }
  });

  it("an empty order stays empty", () => {
    expect(applyReactionBias([], () => "x", new Map([["x", 1]]))).toEqual([]);
  });
});

describe("F2 model gate", () => {
  it("does not fire below 50 reactions", () => {
    const gate = retrainGate(RETRAIN_MIN_REACTIONS - 1, { before: 100, after: 140 });
    expect(gate.eligible).toBe(false);
    expect(gate.reasons.join(" ")).toContain("reactions");
  });

  it("does not fire when the val split did not grow", () => {
    const gate = retrainGate(60, { before: 100, after: 100 });
    expect(gate.eligible).toBe(false);
    expect(gate.reasons.join(" ")).toContain("validation");
  });

  it("does not fire when no split has been measured", () => {
    expect(retrainGate(500, null).eligible).toBe(false);
  });

  it("fires only on BOTH conditions, and then it is eligible", () => {
    const gate = retrainGate(50, { before: 100, after: 101 });
    expect(gate.eligible).toBe(true);
    expect(gate.reasons).toEqual([]);
  });
});

describe("F2 top rejections", () => {
  it("names only descriptors with a negative weight", () => {
    const report = buildReactionReport([
      ...entriesWith("a:effect:rel", "undone", 5),
      ...entriesWith("b:trackGain:rel", "kept", 5),
    ]);
    expect(topRejections(report).map((stat) => stat.action)).toEqual(["a:effect:rel"]);
  });

  it("a single undo is not a top rejection — the floor holds", () => {
    const report = buildReactionReport(entriesWith("a:effect:rel", "undone", 1));
    expect(topRejections(report)).toEqual([]);
  });
});

describe("F2 report survives a hostile ledger", () => {
  it("sanitised entries from storage are enough to build a report", () => {
    // Anything read back from IndexedDB passes through sanitizeReactionEntry
    // first; a malformed row must not poison the weights.
    const parsed = sanitizeReactionEntry({ ...entry(), action: "adjust:effect:rel" });
    expect(parsed).not.toBeNull();
    const report = buildReactionReport(parsed ? [parsed] : []);
    expect(report.decided).toBe(1);
    expect(report.byAction[0].weight).toBe(0); // one sample → no opinion
  });
});
