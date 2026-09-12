/**
 * Ultina worklet entry regression — runs the REAL bundled entry
 * (src/effects/ultina-worklet.entry.js) under a stubbed AudioWorklet scope.
 *
 * Pins the module-graph sync: the graph boots all-disabled and the entry is
 * the ONLY layer that mirrors "<module>.enabled" params into it. Without that
 * sync the active chain stays empty forever — the whole module DSP never runs
 * in the shipped app while the UI reports it on (regression discovered while
 * building the numeric-stress suite).
 */
import { beforeAll, describe, expect, it } from "vitest";

interface PostedMessage {
  type?: string;
  samples?: number;
  meters?: { modules?: Record<string, unknown>; global?: { timestamp?: number } };
}

class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  posted: PostedMessage[] = [];
  postMessage(msg: unknown): void {
    this.posted.push(msg as PostedMessage);
  }
  last(type: string): PostedMessage | undefined {
    return [...this.posted].reverse().find((m) => m.type === type);
  }
}

class FakeAudioWorkletProcessor {
  port = new FakePort();
}

interface ProcShape {
  port: FakePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

type ProcCtor = new (options?: { processorOptions?: { params?: Record<string, number> } }) => ProcShape;

let Processor: ProcCtor;
/** Render clock for the worklet scope — tests advance it per quantum. */
let now = 0;

beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = 48000;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (_name: string, cls: ProcCtor) => {
    Processor = cls;
  };
  Object.defineProperty(globalThis, "currentTime", {
    get: () => now,
    configurable: true,
  });
  // @ts-expect-error untyped .js worklet entry (gallery-server.test.ts convention)
  await import("../src/effects/ultina-worklet.entry.js");
  if (!Processor) throw new Error("ultina-processor did not register");
});

const SR = 48000;
const BLOCK = 128;

function fillSine(chans: Float32Array[], blockIndex: number, amplitude: number): void {
  for (let i = 0; i < BLOCK; i++) {
    const t = (blockIndex * BLOCK + i) / SR;
    const v = amplitude * Math.sin(2 * Math.PI * 1000 * t);
    chans[0][i] = v;
    chans[1][i] = v;
  }
}

/** Run blocks through the entry; return [outputRms, inputRms]. */
function run(proc: ProcShape, blocks: number, amplitude: number): [number, number] {
  const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  const output = [[new Float32Array(BLOCK), new Float32Array(BLOCK)]];
  let sumSq = 0;
  let inSumSq = 0;
  let n = 0;
  for (let b = 0; b < blocks; b++) {
    fillSine(input, b, amplitude);
    proc.process([input], output);
    // Measure only the settled tail.
    if (b >= blocks - 8) {
      for (let i = 0; i < BLOCK; i++) {
        sumSq += output[0][0][i] * output[0][0][i];
        inSumSq += input[0][i] * input[0][i];
        n += 1;
      }
    }
  }
  return [Math.sqrt(sumSq / n), Math.sqrt(inSumSq / n)];
}

const COMP_ON: Record<string, number> = {
  "comp.enabled": 1,
  // Per-band thresholds OVERRIDE comp.thresholdDb when present (schema
  // defaults −20), so a deterministic test must pin all of them.
  "comp.thresholdDb": -40,
  "comp.band0.thresholdDb": -40,
  "comp.band1.thresholdDb": -40,
  "comp.band2.thresholdDb": -40,
  "comp.ratio": 20,
  "comp.detectionMode": 0, // peak — amplitude-direct, no RMS window shaping
  "comp.attackMs": 5,
  "comp.releaseMs": 120,
  "comp.makeupDb": 0,
};

