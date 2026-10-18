/**
 * Vocoder hardening regressions (plugin audit round 5).
 *
 * Two confirmed defects in `src/audio-worklets/vocoder-processor.js`:
 *
 * 1. **Non-finite input poisoned every recursive state.** One NaN/Infinity
 *    block latched the 32 biquad y-states and both envelope followers; every
 *    later block rendered NaN forever (the graph boundary had no guard).
 * 2. **The SIBILANCE "high-pass" was not a high-pass.** The recurrence fed
 *    back the output without subtracting the previous low-pass input, so DC
 *    and 60 Hz passed at ~0.52 and the top octave was boosted. The intended
 *    chain (LP 4 kHz → HP 500 Hz) only exists with the direct form used by
 *    vinyl-processor.js: `hp = (1-c)·(hp + lp - lpPrev)`.
 *
 * Both are negative assertions: no non-finite sample survives, and content
 * BELOW the 500 Hz corner is rejected rather than merely "different".
 *
 * The processor runs as real code under the stubbed AudioWorkletGlobalScope
 * (same host pattern as tests/vocoder.test.ts).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

class FakePort {
  onmessage: ((e: unknown) => void) | null = null;
  postMessage() {}
}
class FakeAudioWorkletProcessor {
  port = new FakePort();
}

const SR = 48000;
const BLOCK = 128;

let factory: () => {
  process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean;
  rebuildLayout?: (...args: number[]) => void;
  renderBankSample?: (...args: any[]) => void;
  fadeActive?: boolean;
  fadeWarm?: boolean;
  fadeOldBands?: number;
  fadeNewBands?: number;
  lastBands?: number;
  carCoeffs?: Float64Array;
  carCoeffsB?: Float64Array;
};

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = () => {};
  const source = readFileSync(
    resolve(import.meta.dirname ?? ".", "..", "src", "audio-worklets", "vocoder-processor.js"),
    "utf-8",
  );
  let captured: unknown = null;
  const host = new Function("registerProcessor", "AudioWorkletProcessor", "globalThis", source);
  host((_name: string, cls: unknown) => (captured = cls), FakeAudioWorkletProcessor, globalThis);
  if (!captured) throw new Error("no processor registered in vocoder-processor.js");
  factory = () => new (captured as new () => ReturnType<typeof factory>)();
});

const BASE = {
  bands: 16,
  loFreq: 120,
  hiFreq: 7000,
  q: 4,
  attack: 0.004,
  release: 0.06,
  shift: 0,
  sibilance: 1,
  stereo: 0,
  level: 0,
  mix: 1,
};

function param(patch: Record<string, number> = {}): Record<string, Float32Array> {
  return Object.fromEntries(Object.entries({ ...BASE, ...patch }).map(([k, v]) => [k, Float32Array.of(v)]));
}

function peak(data: Float32Array): number {
  let p = 0;
  for (let i = 0; i < data.length; i++) p = Math.max(p, Math.abs(data[i]));
  return p;
}

function allFinite(data: Float32Array): boolean {
  for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i])) return false;
  return true;
}

/** Largest sample-to-sample step across a captured transition. A gain step
 *  shows up here as a jump of the whole signal amplitude. */
function maxAdjacentDelta(blocks: Float32Array[], before: number): number {
  let prev = before;
  let worst = 0;
  for (const block of blocks) {
    for (let i = 0; i < block.length; i++) {
      worst = Math.max(worst, Math.abs(block[i] - prev));
      prev = block[i];
    }
  }
  return worst;
}

function sineBlocks(freq: number, amp: number, startSample = 0): [Float32Array, Float32Array] {
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    const v = amp * Math.sin((2 * Math.PI * freq * (startSample + i)) / SR);
    l[i] = v;
    r[i] = v;
  }
  return [l, r];
}

/** Render `blocks` quanta of the given modulator against a silent carrier and
 *  return the peak of the LAST block (the filters have long settled). */
