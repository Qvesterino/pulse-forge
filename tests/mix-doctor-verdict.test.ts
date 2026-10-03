import { describe, it, expect } from "vitest";
import { buildMixCheckVerdict, analyzeMixHealth } from "../src/analysis/mixDoctor";

/**
 * MIX-DOCTOR VERDICT LINE (per-render mix-doctor, quality roadmap P1) —
 * every agent export (quick-bounce: WAV/MP3) carries the mix check in its
 * read-back so an agent can react without ears. The builder is pure and
 * the verdict is deterministic from the report.
 */

function fakeHealth(overrides: Partial<Parameters<typeof buildMixCheckVerdict>[0]> = {}) {
  return {
    durationSec: 8,
    peak: 0.85,
    clippedSamples: 0,
    headroomDb: 1.4,
    crestDb: 9.2,
    dcOffset: 0,
    integratedLufs: -13.8,
    momentaryMaxLufs: -9.5,
    bandShares: { sub: 0.3, low: 0.44, lowmid: 0.1, mid: 0.08, himid: 0.05, high: 0.02, air: 0.01 },
    lowEndShare: 0.74,
    stereoCorrelation: 0.9,
    flags: [],
    ok: true,
    ...overrides,
  };
}

describe("buildMixCheckVerdict", () => {
  it("PASS line carries the core numbers when nothing is flagged", () => {
    const line = buildMixCheckVerdict(fakeHealth());
    expect(line).toContain("MIX CHECK PASS");
    expect(line).toContain("-13.8 LUFS");
    expect(line).toContain("low 74%");
    expect(line).toContain("crest 9.2 dB");
  });

  it("issues are named with severity; red count leads the line", () => {
    const line = buildMixCheckVerdict(
      fakeHealth({
        ok: false,
        flags: [
          { severity: "red", check: "clipping", detail: "120 samples at full scale" },
          { severity: "yellow", check: "low-end", detail: "74% low share" },
        ],
      }),
    );
    expect(line).toContain("MIX CHECK — 1 ISSUE —");
    expect(line).toContain("⚠ clipping");
    expect(line).toContain("○ low-end");
  });

  it("the derived auto-fix is offered when one exists", () => {
    const health = fakeHealth({ peak: 1.2, clippedSamples: 900, ok: false });
    const line = buildMixCheckVerdict(health);
    expect(line).toContain("suggested fix");
    expect(line).toContain("master gain");
  });

  it("silence (no measurable LUFS) still renders an honest line", () => {
    const line = buildMixCheckVerdict(fakeHealth({ integratedLufs: null, momentaryMaxLufs: null }));
    expect(line).toContain("MIX CHECK");
    expect(line).toContain("LUFS n/a");
  });

  it("round-trips through analyzeMixHealth on synthetic silence (sanity)", () => {
    const silent = [new Float32Array(44100), new Float32Array(44100)];
    const health = analyzeMixHealth(silent, 44100);
    const line = buildMixCheckVerdict(health);
    expect(line).toContain("MIX CHECK");
  });
});
