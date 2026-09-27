import { describe, expect, it } from "vitest";
import { parseIntentText } from "../src/intent/text-parser";
import { normalizeIntent } from "../src/intent/normalize";

describe("intent probe 2 (temp)", () => {
  const prompts = ["Overmono x Future Garage", "Duskus x Fred again x house", "duskus", "future garage"];
  for (const prompt of prompts) {
    it(prompt, () => {
      const { input, detected } = parseIntentText(prompt);
      const spec = normalizeIntent(input);
      console.log(
        JSON.stringify(
          {
            prompt,
            detected,
            genre: spec.genre,
            style: spec.style,
            mood: spec.mood,
            energy: spec.energy,
            bpm: spec.bpmRange,
          },
          null,
          0,
        ),
      );
      expect(true).toBe(true);
    });
  }
});
