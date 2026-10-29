import { describe, expect, it } from "vitest";
import { compareAudiblePcm, type AudibleMetrics } from "../src/mcp/audible-verification";

function sine(length: number, amplitude: number, sampleRate = 44100, hz = 220): Float32Array {
  const mono = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    mono[index] = Math.sin((2 * Math.PI * hz * index) / sampleRate) * amplitude;
  }
  return mono;
}

function rmsDbOf(mono: Float32Array): number {
  let sum = 0;
  for (const sample of mono) sum += sample * sample;
  const rms = Math.sqrt(sum / Math.max(1, mono.length));
  return 20 * Math.log10(Math.max(rms, 1e-7));
}

function metricsOf(mono: Float32Array, lufs: number | null, bands?: AudibleMetrics["bands"]): AudibleMetrics {
  const rmsDb = rmsDbOf(mono);
  return {
    lufs,
    peakDb: rmsDb + 3,
    rmsDb,
    crestDb: 3,
    durationSec: mono.length / 44100,
    sampleRate: 44100,
    bands: bands ?? null,
    contentHash: "test",
  };
}

describe("audible PCM comparison", () => {
  it("identical PCM is a verified, unchanged result with no residual", () => {
    const mono = sine(44100, 0.5);
    const metrics = metricsOf(mono, -18);
    const result = compareAudiblePcm(mono, metrics, mono.slice(), metrics, 44100);
    expect(result.verified).toBe(true);
    expect(result.audibleChanged).toBe(false);
    expect(result.verdict).toBe("unchanged");
    expect(result.deltas.nullResidualDb).toBeLessThan(-60);
    expect(result.deltas.lufs).toBe(0);
  });

  it("a -12 dB gain edit is detected with the measured RMS delta", () => {
    const before = sine(44100, 0.8);
    const after = before.map((sample) => sample * 0.25);
    const result = compareAudiblePcm(before, metricsOf(before, -12), after, metricsOf(after, -24), 44100);
    expect(result.verified).toBe(true);
    expect(result.audibleChanged).toBe(true);
    expect(result.verdict).toBe("changed");
    expect(result.deltas.rmsDb).toBeCloseTo(-12.04, 1);
    expect(result.deltas.nullResidualDb!).toBeGreaterThan(-6);
  });

  it("silence against signal is a verified change, not a crash", () => {
    const silent = new Float32Array(44100);
    const signal = sine(44100, 0.5);
    const result = compareAudiblePcm(silent, metricsOf(silent, null), signal, metricsOf(signal, -18), 44100);
    expect(result.verified).toBe(true);
    expect(result.audibleChanged).toBe(true);
    expect(result.deltas.nullResidualDb).toBeNull();
    expect(result.caveats.join(" ")).toMatch(/silence floor/);
  });

  it("two silent renders are inconclusive, never 'verified unchanged'", () => {
    const silent = new Float32Array(44100);
    const result = compareAudiblePcm(
      silent,
      metricsOf(silent, null),
      new Float32Array(44100),
      metricsOf(silent, null),
      44100,
    );
    expect(result.verified).toBe(false);
    expect(result.audibleChanged).toBe(false);
    expect(result.verdict).toBe("inconclusive");
  });

  it("a band-only change is reported with its dominant band", () => {
    const mono = sine(44100, 0.5);
    const before = metricsOf(mono, -18, { lowDb: -30, midDb: -20, highDb: -40 });
    const after = metricsOf(mono, -18, { lowDb: -30, midDb: -19.8, highDb: -37 });
    const result = compareAudiblePcm(mono, before, mono.slice(), after, 44100);
    expect(result.audibleChanged).toBe(true);
    expect(result.bands.delta).toEqual({ lowDb: 0, midDb: 0.2, highDb: 3 });
    expect(result.bands.dominant?.band).toBe("high");
    expect(result.bands.dominant?.centerHz).toBeGreaterThan(2000);
  });
});
