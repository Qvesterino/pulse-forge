/**
 * Ultina numeric-stress suite — proves the DSP stays FINITE and BOUNDED
 * under every parameter extreme and poisoned input, the invariant a master-bus
 * plugin must never break (a NaN on the master is silence on the master).
 *
 * Covered here:
 *  1. Every module at ALL-params-min / ALL-params-max / alternating extremes.
 *  2. All modules enabled at once at worst-case gain staging.
 *  3. NaN/Inf poisoned AUDIO mid-stream — state must re-converge afterwards.
 *  4. NaN/Inf PARAMETERS (bad automation, corrupted store) — must be clamped
 *     to a legal value, never reach the audio path.
 *  5. Parameter-queue overflow (ring-buffer wrap under a knob storm).
 */
import { describe, expect, it } from "vitest";
import { UltinaProcessor } from "../src/effects/ultina-core/dsp/ultinaProcessor.js";
import { registerCoreModules } from "../src/effects/ultina-core/dsp/moduleFactories.js";
import { ALL_PARAMS, PARAM_BY_ID, buildDefaultParams } from "../src/effects/ultina-core/contracts/parameterSchema.js";
import { MODULE_TYPES } from "../src/effects/ultina-core/contracts/moduleTypes.js";

const SR = 48000;
const BLOCK = 128;
const BLOCKS = Math.round((0.3 * SR) / BLOCK);

function makeProcessor(): UltinaProcessor {
  const proc = new UltinaProcessor();
  registerCoreModules(proc);
  proc.prepare({ sampleRate: SR, maxBlockSize: BLOCK, channelCount: 2, qualityMode: 1 });
  return proc;
}

/** The audio thread walks the module GRAPH, which boots all-disabled — exactly
 * what the worklet entry mirrors from the "<module>.enabled" params. Tests
 * must do the same sync or they only ever exercise the passthrough path. */
function enableInGraph(proc: UltinaProcessor, moduleType: string): void {
  proc.getGraphRuntime().setModuleEnabled(moduleType as never, true);
  proc.setParameter(`${moduleType}.enabled`, 1);
}

/** Processor with every module in the graph and enabled — the deep-interaction case. */
function makeFullProcessor(): UltinaProcessor {
  const proc = makeProcessor();
  for (const moduleType of MODULE_TYPES) enableInGraph(proc, moduleType);
  return proc;
}

/** Deterministic stereo noise + 440 Hz sine blend. */
function fillSignal(chans: Float32Array[], blockIndex: number, amplitude = 0.4): void {
  let s = (blockIndex * 2654435761) & 0x7fffffff;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 2 - 1;
  };
  for (let i = 0; i < BLOCK; i++) {
    const t = (blockIndex * BLOCK + i) / SR;
    const v = amplitude * (0.6 * Math.sin(2 * Math.PI * 440 * t) + 0.4 * rand());
    chans[0][i] = v;
    chans[1][i] = v;
  }
}

interface RenderResult {
  maxAbs: number;
  nonFinite: number;
  tailRms: number;
}

function render(proc: UltinaProcessor, blocks = BLOCKS, poisonAtBlock = -1, tailBlocks = 10): RenderResult {
  const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  let maxAbs = 0;
  let nonFinite = 0;
  let sumSq = 0;
  let tailSamples = 0;
  for (let b = 0; b < blocks; b++) {
    fillSignal(chans, b);
    if (b === poisonAtBlock) {
      chans[0][BLOCK >> 1] = NaN;
      chans[1][BLOCK >> 1] = Infinity;
      chans[0][(BLOCK >> 1) + 1] = -Infinity;
    }
    proc.process(chans, BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      const l = chans[0][i];
      const r = chans[1][i];
      if (!Number.isFinite(l) || !Number.isFinite(r)) nonFinite++;
      maxAbs = Math.max(maxAbs, Math.abs(l), Math.abs(r));
      if (b >= blocks - tailBlocks) {
        sumSq += l * l + r * r;
        tailSamples += 2;
      }
    }
  }
  return { maxAbs, nonFinite, tailRms: Math.sqrt(sumSq / Math.max(1, tailSamples)) };
}

function setModuleParams(
  proc: UltinaProcessor,
  module: string,
  value: (defMin: number, defMax: number, index: number) => number,
): void {
  let index = 0;
  for (const def of ALL_PARAMS) {
    if (def.id.startsWith(`${module}.`)) {
      proc.setParameter(def.id, value(def.minValue, def.maxValue, index++));
    }
  }
}

describe("Ultina numeric stress — parameter extremes", () => {
  const CASES: { name: string; value: (min: number, max: number, index: number) => number }[] = [
    { name: "all-min", value: (min) => min },
    { name: "all-max", value: (_min, max) => max },
    { name: "alternating extremes", value: (min, max, i) => (i % 2 === 0 ? min : max) },
  ];

  for (const moduleType of MODULE_TYPES) {
    for (const c of CASES) {
      it(`${moduleType} survives ${c.name}`, () => {
        const proc = makeProcessor();
        setModuleParams(proc, moduleType, c.value);
        enableInGraph(proc, moduleType);
        const r = render(proc);
        expect(r.nonFinite).toBe(0);
        expect(r.maxAbs).toBeLessThanOrEqual(32);
      });
    }
  }

  it("all modules enabled at alternating extremes + worst-case gain staging stays finite and bounded", () => {
    const proc = makeFullProcessor();
    for (const moduleType of MODULE_TYPES)
      setModuleParams(proc, moduleType, (min, max, i) => (i % 2 === 0 ? min : max));
    proc.setParameter("global.inputGainDb", 24);
    proc.setParameter("global.outputGainDb", 24);
    const r = render(proc);
    expect(r.nonFinite).toBe(0);
    expect(r.maxAbs).toBeLessThanOrEqual(32);
  });
});

