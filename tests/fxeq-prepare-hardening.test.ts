/**
 * FXEQ lifecycle & prepare-hardening regression suite.
 *
 * Covers defect classes found in the 2026-09 hardening audit:
 *
 *  1. Re-prepare capacity (P1): the reverb FDN used to keep buffers sized
 *     for the OLD sample rate when prepare() ran again with the same
 *     channel count. With hall (lenMult 1.4) at 96 kHz the write cursor
 *     crossed the old physical capacity after ~17 blocks of 128 — OOB
 *     reads return undefined, the tank NaN-poisons the wet sum, and the
 *     processor's final sanitizer masks it as total silence. Plate
 *     (lenMult 0.7) never trips this, which is why earlier rate-switch
 *     tests passed — these tests pin the failing configuration.
 *  2. Whole-processor re-prepare with every module active must keep the
 *     wet path ALIVE (finite is not enough — the sanitizer makes a dead
 *     path look finite).
 *  3. Parameter boundary validation: setParameter / constructor params /
 *     morph targets clamp to the schema range exactly like loadParameters
 *     (per-block consumers read the flat store raw).
 *  4. State round-trip: getParameters() → new processor → identical audio.
 *  5. Determinism, tail decay, and out-of-range fuzz.
 */
import { describe, expect, it } from "vitest";
import { createFxEqProcessor } from "../src/effects/fxeq-core/core/fxEqProcessor";
import { createReverbModule } from "../src/effects/fxeq-core/modules/reverb";
import { buildSchema } from "../src/effects/fxeq-core/core/parameterSchema";

const BLOCK = 128;

function tone(n: number, freq: number, sr: number, amp = 0.8): Float32Array {
  const ch = new Float32Array(n);
  for (let i = 0; i < n; i++) ch[i] = Math.sin((2 * Math.PI * freq * i) / sr) * amp;
  return ch;
}

/** Deterministic PRNG for reproducible fuzz configurations. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

/** Energy of a buffer — used to prove the wet path is alive (0 ⇒ dead). */
function energy(ch: Float32Array): number {
  let e = 0;
  for (let i = 0; i < ch.length; i++) e += ch[i] * ch[i];
  return e;
}

describe("fxeq reverb re-prepare capacity (P1 regression)", () => {
  it("hall at 96 kHz after a 44.1 kHz prepare stays finite AND audible", () => {
    const mod = createReverbModule({ enabled: 1, mix: 50, type: 1, decayMs: 2000 });
    mod.prepare(44100, 2, BLOCK);
    mod.process([tone(BLOCK, 440, 44100, 0.3), tone(BLOCK, 551, 44100, 0.3)], BLOCK);

    mod.prepare(96000, 2, BLOCK);
    // Old capacity ≈ 2265 samples ≈ 17.7 blocks of 128 — run well past it.
    for (let blk = 0; blk < 40; blk++) {
      const L = tone(BLOCK, 440, 96000, 0.3);
      const R = tone(BLOCK, 551, 96000, 0.3);
      mod.process([L, R], BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        expect(Number.isFinite(L[i]), `block ${blk} sample ${i}`).toBe(true);
        expect(Number.isFinite(R[i]), `block ${blk} sample ${i}`).toBe(true);
      }
    }
    // Wet path alive: a driven reverb must return energy.
    const L = tone(BLOCK, 440, 96000, 0.3);
    const R = tone(BLOCK, 551, 96000, 0.3);
    mod.process([L, R], BLOCK);
    expect(energy(L) + energy(R)).toBeGreaterThan(1e-6);
  });

  it("88.2 kHz and 192 kHz re-prepares stay finite for every reverb type", () => {
    for (const type of [0, 1, 2]) {
      const mod = createReverbModule({ enabled: 1, mix: 50, type, decayMs: 3000 });
      mod.prepare(44100, 2, BLOCK);
      mod.process([tone(BLOCK, 440, 44100, 0.3), tone(BLOCK, 551, 44100, 0.3)], BLOCK);
      for (const sr of [88200, 192000]) {
        mod.prepare(sr, 2, BLOCK);
        for (let blk = 0; blk < 12; blk++) {
          const L = tone(BLOCK, 440, sr, 0.3);
          const R = tone(BLOCK, 551, sr, 0.3);
          mod.process([L, R], BLOCK);
          for (let i = 0; i < BLOCK; i++) {
            expect(Number.isFinite(L[i]), `type ${type} sr ${sr} block ${blk}`).toBe(true);
          }
        }
      }
    }
  });
});

