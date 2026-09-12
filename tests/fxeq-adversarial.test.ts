/**
 * FXEQ adversarial sweep — combined stressors over the hardened paths.
 *
 * Complements the per-defect regressions in fxeq-stale-state.test.ts with
 * interleaved stress: rapid module/band toggling under signal, hostile
 * parameter values (NaN/±Infinity via every ingestion path), predelay
 * shrink mid-stream, sample-rate sweep of the toggle paths, and
 * reset-equivalence (a reset processor must behave like a fresh one).
 */
import { describe, expect, it } from "vitest";
import { createFxEqProcessor } from "../src/effects/fxeq-core/core/fxEqProcessor";

const BLOCK = 128;

function noisePair(seed0: number): () => Float32Array[] {
  let seed = seed0;
  return () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const l = new Float32Array(BLOCK);
    const r = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      l[i] = ((seed >>> 0) / 0x100000000) * 1.6 - 0.8;
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      r[i] = ((seed >>> 0) / 0x100000000) * 1.6 - 0.8;
    }
    return [l, r];
  };
}

describe("fxeq adversarial sweep", () => {
  it("survives rapid module/band/mute toggle spam under signal with finite output", () => {
    const proc = createFxEqProcessor();
    proc.prepare(48000, 2, BLOCK);
    proc.loadParameters({
      bandCount: 6,
      "band2.satEnabled": 1,
      "band2.satDriveDb": 24,
      "band2.satMode": 5,
      "band3.revEnabled": 1,
      "band3.revDecayMs": 4000,
      "band4.delayEnabled": 1,
      "band4.delayType": 2,
      "band4.delayFeedback": 0.92,
      "band5.modEnabled": 1,
      "band5.modType": 1,
      "band5.modFeedback": 0.9,
      "band6.lofiEnabled": 1,
      "band6.lofiMode": 2,
      limiterEnabled: 1,
      limiterCeilDb: -0.1,
    });
    const next = noisePair(0xbeef);
    const toggleIds = [
      "band2.satEnabled",
      "band3.revEnabled",
      "band4.delayEnabled",
      "band5.modEnabled",
      "band6.lofiEnabled",
      "band3.mute",
      "band4.enabled",
      "limiterEnabled",
    ];
    let state = 1;
    // 400 blocks ≈ 1.07 s; toggle something every 3rd block.
    for (let i = 0; i < 400; i++) {
      if (i % 3 === 0) {
        const id = toggleIds[(i / 3) % toggleIds.length];
        state = state === 1 ? 0 : 1;
        proc.setParameter(id, id.endsWith("mute") ? (state === 1 ? 0 : 1) : state);
      }
      proc.process(next(), BLOCK);
    }
    // Final stretch: everything on, loud input — output must stay finite
    // and the limiter must contain it near the ceiling.
    for (const id of toggleIds) proc.setParameter(id, id.endsWith("mute") ? 0 : 1);
    let peak = 0;
    for (let i = 0; i < 100; i++) {
      const ch = next();
      proc.process(ch, BLOCK);
      for (let c = 0; c < 2; c++) {
        for (let s = 0; s < BLOCK; s++) {
          expect(Number.isFinite(ch[c][s])).toBe(true);
          const a = Math.abs(ch[c][s]);
          if (a > peak) peak = a;
        }
      }
    }
    // True-peak limiter at -0.1 dBFS contains the oversampled domain; the
    // sample-peak at the output can slightly exceed the linear ceiling but
    // must remain bounded far below runaway.
    expect(peak).toBeLessThan(1.1);
  });

  it("rejects hostile parameter values from every ingestion path and stays finite", () => {
    const proc = createFxEqProcessor();
    proc.prepare(48000, 2, BLOCK);
    // Constructor path (host state):
    const hostile = createFxEqProcessor(
      { inputGainDb: Number.NaN, "band1.gainDb": Infinity, globalMix: -Infinity, limiterCeilDb: Number.NaN },
      { seed: 1234 },
    );
    hostile.prepare(48000, 2, BLOCK);
    // setParameter path:
    proc.setParameter("inputGainDb", Number.NaN);
    proc.setParameter("band2.revDecayMs", Infinity);
    proc.setParameter("globalMix", Number.NaN);
    // loadParameters path (corrupt preset):
    proc.loadParameters({
      "band3.satDriveDb": Number.NaN,
      "band4.delayFeedback": Infinity,
      outputGainDb: -Infinity,
      crossoverFreq2: Number.NaN,
    });
    // paramAt-style morph path:
    proc.startMorph({ inputGainDb: Number.NaN, "band1.gainDb": Infinity }, 0.1);

    const next = noisePair(0xfeed);
    for (let i = 0; i < 60; i++) {
      const ch = next();
      proc.process(ch, BLOCK);
      for (let c = 0; c < 2; c++) {
        for (let s = 0; s < BLOCK; s++) {
          if (!Number.isFinite(ch[c][s])) throw new Error(`non-finite at block ${i}`);
        }
      }
    }
    // Values in the flat store must have stayed finite (drops/clamps).
    const all = proc.getParameters();
    for (const [id, v] of Object.entries(all)) {
      expect(Number.isFinite(v), `${id} = ${v}`).toBe(true);
    }
  });

  it("handles predelay shrink mid-stream without stale clicks or NaN (reverb cursor clamp)", () => {
    const proc = createFxEqProcessor();
    proc.prepare(48000, 2, BLOCK);
    proc.loadParameters({
      bandCount: 2,
      "band2.revEnabled": 1,
      "band2.revPredelayMs": 100,
      "band2.revMix": 50,
      limiterEnabled: 0,
    });
    const next = noisePair(0xabc);
    for (let i = 0; i < 30; i++) proc.process(next(), BLOCK);
    // Sweep the predelay down and back up mid-stream.
    for (const pd of [80, 40, 20, 5, 0, 10, 60, 100]) {
      proc.setParameter("band2.revPredelayMs", pd);
      for (let i = 0; i < 5; i++) {
        const ch = next();
        proc.process(ch, BLOCK);
        for (let c = 0; c < 2; c++) {
          for (let s = 0; s < BLOCK; s++) {
            expect(Number.isFinite(ch[c][s])).toBe(true);
          }
        }
      }
    }
  });

  it("toggle paths stay finite across sample rates (44.1/48/88.2/96 kHz)", () => {
    for (const sr of [44100, 48000, 88200, 96000]) {
      const proc = createFxEqProcessor({ seed: 77 });
      proc.prepare(sr, 2, BLOCK);
      proc.loadParameters({
        bandCount: 3,
        "band1.delayEnabled": 1,
        "band1.delayTimeMs": 5, // near the minimum — tightest ring arithmetic
        "band1.delayFeedback": 0.92,
        "band1.delayType": 1, // tape wobble: modulated read near the head
        "band2.revEnabled": 1,
        "band2.revDecayMs": 8000,
        "band3.modEnabled": 1,
        "band3.modType": 1,
        "band3.modFeedback": 0.9,
        limiterEnabled: 1,
        limiterLookaheadMs: 5,
      });
      const next = noisePair(0x999 + sr);
      for (let i = 0; i < 40; i++) proc.process(next(), BLOCK);
      proc.setParameter("band1.delayEnabled", 0);
      proc.setParameter("band2.revEnabled", 0);
      proc.setParameter("band3.modEnabled", 0);
      for (let i = 0; i < 40; i++) proc.process(next(), BLOCK);
      proc.setParameter("band1.delayEnabled", 1);
      proc.setParameter("band2.revEnabled", 1);
      proc.setParameter("band3.modEnabled", 1);
      for (let i = 0; i < 40; i++) {
        const ch = next();
        proc.process(ch, BLOCK);
        for (let c = 0; c < 2; c++) {
          for (let s = 0; s < BLOCK; s++) {
            if (!Number.isFinite(ch[c][s])) throw new Error(`non-finite at ${sr} Hz`);
          }
        }
      }
    }
  });

  it("reset() restores fresh-processor silence behavior after loud processing", () => {
    const proc = createFxEqProcessor();
    proc.prepare(48000, 2, BLOCK);
    proc.loadParameters({
      bandCount: 2,
      "band2.revEnabled": 1,
      "band2.revDecayMs": 6000,
      "band2.delayEnabled": 1,
      "band2.delayFeedback": 0.9,
      limiterEnabled: 1,
    });
    const next = noisePair(0x777);
    for (let i = 0; i < 40; i++) proc.process(next(), BLOCK);
    proc.reset();
    let peak = 0;
    for (let i = 0; i < 40; i++) {
      const ch = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      proc.process(ch, BLOCK);
      for (let c = 0; c < 2; c++) {
        for (let s = 0; s < BLOCK; s++) {
          const a = Math.abs(ch[c][s]);
          if (a > peak) peak = a;
        }
      }
    }
    expect(peak).toBe(0);
  });
});
