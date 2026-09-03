/**
 * Ultina soak — a master-bus plugin runs for the whole session. This renders
 * 300 seconds of audio through the FULL module graph (all 10 modules enabled)
 * with live parameter traffic and proves the invariants that only appear over
 * time:
 *
 *  1. Output stays finite and bounded for every sample of the render.
 *  2. NO DRIFT: with stationary input and restored parameters, the level at
 *     the end of the render matches the settled level from minute one (a
 *     ratcheting envelope, winding integrator or leaking filter would show).
 *  3. Silence converges to EXACT silence — after the signal stops, every
 *     filter/envelope decays and the tail stays below 1e-4 (no DC offset or
 *     self-oscillation).
 *  4. Heap growth over the session stays bounded (meters snapshots and param
 *     traffic must not accumulate).
 */
import { describe, expect, it } from "vitest";
import { UltinaProcessor } from "../src/effects/ultina-core/dsp/ultinaProcessor.js";
import { registerCoreModules } from "../src/effects/ultina-core/dsp/moduleFactories.js";
import { MODULE_TYPES } from "../src/effects/ultina-core/contracts/moduleTypes.js";

const SR = 48000;
const BLOCK = 128;
const BLOCKS_PER_SECOND = SR / BLOCK;
const SETTLE_SECONDS = 60;
const WOBBLE_END = 240;
const TOTAL_SECONDS = 300;
const TAIL_SILENCE_SECONDS = 20;

/** The settle parameter set — reapplied after the wobble phase so the
 * final window measures the SAME configuration as the first one. */
const SETTLE_STATE: Record<string, number> = {
  "global.inputGainDb": -1,
  "global.outputGainDb": 0,
  "eq.enabled": 1,
  "eq.band0.gainDb": 2,
  "eq.band0.freqHz": 120,
  "comp.enabled": 1,
  "comp.thresholdDb": -24,
  "comp.ratio": 3,
  "comp.attackMs": 12,
  "comp.releaseMs": 140,
  "exciter.enabled": 1,
  "transient.enabled": 1,
  "gate.enabled": 1,
  "gate.thresholdDb": -50,
};

function makeProcessor(): UltinaProcessor {
  const proc = new UltinaProcessor();
  registerCoreModules(proc);
  proc.prepare({ sampleRate: SR, maxBlockSize: BLOCK, channelCount: 2, qualityMode: 1 });
  for (const type of MODULE_TYPES) {
    proc.getGraphRuntime().setModuleEnabled(type, true);
    proc.setParameter(`${type}.enabled`, 1);
  }
  proc.loadState(SETTLE_STATE);
  return proc;
}

/** Deterministic stationary input: 440 Hz sine + seeded noise, fixed level. */
function fill(chans: Float32Array[], blockIndex: number, level = 0.35): void {
  let s = (blockIndex * 97 + 13) & 0x7fffffff;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 2 - 1;
  };
  for (let i = 0; i < BLOCK; i++) {
    const t = (blockIndex * BLOCK + i) / SR;
    const v = level * (0.6 * Math.sin(2 * Math.PI * 440 * t) + 0.4 * rand());
    chans[0][i] = v;
    chans[1][i] = v;
  }
}

/** Seeded wobble schedule: one param touch per ~0.5 s during the middle phase. */
const WOBBLE_PARAMS: [string, (i: number) => number][] = [
  ["comp.thresholdDb", (i) => -30 + (i % 12)],
  ["comp.ratio", (i) => 1.5 + (i % 5)],
  ["eq.band0.gainDb", (i) => ((i % 7) - 3) * 2],
  ["global.outputGainDb", (i) => (i % 5) - 2],
  ["comp.bandCount", (i) => (i % 3) + 1],
  ["comp.crossoverHz1", (i) => 150 + (i % 6) * 60],
  ["comp.crossoverMode", (i) => i % 2],
  ["transient.attack", (i) => ((i % 9) - 4) / 10],
  ["exciter.amount", (i) => (i % 8) / 10],
];

