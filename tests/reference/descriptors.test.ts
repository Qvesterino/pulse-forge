/**
 * F2 §2.2 — descriptors.
 *
 * The five descriptors are a port of `beat_modifier`'s `_spectral`,
 * `_loudness`, `_stereo`, `_groove` and `_plain_summary`, so these tests pin
 * the SAME behaviour those depend on: the 0.85 rolloff, the 250/4000 Hz band
 * split, the 400 ms loudness blocks with the top-95 % integration, the
 * mid/side width formula, and the groove family thresholds.
 *
 * The two claims that are easy to get subtly wrong and are therefore pinned
 * hardest:
 *
 *  - **Stereo cannot be measured from the mono downmix.** Mid/side IS the
 *    left-right difference, so a mono signal has no side energy and must
 *    report width 0 — not a plausible-looking guess. The pipeline test feeds
 *    real channels to prove the width survives the trip.
 *  - **Clipping is reported, never corrected.** A clipped file's loudness
 *    number is meaningless, so the descriptor flags it and the analyzer warns.
 */

import { describe, expect, it } from "vitest";
import { analyzeReference } from "../../src/reference/analysis/analyzeReference";
import {
  grooveDescriptor,
  loudnessDescriptor,
  plainSummary,
  spectralDescriptor,
  stereoDescriptor,
} from "../../src/reference/descriptors";
import { ReferenceFft } from "../../src/reference/dsp/fft";
import { makeMetadata } from "./_fixtures";
import { FIXTURE_SR } from "./_fixtures";

const fft = new ReferenceFft(2048);

