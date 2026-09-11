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
import { createFxEqProcessor } from "../src/effects/fxeq-core/core/fxEqProcessor";
import { createDelayModule } from "../src/effects/fxeq-core/modules/delay";
import { createLimiterModule } from "../src/effects/fxeq-core/modules/limiter";
import { createLofiModule } from "../src/effects/fxeq-core/modules/lofi";
import { createSaturationModule } from "../src/effects/fxeq-core/modules/saturation";
import { createReverbModule } from "../src/effects/fxeq-core/modules/reverb";

const SR = 48000;
const BLOCK = 128;

describe("fxeq-core LFO readInto (allocation-free reads)", () => {
  // Since the "random" S&H moved from Math.random() to a per-instance
  // seeded xorshift (export determinism, KNOWN_LIMITATIONS residual),
  // two identically-configured LFOs must also match sample-for-sample —
  // that includes the "random" waveform.
  const waves: LfoWaveform[] = ["sine", "triangle", "saw", "square", "random"];

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

  it("random S&H is deterministic: independent instances and reset restart the same sequence", () => {
    // 300 Hz at 48 kHz: a hold retake every 80 samples — ~100 distinct
    // values across the drive window, so the S&H shape is actually exercised.
    const drive = (lfo: ReturnType<typeof createLfo>): [number, number][] => {
      const out: [number, number][] = [];
      for (let i = 0; i < 8000; i++) out.push([...lfo.read()] as [number, number]);
      return out;
    };
    const a = drive(createLfo(SR, 300, "random", Math.PI / 5, 0.9));
    const b = drive(createLfo(SR, 300, "random", Math.PI / 5, 0.9));
    // Two independent instances produce the identical hold sequence…
    expect(b).toEqual(a);
    // …and the values are a real S&H: non-constant, within depth bounds,
    // and each held value repeats across consecutive samples.
    const distinct = new Set(a.map(([l]) => l.toFixed(6)));
    expect(distinct.size).toBeGreaterThan(10);
    for (const [l, r] of a) {
      expect(Math.abs(l)).toBeLessThanOrEqual(0.9 + 1e-9);
      expect(Math.abs(r)).toBeLessThanOrEqual(0.9 + 1e-9);
    }
    // reset() re-seeds: the sequence after a reset equals a fresh instance.
    const c = createLfo(SR, 300, "random", Math.PI / 5, 0.9);
    for (let i = 0; i < 500; i++) c.read();
    c.reset();
    const afterReset = drive(c);
    expect(afterReset).toEqual(a);
  });

  it("accepts a stable per-instance seed without changing reset semantics", () => {
    const drive = (seed: number): number[] => {
      const lfo = createLfo(SR, 300, "random", 0, 1, seed);
      const values: number[] = [];
      for (let i = 0; i < 8000; i++) values.push(lfo.read()[0]);
      return values;
    };
    expect(drive(0x11111111)).toEqual(drive(0x11111111));
    expect(drive(0x11111111)).not.toEqual(drive(0x22222222));
  });

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

describe("fxeq-core seeded module streams", () => {
  it("decorrelates explicit lo-fi noise seeds while keeping identical seeds repeatable", () => {
    const render = (seed: number): Float32Array => {
      const module = createLofiModule(undefined, seed);
      module.prepare(SR, 2, BLOCK);
      module.setParameter("enabled", 1);
      module.setParameter("mode", 3);
      module.setParameter("amount", 100);
      module.setParameter("mix", 100);
      const left = new Float32Array(BLOCK);
      const right = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) left[i] = right[i] = Math.sin(i * 0.07) * 0.4;
      module.process([left, right], BLOCK);
      return left;
    };

    expect(Array.from(render(7))).toEqual(Array.from(render(7)));
    expect(Array.from(render(7))).not.toEqual(Array.from(render(8)));
  });
});

describe("fxeq-core host-seeded render determinism", () => {
  const render = (seed: number): Float32Array[] => {
    const proc = createFxEqProcessor(
      {
        bandCount: 2,
        globalMix: 100,
        limiterEnabled: 0,
        "band1.lofiEnabled": 1,
        "band1.lofiMode": 3,
        "band1.lofiAmount": 100,
        "band1.lofiMix": 100,
        "band2.lofiEnabled": 1,
        "band2.lofiMode": 3,
        "band2.lofiAmount": 100,
        "band2.lofiMix": 100,
      },
      { seed },
    );
    proc.prepare(SR, 2, BLOCK);

    const left = new Float32Array(BLOCK);
    const right = new Float32Array(BLOCK);
    const output: Float32Array[] = [];
    let inputSeed = 0x13579bdf;
    for (let block = 0; block < 24; block++) {
      for (let i = 0; i < BLOCK; i++) {
        inputSeed ^= inputSeed << 13;
        inputSeed ^= inputSeed >>> 17;
        inputSeed ^= inputSeed << 5;
        const sample = ((inputSeed >>> 0) / 0x100000000) * 0.6 - 0.3;
        left[i] = sample;
        right[i] = -sample;
      }
      proc.process([left, right], BLOCK);
      output.push(Float32Array.from(left), Float32Array.from(right));
    }
    return output;
  };

  it("reproduces a multi-instance export exactly for the same project seed", () => {
    const first = render(0x2468ace0);
    const second = render(0x2468ace0);
    expect(second).toEqual(first);
  });

  it("changes the intentional noise stream when the render seed changes", () => {
    const first = render(0x2468ace0);
    const second = render(0x13579bdf);
    expect(second).not.toEqual(first);
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
  // Oversampled-domain limiting bounds the oversampled signal; the
  // decimation FIR's reconstruction can locally exceed it — measured
  // ~0.2% on smooth material, up to ~2.4% on sign-alternating worst cases
  // (≈0.02–0.2 dB — the reason pro ISP limiters carry a true-peak margin;
  // the fill guard covers this during priming with its own 3% margin).
  const BOUND_FACTOR = 1.003;

  it("stereo-linked limiting keeps output bounded at the ceiling from block 0", () => {
    const mod = createLimiterModule({ enabled: 1, ceilDb: -3, truePeak: 1, lookaheadMs: 2, stereoLink: 1 });
    mod.prepare(SR, 2, BLOCK);
    // Loud, decorrelated stereo material FROM SAMPLE 0: the fill guard
    // (Chan.fillPeak) must clamp the envelope while the lookahead ring
    // primes, so the ceiling holds immediately — no startup overshoot.
    const bound = Math.pow(10, -3 / 20) * BOUND_FACTOR + 1e-6;
    for (let blk = 0; blk < 64; blk++) {
      const L = new Float32Array(BLOCK);
      const R = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        L[i] = Math.sin((2 * Math.PI * 3117 * (blk * BLOCK + i)) / SR) * 4;
        R[i] = Math.sin((2 * Math.PI * 1973 * (blk * BLOCK + i)) / SR) * 4;
      }
      mod.process([L, R], BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        expect(Number.isFinite(L[i])).toBe(true);
        expect(Number.isFinite(R[i])).toBe(true);
        expect(Math.abs(L[i]), `block ${blk} sample ${i} exceeded the ceiling`).toBeLessThanOrEqual(bound);
        expect(Math.abs(R[i]), `block ${blk} sample ${i} exceeded the ceiling`).toBeLessThanOrEqual(bound);
      }
    }
  });

  it("fill guard clamps a transient inside the first (unlookaheaded) block", () => {
    // In block 0 the effective lookahead is zero, so the detector window is
    // the single current sample — a burst starting mid-block-0 passed at
    // FULL amplitude in the old code (+8 dB over the ceiling until the ring
    // primed). The fill guard clamps the envelope to the loudest peak
    // witnessed so far, so the burst is limited immediately.
    const mod = createLimiterModule({ enabled: 1, ceilDb: -3, truePeak: 1, lookaheadMs: 2, stereoLink: 1 });
    mod.prepare(SR, 2, BLOCK);
    const bound = Math.pow(10, -3 / 20) * BOUND_FACTOR + 1e-6;
    const burstFrom = 96; // inside block 0, before any lookahead exists
    let maxSeen = 0;
    for (let blk = 0; blk < 16; blk++) {
      const L = new Float32Array(BLOCK);
      const R = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        const n = blk * BLOCK + i;
        const v = n >= burstFrom ? Math.sin((2 * Math.PI * 997 * n) / SR) * 4 : 0;
        L[i] = v;
        R[i] = v;
      }
      mod.process([L, R], BLOCK);
      for (let i = burstFrom > blk * BLOCK ? burstFrom - blk * BLOCK : 0; i < BLOCK; i++) {
        maxSeen = Math.max(maxSeen, Math.abs(L[i]), Math.abs(R[i]));
      }
    }
    expect(
      maxSeen,
      `burst output reached ${maxSeen.toFixed(4)} (ceiling bound ${bound.toFixed(4)})`,
    ).toBeLessThanOrEqual(bound);
  });
});

describe("fxeq-core de-click parameter smoothing", () => {
  function maxJump(buf: Float32Array): number {
    let m = 0;
    for (let i = 1; i < buf.length; i++) {
      const d = Math.abs(buf[i] - buf[i - 1]);
      if (d > m) m = d;
    }
    return m;
  }

  it("saturation drive change glides instead of stepping", () => {
    const mod = createSaturationModule();
    mod.prepare(SR, 2, BLOCK);
    mod.setParameter("enabled", 1);
    mod.setParameter("driveDb", 0);
    mod.setParameter("mix", 100);

    const steady = new Float32Array(BLOCK);
    for (let blk = 0; blk < 40; blk++) {
      const L = new Float32Array(BLOCK);
      const R = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        L[i] = Math.sin((2 * Math.PI * 220 * (blk * BLOCK + i)) / SR) * 0.6;
        R[i] = L[i];
      }
      mod.process([L, R], BLOCK);
      if (blk === 39) steady.set(L);
    }
    const steadyJump = maxJump(steady);

    // Full-scale drive step mid-stream.
    mod.setParameter("driveDb", 24);
    let changeJump = 0;
    for (let blk = 40; blk < 140; blk++) {
      const L = new Float32Array(BLOCK);
      const R = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        L[i] = Math.sin((2 * Math.PI * 220 * (blk * BLOCK + i)) / SR) * 0.6;
        R[i] = L[i];
      }
      mod.process([L, R], BLOCK);
      changeJump = Math.max(changeJump, maxJump(L));
    }
    // The glide keeps the worst per-sample jump in the same class as the
    // steady-state signal (a raw 24 dB drive step multiplies it several-fold).
    expect(changeJump, `drive step caused a ${changeJump.toFixed(4)} discontinuity`).toBeLessThan(
      Math.max(0.02, steadyJump * 3),
    );
  });

  it("reverb decay change glides the feedback gains instead of jumping the tail", () => {
    const mod = createReverbModule();
    mod.prepare(SR, 2, BLOCK);
    mod.setParameter("enabled", 1);
    mod.setParameter("mix", 100);
    mod.setParameter("decayMs", 400);

    const steady = new Float32Array(BLOCK);
    for (let blk = 0; blk < 40; blk++) {
      const L = new Float32Array(BLOCK);
      const R = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        L[i] = Math.sin((2 * Math.PI * 990 * (blk * BLOCK + i)) / SR) * 0.5;
        R[i] = Math.sin((2 * Math.PI * 990 * (blk * BLOCK + i)) / SR) * 0.5;
      }
      mod.process([L, R], BLOCK);
      if (blk === 39) steady.set(L);
    }
    const steadyJump = maxJump(steady);

    mod.setParameter("decayMs", 8000); // huge decay jump mid-tail
    let changeJump = 0;
    for (let blk = 40; blk < 120; blk++) {
      const L = new Float32Array(BLOCK);
      const R = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        L[i] = Math.sin((2 * Math.PI * 990 * (blk * BLOCK + i)) / SR) * 0.5;
        R[i] = L[i];
      }
      mod.process([L, R], BLOCK);
      changeJump = Math.max(changeJump, maxJump(L));
    }
    expect(changeJump, `decay step caused a ${changeJump.toFixed(4)} discontinuity in the tail`).toBeLessThan(
      Math.max(0.02, steadyJump * 3),
    );
  });
});

