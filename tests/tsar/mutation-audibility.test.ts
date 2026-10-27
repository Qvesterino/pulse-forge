import { describe, expect, it } from "vitest";
import { mutateTsarPatch } from "../../src/tsar/mutations";
import { auditParams, renderPatch, audibleDistance } from "./mutation-audit";

/**
 * WAVE 4 — THE AUDIBILITY GATE.
 *
 * The roadmap's criterion: *"Varianty sú odlišné aj zvukovo; iba odlišné
 * číselné hodnoty nie sú dôkazom kvality."* A variant that differs only in
 * its numbers is not a variation — it is a different patch that sounds the
 * same.
 *
 * This gate renders the variants through the REAL TSAR processor and
 * measures the difference in the SOUND. It exists to be doubted, so it
 * carries controls:
 *
 *  - the identity of a patch against itself measures EXACTLY 0;
 *  - a patch that differs only in a SILENT source's parameters also measures
 *    EXACTLY 0 — that is the trap the criterion names, made measurable;
 *  - a patch whose timbre really changed measures far above zero.
 *
 * The mutator's rules (the live-axis rule, the spectrum-independence rule,
 * the inert-value rule) are what turn the "exactly 0" class into an empty
 * class. This gate is what keeps them that way.
 */

/**
 * The floor for a REAL difference at the default range.
 *
 * Measured over 240 variants at range 1 (2026-10-27): the weakest was
 * 0.0083, the tenth percentile 0.165, the median 1.41. The floor sits below
 * the weakest measured variant with a margin of ~1.7x, and it is more than
 * three orders of magnitude above the trap's exact 0.
 */
const REAL_DIFFERENCE_FLOOR = 0.005;

const BASE = auditParams();
const BASE_RENDER = renderPatch(BASE);

describe("the mutation audit — the measure can tell a real difference from a fake one", () => {
  it("a patch against itself measures exactly zero", () => {
    expect(audibleDistance(BASE_RENDER, renderPatch(BASE))).toBe(0);
  });

  it("THE TRAP: a numerically different patch that sounds the same measures zero", () => {
    // Source B is silent at level 0, so its parameters reach no ear. The
    // numbers differ; the sound does not. This is the case the criterion
    // warns about — and the reason the mutator must not spend its budget
    // on a silent source.
    const trap = auditParams({ srcBCutoff: 900, srcBQ: 4, srcBDec: 0.05, srcBMorph: 0.9, srcBAtk: 0.4 });
    expect(trap.srcBCutoff).not.toBe(BASE.srcBCutoff);
    expect(audibleDistance(BASE_RENDER, renderPatch(trap))).toBe(0);
  });

  it("a real change in the timbre measures far above zero", () => {
    const real = auditParams({ srcACutoff: 700, srcAQ: 6 });
    expect(audibleDistance(BASE_RENDER, renderPatch(real))).toBeGreaterThan(0.1);
  });
});

describe("the mutation audit — every variant the mutator offers differs in SOUND", () => {
  it(
    "no variant produces the original's sound, at any range",
    () => {
      for (const range of [1, 0.75, 0.5, 0.25]) {
        for (let seedIndex = 0; seedIndex < 6; seedIndex += 1) {
          const seed = (1_234_567 + seedIndex * 7919) >>> 0;
          for (const variant of mutateTsarPatch(BASE, seed, 6, { range })) {
            const distance = audibleDistance(BASE_RENDER, renderPatch(variant.params));
            expect(
              distance,
              `seed ${seed} ${variant.id} (range ${range}) must not sound like the original`,
            ).toBeGreaterThan(0);
          }
        }
      }
    },
    180_000,
  );

  it(
    "at the default range every variant is a real difference, not a rounding error",
    () => {
      for (let seedIndex = 0; seedIndex < 8; seedIndex += 1) {
        const seed = (1_234_567 + seedIndex * 7919) >>> 0;
        for (const variant of mutateTsarPatch(BASE, seed, 6)) {
          const distance = audibleDistance(BASE_RENDER, renderPatch(variant.params));
          expect(distance, `seed ${seed} ${variant.id} must be a real difference`).toBeGreaterThan(
            REAL_DIFFERENCE_FLOOR,
          );
        }
      }
    },
    180_000,
  );

  it(
    "a patch with BOTH sources audible also produces audible variations",
    () => {
      // The liveness rule follows the patch: with B audible, B's axes join
      // the pool and the variants move further.
      const both = auditParams({ srcBLevel: 0.7, srcBEngine: 1, morph: 0.4 });
      const bothRender = renderPatch(both);
      for (let seedIndex = 0; seedIndex < 4; seedIndex += 1) {
        const seed = (777_000 + seedIndex * 7919) >>> 0;
        for (const variant of mutateTsarPatch(both, seed, 6)) {
          const distance = audibleDistance(bothRender, renderPatch(variant.params));
          expect(distance, `seed ${seed} ${variant.id} must be a real difference`).toBeGreaterThan(
            REAL_DIFFERENCE_FLOOR,
          );
        }
      }
    },
    180_000,
  );
});