describe("Ultina worklet entry — module graph sync", () => {
  it("an enabled compressor actually compresses audio through the entry", () => {
    const proc = new Processor({ processorOptions: { params: { ...COMP_ON } } });
    const [outRms, inRms] = run(proc, 200, 0.158); // −16 dBFS sine
    // Threshold −40, ratio 20, peak detection → ≈23 dB gain reduction.
    expect(outRms).toBeGreaterThan(0);
    expect(outRms / inRms).toBeLessThan(0.3);
  });

  it("module meters are published once the module is enabled (graph populated)", () => {
    const proc = new Processor({ processorOptions: { params: { ...COMP_ON } } });
    run(proc, 12, 0.158);
    const meters = proc.port.last("meters");
    expect(meters).toBeDefined();
    expect(meters?.meters?.modules?.comp).toBeDefined();
  });

  it("disabling the module via a param message returns the chain to passthrough", () => {
    const proc = new Processor({ processorOptions: { params: { ...COMP_ON } } });
    run(proc, 100, 0.158);
    proc.port.onmessage?.({ data: { type: "param", id: "comp.enabled", value: 0 } });
    const [outRms, inRms] = run(proc, 100, 0.158);
    expect(outRms / inRms).toBeGreaterThan(0.9);
  });

  it("hybrid crossover latency is reported over the port after the first block configures it", () => {
    const proc = new Processor({
      processorOptions: {
        params: { ...COMP_ON, "comp.bandCount": 2, "comp.crossoverHz1": 200, "comp.crossoverMode": 1 },
      },
    });
    // The crossover (and its latency) is applied on the first processed
    // block; the meters-cadence latency re-post then reports it.
    run(proc, 12, 0.158);
    const latency = proc.port.last("latency");
    expect(latency?.type).toBe("latency");
    expect(latency?.samples).toBe(31); // DEFAULT_FIR_TAPS=63 → (63−1)/2
  });

  it("a fresh instance with no enabled modules is a clean passthrough", () => {
    const proc = new Processor({ processorOptions: { params: {} } });
    const [outRms, inRms] = run(proc, 100, 0.3);
    expect(Math.abs(outRms / inRms - 1)).toBeLessThan(0.02);
  });
});

describe("Ultina worklet entry — metering gate", () => {
  function metersPosted(proc: ProcShape): number {
    return proc.port.posted.filter((m) => m.type === "meters").length;
  }

  it("meters post by default, stop after setMeters:false, resume after true", () => {
    const proc = new Processor({ processorOptions: { params: {} } });
    run(proc, 20, 0.2);
    const before = metersPosted(proc);
    expect(before).toBeGreaterThan(0); // worklet-side default is ON

    proc.port.onmessage?.({ data: { type: "setMeters", enabled: false } });
    const atDisable = metersPosted(proc);
    run(proc, 80, 0.2);
    expect(metersPosted(proc)).toBe(atDisable); // zero postings while gated

    proc.port.onmessage?.({ data: { type: "setMeters", enabled: true } });
    run(proc, 20, 0.2);
    expect(metersPosted(proc)).toBeGreaterThan(atDisable); // resumed
  });

  it("setMeters message with a missing flag re-enables (defensive default)", () => {
    const proc = new Processor({ processorOptions: { params: {} } });
    proc.port.onmessage?.({ data: { type: "setMeters", enabled: false } });
    run(proc, 40, 0.2);
    expect(metersPosted(proc)).toBe(0);
    proc.port.onmessage?.({ data: { type: "setMeters" } });
    run(proc, 20, 0.2);
    expect(metersPosted(proc)).toBeGreaterThan(0);
  });
});