describe("fxeq tape delay wobble read-head guard", () => {
  // At the 1 ms minimum delay on an 8 kHz device the delay is 8 samples, so
  // the ±12-sample wobble used to push the read AHEAD of the write head —
  // the wrapped ring served ~2 s old content back into the output (and the
  // feedback path re-wrote it at the live head). After a loud prime, silence
  // must stay silent; normal delays (≥ 32 samples at 44.1 kHz+) never reach
  // the guard floor, so audible wobble is unchanged.
  it("sub-12-sample tape delay never serves stale ring content", () => {
    const sr = 8000;
    const block = 128;
    const mod = createDelayModule({ enabled: 1, type: 1, timeMs: 1, feedback: 0.5, mix: 100 });
    mod.prepare(sr, 1, block);
    // 2 s of loud tone primes the ring; the 0.5 Hz wobble dips below the
    // guard floor around 0.5 s into the silence — exactly when the ~2.02 s
    // ring still holds prime content.
    for (let b = 0; b < Math.ceil((sr * 2) / block); b++) {
      const loud = new Float32Array(block);
      for (let i = 0; i < block; i++) loud[i] = Math.sin((2 * Math.PI * 997 * i) / sr) * 0.8;
      mod.process([loud], block);
    }
    // The first blocks still carry the legitimate 8-sample-spaced tail
    // (fb 0.5 decays it within ~2 blocks) — assert past the decay so ONLY
    // stale ring content can fail.
    for (let b = 0; b < Math.ceil((sr * 3) / block); b++) {
      const silent = new Float32Array(block);
      mod.process([silent], block);
      if (b < 4) continue;
      let peak = 0;
      for (let i = 0; i < block; i++) peak = Math.max(peak, Math.abs(silent[i]));
      expect(peak, `stale ring content leaked at silence block ${b}`).toBeLessThan(1e-5);
    }
  });
});

