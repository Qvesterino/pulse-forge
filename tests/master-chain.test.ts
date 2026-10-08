import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MasterChain } from "../src/audio-engine/masterChain";
import type { MeteringRig } from "../src/audio-engine/meteringRig";
import { createLimiterNode } from "../src/audio-worklets/limiter-node";
import { defaultMasterConfig } from "../src/project-model/schema";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * Wave 4b (AudioEngine decomposition) — MasterChain pins.
 *
 * The master output chain (input gain → tape → M/S → bass-mono → DC →
 * match EQ → tilt → glue → clipper → limiter + worklet splice + K-weight
 * sink) moved verbatim out of AudioEngine.ts into masterChain.ts. The
 * facade law is the load-bearing invariant: the collaborator must never
 * import AudioEngine, so the engine module graph stays acyclic toward its
 * domain owners (docs/AUDIOENGINE-DECOMPOSITION-PLAN.md §2).
 */

const CHAIN = resolve(process.cwd(), "src/audio-engine/masterChain.ts");
const ENGINE = resolve(process.cwd(), "src/audio-engine/AudioEngine.ts");

describe("MasterChain (Wave 4b)", () => {
  it("facade law: the chain never imports AudioEngine", () => {
    const src = readFileSync(CHAIN, "utf8");
    expect(/from\s+"\.\/AudioEngine"/.test(src)).toBe(false);
    expect(/from\s+"[^"]*audio-engine\/AudioEngine"/.test(src)).toBe(false);
  });

  it("the chain owns the moved methods verbatim (bodies intact)", () => {
    const src = readFileSync(CHAIN, "utf8");
    // Method inventory that moved: build, kw meter, config, worklet splice.
    for (const marker of [
      "build(): void {",
      "attachKwMeter(ctx: BaseAudioContext): void {",
      "upgradeKwMeter(): void {",
      "applyMasterConfig(config: MasterConfig): void {",
      "attachMasterWorklet(ctx: BaseAudioContext): void {",
      "upgradeMasterDynamics(): void {",
      "bypassForOfflineRender(): void {",
    ]) {
      expect(src.includes(marker), `missing: ${marker}`).toBe(true);
    }
    // The dBFS ceiling contract (lifecycle-audit regression) survived the move.
    expect(src).toMatch(/const ceilingDb\s*=\s*Math\.min\(0,\s*Math\.max\(-12,\s*config\.ceilingDb\)\)/);
    expect(src).not.toMatch(/Math\.pow\(10,\s*config\.ceilingDb\s*\/\s*20\)/);
  });

  it("the engine keeps the public surface as delegates (no master-device fields left)", () => {
    const src = readFileSync(ENGINE, "utf8");
    // The graph sink now lives on the collaborator.
    expect(src).toMatch(/private masterChain = new MasterChain\(/);
    expect(src).toMatch(
      /bypassMasterChainForOfflineRender\(\): void \{\s*\n\s*this\.masterChain\.bypassForOfflineRender\(\);/,
    );
    expect(src).toMatch(/getMasterTapNode\(\): AudioNode \| null \{\s*\n\s*return this\.masterChain\.stage\.limiter;/);
    // The moved device fields must be GONE from the facade.
    for (const gone of [
      "private masterLimiter:",
      "private masterGlue:",
      "private masterTiltLow:",
      "private masterMs:",
      "private masterBassMono:",
    ]) {
      expect(src.includes(gone), `stale facade field: ${gone}`).toBe(false);
    }
    // The offline-bypass guard error text is a pinned contract.
    expect(src).not.toMatch(/The offline master graph is not initialized/);
    const chain = readFileSync(CHAIN, "utf8");
    expect(chain).toMatch(/The offline master graph is not initialized/);
  });

  it("metering taps are handed to the rig (creation here, storage in MeteringRig)", () => {
    const src = readFileSync(CHAIN, "utf8");
    expect(src).toMatch(/this\.deps\.metering\.attachMasterTaps\(\{/);
    expect(src).toMatch(/this\.deps\.metering\.disconnectMasterTaps\(\)/);
    expect(src).toMatch(/this\.deps\.metering\.resetMeterHistory\(\)/);
  });

  it("liveContext guard is shared, not duplicated", () => {
    const engine = readFileSync(ENGINE, "utf8");
    const chain = readFileSync(CHAIN, "utf8");
    const defRe = /function isLiveAudioContext/;
    expect(defRe.test(engine)).toBe(false);
    expect(defRe.test(chain)).toBe(false);
    expect(readFileSync(resolve(process.cwd(), "src/audio-engine/liveContext.ts"), "utf8")).toMatch(defRe);
  });
});

describe("MasterChain monitor bypass", () => {
  type ParamCall = { method: string; args: number[] };
  const makeParam = (value = 0) => {
    const calls: ParamCall[] = [];
    const param = {
      value,
      cancelScheduledValues: (time: number) => calls.push({ method: "cancelScheduledValues", args: [time] }),
      cancelAndHoldAtTime: (time: number) => calls.push({ method: "cancelAndHoldAtTime", args: [time] }),
      setValueAtTime: (next: number, time: number) => calls.push({ method: "setValueAtTime", args: [next, time] }),
      setTargetAtTime: (next: number, time: number, constant: number) =>
        calls.push({ method: "setTargetAtTime", args: [next, time, constant] }),
      linearRampToValueAtTime: (next: number, time: number) =>
        calls.push({ method: "linearRampToValueAtTime", args: [next, time] }),
    } as unknown as AudioParam;
    return { param, calls };
  };

  const makeHarness = () => {
    const delayTime = makeParam();
    const wetGain = makeParam(1);
    const dryGain = makeParam(0);
    const ctx = { currentTime: 2, sampleRate: 48_000 } as BaseAudioContext;
    const master = { ...defaultMasterConfig(), tapeEnabled: true, glueEnabled: true };
    const document = { master } as ProjectDocument;
    let tapeLatency = 0.004;
    let glueLatency = 0.01;
    let insertLatency = 0.02;
    const chain = new MasterChain({
      ctx: () => ctx,
      doc: () => document,
      metering: {} as MeteringRig,
      masterInsertLatencySec: () => insertLatency,
    });
    Object.assign(chain, {
      masterTape: { getLatencySec: () => tapeLatency },
      masterGlue: { getLatencySec: () => glueLatency },
      masterBypassDelay: { delayTime: delayTime.param },
      masterBypassWet: { gain: wetGain.param },
      masterBypassDry: { gain: dryGain.param },
    });
    return {
      chain,
      delayTime,
      wetGain,
      dryGain,
      setLatency: (tape: number, glue: number, inserts: number) => {
        tapeLatency = tape;
        glueLatency = glue;
        insertLatency = inserts;
      },
      setStagesEnabled: (tape: boolean, glue: boolean) => {
        master.tapeEnabled = tape;
        master.glueEnabled = glue;
      },
    };
  };

  it("follows delayed master latency reports with a smoothed, bounded alignment", () => {
    const { chain, delayTime, setLatency } = makeHarness();

    chain.syncMonitorBypassLatency();
    expect(delayTime.calls.at(-1)).toEqual({ method: "setTargetAtTime", args: [0.034, 2, 0.015] });

    // A later AudioWorklet report re-runs the same synchronization path.
    setLatency(0.008, 0.012, 0.025);
    chain.syncMonitorBypassLatency();
    expect(delayTime.calls.at(-1)).toEqual({ method: "setTargetAtTime", args: [0.045, 2, 0.015] });

    setLatency(0.4, 0.4, 0.3);
    chain.syncMonitorBypassLatency();
    expect(delayTime.calls.at(-1)).toEqual({ method: "setTargetAtTime", args: [0.999, 2, 0.015] });
    expect(chain.getDegradedStages().find((stage) => stage.stageId === "monitorBypass")?.reason).toContain(
      "aligned only to 0.999 s",
    );
  });

  it("uses sample-exact delay writes when armed for offline PDC", () => {
    const { chain, delayTime } = makeHarness();

    chain.syncMonitorBypassLatency(true);

    expect(delayTime.calls).toContainEqual({ method: "cancelScheduledValues", args: [2] });
    expect(delayTime.calls).toContainEqual({ method: "setValueAtTime", args: [0.034, 2] });
    expect(delayTime.calls.some((call) => call.method === "setTargetAtTime")).toBe(false);
  });

  it("excludes disabled built-in stages from monitor-bypass latency alignment", () => {
    const { chain, delayTime, setStagesEnabled } = makeHarness();

    setStagesEnabled(false, false);
    chain.syncMonitorBypassLatency();
    expect(delayTime.calls.at(-1)).toEqual({ method: "setTargetAtTime", args: [0.02, 2, 0.015] });

    setStagesEnabled(true, false);
    chain.syncMonitorBypassLatency();
    expect(delayTime.calls.at(-1)).toEqual({ method: "setTargetAtTime", args: [0.024, 2, 0.015] });
  });

  it("crossfades wet and latency-aligned dry paths over 40ms and holds automation on rapid toggles", () => {
    const { chain, wetGain, dryGain } = makeHarness();

    chain.setBypassed(true);
    expect(chain.isBypassed).toBe(true);
    expect(wetGain.calls.slice(-2)).toEqual([
      { method: "cancelAndHoldAtTime", args: [2] },
      { method: "linearRampToValueAtTime", args: [0, 2.04] },
    ]);
    expect(dryGain.calls.slice(-2)).toEqual([
      { method: "cancelAndHoldAtTime", args: [2] },
      { method: "linearRampToValueAtTime", args: [1, 2.04] },
    ]);

    chain.setBypassed(false);
    expect(chain.isBypassed).toBe(false);
    expect(wetGain.calls.slice(-2)).toEqual([
      { method: "cancelAndHoldAtTime", args: [2] },
      { method: "linearRampToValueAtTime", args: [1, 2.04] },
    ]);
    expect(dryGain.calls.slice(-2)).toEqual([
      { method: "cancelAndHoldAtTime", args: [2] },
      { method: "linearRampToValueAtTime", args: [0, 2.04] },
    ]);
  });
});

describe("MasterChain limiter delivery", () => {
  it("applies the user ceiling, internal true-peak reserve, and knee to the live worklet", () => {
    const nativeParam = () => ({ value: 123 });
    const nativeLimiter = {
      threshold: nativeParam(),
      knee: nativeParam(),
      ratio: nativeParam(),
      attack: nativeParam(),
      release: nativeParam(),
    } as unknown as DynamicsCompressorNode;
    const workletParameters: Record<string, number> = {};
    const chain = new MasterChain({
      ctx: () => null,
      doc: () => null,
      metering: {} as MeteringRig,
      masterInsertLatencySec: () => 0,
    });
    Object.assign(chain, {
      master: {},
      masterClipper: { curve: null },
      masterLimiter: nativeLimiter,
      masterLimiterWorklet: {
        setParameter: (name: string, value: number) => {
          workletParameters[name] = value;
        },
      },
    });

    chain.applyMasterConfig({ ...defaultMasterConfig(), ceilingDb: -1, limiterEnabled: true });
    expect(workletParameters).toEqual({
      ceiling: -1.2,
      threshold: -4.4,
      release: 0.12,
      lookaheadMs: 5,
      link: 1,
      mix: 1,
    });
    expect(nativeLimiter.threshold.value).toBe(0);
    expect(nativeLimiter.ratio.value).toBe(1);

    chain.applyMasterConfig({ ...defaultMasterConfig(), ceilingDb: -20, limiterEnabled: true });
    expect(workletParameters.ceiling).toBeCloseTo(-12.2, 10);
    expect(workletParameters.threshold).toBeCloseTo(-15.4, 10);
  });

  it("reports the limiter's realized integer-sample latency at mastering sample rates", () => {
    class FakeAudioParam {
      value = 0;
      setValueAtTime(value: number) {
        this.value = value;
      }
    }
    class FakeGainNode {
      gain = new FakeAudioParam();
      connect<T>(destination: T): T {
        return destination;
      }
      disconnect() {}
    }
    class FakeWorkletNode {
      parameters = new Map(
        ["ceiling", "threshold", "release", "lookahead", "link", "mix"].map((id) => [id, new FakeAudioParam()]),
      );
      port = { onmessage: null as ((event: MessageEvent) => void) | null, close() {} };
      onprocessorerror: ((event: Event) => void) | null = null;
      connect<T>(destination: T): T {
        return destination;
      }
      disconnect() {}
    }

    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    const expectedLatency = (lookaheadMs: number, sampleRate: number) =>
      Math.round(Math.fround(lookaheadMs / 1000) * sampleRate) / sampleRate;
    try {
      for (const sampleRate of [44_100, 48_000, 96_000]) {
        const context = {
          currentTime: 0,
          sampleRate,
          createGain: () => new FakeGainNode(),
        } as unknown as BaseAudioContext;
        const runtime = createLimiterNode(context, { params: {} });
        if (!runtime.getLatencySec || !runtime.setParameter || !runtime.getAudioParam || !runtime.dispose) {
          throw new Error("Limiter runtime is missing its latency or parameter contract.");
        }
        expect(runtime.getLatencySec()).toBe(expectedLatency(5, sampleRate));

        runtime.setParameter("lookaheadMs", 2.3);
        expect(runtime.getLatencySec()).toBe(expectedLatency(2.3, sampleRate));

        runtime.setParameter("lookaheadMs", 30);
        expect(runtime.getLatencySec()).toBe(expectedLatency(20, sampleRate));
        expect(runtime.getAudioParam("lookahead")?.value).toBe(0.02);

        runtime.setParameter("lookaheadMs", 0.2);
        expect(runtime.getLatencySec()).toBe(expectedLatency(1, sampleRate));
        expect(runtime.getAudioParam("lookahead")?.value).toBe(0.001);

        runtime.setParameter("lookaheadMs", Number.NaN);
        expect(runtime.getLatencySec()).toBe(expectedLatency(1, sampleRate));
        runtime.dispose();
      }

      const invalidInitialContext = {
        currentTime: 0,
        sampleRate: 44_100,
        createGain: () => new FakeGainNode(),
      } as unknown as BaseAudioContext;
      const invalidInitialRuntime = createLimiterNode(invalidInitialContext, {
        params: { lookaheadMs: Number.POSITIVE_INFINITY },
      });
      if (
        !invalidInitialRuntime.getLatencySec ||
        !invalidInitialRuntime.getAudioParam ||
        !invalidInitialRuntime.dispose
      ) {
        throw new Error("Limiter runtime is missing its latency or parameter contract.");
      }
      expect(invalidInitialRuntime.getLatencySec()).toBe(expectedLatency(5, 44_100));
      expect(invalidInitialRuntime.getAudioParam("lookahead")?.value).toBe(0.005);
      invalidInitialRuntime.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