describe("Ultina worklet entry — scheduled parameters (paramAt)", () => {
  /** Run blocks advancing the render clock one quantum per block; returns
   *  [outputRms, inputRms] measured over the settled tail. */
  function runTimed(proc: ProcShape, blocks: number, amplitude: number): [number, number] {
    const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    const output = [[new Float32Array(BLOCK), new Float32Array(BLOCK)]];
    let sumSq = 0;
    let inSumSq = 0;
    let n = 0;
    for (let b = 0; b < blocks; b++) {
      now = (b * BLOCK) / SR;
      fillSine(input, b, amplitude);
      proc.process([input], output);
      if (b >= blocks - 8) {
        for (let i = 0; i < BLOCK; i++) {
          sumSq += output[0][0][i] * output[0][0][i];
          inSumSq += input[0][i] * input[0][i];
          n += 1;
        }
      }
    }
    now = (blocks * BLOCK) / SR;
    return [Math.sqrt(sumSq / n), Math.sqrt(inSumSq / n)];
  }

  it("a paramAt event applies only once the render clock reaches it", () => {
    now = 0;
    const proc = new Processor({ processorOptions: { params: {} } });
    // Reference level with the effect active but no automation.
    const [refRms, inRms] = runTimed(proc, 40, 0.3);
    expect(Math.abs(refRms / inRms - 1)).toBeLessThan(0.02);

    // Fresh instance: schedule −20 dB output gain at t=0.25 s (schema min
    // is −24 dB — values beyond it clamp at the DSP boundary).
    now = 0;
    const proc2 = new Processor({ processorOptions: { params: {} } });
    proc2.port.onmessage?.({
      data: { type: "paramAt", id: "global.outputGainDb", value: -20, when: 0.25 },
    });
    // Before the due time: untouched (≈ unity).
    const [beforeRms] = runTimed(proc2, Math.round((0.2 * SR) / BLOCK), 0.3);
    expect(beforeRms / inRms).toBeGreaterThan(0.9);
    // Across the due time: the drop lands (0.1 × + smoother residual).
    const [afterRms] = runTimed(proc2, Math.round((0.35 * SR) / BLOCK), 0.3);
    expect(afterRms / inRms).toBeLessThan(0.15);
  });

  it("a manual param cancels pending scheduled events for that id", () => {
    now = 0;
    const proc = new Processor({ processorOptions: { params: {} } });
    const [, inRms] = runTimed(proc, 8, 0.3);
    proc.port.onmessage?.({
      data: { type: "paramAt", id: "global.outputGainDb", value: -20, when: 0.1 },
    });
    // User touches the same knob before the event fires.
    proc.port.onmessage?.({ data: { type: "param", id: "global.outputGainDb", value: 0 } });
    const [outRms] = runTimed(proc, Math.round((0.3 * SR) / BLOCK), 0.3);
    expect(outRms / inRms).toBeGreaterThan(0.9);
  });

  it("a malformed timestamp degrades to an immediate set", () => {
    now = 0;
    const proc = new Processor({ processorOptions: { params: {} } });
    const [, inRms] = runTimed(proc, 8, 0.3);
    proc.port.onmessage?.({
      data: { type: "paramAt", id: "global.outputGainDb", value: -20, when: Number.NaN },
    });
    // 20 blocks later the −20 dB gain is most of the way through its 20 ms
    // smoother (pre-fix: no paramAt handler at all → unity passthrough).
    const [outRms] = runTimed(proc, 20, 0.3);
    expect(outRms / inRms).toBeLessThan(0.5);
  });
});

describe("Ultina worklet entry — .enabled scheduled via paramAt (graph re-sync)", () => {
  it("a scheduled module toggle starts processing only after its due time", () => {
    now = 0;
    const proc = new Processor({ processorOptions: { params: {} } });
    const runBlocks = (blocks: number): boolean => {
      const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      const output = [[new Float32Array(BLOCK), new Float32Array(BLOCK)]];
      let sawComp = false;
      for (let b = 0; b < blocks; b++) {
        now = (b * BLOCK) / SR;
        fillSine(input, b, 0.3);
        proc.process([input], output);
      }
      const meters = [...proc.port.posted].reverse().find((m) => m.type === "meters");
      const mods = (meters?.meters as { modules?: Record<string, unknown> } | undefined)?.modules;
      sawComp = Boolean(mods?.comp);
      return sawComp;
    };

    runBlocks(8); // settle
    let before = [...proc.port.posted].reverse().find((m) => m.type === "meters");
    expect((before?.meters as { modules?: Record<string, unknown> } | undefined)?.modules?.comp).toBeUndefined();

    // Schedule comp.enable at t = 0.2 s (≈ block 75 at 48 kHz / 128).
    proc.port.onmessage?.({
      data: { type: "paramAt", id: "comp.enabled", value: 1, when: 0.2 },
    });
    now = 0;
    runBlocks(Math.round((0.35 * SR) / BLOCK)); // run past the due time
    const after = [...proc.port.posted].reverse().find((m) => m.type === "meters");
    expect((after?.meters as { modules?: Record<string, unknown> } | undefined)?.modules?.comp).toBeDefined();
  });
});