describe("fxeq solo continuity (band tails keep clocking)", () => {
  const PARAMS = {
    bandCount: 2,
    "band2.delayEnabled": 1,
    "band2.delayType": 0,
    "band2.delayTimeMs": 50,
    "band2.delayFeedback": 0.5,
    "band2.delayMix": 100,
    limiterEnabled: 0,
    globalMix: 100,
  };

  /** Drive with a deterministic per-block PRNG signal; returns the outputs. */
  function drive(proc: ReturnType<typeof createFxEqProcessor>, seed: number, blocks: number): Float32Array[][] {
    const out: Float32Array[][] = [];
    for (let b = 0; b < blocks; b++) {
      const L = new Float32Array(BLOCK);
      const R = new Float32Array(BLOCK);
      let s = (seed + b * 0x9e37) >>> 0;
      for (let i = 0; i < BLOCK; i++) {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        L[i] = ((s >>> 0) / 0x100000000) * 2 - 1;
        R[i] = -L[i];
      }
      proc.process([L, R], BLOCK);
      out.push([L, R]);
    }
    return out;
  }

  it("un-soloing resumes bit-identically to a never-soloed reference", () => {
    const soloed = createFxEqProcessor();
    const reference = createFxEqProcessor();
    soloed.prepare(SR, 2, BLOCK);
    reference.prepare(SR, 2, BLOCK);
    soloed.loadParameters(PARAMS);
    reference.loadParameters(PARAMS);

    drive(soloed, 7, 40);
    drive(reference, 7, 40);

    // Solo band 1 for one second — band 2 must keep clocking underneath
    // (both processors consume the same input the whole time).
    soloed.setParameter("band1.solo", 1);
    drive(soloed, 99, 80);
    drive(reference, 99, 80);
    soloed.setParameter("band1.solo", 0);

    // After un-solo the soloed processor must be bit-identical to the
    // never-soloed reference: skipping process() for soloed-out bands used
    // to freeze band 2's delay line, so the resumed output diverged here.
    const a = drive(soloed, 5, 12);
    const b = drive(reference, 5, 12);
    for (let blk = 0; blk < 12; blk++) {
      for (let c = 0; c < 2; c++) {
        for (let i = 0; i < BLOCK; i++) {
          expect(a[blk][c][i], `block ${blk} channel ${c} sample ${i} diverged after un-solo`).toBe(b[blk][c][i]);
        }
      }
    }
  });

  it("band meters track live levels while another band is soloed", () => {
    const proc = createFxEqProcessor();
    proc.prepare(SR, 2, BLOCK);
    proc.loadParameters({ bandCount: 2, limiterEnabled: 0, globalMix: 100 });
    // 1 kHz lands mostly in band 2 (top band, LP split at 400 Hz).
    const hot = [0, 1].map(() => new Float32Array(BLOCK));
    for (let i = 0; i < BLOCK; i++) {
      const v = Math.sin((2 * Math.PI * 1000 * i) / SR) * 0.8;
      hot[0][i] = v;
      hot[1][i] = v;
    }
    proc.process(hot, BLOCK);
    expect(proc.getBandPeaks()[1]).toBeGreaterThan(0.4);

    proc.setParameter("band1.solo", 1);
    for (let b = 0; b < 8; b++) {
      const quiet = [0, 1].map(() => new Float32Array(BLOCK));
      for (let i = 0; i < BLOCK; i++) {
        const v = Math.sin((2 * Math.PI * 1000 * i) / SR) * 0.01;
        quiet[0][i] = v;
        quiet[1][i] = v;
      }
      proc.process(quiet, BLOCK);
    }
    // Band 2 keeps clocking on the quiet input, so its meter must fall —
    // the old skip-process code left the stale hot peak on the meter.
    expect(proc.getBandPeaks()[1]).toBeLessThan(0.05);
  });
});

