import { describe, expect, it } from "vitest";
import {
  MAX_DB,
  MIN_DB,
  PeakHold,
  channelLevels,
  computeStageAdjustment,
  evaluateExportMonoGuard,
  evaluateMasterVerdict,
  splitChannels,
  stereoCorrelation,
  summarizeBuffer,
  toDb,
  fromDb,
} from "../src/audio-engine/metering";

function makeBuffer(samples: number[][], sampleRate = 44100): AudioBuffer {
  const length = Math.max(...samples.map((c) => c.length));
  return {
    length,
    sampleRate,
    numberOfChannels: samples.length,
    duration: length / sampleRate,
    getChannelData: (ch: number) => Float32Array.from(samples[ch]),
  } as unknown as AudioBuffer;
}

describe("metering utilities", () => {
  it("toDb / fromDb round-trip and clamp", () => {
    expect(toDb(0)).toBe(MIN_DB);
    expect(toDb(1)).toBeCloseTo(0, 5);
    expect(toDb(0.5)).toBeCloseTo(-6.0206, 3);
    expect(toDb(2)).toBe(MAX_DB);
    expect(fromDb(-6)).toBeCloseTo(0.5012, 3);
    expect(fromDb(0)).toBe(1);
  });

  it("channelLevels reports peak and RMS for a sine-like signal", () => {
    const sine = new Float32Array(1000);
    for (let i = 0; i < sine.length; i++) sine[i] = Math.sin((i / sine.length) * Math.PI * 2) * 0.5;
    const lv = channelLevels(sine);
    expect(lv.peak).toBeCloseTo(0.5, 5);
    expect(lv.peakDb).toBeCloseTo(-6.02, 2);
    expect(lv.rms).toBeGreaterThan(0);
    expect(lv.rms).toBeLessThan(0.5);
  });

  it("stereoCorrelation is +1 for identical L/R and -1 for inverted L/R", () => {
    const a = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
    const b = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
    expect(stereoCorrelation(a, b)).toBeCloseTo(1, 5);
    const c = new Float32Array([-0.1, -0.2, -0.3, -0.4, -0.5]);
    expect(stereoCorrelation(a, c)).toBeCloseTo(-1, 5);
    // An unrelated noise vector is decorrelated — magnitude is small (≪ 1).
    const noise = new Float32Array([0.5, -0.3, 0.8, -0.1, 0.2]);
    const corr = stereoCorrelation(a, noise);
    expect(Math.abs(corr)).toBeLessThan(1);
  });

  it("splitChannels splits interleaved frames and preserves single-channel", () => {
    const interleaved = new Float32Array([1, 4, 2, 5, 3, 6]);
    expect(splitChannels(interleaved, 1)).toEqual([interleaved]);
    const split = splitChannels(interleaved, 2);
    expect([...split[0]]).toEqual([1, 2, 3]);
    expect([...split[1]]).toEqual([4, 5, 6]);
  });

  it("PeakHold retains the highest peak and decays between polls", () => {
    const hold = new PeakHold(1);
    expect(hold.push(0)).toBe(0);
    expect(hold.push(-6)).toBe(-1); // decays by 1 below the held peak (0)
    expect(hold.push(-3)).toBe(-2);
    expect(hold.push(-2)).toBe(-3); // strictly-less than held (-2), so decay applies
    expect(hold.push(-10)).toBe(-4);
    expect(hold.push(-10)).toBe(-5);
    hold.reset();
    expect(hold.current).toBe(MIN_DB);
  });
});

