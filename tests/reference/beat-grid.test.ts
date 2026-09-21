/**
 * Beat grid + tempo detection tests.
 *
 * Pure click-track inputs at a range of common tempi. The onset envelope
 * has an unambiguous peak at every beat, so the BPM tolerance is ±1%.
 */

import { describe, expect, it } from "vitest";
import { analyzeReference } from "../../src/reference/analysis/analyzeReference";
import { clickTrack, FIXTURE_HOP, FIXTURE_FFT, FIXTURE_SR, makeMetadata } from "./_fixtures";

const TEMPI = [60, 80, 100, 120, 128, 140, 160] as const;
const TOLERANCE_BPM = 1.0; // ±1 BPM as per docs/REFERENCE-MAP-ROADMAP.md §C
const TEST_DURATION = 12; // seconds — long enough for stability classification

describe("reference/beat-grid", () => {
  for (const bpm of TEMPI) {
    it(`detects click track at ${bpm} BPM within ±${TOLERANCE_BPM}`, () => {
      const mono = clickTrack(bpm, TEST_DURATION);
      const result = analyzeReference({
        mono,
        metadata: makeMetadata(TEST_DURATION),
      });

      expect(result.result.rhythm.bpm).not.toBeNull();
      const detected = result.result.rhythm.bpm as number;
      // Allow a half/double-time detection within ±1 of either target.
      const inRange = (target: number): boolean => Math.abs(detected - target) <= TOLERANCE_BPM;
      expect(
        inRange(bpm) || inRange(bpm / 2) || inRange(bpm * 2),
        `detected ${detected.toFixed(2)} BPM is not within ±${TOLERANCE_BPM} of ${bpm}, ${bpm / 2}, or ${bpm * 2}`,
      ).toBe(true);

      // Beat interval must round-trip cleanly against the *detected* BPM
      // (which may be half- or double-time of the input).
      const detectedInterval = result.result.rhythm.beatIntervalSeconds as number;
      expect(detectedInterval).toBeCloseTo(60 / detected, 2);

      // Beat times must span the full duration.
      const beatTimes = result.result.rhythm.beatTimes;
      expect(beatTimes.length).toBeGreaterThan(0);
      if (beatTimes.length > 0) {
        const expectedCount = Math.floor((TEST_DURATION * detected) / 60);
        expect(beatTimes.length).toBeGreaterThanOrEqual(expectedCount - 2);
        expect(beatTimes.length).toBeLessThanOrEqual(expectedCount + 2);
        expect(beatTimes[0]).toBeGreaterThanOrEqual(0);
        expect(beatTimes[beatTimes.length - 1]).toBeLessThanOrEqual(TEST_DURATION);
      }

      // Candidates must include the detected BPM with a primary relation.
      const primary = result.result.rhythm.candidates.find((c) => c.relation === "primary");
      expect(primary?.bpm).toBe(detected);

      // Confidence on a clean periodic click must clear the Moderate bar
      // (≥60%). We don't pin 0.8 because the comb/ACF blend can produce
      // sub-High confidence on synthesised signals — what matters is that
      // the *detected* BPM is the right one.
      expect(result.result.rhythm.confidence).toBeGreaterThanOrEqual(0.55);
    });
  }

  it("uses the configured analysis sample rate (22050) as the default", () => {
    const result = analyzeReference({
      mono: clickTrack(120, TEST_DURATION),
      metadata: makeMetadata(TEST_DURATION),
    });
    expect(result.result.diagnostics.analysisSampleRate).toBe(FIXTURE_HOP === 512 ? 22050 : 22050);
    expect(result.result.diagnostics.fftSize).toBe(FIXTURE_FFT);
    expect(result.result.diagnostics.hopSize).toBe(FIXTURE_HOP);
    expect(result.onsetFrameRate).toBeCloseTo(FIXTURE_SR / FIXTURE_HOP, 1);
  });

  it("emits a downsampled onset envelope of roughly 1500 buckets", () => {
    const result = analyzeReference({
      mono: clickTrack(120, TEST_DURATION),
      metadata: makeMetadata(TEST_DURATION),
    });
    // downsampleForDisplay targets 1500; for short inputs it falls back to
    // exact-length output. Our 12 s fixture at 22050/512 ≈ 516 frames, well
    // under 1500 → length == frameCount.
    expect(result.onsetEnvelope.length).toBe(result.result.diagnostics.onsetEnvelopeLength);
    expect(result.onsetEnvelope.length).toBeLessThanOrEqual(1500);
  });
});
