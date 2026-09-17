import { beforeAll, describe, expect, it } from "vitest";
import { CORE_EFFECT_PRESETS } from "../src/effects/presets";
import { EFFECT_DEFS } from "../src/effects/registry";
import type { KaskadaProcessorInstance } from "../src/audio-worklets/kaskada-processor";

/**
 * KYX Kaskáda — processor test battery (step 1 of the Phase 1 continuation:
 * docs/kaskada-architecture.md §9 "Definition of Done" — the unit-test box).
 *
 * Runs the REAL worklet processor (src/audio-worklets/kaskada-processor.js)
 * under a stubbed AudioWorkletGlobalScope, the same harness pattern as
 * tests/ozvena-worklet-entry.test.ts. The processor is a plain per-sample
 * delay, so impulse/sine renders give exact expectations:
 *
 *  - echo spacing: free TIME and every SYNC ratio × BPM (resolved in-worklet)
 *  - feedback decay ≈ fbⁿ (digital character is a linear loop at drive 0)
 *  - ping-pong alternation L/R with a one-sided impulse
 *  - freeze seals the write head (bit-identical render with vs without a
 *    post-freeze impulse) and sustains the captured tail
 *  - loop EQ darkening (LP/HP) measured on delayed repeats
 *  - drive: digital path linear at drive 0, saturating at drive 1
 *  - mix/level laws, silence in → silence out
 *  - extremes soak: every param at min/max/random, finite + bounded + no growth
 *  - registry contract: descriptors ↔ EFFECT_DEFS params ↔ presets in range
 *  - 44.1/48 kHz parity of echo position and decay ratio
 *
 * Post-step-2 notes (DSP polish landed: cubic-hermite reads, one-pole DC
 * blocker, tape-character wow, drive normalised to unity small-signal gain,
 * freeze looping the processed wet back at 0.99 — docs §3/§5 now match the
 * implementation):
 *  - the loop EQ still colours the whole wet path, so the FIRST repeat is
 *    already filtered — docs §3.4 was updated to match (a feedback-path-only
 *    EQ variant was considered and rejected as a bigger retopology);
 *  - drive keeps small-signal loop gain ≤ fb at every amplitude, so the
 *    driven-loop test asserts the fb ceiling directly.
 */

class FakeAudioWorkletProcessor {}

interface DescriptorShape {
  name: string;
  defaultValue: number;
  automationRate: string;
}
type ProcCtor = new () => KaskadaProcessorInstance & { static?: never };

let createKaskadaProcessor: () => KaskadaProcessorInstance;
let RegisteredClass: (new () => KaskadaProcessorInstance) & {
  parameterDescriptors?: DescriptorShape[];
};

beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = 48000;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor =
    FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (
    _name: string,
    cls: ProcCtor,
  ) => {
    RegisteredClass = cls as typeof RegisteredClass;
  };
  const mod = await import("../src/audio-worklets/kaskada-processor.js");
  createKaskadaProcessor = mod.createKaskadaProcessor;
  if (typeof createKaskadaProcessor !== "function") {
    throw new Error("kaskada-processor.js did not export createKaskadaProcessor");
  }
});

/* ─────────────── harness ─────────────── */

const BLOCK = 128;

/** Canonical defaults mirroring parameterDescriptors — pinned by a contract
 *  test below, so the spread base can never drift from the worklet. */
const DEFAULTS: Record<string, number> = {
  time: 375,
  sync: 0,
  bpm: 120,
  pingPong: 0,
  feedback: 0.35,
  toneLp: 4500,
  toneHp: 150,
  drive: 0,
  modRate: 0.6,
  modDepth: 0.15,
  spread: 0.8,
  freeze: 0,
  character: 1,
  mix: 0.25,
  level: -6,
};

function makeParams(overrides: Record<string, number> = {}): Record<string, Float32Array> {
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries({ ...DEFAULTS, ...overrides })) {
    out[k] = Float32Array.from([v]);
  }
  return out;
}

/** Near-transparent overrides for timing/amplitude measurements: digital
 *  character, no drive/modulation, full-wet unity monitoring, EQ parked at
 *  its extremes so biquad colouring stays out of the numbers. */
