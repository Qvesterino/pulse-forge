import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ensureWorkletsForDoc,
  isWorkletReady,
  loadAllWorklets,
  loadCoreWorklets,
  loadPluginWorklet,
  pluginTypesInDoc,
} from "../src/audio-worklets/loader";

function mockCtx(addModule: (url: string) => Promise<void>): BaseAudioContext {
  return { audioWorklet: { addModule } } as unknown as BaseAudioContext;
}

describe("AudioWorklet loader", () => {
  it("reports not ready for contexts that have not loaded modules", () => {
    expect(isWorkletReady("bitcrusher", {} as BaseAudioContext)).toBe(false);
    expect(isWorkletReady("sidechain", {} as BaseAudioContext)).toBe(false);
    expect(isWorkletReady("limiter", {} as BaseAudioContext)).toBe(false);
    expect(isWorkletReady("compressor", {} as BaseAudioContext)).toBe(false);
    expect(isWorkletReady("fxeq", {} as BaseAudioContext)).toBe(false);
    expect(isWorkletReady("bitcrusher", null)).toBe(false);
    expect(isWorkletReady("sidechain", undefined)).toBe(false);
  });

  it("marks a context ready after CORE modules load (no plugin fetches)", async () => {
    const addModule = vi.fn(async () => {});
    const ctx = mockCtx(addModule);
    await loadCoreWorklets(ctx);
    expect(addModule).toHaveBeenCalledTimes(2); // bitcrusher + core (sidechain, transient, gate, limiter…)
    expect(isWorkletReady("bitcrusher", ctx)).toBe(true);
    expect(isWorkletReady("sidechain", ctx)).toBe(true);
    expect(isWorkletReady("limiter", ctx)).toBe(true);
    expect(isWorkletReady("compressor", ctx)).toBe(true);
    // Vendored plugin suites are NOT loaded by the core path.
    expect(isWorkletReady("fxeq", ctx)).toBe(false);
    expect(isWorkletReady("ultina", ctx)).toBe(false);
    expect(isWorkletReady("ozvena", ctx)).toBe(false);
  });

  it("loads plugin modules on demand, per type", async () => {
    const addModule = vi.fn(async () => {});
    const ctx = mockCtx(addModule);
    await loadPluginWorklet(ctx, "ozvena");
    expect(addModule).toHaveBeenCalledTimes(3); // bitcrusher + core + ozvena
    expect(isWorkletReady("ozvena", ctx)).toBe(true);
    expect(isWorkletReady("fxeq", ctx)).toBe(false);
    // Same type again → cached, no extra fetch.
    await loadPluginWorklet(ctx, "ozvena");
    expect(addModule).toHaveBeenCalledTimes(3);
  });

  it("ensureWorkletsForDoc loads exactly the plugin types the project uses", async () => {
    const addModule = vi.fn(async () => {});
    const ctx = mockCtx(addModule);
    const doc = {
      tracks: [
        { effects: [{ type: "fxeq" }, { type: "tremolo" }] },
        { effects: [] },
        { effects: [{ type: "ultina" }] },
      ],
      returns: [{ effects: [{ type: "ozvena" }] }],
      master: { effects: [{ type: "limiter" }] },
    };
    const ready = await ensureWorkletsForDoc(doc, ctx);
    expect(ready.sort()).toEqual(["fxeq", "ozvena", "ultina"]);
    expect(addModule).toHaveBeenCalledTimes(5); // 2 core + 3 plugins
  });

  it("pluginTypesInDoc scans tracks, returns and master (pure)", () => {
    expect(pluginTypesInDoc(null)).toEqual([]);
    expect(
      pluginTypesInDoc({
        tracks: [{ effects: [{ type: "fxeq" }] }],
        returns: [{ effects: [{ type: "ozvena" }, { type: "ozvena" }] }],
        master: { effects: [{ type: "bitcrusher" }] },
      }),
    ).toEqual(["fxeq", "ozvena"]);
  });

  it("tracks readiness per context — offline renders are separate contexts", async () => {
    // Regression: a global ready flag made factories construct
    // AudioWorkletNodes in OfflineAudioContexts where the processor was
    // never registered, which throws during freeze/bounce/export.
    const live = mockCtx(async () => {});
    await loadCoreWorklets(live);
    const offline = mockCtx(async () => {});
    expect(isWorkletReady("bitcrusher", live)).toBe(true);
    expect(isWorkletReady("bitcrusher", offline)).toBe(false);
  });

  it("loads each context only once", async () => {
    const addModule = vi.fn(async () => {});
    const ctx = mockCtx(addModule);
    await loadCoreWorklets(ctx);
    await loadCoreWorklets(ctx);
    expect(addModule).toHaveBeenCalledTimes(2);
  });

  it("never rejects and keeps fallback on addModule failure", async () => {
    const ctx = mockCtx(async () => {
      throw new Error("404 module not found");
    });
    await expect(loadCoreWorklets(ctx)).resolves.toBeUndefined();
    expect(isWorkletReady("bitcrusher", ctx)).toBe(false);
    expect(isWorkletReady("sidechain", ctx)).toBe(false);
    // Plugin loads on a failed context are also graceful no-ops.
    await expect(loadPluginWorklet(ctx, "fxeq")).resolves.toBeUndefined();
    expect(isWorkletReady("fxeq", ctx)).toBe(false);
  });

  it("loadAllWorklets still fetches every module (browser check suite)", async () => {
    const addModule = vi.fn(async () => {});
    const ctx = mockCtx(addModule);
    await loadAllWorklets(ctx);
    // 6th entry added by the granularFreeze worklet (FX expansion phase 4).
    expect(addModule).toHaveBeenCalledTimes(6);
    expect(isWorkletReady("fxeq", ctx)).toBe(true);
    expect(isWorkletReady("ultina", ctx)).toBe(true);
    expect(isWorkletReady("ozvena", ctx)).toBe(true);
  });

  it("resolves silently without audioWorklet (jsdom)", async () => {
    await expect(loadCoreWorklets({} as BaseAudioContext)).resolves.toBeUndefined();
  });
});