describe("summarizeBuffer", () => {
  it("computes peak and RMS for a known sine buffer", () => {
    const samples: number[][] = [];
    const channel: number[] = [];
    for (let i = 0; i < 1000; i++) channel.push(Math.sin((i / 1000) * Math.PI * 2) * 0.5);
    samples.push(channel);
    samples.push(channel);
    const summary = summarizeBuffer(makeBuffer(samples));
    expect(summary.peak).toBeCloseTo(0.5, 2);
    expect(summary.peakDb).toBeCloseTo(-6.02, 1);
    expect(summary.rms).toBeGreaterThan(0);
    expect(summary.rmsDb).toBeLessThan(0);
    expect(summary.correlation).toBeCloseTo(1, 5);
    expect(summary.truePeakDb).toBeGreaterThan(summary.peakDb - 0.5);
  });

  it("true-peak detects an inter-sample peak much louder than the sample peak", () => {
    // Two-sample ramp 0 → 1 every 4 samples so the parabolic interpolation
    // between samples reconstructs a peak of 1.0625 — clearly above the
    // discrete sample peak of 1.0.
    const left = new Float32Array(64);
    const right = new Float32Array(64);
    for (let i = 0; i < 64; i++) {
      const v = Math.min(1, i / 4);
      left[i] = v;
      right[i] = v;
    }
    const summary = summarizeBuffer(makeBuffer([Array.from(left), Array.from(right)]));
    expect(summary.peak).toBe(1);
    expect(summary.truePeakDb).toBeGreaterThan(0);
    expect(summary.correlation).toBeCloseTo(1, 5);
  });

  it("correlation is -1 for a perfectly inverted stereo file", () => {
    const left = [0.1, 0.2, 0.3, -0.4, -0.5, 0.6];
    const right = left.map((v) => -v);
    const summary = summarizeBuffer(makeBuffer([left, right]));
    expect(summary.correlation).toBeLessThan(-0.99);
  });
});

describe("evaluateMasterVerdict", () => {
  const base = {
    lufsIntegrated: -14,
    truePeakDb: -1.5,
    monoLossDb: -0.5,
    correlation: 0.6,
    lrImbalanceDb: 1,
  };

  it("is idle when nothing has played yet", () => {
    const verdict = evaluateMasterVerdict({ ...base, lufsIntegrated: -120 }, -14, -1);
    expect(verdict.level).toBe("idle");
    expect(verdict.hints).toHaveLength(0);
  });

  it("says READY with the target label when loudness and peaks fit", () => {
    const verdict = evaluateMasterVerdict(base, -14, -1, "SPOTIFY");
    expect(verdict.level).toBe("ok");
    expect(verdict.headline).toBe("READY FOR SPOTIFY");
    expect(verdict.hints).toHaveLength(0);
  });

  it("flags too loud with the delta as a hint", () => {
    const verdict = evaluateMasterVerdict({ ...base, lufsIntegrated: -11.5 }, -14, -1);
    expect(verdict.level).toBe("warn");
    expect(verdict.headline).toBe("TOO LOUD");
    expect(verdict.hints[0]).toContain("+2.5 dB louder than target");
  });

  it("flags too quiet with the delta as a hint", () => {
    const verdict = evaluateMasterVerdict({ ...base, lufsIntegrated: -17 }, -14, -1);
    expect(verdict.level).toBe("warn");
    expect(verdict.headline).toBe("TOO QUIET");
    expect(verdict.hints[0]).toContain("3.0 dB quieter than target");
  });

  it("escalates to bad when true peak exceeds the ceiling", () => {
    const verdict = evaluateMasterVerdict({ ...base, truePeakDb: -0.5 }, -14, -1);
    expect(verdict.level).toBe("bad");
    expect(verdict.headline).toBe("TRUE PEAK OVER");
    expect(verdict.hints[0]).toContain("ceiling");
  });

  it("escalates to bad on negative correlation", () => {
    const verdict = evaluateMasterVerdict({ ...base, correlation: -0.3 }, -14, -1);
    expect(verdict.level).toBe("bad");
    expect(verdict.headline).toBe("PHASE ISSUES");
  });

  it("warns on heavy mono loss while staying loudness-ok", () => {
    const verdict = evaluateMasterVerdict({ ...base, monoLossDb: -4.2 }, -14, -1);
    expect(verdict.level).toBe("warn");
    expect(verdict.headline).toBe("CHECK STEREO");
    expect(verdict.hints[0]).toContain("Mono fold-down");
  });

  it("caps hints at two, keeping phase and true peak first", () => {
    const verdict = evaluateMasterVerdict(
      { ...base, correlation: -0.5, truePeakDb: 0.5, lufsIntegrated: -11, monoLossDb: -5 },
      -14,
      -1,
    );
    expect(verdict.level).toBe("bad");
    expect(verdict.hints).toHaveLength(2);
    expect(verdict.hints[0]).toContain("Phase");
    expect(verdict.hints[1]).toContain("True peak");
  });
});

