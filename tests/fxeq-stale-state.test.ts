/**
 * FXEQ stale-audio-state regression suite.
 *
 * The codebase's own convention (see the solo fix in fxEqProcessor.process and
 * saturation's clearDelayHistory-on-re-enable) is that a processing pause must
 * never RESUME stale audio: a module/band that was disabled while signal ran,
 * then re-enabled during silence, must output silence — not echoes of the
 * pre-disable material. Delay lines, FDN tanks, wow buffers, limiter lookahead
 * rings and biquad states all carry audio; freezing them (early return while
 * disabled) replays that audio as a stale burst on re-enable.
 *
 * Every case here follows the same shape:
 *   loud signal → disable (state freezes) → sustained silence → re-enable
 *   → silence in, and the output must be silent too.
 */
import { describe, expect, it } from "vitest";
import { createFxEqProcessor } from "../src/effects/fxeq-core/core/fxEqProcessor";

const SR = 48000;
const BLOCK = 128;

/** Deterministic broadband noise burst pair (same PRNG family as the perf gate). */
function burstChannels(): Float32Array[] {
  let seed = 0x1234abc;
  const noise = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) / 0x100000000) * 2 - 1;
  };
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    l[i] = noise() * 0.8;
    r[i] = noise() * 0.8;
  }
  return [l, r];
}

const SILENCE: Float32Array[] = [new Float32Array(BLOCK), new Float32Array(BLOCK)];

function makeProc(params: Record<string, number>) {
  const proc = createFxEqProcessor();
  proc.prepare(SR, 2, BLOCK);
  proc.loadParameters({ limiterEnabled: 0, globalMix: 100, ...params });
  return proc;
}

/** Peak absolute sample across the last `tailBlocks` blocks of a run. */
function runAndMeasureTailPeak(
  proc: ReturnType<typeof createFxEqProcessor>,
  blocks: Float32Array[][],
  tailBlocks: number,
): number {
  let peak = 0;
  const start = Math.max(0, blocks.length - tailBlocks);
  for (let b = start; b < blocks.length; b++) {
    // The processor works in place — copy the input so the caller's buffer
    // stays intact for reuse across blocks.
    const ch: Float32Array[] = [new Float32Array(blocks[b][0]), new Float32Array(blocks[b][1])];
    proc.process(ch, BLOCK);
    if (b >= start) {
      for (let c = 0; c < 2; c++) {
        for (let i = 0; i < BLOCK; i++) {
          const a = Math.abs(ch[c][i]);
          if (a > peak) peak = a;
        }
      }
    }
  }
  return peak;
}

/** loud → freeze (toggle off) → silence → resume (toggle on) → silence; return tail peak. */
function freezeReenablePeak(
  params: Record<string, number>,
  toggleId: string,
  freezeValue: number,
  resumeValue: number,
): number {
  const proc = makeProc(params);
  const burst = burstChannels();
  // Build signal + tail in the effect.
  for (let i = 0; i < 30; i++) {
    proc.process([new Float32Array(burst[0]), new Float32Array(burst[1])], BLOCK);
  }
  // Freeze while loud content sits in the delay lines / tanks.
  proc.setParameter(toggleId, freezeValue);
  for (let i = 0; i < 120; i++) proc.process([new Float32Array(BLOCK), new Float32Array(BLOCK)], BLOCK);
  proc.setParameter(toggleId, resumeValue);
  // Re-enable into silence: any output here is stale pre-disable audio.
  const tail: Float32Array[][] = [];
  for (let i = 0; i < 24; i++) tail.push(SILENCE);
  return runAndMeasureTailPeak(proc, tail, 24);
}

