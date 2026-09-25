/**
 * Ozvena soak — a reverb runs for the whole session, accumulating reverb
 * state across every parameter change. This renders 300 seconds through the
 * FULL vendored core (all three engines + pre-delay/EQ/mod/limiter) with
 * live parameter traffic and proves the invariants that only appear over
 * time:
 *
 *  1. Output stays finite and bounded for every sample of the render.
 *  2. NO DRIFT: with stationary input and the restored parameter snapshot,
 *     the settled level at the end matches the settled level from minute
 *     one (a winding LFO phase, ratcheting envelope or leaking filter
 *     would show).
 *  3. Silence converges to silence — after the signal stops, the FDN tails,
 *     delay lines and envelopes decay below 1e-4 peak (no self-oscillation;
 *     the shimmer stability guard must hold for the whole session).
 *  4. Heap growth stays bounded (state churn and latency polls must not
 *     accumulate).
 *
 * Quality is cycled during the wobble phase — the limiter's oversample
 * switch is exercised hundreds of times mid-render (it used to be a full
 * audio-thread re-prepare).
 */
import { describe, expect, it } from "vitest";
import { createOzvenaProcessor } from "../src/effects/ozvena-core/core/ozvenaProcessor.js";
import { defaultOzvenaStateV1, type OzvenaStateV1 } from "../src/effects/ozvena-core/v2/types.js";

const SR = 48000;
const BLOCK = 128;
const BLOCKS_PER_SECOND = SR / BLOCK;
const SETTLE_SECONDS = 60;
const WOBBLE_END = 210;
const TOTAL_SECONDS = 300;
const STABILITY_WINDOW_SECONDS = 50;
const TAIL_SILENCE_SECONDS = 20;

/** The settled configuration measured before AND after the wobble phase. */
function settledState(): OzvenaStateV1 {
  const s = defaultOzvenaStateV1();
  return {
    ...s,
    global: { ...s.global, dryWet: 35, quality: "standard" },
  };
}

/** Immutable dotted-path patch over the state (same contract as the
 *  worklet entry's setPath — sections must be fresh objects or the
 *  core's section-reference diffing drops the change). */
function patch(state: OzvenaStateV1, path: string, value: number): OzvenaStateV1 {
  const parts = path.split(".");
  const clone = (node: unknown, depth: number): unknown => {
    if (depth === parts.length - 1) {
      return { ...(node as Record<string, unknown>), [parts[depth]]: value };
    }
    const child = (node as Record<string, unknown>)[parts[depth]];
    return { ...(node as Record<string, unknown>), [parts[depth]]: clone(child, depth + 1) };
  };
  return clone(state, 0) as OzvenaStateV1;
}

/** Seeded wobble schedule — one parameter touch every ~0.5 s. */
const WOBBLE: [path: string, valueOf: (i: number) => number][] = [
  ["global.dryWet", (i) => 30 + (i % 8) * 10],
  ["global.quality", (i) => i % 4],
  ["blendPad.x", (i) => (i % 5) / 5],
  ["blendPad.y", (i) => (i % 7) / 7],
  ["engines.e2.time", (i) => 1400 + (i % 6) * 1100],
  ["engines.e3.time", (i) => 4170 + (i % 4) * 2000],
  ["engines.e1.enabled", (i) => i % 2],
  ["preDelay.ms", (i) => (i % 5) * 10],
  ["mod.enabled", (i) => i % 2],
  ["global.gate", (i) => i % 2],
  ["global.freeze", (i) => (i % 4 === 0 ? 1 : 0)],
  ["engines.e2.shimmer", (i) => (i % 3) / 3],
  ["engines.e3.shimmer", (i) => ((i + 1) % 3) / 3],
];