describe("Ultina numeric stress — poisoned audio", () => {
  it("NaN/Inf samples are sanitized and state re-converges after the poison block", () => {
    // Same configuration, rendered twice: once with a poison block in the
    // middle, once clean. After the poison, the DSP must re-converge to the
    // clean trajectory (within 3 dB) — a permanently-poisoned filter state
    // would show up as a collapsed or runaway tail.
    const makeConfigured = (): UltinaProcessor => {
      const proc = makeProcessor();
      enableInGraph(proc, "comp");
      proc.setParameter("comp.ratio", 4);
      proc.setParameter("comp.thresholdDb", -30);
      enableInGraph(proc, "exciter");
      enableInGraph(proc, "eq");
      return proc;
    };

    const reference = render(makeConfigured(), 220);
    expect(reference.nonFinite).toBe(0);

    const poisoned = render(makeConfigured(), 220, 60);
    expect(poisoned.nonFinite).toBe(0);
    expect(poisoned.maxAbs).toBeLessThanOrEqual(32);
    expect(poisoned.tailRms).toBeGreaterThan(0);
    const tailDeltaDb = Math.abs(20 * Math.log10(poisoned.tailRms / reference.tailRms));
    expect(tailDeltaDb).toBeLessThan(3);
  });
});

describe("Ultina numeric stress — poisoned parameters", () => {
  it("setParameter with NaN/Infinity never stores a non-finite value", () => {
    const proc = makeProcessor();
    for (const def of ALL_PARAMS) {
      proc.setParameter(def.id, NaN);
      expect(Number.isFinite(proc.getParameter(def.id))).toBe(true);
      proc.setParameter(def.id, Infinity);
      expect(Number.isFinite(proc.getParameter(def.id))).toBe(true);
      proc.setParameter(def.id, -Infinity);
      expect(Number.isFinite(proc.getParameter(def.id))).toBe(true);
    }
  });

  it("loadState with NaN values clamps to legal values and still renders finite audio", () => {
    const proc = makeProcessor();
    const poisoned: Record<string, number> = {};
    for (const def of ALL_PARAMS) poisoned[def.id] = NaN;
    proc.loadState(poisoned);
    for (const def of ALL_PARAMS) {
      expect(Number.isFinite(proc.getParameter(def.id))).toBe(true);
    }
    const r = render(proc);
    expect(r.nonFinite).toBe(0);
  });

  it("a fully NaN-poisoned state with every module enabled still renders bounded audio", () => {
    const proc = makeProcessor();
    const params = buildDefaultParams();
    for (const moduleType of MODULE_TYPES) params[`${moduleType}.enabled`] = 1;
    for (const def of PARAM_BY_ID.values()) {
      if (params[def.id] !== undefined) params[def.id] = NaN;
    }
    proc.loadState(params);
    const r = render(proc);
    expect(r.nonFinite).toBe(0);
    expect(r.maxAbs).toBeLessThanOrEqual(32);
  });
});

describe("Ultina numeric stress — parameter queue", () => {
  it("a 5000-update knob storm (ring wrap) still lets the FINAL values reach the audio path", () => {
    const makeConfigured = (outputGainDb: number): UltinaProcessor => {
      const proc = makeProcessor();
      enableInGraph(proc, "comp");
      proc.setParameter("comp.ratio", 4);
      proc.setParameter("comp.thresholdDb", -30);
      // Storm past the 1024-slot ring many times over, then set the winners
      // WHILE the queue is still full — they must not be silently dropped.
      for (let i = 0; i < 5000; i++) {
        proc.setParameter("comp.thresholdDb", -60 + (i % 61));
        proc.setParameter("global.outputGainDb", (i % 9) - 4);
      }
      proc.setParameter("comp.thresholdDb", -12);
      proc.setParameter("global.outputGainDb", outputGainDb);
      // One block drains the storm; the winners above must be the state the
      // audio thread converged to.
      proc.process([new Float32Array(BLOCK), new Float32Array(BLOCK)], BLOCK);
      return proc;
    };

    // Both runs share the same compression (GR is gain-independent), so the
    // tail ratio isolates the output-gain winner: ≈ +6 dB if it arrived.
    const unity = render(makeConfigured(0));
    const boosted = render(makeConfigured(6));
    expect(boosted.nonFinite).toBe(0);
    const gainDb = 20 * Math.log10(boosted.tailRms / unity.tailRms);
    expect(gainDb).toBeGreaterThan(4.5);
    expect(gainDb).toBeLessThan(7.5);
    expect(makeConfigured(0).getParameter("comp.thresholdDb")).toBe(-12);
  });
});