describe("fxeq processor re-prepare lifecycle (all modules active)", () => {
  // All six module types on every band. The dyn threshold sits at 0 dB so
  // the six cascaded compressors do not legitimately crush the signal to
  // inaudibility (their -24 dB default threshold compounds to ~-140 dB
  // through the stack — a valid but useless probe configuration).
  const ALL_ON: Record<string, number> = {
    ...Object.fromEntries(
      buildSchema(6).defs
        .filter((d) => /(sat|dyn|lofi|mod|delay|rev)Enabled$/.test(d.id))
        .map((d) => [d.id, 1]),
    ),
    ...Object.fromEntries(
      buildSchema(6).defs
        .filter((d) => /^band\d+\.dynThreshDb$/.test(d.id))
        .map((d) => [d.id, 0]),
    ),
    "band2.satDriveDb": 18,
    "band2.quality": 2,
    limiterEnabled: 0,
    globalMix: 100,
  };

  it("re-prepare 44.1→96 kHz then reset is bit-identical to a fresh processor", () => {
    // Invariant: a processor that was prepared, driven, re-prepared at a new
    // rate, driven past the old buffer capacities, and reset must render
    // EXACTLY what a freshly constructed processor renders. The pre-fix
    // reverb defect made the re-prepared instance diverge (NaN tank →
    // sanitizer → permanent silence) once the FDN cursor crossed the old
    // 44.1 kHz-era capacity (~block 17 of 128).
    const recycled = createFxEqProcessor();
    recycled.prepare(44100, 2, BLOCK);
    recycled.loadParameters(ALL_ON);
    for (let blk = 0; blk < 10; blk++) {
      recycled.process([tone(BLOCK, 700, 44100, 0.5), tone(BLOCK, 551, 44100, 0.5)], BLOCK);
    }
    recycled.prepare(96000, 2, BLOCK);
    recycled.loadParameters(ALL_ON);
    // Advance well past the 44.1 kHz-era FDN capacity (~17.7 blocks).
    for (let blk = 0; blk < 30; blk++) {
      recycled.process([tone(BLOCK, 700, 96000, 0.5), tone(BLOCK, 551, 96000, 0.5)], BLOCK);
    }
    recycled.reset();

    const fresh = createFxEqProcessor();
    fresh.prepare(96000, 2, BLOCK);
    fresh.loadParameters(ALL_ON);
    fresh.reset();

    let rendered = 0;
    // 150 blocks ≈ 200 ms at 96 kHz: the dynamics module's envelope starts
    // at −100 dB (documented upstream behavior) and climbs out over ~50 ms,
    // so the liveness total must span the steady-state region.
    for (let blk = 0; blk < 150; blk++) {
      const A = [tone(BLOCK, 300 + (blk % 24) * 11, 96000, 0.6), tone(BLOCK, 507 + (blk % 24) * 7, 96000, 0.6)];
      const B = [Float32Array.from(A[0]), Float32Array.from(A[1])];
      recycled.process(A, BLOCK);
      fresh.process(B, BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        expect(A[0][i], `recycled diverged from fresh at block ${blk} sample ${i}`).toBe(B[0][i]);
        expect(A[1][i]).toBe(B[1][i]);
      }
      rendered += energy(A[0]);
    }
    // The identical pair must also be ALIVE — silence would satisfy equality.
    expect(rendered).toBeGreaterThan(1e-3);
  });

  it("re-prepare survives repeated toggling across sample rates", () => {
    const proc = createFxEqProcessor();
    for (const sr of [44100, 48000, 44100, 96000, 88200, 44100]) {
      proc.prepare(sr, 2, BLOCK);
      proc.loadParameters(ALL_ON);
      for (let blk = 0; blk < 6; blk++) {
        const L = tone(BLOCK, 700, sr, 0.5);
        const R = tone(BLOCK, 551, sr, 0.5);
        proc.process([L, R], BLOCK);
        for (let i = 0; i < BLOCK; i++) {
          expect(Number.isFinite(L[i]), `sr ${sr} block ${blk} sample ${i}`).toBe(true);
        }
      }
    }
  });
});