/** `seconds` of a pure tone at `hz`, amplitude `amp`. */
function tone(seconds: number, hz: number, amp = 0.5, sampleRate = FIXTURE_SR): Float32Array {
  const out = new Float32Array(Math.floor(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
}

/** White-ish noise from a deterministic LCG — no Math.random in a test. */
function noise(seconds: number, sampleRate = FIXTURE_SR): Float32Array {
  const out = new Float32Array(Math.floor(seconds * sampleRate));
  let seed = 12345;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (seed / 0x3fffffff - 1) * 0.5;
  }
  return out;
}

describe("descriptors — spectral", () => {
  it("puts a low tone in the low band and a high tone in the high band", () => {
    const low = spectralDescriptor(tone(4, 100), FIXTURE_SR, fft);
    const high = spectralDescriptor(tone(4, 8000), FIXTURE_SR, fft);
    // A 100 Hz sine is almost entirely below 250 Hz; an 8 kHz sine almost
    // entirely above 4 kHz. This is the band split doing its job.
    expect(low.lowEnergy).toBeGreaterThan(0.9);
    expect(low.highEnergy).toBeLessThan(0.05);
    expect(high.highEnergy).toBeGreaterThan(0.9);
    expect(high.lowEnergy).toBeLessThan(0.05);
  });

  it("orders the centroid with pitch — a higher tone reads brighter", () => {
    const low = spectralDescriptor(tone(4, 200), FIXTURE_SR, fft);
    const high = spectralDescriptor(tone(4, 4000), FIXTURE_SR, fft);
    expect(high.centroidHz).toBeGreaterThan(low.centroidHz);
    expect(high.brightness).toBeGreaterThan(low.brightness);
  });

  it("keeps rolloff above the centroid for a tonal signal", () => {
    const s = spectralDescriptor(tone(4, 1000), FIXTURE_SR, fft);
    // 85 % of the energy sits ABOVE the centroid for any peaked spectrum, so
    // an inverted pair means the cumulative scan is broken.
    expect(s.rolloffHz).toBeGreaterThan(s.centroidHz);
  });

  it("reads noise as flat and a tone as not-flat", () => {
    const flat = spectralDescriptor(noise(4), FIXTURE_SR, fft);
    const tonal = spectralDescriptor(tone(4, 1000), FIXTURE_SR, fft);
    // Spectral flatness separates noise from tone — this is the whole reason
    // the descriptor exists.
    expect(flat.flatness).toBeGreaterThan(tonal.flatness);
  });

  it("sums the three bands to 1 and keeps brightness in 0..1", () => {
    for (const signal of [tone(4, 440), noise(4), tone(4, 6000)]) {
      const s = spectralDescriptor(signal, FIXTURE_SR, fft);
      expect(s.lowEnergy + s.midEnergy + s.highEnergy).toBeCloseTo(1, 3);
      expect(s.brightness).toBeGreaterThanOrEqual(0);
      expect(s.brightness).toBeLessThanOrEqual(1);
    }
  });

  it("returns the flat fallback for silence rather than NaN", () => {
    const s = spectralDescriptor(new Float32Array(FIXTURE_SR * 3), FIXTURE_SR, fft);
    expect(Number.isFinite(s.centroidHz)).toBe(true);
    expect(s.flatness).toBe(0);
  });

  it("handles a buffer shorter than one FFT frame", () => {
    const s = spectralDescriptor(tone(0.05, 440), FIXTURE_SR, fft);
    expect(Number.isFinite(s.centroidHz)).toBe(true);
  });

  it("is deterministic", () => {
    const signal = noise(4);
    expect(spectralDescriptor(signal, FIXTURE_SR, fft)).toEqual(spectralDescriptor(signal, FIXTURE_SR, fft));
  });
});

describe("descriptors — loudness", () => {
  it("reports a full-scale sine at -3.70 LUFS-ish and 0 dBFS peak", () => {
    const l = loudnessDescriptor(tone(2, 440, 1), FIXTURE_SR);
    // Arithmetic, not a guess: a full-scale sine has RMS 1/√2, so
    // 10·log10(0.5) = -3.01 dB, minus the 0.691 LUFS offset = -3.70.
    expect(l.integratedLufs).toBeCloseTo(-3.7, 1);
    expect(l.peakDbfs).toBeCloseTo(0, 1);
    expect(l.clipped).toBe(true);
  });

  it("reads quieter signals as quieter", () => {
    const loud = loudnessDescriptor(tone(2, 440, 0.5), FIXTURE_SR);
    const quiet = loudnessDescriptor(tone(2, 440, 0.05), FIXTURE_SR);
    expect(quiet.integratedLufs).toBeLessThan(loud.integratedLufs - 15);
  });

  it("flags clipping instead of silently reporting a level", () => {
    const l = loudnessDescriptor(tone(2, 440, 1), FIXTURE_SR);
    expect(l.clipped).toBe(true);
    const clean = loudnessDescriptor(tone(2, 440, 0.4), FIXTURE_SR);
    expect(clean.clipped).toBe(false);
  });

  it("keeps crest factor positive and finite for a sine", () => {
    const l = loudnessDescriptor(tone(2, 440, 0.5), FIXTURE_SR);
    expect(l.crestFactorDb).toBeGreaterThan(0);
    expect(Number.isFinite(l.crestFactorDb)).toBe(true);
  });

  it("reports a wider dynamic range for a level-varying signal than a constant one", () => {
    // The 95th/10th percentile spread is the whole point of the metric.
    const steady = tone(3, 440, 0.5);
    const varying = new Float32Array(FIXTURE_SR * 3);
    for (let i = 0; i < varying.length; i++) {
      const t = i / FIXTURE_SR;
      varying[i] = (t < 1.5 ? 0.02 : 0.5) * Math.sin((2 * Math.PI * 440 * i) / FIXTURE_SR);
    }
    expect(loudnessDescriptor(varying, FIXTURE_SR).dynamicRangeDb).toBeGreaterThan(
      loudnessDescriptor(steady, FIXTURE_SR).dynamicRangeDb,
    );
  });

  it("falls back to whole-file RMS for a buffer shorter than one 400 ms block", () => {
    const l = loudnessDescriptor(tone(0.2, 440, 0.5), FIXTURE_SR);
    // The Python hardcodes 12 dB here; a sub-block file has no percentile
    // spread worth reporting and inventing one would be noise.
    expect(l.dynamicRangeDb).toBe(12);
    expect(Number.isFinite(l.integratedLufs)).toBe(true);
  });

  it("clamps an artifact-level dynamic range to something physically possible", () => {
    // Regression: `p95 / (p10 + 1e-12)` explodes on sparse material. A click
    // track with true digital silence between hits measured 223 dB here,
    // because the 10th percentile is the epsilon floor, not a quiet musical
    // level. Nothing has 223 dB of range, so the metric now stops claiming one.
    const sparse = new Float32Array(FIXTURE_SR * 4);
    for (let i = 0; i < sparse.length; i++) {
      const period = Math.round((60 / 120) * FIXTURE_SR);
      const j = i % period;
      sparse[i] = j < 500 ? 0.9 * Math.sin((2 * Math.PI * 1000 * j) / FIXTURE_SR) : 0;
    }
    const l = loudnessDescriptor(sparse, FIXTURE_SR);
    expect(l.dynamicRangeDb).toBeLessThanOrEqual(60);
    // A steady tone is unaffected — the clamp only bites at the top.
    expect(loudnessDescriptor(tone(3, 440, 0.5), FIXTURE_SR).dynamicRangeDb).toBeLessThan(5);
  });

  it("does not produce NaN for silence", () => {
    const l = loudnessDescriptor(new Float32Array(FIXTURE_SR * 2), FIXTURE_SR);
    for (const [k, v] of Object.entries(l)) {
      if (typeof v === "number") expect(Number.isFinite(v), `${k} is ${v}`).toBe(true);
    }
  });
});

describe("descriptors — stereo", () => {
  it("reports width 0 for a mono file", () => {
    // Mid/side IS the left-right difference. A mono signal has no side
    // component, so width 0 is the CORRECT answer, not missing information.
    const s = stereoDescriptor([tone(2, 440)]);
    expect(s.width).toBe(0);
    expect(s.sideEnergyRatio).toBe(0);
  });

  it("reports width 0 for identical left and right", () => {
    const t = tone(2, 440);
    const s = stereoDescriptor([t, new Float32Array(t)]);
    expect(s.width).toBeCloseTo(0, 6);
  });

  it("reports wide for a hard-panned signal", () => {
    // Left only: side = -mid, so width = |side| / (mid + mid) = 1.
    const left = tone(2, 440);
    const s = stereoDescriptor([left, new Float32Array(left.length)]);
    expect(s.width).toBeCloseTo(1, 2);
  });

  it("reports a partial width for a partially decorrelated pair", () => {
    const a = tone(2, 440);
    const b = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) b[i] = a[i] * 0.5;
    const s = stereoDescriptor([a, b]);
    expect(s.width).toBeGreaterThan(0);
    expect(s.width).toBeLessThan(1);
  });

  it("keeps both values inside 0..1", () => {
    for (const pair of [
      [tone(1, 440), tone(1, 440)],
      [tone(1, 440), new Float32Array(FIXTURE_SR)],
    ]) {
      const s = stereoDescriptor(pair as [Float32Array, Float32Array]);
      expect(s.width).toBeGreaterThanOrEqual(0);
      expect(s.width).toBeLessThanOrEqual(1);
      expect(s.sideEnergyRatio).toBeGreaterThanOrEqual(0);
      expect(s.sideEnergyRatio).toBeLessThanOrEqual(1);
    }
  });

  it("handles unequal-length channels without reading past the end", () => {
    const short = tone(1, 440);
    const s = stereoDescriptor([tone(2, 440), short]);
    expect(Number.isFinite(s.width)).toBe(true);
  });
});

