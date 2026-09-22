import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFamilies, canonicalize, type GoldenCase } from "./domain-goldens/harness";

/**
 * GOAL 06 — domain parity replay.
 *
 * Recomputes every golden family through the shared harness and compares
 * against the committed fixtures in `tests/domain-goldens/*.json`. A diff
 * means observable domain behavior changed — either a regression, or an
 * intentional change that must be re-captured (`npm run goldens:capture`)
 * and reviewed like code, because these fixtures are the parity contract
 * a future platform implementation proves itself against.
 */

const GOLDEN_DIR = resolve(process.cwd(), "tests/domain-goldens");
const DECODE_FILE = resolve(GOLDEN_DIR, "decode-goldens.json");

const decodeGoldens = existsSync(DECODE_FILE)
  ? ((JSON.parse(readFileSync(DECODE_FILE, "utf8")) as { pins: Array<{ label: string; code: string }> }).pins ?? [])
  : [];

const families = buildFamilies(decodeGoldens);

describe.each(families.map((f) => [f.file, f] as const))("domain goldens: %s", (_file, family) => {
  const path = resolve(GOLDEN_DIR, family.file);

  it("fixture exists (run `npm run goldens:capture` after intentional changes)", () => {
    expect(existsSync(path), `${family.file} missing`).toBe(true);
  });

  it("replays every case to the committed expected output", () => {
    if (!existsSync(path)) return; // reported by the guard above
    const fixture = JSON.parse(readFileSync(path, "utf8")) as {
      meta: Record<string, string>;
      cases: Array<{ name: string; operation: string; input: unknown; expected: unknown }>;
    };
    expect(fixture.cases.map((c) => c.name)).toEqual(family.cases.map((c) => c.name));
    for (let i = 0; i < family.cases.length; i++) {
      const computed = canonicalize(family.cases[i]!) as GoldenCase;
      expect(computed.expected, `case "${family.cases[i]!.name}" drifted`).toEqual(fixture.cases[i]!.expected);
      expect(computed.input).toEqual(fixture.cases[i]!.input);
    }
  });
});
