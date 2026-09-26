import { describe, it, expect } from "vitest";
import { parseIntentText } from "../src/intent/text-parser";

describe("probe", () => {
  it("finds the house leak", () => {
    for (const text of [
      "jump up dnb at 174",
      "drumfunk rollers",
      "techstep pressure",
      "darkstep tearout",
      "ragga jungle with vocals",
      "halftime dnb",
      "minimal dnb roller",
      "deep drum and bass",
    ]) {
      const parsed = parseIntentText(text);
      console.log(JSON.stringify(text), "->", parsed.input.genre, "/", parsed.input.style);
      expect(true).toBe(true);
    }
  });
});