describe("AudioWorklet stereo output contract", () => {
  it("declares stereo output for every stereo FX worklet wrapper", () => {
    const directory = resolve(process.cwd(), "src/audio-worklets");
    // Envelope follower emits a mono control signal; all other signal FX
    // wrappers in this directory are stereo processors. AudioWorkletNode's
    // `channelCount: 2` configures inputs only and does not make its output
    // stereo, so each signal processor must declare outputChannelCount.
    const monoControlNodes = new Set(["envfollower-node.ts"]);
    const files = readdirSync(directory).filter(
      (file) => file.endsWith("-node.ts") && !monoControlNodes.has(file),
    );

    for (const file of files) {
      const source = readFileSync(resolve(directory, file), "utf8");
      if (!/numberOfOutputs:\s*1/.test(source)) continue;
      expect(source, `${file} must explicitly declare two output channels`).toMatch(
        /outputChannelCount:\s*\[\s*2\s*\]/,
      );
    }
  });

  it("keeps direct FX and instrument worklet constructors stereo too", () => {
    for (const [path, worklet] of [
      ["src/effects/fxeqNode.ts", "fxeq"],
      ["src/effects/ultinaNode.ts", "ultina"],
      ["src/effects/ozvenaNode.ts", "ozvena"],
    ]) {
      const source = readFileSync(resolve(process.cwd(), path), "utf8");
      expect(source, `${worklet} constructor must declare stereo output`).toMatch(
        /outputChannelCount:\s*\[\s*2\s*\]/,
      );
    }

    const instrumentSource = readFileSync(resolve(process.cwd(), "src/instruments/registry.ts"), "utf8");
    const svFilterOptions = instrumentSource.match(
      /new AudioWorkletNode\(ctx,\s*"svfilter-processor",\s*\{([\s\S]*?)\}\)/,
    )?.[1];
    expect(svFilterOptions, "SV Filter instrument node options").toMatch(/outputChannelCount:\s*\[\s*2\s*\]/);
  });
});

describe("Bitcrusher processor (unit logic)", () => {
  it("quantizes values to bit depth levels", () => {
    // Simulate the processor's bit reduction logic
    const bits = 2;
    const levels = Math.max(2, Math.pow(2, Math.max(1, Math.round(bits))));
    const step = 2 / (levels - 1);
    // Input: 0.3 → quantize to nearest level
    const input = 0.3;
    const quantized = Math.round((input + 1) / step) * step - 1;
    expect(quantized).toBeGreaterThanOrEqual(-1);
    expect(quantized).toBeLessThanOrEqual(1);
    // With 2 bits (4 levels), step = 2/3 ≈ 0.667
    // 0.3 → round((0.3+1)/0.667) * 0.667 - 1 = round(1.95) * 0.667 - 1 = 2*0.667 - 1 = 0.333
    expect(quantized).toBeCloseTo(0.333, 2);
  });

  it("downsample holds value for N samples", () => {
    // Simulate sample-and-hold
    let heldValue = 0;
    let counter = 0;
    const downsample = 4;
    const input = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    const output: number[] = [];

    for (let i = 0; i < input.length; i++) {
      if (counter === 0) {
        heldValue = input[i];
      }
      output.push(heldValue);
      counter = (counter + 1) % downsample;
    }

    // With downsample=4: hold each value for 4 samples
    expect(output[0]).toBe(0.1); // sample 0 → hold 0.1
    expect(output[1]).toBe(0.1); // sample 1 → still 0.1
    expect(output[2]).toBe(0.1); // sample 2 → still 0.1
    expect(output[3]).toBe(0.1); // sample 3 → still 0.1
    expect(output[4]).toBe(0.5); // sample 4 → new hold 0.5
    expect(output[5]).toBe(0.5); // sample 5 → still 0.5
  });
});

describe("Sidechain processor (unit logic)", () => {
  it("envelope follower tracks peak with attack/release", () => {
    // Simulate asymmetric envelope follower
    const sampleRate = 44100;
    const attack = 0.005;
    const release = 0.2;
    const attackCoef = Math.exp(-1 / (sampleRate * attack));
    const releaseCoef = Math.exp(-1 / (sampleRate * release));

    let env = 0;
    // Simulate a signal with a sharp attack and slow release
    const signal = [0, 0, 0, 0.8, 0.8, 0.8, 0, 0, 0, 0];

    for (let i = 0; i < signal.length; i++) {
      const peak = Math.abs(signal[i]);
      env = peak > env ? attackCoef * env + (1 - attackCoef) * peak : releaseCoef * env + (1 - releaseCoef) * peak;
    }

    // After the signal drops to 0, env should still be > 0 (release phase)
    expect(env).toBeGreaterThan(0);
    expect(env).toBeLessThan(1);
  });

  it("gain reduction increases with higher ratio", () => {
    const threshold = -18;
    const envDb = -10; // 8 dB above threshold
    const threshDb = threshold;

    const overDb = Math.max(0, envDb - threshDb);

    const lowRatio = 2;
    const highRatio = 10;

    const reductionLow = overDb * (1 - 1 / lowRatio);
    const reductionHigh = overDb * (1 - 1 / highRatio);

    expect(reductionHigh).toBeGreaterThan(reductionLow);
  });
});
