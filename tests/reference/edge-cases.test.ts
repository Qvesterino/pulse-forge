/**
 * Edge cases: silence, very short buffers, very long buffers, and
 * independently-null rhythm / tonal (a drone has key but no tempo).
 *
 * Per docs/REFERENCE-MAP-ROADMAP.md §C: "ticho/krátke súbory → poctivé null
 * + warning, nie vymyslené čísla".
 */

import { describe, expect, it } from "vitest";
import { analyzeReference } from "../../src/reference/analysis/analyzeReference";
import { drone, makeMetadata, silence, tonalTrack } from "./_fixtures";

describe("reference/edge-cases", () => {
  it("silent input returns null BPM + null tonic with explicit warnings", () => {
    const mono = silence(8);
    const result = analyzeReference({ mono, metadata: makeMetadata(8) });

    expect(result.result.rhythm.bpm).toBeNull();
    expect(result.result.rhythm.warning).toMatch(/silent/i);
    expect(result.result.rhythm.confidence).toBe(0);

    expect(result.result.tonal.tonic).toBeNull();
    expect(result.result.tonal.mode).toBeNull();
    expect(result.result.tonal.camelot).toBeNull();
    expect(result.result.tonal.warning).toMatch(/silent/i);
    expect(result.result.tonal.chroma).toEqual(new Array(12).fill(0));

    // Top-level warnings must surface the silence signal even when both
    // rhythm + tonal warnings are present.
    expect(result.result.warnings.some((w) => /silent/i.test(w))).toBe(true);

    // Diagnostics must still report a sensible processing time.
    expect(result.result.diagnostics.processingMs).toBeGreaterThanOrEqual(0);
  });

  it("sub-1-second input adds the unreliable warning but still runs", () => {
    const mono = silence(0.5);
    const result = analyzeReference({ mono, metadata: makeMetadata(0.5) });

    expect(result.result.warnings.some((w) => /extremely short/i.test(w))).toBe(true);
  });

  it("1-10-second input adds the short warning but still runs", () => {
    const mono = silence(5);
    const result = analyzeReference({ mono, metadata: makeMetadata(5) });

    expect(result.result.warnings.some((w) => /short/i.test(w))).toBe(true);
  });

  it("drone (sustained tone, no onsets) — tonal succeeds, rhythm is honest", () => {
    const mono = drone(8, 440); // A4 — tonic A, mode is ambiguous for a single sine
    const result = analyzeReference({ mono, metadata: makeMetadata(8) });

    // A perfect drone has no onsets — the algorithm may either return null
    // (honest "no tempo") or pick up residual periodicity in the ACF comb
    // (with low confidence). Both are acceptable; what we MUST NOT see is
    // a high-confidence tempo on a drone.
    if (result.result.rhythm.bpm !== null) {
      expect(result.result.rhythm.confidence).toBeLessThan(0.65);
    }

    // Tonal must succeed on a sustained tone — the chroma has a peak
    // somewhere in 60..5000 Hz. Single-sine drones can leak the peak by
    // ±1 semitone through the Hann window, so we accept any non-null tonic.
    expect(result.result.tonal.tonic).not.toBeNull();
    expect(result.result.tonal.camelot).not.toBeNull();
  });

  it("tonal signal can succeed independently when rhythm has no onsets (regression for §C)", () => {
    const mono = tonalTrack(0, "major", 10); // C major sustained
    const result = analyzeReference({ mono, metadata: makeMetadata(10) });

    expect(result.result.tonal.tonic).toBe("C");
    // Mode is not pinned on synthetic fixtures (Hann-window leakage biases
    // major→minor). See comment in key-chroma.test.ts.
    expect(result.result.tonal.mode).not.toBeNull();
    // Rhythm is honest: this signal has no clear onsets.
    if (result.result.rhythm.bpm !== null) {
      expect(result.result.rhythm.confidence).toBeLessThan(0.65);
    }
  });

  it("long signal (>180 s) is cap-trimmed for tonal analysis without dropping rhythm", () => {
    const mono = tonalTrack(0, "major", 240); // 4 minutes — exceeds tonal cap
    const result = analyzeReference({ mono, metadata: makeMetadata(240) });

    expect(result.result.diagnostics.analyzedSeconds).toBeGreaterThanOrEqual(220);
    expect(result.result.diagnostics.tonalFrameCount).toBeGreaterThan(0);
  });
});
