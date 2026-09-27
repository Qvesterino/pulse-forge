import { describe, expect, it } from "vitest";
import { parseProductionIntent } from "../src/intent/production";

/* ------------------------------------------------------------------ */
/* Level 1 - magnitude: the degree ladder                                */
/* ------------------------------------------------------------------ */

function amountOf(text: string, concept: string): number | undefined {
  const intent = parseProductionIntent(text);
  return intent?.goals.find((g) => g.concept === concept)?.amount;
}

describe("level 1 — magnitude: English-first degree ladder", () => {
  it("an unqualified ask keeps the untouched default", () => {
    expect(amountOf("make the bass deeper", "deeper")).toBe(0.7);
  });

  it("'much deeper' outranks the default", () => {
    expect(amountOf("make the bass much deeper", "deeper")).toBe(0.85);
  });

  it("'slightly deeper' lands below the default", () => {
    expect(amountOf("make the bass slightly deeper", "deeper")).toBe(0.35);
  });

  it("gives each attenuator its own step instead of one shared value", () => {
    // The old binary made these two identical, which is the whole point of
    // the ladder: the engine could not tell a polite ask from a real one.
    const barely = amountOf("make the bass barely deeper", "deeper");
    const slightly = amountOf("make the bass slightly deeper", "deeper");
    const fairly = amountOf("make the bass fairly deeper", "deeper");
    const quite = amountOf("make the bass quite deeper", "deeper");
    const much = amountOf("make the bass much deeper", "deeper");
    const fully = amountOf("make the bass fully deeper", "deeper");
    expect([barely, slightly, fairly, quite, much, fully]).toEqual([0.2, 0.35, 0.55, 0.7, 0.85, 0.95]);
    // Strictly increasing — the ladder never collapses two words together.
    const steps = [barely, slightly, fairly, quite, much, fully] as number[];
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeGreaterThan(steps[i - 1]);
  });

  it("'completely' and 'totally' read as maximal", () => {
    expect(amountOf("make the drums completely darker", "darker")).toBe(0.95);
    expect(amountOf("make the drums totally darker", "darker")).toBe(0.95);
  });

  it("a softener scopes a following 'too much' phrase", () => {
    // "a bit too much" is one softened degree phrase, not two competing
    // tokens where the nearby "much" wins by itself.
    expect(amountOf("make the bass a bit too much deeper", "deeper")).toBe(0.35);
  });
});

describe("level 1 — magnitude: numeric degree (EN + SK)", () => {
  it("'by one' resolves to its own step", () => {
    expect(amountOf("make the bass deeper by one", "deeper")).toBe(0.4);
  });

  it("'by two' is stronger than 'by one'", () => {
    expect(amountOf("make the bass deeper by two", "deeper")).toBe(0.5);
    expect(amountOf("make the bass deeper by three", "deeper")).toBe(0.62);
    expect(amountOf("make the bass deeper by four", "deeper")).toBe(0.7);
  });

  it("'by half' reaches the default band", () => {
    expect(amountOf("make the bass deeper by half", "deeper")).toBe(0.7);
  });

  it("reads the Slovak 'o jednu' form", () => {
    expect(amountOf("urob basu hlbšie o jednu dobu", "deeper")).toBe(0.4);
  });

  it("numeric degrees increase monotonically", () => {
    const one = amountOf("make the bass deeper by one", "deeper")!;
    const two = amountOf("make the bass deeper by two", "deeper")!;
    const three = amountOf("make the bass deeper by three", "deeper")!;
    const four = amountOf("make the bass deeper by four", "deeper")!;
    expect(two).toBeGreaterThan(one);
    expect(three).toBeGreaterThan(two);
    expect(four).toBeGreaterThan(three);
  });
});

describe("level 1 — magnitude: the degree is scoped to its own clause", () => {
  it("a degree in one clause does not scale the other clause's concept", () => {
    // The whole reason detectAmount takes a window instead of the whole
    // string: previously every goal inherited one global amount.
    const intent = parseProductionIntent("make the drums much punchier and the bass slightly deeper");
    expect(intent).not.toBeNull();
    const punch = intent!.goals.find((g) => g.concept === "punchier")!.amount;
    const deeper = intent!.goals.find((g) => g.concept === "deeper")!.amount;
    expect(punch).toBeGreaterThan(deeper);
    expect(punch).toBe(0.85);
    expect(deeper).toBe(0.35);
  });

  it("both degrees survive a two-clause request", () => {
    const intent = parseProductionIntent("slightly warmer bass, way wider lead");
    expect(intent!.goals.find((g) => g.concept === "warmer")!.amount).toBe(0.35);
    expect(intent!.goals.find((g) => g.concept === "wider")!.amount).toBe(0.85);
  });
});

/* ------------------------------------------------------------------ */
/* Level 2 - per-clause effect targeting                                */
/* ------------------------------------------------------------------ */

describe("level 2 — targeting: a named target in the same clause wins", () => {
  it("'punchier drums' aims at the drums", () => {
    const intent = parseProductionIntent("make it punchier on the drums");
    expect(intent!.targets).toContain("drums");
  });

  it("'a filter on the bass' aims at the bass", () => {
    const intent = parseProductionIntent("add a telephone effect to the bass");
    expect(intent!.targets).toContain("bass");
  });

  it("'wider on the chords' aims at the chords", () => {
    const intent = parseProductionIntent("make the chords wider");
    expect(intent!.targets).toContain("chords");
  });
});

describe("level 2 — targeting: two clauses land on two different tracks", () => {
  it("'punchier drums, deeper bass' splits across both", () => {
    // Before per-clause binding the parser collected targets GLOBALLY, so
    // both concepts were applied to the first track detected and the second
    // ask silently overwrote the first.
    const intent = parseProductionIntent("punchier drums, deeper bass");
    expect(intent).not.toBeNull();
    expect(intent!.targets).toContain("drums");
    expect(intent!.targets).toContain("bass");
    expect(intent!.goals).toHaveLength(2);
  });

  it("both degrees and both targets survive the split", () => {
    const intent = parseProductionIntent("slightly punchier drums, much deeper bass");
    expect(intent!.targets.sort()).toEqual(["bass", "drums"]);
    expect(intent!.goals.find((g) => g.concept === "punchier")!.amount).toBe(0.35);
    expect(intent!.goals.find((g) => g.concept === "deeper")!.amount).toBe(0.85);
  });

  it("a third clause adds a third target", () => {
    const intent = parseProductionIntent("darker drums, wider chords, tape on the bass");
    expect(intent!.targets).toHaveLength(3);
    for (const target of ["drums", "chords", "bass"]) expect(intent!.targets).toContain(target);
  });
});

describe("level 2 — targeting: fallbacks still apply", () => {
  it("an unnamed target falls back to the concept's natural home", () => {
    // "deeper" naturally lives on the bass, so an unqualified ask still
    // aims there rather than nowhere.
    const intent = parseProductionIntent("make it deeper");
    expect(intent!.targets).toContain("bass");
  });

  it("a concept with no target named anywhere still resolves", () => {
    const intent = parseProductionIntent("add some tape");
    expect(intent).not.toBeNull();
    expect(intent!.targets.length).toBeGreaterThan(0);
  });

  it("pad targets are still extracted from the result", () => {
    const intent = parseProductionIntent("more punch on the kick");
    expect(intent!.padTargets).toContain("kick");
  });
});