describe("fxeq crossover ordering guard (roadmap Q5)", () => {
  it("single changes cannot invert band order", () => {
    const proc = createFxEqProcessor();
    proc.prepare(SR, 2, BLOCK);
    // f3 below f2 (default 400) clamps up to f2 + 40 Hz gap.
    proc.setParameter("crossoverFreq3", 300);
    expect(proc.getParameter("crossoverFreq3")).toBe(440);
    // f2 above f3 (now 440) clamps down to f3 − 40 Hz gap.
    proc.setParameter("crossoverFreq2", 10000);
    expect(proc.getParameter("crossoverFreq2")).toBe(400);
    // In-range, non-crossing values pass through untouched.
    proc.setParameter("crossoverFreq2", 350);
    expect(proc.getParameter("crossoverFreq2")).toBe(350);
    expect(proc.getParameter("crossoverFreq3")).toBe(440);
  });

  it("bulk preset load with crossing splits resolves ascending and stays finite", () => {
    const proc = createFxEqProcessor();
    proc.prepare(SR, 2, BLOCK);
    proc.loadParameters({
      crossoverFreq2: 800,
      crossoverFreq3: 300,
      crossoverFreq4: 100,
      crossoverFreq5: 50,
    });
    const f2 = proc.getParameter("crossoverFreq2");
    const f3 = proc.getParameter("crossoverFreq3");
    const f4 = proc.getParameter("crossoverFreq4");
    const f5 = proc.getParameter("crossoverFreq5");
    expect(f2).toBeLessThan(f3);
    expect(f3).toBeLessThan(f4);
    expect(f4).toBeLessThan(f5);
    expect(f3 - f2).toBeGreaterThanOrEqual(40);
    expect(f4 - f3).toBeGreaterThanOrEqual(40);
    expect(f5 - f4).toBeGreaterThanOrEqual(40);

    // Audio path with the clamped splits stays finite.
    for (let blk = 0; blk < 6; blk++) {
      const L = new Float32Array(BLOCK);
      const R = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        L[i] = Math.sin((2 * Math.PI * 997 * (blk * BLOCK + i)) / SR) * 0.5;
        R[i] = -L[i];
      }
      proc.process([L, R], BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        expect(Number.isFinite(L[i])).toBe(true);
      }
    }
  });
});