function sibilanceTailPeak(freq: number | "dc", blocks: number, amp = 0.5, sr = SR): number {
  const proc = factory();
  const p = param({ sibilance: 1, mix: 1, level: 0 });
  let last = 0;
  for (let b = 0; b < blocks; b++) {
    const carrierL = new Float32Array(BLOCK);
    const carrierR = new Float32Array(BLOCK);
    const modL = new Float32Array(BLOCK);
    const modR = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      const v = freq === "dc" ? amp : amp * Math.sin((2 * Math.PI * freq * (b * BLOCK + i)) / sr);
      modL[i] = v;
      modR[i] = v;
    }
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    proc.process(
      [
        [carrierL, carrierR],
        [modL, modR],
      ],
      [[outL, outR]],
      p,
    );
    if (b === blocks - 1) last = peak(outL);
  }
  return last;
}

describe("vocoder hardening — non-finite input cannot poison recursive state", () => {
  it("recovers after a NaN/Infinity block and stays finite for every later block", () => {
    const proc = factory();
    const p = param({ sibilance: 0.5 });
    const bad = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) bad[i] = i % 2 === 0 ? NaN : Infinity;
    const poisonOutL = new Float32Array(BLOCK);
    const poisonOutR = new Float32Array(BLOCK);
    proc.process(
      [
        [bad, bad],
        [bad, bad],
      ],
      [[poisonOutL, poisonOutR]],
      p,
    );

    let sawNonFinite = false;
    let tailPeak = 0;
    for (let b = 0; b < 32; b++) {
      const [car, carR] = sineBlocks(440, 0.4, b * BLOCK);
      const [mod, modR] = sineBlocks(1000, 0.4, b * BLOCK);
      const outL = new Float32Array(BLOCK);
      const outR = new Float32Array(BLOCK);
      proc.process(
        [
          [car, carR],
          [mod, modR],
        ],
        [[outL, outR]],
        p,
      );
      if (!allFinite(outL) || !allFinite(outR)) sawNonFinite = true;
      if (b === 31) tailPeak = peak(outL);
    }
    expect(sawNonFinite, "no non-finite output after the poisoned block").toBe(false);
    expect(tailPeak, "the filterbank still processes after the poisoned block").toBeGreaterThan(0.01);
  });

  it("a short (undefined-read) input block is treated as silence, not NaN", () => {
    const proc = factory();
    const p = param({ sibilance: 0.5 });
    const short = new Float32Array(16); // shorter than the 128-sample output
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    proc.process(
      [
        [short, short],
        [short, short],
      ],
      [[outL, outR]],
      p,
    );
    expect(allFinite(outL)).toBe(true);
    expect(allFinite(outR)).toBe(true);
  });
});

describe("vocoder hardening — SIBILANCE is the documented LP→HP chain", () => {
  it("rejects DC (a high-pass cannot pass a constant offset into the wet signal)", () => {
    // Pre-fix this settled at ~0.2065 (0.5 · 0.52 · 0.8): a constant offset.
    expect(sibilanceTailPeak("dc", 80)).toBeLessThan(1e-4);
  });

  it("attenuates 60 Hz below the 500 Hz corner instead of passing it at half level", () => {
    // Pre-fix: ~0.2065. Post-fix |H| = 60/√(60²+500²) ≈ 0.119 → ~0.034.
    expect(sibilanceTailPeak(60, 100)).toBeLessThan(0.08);
  });

  it("still passes the sibilance region and discriminates it from low content", () => {
    const low = sibilanceTailPeak(60, 100);
    const high = sibilanceTailPeak(2000, 100);
    expect(high).toBeGreaterThan(0.2);
    expect(high).toBeGreaterThan(low * 4);
  });

  it("does not boost near-Nyquist content above the 4 kHz low-pass response", () => {
    // Pre-fix the broken recurrence added ~+2.6 dB at 18 kHz (peak ≈ 0.148);
    // the LP→HP chain lands at ≈ 0.10.
    expect(sibilanceTailPeak(18000, 200)).toBeLessThan(0.12);
  });

  it("re-enabling SIBILANCE after a muted passage does not replay stale filter state", () => {
    const proc = factory();
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    const run = (modAmp: number, sibilance: number) => {
      const p = param({ sibilance, mix: 1, level: 0 });
      const carrier = new Float32Array(BLOCK);
      const [mod, modR] = sineBlocks(8000, modAmp);
      proc.process(
        [
          [carrier, carrier],
          [mod, modR],
        ],
        [[outL, outR]],
        p,
      );
    };
    for (let b = 0; b < 20; b++) run(0.9, 1); // charge the sibilance chain
    for (let b = 0; b < 20; b++) run(0, 0); // muted + knob off (old code froze)
    run(0, 1); // re-enable on silence: stale state would click here
    expect(peak(outL)).toBeLessThan(1e-4);
  });
});