describe("fxeq parameter boundary validation", () => {
  it("setParameter clamps out-of-range values into the flat store", () => {
    const proc = createFxEqProcessor();
    proc.prepare(48000, 2, BLOCK);
    proc.setParameter("inputGainDb", 1e6);
    expect(proc.getParameter("inputGainDb")).toBe(24);
    proc.setParameter("outputGainDb", -1e6);
    expect(proc.getParameter("outputGainDb")).toBe(-24);
    proc.setParameter("band1.gainDb", 999);
    expect(proc.getParameter("band1.gainDb")).toBe(12);
    // In-range values pass through unchanged.
    proc.setParameter("inputGainDb", -7.5);
    expect(proc.getParameter("inputGainDb")).toBe(-7.5);
  });

  it("an extreme inputGainDb cannot nuke the output (sanitizer is not the only defense)", () => {
    const proc = createFxEqProcessor();
    proc.prepare(48000, 2, BLOCK);
    // Pre-fix this stored 1e6 raw → gain 10^50000 → Inf → total silence via
    // the final sanitizer. Clamped to +24 dB it must behave exactly like a
    // legitimate +24 dB setting: gain applied, output finite. Limiter off so
    // the pure gain path is observable.
    proc.setParameter("inputGainDb", 1e6);
    proc.setParameter("limiterEnabled", 0);
    const L = tone(BLOCK, 440, 48000, 0.5);
    const R = tone(BLOCK, 551, 48000, 0.5);
    proc.process([L, R], BLOCK);
    let peak = 0;
    for (let i = 0; i < BLOCK; i++) {
      expect(Number.isFinite(L[i])).toBe(true);
      expect(Number.isFinite(R[i])).toBe(true);
      peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    }
    // 0.5 × 10^(24/20) ≈ 7.9 — the clamped gain must actually be applied.
    expect(peak).toBeGreaterThan(7);
    expect(peak).toBeLessThan(9);
  });

  it("constructor params clamp to the schema range", () => {
    const proc = createFxEqProcessor({ inputGainDb: 1e9, "band1.gainDb": -999 });
    expect(proc.getParameter("inputGainDb")).toBe(24);
    expect(proc.getParameter("band1.gainDb")).toBe(-48);
  });

  it("morph targets clamp to the schema range", () => {
    const proc = createFxEqProcessor();
    proc.prepare(48000, 2, BLOCK);
    proc.startMorph({ "band1.gainDb": 999, globalMix: 500 }, 0.02);
    const L = tone(BLOCK, 440, 48000);
    const R = tone(BLOCK, 551, 48000);
    let guard = 0;
    while (proc.isMorphing && guard++ < 10000) proc.process([L, R], BLOCK);
    expect(proc.isMorphing).toBe(false);
    expect(proc.getParameter("band1.gainDb")).toBe(12);
    expect(proc.getParameter("globalMix")).toBe(100);
  });
});