const NEUTRAL: Record<string, number> = {
  character: 0,
  drive: 0,
  modDepth: 0,
  spread: 0,
  mix: 1,
  level: 0,
  toneLp: 12000,
  toneHp: 20,
};

function currentSr(): number {
  return (globalThis as unknown as { sampleRate: number }).sampleRate;
}

interface RenderResult {
  L: Float32Array;
  R: Float32Array;
}

/** Drive the processor like a host: 128-frame quanta, k-rate params mutable
 *  between blocks via onBlock (Float32Array slots are written in place). */
function render(
  seconds: number,
  prm: Record<string, Float32Array>,
  input: (sample: number) => [number, number] = () => [0, 0],
  onBlock?: (block: number, prm: Record<string, Float32Array>) => void,
): RenderResult {
  const sr = currentSr();
  const proc = createKaskadaProcessor();
  const nBlocks = Math.ceil((seconds * sr) / BLOCK);
  const L = new Float32Array(nBlocks * BLOCK);
  const R = new Float32Array(nBlocks * BLOCK);
  for (let b = 0; b < nBlocks; b++) {
    onBlock?.(b, prm);
    const inL = new Float32Array(BLOCK);
    const inR = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      const [l, r] = input(b * BLOCK + i);
      inL[i] = l;
      inR[i] = r;
    }
    proc.process(
      [[inL, inR]],
      [
        [
          L.subarray(b * BLOCK, (b + 1) * BLOCK),
          R.subarray(b * BLOCK, (b + 1) * BLOCK),
        ],
      ],
      prm,
    );
  }
  return { L, R };
}

/** Mono impulse into both channels at sample 0. */
const monoImpulse = (amp = 0.9) => (s: number): [number, number] =>
  s === 0 ? [amp, amp] : [0, 0];

/** Sine burst starting at sample 0; `left` feeds only the left channel —
 *  the input shape that makes ping-pong crossfeed observable. */
const sineBurst =
  (freq: number, durSamples: number, amp = 0.5, side: "both" | "left" = "both") =>
  (s: number): [number, number] => {
    const v = s < durSamples ? amp * Math.sin((2 * Math.PI * freq * s) / currentSr()) : 0;
    return side === "left" ? [v, 0] : [v, v];
  };

function peak(buf: Float32Array, from: number, to: number): number {
  let m = 0;
  for (let i = Math.max(0, from); i < Math.min(buf.length, to); i++) {
    const a = Math.abs(buf[i]);
    if (a > m) m = a;
  }
  return m;
}

function peakIndex(buf: Float32Array, from: number, to: number): number {
  let m = -1;
  let idx = -1;
  for (let i = Math.max(0, from); i < Math.min(buf.length, to); i++) {
    const a = Math.abs(buf[i]);
    if (a > m) {
      m = a;
      idx = i;
    }
  }
  return idx;
}

function rms(buf: Float32Array, from: number, to: number): number {
  let acc = 0;
  let n = 0;
  for (let i = Math.max(0, from); i < Math.min(buf.length, to); i++) {
    acc += buf[i] * buf[i];
    n++;
  }
  return n === 0 ? 0 : Math.sqrt(acc / n);
}

function assertAllFinite(chans: Float32Array[], label: string): number {
  let max = 0;
  for (const c of chans) {
    for (let i = 0; i < c.length; i++) {
      if (!Number.isFinite(c[i])) {
        throw new Error(`${label}: non-finite sample at ${i}: ${c[i]}`);
      }
      const a = Math.abs(c[i]);
      if (a > max) max = a;
    }
  }
  return max;
}

/** Deterministic PRNG for the soak (reproducible failures). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ─────────────── contract: descriptors ↔ registry ↔ presets ─────────────── */

