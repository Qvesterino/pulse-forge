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

class FakeAudioWorkletProcessor {
  port = new FakePort();
}

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
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (_name: string, cls: ProcCtor) => {
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
  reverse: 0,
  feedback: 0.35,
  toneLp: 4500,
  toneHp: 150,
  drive: 0,
  modRate: 0.6,
  modDepth: 0.15,
  spread: 0.8,
  freeze: 0,
  unmaskOn: 0,
  unmask: 0.6,
  unmaskSens: 0.5,
  unmaskAtk: 5,
  unmaskRel: 250,
  character: 1,
  mix: 0.25,
  soloWet: 0,
  deltaListen: 0,
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
    proc.process([[inL, inR]], [[L.subarray(b * BLOCK, (b + 1) * BLOCK), R.subarray(b * BLOCK, (b + 1) * BLOCK)]], prm);
  }
  return { L, R };
}

/** Mono impulse into both channels at sample 0. */
const monoImpulse =
  (amp = 0.9) =>
  (s: number): [number, number] =>
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

/* ─────────────── dual-spectrum meters harness ─────────────── */

class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  posted: { msg: unknown; transfer?: Transferable[] }[] = [];
  postMessage(msg: unknown, transfer?: Transferable[]) {
    this.posted.push({ msg, transfer });
  }
}

/** Band index nearest `freq` on the worklet's 72-band 20 Hz–20 kHz geometry. */
const bandOf = (freq: number) =>
  Math.max(0, Math.min(71, Math.round(72 * (Math.log(freq / 20) / Math.log(1000)) - 0.5)));

function maxBandDb(frame: Float32Array, offset: number, freq: number, spread = 2): number {
  const center = bandOf(freq);
  let m = -Infinity;
  for (let b = Math.max(0, center - spread); b <= Math.min(71, center + spread); b++) {
    m = Math.max(m, frame[offset + b]);
  }
  return m;
}

/* ─────────────── contract: descriptors ↔ registry ↔ presets ─────────────── */

describe("kaskada parameter contract", () => {
  it("registers as 'kaskada' with a parameterDescriptors static", () => {
    expect(RegisteredClass).toBeDefined();
    const descriptors = RegisteredClass!.parameterDescriptors;
    expect(Array.isArray(descriptors)).toBe(true);
    expect(descriptors!.length).toBe(23);
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
    const { L } = render(1.0, makeParams({ ...NEUTRAL, time: 200, feedback: 0.5 }), sineBurst(2000, w));
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
    const prm = (toneLp: number) => makeParams({ ...NEUTRAL, time: 150, feedback: 0.3, toneLp });
    const a = render(0.3, prm(12000), sineBurst(5000, Math.round(0.06 * currentSr())));
    const b = render(0.3, prm(500), sineBurst(5000, Math.round(0.06 * currentSr())));
    const loud = rms(a.L, d, d + Math.round(0.06 * currentSr()));
    const dark = rms(b.L, d, d + Math.round(0.06 * currentSr()));
    expect(loud).toBeGreaterThan(0.05);
    expect(dark / loud).toBeLessThan(0.05); // 24 dB/oct over 3.3 octaves
  });

  it("TONE HP darkens repeats: 30 Hz echo at HP 800 ≪ HP 20", () => {
    const d = Math.round(0.15 * currentSr());
    const prm = (toneHp: number) => makeParams({ ...NEUTRAL, time: 150, feedback: 0.3, toneHp });
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
    const { L } = render(1.0, makeParams({ ...NEUTRAL, time: 150, feedback: 0.6, drive: 1 }), sineBurst(2000, w, 0.9));
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
    const cases: Record<string, number>[] = [{}, { freeze: 1 }, { drive: 1, feedback: 0.95, pingPong: 1 }];
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
    reverse: [0, 1],
    feedback: [0, 0.95],
    toneLp: [500, 12000],
    toneHp: [20, 800],
    drive: [0, 1],
    modRate: [0.1, 8],
    modDepth: [0, 1],
    spread: [0, 1],
    freeze: [0, 2],
    unmaskOn: [0, 1],
    unmask: [0, 1],
    unmaskSens: [0, 1],
    unmaskAtk: [0.1, 100],
    unmaskRel: [10, 2000],
    character: [0, 4],
    mix: [0, 1],
    soloWet: [0, 1],
    deltaListen: [0, 1],
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
        overrides[k] = pick < 0.25 ? lo : pick < 0.5 ? hi : pick < 0.75 ? DEFAULTS[k] : lo + rng() * (hi - lo);
      }
      soak(`random-${n}`, overrides);
    }
  });
  it("delta listen outputs exactly what the solver removes", () => {
    const input = sineBurst(2000, currentSr(), 0.6);
    const base = { ...NEUTRAL, time: 30, feedback: 0.35, mix: 0.5, unmaskOn: 1, unmask: 1 };
    const off = render(1.0, makeParams({ ...base, unmaskOn: 0 }), input);
    const on = render(1.0, makeParams(base), input);
    const delta = render(1.0, makeParams({ ...base, deltaListen: 1 }), input);
    // delta bypasses the mix law: delta == (off − on) / mix (float assoc ~ulp)
    let maxErr = 0;
    for (let i = 0; i < delta.L.length; i++) {
      const expected = (off.L[i] - on.L[i]) / 0.5;
      maxErr = Math.max(maxErr, Math.abs(delta.L[i] - expected));
    }
    expect(maxErr).toBeLessThan(1e-6);
    expect(peak(delta.L, 0, delta.L.length)).toBeGreaterThan(0.01); // solver really removed energy
  });

  it("delta listen with the solver off is exact silence", () => {
    const { L, R } = render(0.4, makeParams({ ...NEUTRAL, deltaListen: 1 }), monoImpulse());
    expect(peak(L, 0, L.length)).toBe(0);
    expect(peak(R, 0, R.length)).toBe(0);
  });
});