describe("fxeq state round-trip (serialize → destroy → restore)", () => {
  it("getParameters() into a fresh processor reproduces identical audio", () => {
    const source = createFxEqProcessor();
    source.prepare(48000, 2, BLOCK);
    source.loadParameters({
      "band2.satEnabled": 1,
      "band2.satDriveDb": 14,
      "band2.satMode": 5,
      "band4.revEnabled": 1,
      "band4.revDecayMs": 2400,
      "band5.delayEnabled": 1,
      "band5.delayType": 2,
      "band3.lofiEnabled": 1,
      "band6.modEnabled": 1,
      "band1.dynEnable": 1,
      crossoverFreq3: 900,
      globalMix: 80,
    });
    // Advance state (tails, envelopes, delay lines).
    for (let blk = 0; blk < 40; blk++) {
      source.process([tone(BLOCK, 700, 48000), tone(BLOCK, 551, 48000)], BLOCK);
    }
    const snapshot = source.getParameters();

    // Every snapshot value must be inside the schema range (serialization
    // contract — restore must not depend on downstream clamping).
    const schema = buildSchema(Math.round(snapshot.bandCount));
    for (const [id, value] of Object.entries(snapshot)) {
      const def = schema.defById.get(id);
      if (!def) continue;
      expect(
        value,
        `serialized ${id}=${value} outside schema range [${def.minValue}, ${def.maxValue}]`,
      ).toBeGreaterThanOrEqual(def.minValue);
      expect(value).toBeLessThanOrEqual(def.maxValue);
    }

    const restored = createFxEqProcessor(snapshot);
    restored.prepare(48000, 2, BLOCK);
    // Fresh state vs. the source's advanced state differ (tails are runtime
    // state, not serialized) — compare the restored processor against a
    // REFERENCE built the documented way: defaults + loadParameters.
    const reference = createFxEqProcessor();
    reference.prepare(48000, 2, BLOCK);
    reference.loadParameters(snapshot);

    for (let blk = 0; blk < 12; blk++) {
      const A = [tone(BLOCK, 300 + blk * 13, 48000, 0.6), tone(BLOCK, 511 + blk * 7, 48000, 0.6)];
      const B = [Float32Array.from(A[0]), Float32Array.from(A[1])];
      restored.process(A, BLOCK);
      reference.process(B, BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        expect(A[0][i]).toBe(B[0][i]);
        expect(A[1][i]).toBe(B[1][i]);
      }
    }
  });
});

describe("fxeq determinism and decay", () => {
  it("two identically-driven processors produce bit-identical output", () => {
    const params = {
      "band2.satEnabled": 1,
      "band2.satDriveDb": 12,
      "band4.revEnabled": 1,
      "band5.delayEnabled": 1,
      "band3.lofiEnabled": 1,
      "band6.modEnabled": 1,
    };
    const a = createFxEqProcessor();
    const b = createFxEqProcessor();
    a.prepare(48000, 2, BLOCK);
    b.prepare(48000, 2, BLOCK);
    a.loadParameters(params);
    b.loadParameters(params);
    for (let blk = 0; blk < 50; blk++) {
      const s = tone(BLOCK, 700 + blk, 48000);
      const A = [Float32Array.from(s), Float32Array.from(s)];
      const B = [Float32Array.from(s), Float32Array.from(s)];
      a.process(A, BLOCK);
      b.process(B, BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        expect(A[0][i]).toBe(B[0][i]);
        expect(A[1][i]).toBe(B[1][i]);
      }
    }
  });

  it("reverb+delay tails decay under sustained silence", () => {
    const proc = createFxEqProcessor();
    proc.prepare(48000, 2, BLOCK);
    proc.loadParameters({
      "band5.revEnabled": 1,
      "band5.revDecayMs": 100,
      "band5.delayEnabled": 1,
      "band5.delayFeedback": 0.92,
      "band5.delayTimeMs": 100,
      limiterEnabled: 0,
    });
    for (let blk = 0; blk < Math.floor(48000 / BLOCK); blk++) {
      proc.process([tone(BLOCK, 440, 48000), tone(BLOCK, 441, 48000)], BLOCK);
    }
    // 2 s of silence in 10 windows — the running tail must keep falling and
    // end below −60 dB. (Guards against feedback > 1 regressions: an unstable
    // loop would GROW under silence.)
    let previous = Infinity;
    for (let w = 0; w < 10; w++) {
      let wMax = 0;
      for (let blk = 0; blk < Math.floor(4800 / BLOCK); blk++) {
        const L = new Float32Array(BLOCK);
        const R = new Float32Array(BLOCK);
        proc.process([L, R], BLOCK);
        for (let i = 0; i < BLOCK; i++) wMax = Math.max(wMax, Math.abs(L[i]), Math.abs(R[i]));
      }
      expect(wMax, `tail grew in silence window ${w}`).toBeLessThanOrEqual(previous + 1e-6);
      previous = wMax;
    }
    expect(previous).toBeLessThan(1e-3);
  });
});