describe("vocoder hardening — parameter transitions are de-clicked", () => {
  it("a MIX 0 → 1 jump glides instead of dropping the dry signal in one sample", () => {
    const proc = factory();
    const dc = new Float32Array(BLOCK).fill(0.5);
    const run = (mix: number) => {
      const p = param({ mix, sibilance: 0, level: 0 });
      const outL = new Float32Array(BLOCK);
      const outR = new Float32Array(BLOCK);
      proc.process(
        [
          [dc, dc],
          [dc, dc],
        ],
        [[outL, outR]],
        p,
      );
      return outL;
    };
    for (let b = 0; b < 20; b++) run(0);
    const prev = 0.5; // steady mix=0 output is exactly the carrier
    const transition: Float32Array[] = [];
    for (let b = 0; b < 4; b++) transition.push(run(1));
    // Pre-smoothing the first wet sample dropped the 0.5 dry term at once.
    expect(maxAdjacentDelta(transition, prev)).toBeLessThan(0.02);
  });

  it("a LEVEL +12 dB jump glides instead of stepping the wet gain", () => {
    const proc = factory();
    const run = (level: number, startSample: number) => {
      const p = param({ mix: 1, level, sibilance: 0 });
      const [car, carR] = sineBlocks(997, 0.9, startSample);
      const [mod, modR] = sineBlocks(997, 0.9, startSample);
      const outL = new Float32Array(BLOCK);
      const outR = new Float32Array(BLOCK);
      proc.process(
        [
          [car, carR],
          [mod, modR],
        ],
        [[outL, outR]],
        p,
      );
      return outL;
    };
    let n = 0;
    let last = 0;
    for (let b = 0; b < 30; b++) {
      const block = run(0, n);
      last = block[BLOCK - 1];
      n += BLOCK;
    }
    const transition: Float32Array[] = [];
    for (let b = 0; b < 4; b++) {
      transition.push(run(12, n));
      n += BLOCK;
    }
    // The 1 kHz sine itself moves ~0.05 between samples; a gain step adds the
    // whole amplitude difference (~1.2 here). The glide stays near the sine.
    expect(maxAdjacentDelta(transition, last)).toBeLessThan(0.15);
  });

  it("a SIBILANCE 0 → 1 jump glides instead of switching the layer on in one sample", () => {
    const proc = factory();
    const silent = new Float32Array(BLOCK);
    const run = (sibilance: number, startSample: number) => {
      const p = param({ mix: 1, level: 0, sibilance });
      const [mod, modR] = sineBlocks(500, 0.5, startSample);
      const outL = new Float32Array(BLOCK);
      const outR = new Float32Array(BLOCK);
      proc.process(
        [
          [silent, silent],
          [mod, modR],
        ],
        [[outL, outR]],
        p,
      );
      return outL;
    };
    let n = 0;
    let last = 0;
    for (let b = 0; b < 20; b++) {
      const block = run(0, n);
      last = block[BLOCK - 1];
      n += BLOCK;
    }
    const transition: Float32Array[] = [];
    for (let b = 0; b < 4; b++) {
      transition.push(run(1, n));
      n += BLOCK;
    }
    // The 500 Hz sibilance signal moves ~0.018 per sample; the old gain step
    // added the full ~0.28 amplitude on the first sample.
    expect(maxAdjacentDelta(transition, last)).toBeLessThan(0.08);
  });
});

