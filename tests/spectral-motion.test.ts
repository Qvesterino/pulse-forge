import { describe, expect, it } from "vitest";

import { DEFAULT_SPECTRAL_PARAMS, SpectralProcessor } from "../src/effects/spectral-core/dsp/SpectralProcessor";
import { MAX_BLOCK } from "../src/effects/spectral-core/dsp/stft";
import { portalParamModeHint } from "../src/ui/effectEditorRegistry";
import type { SpectralParams } from "../src/effects/spectral-core/dsp/SpectralProcessor";

/**
 * PORTAL MOTION — one sine LFO driving TIME (full swing) and FEEDBACK (a quarter).
 *
 * What is under test is the FEATURE, not the code path. A motion implementation
 * that compiles, runs and changes nothing passes every structural check there
 * is, so each test below asserts a thing a listener would notice — and each was
 * checked by running it against a deliberately broken version first.
 */

const SR = 48000;
const BLOCK = 128;

/** A two-tone input: fundamental plus a partial, so per-bin behaviour is visible. */
const twoTone = (i: number) =>
  0.5 * Math.sin((2 * Math.PI * 220 * i) / SR) + 0.25 * Math.sin((2 * Math.PI * 660 * i) / SR);

interface RenderResult {
  outL: Float32Array;
  /** `delaySec` as reported per block — what the panel shows as TIME. */
  reportedDelay: number[];
}

function render({
  params = {},
  seconds,
  input,
  bpm,
}: {
  params?: Partial<SpectralParams>;
  seconds: number;
  input: (i: number) => number;
  bpm?: number;
}): RenderResult {
  const proc = new SpectralProcessor();
  // Params before prepare() so the smoothed controls and the MOTION phase are
  // seeded correctly and the effect does not ramp through its first block.
  proc.setParams({ ...DEFAULT_SPECTRAL_PARAMS, ...params });
  proc.prepare(SR);
  if (bpm !== undefined) proc.setBpm(bpm);

  const total = Math.ceil(seconds * SR);
  const outL = new Float32Array(total);
  const reportedDelay: number[] = [];
  const inL = new Float32Array(MAX_BLOCK);
  const inR = new Float32Array(MAX_BLOCK);
  const bL = new Float32Array(MAX_BLOCK);
  const bR = new Float32Array(MAX_BLOCK);

  for (let offset = 0; offset < total; offset += BLOCK) {
    const len = Math.min(BLOCK, total - offset);
    for (let i = 0; i < len; i++) {
      inL[i] = input(offset + i);
      inR[i] = inL[i]!;
    }
    proc.process(inL, inR, bL, bR, len);
    outL.set(bL.subarray(0, len), offset);
    reportedDelay.push(proc.getMeters().delaySec);
  }
  return { outL, reportedDelay };
}

function rms(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    sum += d * d;
  }
  return Math.sqrt(sum / a.length);
}

function rmsOf(a: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * a[i]!;
  return Math.sqrt(sum / a.length);
}