/* ─────────────── reverse / hold / soloWet / character 3-4 ─────────────── */

describe("kaskada reverse", () => {
  const D_MS = 200;
  const GAP_MS = 80;

  it("swaps the order of two impulses inside the echo window (segment reverse)", () => {
    const d = Math.round((D_MS / 1000) * currentSr());
    const gap = Math.round((GAP_MS / 1000) * currentSr());
    const input = (s: number): [number, number] => (s === 0 ? [0.8, 0.8] : s === gap ? [0.8, 0.8] : [0, 0]);
    const fwd = render(0.6, makeParams({ ...NEUTRAL, time: D_MS, feedback: 0 }), input);
    const rev = render(0.6, makeParams({ ...NEUTRAL, time: D_MS, feedback: 0, reverse: 1 }), input);
    // Forward: imp1 echoes at d, imp2 at d+gap — chronological.
    const f1 = peakIndex(fwd.L, d - 400, d + Math.round(gap / 2));
    const f2 = peakIndex(fwd.L, d + Math.round(gap / 2), 2 * d);
    expect(Math.abs(f1 - d)).toBeLessThan(60);
    expect(Math.abs(f2 - (d + gap))).toBeLessThan(60);
    // Reverse: the echo window plays newest-first — imp2 surfaces before imp1.
    const r2 = peakIndex(rev.L, 2 * d - gap - 800, 2 * d - gap + 800);
    const r1 = peakIndex(rev.L, 2 * d - 900, 2 * d + 500);
    expect(Math.abs(r2 - (2 * d - gap))).toBeLessThan(80);
    expect(Math.abs(r1 - 2 * d)).toBeLessThan(80);
    expect(r2).toBeLessThan(r1); // the swap itself
  });

  it("reverse render differs from forward and stays audible", () => {
    const input = monoImpulse(0.8);
    const fwd = render(0.6, makeParams({ ...NEUTRAL, time: 200, feedback: 0.5 }), input);
    const rev = render(0.6, makeParams({ ...NEUTRAL, time: 200, feedback: 0.5, reverse: 1 }), input);
    let diff = 0;
    for (let i = 0; i < fwd.L.length; i++) diff = Math.max(diff, Math.abs(fwd.L[i] - rev.L[i]));
    expect(diff).toBeGreaterThan(0.05);
    expect(peak(rev.L, 0, rev.L.length)).toBeGreaterThan(0.05);
  });
});