describe("kaskada parameter contract", () => {
  it("registers as 'kaskada' with a parameterDescriptors static", () => {
    expect(RegisteredClass).toBeDefined();
    const descriptors = RegisteredClass!.parameterDescriptors;
    expect(Array.isArray(descriptors)).toBe(true);
    expect(descriptors!.length).toBe(15);
    expect(descriptors!.every((d) => d.automationRate === "k-rate")).toBe(true);
  });

  it("exposes every registry param as a descriptor, plus only the hidden bpm", () => {
    const descriptors = RegisteredClass!.parameterDescriptors!;
    const names = new Set(descriptors.map((d) => d.name));
    const registryIds = EFFECT_DEFS.kaskada.params.map((p) => p.id);
    for (const id of registryIds) {
      expect(names.has(id), `registry param ${id} missing from worklet descriptors`).toBe(true);
    }
    const hidden = [...names].filter((n) => !registryIds.includes(n));
    expect(hidden).toEqual(["bpm"]);
  });

  it("DEFAULTS table matches the worklet descriptor defaults (test-harness pin)", () => {
    for (const d of RegisteredClass!.parameterDescriptors!) {
      expect(DEFAULTS[d.name], `default for ${d.name}`).toBe(d.defaultValue);
    }
  });

  it("all 6 factory presets are in-range against the registry definition", () => {
    const ks = CORE_EFFECT_PRESETS.filter((p) => p.type === "kaskada");
    expect(ks.length).toBe(6);
    const ids = new Set(ks.map((p) => p.id));
    expect(ids.size).toBe(6);
    const defs = EFFECT_DEFS.kaskada.params;
    for (const preset of ks) {
      for (const [id, value] of Object.entries(preset.params)) {
        const def = defs.find((p) => p.id === id);
        expect(def, `preset ${preset.id} param ${id}`).toBeDefined();
        expect(value, `preset ${preset.id} param ${id} below min`).toBeGreaterThanOrEqual(def!.min);
        expect(value, `preset ${preset.id} param ${id} above max`).toBeLessThanOrEqual(def!.max);
      }
    }
  });
});

/* ─────────────── echo spacing ─────────────── */

describe("kaskada echo spacing", () => {
  // Biquad ringing shifts the argmax by a few samples; ±30 (0.625 ms) is
  // far below any wrong-ratio error (whole note vs 1/16 is thousands).
  const TOL = 30;

  it("free TIME places the first echo at time ms (and repeats at N×time)", () => {
    const d = Math.round(0.5 * currentSr());
    const { L } = render(1.8, makeParams({ ...NEUTRAL, time: 500, feedback: 0.5 }), monoImpulse());
    expect(Math.abs(peakIndex(L, d - 500, d + 500) - d)).toBeLessThan(TOL);
    expect(Math.abs(peakIndex(L, 2 * d - 500, 2 * d + 500) - 2 * d)).toBeLessThan(TOL);
    expect(Math.abs(peakIndex(L, 3 * d - 500, 3 * d + 500) - 3 * d)).toBeLessThan(TOL);
    // Dry is muted at mix 1 — nothing before the first echo.
    expect(peak(L, 1, d - 200)).toBe(0);
  });

  it.each([
    { sync: 1, bpm: 120, expectedMs: 500 }, // 1/4 @ 120
    { sync: 2, bpm: 120, expectedMs: 250 }, // 1/8 @ 120
    { sync: 3, bpm: 100, expectedMs: 200 }, // 1/8T @ 100 (1/3 of a quarter)
    { sync: 4, bpm: 90, expectedMs: 1000 / 6 }, // 1/16 @ 90
    { sync: 5, bpm: 140, expectedMs: 1000 / 14 }, // 1/16T @ 140
  ])("sync $sync @ $bpm bpm → echo at $expectedMs ms (TIME is a decoy)", ({ sync, bpm, expectedMs }) => {
    const d = Math.round((expectedMs / 1000) * currentSr());
    const { L } = render(
      Math.max(0.6, (expectedMs / 1000) * 3),
      makeParams({ ...NEUTRAL, time: 900, sync, bpm, feedback: 0.4 }),
      monoImpulse(),
    );
    expect(Math.abs(peakIndex(L, d - 500, d + 500) - d)).toBeLessThan(TOL);
  });

  it("changing bpm re-times a synced delay", () => {
    const d120 = Math.round(0.25 * currentSr()); // 1/8 @ 120
    const d90 = Math.round((60 / 90 / 2) * currentSr()); // 1/8 @ 90 = 333.3 ms
    const a = render(1.2, makeParams({ ...NEUTRAL, sync: 2, bpm: 120, feedback: 0.4 }), monoImpulse());
    const b = render(1.2, makeParams({ ...NEUTRAL, sync: 2, bpm: 90, feedback: 0.4 }), monoImpulse());
    expect(Math.abs(peakIndex(a.L, d120 - 500, d120 + 500) - d120)).toBeLessThan(TOL);
    expect(Math.abs(peakIndex(b.L, d90 - 500, d90 + 500) - d90)).toBeLessThan(TOL);
  });
});