describe("Ultina soak (300 s full-graph render)", () => {
  it(
    "stays finite, does not drift, and decays to silence",
    () => {
      const proc = makeProcessor();
      const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      // Snapshot the FULL settled parameter state — the wobble phase touches
      // params beyond SETTLE_STATE (band count, crossover mode, module
      // amounts), and every one of them must be restored for the no-drift
      // comparison to be honest.
      const settleSnapshot = proc.getAllParameters();

      let nonFinite = 0;
      let maxAbs = 0;
      let settleSumSq = 0;
      let settleSamples = 0;
      let finalSumSq = 0;
      let finalSamples = 0;

      const totalBlocks = TOTAL_SECONDS * BLOCKS_PER_SECOND;
      const settleFrom = 10 * BLOCKS_PER_SECOND;
      const settleTo = SETTLE_SECONDS * BLOCKS_PER_SECOND;
      const finalFrom = (TOTAL_SECONDS - 10) * BLOCKS_PER_SECOND;

      let heapStart = 0;
      if (typeof process !== "undefined" && process.memoryUsage) {
        global.gc?.();
        heapStart = process.memoryUsage().heapUsed;
      }

      for (let b = 0; b < totalBlocks; b++) {
        const second = b / BLOCKS_PER_SECOND;
        fill(input, b);
        chans[0].set(input[0]);
        chans[1].set(input[1]);

        // Middle phase: seeded parameter traffic incl. band-count and
        // crossover-mode switches (the paths the audit touched).
        if (second >= SETTLE_SECONDS && second < WOBBLE_END && b % Math.round(BLOCKS_PER_SECOND / 2) === 0) {
          const i = Math.floor(b / Math.round(BLOCKS_PER_SECOND / 2));
          const [id, valueOf] = WOBBLE_PARAMS[i % WOBBLE_PARAMS.length];
          proc.setParameter(id, valueOf(Math.floor(i / WOBBLE_PARAMS.length)));
        }
        // End of wobble: restore the settled configuration so the final
        // window measures the same setup as the first (state must re-converge).
        if (b === WOBBLE_END * BLOCKS_PER_SECOND) {
          proc.loadState(settleSnapshot);
        }
        // Control-thread meters poll ~2 Hz over the whole session.
        if (b % Math.round(BLOCKS_PER_SECOND / 2) === 0) proc.getMeters();

        proc.process(chans, BLOCK);
        for (let i = 0; i < BLOCK; i++) {
          const l = chans[0][i];
          const r = chans[1][i];
          if (!Number.isFinite(l) || !Number.isFinite(r)) nonFinite++;
          const a = Math.max(Math.abs(l), Math.abs(r));
          if (a > maxAbs) maxAbs = a;
          if (b >= settleFrom && b < settleTo) {
            settleSumSq += l * l + r * r;
            settleSamples += 2;
          }
          if (b >= finalFrom) {
            finalSumSq += l * l + r * r;
            finalSamples += 2;
          }
        }
      }

      expect(nonFinite).toBe(0);
      expect(maxAbs).toBeLessThanOrEqual(32);

      // No drift: identical input + identical restored params → same level.
      const settleRms = Math.sqrt(settleSumSq / settleSamples);
      const finalRms = Math.sqrt(finalSumSq / finalSamples);
      const driftDb = 20 * Math.log10(finalRms / settleRms);
      expect(Math.abs(driftDb)).toBeLessThan(1.0);

      // Tail: silence must converge to silence (peak of the last second).
      const tailBlocks = TAIL_SILENCE_SECONDS * BLOCKS_PER_SECOND;
      let tailPeak = 0;
      for (let b = 0; b < tailBlocks; b++) {
        chans[0].fill(0);
        chans[1].fill(0);
        proc.process(chans, BLOCK);
        if (b >= tailBlocks - BLOCKS_PER_SECOND) {
          for (let i = 0; i < BLOCK; i++) {
            tailPeak = Math.max(tailPeak, Math.abs(chans[0][i]), Math.abs(chans[1][i]));
          }
        }
      }
      expect(tailPeak).toBeLessThan(1e-4);

      if (typeof process !== "undefined" && process.memoryUsage) {
        global.gc?.();
        const growthMb = (process.memoryUsage().heapUsed - heapStart) / (1024 * 1024);
        console.log(`[ultina-soak] heap growth over ${TOTAL_SECONDS}s render: ${growthMb.toFixed(1)} MB (drift ${driftDb.toFixed(3)} dB, tail peak ${tailPeak.toExponential(2)})`);
        expect(growthMb).toBeLessThan(100);
      }
    },
    300_000,
  );
});
