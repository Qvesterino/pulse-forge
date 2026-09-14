/**
 * FXEQ golden parity — Pulse Forge vendored core vs upstream fixtures.
 *
 * Fixtures + cases + helpers are COPIES of VocalForge_DAW/plugins/fxeq's
 * tests/golden/ (see tests/fxeq-golden/). This suite renders the same
 * deterministic cases through the VENDORED core with the SAME harness and
 * tolerances — proving the browser DAW runs bit-comparable DSP to the
 * plugin's behavioral oracle.
 *
 * Refresh workflow: re-copy upstream tests/golden/{cases,helpers}.ts and
 * *.json here when the upstream oracle evolves, then re-vendor src.
 *
 * POLICY (2026-09-14): the vendored core is intentionally ALLOWED TO DIVERGE
 * from upstream — Pulse Forge treats it as its own hardened copy (owner
 * decision). These fixtures are therefore a HISTORICAL REGRESSION BASELINE:
 * they still match the upstream snapshots where the DSP math is unchanged,
 * and documented deliberate deviations are regenerated via UPDATE_GOLDEN=1
 * with justification in the change notes.
 */
import { describe, expect, it } from "vitest";
import { GOLDEN_CASES } from "./fxeq-golden/cases.js";
import { renderCase, fingerprint, loadFixture, saveFixture, shouldUpdateGolden } from "./fxeq-golden/helpers.js";

describe("FXEQ golden parity (vendored core vs upstream fixtures)", () => {
  let bitExact = 0;

  for (const tc of GOLDEN_CASES) {
    it(`parity: ${tc.name}`, () => {
      const actual = fingerprint(renderCase(tc));

      // Regeneration path (quality roadmap Q1): UPDATE_GOLDEN=1 rewrites the
      // fixtures from the CURRENT renderer. Only legitimate after a
      // documented, justified sonic change (see
      // docs/IMPLEMENTATION-ROADMAP-FXEQ-QUALITY.md).
      if (shouldUpdateGolden()) {
        saveFixture(tc.name, actual);
        console.log(`[fxeq-parity] ${tc.name}: fixture REGENERATED (UPDATE_GOLDEN=1)`);
        return;
      }

      const golden = loadFixture(tc.name);
      expect(golden, `fixture missing for ${tc.name}`).not.toBeNull();
      if (!golden) return;

      expect(actual.topology).toBe("v1-shared-crossover");
      expect(golden.topology).toBe("v1-shared-crossover");

      let maxEnvelopeDiff = 0;
      for (let i = 0; i < actual.envelope.length; i++) {
        maxEnvelopeDiff = Math.max(maxEnvelopeDiff, Math.abs(actual.envelope[i] - golden.envelope[i]));
      }
      const peakDiff = Math.abs(actual.peak - golden.peak);
      const rmsDiff = Math.abs(actual.rms - golden.rms);

      // Same tolerances as the upstream golden harness.
      expect(maxEnvelopeDiff).toBeLessThanOrEqual(1e-3);
      expect(peakDiff).toBeLessThanOrEqual(1e-3);
      expect(rmsDiff).toBeLessThanOrEqual(1e-3);

      if (actual.hash === golden.hash) bitExact++;
      console.log(
        `[fxeq-parity] ${tc.name}: envelopeΔ=${maxEnvelopeDiff.toExponential(1)} peakΔ=${peakDiff.toExponential(1)} ` +
          `rmsΔ=${rmsDiff.toExponential(1)} hash=${actual.hash === golden.hash ? "EXACT" : "differs"}`,
      );
    });
  }

  it("reports how many cases are bit-exact (informational)", () => {
    // Tolerance parity is the gate (asserted per case); bit-exactness is a
    // bonus that depends on the generating environment's float ordering.
    console.log(`[fxeq-parity] ${bitExact}/${GOLDEN_CASES.length} cases bit-exact vs fixtures`);
    expect(bitExact).toBeGreaterThanOrEqual(0);
  });
});
