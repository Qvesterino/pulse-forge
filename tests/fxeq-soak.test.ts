/**
 * FXEQ soak — the missing long-session leg of the flagship trio (ultina and
 * ozvena each have one). PRISM rides the master bus for whole sessions, and
 * its oversampler/limiter/reverb-FDN are exactly the modules the recent
 * allocation-hardening campaign touched — the paths where slow leaks, drift
 * and non-converging tails show up only over time. This renders 300 seconds
 * through the FULL worst-case graph (6 bands, every module enabled) with live
 * parameter traffic and proves the same invariants as the sibling soaks:
 *
 *  1. Output stays finite and bounded for every sample of the render.
 *  2. NO DRIFT: with stationary input and the restored parameter snapshot,
 *     the level at the end of the render matches the settled level from
 *     minute one (a ratcheting envelope, winding integrator or leaking
 *     filter would show).
 *  3. Silence converges to silence — after the signal stops, the reverb FDN
 *     (fb ≤ 0.99/line), delay feedback (≤ 0.92), envelope followers and the
 *     limiter release fully; the tail stays below 1e-4 (no DC offset or
 *     self-oscillation).
 *  4. Heap growth over the session stays bounded (band-peak metering and
 *     parameter traffic must not accumulate).
 */
import { describe, expect, it } from "vitest";
import { createFxEqProcessor } from "../src/effects/fxeq-core/core/fxEqProcessor.js";

const SR = 48000;
const BLOCK = 128;
const BLOCKS_PER_SECOND = SR / BLOCK;
const SETTLE_SECONDS = 60;
const WOBBLE_END = 240;
const TOTAL_SECONDS = 300;
const TAIL_SILENCE_SECONDS = 20;

/** Worst-case graph: 6 bands, every module enabled (mirrors the CPU-budget
 * probe), moderate levels. The limiter ceiling is backed off so the level
 * comparisons are limiter-static (ceiling restored with the snapshot). */
const SETTLE_PARAMS: Record<string, number> = {
  bandCount: 6,
  limiterEnabled: 1,
  limiterCeilDb: -0.3,
};
for (let b = 1; b <= 6; b++) {
  SETTLE_PARAMS[`band${b}.enabled`] = 1;
  SETTLE_PARAMS[`band${b}.freqHz`] = 80 * Math.pow(1.9, b - 1);
  SETTLE_PARAMS[`band${b}.gainDb`] = 2;
  for (const mod of ["sat", "lofi", "mod", "delay", "rev"]) {
    SETTLE_PARAMS[`band${b}.${mod}Enabled`] = 1;
  }
  SETTLE_PARAMS[`band${b}.satDriveDb`] = 12;
  SETTLE_PARAMS[`band${b}.delayTimeMs`] = 200;
  SETTLE_PARAMS[`band${b}.revDecayMs`] = 1500;
}

/** Deterministic stationary input: 440 Hz sine + seeded noise, fixed level. */
function fill(chans: Float32Array[], blockIndex: number, level = 0.3): void {
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

/** Seeded wobble schedule: one param touch per ~0.5 s during the middle phase.
 * Only ids the schema demonstrably accepts (validated + clamped at the store
 * boundary); band-count and module toggles stay OUT of the wobble — they are
 * structurally tested elsewhere and would change the level being compared. */
const WOBBLE_PARAMS: [string, (i: number) => number][] = [
  ["band1.satDriveDb", (i) => 6 + (i % 10)],
  ["band2.revDecayMs", (i) => 800 + (i % 8) * 150],
  ["band3.delayTimeMs", (i) => 120 + (i % 7) * 40],
  ["band4.gainDb", (i) => ((i % 5) - 2) * 1.5],
  ["band5.freqHz", (i) => 900 + (i % 6) * 120],
  ["band6.satDriveDb", (i) => 4 + (i % 12)],
  ["limiterCeilDb", (i) => -2 + (i % 4) * 0.5],
];

describe("FXEQ soak (300 s worst-case render)", () => {
  it("stays finite, does not drift, and decays to silence", () => {
    const settleParams = { ...SETTLE_PARAMS };
    const proc = createFxEqProcessor({ ...settleParams }, { seed: 0x51f00d });
    proc.prepare(SR, 2, BLOCK);
    const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];

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
    const wobbleEvery = Math.round(BLOCKS_PER_SECOND / 2);

    let heapStart = 0;
    if (typeof process !== "undefined" && process.memoryUsage) {
      global.gc?.();
      heapStart = process.memoryUsage().heapUsed;
    }

    for (let b = 0; b < totalBlocks; b++) {
      const second = b / BLOCKS_PER_SECOND;

      // Middle phase: seeded parameter traffic through the validated store
      // (the path live knob turns and automation take).
      if (second >= SETTLE_SECONDS && second < WOBBLE_END && b % wobbleEvery === 0) {
        const i = Math.floor(b / wobbleEvery);
        const [id, valueOf] = WOBBLE_PARAMS[i % WOBBLE_PARAMS.length];
        proc.loadParameters({ [id]: valueOf(Math.floor(i / WOBBLE_PARAMS.length)) });
      }
      // End of wobble: restore the settled configuration so the final
      // window measures the same setup as the first (state must re-converge).
      if (b === WOBBLE_END * BLOCKS_PER_SECOND) {
        proc.loadParameters(settleParams);
      }
      // Control-thread band metering polls ~2 Hz over the whole session.
      if (b % wobbleEvery === 0) proc.getBandPeaks();

      fill(chans, b);
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
      console.log(
        `[fxeq-soak] heap growth over ${TOTAL_SECONDS}s render: ${growthMb.toFixed(1)} MB (drift ${driftDb.toFixed(3)} dB, tail peak ${tailPeak.toExponential(2)}, maxAbs ${maxAbs.toFixed(3)})`,
      );
      expect(growthMb).toBeLessThan(100);
    }
  }, 600_000);
});