describe("evaluateExportMonoGuard", () => {
  it("is ok for a mono-safe mix", () => {
    expect(evaluateExportMonoGuard({ monoLossDb: -0.5, correlation: 0.8 })).toEqual({ level: "ok", hints: [] });
  });

  it("warns past −3 dB mono loss", () => {
    const guard = evaluateExportMonoGuard({ monoLossDb: -4.2, correlation: 0.6 });
    expect(guard.level).toBe("warn");
    expect(guard.hints[0]).toContain("Mono fold-down");
  });

  it("is bad on negative correlation", () => {
    const guard = evaluateExportMonoGuard({ monoLossDb: -0.5, correlation: -0.3 });
    expect(guard.level).toBe("bad");
    expect(guard.hints[0]).toContain("Phase");
  });

  it("is bad past −6 dB mono loss and leads with the phase hint", () => {
    const guard = evaluateExportMonoGuard({ monoLossDb: -7, correlation: -0.2 });
    expect(guard.level).toBe("bad");
    expect(guard.hints).toHaveLength(2);
    expect(guard.hints[0]).toContain("Phase");
  });
});

describe("computeStageAdjustment", () => {
  it("pulls a hot master down to ceiling − 1 dBTP", () => {
    const adj = computeStageAdjustment({ lufsIntegrated: -14, truePeakDb: -0.2 }, 1, -14, -1);
    expect(adj.noop).toBe(false);
    // peakDelta = (−1−1) − (−0.2) = −1.8 dB; loudness is on target.
    expect(adj.deltaDb).toBeCloseTo(-1.8, 5);
    expect(adj.masterGain).toBeCloseTo(Math.pow(10, -1.8 / 20), 5);
    expect(adj.applied[0]).toContain("Master IN -1.8 dB");
  });

  it("takes the conservative (quieter) delta when loud and hot", () => {
    const adj = computeStageAdjustment({ lufsIntegrated: -11, truePeakDb: -0.5 }, 1, -14, -1);
    // loudDelta = −3, peakDelta = −1.5 → −3 wins.
    expect(adj.deltaDb).toBeCloseTo(-3, 5);
  });

  it("raises a quiet mix without breaking the peak ceiling", () => {
    const adj = computeStageAdjustment({ lufsIntegrated: -20, truePeakDb: -8 }, 1, -14, -1);
    // loudDelta = +6, peakDelta = +6 → +6 (both agree, stays under ceiling).
    expect(adj.deltaDb).toBeCloseTo(6, 5);
    expect(adj.masterGain).toBeGreaterThan(1);
  });

  it("is noop when already staged, silent or muted", () => {
    expect(computeStageAdjustment({ lufsIntegrated: -14, truePeakDb: -2 }, 1, -14, -1).noop).toBe(true);
    expect(computeStageAdjustment({ lufsIntegrated: -120, truePeakDb: -120 }, 1, -14, -1).noop).toBe(true);
    expect(computeStageAdjustment({ lufsIntegrated: -11, truePeakDb: -0.5 }, 0, -14, -1).noop).toBe(true);
  });

  it("clamps to the 0..2 master range", () => {
    const adj = computeStageAdjustment({ lufsIntegrated: -30, truePeakDb: -30 }, 1, -14, -1);
    expect(adj.masterGain).toBe(2);
    expect(adj.noop).toBe(false);
  });
});