describe("vocoder hardening — BANDS changes crossfade two complete banks", () => {
  const render = (
    proc: ReturnType<typeof factory>,
    bands: number,
    blocks: number,
    startSample: number,
    outL: Float32Array,
    outR: Float32Array,
  ) => {
    const p = param({ bands, mix: 1, level: 0, sibilance: 0.35 });
    for (let b = 0; b < blocks; b++) {
      const n = startSample + b * BLOCK;
      const [car, carR] = sineBlocks(220, 0.4, n);
      const [mod, modR] = sineBlocks(1000, 0.4, n);
      proc.process(
        [
          [car, carR],
          [mod, modR],
        ],
        [[outL, outR]],
        p,
      );
    }
    return startSample + blocks * BLOCK;
  };

  it("16 → 8 runs both banks for ~25 ms, then swaps once", () => {
    const proc = factory();
    let calls = 0;
    const original = proc.renderBankSample!.bind(proc);
    proc.renderBankSample = (...args: Parameters<NonNullable<typeof proc.renderBankSample>>) => {
      calls += 1;
      original(...args);
    };
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    let n = render(proc, 16, 40, 0, outL, outR);
    calls = 0;
    n = render(proc, 16, 1, n, outL, outR);
    expect(calls).toBe(128); // steady state: one bank per sample
    calls = 0;
    n = render(proc, 8, 1, n, outL, outR);
    expect(calls, "the first changed block renders the old and the new bank").toBe(256);
    expect(proc.fadeActive).toBe(true);
    expect(proc.fadeWarm, "the new bank warms silently before the audible blend").toBe(true);
    expect(proc.fadeOldBands).toBe(16);
    expect(proc.fadeNewBands).toBe(8);
    render(proc, 8, 20, n, outL, outR);
    expect(proc.fadeActive, "20 ms warm-up + 25 ms fade completes after twenty blocks").toBe(false);
    expect(proc.lastBands).toBe(8);
    expect(proc.carCoeffs).not.toBe(proc.carCoeffsB);
    calls = 0;
    render(proc, 8, 1, n + 20 * BLOCK, outL, outR);
    expect(calls, "after the swap the old bank is idle").toBe(128);
  });

  it("8 → 16 crossfades the newly activated bands in and stays finite", () => {
    const proc = factory();
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    let n = render(proc, 8, 40, 0, outL, outR);
    let worst = 0;
    const p = param({ bands: 16, mix: 1, level: 0, sibilance: 0.35 });
    for (let b = 0; b < 20; b++) {
      const [car, carR] = sineBlocks(220, 0.4, n + b * BLOCK);
      const [mod, modR] = sineBlocks(1000, 0.4, n + b * BLOCK);
      proc.process(
        [
          [car, carR],
          [mod, modR],
        ],
        [[outL, outR]],
        p,
      );
      expect(allFinite(outL)).toBe(true);
      worst = Math.max(worst, peak(outL));
    }
    expect(proc.fadeActive).toBe(false);
    expect(proc.lastBands).toBe(16);
    expect(worst).toBeGreaterThan(0.001);
  });

  it("a second BANDS change during a fade is deferred, then fades again", () => {
    const proc = factory();
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    let n = render(proc, 16, 40, 0, outL, outR);
    n = render(proc, 8, 2, n, outL, outR);
    expect(proc.fadeActive).toBe(true);
    expect(proc.fadeNewBands).toBe(8);
    // The 8-band fade completes first; the 12-band target then starts a
    // second fade instead of swapping mid-transition.
    render(proc, 12, 40, n, outL, outR);
    expect(proc.fadeActive).toBe(false);
    expect(proc.lastBands).toBe(12);
    expect(allFinite(outL)).toBe(true);
  });
});

