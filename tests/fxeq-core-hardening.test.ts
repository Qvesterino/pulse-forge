/**
 * Regression coverage for fxeq-core real-time-safety hardening:
 *  - LFO readInto() must be numerically identical to read() (audio-thread
 *    callers switched to the allocation-free variant).
 *  - M/S encode/decode round-trips through the band engine with scratch
 *    buffers now allocated in prepare() (no first-block allocation).
 *  - Module param stores must reject non-finite values instead of letting
 *    clamp() pass NaN through into DSP state.
 *  - Linked true-peak limiter (hoisted scratch buffers) stays bounded.
 *
 * The full-chain numerical behavior is additionally pinned by the golden
 * parity suite (tests/fxeq-golden.test.ts), which must stay bit-exact.
 */
import { describe, expect, it } from "vitest";
import { createLfo, type LfoWaveform } from "../src/effects/fxeq-core/dsp/lfo";
import { createBandEngine } from "../src/effects/fxeq-core/core/bandEngine";
import { createDelayModule } from "../src/effects/fxeq-core/modules/delay";
import { createLimiterModule } from "../src/effects/fxeq-core/modules/limiter";

const SR = 48000;
const BLOCK = 128;

describe("fxeq-core LFO readInto (allocation-free reads)", () => {
  // "random" is excluded: it samples Math.random(), so two instances can
  // never match sample-for-sample by design.
  const waves: LfoWaveform[] = ["sine", "triangle", "saw", "square"];

  for (const wave of waves) {
    it(`readInto matches read sample-for-sample (${wave})`, () => {
      const a = createLfo(SR, 2.3, wave, Math.PI / 3, 0.8);
      const b = createLfo(SR, 2.3, wave, Math.PI / 3, 0.8);
      const scratch: [number, number] = [0, 0];
      for (let i = 0; i < 5000; i++) {
        const expected = a.read();
        const actual = b.readInto(scratch);
        expect(actual).toBe(scratch); // reuses the caller's pair
        expect(actual[0]).toBe(expected[0]);
        expect(actual[1]).toBe(expected[1]);
      }
    });
  }

  it("readInto keeps advancing phase like read", () => {
    const a = createLfo(SR, 5, "sine", 0, 1);
    const b = createLfo(SR, 5, "sine", 0, 1);
    const pair: [number, number] = [0, 0];
    for (let i = 0; i < SR; i++) {
      a.read();
      b.readInto(pair);
    }
    // After exactly one period worth of reads both LFOs are back in phase —
    // compare the NEXT read from each, not a stale pair from the loop.
    const nextA = a.read();
    const nextB = b.readInto(pair);
    expect(nextB[0]).toBeCloseTo(nextA[0], 10);
    expect(nextB[1]).toBeCloseTo(nextA[1], 10);
  });
});

describe("fxeq-core band engine M/S scratch (prepare-time allocation)", () => {
  it("M/S round-trip reconstructs the input when all modules are bypassed", () => {
    const engine = createBandEngine();
    engine.prepare(SR, 2, BLOCK);
    engine.setBandParam("midSide", 1); // mid mode: encode → modules → decode

    // Stereo material (impulse + detuned tones), processed across several
    // blocks to exercise block-boundary state in the scratch buffers.
    const frames = BLOCK * 4;
    const inputL = new Float32Array(frames);
    const inputR = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      inputL[i] = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.5;
      inputR[i] = Math.sin((2 * Math.PI * 447 * i) / SR) * 0.4;
    }
    inputL[7] = 1;
    const L = Float32Array.from(inputL);
    const R = Float32Array.from(inputR);

    for (let off = 0; off < frames; off += BLOCK) {
      engine.process([L.subarray(off, off + BLOCK), R.subarray(off, off + BLOCK)], BLOCK);
    }

    // Orthogonal transform + unity gain + 100% mix ⇒ identity (float error only).
    for (let i = 0; i < frames; i++) {
      expect(Number.isFinite(L[i])).toBe(true);
      expect(Number.isFinite(R[i])).toBe(true);
      expect(Math.abs(L[i] - inputL[i])).toBeLessThan(1e-4);
      expect(Math.abs(R[i] - inputR[i])).toBeLessThan(1e-4);
    }
  });

  it("side mode (midSide=2) round-trips as well", () => {
    const engine = createBandEngine();
    engine.prepare(SR, 2, BLOCK);
    engine.setBandParam("midSide", 2);
    const L = new Float32Array(BLOCK);
    const R = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      L[i] = Math.cos(i * 0.05) * 0.3;
      R[i] = Math.sin(i * 0.11) * 0.2;
    }
    const expectedL = Float32Array.from(L);
    const expectedR = Float32Array.from(R);
    engine.process([L, R], BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      expect(Math.abs(L[i] - expectedL[i])).toBeLessThan(1e-4);
      expect(Math.abs(R[i] - expectedR[i])).toBeLessThan(1e-4);
    }
  });
});

