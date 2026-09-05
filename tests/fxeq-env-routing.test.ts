/**
 * FXEQ per-band envelope routing (quality roadmap Q6).
 *
 * The band's own envelope follower (peak, atk/rel smoothed, normalized
 * against full scale) drives ONE routed parameter around its base value:
 * sat drive/mix, band-EQ shelf/peak gains, delay/reverb mix, or the band
 * gain itself (target 9).
 *
 * Invariants pinned here:
 *  - default (envModTarget 0) is a bit-identical no-op at processor level,
 *  - the processor's flat store NEVER shows the modulation — a routed
 *    parameter keeps its base (serialization contract),
 *  - modulation direction follows the depth sign (positive = louder input
 *    pushes the parameter up, negative inverts),
 *  - disabling the routing (depth 0) restores the base — after the de-click
 *    smoothing settles, output re-converges to a never-modulated reference,
 *  - rendering stays deterministic and finite at full depth on every target.
 */
import { describe, expect, it } from "vitest";
import { createFxEqProcessor } from "../src/effects/fxeq-core/core/fxEqProcessor";
import { createBandEngine } from "../src/effects/fxeq-core/core/bandEngine";

const SR = 48000;
const BLOCK = 128;

function tone(freq: number, blocks: number, amp: number, startBlock = 0): Float32Array {
  const out = new Float32Array(blocks * BLOCK);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.sin((2 * Math.PI * freq * (startBlock * BLOCK + i)) / SR) * amp;
  }
  return out;
}

function rms(buf: Float32Array, from: number, to: number): number {
  let sum = 0;
  let count = 0;
  for (let i = from; i < to; i++) {
    sum += buf[i] * buf[i];
    count++;
  }
  return Math.sqrt(sum / Math.max(1, count));
}

/** Feed an existing buffer to the processor block by block. */
function run(proc: ReturnType<typeof createFxEqProcessor>, buf: Float32Array): void {
  for (let off = 0; off < buf.length; off += BLOCK) {
    proc.process([buf.subarray(off, off + BLOCK), Float32Array.from(buf.subarray(off, off + BLOCK))], BLOCK);
  }
}

const ROUTED = {
  bandCount: 6,
  "band1.satEnabled": 1,
  "band1.satMode": 0, // cleanWarmth — stateless tanh, trajectories converge
  "band1.satMix": 100,
  "band1.eqEnabled": 0,
  "band1.envModTarget": 1, // sat drive
  "band1.envModDepth": 100, // ±6 dB
  limiterEnabled: 0,
  globalMix: 100,
};