describe("fxeq limiter program-dependent release (roadmap Q4)", () => {
  const BASE = { enabled: 1, ceilDb: -6, releaseMs: 100, truePeak: 1, lookaheadMs: 0, stereoLink: 0 };

  function sustainThenSilence(pdr: number): { grAt: (offsetSamples: number) => number } {
    const mod = createLimiterModule({ ...BASE, pdr });
    mod.prepare(SR, 1, BLOCK);
    // 0.9 amplitude against a −6 dB ceiling (≈0.5) → deep sustained GR.
    for (let blk = 0; blk < 200; blk++) {
      const buf = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) buf[i] = Math.sin((2 * Math.PI * 997 * (blk * BLOCK + i)) / SR) * 0.9;
      mod.process([buf], BLOCK);
    }
    // Silence from here — the release trajectory is what we measure.
    const silenceBlocks = 40;
    for (let blk = 0; blk < silenceBlocks; blk++) mod.process([new Float32Array(BLOCK)], BLOCK);
    return {
      grAt(offsetSamples: number): number {
        void offsetSamples;
        return mod.getGainReductionDb!();
      },
    };
  }

  it("pdr=1 recovers slower from deep sustained gain reduction than pdr=0", () => {
    // Release started after the same sustain; measure the REMAINING gain
    // reduction right after 15 blocks (≈16 ms @48k) of silence.
    const fast = sustainThenSilence(0);
    const slow = sustainThenSilence(1);
    // 15 blocks of silence have already elapsed inside the helper — the
    // helper consumed the same timeline for both, so compare final GR.
    expect(slow.grAt(0)).toBeGreaterThan(fast.grAt(0) + 0.3);
  });

  it("pdr=0 is bit-identical to the pre-Q4 behaviour", () => {
    const withParam = createLimiterModule({ ...BASE, pdr: 0 });
    const without = createLimiterModule({ ...BASE });
    withParam.prepare(SR, 1, BLOCK);
    without.prepare(SR, 1, BLOCK);
    for (let blk = 0; blk < 30; blk++) {
      const a = new Float32Array(BLOCK);
      const b = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        const v = Math.sin((2 * Math.PI * 3117 * (blk * BLOCK + i)) / SR) * 2;
        a[i] = v;
        b[i] = v;
      }
      withParam.process([a], BLOCK);
      without.process([b], BLOCK);
      for (let i = 0; i < BLOCK; i++) expect(a[i]).toBe(b[i]);
    }
  });

  it("ceiling still holds with pdr=1 on hot alternating material", () => {
    const mod = createLimiterModule({ ...BASE, pdr: 1 });
    mod.prepare(SR, 2, BLOCK);
    // Sign-alternating ±3 is the documented worst case: the decimation
    // FIR's reconstruction locally exceeds the oversampled-domain ceiling
    // by up to ~2.4% (see the hoisted-scratch suite above) — hence the 3%
    // margin instead of the smooth-material 0.3%.
    const bound = Math.pow(10, -6 / 20) * 1.03 + 1e-6;
    for (let blk = 0; blk < 40; blk++) {
      const L = new Float32Array(BLOCK);
      const R = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        L[i] = (i % 2 === 0 ? 1 : -1) * 3;
        R[i] = -L[i];
      }
      mod.process([L, R], BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        expect(Math.abs(L[i])).toBeLessThanOrEqual(bound);
        expect(Number.isFinite(L[i])).toBe(true);
      }
    }
  });
});