describe("fxeq-core module param store finite guards", () => {
  it("delay module rejects NaN/Infinity params and keeps the previous value", () => {
    const mod = createDelayModule();
    mod.prepare(SR, 2, BLOCK);
    mod.setParameter("enabled", 1);
    mod.setParameter("feedback", 0.4);
    mod.setParameter("feedback", Number.NaN);
    expect(mod.getParameter("feedback")).toBe(0.4);
    mod.setParameter("timeMs", Number.POSITIVE_INFINITY);
    expect(Number.isFinite(mod.getParameter("timeMs"))).toBe(true);

    // Processing after the poison attempts must stay finite.
    const L = new Float32Array(BLOCK);
    const R = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) L[i] = R[i] = Math.sin(i * 0.2) * 0.5;
    mod.process([L, R], BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      expect(Number.isFinite(L[i])).toBe(true);
      expect(Number.isFinite(R[i])).toBe(true);
    }
  });

  it("loadParameters skips non-finite entries", () => {
    const mod = createDelayModule();
    mod.prepare(SR, 2, BLOCK);
    mod.loadParameters({ feedback: Number.NaN, timeMs: 500 } as Record<string, number>);
    expect(mod.getParameter("feedback")).toBe(0.3); // schema default retained
    expect(mod.getParameter("timeMs")).toBe(500);
  });
});

describe("fxeq-core limiter linked true-peak path (hoisted scratch)", () => {
  it("stereo-linked limiting keeps output bounded at the ceiling", () => {
    const mod = createLimiterModule({ enabled: 1, ceilDb: -3, truePeak: 1, lookaheadMs: 2, stereoLink: 1 });
    mod.prepare(SR, 2, BLOCK);
    // Feed loud, decorrelated stereo blocks. The first blocks are the
    // documented startup transient (the lookahead ring is still filling),
    // so bounds are asserted once the ring is primed.
    const warmupBlocks = 8;
    for (let blk = 0; blk < 64; blk++) {
      const L = new Float32Array(BLOCK);
      const R = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        L[i] = Math.sin((2 * Math.PI * 3117 * (blk * BLOCK + i)) / SR) * 4;
        R[i] = Math.sin((2 * Math.PI * 1973 * (blk * BLOCK + i)) / SR) * 4;
      }
      mod.process([L, R], BLOCK);
      if (blk < warmupBlocks) continue;
      const ceil = Math.pow(10, -3 / 20);
      for (let i = 0; i < BLOCK; i++) {
        expect(Number.isFinite(L[i])).toBe(true);
        expect(Number.isFinite(R[i])).toBe(true);
        expect(Math.abs(L[i])).toBeLessThanOrEqual(ceil * 1.001 + 1e-6);
        expect(Math.abs(R[i])).toBeLessThanOrEqual(ceil * 1.001 + 1e-6);
      }
    }
  });
});