/* ─────────────── feedback decay ─────────────── */

describe("kaskada feedback decay", () => {
  // A mid-band burst keeps the loop EQ transparent (LP 12k / HP 20 Hz),
  // so echo RMS scales by ≈ fb exactly — an impulse would smear into the
  // HP cascade's subsonic tail and skew the peak ratios.
  it("echo RMS decays by ≈ fb per repeat (digital, drive 0)", () => {
    const d = Math.round(0.2 * currentSr());
    const w = Math.round(0.02 * currentSr());
    const { L } = render(
      1.0,
      makeParams({ ...NEUTRAL, time: 200, feedback: 0.5 }),
      sineBurst(2000, w),
    );
    const r1 = rms(L, d, d + w);
    const r2 = rms(L, 2 * d, 2 * d + w);
    const r3 = rms(L, 3 * d, 3 * d + w);
    expect(r1).toBeGreaterThan(0.05);
    expect(r2 / r1).toBeGreaterThan(0.45);
    expect(r2 / r1).toBeLessThan(0.55);
    expect(r3 / r2).toBeGreaterThan(0.45);
    expect(r3 / r2).toBeLessThan(0.55);
  });

  it("level scales the wet path by the dB law", () => {
    const d = Math.round(0.2 * currentSr());
    const a = render(0.6, makeParams({ ...NEUTRAL, time: 200, feedback: 0.4, level: 0 }), monoImpulse());
    const b = render(0.6, makeParams({ ...NEUTRAL, time: 200, feedback: 0.4, level: -6 }), monoImpulse());
    const ratio = peak(b.L, d - 300, d + 300) / peak(a.L, d - 300, d + 300);
    expect(ratio).toBeGreaterThan(0.45);
    expect(ratio).toBeLessThan(0.56); // 10^(-6/20) ≈ 0.501
  });

  it("mix 0 passes the dry signal untouched and mutes the wet", () => {
    const { L, R } = render(0.5, makeParams({ ...NEUTRAL, time: 200, mix: 0 }), monoImpulse(0.75));
    expect(L[0]).toBe(0.75);
    expect(R[0]).toBe(0.75);
    const d = Math.round(0.2 * currentSr());
    expect(peak(L, d - 300, d + 300)).toBe(0);
  });

  it("mix 1 mutes dry: an impulse at sample 0 produces no output before the echo", () => {
    const { L } = render(0.5, makeParams({ ...NEUTRAL, time: 200, mix: 1 }), monoImpulse(0.75));
    expect(peak(L, 0, Math.round(0.15 * currentSr()))).toBe(0);
  });
});

/* ─────────────── ping-pong ─────────────── */

describe("kaskada ping-pong", () => {
  it("a left-only burst alternates L → R → L → R with ≈ fb decay", () => {
    const d = Math.round(0.25 * currentSr());
    const w = Math.round(0.02 * currentSr());
    const { L, R } = render(
      1.3,
      makeParams({ ...NEUTRAL, time: 250, pingPong: 1, feedback: 0.6 }),
      sineBurst(2000, w, 0.5, "left"),
    );
    const l1 = rms(L, d, d + w);
    const r2 = rms(R, 2 * d, 2 * d + w);
    const l3 = rms(L, 3 * d, 3 * d + w);
    const r4 = rms(R, 4 * d, 4 * d + w);
    expect(l1).toBeGreaterThan(0.05);
    // Cross-side windows are numerically silent at spread 0 (residue ~1e-11
    // from the biquad denormal flush floor — crossfeed only enters the
    // output through the spread matrix).
    expect(rms(R, d, d + w)).toBeLessThan(1e-6);
    expect(rms(L, 2 * d, 2 * d + w)).toBeLessThan(1e-6);
    expect(r2 / l1).toBeGreaterThan(0.54);
    expect(r2 / l1).toBeLessThan(0.66);
    expect(l3 / r2).toBeGreaterThan(0.54);
    expect(l3 / r2).toBeLessThan(0.66);
    expect(r4).toBeGreaterThan(0.02);
  });
});