describe("fxeq ping-pong hermite cross-read (roadmap P)", () => {
  it("ping-pong type runs stereo without NaN and bounces between channels", () => {
    const mod = createDelayModule({ enabled: 1, type: 2, timeMs: 120, feedback: 0.5, mix: 100, dampHz: 8000 });
    mod.prepare(SR, 2, BLOCK);
    const impulseAt = 5;
    const channelPeaks = [0, 0];
    let total = 0;
    // 120 ms delay: L echoes at ~120 ms, R only after the cross-feedback
    // bounces back (~240 ms) — run well past three repeats.
    for (let blk = 0; blk < 200 && total < 0.4 * SR; blk++) {
      const L = new Float32Array(BLOCK);
      const R = new Float32Array(BLOCK);
      if (total <= impulseAt && impulseAt < total + BLOCK) L[impulseAt - total] = 0.9;
      mod.process([L, R], BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        expect(Number.isFinite(L[i])).toBe(true);
        expect(Number.isFinite(R[i])).toBe(true);
        channelPeaks[0] = Math.max(channelPeaks[0], Math.abs(L[i]));
        channelPeaks[1] = Math.max(channelPeaks[1], Math.abs(R[i]));
      }
      total += BLOCK;
    }
    // Both ears hear the bounce (feedback crosses L↔R), not just the input.
    expect(channelPeaks[0]).toBeGreaterThan(0.01);
    expect(channelPeaks[1]).toBeGreaterThan(0.01);
  });
});