describe("vocoder hardening — runtime configuration boundaries", () => {
  it("derives the sibilance HP corner from the active sample rate (44.1 / 48 / 96 / 192 kHz)", () => {
    for (const sr of [44100, 48000, 96000, 192000]) {
      (globalThis as unknown as { sampleRate: number }).sampleRate = sr;
      try {
        expect(sibilanceTailPeak("dc", 80, 0.5, sr), `${sr} Hz: DC rejected`).toBeLessThan(1e-4);
        expect(sibilanceTailPeak(2000, 100, 0.5, sr), `${sr} Hz: 2 kHz passed`).toBeGreaterThan(0.2);
      } finally {
        (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
      }
    }
  });

  it("non-finite parameter values fall back to descriptor defaults instead of poisoning the block", () => {
    const proc = factory();
    const p = param({
      bands: NaN,
      loFreq: NaN,
      hiFreq: Infinity,
      q: NaN,
      attack: NaN,
      release: Infinity,
      shift: -Infinity,
      sibilance: NaN,
      stereo: NaN,
      level: NaN,
      mix: NaN,
    });
    const [car, carR] = sineBlocks(440, 0.4);
    const [mod, modR] = sineBlocks(1000, 0.4);
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    proc.process(
      [
        [car, carR],
        [mod, modR],
      ],
      [[outL, outR]],
      p,
    );
    expect(allFinite(outL)).toBe(true);
    expect(allFinite(outR)).toBe(true);
    expect(peak(outL)).toBeGreaterThan(0.001);
  });
});

describe("vocoder hardening — layout and parameter stability", () => {
  it("rebuilds once per layout, glides a changed layout, then stops rebuilding", () => {
    const proc = factory();
    let calls = 0;
    const original = proc.rebuildLayout!.bind(proc);
    proc.rebuildLayout = (...args: number[]) => {
      calls += 1;
      original(...args);
    };
    const carrierL = new Float32Array(BLOCK);
    const carrierR = new Float32Array(BLOCK);
    const modL = new Float32Array(BLOCK);
    const modR = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      carrierL[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR);
      carrierR[i] = carrierL[i];
      modL[i] = 0.3 * Math.sin((2 * Math.PI * 1000 * i) / SR);
      modR[i] = modL[i];
    }
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    const run = (patch: Record<string, number>, blocks: number) => {
      const p = param(patch);
      for (let b = 0; b < blocks; b++)
        proc.process(
          [
            [carrierL, carrierR],
            [modL, modR],
          ],
          [[outL, outR]],
          p,
        );
    };
    run({}, 8);
    expect(calls, "same layout over eight blocks rebuilds once").toBe(1);
    run({ q: 8 }, 60);
    const glided = calls;
    expect(glided, "a changed layout is interpolated across quanta, not stepped").toBeGreaterThan(2);
    run({ q: 8 }, 10);
    expect(calls, "a settled layout stops rebuilding").toBe(glided);
  });

  it("mono input mirrors to both output channels and stays finite", () => {
    const proc = factory();
    const p = param();
    const car = new Float32Array(BLOCK);
    const mod = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      car[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / SR);
      mod[i] = 0.4 * Math.sin((2 * Math.PI * 1000 * i) / SR);
    }
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    proc.process([[car], [mod]], [[outL, outR]], p);
    expect(allFinite(outL)).toBe(true);
    expect(allFinite(outR)).toBe(true);
    for (let i = 0; i < BLOCK; i++) expect(outR[i]).toBeCloseTo(outL[i], 6);
  });

  it("full-scale alternating input at the extreme parameter corner stays finite and bounded", () => {
    const proc = factory();
    const p = param({ bands: 16, q: 16, shift: 24, sibilance: 1, level: 12, mix: 1, stereo: 1 });
    let worst = 0;
    for (let b = 0; b < 64; b++) {
      const l = new Float32Array(BLOCK);
      const r = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        const v = (i + b) % 2 === 0 ? 1 : -1;
        l[i] = v;
        r[i] = -v;
      }
      const outL = new Float32Array(BLOCK);
      const outR = new Float32Array(BLOCK);
      proc.process(
        [
          [l, r],
          [l, r],
        ],
        [[outL, outR]],
        p,
      );
      expect(allFinite(outL) && allFinite(outR)).toBe(true);
      worst = Math.max(worst, peak(outL), peak(outR));
    }
    // Sonic clipping is allowed; unbounded divergence is not. Pre/post-fix both
    // sit far below this ceiling, so it fails only on a real runaway.
    expect(worst).toBeLessThan(50);
  });
});