/** Not bit-identical — a real, measurable difference in the audio. */
function identical(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const DELAY_MODE = { mode: 0, time: 320, sync: 0, feedback: 0.55, mix: 1, diffuse: 0 };

describe("PORTAL motion", () => {
  it("ships OFF: an untouched instance is bit-identical to one that never had motion", () => {
    // The whole point of a default depth of 0. If this drifts, every existing
    // project changes sound the moment the feature lands — and no functional
    // test would notice, because "the effect makes sound" still passes.
    const untouched = render({ seconds: 0.6, input: twoTone, params: DELAY_MODE });
    const explicitZero = render({
      seconds: 0.6,
      input: twoTone,
      params: { ...DELAY_MODE, motionRate: 8, motionDepth: 0 },
    });
    expect(Array.from(explicitZero.outL)).toEqual(Array.from(untouched.outL));
    // And the reported delay must not drift either — the panel reads this number.
    expect(identical(Float32Array.from(explicitZero.reportedDelay), Float32Array.from(untouched.reportedDelay))).toBe(
      true,
    );
  });

  it("moves the delay length, and moves it by the amount DEPTH claims", () => {
    const base = DELAY_MODE.time / 1000;
    const { reportedDelay } = render({
      seconds: 2,
      input: twoTone,
      params: { ...DELAY_MODE, motionDepth: 1, motionRate: 0.6 },
    });

    let lo = Infinity;
    let hi = -Infinity;
    for (const d of reportedDelay) {
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }

    // Documented contract: ±0.2 octaves at DEPTH 1, i.e. ×1.149 / ×0.871.
    const expectedHi = base * Math.pow(2, 0.2);
    const expectedLo = base * Math.pow(2, -0.2);
    // Allow a little for the sine not quite reaching ±1 in a finite window and
    // for the TIME range clamp, but not so much that a wrong magnitude passes.
    expect(hi).toBeGreaterThan(expectedHi * 0.97);
    expect(hi).toBeLessThan(expectedHi * 1.03);
    expect(lo).toBeLessThan(expectedLo * 1.03);
    expect(lo).toBeGreaterThan(expectedLo * 0.97);
  });

  it("changes the rendered audio, and does so by a lot", () => {
    const still = render({ seconds: 2, input: twoTone, params: DELAY_MODE });
    const moving = render({
      seconds: 2,
      input: twoTone,
      params: { ...DELAY_MODE, motionDepth: 1, motionRate: 0.6 },
    });
    const signal = rmsOf(still.outL);
    const difference = rms(still.outL, moving.outL);
    const ratio = difference / signal;
    // Reported, not asserted blind: this is the audibility figure for DEPTH 1.
    console.log(`[portal-motion] depth=1 difference/signal = ${ratio.toFixed(4)}`);
    // "Not bit-identical" is far too weak — a rounding difference passes it. A
    // tail that warps by ±15% of its length moves most of the wet energy.
    expect(ratio).toBeGreaterThan(0.05);
  });

  it("RATE matters: two rates are two different sounds", () => {
    const slow = render({
      seconds: 2,
      input: twoTone,
      params: { ...DELAY_MODE, motionDepth: 1, motionRate: 0.15 },
    });
    const fast = render({
      seconds: 2,
      input: twoTone,
      params: { ...DELAY_MODE, motionDepth: 1, motionRate: 4 },
    });
    expect(identical(slow.outL, fast.outL)).toBe(false);
    expect(rms(slow.outL, fast.outL) / rmsOf(slow.outL)).toBeGreaterThan(0.05);
  });

  it("SYNC takes the rate over: with a division selected, RATE is inert and BPM rules", () => {
    // This is the deliberate design choice — one SYNC dial means "put it on the
    // grid", for the delay length AND the motion, rather than two dials meaning
    // different things. It is only true if the tests say so.
    const synced = { mode: 0, time: 320, sync: 1, feedback: 0.55, mix: 1, diffuse: 0, motionDepth: 1 };
    const rateA = render({ seconds: 2, input: twoTone, params: { ...synced, motionRate: 0.6 }, bpm: 120 });
    const rateB = render({ seconds: 2, input: twoTone, params: { ...synced, motionRate: 4 }, bpm: 120 });
    expect(Array.from(rateB.outL)).toEqual(Array.from(rateA.outL));

    // ...and a tempo change must move it, otherwise SYNC is decorative.
    const faster = render({ seconds: 2, input: twoTone, params: { ...synced, motionRate: 0.6 }, bpm: 150 });
    expect(identical(faster.outL, rateA.outL)).toBe(false);

    // The synced DELAY is still the beat, not the manual TIME — motion must not
    // have broken the meaning SYNC already had.
    const plain = render({ seconds: 0.4, input: twoTone, params: { ...synced, motionDepth: 0 }, bpm: 120 });
    const base = plain.reportedDelay[plain.reportedDelay.length - 1]!;
    expect(base).toBeCloseTo(0.5, 3); // 120 bpm → one beat
  });

  it("runs at the RATE it is told to, not at some other speed", () => {
    // This is the gap the other tests leave open. Nothing here would catch an
    // LFO running at DOUBLE speed: the amplitude is unchanged, determinism
    // still holds, the audio still differs from the motionless render. Only
    // counting the crossings pins the rate.
    //
    // One full sine cycle crosses its midpoint twice, so `hz × seconds` cycles
    // means `2 × hz × seconds` crossings of (delay − base).
    const hz = 1;
    const seconds = 4;
    const base = DELAY_MODE.time / 1000;
    const { reportedDelay } = render({
      seconds,
      input: twoTone,
      params: { ...DELAY_MODE, motionDepth: 1, motionRate: hz },
    });

    let crossings = 0;
    let sign = 0;
    for (const d of reportedDelay) {
      const s = d - base > 0 ? 1 : d - base < 0 ? -1 : 0;
      if (s !== 0 && sign !== 0 && s !== sign) crossings++;
      if (s !== 0) sign = s;
    }

    const expected = 2 * hz * seconds;
    console.log(`[portal-motion] crossings=${crossings} expected≈${expected}`);
    // ±1 for a partial cycle at each end of the window.
    expect(Math.abs(crossings - expected)).toBeLessThanOrEqual(1);
  });

  it("is deterministic: the same motion twice is the same audio twice", () => {
    const params = { ...DELAY_MODE, motionDepth: 1, motionRate: 0.6 };
    const a = render({ seconds: 1, input: twoTone, params });
    const b = render({ seconds: 1, input: twoTone, params });
    const c = render({ seconds: 1, input: twoTone, params });
    expect(Array.from(b.outL)).toEqual(Array.from(a.outL));
    expect(Array.from(c.outL)).toEqual(Array.from(a.outL));
  });

  it("stays finite across the motion parameter space", () => {
    for (const p of [
      { motionDepth: 1, motionRate: 0.05, time: 20 },
      { motionDepth: 1, motionRate: 8, time: 2000 },
      { motionDepth: 1, motionRate: 0.05, time: 2000, sync: 1 },
      { motionDepth: 1, motionRate: 8, time: 20, sync: 5, feedback: 1 },
    ]) {
      const { outL } = render({
        seconds: 1,
        input: twoTone,
        params: { ...DELAY_MODE, ...p },
        bpm: 200,
      });
      for (let i = 0; i < outL.length; i++) expect(Number.isFinite(outL[i]!)).toBe(true);
    }
  });

  it("is inert in RESONATOR, and the panel is expected to say so", () => {
    // Measured, not assumed: my first draft of this test asserted that the
    // FEEDBACK share would still be faintly audible in RESONATOR. It is not —
    // the difference is exactly 0. RESONATOR passes the ring `passInputThrough`
    // and takes its output from the resonator, so nothing the LFO does to the
    // delay read ever reaches the speaker.
    //
    // That is a real property, not a bug: RESONATOR has its own motion control
    // in `resonance`. The obligation that follows from it is honesty — the
    // editor registry must list MOTION as inactive for RESONATOR so the panel
    // explains the two knobs instead of leaving them looking alive.
    const reso = { mode: 1, time: 320, sync: 0, feedback: 0.55, mix: 1, diffuse: 0 };
    const still = render({ seconds: 1, input: twoTone, params: { ...reso, motionDepth: 0 } });
    const warped = render({ seconds: 1, input: twoTone, params: { ...reso, motionDepth: 1 } });
    expect(Array.from(warped.outL)).toEqual(Array.from(still.outL));

    for (const id of ["motionRate", "motionDepth"]) {
      expect(portalParamModeHint(id, 0)).toBeUndefined(); // live in DELAY
      expect(portalParamModeHint(id, 2)).toBeUndefined(); // live in FREEZE
      expect(portalParamModeHint(id, 1)).toMatch(/RESONATOR/); // explained, not silent
    }
  });
});