describe("kaskada freeze HOLD (tail capture)", () => {
  const HOLD_BLOCK = 200; // sample 25600 = ~0.53 s

  function renderHold(mode: number, postImpulse: boolean) {
    const prm = makeParams({ ...NEUTRAL, time: 100, feedback: 0.5 });
    const burstEnd = Math.round(0.25 * currentSr());
    const input = (s: number): [number, number] => {
      if (s < burstEnd) {
        const v = 0.5 * Math.sin((2 * Math.PI * 440 * s) / currentSr());
        return [v, v];
      }
      if (postImpulse && s === Math.round(0.9 * currentSr())) return [0.9, 0.9];
      return [0, 0];
    };
    return render(1.6, prm, input, (block, p) => {
      if (block === HOLD_BLOCK) p.freeze[0] = mode;
    });
  }

  it("sustains the captured window bit-stably (no per-pass decay like LOOP)", () => {
    const hold = renderHold(2, false);
    const loop = renderHold(1, false);
    const earlyFrom = Math.round(0.7 * currentSr());
    const earlyTo = Math.round(0.9 * currentSr());
    const lateFrom = Math.round(1.3 * currentSr());
    const holdRatio = rms(hold.L, lateFrom, hold.L.length) / rms(hold.L, earlyFrom, earlyTo);
    const loopRatio = rms(loop.L, lateFrom, loop.L.length) / rms(loop.L, earlyFrom, earlyTo);
    // HOLD loops one captured window with no write-back: level stays put.
    // LOOP decays by 0.99 per ~100 ms pass (plus ~6 passes in the window).
    expect(holdRatio).toBeGreaterThan(0.95);
    expect(holdRatio).toBeLessThan(1.05);
    expect(loopRatio).toBeLessThan(0.98);
  });

  it("seals the write head: a post-hold impulse cannot reach the output", () => {
    const withImpulse = renderHold(2, true);
    const without = renderHold(2, false);
    expect([...withImpulse.L]).toEqual([...without.L]);
    expect([...withImpulse.R]).toEqual([...without.R]);
  });
});

describe("kaskada solo wet", () => {
  it("mutes the dry arm regardless of MIX while the echo stays", () => {
    const d = Math.round(0.2 * currentSr());
    const { L } = render(
      0.5,
      makeParams({ ...NEUTRAL, time: 200, feedback: 0, mix: 0.25, soloWet: 1 }),
      monoImpulse(0.75),
    );
    expect(peak(L, 0, d - 500)).toBe(0); // no dry passthrough before the echo
    expect(peak(L, d - 500, d + 1500)).toBeGreaterThan(0.05); // echo present
  });
});