/* ─────────────── freeze ─────────────── */

describe("kaskada freeze", () => {
  const FREEZE_BLOCK = 300; // sample 38400 = 0.8 s, tail already in the buffer

  function renderFreeze(secondImpulse: boolean) {
    const prm = makeParams({ ...NEUTRAL, time: 250, feedback: 0.5 });
    // A 0.3 s burst overlaps the 0.25 s echo grid, so the frozen content is
    // dense — RMS windows then track amplitude, not spike sparsity.
    const burstEnd = Math.round(0.3 * currentSr());
    const input = (s: number): [number, number] => {
      if (s < burstEnd) {
        const v = 0.5 * Math.sin((2 * Math.PI * 440 * s) / currentSr());
        return [v, v];
      }
      if (secondImpulse && s === Math.round(1.2 * currentSr())) return [0.9, 0.9];
      return [0, 0];
    };
    return render(2.5, prm, input, (block, p) => {
      if (block === FREEZE_BLOCK) p.freeze[0] = 1;
    });
  }

  it("seals the write head: a post-freeze impulse cannot reach the output", () => {
    const withImpulse = renderFreeze(true);
    const without = renderFreeze(false);
    // mix 1 mutes the dry arm, so the second impulse is only audible as a
    // new echo — which freeze must suppress. Bit-identical is the strongest
    // form of that assertion.
    expect([...withImpulse.L]).toEqual([...without.L]);
    expect([...withImpulse.R]).toEqual([...without.R]);
  });

  it("control: without freeze the post-freeze impulse DOES echo (guard for the test above)", () => {
    const d = Math.round(0.25 * currentSr());
    const prm = makeParams({ ...NEUTRAL, time: 250, feedback: 0.5 });
    const echoAt = Math.round(1.2 * currentSr()) + d;
    const out = render(2.5, prm, (s) => (s === Math.round(1.2 * currentSr()) ? [0.9, 0.9] : [0, 0]));
    expect(peak(out.L, echoAt - 300, echoAt + 300)).toBeGreaterThan(0.1);
  });

  it("loops the captured tail: sustain persists across the whole render", () => {
    // Step-2 fix: freeze writes the processed wet back at 0.99, so the
    // read head keeps replaying looping content instead of walking into
    // silence (the old skip-write behaviour also glitch-replayed stale
    // buffer content on every ring wrap).
    const { L } = renderFreeze(false);
    const period = Math.round(0.25 * currentSr());
    const early = rms(L, Math.round(1.3 * currentSr()), Math.round(1.3 * currentSr()) + 2 * period);
    const late = rms(L, L.length - 2 * period, L.length);
    expect(early).toBeGreaterThan(0.01);
    // 0.99 per echo period; the ~1.2 s between window centres is ≈ 5
    // repeats → expected ratio ≈ 0.95.
    expect(late / early).toBeGreaterThan(0.75);
    expect(late / early).toBeLessThan(1.05);
  });

  it("freeze cannot accumulate DC: a frozen DC-offset tail decays to zero mean", () => {
    // The loop HP already nulls DC per pass and the one-pole DC blocker is
    // defence in depth — this pins the guarantee either way.
    const prm = makeParams({ ...NEUTRAL, time: 250, feedback: 0.5 });
    const { L } = render(
      2.5,
      prm,
      (s) => (s < Math.round(0.4 * currentSr()) ? [0.5, 0.5] : [0, 0]),
      (block, p) => {
        if (block === FREEZE_BLOCK) p.freeze[0] = 1;
      },
    );
    const from = Math.round(2 * currentSr());
    let sum = 0;
    for (let i = from; i < L.length; i++) sum += L[i];
    expect(Math.abs(sum / (L.length - from))).toBeLessThan(0.02);
  });
});

/* ─────────────── loop EQ ─────────────── */

