/**
 * FXEQ band equalizer module (quality roadmap Q3).
 *
 * The new per-band EQ heads the module chain (eq → sat → dyn → lofi →
 * mod → delay → rev): one low shelf, two peaking bands, one high shelf
 * on the shared RBJ biquad primitive. Invariants pinned here:
 *  - a 12 dB boost actually boosts the tuned band by ~12 dB,
 *  - out-of-band content is left (mostly) alone,
 *  - enabled = 0 (the default) is a bit-identical no-op — module-level
 *    AND processor-level (golden parity contract for old presets),
 *  - extreme corner parameters stay finite (store clamps + w0 clamp),
 *  - rendering is deterministic.
 */
import { describe, expect, it } from "vitest";
import { createBandEqModule } from "../src/effects/fxeq-core/modules/bandEq";
import { createFxEqProcessor } from "../src/effects/fxeq-core/core/fxEqProcessor";

const SR = 48000;
const BLOCK = 128;

function tone(freq: number, blocks: number, amp = 0.5): Float32Array {
  const out = new Float32Array(blocks * BLOCK);
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / SR) * amp;
  return out;
}

function rms(buf: Float32Array, from = 0): number {
  let sum = 0;
  let count = 0;
  for (let i = from; i < buf.length; i++) {
    sum += buf[i] * buf[i];
    count++;
  }
  return Math.sqrt(sum / Math.max(1, count));
}

/** Render a tone through the module, returning the output + steady-state RMS. */
function renderModule(config: Record<string, number>, freq: number): { out: Float32Array; rms: number } {
  const mod = createBandEqModule({ enabled: 1, ...config });
  mod.prepare(SR, 1, BLOCK);
  const src = tone(freq, 100);
  const out = Float32Array.from(src);
  for (let off = 0; off < out.length; off += BLOCK) {
    mod.process([out.subarray(off, off + BLOCK)], BLOCK);
  }
  // Skip the filter settling transient (~100 ms).
  const from = Math.floor(out.length * 0.5);
  return { out, rms: rms(out, from) };
}

describe("fxeq band EQ module", () => {
  it("a 12 dB peak boost lifts the tuned frequency by ~12 dB", () => {
    const flat = renderModule({ peak1Freq: 1000, peak1GainDb: 0, peak1Q: 0.7 }, 1000);
    const boosted = renderModule({ peak1Freq: 1000, peak1GainDb: 12, peak1Q: 0.7 }, 1000);
    const ratioDb = 20 * Math.log10(boosted.rms / flat.rms);
    expect(ratioDb).toBeGreaterThan(10);
    expect(ratioDb).toBeLessThan(14);
  });

  it("out-of-band content is left mostly alone by the peak boost", () => {
    const flat = renderModule({ peak1Freq: 1000, peak1GainDb: 0, peak1Q: 0.7 }, 100);
    const boosted = renderModule({ peak1Freq: 1000, peak1GainDb: 12, peak1Q: 0.7 }, 100);
    const ratioDb = 20 * Math.log10(boosted.rms / flat.rms);
    expect(Math.abs(ratioDb)).toBeLessThan(1.5);
  });

  it("a low shelf boost lifts bass by roughly the requested amount", () => {
    const flat = renderModule({ lowFreq: 120, lowGainDb: 0 }, 80);
    const boosted = renderModule({ lowFreq: 120, lowGainDb: 9 }, 80);
    const ratioDb = 20 * Math.log10(boosted.rms / flat.rms);
    expect(ratioDb).toBeGreaterThan(7);
    expect(ratioDb).toBeLessThan(11);
  });

  it("enabled = 0 is a bit-identical passthrough", () => {
    const mod = createBandEqModule({ enabled: 0, peak1GainDb: 12, lowGainDb: -18, highGainDb: 24 });
    mod.prepare(SR, 2, BLOCK);
    const L = tone(997, 2, 0.9);
    const R = tone(551, 2, 0.7);
    const srcL = Float32Array.from(L);
    const srcR = Float32Array.from(R);
    for (let off = 0; off < L.length; off += BLOCK) {
      mod.process([L.subarray(off, off + BLOCK), R.subarray(off, off + BLOCK)], BLOCK);
    }
    for (let i = 0; i < L.length; i++) {
      expect(L[i]).toBe(srcL[i]);
      expect(R[i]).toBe(srcR[i]);
    }
  });

  it("corner parameters stay finite (store clamps + frequency clamp)", () => {
    const mod = createBandEqModule({
      enabled: 1,
      lowFreq: -999,
      lowGainDb: 999,
      peak1Freq: 1e6,
      peak1GainDb: -999,
      peak1Q: 999,
      peak2Freq: -1e6,
      peak2GainDb: 999,
      peak2Q: 0.001,
      highFreq: 999999,
      highGainDb: -999,
    });
    mod.prepare(SR, 2, BLOCK);
    for (let blk = 0; blk < 30; blk++) {
      const L = tone(700, 1);
      const R = tone(551, 1);
      mod.process([L, R], BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        expect(Number.isFinite(L[i])).toBe(true);
        expect(Number.isFinite(R[i])).toBe(true);
      }
    }
  });

  it("rendering is deterministic across instances", () => {
    const a = renderModule({ lowGainDb: 6, peak2GainDb: -6 }, 997).out;
    const b = renderModule({ lowGainDb: 6, peak2GainDb: -6 }, 997).out;
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]);
  });
});