describe("fxeq stale-audio-state on re-enable (module enabled rising edge)", () => {
  it("delay module does not replay frozen tail on re-enable", () => {
    const peak = freezeReenablePeak(
      {
        bandCount: 2,
        "band2.delayEnabled": 1,
        "band2.delayType": 0,
        "band2.delayTimeMs": 20, // short line: the ring wraps many times during the burst
        "band2.delayFeedback": 0.9,
        "band2.delayMix": 100,
      },
      "band2.delayEnabled",
      0,
      1,
    );
    expect(peak).toBeLessThan(0.01);
  });

  it("reverb module does not replay frozen tank on re-enable", () => {
    const peak = freezeReenablePeak(
      {
        bandCount: 2,
        "band2.revEnabled": 1,
        "band2.revType": 1,
        "band2.revDecayMs": 3000,
        "band2.revMix": 100,
      },
      "band2.revEnabled",
      0,
      1,
    );
    expect(peak).toBeLessThan(0.01);
  });

  it("flanger module does not replay frozen feedback/delay state on re-enable", () => {
    const peak = freezeReenablePeak(
      {
        bandCount: 2,
        "band2.modEnabled": 1,
        "band2.modType": 1,
        "band2.modRate": 0.4,
        "band2.modDepth": 90,
        "band2.modFeedback": 0.9,
        "band2.modMix": 100,
      },
      "band2.modEnabled",
      0,
      1,
    );
    expect(peak).toBeLessThan(0.01);
  });

  it("lo-fi wow/flutter does not replay frozen wow buffer on re-enable", () => {
    const peak = freezeReenablePeak(
      {
        bandCount: 2,
        "band2.lofiEnabled": 1,
        "band2.lofiMode": 2,
        "band2.lofiAmount": 100,
        "band2.lofiWobble": 100,
        "band2.lofiMix": 100,
      },
      "band2.lofiEnabled",
      0,
      1,
    );
    expect(peak).toBeLessThan(0.01);
  });

  it("band EQ does not emit a biquad-state blip on re-enable", () => {
    const peak = freezeReenablePeak(
      {
        bandCount: 2,
        "band2.eqEnabled": 1,
        "band2.eqHighGainDb": 18,
      },
      "band2.eqEnabled",
      0,
      1,
    );
    expect(peak).toBeLessThan(0.001);
  });

  it("limiter does not replay frozen lookahead ring on re-enable", () => {
    const peak = freezeReenablePeak(
      {
        limiterEnabled: 1,
        limiterTruePeak: 1,
        limiterLookaheadMs: 5,
        limiterCeilDb: -0.1,
      },
      "limiterEnabled",
      0,
      1,
    );
    expect(peak).toBeLessThan(0.01);
  });
});

describe("fxeq stale-audio-state on band unmute/enable (bandEngine)", () => {
  it("unmuting a band does not replay its frozen module tails", () => {
    const peak = freezeReenablePeak(
      {
        bandCount: 2,
        "band2.delayEnabled": 1,
        "band2.delayType": 0,
        "band2.delayTimeMs": 20,
        "band2.delayFeedback": 0.9,
        "band2.delayMix": 100,
      },
      "band2.mute",
      1,
      0,
    );
    expect(peak).toBeLessThan(0.01);
  });

  it("re-enabling a disabled band does not replay its frozen module tails", () => {
    const peak = freezeReenablePeak(
      {
        bandCount: 2,
        "band2.revEnabled": 1,
        "band2.revType": 0,
        "band2.revDecayMs": 2500,
        "band2.revMix": 100,
      },
      "band2.enabled",
      0,
      1,
    );
    expect(peak).toBeLessThan(0.01);
  });
});

describe("fxeq fresh-start equivalence after re-enable clears", () => {
  it("toggle→clear leaves the processor silent on silence (fresh-start parity)", () => {
    // After the stale-state clear, a re-enabled module fed silence must be
    // silent down to the crossover's own decaying filter residual (< 1e-5) —
    // the loud pre-toggle audio must not survive the toggle anywhere.
    const proc = makeProc({
      bandCount: 2,
      "band2.delayEnabled": 1,
      "band2.delayTimeMs": 20,
      "band2.delayFeedback": 0.9,
      "band2.delayMix": 100,
    });
    const burst = burstChannels();
    for (let i = 0; i < 30; i++) {
      proc.process([new Float32Array(burst[0]), new Float32Array(burst[1])], BLOCK);
    }
    proc.setParameter("band2.delayEnabled", 0);
    for (let i = 0; i < 50; i++) proc.process([new Float32Array(BLOCK), new Float32Array(BLOCK)], BLOCK);
    proc.setParameter("band2.delayEnabled", 1);
    let peak = 0;
    for (let i = 0; i < 40; i++) {
      const ch: Float32Array[] = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      proc.process(ch, BLOCK);
      for (let c = 0; c < 2; c++) {
        for (let s = 0; s < BLOCK; s++) {
          const a = Math.abs(ch[c][s]);
          if (a > peak) peak = a;
        }
      }
    }
    expect(peak).toBeLessThan(1e-5);
  });
});