describe("fxeq envelope routing (roadmap Q6)", () => {
  it("default (target 0) renders bit-identically to a processor without env params", () => {
    const plain = createFxEqProcessor();
    const withParams = createFxEqProcessor();
    plain.prepare(SR, 2, BLOCK);
    withParams.prepare(SR, 2, BLOCK);
    const base = {
      bandCount: 6,
      "band1.satEnabled": 1,
      "band1.satMode": 0,
      "band1.satMix": 100,
      limiterEnabled: 0,
      globalMix: 100,
    };
    plain.loadParameters(base);
    withParams.loadParameters({ ...base, "band1.envModTarget": 0, "band1.envModDepth": 100, "band1.envModAtkMs": 5, "band1.envModRelMs": 50 });

    for (let blk = 0; blk < 20; blk++) {
      const s = tone(80, 1, 0.5, blk);
      const A = [Float32Array.from(s), Float32Array.from(s)];
      const B = [Float32Array.from(s), Float32Array.from(s)];
      plain.process(A, BLOCK);
      withParams.process(B, BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        expect(B[0][i]).toBe(A[0][i]);
      }
    }
  });

  it("louder input pushes the routed sat drive up (positive depth)", () => {
    const mod = createFxEqProcessor();
    const ref = createFxEqProcessor();
    mod.prepare(SR, 2, BLOCK);
    ref.prepare(SR, 2, BLOCK);
    mod.loadParameters(ROUTED);
    ref.loadParameters({ ...ROUTED, "band1.envModDepth": 0 });

    // Settle + quiet intro (envelope low → little modulation)…
    run(mod, tone(80, 20, 0.05));
    run(ref, tone(80, 20, 0.05));
    // …then a loud section: routed drive rises, reference stays at base.
    const loudMod = tone(80, 30, 0.9);
    run(mod, loudMod);
    run(ref, tone(80, 30, 0.9));

    const rmsMod = rms(loudMod, loudMod.length - BLOCK * 4);
    // Re-render reference loud tail for measurement.
    const refLoud = tone(80, 30, 0.9);
    run(ref, refLoud);
    const rmsRef = rms(refLoud, refLoud.length - BLOCK * 4);
    expect(rmsMod).toBeGreaterThan(rmsRef);
  });

  it("the flat store keeps the base while the modulation swings the module", () => {
    const proc = createFxEqProcessor();
    proc.prepare(SR, 2, BLOCK);
    proc.loadParameters(ROUTED);
    proc.setParameter("band1.satDriveDb", 6);
    expect(proc.getParameter("band1.satDriveDb")).toBe(6);
    // Loud input drives the modulation hard…
    run(proc, tone(80, 40, 0.95));
    // …but the flat store (serialization source of truth) never moves.
    expect(proc.getParameter("band1.satDriveDb")).toBe(6);
  });

  it("depth back to 0 restores the base — output re-converges to a never-modulated reference", () => {
    const routed = createFxEqProcessor();
    const reference = createFxEqProcessor();
    routed.prepare(SR, 2, BLOCK);
    reference.prepare(SR, 2, BLOCK);
    routed.loadParameters(ROUTED);
    reference.loadParameters({ ...ROUTED, "band1.envModDepth": 0 });

    // Modulate hard, then switch the routing off.
    run(routed, tone(80, 40, 0.95));
    routed.setParameter("band1.envModDepth", 0);
    // Drive smoothing (~12 ms) settles; the stateless tanh leaves no state.
    run(routed, tone(80, 200, 0.3));
    run(reference, tone(80, 240, 0.3));

    let maxDiff = 0;
    for (let blk = 0; blk < 6; blk++) {
      const A = [tone(80, 1, 0.3, 240 + blk), Float32Array.from(tone(80, 1, 0.3, 240 + blk))];
      const B = [Float32Array.from(A[0]), Float32Array.from(A[1])];
      routed.process(A, BLOCK);
      reference.process(B, BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        maxDiff = Math.max(maxDiff, Math.abs(A[0][i] - B[0][i]));
      }
    }
    expect(maxDiff).toBeLessThan(1e-6);
  });

  it("negative depth inverts the direction (louder input → quieter routed mix)", () => {
    const inv = createFxEqProcessor();
    const ref = createFxEqProcessor();
    inv.prepare(SR, 2, BLOCK);
    ref.prepare(SR, 2, BLOCK);
    inv.loadParameters({ ...ROUTED, "band1.envModTarget": 7, "band1.envModDepth": -100, "band1.delayEnabled": 1, "band1.delayMix": 100 });
    ref.loadParameters({ ...ROUTED, "band1.envModTarget": 7, "band1.envModDepth": 0, "band1.delayEnabled": 1, "band1.delayMix": 100 });

    run(inv, tone(80, 30, 0.9));
    run(ref, tone(80, 30, 0.9));
    const invOut = tone(80, 10, 0.9);
    run(inv, invOut);
    const refOut = tone(80, 10, 0.9);
    run(ref, refOut);

    // Negative depth pulls the delay mix DOWN on loud input → routed output
    // carries less delay wet than the reference.
    expect(rms(invOut, invOut.length - BLOCK * 4)).toBeLessThan(rms(refOut, refOut.length - BLOCK * 4));
  });

  it("band gain target (9) follows the envelope", () => {
    const mod = createFxEqProcessor();
    const ref = createFxEqProcessor();
    mod.prepare(SR, 2, BLOCK);
    ref.prepare(SR, 2, BLOCK);
    mod.loadParameters({ ...ROUTED, "band1.envModTarget": 9 });
    ref.loadParameters({ ...ROUTED, "band1.envModTarget": 9, "band1.envModDepth": 0 });

    run(mod, tone(80, 20, 0.9));
    run(ref, tone(80, 20, 0.9));
    const modOut = tone(80, 10, 0.9);
    run(mod, modOut);
    const refOut = tone(80, 10, 0.9);
    run(ref, refOut);
    // +12 dB swing at full envelope → routed band is substantially louder.
    expect(rms(modOut, modOut.length - BLOCK * 4)).toBeGreaterThan(rms(refOut, refOut.length - BLOCK * 4) * 1.5);
  });

  it("band engine reports the routed base, not the modulated value", () => {
    const engine = createBandEngine();
    engine.prepare(SR, 2, BLOCK);
    engine.setModuleParam("sat", "driveDb", 6);
    engine.setBandParam("envModTarget", 1);
    engine.setBandParam("envModDepth", 100);
    const loud = tone(80, 1, 0.95);
    engine.process([loud, Float32Array.from(loud)], BLOCK);
    expect(engine.getModuleParam("sat", "driveDb")).toBe(6);
  });

  it("every target at full depth stays deterministic, finite and bounded", () => {
    for (let target = 1; target <= 9; target++) {
      for (const depth of [100, -100]) {
        const a = createFxEqProcessor();
        const b = createFxEqProcessor();
        a.prepare(SR, 2, BLOCK);
        b.prepare(SR, 2, BLOCK);
        const params = {
          ...ROUTED,
          "band1.eqEnabled": 1,
          "band1.delayEnabled": 1,
          "band1.revEnabled": 1,
          "band1.envModTarget": target,
          "band1.envModDepth": depth,
        };
        a.loadParameters(params);
        b.loadParameters(params);
        for (let blk = 0; blk < 25; blk++) {
          const s = tone(80 + blk, 1, blk % 2 === 0 ? 0.95 : 0.02, blk);
          const A = [Float32Array.from(s), Float32Array.from(s)];
          const B = [Float32Array.from(s), Float32Array.from(s)];
          a.process(A, BLOCK);
          b.process(B, BLOCK);
          for (let i = 0; i < BLOCK; i++) {
            expect(Number.isFinite(A[0][i]), `target ${target} depth ${depth}: non-finite`).toBe(true);
            expect(Math.abs(A[0][i])).toBeLessThan(100);
            expect(A[0][i]).toBe(B[0][i]);
          }
        }
      }
    }
  });
});