describe("fxeq reverb tank upgrade (roadmap Q1)", () => {
  const TANK = { enabled: 1, type: 1, decayMs: 2200, mix: 100, predelayMs: 10 };

  function renderTank(extra: Record<string, number>): Float32Array {
    const mod = createReverbModule({ ...TANK, ...extra });
    mod.prepare(SR, 2, BLOCK);
    const frames = BLOCK * 60;
    const out = new Float32Array(frames);
    for (let off = 0; off < frames; off += BLOCK) {
      const L = new Float32Array(BLOCK);
      const R = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        const n = off + i;
        L[i] = Math.sin((2 * Math.PI * 997 * n) / SR) * 0.5;
        R[i] = Math.cos((2 * Math.PI * 743 * n) / SR) * 0.5;
      }
      mod.process([L, R], BLOCK);
      out.set(L, off);
    }
    return out;
  }

  it("8-line modulated tank is deterministic and finite", () => {
    const a = renderTank({ modDepthPct: 60, modRateHz: 0.6 });
    const b = renderTank({ modDepthPct: 60, modRateHz: 0.6 });
    for (let i = 0; i < a.length; i++) {
      expect(Number.isFinite(a[i]), `non-finite at ${i}`).toBe(true);
      expect(a[i]).toBe(b[i]);
    }
  });

  it("modulation actually moves the tail (depth > 0 differs from depth = 0)", () => {
    const off = renderTank({});
    const on = renderTank({ modDepthPct: 60 });
    let diff = 0;
    for (let i = 0; i < off.length; i++) diff = Math.max(diff, Math.abs(off[i] - on[i]));
    expect(diff).toBeGreaterThan(1e-3);
  });

  it("modulated tank still decays under sustained silence", () => {
    const mod = createReverbModule({ enabled: 1, type: 0, decayMs: 100, mix: 100, modDepthPct: 100, modRateHz: 1 });
    mod.prepare(SR, 2, BLOCK);
    for (let blk = 0; blk < Math.floor(SR / BLOCK); blk++) {
      const L = new Float32Array(BLOCK);
      const R = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) L[i] = Math.sin((2 * Math.PI * 440 * (blk * BLOCK + i)) / SR) * 0.8;
      mod.process([L, R], BLOCK);
    }
    for (let blk = 0; blk < Math.floor((SR * 2) / BLOCK); blk++) {
      const L = new Float32Array(BLOCK);
      const R = new Float32Array(BLOCK);
      mod.process([L, R], BLOCK);
      if (blk > 20) {
        let peak = 0;
        for (let i = 0; i < BLOCK; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
        expect(peak, `tail grew at silence block ${blk}`).toBeLessThan(1e-2);
      }
    }
  });
});
describe("fxeq latency-transition stale-buffer regression (alignment rings)", () => {
  // Band latency flips 0↔8 mid-stream (saturation enable toggles, drive
  // automation crossing the oversample threshold). Every ring that only
  // clocks while its delayed read is active replays the PREVIOUS latency
  // period's content as an 8-sample stale burst when the read switches
  // back on. These tests pin the three layers involved: the processor's
  // band/dry alignment rings, the saturation wrapper's per-factor FIR
  // lines, and its dry-alignment ring.

  const SILENCE_TAIL_FLOOR = 1e-5; // legit crossover/limiter decay sits ~1e-6

  function loudBlock(chans: Float32Array[], index: number) {
    for (let i = 0; i < BLOCK; i++) {
      const v = Math.sin((2 * Math.PI * 1000 * (index * BLOCK + i)) / SR) * 0.9;
      chans[0][i] = v;
      chans[1][i] = v;
    }
  }

  function silenceBlock(chans: Float32Array[]) {
    chans[0].fill(0);
    chans[1].fill(0);
  }

  function blockPeak(chans: Float32Array[]): number {
    let m = 0;
    for (let c = 0; c < 2; c++)
      for (let i = 0; i < BLOCK; i++) {
        const a = Math.abs(chans[c][i]);
        if (a > m) m = a;
      }
    return m;
  }

  it("silence stays silent when a latency band is re-enabled mid-stream", () => {
    const proc = createFxEqProcessor();
    proc.prepare(SR, 2, BLOCK);
    proc.loadParameters({
      limiterEnabled: 0,
      globalMix: 50,
      "band1.satEnabled": 1,
      "band1.satMode": 4,
      "band1.satDriveDb": 18,
      "band1.quality": 1,
    });
    const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    // Latency period with loud content (rings clocked hot).
    for (let b = 0; b < 10; b++) {
      loudBlock(chans, b);
      proc.process(chans, BLOCK);
    }
    // Drop the latency structure to 0, let legit tails decay.
    proc.setParameter("band1.satEnabled", 0);
    for (let b = 0; b < 40; b++) {
      silenceBlock(chans);
      proc.process(chans, BLOCK);
    }
    expect(blockPeak(chans)).toBeLessThan(SILENCE_TAIL_FLOOR);
    // Re-enable on silence — the FIRST block is where a stale ring burst
    // escaped (previously up to 0.16 amplitude of pre-disable audio).
    proc.setParameter("band1.satEnabled", 1);
    for (let b = 0; b < 4; b++) {
      silenceBlock(chans);
      proc.process(chans, BLOCK);
      expect(blockPeak(chans), `stale burst in re-enable block ${b}`).toBeLessThan(SILENCE_TAIL_FLOOR);
    }
  });

  it("silence stays silent when drive automation re-crosses the oversample threshold", () => {
    const proc = createFxEqProcessor();
    proc.prepare(SR, 2, BLOCK);
    proc.loadParameters({
      limiterEnabled: 0,
      globalMix: 50,
      "band1.satEnabled": 1,
      "band1.satMode": 4,
      "band1.satDriveDb": 18, // factor 2 → band latency 8
      "band1.satMix": 60,
      "band1.quality": 1,
    });
    const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    // Hot factor-2 period first (smoother primes at 18 on the first block):
    // latency must be live and the FIR history loud before the glide.
    for (let b = 0; b < 10; b++) {
      loudBlock(chans, b);
      proc.process(chans, BLOCK);
    }
    expect(proc.getLatencySamples()).toBeGreaterThan(0);
    // Phase A — glide the drive down (smoother moves ~0.17 %/block, so the
    // 6 dB threshold lands after ~650 blocks) while feeding LOUD material,
    // so the factor-2 FIR history is still hot at the moment the module
    // actually drops to factor 1. Stop right after the real 2→1 crossing.
    proc.setParameter("band1.satDriveDb", 0);
    let crossedDownAt = -1;
    for (let b = 0; b < 1200 && crossedDownAt < 0; b++) {
      loudBlock(chans, b);
      proc.process(chans, BLOCK);
      if (proc.getLatencySamples() === 0) crossedDownAt = b;
    }
    expect(crossedDownAt, "descent must actually cross the threshold").toBeGreaterThan(0);
    // Phase B — silence: legit tails decay; nothing may ring above the
    // floor (the module now runs at factor 1 on silence).
    for (let b = 0; b < 40; b++) {
      silenceBlock(chans);
      proc.process(chans, BLOCK);
    }
    expect(blockPeak(chans)).toBeLessThan(SILENCE_TAIL_FLOOR);
    // Phase C — drive back up. The 1→2 crossing (~70 blocks in) re-enters
    // the oversampled path: its FIR lines and dry ring must not replay the
    // loud descent material they last held.
    proc.setParameter("band1.satDriveDb", 18);
    for (let b = 0; b < 300; b++) {
      silenceBlock(chans);
      proc.process(chans, BLOCK);
      expect(blockPeak(chans), `stale burst in ascent block ${b}`).toBeLessThan(SILENCE_TAIL_FLOOR);
    }
    expect(proc.getLatencySamples(), "ascent must actually re-cross the threshold").toBeGreaterThan(0);
  });

  it("saturation module re-enable after a bypassed period starts from clean FIR history", () => {
    const mod = createSaturationModule();
    mod.prepare(SR, 2, BLOCK);
    mod.loadParameters({ enabled: 1, mode: 4, driveDb: 18, mix: 60 });
    const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    for (let b = 0; b < 10; b++) {
      loudBlock(chans, b);
      mod.process(chans, BLOCK);
    }
    mod.setParameter("enabled", 0);
    for (let b = 0; b < 10; b++) {
      silenceBlock(chans);
      mod.process(chans, BLOCK);
    }
    // While bypassed the module never runs, so its FIR/dry history holds
    // pre-bypass audio; re-enabling must not replay it.
    mod.setParameter("enabled", 1);
    for (let b = 0; b < 4; b++) {
      silenceBlock(chans);
      mod.process(chans, BLOCK);
      expect(blockPeak(chans), `stale burst in re-enable block ${b}`).toBeLessThan(1e-6);
    }
  });
});
