import { describe, expect, it } from "vitest";
import { planCompCore, type CompCoreTake } from "../src/shared/comp-core";

/**
 * COMP PLAN CORE — the shared spine behind BOTH comping lanes (vocal-lane
 * profiles and arrangement take audio). Its contract is what stops the two
 * planners from drifting apart, so it is pinned here directly:
 *
 *   - a bar goes to the highest-scoring ELIGIBLE take;
 *   - equal scores keep the earlier take (callers pre-rank for priority);
 *   - consecutive same-winner bars merge into ONE span;
 *   - a bar no take can serve stays an honest hole (reported, not filled);
 *   - the winner is the take with the most bars, earlier take winning ties;
 *   - everything is deterministic and pure.
 */

function take(takeId: string, eligible: (bar: number) => number, score: (bar: number) => number): CompCoreTake<string> {
  return {
    takeId,
    scoreBar: (bar) => {
      const e = eligible(bar);
      return { eligible: e > 0, score: e > 0 ? score(bar) : 0 };
    },
  };
}

describe("planCompCore", () => {
  it("gives each bar to the higher-scoring eligible take and merges spans", () => {
    // A wins 0-1, B wins 2-3, A wins 4.
    const a = take(
      "a",
      () => 1,
      (bar) => (bar < 2 || bar === 4 ? 0.9 : 0.1),
    );
    const b = take(
      "b",
      () => 1,
      (bar) => (bar === 2 || bar === 3 ? 0.9 : 0.1),
    );
    const plan = planCompCore([a, b], 5);

    expect(plan.segments).toEqual([
      { startBar: 0, endBar: 1, winner: "a", score: 0.9 },
      { startBar: 2, endBar: 3, winner: "b", score: 0.9 },
      { startBar: 4, endBar: 4, winner: "a", score: 0.9 },
    ]);
    expect(plan.coveredBars).toBe(5);
    expect(plan.uncoveredBars).toEqual([]);
    expect(plan.perTakeBars.get("a")).toBe(3);
    expect(plan.perTakeBars.get("b")).toBe(2);
    expect(plan.winner).toBe("a");
  });

  it("keeps the earlier take on equal scores", () => {
    const first = take(
      "first",
      () => 1,
      () => 0.5,
    );
    const second = take(
      "second",
      () => 1,
      () => 0.5,
    );
    const plan = planCompCore([first, second], 4);

    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0]!.winner).toBe("first");
    expect(plan.perTakeBars.get("second")).toBe(0);
  });

  it("an ineligible take cannot win even with an infinite-looking score", () => {
    // Only 'b' is eligible on bar 1, 'a' is not — coverage must beat score.
    const a = take(
      "a",
      (bar) => (bar === 0 ? 1 : 0),
      () => 999,
    );
    const b = take(
      "b",
      (bar) => (bar === 1 ? 1 : 0),
      () => 0.01,
    );
    const plan = planCompCore([a, b], 2);

    expect(plan.segments.map((s) => s.winner)).toEqual(["a", "b"]);
    expect(plan.uncoveredBars).toEqual([]);
  });

  it("reports uncovered bars as holes and never merges across them", () => {
    const a = take(
      "a",
      (bar) => (bar === 0 || bar === 3 ? 1 : 0),
      () => 0.9,
    );
    const plan = planCompCore([a], 4);

    expect(plan.segments.map((s) => [s.startBar, s.endBar])).toEqual([
      [0, 0],
      [3, 3],
    ]);
    expect(plan.uncoveredBars).toEqual([1, 2]);
    expect(plan.coveredBars).toBe(2);
    expect(plan.perTakeBars.get("a")).toBe(2);
  });

  it("a no-take grid is all holes, with a null winner", () => {
    const plan = planCompCore(
      [
        take(
          "a",
          () => 0,
          () => 1,
        ),
      ],
      3,
    );
    expect(plan.segments).toEqual([]);
    expect(plan.uncoveredBars).toEqual([0, 1, 2]);
    expect(plan.winner).toBeNull();
  });

  it("keeps the span score at its highest bar", () => {
    const a = take(
      "a",
      () => 1,
      (bar) => (bar === 1 ? 0.9 : 0.4),
    );
    const plan = planCompCore([a], 3);
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0]!.score).toBe(0.9);
  });

  it("is deterministic and handles a degenerate grid without throwing", () => {
    const a = take(
      "a",
      () => 1,
      () => 0.5,
    );
    expect(planCompCore([a], 0)).toMatchObject({ segments: [], coveredBars: 0, winner: null, bars: 0 });
    expect(planCompCore([a], Number.NaN).bars).toBe(0);
    expect(planCompCore([a], 3)).toEqual(planCompCore([a], 3));
  });
});