describe("fxeq randomized fuzz (out-of-range values included)", () => {
  it("random schema-range and beyond-range parameter sets stay finite and bounded", () => {
    const schema6 = buildSchema(6);
    for (const sr of [44100, 96000]) {
      for (let iter = 0; iter < 30; iter++) {
        const rand = rng(0x51ed ^ (sr + iter * 7919));
        const params: Record<string, number> = {};
        for (const def of schema6.defs) {
          // 25% of values deliberately OUTSIDE the valid range — the
          // boundary validation must contain them.
          params[def.id] =
            rand() < 0.25
              ? rand() < 0.5
                ? def.minValue - 100 * rand()
                : def.maxValue + 100 * rand()
              : def.minValue + (def.maxValue - def.minValue) * rand();
        }
        // Audible path: bands on, modules on, no mute/solo tricks.
        for (let b = 1; b <= 6; b++) {
          params[`band${b}.enabled`] = 1;
          params[`band${b}.mute`] = 0;
          params[`band${b}.solo`] = 0;
          for (const key of ["sat", "dyn", "lofi", "mod", "delay", "rev"]) {
            params[`band${b}.${key}Enabled`] = 1;
          }
        }
        params.limiterEnabled = rand() < 0.5 ? 0 : 1;
        params.globalMix = 100;

        const proc = createFxEqProcessor();
        proc.prepare(sr, 2, BLOCK);
        proc.loadParameters(params);

        for (let blk = 0; blk < 8; blk++) {
          const L = new Float32Array(BLOCK);
          const R = new Float32Array(BLOCK);
          for (let i = 0; i < BLOCK; i++) {
            const n = blk * BLOCK + i;
            if (blk % 3 === 0) {
              L[i] = Math.sin((2 * Math.PI * (300 + iter) * n) / sr);
              R[i] = Math.sin((2 * Math.PI * (700 + iter) * n) / sr);
            } else if (blk % 3 === 1) {
              // Alternating near-Nyquist — worst case for oversampled paths.
              L[i] = i % 2 === 0 ? 0.99 : -0.99;
              R[i] = i % 2 === 0 ? -0.99 : 0.99;
            } else {
              L[i] = 0.9;
              R[i] = -0.9;
            }
          }
          proc.process([L, R], BLOCK);
          for (let i = 0; i < BLOCK; i++) {
            expect(Number.isFinite(L[i]), `NaN sr=${sr} iter=${iter} blk=${blk}`).toBe(true);
            // Hard sanity ceiling with the limiter off: internal gain staging
            // must stay orders of magnitude below float trouble.
            expect(Math.abs(L[i])).toBeLessThan(1e4);
          }
        }
      }
    }
  });

  it("rapid automation bursts keep the processor finite", () => {
    const proc = createFxEqProcessor();
    proc.prepare(48000, 2, BLOCK);
    const rand = rng(0xf00d);
    const ids = [
      "band1.satDriveDb", "band2.satMix", "band3.modRate", "band4.delayTimeMs",
      "band5.revDecayMs", "band6.gainDb", "band2.mix", "inputGainDb",
    ];
    for (let blk = 0; blk < 150; blk++) {
      // 20 random param changes before each block — UI-drag-rate automation.
      for (let k = 0; k < 20; k++) {
        proc.setParameter(ids[Math.floor(rand() * ids.length)], rand() * 100);
      }
      const L = tone(BLOCK, 440, 48000);
      const R = tone(BLOCK, 551, 48000);
      proc.process([L, R], BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        expect(Number.isFinite(L[i]), `storm NaN at blk ${blk}`).toBe(true);
      }
    }
  });
});
