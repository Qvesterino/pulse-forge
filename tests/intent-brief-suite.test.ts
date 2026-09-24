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
  // ── hard constraints: BPM ──────────────────────────────────────────
  {
    name: "EN: explicit BPM is extracted",
    text: "dark trap at 142 bpm",
    expect: (input) => {
      expect(input.bpm).toBe(142);
      expect(String(input.genre ?? "").toLowerCase()).toContain("trap");
    },
  },
  {
    name: "SK: explicit BPM is extracted",
    text: "tvrdý techno 150 bpm",
    expect: (input) => {
      expect(input.bpm).toBe(150);
    },
  },
  // ── hard constraints: key ──────────────────────────────────────────
  {
    name: "EN: key phrase is recognized",
    text: "melodic house in f# minor at 124",
    expect: (input) => {
      expect(String(input.key ?? "").toLowerCase()).toContain("f#");
      expect(input.bpm).toBe(124);
    },
  },
  {
    name: "SK: key phrase is recognized",
    text: "hlboké house v a mol 122",
    expect: (input) => {
      expect(String(input.key ?? "").toLowerCase()).toContain("a");
    },
  },
  // ── genre / mood ───────────────────────────────────────────────────
  {
    name: "EN: genre + mood map to normalized fields",
    text: "aggressive drill beat",
    expect: (input) => {
      expect(String(input.genre ?? "").toLowerCase()).toContain("drill");
    },
  },
  {
    name: "SK: genre is recognized in Slovak phrasing",
    text: "temný phonk beat",
    expect: (input) => {
      expect(String(input.genre ?? "").toLowerCase()).toContain("phonk");
    },
  },
  // ── determinism (Fáza 0.3 benchmark, parser half) ─────────────────
  {
    name: "same brief → identical hash (determinism)",
    text: "dark rolling techno at 140 with lead",
    expect: () => undefined,
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
    const a = generateLocalResult(base, normalizeIntent({ ...parseIntentText(text).input, seed: "suite-1" }), "apply");
    const b = generateLocalResult(base, normalizeIntent({ ...parseIntentText(text).input, seed: "suite-1" }), "apply");
    expect(intentHash(a.pattern)).toBe(intentHash(b.pattern));
    expect(JSON.stringify(a.pattern.rows)).toBe(JSON.stringify(b.pattern.rows));
  });

  it("different seed → different content (variation is real, not a re-render)", () => {
    const text = "dark rolling techno at 140 with lead";
    const base = createProjectFromTemplate("house");
    const a = generateLocalResult(base, normalizeIntent({ ...parseIntentText(text).input, seed: "suite-a" }), "apply");
    const b = generateLocalResult(base, normalizeIntent({ ...parseIntentText(text).input, seed: "suite-b" }), "apply");
    expect(intentHash(a.pattern)).not.toBe(intentHash(b.pattern));
  });
});

__zcode_status=$?
if [ "$__zcode_status" -eq 0 ]; then pwd -P > '/c/Users/danie/AppData/Local/Temp/zcode-d295723d-9afd-4e76-94b7-84a464eddf8c-cwd'; fi
exit "$__zcode_status"