describe("Ultina worklet entry — parameter burst (live drag preview)", () => {
  it("survives 200 rapid param messages per block; the last value wins; output stays finite", () => {
    now = 0;
    const proc = new Processor({ processorOptions: { params: {} } });
    const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    const output = [[new Float32Array(BLOCK), new Float32Array(BLOCK)]];
    let nonFinite = 0;
    for (let b = 0; b < 20; b++) {
      now = (b * BLOCK) / SR;
      fillSine(input, b, 0.3);
      // Simulate a maximally chatty drag: 100 immediate + 100 scheduled params.
      for (let k = 0; k < 100; k++) {
        proc.port.onmessage?.({
          data: { type: "param", id: "global.outputGainDb", value: -6 + k * 0.01 },
        });
      }
      for (let k = 0; k < 100; k++) {
        proc.port.onmessage?.({
          data: { type: "paramAt", id: "global.inputGainDb", value: -6 + k * 0.01, when: now },
        });
      }
      proc.process([input], output);
      for (let i = 0; i < BLOCK; i++) {
        if (!Number.isFinite(output[0][0][i])) nonFinite++;
      }
    }
    expect(nonFinite).toBe(0);
    // Settle phase — no more messages: the 20 ms gain smoother converges to
    // the LAST posted value, proving ordering survived the burst.
    for (let b = 20; b < 60; b++) {
      now = (b * BLOCK) / SR;
      fillSine(input, b, 0.3);
      proc.process([input], output);
    }
    // Both scheduled params converge to their last value (−6 + 99·0.01 ≈
    // −5.01 dB each): the source passes input gain × output gain.
    const sourceRms = 0.3 * Math.SQRT1_2;
    let sumSq = 0;
    for (let i = 0; i < BLOCK; i++) sumSq += output[0][0][i] * output[0][0][i];
    const outRms = Math.sqrt(sumSq / BLOCK);
    const expected = sourceRms * Math.pow(10, -5.01 / 20) * Math.pow(10, -5.01 / 20);
    expect(outRms).toBeGreaterThan(expected * 0.9);
    expect(outRms).toBeLessThan(expected * 1.1);
  });
});

describe("Ultina worklet entry — latency reporting (meters-gate regression)", () => {
  it("re-posts latency when a latency-affecting param changes with meters DISABLED", () => {
    now = 0;
    // App default state: meters OFF (no panel attached), comp active in
    // ANALOG 1-band mode (latency 0).
    const proc = new Processor({
      processorOptions: { params: { "comp.enabled": 1 } },
    });
    proc.port.onmessage?.({ data: { type: "setMeters", enabled: false } });
    const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    const output = [[new Float32Array(BLOCK), new Float32Array(BLOCK)]];
    for (let b = 0; b < 8; b++) {
      now = (b * BLOCK) / SR;
      fillSine(input, b, 0.3);
      proc.process([input], output);
    }
    const latencyZero = proc.port.posted.filter((m) => m.type === "latency");
    expect(latencyZero[latencyZero.length - 1]?.samples).toBe(0);

    // Hybrid 3-band crossover: comp latency becomes the FIR group delay
    // (31 samples) — a NON-".enabled" param. Pre-fix this was never
    // re-posted while meters were off.
    proc.port.onmessage?.({ data: { type: "param", id: "comp.crossoverMode", value: 1 } });
    proc.port.onmessage?.({ data: { type: "param", id: "comp.bandCount", value: 3 } });
    for (let b = 8; b < 16; b++) {
      now = (b * BLOCK) / SR;
      fillSine(input, b, 0.3);
      proc.process([input], output);
    }
    const hybrid = [...proc.port.posted].reverse().find((m) => m.type === "latency");
    expect(hybrid?.samples).toBe(31); // (DEFAULT_FIR_TAPS − 1) / 2 = 31

    // HQ quality mode arms the oversampler INSIDE comp.process() on the
    // next block (+4 samples) — only the per-block re-report catches it.
    proc.port.onmessage?.({ data: { type: "param", id: "global.qualityMode", value: 2 } });
    for (let b = 16; b < 24; b++) {
      now = (b * BLOCK) / SR;
      fillSine(input, b, 0.3);
      proc.process([input], output);
    }
    const hq = [...proc.port.posted].reverse().find((m) => m.type === "latency");
    expect(hq?.samples).toBe(35); // 31 + OS_LATENCY_SAMPLES (4)
  });
});

describe("Ultina worklet entry — hardening regressions (2026-09-12)", () => {
  it("dispose stops processing (process returns false afterwards)", () => {
    const proc = new Processor({ processorOptions: { params: {} } });
    proc.port.onmessage?.({ data: { type: "dispose" } });
    const out = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    // Mirrors Ozvena: a quantum pulled between the dispose message and the
    // main thread's node.disconnect() must not run DSP (or post latency).
    expect(proc.process([out], [out])).toBe(false);
  });

  it("meter postings run ≈21 Hz (every 16th block), not every 4th", () => {
    const proc = new Processor({ processorOptions: { params: {} } });
    run(proc, 64, 0.2);
    const posts = proc.port.posted.filter((m) => m.type === "meters").length;
    // 64 blocks / 16 = 4 snapshots (the first block posts too). The old
    // mask (& 3) produced 16 posts — 4× the documented main-thread load.
    expect(posts).toBeGreaterThanOrEqual(3);
    expect(posts).toBeLessThanOrEqual(5);
  });
});