describe("fxeq processor with band EQ (Q3 integration)", () => {
  const EQ_ON: Record<string, number> = {
    bandCount: 2,
    "band1.eqEnabled": 1,
    "band1.eqLowFreq": 120,
    "band1.eqLowGainDb": 12,
    limiterEnabled: 0,
    globalMix: 100,
  };

  it("an enabled band EQ changes the output vs an EQ-less reference", () => {
    const withEq = createFxEqProcessor();
    const reference = createFxEqProcessor();
    withEq.prepare(SR, 2, BLOCK);
    reference.prepare(SR, 2, BLOCK);
    withEq.loadParameters(EQ_ON);
    reference.loadParameters({ bandCount: 2, limiterEnabled: 0, globalMix: 100 });

    let diff = 0;
    for (let blk = 0; blk < 20; blk++) {
      const A = [tone(80, 1), tone(80, 1)];
      const B = [Float32Array.from(A[0]), Float32Array.from(A[1])];
      withEq.process(A, BLOCK);
      reference.process(B, BLOCK);
      for (let i = 0; i < BLOCK; i++) diff = Math.max(diff, Math.abs(A[0][i] - B[0][i]));
    }
    expect(diff).toBeGreaterThan(0.05);
  });

  it("eqEnabled = 0 renders bit-identically to a processor without any EQ keys", () => {
    const withOff = createFxEqProcessor();
    const reference = createFxEqProcessor();
    withOff.prepare(SR, 2, BLOCK);
    reference.prepare(SR, 2, BLOCK);
    withOff.loadParameters({ ...EQ_ON, "band1.eqEnabled": 0 });
    reference.loadParameters({ bandCount: 2, limiterEnabled: 0, globalMix: 100 });

    for (let blk = 0; blk < 12; blk++) {
      const A = [tone(700 + blk, 1), tone(551, 1)];
      const B = [Float32Array.from(A[0]), Float32Array.from(A[1])];
      withOff.process(A, BLOCK);
      reference.process(B, BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        expect(A[0][i]).toBe(B[0][i]);
        expect(A[1][i]).toBe(B[1][i]);
      }
    }
  });

  it("the schema exposes the eq parameter surface per band", () => {
    const proc = createFxEqProcessor();
    proc.prepare(SR, 2, BLOCK);
    proc.setParameter("band3.eqEnabled", 1);
    proc.setParameter("band3.eqPeak1Freq", 2000);
    proc.setParameter("band3.eqPeak1GainDb", 6);
    expect(proc.getParameter("band3.eqEnabled")).toBe(1);
    expect(proc.getParameter("band3.eqPeak1Freq")).toBe(2000);
    expect(proc.getParameter("band3.eqPeak1GainDb")).toBe(6);
    // Out-of-range still clamps at the schema boundary (audit invariant).
    proc.setParameter("band3.eqPeak1GainDb", 999);
    expect(proc.getParameter("band3.eqPeak1GainDb")).toBe(24);
  });
});