describe("kaskada character 3-4", () => {
  it("DRUM darkens repeats harder than digital and stays audible", () => {
    const d = Math.round(0.15 * currentSr());
    const w = Math.round(0.06 * currentSr());
    const input = sineBurst(5000, w);
    const dig = render(0.4, makeParams({ ...NEUTRAL, time: 150, feedback: 0.3, character: 0 }), input);
    const drum = render(0.4, makeParams({ ...NEUTRAL, time: 150, feedback: 0.3, character: 3 }), input);
    const digRms = rms(dig.L, d, d + w);
    const drumRms = rms(drum.L, d, d + w);
    expect(digRms).toBeGreaterThan(0.02);
    expect(drumRms).toBeGreaterThan(0.005);
    expect(drumRms).toBeLessThan(digRms * 0.8); // head loss at 5 kHz
  });

  it("DIFFUSE fills the gaps between repeats (smear builds through the loop)", () => {
    const d = Math.round(0.15 * currentSr());
    const input = monoImpulse(0.9);
    const dig = render(0.6, makeParams({ ...NEUTRAL, time: 150, feedback: 0.6, character: 0 }), input);
    const dif = render(0.6, makeParams({ ...NEUTRAL, time: 150, feedback: 0.6, character: 4 }), input);
    let diff = 0;
    for (let i = 0; i < dig.L.length; i++) diff = Math.max(diff, Math.abs(dig.L[i] - dif.L[i]));
    expect(diff).toBeGreaterThan(0.05); // audibly different from digital
    // Between two discrete echo peaks the diffuse network keeps energy
    // flowing (allpass tail) where digital decays to near-silence.
    const gapFrom = d + Math.round(0.02 * currentSr());
    const gapTo = 2 * d - Math.round(0.02 * currentSr());
    expect(rms(dif.L, gapFrom, gapTo)).toBeGreaterThan(rms(dig.L, gapFrom, gapTo) * 1.5);
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

/* ─────────────── dual-spectrum meters ─────────────── */

/** Params for wet-trace assertions: short delay so EVERY 46 ms analysis
 *  window contains echoes (375 ms default would leave most windows dry),
 *  hot feedback for level, transparent EQ so a 1 kHz tone passes intact. */
const METER_PARAMS = { ...NEUTRAL, time: 30, feedback: 0.9 };

interface MeterRun {
  frames: Float32Array[];
  leakedAfterDisable: number;
}

/** Module-scope so the unmask battery can drive meters too. */
function driveMeters(
  seconds: number,
  input: (s: number) => [number, number],
  opts: { enable?: boolean; disableAtBlock?: number; params?: Record<string, number> } = {},
): MeterRun {
  const sr = currentSr();
  const proc = createKaskadaProcessor() as KaskadaProcessorInstance & { port: FakePort };
  const prm = makeParams(opts.params ?? METER_PARAMS);
  const run: MeterRun = { frames: [], leakedAfterDisable: 0 };
  const nBlocks = Math.ceil((seconds * sr) / BLOCK);
  const outL = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);
  if (opts.enable !== false) proc.port.onmessage?.({ data: { type: "setMeters", enabled: true } });
  for (let b = 0; b < nBlocks; b++) {
    const disabled = b === opts.disableAtBlock;
    if (disabled) proc.port.onmessage?.({ data: { type: "setMeters", enabled: false } });
    const inL = new Float32Array(BLOCK);
    const inR = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      const [l, r] = input(b * BLOCK + i);
      inL[i] = l;
      inR[i] = r;
    }
    proc.process([[inL, inR]], [[outL, outR]], prm);
    for (const { msg } of proc.port.posted) {
      const m = msg as { type?: string; bands?: Float32Array };
      if (m?.type === "meters" && m.bands instanceof Float32Array) {
        if (disabled || run.leakedAfterDisable > 0) run.leakedAfterDisable++;
        else run.frames.push(m.bands);
      }
    }
    proc.port.posted.length = 0;
  }
  return run;
}

describe("kaskada dual-spectrum meters", () => {
  it("posts nothing while gated (default off — closed panel costs no analysis)", () => {
    const run = driveMeters(0.5, sineBurst(1000, Math.round(0.4 * currentSr())), { enable: false });
    expect(run.frames.length).toBe(0);
    expect(run.leakedAfterDisable).toBe(0);
  });

  it("streams ~30 frames/s of 176 values (dry + wet dB, unmask reduction dB)", () => {
    const run = driveMeters(1.0, sineBurst(1000, currentSr(), 0.9));
    // First frame lands after the window fills (~43 ms) + the 11-block
    // cadence; 1 s of audio then yields roughly 28–30 frames.
    expect(run.frames.length).toBeGreaterThanOrEqual(15);
    expect(run.frames.length).toBeLessThanOrEqual(45);
    const last = run.frames[run.frames.length - 1];
    expect(last.length).toBe(176);
    for (const v of last) {
      expect(Number.isFinite(v)).toBe(true);
    }
    for (let i = 0; i < 144; i++) {
      expect(last[i]).toBeGreaterThanOrEqual(-90);
      expect(last[i]).toBeLessThanOrEqual(0);
    }
    for (let i = 144; i < 176; i++) {
      expect(last[i]).toBeGreaterThanOrEqual(0); // reduction is positive dB
      expect(last[i]).toBeLessThanOrEqual(12);
    }
  });

  it("dry trace shows the true input spectrum (1 kHz tone, no HF leak)", () => {
    const run = driveMeters(1.0, sineBurst(1000, currentSr(), 0.9));
    const last = run.frames[run.frames.length - 1];
    const peakDb = maxBandDb(last, 0, 1000);
    // 0.9 amplitude lands a few dB under 0 once the band mean dilutes a
    // 2-bin mainlobe across the band's bins (plus Hann scallop).
    expect(peakDb).toBeGreaterThan(-20);
    expect(maxBandDb(last, 0, 9000)).toBeLessThan(-50); // nothing up there
    expect(maxBandDb(last, 0, 100)).toBeLessThan(-50); // Hann leakage stays deep
  });

  it("wet trace shows the delay bus echoes at the input tone", () => {
    const run = driveMeters(1.0, sineBurst(1000, currentSr(), 0.9));
    const last = run.frames[run.frames.length - 1];
    // Short delay + fb 0.9 keeps a dense echo train in every window; the
    // loop EQ is parked transparent so the tone arrives uncoloured.
    expect(maxBandDb(last, 72, 1000)).toBeGreaterThan(-25);
    expect(maxBandDb(last, 72, 9000)).toBeLessThan(-45);
  });

  it("loop EQ shapes the wet trace: LP 500 buries a 5 kHz tone", () => {
    const open = driveMeters(1.0, sineBurst(5000, currentSr(), 0.9), {
      params: { ...METER_PARAMS, toneLp: 12000 },
    });
    const dark = driveMeters(1.0, sineBurst(5000, currentSr(), 0.9), {
      params: { ...METER_PARAMS, toneLp: 500 },
    });
    const openDb = maxBandDb(open.frames[open.frames.length - 1], 72, 5000);
    const darkDb = maxBandDb(dark.frames[dark.frames.length - 1], 72, 5000);
    expect(openDb).toBeGreaterThan(-25);
    expect(darkDb - openDb).toBeLessThan(-30); // 24 dB/oct cascade doing its job
  });

  it("stops posting after a disable (no straggler frames leak through the gate)", () => {
    const sr = currentSr();
    const disableAt = Math.ceil((0.3 * sr) / BLOCK);
    const run = driveMeters(1.0, sineBurst(1000, currentSr(), 0.9), { disableAtBlock: disableAt });
    expect(run.frames.length).toBeGreaterThan(3); // was live before the flip
    expect(run.leakedAfterDisable).toBe(0);
  });

  it("silent input renders floor-valued frames (no NaN from empty windows)", () => {
    const run = driveMeters(0.5, () => [0, 0]);
    expect(run.frames.length).toBeGreaterThan(0);
    for (const frame of run.frames) {
      for (const v of frame) {
        expect(Number.isFinite(v)).toBe(true);
      }
      for (let i = 0; i < 144; i++) {
        expect(frame[i]).toBe(-90); // clamped floor, not -Infinity
      }
      for (let i = 144; i < 176; i++) {
        expect(frame[i]).toBe(0); // no reduction without a masker
      }
    }
  });
});

/* ─────────────── unmask solver ─────────────── */

describe("kaskada unmask solver", () => {
  /** Solver fixture: short delay (dense echo train), transparent loop EQ,
   *  full wet monitoring, solver wide open (amount 1). Feedback stays at
   *  the 0.35 default so the wet bus sits ABOVE the dry only slightly —
   *  a hot feedback would push the wet over the dry and shrink masking. */
  const UM_BASE = { ...NEUTRAL, time: 30, feedback: 0.35, unmask: 1, unmaskSens: 0.5 };

  /** Band index nearest `freq` on the solver's 32-band 40 Hz–16 kHz grid. */
  const umBandOf = (freq: number) => Math.max(0, Math.min(31, Math.round(31 * (Math.log(freq / 40) / Math.log(400)))));

  it("ducks the masked echo: the output drops where the dry dominates the same band", () => {
    const input = sineBurst(2000, currentSr(), 0.6);
    const off = render(1.0, makeParams({ ...UM_BASE, unmaskOn: 0 }), input);
    const on = render(1.0, makeParams({ ...UM_BASE, unmaskOn: 1 }), input);
    const from = Math.round(0.5 * currentSr());
    const rmsOff = rms(off.L, from, off.L.length);
    const rmsOn = rms(on.L, from, on.L.length);
    expect(rmsOff).toBeGreaterThan(0.05);
    // The echo carries the same 2 kHz tone as the dry; the solver carves
    // that band out of the delay bus (≤ 12 dB, amount-scaled).
    expect(rmsOn).toBeLessThan(rmsOff * 0.6);
  });

  it("reports the reduction in the meters frame at the masked band", () => {
    const run = driveMeters(1.0, sineBurst(2000, currentSr(), 0.6), {
      params: { ...UM_BASE, unmaskOn: 1 },
    });
    expect(run.frames.length).toBeGreaterThan(0);
    const last = run.frames[run.frames.length - 1];
    let maxRed = 0;
    for (let b = 0; b < 32; b++) maxRed = Math.max(maxRed, last[144 + b]);
    expect(maxRed).toBeGreaterThan(4);
  });

  it("rings free in pauses: reduction recovers after the dry stops", () => {
    const burst = Math.round(0.3 * currentSr());
    const input = (s: number): [number, number] =>
      s < burst ? [0.6 * Math.sin((2 * Math.PI * 2000 * s) / currentSr()), 0] : [0, 0];
    const off = render(2.2, makeParams({ ...UM_BASE, unmaskOn: 0 }), input);
    const on = render(2.2, makeParams({ ...UM_BASE, unmaskOn: 1 }), input);
    // Well past the 250 ms default release: the delay bus decays alone.
    const tailFrom = Math.round(1.7 * currentSr());
    const ratio = rms(on.L, tailFrom, on.L.length) / rms(off.L, tailFrom, off.L.length);
    expect(ratio).toBeGreaterThan(0.9);
  });

  it("an inaudible masker masks nothing (below the −60 dB floor the output is bit-exact)", () => {
    const input = sineBurst(2000, currentSr(), 0.0005);
    const off = render(1.0, makeParams({ ...UM_BASE, unmaskOn: 0 }), input);
    const on = render(1.0, makeParams({ ...UM_BASE, unmaskOn: 1 }), input);
    expect([...on.L]).toEqual([...off.L]);
    expect([...on.R]).toEqual([...off.R]);
  });

  it("solver band grid centers the 2 kHz bell near band 20 (sanity for the meters assertion)", () => {
    expect(umBandOf(2000)).toBe(20);
    expect(umBandOf(100)).toBeLessThan(umBandOf(2000));
    expect(umBandOf(8000)).toBeGreaterThan(umBandOf(2000));
  });

  it("silent input stays exactly silent with the solver wide open", () => {
    const { L, R } = render(0.5, makeParams({ ...UM_BASE, unmaskOn: 1, unmaskSens: 1 }));
    expect(peak(L, 0, L.length)).toBe(0);
    expect(peak(R, 0, R.length)).toBe(0);
  });

  it("power toggle mid-render never poisons the output (gains decay, no jump)", () => {
    const { L } = render(
      1.5,
      makeParams({ ...UM_BASE, unmaskOn: 1 }),
      sineBurst(2000, currentSr(), 0.6),
      (block, p) => {
        if (block === Math.round((0.7 * currentSr()) / BLOCK)) p.unmaskOn[0] = 0;
      },
    );
    const max = assertAllFinite([L], "unmask power toggle");
    expect(max).toBeLessThan(48);
  });

  it("hot settings soak: solver wide open at min sensitivity stays finite and bounded", () => {
    const rng = mulberry32(0x0ada);
    const { L, R } = render(
      2.2,
      makeParams({
        ...UM_BASE,
        unmaskOn: 1,
        unmaskSens: 1, // −36 dB threshold — maximal masking
        unmaskAtk: 0.1,
        unmaskRel: 2000,
        feedback: 0.95,
        drive: 1,
        level: 6,
      }),
      () => [rng() * 1.8 - 0.9, rng() * 1.8 - 0.9],
    );
    const max = assertAllFinite([L, R], "unmask-hot");
    expect(max).toBeLessThan(48);
  });
});

/* ─────────────── audit-fix regressions (2026-09-19) ───────────────
 * Each of these pins a defect found by the four-plugin audit:
 *  - LEVEL did not scale the dry path (mix 0 made it fully inert)
 *  - SPREAD's M/S coefficient had the sign flipped (it narrowed to mono)
 *  - a non-finite input sample poisoned the ring buffer permanently
 *  - the unmask power-off zeroed every gain in one block (click)
 *  - HOLD capture was capped at bufSize>>1 (wrong period above 1 s)
 *  - HOLD ignored the modulation/wow offset (click on entry/exit)
 */

describe("kaskada audit regressions", () => {
  it("LEVEL scales the whole output, dry included (mix 0 is not inert)", () => {
    const imp = (s: number): [number, number] => (s === 0 ? [0.8, 0.8] : [0, 0]);
    const a = render(0.3, makeParams({ ...NEUTRAL, mix: 0, level: 0 }), imp);
    const b = render(0.3, makeParams({ ...NEUTRAL, mix: 0, level: -24 }), imp);
    expect(a.L[0]).toBeCloseTo(0.8, 5);
    expect(20 * Math.log10(Math.abs(b.L[0]) / 0.8)).toBeLessThan(-20);
  });

  it("SPREAD widens the wet bus instead of collapsing it to mono", () => {
    const src = (s: number): [number, number] =>
      s < 4800 ? [0.5 * Math.sin((2 * Math.PI * 1000 * s) / currentSr()), 0] : [0, 0];
    const diff = (r: { L: Float32Array; R: Float32Array }) => {
      let m = 0;
      for (let i = 0; i < r.L.length; i++) m = Math.max(m, Math.abs(r.L[i] - r.R[i]));
      return m;
    };
    const s0 = diff(render(0.4, makeParams({ ...NEUTRAL, spread: 0 }), src));
    const s05 = diff(render(0.4, makeParams({ ...NEUTRAL, spread: 0.5 }), src));
    const s1 = diff(render(0.4, makeParams({ ...NEUTRAL, spread: 1 }), src));
    expect(s0).toBeGreaterThan(0.3);
    expect(s05).toBeGreaterThan(s0); // wider than neutral
    expect(s1).toBeGreaterThan(s05);
  });

  it("a non-finite input burst cannot poison the tail", () => {
    const { L, R } = render(1.5, makeParams({ ...NEUTRAL }), (s) =>
      s >= 1000 && s < 1400 ? [Infinity, Infinity] : s === 0 ? [0.5, 0.5] : [0, 0],
    );
    assertAllFinite([L, R], "non-finite input");
  });

  it("unmask power-off fades the reduction through the bell chain (no step)", () => {
    const start = Math.round(0.7 * currentSr());
    const input = (s: number): [number, number] => {
      const v = 0.6 * Math.sin((2 * Math.PI * 2000 * s) / currentSr());
      return [v, v];
    };
    const { L } = render(
      1.5,
      makeParams({ ...NEUTRAL, unmaskOn: 1, unmask: 1, unmaskSens: 1, time: 200, feedback: 0.4 }),
      input,
      (block, p) => {
        if (block === Math.floor(start / BLOCK)) p.unmaskOn[0] = 0;
      },
    );
    let maxStep = 0;
    for (let i = 1; i < L.length; i++) maxStep = Math.max(maxStep, Math.abs(L[i] - L[i - 1]));
    // Natural sample-to-sample slope of the 2 kHz tone is ~0.155; the old
    // one-block gain zeroing stepped ~0.9.
    expect(maxStep).toBeLessThan(0.4);
  });

  it("HOLD captures a full echo period above 1000 ms", () => {
    const sr = currentSr();
    const freezeBlock = Math.round((2.0 * sr) / BLOCK);
    const { L } = render(
      6.0,
      makeParams({ ...NEUTRAL, mix: 1, time: 1500, feedback: 0.5 }),
      (s) => (s < Math.round(0.2 * sr) ? [0.5, 0.5] : [0, 0]),
      (block, p) => {
        if (block === freezeBlock) p.freeze[0] = 2;
      },
    );
    const energy = (fromSec: number, toSec: number) => {
      let e = 0;
      for (let i = Math.round(fromSec * sr); i < Math.round(toSec * sr); i++) e += L[i] * L[i];
      return e;
    };
    // Capture window [0.5 s, 2.0 s) holds the burst 1.0 s in, so the hold
    // repeats at 3.0 / 4.5 s. The old bufSize>>1 cap (1000 ms) repeated at
    // 2.5 / 3.5 s instead.
    expect(energy(3.0, 3.2)).toBeGreaterThan(0.001);
    expect(energy(4.5, 4.7)).toBeGreaterThan(0.001);
    expect(energy(2.5, 2.7)).toBeLessThan(1e-6);
    expect(energy(3.5, 3.7)).toBeLessThan(1e-6);
  });

  it("HOLD entry mid-modulation does not click", () => {
    const sr = currentSr();
    const freezeBlock = Math.round((0.8 * sr) / BLOCK);
    const { L } = render(
      1.6,
      makeParams({ ...NEUTRAL, mix: 1, time: 250, feedback: 0.5, modDepth: 0.5, modRate: 3, character: 1 }),
      (s) => {
        if (s >= Math.round(0.3 * sr)) return [0, 0];
        const v = 0.5 * Math.sin((2 * Math.PI * 440 * s) / sr);
        return [v, v];
      },
      (block, p) => {
        if (block === freezeBlock) p.freeze[0] = 2;
        if (block === freezeBlock + 20) p.freeze[0] = 0;
      },
    );
    let maxStep = 0;
    for (let i = 1; i < L.length; i++) maxStep = Math.max(maxStep, Math.abs(L[i] - L[i - 1]));
    // Natural slope of the 440 Hz tail is ~0.029/sample; the old raw-read
    // anchor jump measured > 0.1.
    expect(maxStep).toBeLessThan(0.12);
  });
});
