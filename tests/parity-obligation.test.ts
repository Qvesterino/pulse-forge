import { describe, expect, it } from "vitest";
import {
  PARITY_FX_EXCLUSIONS,
  PARITY_INSTRUMENT_EXCLUSIONS,
  PARITY_ALIGN_TOLERANCE,
  PARITY_NULL_FLOOR_DB,
  parityFxCorpus,
  parityInstrumentCorpus,
  parityObligationCheck,
  parityObligations,
} from "../src/testing/live-offline-parity";
import { EFFECT_ORDER } from "../src/effects/registry";
import { INSTRUMENT_ORDER } from "../src/instruments/registry";

/**
 * Live↔offline parity obligation (release-gate hardening).
 *
 * The real-audio null test runs in the browser gate; this suite is the part
 * that can run on every commit. It enforces the OBLIGATION: a registry
 * member cannot be added (or silently removed from the corpus) without an
 * explicit parity decision. Without this, "invariant #3" is a comment again.
 */
describe("live↔offline parity obligation", () => {
  it("every effect is null-tested or explicitly excluded with a reason", () => {
    const { uncoveredFx } = parityObligations();
    expect(
      uncoveredFx,
      `these effects need a parity decision (add to the corpus or PARITY_FX_EXCLUSIONS with a reason): ${uncoveredFx.join(", ")}`,
    ).toEqual([]);
  });

  it("every instrument is null-tested or explicitly excluded with a reason", () => {
    const { uncoveredInstruments } = parityObligations();
    expect(
      uncoveredInstruments,
      `these instruments need a parity decision: ${uncoveredInstruments.join(", ")}`,
    ).toEqual([]);
  });

  it("the corpus is registry-derived and non-empty", () => {
    const fx = parityFxCorpus();
    const instruments = parityInstrumentCorpus();
    expect(fx.length).toBeGreaterThan(0);
    expect(instruments.length).toBeGreaterThan(0);
    // Corpus ∪ exclusions === the full registry (no drift by construction).
    expect(new Set([...fx, ...PARITY_FX_EXCLUSIONS.keys()])).toEqual(new Set(EFFECT_ORDER));
    expect(new Set([...instruments, ...PARITY_INSTRUMENT_EXCLUSIONS.keys()])).toEqual(new Set(INSTRUMENT_ORDER));
  });

  it("every exclusion carries a non-empty, specific reason", () => {
    for (const [key, reason] of [...PARITY_FX_EXCLUSIONS, ...PARITY_INSTRUMENT_EXCLUSIONS]) {
      expect(reason.length, `${key} exclusion needs a reason`).toBeGreaterThan(8);
      // A reason must not be a placeholder — the whole point is a real decision.
      expect(reason.toLowerCase(), `${key} reason looks like a placeholder`).not.toMatch(/^(todo|tbd|n\/a|skip)$/);
    }
  });

  it("the browser check reports the same obligation outcome", () => {
    const result = parityObligationCheck();
    expect(result.ok, result.message).toBe(true);
    expect(result.message).toContain("fx=");
    expect(result.message).toContain("instruments=");
  });

  it("documents its own thresholds (alignment and null floor)", () => {
    expect(PARITY_NULL_FLOOR_DB).toBeLessThan(0);
    expect(PARITY_ALIGN_TOLERANCE).toBeGreaterThan(0);
  });
});