describe("kaskada loop EQ", () => {
  it("TONE LP darkens repeats: 5 kHz echo at LP 500 ≪ LP 12000", () => {
    const d = Math.round(0.15 * currentSr());
    const prm = (toneLp: number) =>
      makeParams({ ...NEUTRAL, time: 150, feedback: 0.3, toneLp });
    const a = render(0.3, prm(12000), sineBurst(5000, Math.round(0.06 * currentSr())));
    const b = render(0.3, prm(500), sineBurst(5000, Math.round(0.06 * currentSr())));
    const loud = rms(a.L, d, d + Math.round(0.06 * currentSr()));
    const dark = rms(b.L, d, d + Math.round(0.06 * currentSr()));
    expect(loud).toBeGreaterThan(0.05);
    expect(dark / loud).toBeLessThan(0.05); // 24 dB/oct over 3.3 octaves
  });

  it("TONE HP darkens repeats: 30 Hz echo at HP 800 ≪ HP 20", () => {
    const d = Math.round(0.15 * currentSr());
    const prm = (toneHp: number) =>
      makeParams({ ...NEUTRAL, time: 150, feedback: 0.3, toneHp });
    const a = render(0.3, prm(20), sineBurst(30, Math.round(0.2 * currentSr())));
    const b = render(0.3, prm(800), sineBurst(30, Math.round(0.2 * currentSr())));
    const loud = rms(a.L, d, d + Math.round(0.06 * currentSr()));
    const dark = rms(b.L, d, d + Math.round(0.06 * currentSr()));
    expect(loud).toBeGreaterThan(0.05);
    expect(dark / loud).toBeLessThan(0.05);
  });
});

/* ─────────────── drive ─────────────── */

describe("kaskada drive", () => {
  it("drive 0 is exactly linear: doubling the input doubles the output", () => {
    const a = render(0.5, makeParams({ ...NEUTRAL, time: 100, feedback: 0.5 }), monoImpulse(0.4));
    const b = render(0.5, makeParams({ ...NEUTRAL, time: 100, feedback: 0.5 }), monoImpulse(0.8));
    let maxDiff = 0;
    for (let i = 0; i < a.L.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(b.L[i] - 2 * a.L[i]));
    }
    expect(maxDiff).toBeLessThan(1e-4);
  });

  it("drive 1 saturates: doubling the input no longer doubles the output", () => {
    const a = render(0.5, makeParams({ ...NEUTRAL, time: 100, feedback: 0.5, drive: 1 }), monoImpulse(0.4));
    const b = render(0.5, makeParams({ ...NEUTRAL, time: 100, feedback: 0.5, drive: 1 }), monoImpulse(0.8));
    let maxDiff = 0;
    for (let i = 0; i < a.L.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(b.L[i] - 2 * a.L[i]));
    }
    expect(maxDiff).toBeGreaterThan(0.01);
  });

  it("driven loop gain never exceeds FEEDBK (no self-oscillation at drive 1)", () => {
    // Step-2 fix: unity-small-signal normalisation makes every loop element
    // contractive, so even fb 0.6 + drive 1 decays monotonically. The old
    // boost-then-clamp tanh ran the loop at up to 7× and saturated into a
    // self-oscillating ring at these settings.
    const d = Math.round(0.15 * currentSr());
    const w = Math.round(0.04 * currentSr());
    const { L } = render(
      1.0,
      makeParams({ ...NEUTRAL, time: 150, feedback: 0.6, drive: 1 }),
      sineBurst(2000, w, 0.9),
    );
    const r1 = rms(L, d, d + w);
    const r2 = rms(L, 2 * d, 2 * d + w);
    const r3 = rms(L, 3 * d, 3 * d + w);
    expect(r1).toBeGreaterThan(0.05);
    expect(r2 / r1).toBeLessThan(0.7);
    expect(r3 / r2).toBeLessThan(0.7);
  });
});

/* ─────────────── silence ─────────────── */

describe("kaskada silence", () => {
  it("silent input produces exact silence (incl. freeze and max drive)", () => {
    const cases: Record<string, number>[] = [
      {},
      { freeze: 1 },
      { drive: 1, feedback: 0.95, pingPong: 1 },
    ];
    for (const overrides of cases) {
      const { L, R } = render(0.4, makeParams({ ...NEUTRAL, ...overrides }));
      expect(peak(L, 0, L.length)).toBe(0);
      expect(peak(R, 0, R.length)).toBe(0);
    }
  });
});

