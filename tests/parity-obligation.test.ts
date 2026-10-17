import { describe, expect, it } from "vitest";
import {
  PARITY_FX_EXCLUSIONS,
  PARITY_INSTRUMENT_EXCLUSIONS,
  PARITY_ALIGN_TOLERANCE,
  PARITY_NULL_FLOOR_DB,
  comparePhaseInsensitiveParity,
  phaseInsensitiveParityAgrees,
  parityFxCorpus,
  parityInstrumentCorpus,
  parityObligationCheck,
  parityObligations,
} from "../src/testing/live-offline-parity";
import { EFFECT_ORDER } from "../src/effects/registry";
import { INSTRUMENT_ORDER } from "../src/instruments/registry";

function tone(frequency: number, phase = 0, amplitude = 0.3, sampleRate = 44100): Float32Array {
  const samples = new Float32Array(sampleRate);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate + phase);
  }
  return samples;
}

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

  it("accepts a phase-shifted oscillator spectrum without masking changed pitch or level", () => {
    const reference = tone(220);
    const phaseShifted = comparePhaseInsensitiveParity(reference, tone(220, 1.25), 0, 44100);
    expect(phaseShifted.windows).toBeGreaterThanOrEqual(8);
    expect(phaseShifted.spectralCosine).toBeGreaterThanOrEqual(0.98);
    expect(phaseShifted.rmsRatio).toBeGreaterThanOrEqual(0.9);
    expect(phaseShifted.rmsRatio).toBeLessThanOrEqual(1.1);

    const changedPitch = comparePhaseInsensitiveParity(reference, tone(440, 0.5), 0, 44100);
    expect(changedPitch.spectralCosine).toBeLessThan(0.98);

    const changedLevel = comparePhaseInsensitiveParity(reference, tone(220, 0.5, 0.6), 0, 44100);
    expect(changedLevel.spectralCosine).toBeGreaterThanOrEqual(0.98);
    expect(changedLevel.rmsRatio).toBeGreaterThan(1.1);
    expect(phaseInsensitiveParityAgrees(phaseShifted, phaseShifted, phaseShifted, -76)).toBe(true);
    expect(phaseInsensitiveParityAgrees(changedPitch, phaseShifted, phaseShifted, -76)).toBe(false);
    expect(phaseInsensitiveParityAgrees(phaseShifted, phaseShifted, phaseShifted, -30)).toBe(false);
    expect(phaseInsensitiveParityAgrees(phaseShifted, phaseShifted, { ...phaseShifted, rmsRatio: 0.89 }, -76)).toBe(
      false,
    );
    expect(phaseInsensitiveParityAgrees(phaseShifted, phaseShifted, null, -76)).toBe(false);
  });
});