describe("Ozvena soak (300 s full-core render)", () => {
  it("stays finite, does not drift, and decays to silence", () => {
    const proc = createOzvenaProcessor();
    proc.prepare(SR, 2, 120, BLOCK);
    let state = settledState();
    proc.loadState(state);
    proc.setAnalyzersEnabled(false);
    const settleSnapshot = state;

    const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    // Deterministic stationary input: 220 Hz sine + seeded noise.
    const fill = (blockIndex: number): void => {
      let s = (blockIndex * 97 + 13) & 0x7fffffff;
      const rand = () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return (s / 0x7fffffff) * 2 - 1;
      };
      for (let i = 0; i < BLOCK; i++) {
        const t = (blockIndex * BLOCK + i) / SR;
        const v = 0.3 * (0.6 * Math.sin(2 * Math.PI * 220 * t) + 0.4 * rand());
        chans[0][i] = v;
        chans[1][i] = v;
      }
    };

    let nonFinite = 0;
    let maxAbs = 0;
    let settleSumSq = 0;
    let settleSamples = 0;
    let finalSumSq = 0;
    let finalSamples = 0;

    const totalBlocks = TOTAL_SECONDS * BLOCKS_PER_SECOND;
    const settleFrom = 10 * BLOCKS_PER_SECOND;
    const settleTo = SETTLE_SECONDS * BLOCKS_PER_SECOND;
    // Compare equal 50-second stationary windows. The restored state has
    // 40 seconds to shed the maximum-decay wobble tail before this window.
    const finalFrom = (TOTAL_SECONDS - STABILITY_WINDOW_SECONDS) * BLOCKS_PER_SECOND;
    const wobbleEvery = Math.round(BLOCKS_PER_SECOND / 2);

    let heapStart = 0;
    if (typeof process !== "undefined" && process.memoryUsage) {
      global.gc?.();
      heapStart = process.memoryUsage().heapUsed;
    }

    for (let b = 0; b < totalBlocks; b++) {
      const second = b / BLOCKS_PER_SECOND;
      // Replay the exact settled-window stimulus at the end so the RMS
      // comparison isolates DSP-state drift from noise-window variance.
      const signalBlock = b >= finalFrom ? settleFrom + (b - finalFrom) : b;
      fill(signalBlock);
      if (second >= SETTLE_SECONDS && second < WOBBLE_END && b % wobbleEvery === 0) {
        const i = Math.floor(b / wobbleEvery);
        const [path, valueOf] = WOBBLE[i % WOBBLE.length];
        state = patch(state, path, valueOf(Math.floor(i / WOBBLE.length)));
        proc.loadState(state);
      }
      // End of wobble: restore the settled configuration (state must
      // re-converge for the no-drift comparison).
      if (b === WOBBLE_END * BLOCKS_PER_SECOND) {
        state = settleSnapshot;
        proc.loadState(state);
      }
      // Control-thread latency polls ~2 Hz over the whole session (the
      // entry posts on every loadState; this is the read side).
      if (b % wobbleEvery === 0) proc.getLatencySamples();

      proc.process(chans, BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        const l = chans[0][i];
        const r = chans[1][i];
        if (!Number.isFinite(l) || !Number.isFinite(r)) nonFinite++;
        maxAbs = Math.max(maxAbs, Math.abs(l), Math.abs(r));
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
    // Safety limiter ceiling is -0.3 dBFS sample-peak; generous margin
    // for the release smoothing and the eco-tier (1×) bypass moments.
    expect(maxAbs).toBeLessThanOrEqual(2);

    // No drift: identical input + identical restored params → same level.
    const settleRms = Math.sqrt(settleSumSq / settleSamples);
    const finalRms = Math.sqrt(finalSumSq / finalSamples);
    const driftDb = 20 * Math.log10(finalRms / settleRms);
    expect(Math.abs(driftDb)).toBeLessThanOrEqual(0.003);

    // Tail: 20 s of silence must converge to silence (peak of the last
    // second) — longest tail reachable in the wobble is ~10 s T60.
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
        `[ozvena-soak] heap growth over ${TOTAL_SECONDS}s render: ${growthMb.toFixed(1)} MB (drift ${driftDb.toFixed(6)} dB, tail peak ${tailPeak.toExponential(2)}, maxAbs ${maxAbs.toFixed(3)})`,
      );
      expect(growthMb).toBeLessThanOrEqual(6);
    }
  }, 600_000);
});
