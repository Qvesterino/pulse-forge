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

function rms(buf: Float32Array, from = 0, to = buf.length): number {
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
    withParams.loadParameters({
      ...base,
      "band1.envModTarget": 0,
      "band1.envModDepth": 100,
      "band1.envModAtkMs": 5,
      "band1.envModRelMs": 50,
    });

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
    const loudRef = tone(80, 30, 0.9);
    run(mod, loudMod);
    run(ref, loudRef);

    const rmsMod = rms(loudMod, loudMod.length - BLOCK * 4);
    const rmsRef = rms(loudRef, loudRef.length - BLOCK * 4);
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

  it("depth back to 0 restores the base — output converges back to the reference", () => {
    const routed = createFxEqProcessor();
    const reference = createFxEqProcessor();
    routed.prepare(SR, 2, BLOCK);
    reference.prepare(SR, 2, BLOCK);
    routed.loadParameters(ROUTED);
    reference.loadParameters({ ...ROUTED, "band1.envModDepth": 0 });

    // Modulate hard, then switch the routing off.
    run(routed, tone(80, 40, 0.95));
    routed.setParameter("band1.envModDepth", 0);

    // The routed parameter's store is restored instantly; the audible
    // glide back runs through the sat de-click smoother (block-rate
    // one-pole, ~0.7 s tau — its slowness IS the click protection), so
    // the restore is verified as a MONOTONIC CONVERGENCE toward the
    // never-modulated reference rather than an instant match.
    const probe = (): number => {
      const s = tone(80, 1, 0.3, 900);
      const A = [Float32Array.from(s), Float32Array.from(s)];
      const B = [Float32Array.from(s), Float32Array.from(s)];
      routed.process(A, BLOCK);
      reference.process(B, BLOCK);
      let d = 0;
      for (let i = 0; i < BLOCK; i++) d = Math.max(d, Math.abs(A[0][i] - B[0][i]));
      return d;
    };
    const feed = (blocks: number, startBlock: number): void => {
      run(routed, tone(80, blocks, 0.3, startBlock));
      run(reference, tone(80, blocks, 0.3, startBlock));
    };
    feed(20, 40);
    const early = probe();
    feed(300, 60);
    const mid = probe();
    feed(2600, 360);
    const late = probe();
    expect(early, "restore did not start converging").toBeGreaterThan(0);
    expect(mid, "convergence stalled mid-way").toBeLessThan(early);
    expect(
      late,
      `convergence incomplete (early ${early.toExponential(2)}, mid ${mid.toExponential(2)}, late ${late.toExponential(2)})`,
    ).toBeLessThan(early * 0.15);
  });

  it("negative depth inverts the direction (louder input → LESS sat drive)", () => {
    const neg = createFxEqProcessor();
    const zero = createFxEqProcessor();
    neg.prepare(SR, 2, BLOCK);
    zero.prepare(SR, 2, BLOCK);
    neg.loadParameters({ ...ROUTED, "band1.envModDepth": -100, "band1.satDriveDb": 12 });
    zero.loadParameters({ ...ROUTED, "band1.envModDepth": 0, "band1.satDriveDb": 12 });

    // Loud sustained input: negative depth pulls drive DOWN (12 → ~6 dB),
    // zero depth keeps 12 dB — tanh(3.8) ≈ 1 vs tanh(1.9) ≈ 0.95.
    const loudNeg = tone(80, 40, 0.9);
    const loudZero = tone(80, 40, 0.9);
    run(neg, loudNeg);
    run(zero, loudZero);
    expect(rms(loudNeg), "negative depth did not reduce the routed drive on loud input").toBeLessThan(rms(loudZero));
  });

  it("band gain target (9) follows the envelope", () => {
    const mod = createFxEqProcessor();
    const ref = createFxEqProcessor();
    mod.prepare(SR, 2, BLOCK);
    ref.prepare(SR, 2, BLOCK);
    // Sat off — a +12 dB band boost into the tanh saturator would rightly
    // compress; this test isolates the linear band-gain routing.
    mod.loadParameters({ ...ROUTED, "band1.envModTarget": 9, "band1.satEnabled": 0 });
    ref.loadParameters({ ...ROUTED, "band1.envModTarget": 9, "band1.envModDepth": 0, "band1.satEnabled": 0 });

    // Whole-window energy (per-block rms of an 80 Hz tone swings with the
    // block's phase slice — whole-window is the robust measure).
    const loudMod = tone(80, 30, 0.9);
    const loudRef = tone(80, 30, 0.9);
    run(mod, loudMod);
    run(ref, loudRef);
    expect(rms(loudMod), "+12 dB envelope swing must lift the band").toBeGreaterThan(rms(loudRef) * 1.5);
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
