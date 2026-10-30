import { describe, expect, it } from "vitest";
import { parseIntentText } from "../src/intent/text-parser";

describe("natural language pattern preservation", () => {
  it.each([
    "vytvor novú basu, bicie nechaj tak",
    "vygeneruj basu, zachovaj bicie",
    "generate bass, don't change drums",
    "generate bass, do not touch drums",
  ])("protects drums for %s", (text) => {
    const parsed = parseIntentText(text);
    expect(parsed.input.preserve).toContain("drums");
    expect(parsed.input.roles).toContain("bass");
    expect(parsed.input.roles).not.toContain("drums");
  });

  it("does not extend an English preserve clause backward across punctuation", () => {
    const parsed = parseIntentText("generate bass, keep drums");
    expect(parsed.input.preserve).toEqual(["drums"]);
  });

  it("does not treat a negated preserve clause as protection", () => {
    expect(parseIntentText("keep bass out, dark techno").input.preserve).toBeUndefined();
  });
});
