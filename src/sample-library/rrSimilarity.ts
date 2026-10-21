/**
 * Round-robin variant similarity — the metric for "is this variation the SAME
 * drum as the base it claims to vary?".
 *
 * WHY THIS EXISTS — the browser verifier used to answer that question with
 * SAMPLE-PHASE correlation (dot / |a||b|) and a 0.7 threshold. That metric is
 * wrong for a round-robin variant, and the repository already says so:
 *
 *   src/audio-engine/artifactGate.ts — "a round-robin variant is a resampled
 *   copy (rate 1.018), so by the end of a 150 ms hit the phase has drifted
 *   ~180° and sample correlation collapses to ~0.1 even though the two hits
 *   are audibly the same drum. The LOG envelope is phase-blind."
 *
 * MEASURED 2026-10-25 on the real bank (26 round-robin bases, synth and
 * curated):
 *
 *   sample-phase correlation   10 of 26 bases fail BEFORE the curated layer
 *                              even loads — hats and shakers read −0.05…0.02,
 *                              because broadband content decorrelates under a
 *                              resample. 19 of 26 fail after it.
 *   log-envelope correlation   0 of 26 fail, minimum 0.99996 (synth 0.99952).
 *
 * So the old gate could never go green: it reported a defect that the metric
 * itself manufactured, and it did that on the SYNTH bank — before the
 * curated layer it was written to police had even loaded.
 *
 * The metric still has to be able to FAIL, which is the other half of the
 * contract. A stale variant — one derived from a different base than the one
 * the bank currently holds — is exactly what the check is for. Measured on
 * the real pairs (synth base vs the curated base that replaced it): the
 * log-envelope correlation falls to 0.696–0.975, and 22 of 24 such pairs sit
 * below the 0.95 threshold used here. The phase-blind metric therefore both
 * stops the false alarm AND still catches the real defect.
 *
 * WHAT IT DOES NOT PROVE: the metric separates "a different character" (a
 * mastered recording against a synth fallback — the real stale case), not
 * "the same character rendered differently". Two hits that differ only in
 * their DECAY CONSTANT keep an almost identical falling envelope and stay
 * above the threshold (measured 0.998 on synthetic pairs). So this check
 * proves the round-robin set was re-derived from the current base's CHARACTER
 * — it does not prove bit-exact derivation.
 */
import { logEnvelopeCorrelation } from "../audio-engine/artifactGate";

/**
 * The floor for "this variation still IS the base it varies".
 *
 * A fresh variant measures ≥ 0.9999; a stale one measures ≤ 0.975 and 22 of
 * 24 measured stale pairs fall below 0.95. The threshold sits in the empty
 * band between the two populations, not on either side of them.
 */
export const RR_VARIANT_MIN_CORRELATION = 0.95;

/**
 * How similar a round-robin variant is to its base, phase-blind.
 *
 * 1.0 = the same hit; ≈0.9999 = a fresh micro-variant; below 0.95 = a
 * variant derived from a DIFFERENT base (a stale round-robin set).
 */
export function rrVariantCorrelation(base: Float32Array, variant: Float32Array): number {
  return logEnvelopeCorrelation(base, variant);
}

/**
 * Is this round-robin variant stale — derived from a base the bank no longer
 * holds? A stale variant means the bank alternates between two different
 * drums instead of one drum with micro-variation.
 */
export function rrVariantIsStale(base: Float32Array, variant: Float32Array): boolean {
  return rrVariantCorrelation(base, variant) < RR_VARIANT_MIN_CORRELATION;
}
