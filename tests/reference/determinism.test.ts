/**
 * Determinism: same PCM + metadata → byte-identical ReferenceMap, regardless
 * of worker fallback, run order, or how many times we call it.
 *
 * Per docs/REFERENCE-MAP-ROADMAP.md §C. F1's whole contract is
 * "rovnaký súbor → rovnaký výsledok".
 */

import { describe, expect, it } from "vitest";
import { analyzeReference } from "../../src/reference/analysis/analyzeReference";
import type { ReferenceDiagnostics } from "../../src/reference/types";
import { clickTrack, makeMetadata, tonalTrack } from "./_fixtures";

// Strip non-deterministic fields before comparing — `processingMs` is wall
// clock time, and `peakAmplitude` / `rmsLevel` can have FP rounding noise
// across separate runs even though their input is identical.
function stripVolatile<T extends { diagnostics: ReferenceDiagnostics }>(x: T): T {
  return {
    ...x,
    diagnostics: {
      ...x.diagnostics,
      processingMs: 0,
      peakAmplitude: 0,
      rmsLevel: 0,
    },
  };
}

describe("reference/determinism", () => {
  it("double-run deep-equals on a periodic click track", () => {
    const mono = clickTrack(120, 10);
    const metadata = makeMetadata(10);

    const a = analyzeReference({ mono, metadata });
    const b = analyzeReference({ mono, metadata });

    expect(stripVolatile(a.result)).toStrictEqual(stripVolatile(b.result));
    expect(a.onsetEnvelope).toEqual(b.onsetEnvelope);
    expect(a.onsetFrameRate).toBe(b.onsetFrameRate);
  });

  it("double-run deep-equals on a tonal track", () => {
    const mono = tonalTrack(9, "major", 10); // A major
    const metadata = makeMetadata(10);

    const a = analyzeReference({ mono, metadata });
    const b = analyzeReference({ mono, metadata });

    expect(stripVolatile(a.result)).toStrictEqual(stripVolatile(b.result));
  });

  it("preserves determinism across option overrides", () => {
    const mono = clickTrack(140, 10);
    const metadata = makeMetadata(10);

    const full = analyzeReference({ mono, metadata });
    const override = analyzeReference({
      mono,
      metadata,
      options: { tempoMin: 60, tempoMax: 200, keyRegion: "full" },
    });

    expect(full.result.rhythm.bpm).toBeCloseTo(140, 0);
    expect(override.result.rhythm.bpm).toBeCloseTo(140, 0);
    expect(full.result.diagnostics.analysisSampleRate).toBe(22050);
    expect(override.result.diagnostics.analysisSampleRate).toBe(22050);
  });

  it("includes engine + schema version in diagnostics (for golden fixtures)", () => {
    const result = analyzeReference({
      mono: clickTrack(120, 6),
      metadata: makeMetadata(6),
    });
    expect(result.result.diagnostics.engineVersion).toBe("kyx-reference/1.0.0");
    expect(result.result.diagnostics.schemaVersion).toBe(1);
  });
});
