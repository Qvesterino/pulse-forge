/**
 * Golden output snapshot — canonical fixtures whose ReferenceMap is the
 * contract callers (UI panels, exports, golden tests downstream) rely on.
 *
 * Snapshot files live next to this test under tests/reference/__snapshots__/.
 * On intentional engine changes, regenerate via:
 *   npx vitest run --update tests/reference/golden.test.ts
 *
 * Per docs/REFERENCE-MAP-ROADMAP.md §C: golden JSON includes engineVersion.
 */

import { describe, expect, it } from "vitest";
import { analyzeReference } from "../../src/reference/analysis/analyzeReference";
import { clickTrack, makeMetadata, tonalTrack } from "./_fixtures";

describe("reference/golden", () => {
  it("120 BPM click track — canonical rhythm snapshot", () => {
    const mono = clickTrack(120, 6);
    const result = analyzeReference({
      mono,
      metadata: makeMetadata(6),
    });
    expect(result.result).toMatchSnapshot();
    // Engine + schema version is part of the golden contract.
    expect(result.result.diagnostics.engineVersion).toBe("kyx-reference/1.0.0");
    expect(result.result.diagnostics.schemaVersion).toBe(1);
  });

  it("C sustained-note track — canonical tonal snapshot (major/minor interchangeable on synthetic fixtures)", () => {
    const mono = tonalTrack(0, "major", 12); // C tonic
    const result = analyzeReference({
      mono,
      metadata: makeMetadata(12),
    });
    expect(result.result).toMatchSnapshot();
    expect(result.result.tonal.tonic).toBe("C");
    // Mode is intentionally NOT pinned — Hann-window leakage on synthetic
    // signals biases major/minor toward minor. Camelot stays well-defined
    // because we still have a tonic + mode pair.
    expect(["C major", "C minor"]).toContain(
      `${result.result.tonal.tonic} ${result.result.tonal.mode}`,
    );
    expect(["8B", "5A"]).toContain(result.result.tonal.camelot);
  });
});