describe("descriptors — groove family", () => {
  /** `bpm` clicks per second, so density is predictable. */
  function clicks(seconds: number, bpm: number, sampleRate = FIXTURE_SR): Float32Array {
    const out = new Float32Array(Math.floor(seconds * sampleRate));
    const period = Math.round((60 / bpm) * sampleRate);
    const len = Math.round(0.02 * sampleRate);
    for (let start = 0; start < out.length; start += period) {
      for (let j = 0; j < len && start + j < out.length; j++) {
        out[start + j] = 0.9 * Math.sin((2 * Math.PI * 1200 * j) / sampleRate);
      }
    }
    return out;
  }

  it("classifies a fast, dense track as breakbeat", () => {
    const g = grooveDescriptor(clicks(8, 170), FIXTURE_SR, 170);
    expect(g.family).toBe("breakbeat");
    expect(g.drumDensity).toBeGreaterThan(0);
  });

  it("classifies a slow track as half-time", () => {
    expect(grooveDescriptor(clicks(8, 80), FIXTURE_SR, 80).family).toBe("half_time");
  });

  it("classifies a mid-tempo sparse track as four-on-the-floor", () => {
    expect(grooveDescriptor(clicks(8, 120), FIXTURE_SR, 120).family).toBe("four_on_the_floor");
  });

  it("falls back to the assumption-light family when no tempo was detected", () => {
    const g = grooveDescriptor(clicks(8, 120), FIXTURE_SR, null);
    expect(g.family).toBe("four_on_the_floor");
  });

  it("keeps density in 0..1 and syncopation in 0..1", () => {
    for (const bpm of [70, 120, 175]) {
      const g = grooveDescriptor(clicks(6, bpm), FIXTURE_SR, bpm);
      expect(g.drumDensity).toBeGreaterThanOrEqual(0);
      expect(g.drumDensity).toBeLessThanOrEqual(1);
      expect(g.syncopation).toBeGreaterThanOrEqual(0);
      expect(g.syncopation).toBeLessThanOrEqual(1);
    }
  });

  it("reports near-zero syncopation for an even click track", () => {
    // Evenly spaced onsets have zero interval variance — that is the
    // definition of "not syncopated" and the metric must agree.
    const g = grooveDescriptor(clicks(8, 120), FIXTURE_SR, 120);
    expect(g.syncopation).toBeLessThan(0.25);
  });

  it("reports higher syncopation for unevenly spaced hits", () => {
    const even = clicks(8, 120);
    const uneven = new Float32Array(even.length);
    // Same number of transients, irregular spacing.
    for (const at of [0, 0.13, 0.31, 0.44, 0.58, 0.79, 0.91, 1.07]) {
      const start = Math.floor(at * FIXTURE_SR);
      for (let j = 0; j < 500 && start + j < uneven.length; j++) {
        uneven[start + j] = 0.9 * Math.sin((2 * Math.PI * 1200 * j) / FIXTURE_SR);
      }
    }
    expect(grooveDescriptor(uneven, FIXTURE_SR, 120).syncopation).toBeGreaterThan(
      grooveDescriptor(even, FIXTURE_SR, 120).syncopation,
    );
  });

  it("does not throw on a signal shorter than the downsample block", () => {
    const g = grooveDescriptor(new Float32Array(10), FIXTURE_SR, 120);
    expect(g.family).toBe("four_on_the_floor");
    expect(g.drumDensity).toBe(0);
  });
});

