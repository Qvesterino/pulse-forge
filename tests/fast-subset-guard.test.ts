import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FAST_SUBSET, FAST_SUBSET_MAX_FILES } from "../src/testing/fast-subset";

/**
 * Fast-subset guard (DAW audit 12 → release-gate hardening).
 *
 * `npm run test:fast` is the every-commit gate. A curated list rots in one
 * of two ways: a renamed spec path turns an entry into a silent no-op, or
 * the list grows until "fast" is a lie. This guard runs in the FULL suite
 * (not in the subset itself — a guard for the subset is not part of the
 * subset) and fails on either drift.
 */
describe("fast subset integrity", () => {
  it("every entry resolves to a real spec file", () => {
    const missing = FAST_SUBSET.filter((rel) => {
      try {
        readFileSync(resolve(process.cwd(), rel), "utf8");
        return false;
      } catch {
        return true;
      }
    });
    expect(missing, `FAST_SUBSET references missing files: ${missing.join(", ")}`).toEqual([]);
  });

  it("stays a real subset — no duplicates, under the ceiling, non-empty", () => {
    expect(FAST_SUBSET.length).toBeGreaterThan(0);
    expect(FAST_SUBSET.length).toBeLessThanOrEqual(FAST_SUBSET_MAX_FILES);
    expect(new Set(FAST_SUBSET).size).toBe(FAST_SUBSET.length);
  });

  it("covers the load-bearing areas (audio engine, scheduler, model, hostile input)", () => {
    const has = (fragment: string) => FAST_SUBSET.some((rel) => rel.includes(fragment));
    for (const area of ["audio-engine", "scheduler", "project-model", "security/", "boot-graph"]) {
      expect(has(area), `fast subset lost its ${area} coverage`).toBe(true);
    }
  });
});
