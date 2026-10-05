import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MeteringRig, measureTruePeak } from "../src/audio-engine/meteringRig";
import type { MeteringRigDeps } from "../src/audio-engine/meteringRig";

/**
 * Wave 4a (AudioEngine decomposition) — MeteringRig pins.
 *
 * The rig owns meter reads, peak hold, LUFS history and the registered
 * master taps; the engine's public surface is one-line delegation. These
 * pins hold the pieces the facade tests cannot see: the snapshot TTL cache
 * (three rAF consumers share one computation), the per-project meter reset,
 * tap teardown on master rebuilds, and the facade law (the rig must never
 * import AudioEngine — the engine module graph stays acyclic toward its
 * collaborators, docs/AUDIOENGINE-DECOMPOSITION-PLAN.md §2).
 */

class FakeAnalyser {
  reads = 0;
  constructor(private readonly value: number) {}
  getFloatTimeDomainData(buf: Float32Array): void {
    this.reads++;
    buf.fill(0);
    if (buf.length > 0) buf[0] = this.value;
  }
}

function makeDeps(overrides: Partial<MeteringRigDeps> = {}): MeteringRigDeps {
  return {
    ctx: () => ({ sampleRate: 48000 }) as unknown as BaseAudioContext,
    trackAnalyser: () => null,
    groupAnalyser: () => null,
    returnAnalyser: () => null,
    trackPreAnalyser: () => null,
    groupPreAnalyser: () => null,
    masterStage: () => ({ limiter: null, limiterWorklet: null, glue: null, kwMeter: null, rtMonitor: null }),
    ...overrides,
  };
}

describe("MeteringRig (Wave 4a)", () => {
  it("track/return meters read the registered analysers with clip + peakDb", () => {
    const track = new FakeAnalyser(0.5);
    const hot = new FakeAnalyser(1.0);
    const ret = new FakeAnalyser(0.25);
    const rig = new MeteringRig(
      makeDeps({
        trackAnalyser: (id) =>
          id === "t1" ? (track as unknown as AnalyserNode) : id === "t2" ? (hot as unknown as AnalyserNode) : null,
        returnAnalyser: (id) => (id === "r1" ? (ret as unknown as AnalyserNode) : null),
      }),
    );
    expect(rig.getTrackLevel("t1")).toBeCloseTo(0.5, 6);
    const snap = rig.getTrackMeterSnapshot("t2");
    expect(snap.level).toBe(1);
    expect(snap.clipping).toBe(true);
    expect(rig.getReturnLevel("r1")).toBeCloseTo(0.25, 6);
    expect(rig.getTrackLevel("missing")).toBe(0);
  });

  it("master snapshot cache shares one computation within the TTL window", () => {
    const analyser = new FakeAnalyser(0.5);
    const analyserL = new FakeAnalyser(0.4);
    const analyserR = new FakeAnalyser(0.3);
    let stageReads = 0;
    let fakeNow = 0;
    const rig = new MeteringRig(
      makeDeps({
        trackAnalyser: () => null,
        masterStage: () => {
          stageReads++;
          return { limiter: null, limiterWorklet: null, glue: null, kwMeter: null, rtMonitor: null };
        },
        now: () => fakeNow,
      }),
    );
    rig.attachMasterTaps({
      analyser: analyser as unknown as AnalyserNode,
      splitter: null,
      analyserL: analyserL as unknown as AnalyserNode,
      analyserR: analyserR as unknown as AnalyserNode,
      spectrogram: null,
      spectrogramLow: null,
      spectrogramHigh: null,
      spectrogramMid: null,
      spectrogramSide: null,
    });
    const a = rig.getMasterMeterSnapshot();
    const readsAfterFirst = analyserL.reads;
    expect(readsAfterFirst).toBeGreaterThan(0);
    const b = rig.getMasterMeterSnapshot();
    expect(b).toBe(a); // same object — the one-frame TTL cache (fixed clock)
    expect(analyserL.reads).toBe(readsAfterFirst);
    expect(stageReads).toBeGreaterThanOrEqual(1);
  });

  it("syncProjectId resets history on project switch (fresh LUFS integration)", () => {
    const analyser = new FakeAnalyser(0.5);
    const rig = new MeteringRig(makeDeps({ trackAnalyser: () => analyser as unknown as AnalyserNode }));
    rig.attachMasterTaps({
      analyser: analyser as unknown as AnalyserNode,
      splitter: null,
      analyserL: null,
      analyserR: null,
      spectrogram: null,
      spectrogramLow: null,
      spectrogramHigh: null,
      spectrogramMid: null,
      spectrogramSide: null,
    });
    rig.syncProjectId("p1");
    const warm = rig.getMasterMeterSnapshot();
    rig.syncProjectId("p1"); // same project — history survives
    const warm2 = rig.getMasterMeterSnapshot();
    expect(warm2.truePeakDb).toBeCloseTo(warm.truePeakDb, 6);
    rig.syncProjectId("p2"); // switch — history resets
    const fresh = rig.getMasterMeterSnapshot();
    expect(Number.isFinite(fresh.lufsIntegrated)).toBe(true);
  });

  it("disconnectMasterTaps tears down every registered tap (master rebuild path)", () => {
    const disconnected: string[] = [];
    const tap = (name: string) =>
      ({
        disconnect: () => {
          disconnected.push(name);
        },
      }) as unknown as AnalyserNode;
    const rig = new MeteringRig(makeDeps());
    rig.attachMasterTaps({
      analyser: tap("analyser"),
      splitter: tap("splitter"),
      analyserL: tap("L"),
      analyserR: tap("R"),
      spectrogram: tap("spec"),
      spectrogramLow: tap("low"),
      spectrogramHigh: tap("high"),
      spectrogramMid: tap("mid"),
      spectrogramSide: tap("side"),
    });
    rig.disconnectMasterTaps();
    expect(disconnected.sort()).toEqual(["L", "R", "analyser", "high", "low", "mid", "side", "spec", "splitter"]);
  });

  it("master gain reduction reads the worklet first, native fallback second", () => {
    const workletRig = new MeteringRig(
      makeDeps({
        masterStage: () => ({
          limiter: { reduction: -3 } as unknown as DynamicsCompressorNode,
          limiterWorklet: { getGainReductionDb: () => 5 } as unknown as never,
          glue: null,
          kwMeter: null,
          // Added by the rt-monitor hardening commit that this test's mock never picked up.
          rtMonitor: null,
        }),
      }),
    );
    expect(workletRig.getMasterGainReductionDb()).toBe(5);
    const nativeRig = new MeteringRig(
      makeDeps({
        masterStage: () => ({
          limiter: { reduction: -3 } as unknown as DynamicsCompressorNode,
          limiterWorklet: null,
          glue: null,
          kwMeter: null,
          // Added by the rt-monitor hardening commit that this test's mock never picked up.
          rtMonitor: null,
        }),
      }),
    );
    expect(nativeRig.getMasterGainReductionDb()).toBe(3);
  });

  it("measureTruePeak passthrough (empty frame = 0)", () => {
    expect(measureTruePeak(new Float32Array(0), 1)).toBe(0);
    const steady = new Float32Array(128).fill(-0.9);
    expect(measureTruePeak(steady, 1)).toBeGreaterThan(0.8);
  });

  it("facade law: the rig never imports AudioEngine", () => {
    const src = readFileSync(resolve(process.cwd(), "src/audio-engine/meteringRig.ts"), "utf8");
    expect(/from\s+"\.\/AudioEngine"/.test(src)).toBe(false);
    expect(/from\s+"[^"]*audio-engine\/AudioEngine"/.test(src)).toBe(false);
  });
});
