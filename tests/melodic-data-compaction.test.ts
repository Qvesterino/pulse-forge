import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * MELODIC DATA COMPACTION GATE (Package 4, 2026-10-17)
 *
 * Closes the class this session hit for real: the compaction tool appended a
 * SECOND `decodeMelodicSequences` import because it never checked for an
 * existing one — an ESM SyntaxError that vite's transform happened to tolerate
 * while node/tsx consumers (the MCP mirror generator) could not load the file
 * at all. The data file's contract is narrow and worth pinning:
 *
 *   1. exactly ONE decoder import,
 *   2. ZERO raw `velocity:` literals — melody rows live as compact codes
 *      authored through the codec, whose palette must cover every value
 *      (a raw literal means someone bypassed the contract),
 *   3. the codec's palette still fits the two-character alphabet
 *      (degrees × durations × velocities ≤ 64² = 4096), the capacity bound
 *      that made widening possible without changing the wire format.
 */

const DATA_PATH = "src/ai/grooves/melodic-data.ts";
const CODEC_PATH = "src/ai/grooves/melodic-codec.ts";

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

/** Pure checks — exported shape testable against bogus bodies. */
export function validateDataFile(text: string): string[] {
  const errors: string[] = [];
  const imports = countMatches(text, /import \{ decodeMelodicSequences \} from "\.\/melodic-codec";/g);
  if (imports !== 1) errors.push(`expected exactly 1 decoder import, found ${imports}`);
  const rawVelocities = countMatches(text, /velocity:/g);
  if (rawVelocities > 0) {
    errors.push(
      `${rawVelocities} raw velocity literal(s) — run the compactor: node scripts/compact-melodic-data.mjs --write`,
    );
  }
  return errors;
}

export function paletteCapacity(codec: string): {
  degrees: number;
  durations: number;
  velocities: number;
  count: number;
} {
  const degrees = /const MELODIC_DEGREES = \[([^\]]*)\]/.exec(codec)?.[1] ?? "";
  const durations = /const MELODIC_DURATIONS = \[([^\]]*)\]/.exec(codec)?.[1] ?? "";
  const velocities = /const MELODIC_VELOCITIES = \[([\s\S]*?)\]/.exec(codec)?.[1] ?? "";
  const count = (list: string) => list.split(",").filter((entry) => entry.trim().length > 0).length;
  const d = count(degrees);
  const u = count(durations);
  const v = count(velocities);
  return { degrees: d, durations: u, velocities: v, count: d * u * v };
}

describe("melodic data compaction gate", () => {
  it("the shipped data file keeps the compactor's contract", () => {
    const text = readFileSync(resolve(__dirname, "..", DATA_PATH), "utf8");
    expect(validateDataFile(text)).toEqual([]);
  });

  it("the codec palette stays inside the two-character alphabet (≤ 4096 codes)", () => {
    const codec = readFileSync(resolve(__dirname, "..", CODEC_PATH), "utf8");
    const capacity = paletteCapacity(codec);
    expect(capacity.degrees).toBeGreaterThan(0);
    expect(capacity.velocities).toBeGreaterThan(0);
    expect(
      capacity.count,
      `palette ${capacity.degrees}×${capacity.durations}×${capacity.velocities} exceeds the 64² alphabet — widening needs a wire-format migration`,
    ).toBeLessThanOrEqual(4096);
  });

  it("NEGATIVE: the validators catch the duplicate import and a raw literal", () => {
    const duplicateImport =
      'import { decodeMelodicSequences } from "./melodic-codec";\n' +
      'import { decodeMelodicSequences } from "./melodic-codec";\n' +
      "export const X = 1;\n";
    expect(validateDataFile(duplicateImport).some((error) => error.includes("exactly 1 decoder import"))).toBe(true);
    const rawLiteral =
      'import { decodeMelodicSequences } from "./melodic-codec";\nsequences: [[{ degree: 0, duration: 2, velocity: 0.58 }]]\n';
    expect(validateDataFile(rawLiteral).some((error) => error.includes("raw velocity literal"))).toBe(true);
  });
});
