import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Regression cover for the semantic escape-hatch fixes (2026-09-28).
 *
 * Measured context: PRIOR_STYLE_VOCAB holds 21 of the 170 grooves in the
 * library, so 88% of generations cannot use the v1 one-hot drum prior. The
 * v3 semantic channel is the only escape, and it silently returned null when
 * the ~118 MB model was cold or the device opted out — which pushed those
 * runs onto the template fallback while the UI still said "generated".
 *
 * These are source-shape pins rather than runtime tests on purpose: the
 * behaviour lives in a Web Worker + ONNX path that does not run under jsdom,
 * and the regression being guarded is "the code path is wired at all",
 * which a source grep pins as reliably as a mock would.
 */

const read = (p: string) => readFileSync(p, "utf8");

const SERVICES = read("src/services.ts");
const CLIENT = read("src/ai/semantic/semantic-client.ts");
const CONDITIONING = read("src/intent/semantic-conditioning.ts");
const PARSER = read("src/intent/text-parser.ts");
const PROVIDER = read("src/intent/providers/symbolic.ts");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fix A — the model is warmed at boot", () => {
  it("the client exports a warmSemanticModel helper", () => {
    expect(CLIENT).toContain("export function warmSemanticModel");
  });

  it("the helper defers so the worker spawn never blocks the boot turn", () => {
    const body = CLIENT.slice(CLIENT.indexOf("export function warmSemanticModel"));
    expect(body.slice(0, 400)).toContain("setTimeout");
  });

  it("the helper embeds a throwaway sentence to force the load", () => {
    const body = CLIENT.slice(CLIENT.indexOf("export function warmSemanticModel"));
    expect(body.slice(0, 500)).toMatch(/embedTexts\(/);
  });

  it("the helper swallows every failure (fire-and-forget, boot never blocks)", () => {
    const body = CLIENT.slice(CLIENT.indexOf("export function warmSemanticModel"));
    expect(body.slice(0, 700)).toMatch(/\.catch\(|\(\) => undefined/);
  });

  it("createCoreServices calls it, so the load overlaps project opening", () => {
    expect(SERVICES).toContain("warmSemanticModel()");
  });

  it("services.ts imports the helper from the semantic client, not from curated", () => {
    // A wrong-module import is the exact failure this pin catches: the first
    // patch put it in the curated import and it would not have compiled.
    expect(SERVICES).toMatch(/import \{ warmSemanticModel \} from ".\/ai\/semantic\/semantic-client"/);
    expect(SERVICES).not.toMatch(/import \{[^}]*warmSemanticModel[^}]*\} from ".\/sample-library\/curated"/);
  });
});

describe("fix B — the template fallback is named, not silent", () => {
  it("the provider records a failure when drums skip the prior entirely", () => {
    expect(PROVIDER).toContain("drums-template-");
  });

  it("the tag distinguishes a vocab miss from an unavailable semantic channel", () => {
    // These are two different problems: a missing one-hot id is a coverage
    // gap, a null semantic vector is an availability problem. Collapsing them
    // into one string would hide which one to fix.
    expect(PROVIDER).toContain("semantic-unavailable");
    expect(PROVIDER).toContain("prior-vocab-miss");
  });

  it("the tag is emitted BEFORE the prior gate, so the skip is not missed", () => {
    const tagged = PROVIDER.indexOf("drums-template-");
    const gate = PROVIDER.indexOf("if (pads.length > 0 && (supportsDrumPrior || semantic)) {");
    expect(tagged).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    expect(tagged).toBeLessThan(gate);
  });

  it("the escape hatch itself is unchanged — semantic still opens the gate", () => {
    // The fix must make the fallback VISIBLE, not less likely: the gate that
    // lets the v3 channel serve out-of-vocab grooves has to stay open.
    expect(PROVIDER).toContain("if (pads.length > 0 && (supportsDrumPrior || semantic)) {");
  });
});

describe("fix C — the semantic channel is primed at parse time", () => {
  it("the conditioning module exports a priming helper", () => {
    expect(CONDITIONING).toContain("export function primeSemanticForText");
  });

  it("parseIntentText primes, so the load starts before the candidate bank is built", () => {
    expect(PARSER).toContain("primeSemanticForText");
  });

  it("the parser reaches it through a LAZY import, not a static one", () => {
    // A static import would drag the semantic client into the landing
    // route's static closure, which the client is explicitly built to avoid.
    expect(PARSER).toMatch(/void import\("\.\/semantic-conditioning"\)/);
    expect(PARSER).not.toMatch(/^import .*semantic-conditioning/m);
  });

  it("the lazy import is failure-tolerant", () => {
    const idx = PARSER.indexOf('void import("./semantic-conditioning")');
    expect(idx).toBeGreaterThan(-1);
    expect(PARSER.slice(idx, idx + 220)).toContain(".catch");
  });

  it("priming is fire-and-forget and never awaited by the parser", () => {
    const idx = PARSER.indexOf('void import("./semantic-conditioning")');
    const segment = PARSER.slice(idx, idx + 220);
    expect(segment).toContain(".then");
    expect(segment).not.toMatch(/await\s+import\("\.\/semantic-conditioning"\)/);
  });

  it("an empty prompt does not start a pointless worker spawn", () => {
    const body = CONDITIONING.slice(CONDITIONING.indexOf("export function primeSemanticForText"));
    expect(body.slice(0, 300)).toMatch(/if \(!trimmed\) return/);
  });
});

describe("all three fixes stay independent", () => {
  it("the provider still calls semanticConditioningForIntent on the normal path", () => {
    // Priming is a head start, not a replacement. If the provider stopped
    // asking, a primed cache would become a correctness dependency and a
    // cleared cache would silently disable the v3 channel.
    expect(PROVIDER).toContain("semanticConditioningForIntent");
  });

  it("the projection cache is still keyed on the text, so a primed entry is reusable", () => {
    expect(CONDITIONING).toContain("projectionCache.set(cacheKey, result)");
  });
});