/* ─────────────── extremes soak ─────────────── */

describe("kaskada extremes soak", () => {
  const RANGES: Record<string, [number, number]> = {
    time: [30, 2000],
    sync: [0, 5],
    bpm: [40, 240],
    pingPong: [0, 1],
    feedback: [0, 0.95],
    toneLp: [500, 12000],
    toneHp: [20, 800],
    drive: [0, 1],
    modRate: [0.1, 8],
    modDepth: [0, 1],
    spread: [0, 1],
    freeze: [0, 1],
    character: [0, 2],
    mix: [0, 1],
    level: [-24, 6],
  };

  function soak(label: string, overrides: Record<string, number>) {
    const rng = mulberry32(0x5eed);
    const { L, R } = render(
      2.2, // ≥ 1 echo even at time 2000 ms
      makeParams(overrides),
      () => [rng() * 1.8 - 0.9, rng() * 1.8 - 0.9],
    );
    const max = assertAllFinite([L, R], label);
    expect(max, `${label} amplitude exploded`).toBeLessThan(48);
    const quarter = Math.floor(L.length / 4);
    const head = Math.max(peak(L, 0, quarter), peak(R, 0, quarter));
    const tail = Math.max(peak(L, L.length - quarter, L.length), peak(R, R.length - quarter, R.length));
    expect(tail, `${label} tail grows — runaway loop`).toBeLessThan(head * 2 + 1);
  }

  it("all-min stays finite and settles", () => {
    const allMin: Record<string, number> = {};
    for (const [k, [lo]] of Object.entries(RANGES)) allMin[k] = lo;
    soak("all-min", allMin);
  });

  it("all-max stays finite and settles", () => {
    const allMax: Record<string, number> = {};
    for (const [k, [, hi]] of Object.entries(RANGES)) allMax[k] = hi;
    soak("all-max", allMax);
  });

  it.each([0, 1, 2])("character %s at hot settings stays finite", (character) => {
    soak(`character ${character}`, {
      character,
      feedback: 0.95,
      drive: 1,
      level: 6,
      mix: 1,
      pingPong: 1,
      modDepth: 1,
      modRate: 8,
    });
  });

  it("freeze at hot settings stays finite (frozen buffer never decays, never grows)", () => {
    soak("freeze-hot", { freeze: 1, feedback: 0.95, drive: 1, level: 6, mix: 1, pingPong: 1 });
  });

  it("randomised param grid stays finite, bounded and non-growing (24 draws)", () => {
    const rng = mulberry32(0x5eed17);
    for (let n = 0; n < 24; n++) {
      const overrides: Record<string, number> = {};
      for (const [k, [lo, hi]] of Object.entries(RANGES)) {
        const pick = rng();
        overrides[k] =
          pick < 0.25 ? lo : pick < 0.5 ? hi : pick < 0.75 ? DEFAULTS[k] : lo + rng() * (hi - lo);
      }
      soak(`random-${n}`, overrides);
    }
  });
});

/* ─────────────── sample-rate parity ─────────────── */

describe("kaskada sample-rate parity", () => {
  it("44.1 kHz and 48 kHz agree on echo position (ms) and decay ratio", () => {
    const results: Array<{ sr: number; echoMs: number; ratio: number }> = [];
    for (const sr of [44100, 48000]) {
      (globalThis as unknown as { sampleRate: number }).sampleRate = sr;
      const d = Math.round(0.333 * sr);
      const { L } = render(1.2, makeParams({ ...NEUTRAL, time: 333, feedback: 0.5 }), monoImpulse());
      const echoIdx = peakIndex(L, d - 500, d + 500);
      const p1 = peak(L, d - 300, d + 300);
      const p2 = peak(L, 2 * d - 300, 2 * d + 300);
      results.push({ sr, echoMs: (echoIdx / sr) * 1000, ratio: p2 / p1 });
    }
    (globalThis as unknown as { sampleRate: number }).sampleRate = 48000;
    expect(Math.abs(results[0].echoMs - 333)).toBeLessThan(1);
    expect(Math.abs(results[1].echoMs - 333)).toBeLessThan(1);
    expect(Math.abs(results[0].ratio - results[1].ratio)).toBeLessThan(0.05);
  });
});
