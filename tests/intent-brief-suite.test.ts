import { describe, expect, it } from "vitest";
import { parseIntentText } from "../src/intent/text-parser";
import { normalizeIntent } from "../src/intent/normalize";
import { generateLocalResult } from "../src/intent/pipeline";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { intentHash } from "../src/intent/hash";

/**
 * AUDIT (AI-first producer, Fáza 0.2+0.3): curated SK+EN brief suite.
 *
 * Every case asserts the CONTRACT LAYER (normalized IntentInput), not raw
 * regex spans — the parser internals may be refactored as long as the
 * interpreted contract stays stable. Categories are kept separate per the
 * Fáza 0 spec: interpretation correctness here; hard-constraint satisfaction
 * and determinism via generateLocalResult; NOT a single "AI quality" score.
 */

interface BriefCase {
  /** Short label for the failure message. */
  name: string;
  text: string;
  /** Assertions on the normalized input (the interpreted contract). */
  expect: (input: ReturnType<typeof normalizeIntent>, detected: string[]) => void;
}

const CASES: BriefCase[] = [
  {
    name: "EN: explicit BPM is extracted",
    text: "dark trap at 142 bpm",
    expect: (input) => {
      expect(input.genre).toBe("trap");
      expect(input.bpmRange?.[0]).toBe(142);
      expect(input.bpmRange?.[1]).toBe(142);
    },
  },
  {
    name: "SK: explicit BPM is extracted",
    text: "tvrdý techno 150 bpm",
    expect: (input) => {
      expect(String(input.genre)).toContain("techno");
      expect(input.bpmRange?.[1]).toBe(150);
    },
  },
  {
    name: "EN: key phrase is recognized",
    text: "melodic house in f# minor at 124",
    expect: (input) => {
      expect(String(input.key ?? "").toLowerCase()).toContain("f#");
      expect(input.bpmRange?.[1]).toBe(124);
    },
  },
  {
    name: "SK: key phrase is recognized",
    text: "hlboké house v a mol pri 122",
    expect: (input) => {
      expect(String(input.key ?? "").toLowerCase()).toContain("a");
      expect(input.bpmRange?.[1]).toBe(122);
    },
  },
  {
    name: "EN: drill genre is recognized",
    text: "aggressive drill beat",
    expect: (input) => {
      expect(input.genre).toBe("drill");
      expect(input.energy).toBeGreaterThan(0.5);
    },
  },
  {
    name: "SK: phonk genre is recognized in Slovak phrasing",
    text: "temný phonk beat",
    expect: (input) => {
      expect(String(input.genre)).toContain("phonk");
    },
  },
];

describe("AI-first producer — SK/EN brief suite (Fáza 0)", () => {
  for (const brief of CASES) {
    it(`interpret: ${brief.name}`, () => {
      const parsed = parseIntentText(brief.text);
      const input = normalizeIntent(parsed.input);
      brief.expect(input, parsed.detected);
    });
  }

  it("determinism: identical brief+seed → identical hash and content", () => {
    const text = "dark rolling techno at 140 with lead";
    const base = createProjectFromTemplate("house");
    const input = normalizeIntent({ ...parseIntentText(text).input, seed: "suite-1" });
    const a = generateLocalResult(base, input, "apply");
    const b = generateLocalResult(base, input, "apply");
    expect(intentHash(a.plan.intent)).toBe(intentHash(b.plan.intent));
    expect(a.proposal).toBeDefined();
    expect(JSON.stringify(a.proposal?.pattern.rows)).toBe(JSON.stringify(b.proposal?.pattern.rows));
  });

  it("different seed → different content (variation is real, not a re-render)", () => {
    const text = "dark rolling techno at 140 with lead";
    const base = createProjectFromTemplate("house");
    const a = generateLocalResult(base, normalizeIntent({ ...parseIntentText(text).input, seed: "suite-a" }), "apply");
    const b = generateLocalResult(base, normalizeIntent({ ...parseIntentText(text).input, seed: "suite-b" }), "apply");
    expect(intentHash(a.plan.intent)).not.toBe(intentHash(b.plan.intent));
  });
});