describe("descriptors — plain summary", () => {
  const base = {
    bpm: 128,
    tonic: "F#",
    mode: "minor" as const,
    confidence: 0.81,
    averageEnergy: 0.42,
    sections: [
      {
        role: "intro" as const,
        startSec: 0,
        endSec: 4,
        startBeat: 0,
        endBeat: 8,
        energy: 0.2,
        markerType: "buildup" as const,
      },
      {
        role: "drop" as const,
        startSec: 4,
        endSec: 20,
        startBeat: 8,
        endBeat: 40,
        energy: 0.9,
        markerType: "drop" as const,
      },
    ],
    spectral: spectralDescriptor(tone(4, 3000), FIXTURE_SR, fft),
    stereo: stereoDescriptor([tone(2, 440), new Float32Array(FIXTURE_SR * 2)]),
    groove: grooveDescriptor(clicksHelper(), FIXTURE_SR, 128),
  };

  function clicksHelper(): Float32Array {
    const out = new Float32Array(FIXTURE_SR * 4);
    for (let i = 0; i < out.length; i++) {
      const period = Math.round((60 / 128) * FIXTURE_SR);
      const j = i % period;
      out[i] = j < 500 ? 0.9 * Math.sin((2 * Math.PI * 1200 * j) / FIXTURE_SR) : 0;
    }
    return out;
  }

  it("names the tempo, key, confidence and structure", () => {
    const s = plainSummary(base);
    expect(s).toMatch(/128 BPM/);
    expect(s).toMatch(/F# minor/);
    expect(s).toMatch(/81%/);
    expect(s).toMatch(/intro/);
  });

  it("says so when no tempo was found instead of inventing one", () => {
    const s = plainSummary({ ...base, bpm: null, tonic: null, mode: null });
    expect(s).toMatch(/no reliable tempo/i);
    expect(s).not.toMatch(/NaN/);
  });

  it("describes brightness and width in words", () => {
    const s = plainSummary(base);
    expect(s).toMatch(/bright|warm\/dark/);
    expect(s).toMatch(/wide|narrow|moderate/);
  });

  it("never contains NaN or undefined for any input", () => {
    for (const variant of [base, { ...base, bpm: null }, { ...base, sections: [] }]) {
      const s = plainSummary(variant);
      expect(s).not.toMatch(/NaN/);
      expect(s).not.toMatch(/undefined/);
    }
  });
});

describe("descriptors — end to end through analyzeReference", () => {
  it("attaches every descriptor to the result", () => {
    const result = analyzeReference({ mono: noise(8), metadata: makeMetadata(8) }).result;
    expect(result.descriptors).toBeDefined();
    const d = result.descriptors!;
    for (const key of ["spectral", "loudness", "stereo", "groove"] as const) {
      expect(d[key], key).toBeDefined();
    }
    expect(d.summary.length).toBeGreaterThan(0);
  });

  it("carries the real stereo width through when channels are supplied", () => {
    // The regression this guards: the analyzer only saw the mono downmix and
    // reported width 0 for every file, including hard-panned stereo.
    const left = tone(4, 440);
    const right = new Float32Array(left.length);
    const result = analyzeReference({
      mono: left,
      channels: [left, right],
      metadata: makeMetadata(4),
    }).result;
    expect(result.descriptors!.stereo.width).toBeGreaterThan(0.9);
  });

  it("reports width 0 when only mono is supplied — honestly, not as a guess", () => {
    const result = analyzeReference({ mono: tone(4, 440), metadata: makeMetadata(4) }).result;
    expect(result.descriptors!.stereo.width).toBe(0);
  });

  it("warns on a clipped reference instead of reporting a usable level", () => {
    const result = analyzeReference({ mono: tone(4, 440, 1), metadata: makeMetadata(4) }).result;
    expect(result.descriptors!.loudness.clipped).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/clip/i);
  });

  it("emits a 'descriptors' stage so the UI can show progress", () => {
    const stages: string[] = [];
    analyzeReference({ mono: noise(6), metadata: makeMetadata(6), onStage: (s) => stages.push(s) });
    expect(stages).toContain("descriptors");
  });

  it("is deterministic across repeated runs", () => {
    const left = tone(4, 440);
    const right = new Float32Array(left.length);
    const run = () =>
      analyzeReference({ mono: left, channels: [left, right], metadata: makeMetadata(4) }).result.descriptors;
    expect(run()).toEqual(run());
  });
});
