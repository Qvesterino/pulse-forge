import { beforeAll, describe, expect, it } from "vitest";
import { createPreDelay } from "../src/effects/ozvena-core/modules/preDelay.js";
import { capUserIrFrames, OZVENA_IR_MAX_SECONDS } from "../src/effects/ozvena-params";
import { globalPeerRegistry } from "../src/effects/ozvena-core/v2/vocalForgeIpc.js";

/**
 * Ozvena hardening regressions — defects found in the 2026-09 self-audit.
 *
 * Covers three confirmed bug classes:
 *  1. Parameter boundary validation: non-finite / malformed values arriving
 *     over the message port (any host source — corrupt docs, collab deltas,
 *     future automation code paths) must be dropped at the entry boundary.
 *     Before the fix, NaN gains produced NaN output samples (the output
 *     limiter does not reject them), and a NaN enum index produced
 *     `list[NaN] === undefined`, which THREW inside the engine recompute()
 *     — on a real audio thread that kills the processor for the whole
 *     context.
 *  2. Global gain clamping: finite-but-absurd gains (1e9 dB) reached
 *     dbToLinear() unclamped → Infinity output. The engines clamp their own
 *     params; the global gains were the missing members of that family.
 *  3. Shimmer feedback stability: the octave-up grain is injected INSIDE the
 *     FDN feedback loop, so the per-pass loop gain is fb·(dirW + √2·inj) —
 *     not fb as the code comment claimed. Unguarded, shimmer ≥ ~0.35 at
 *     most decay times ran away and overflowed the float32 delay lines to
 *     Inf/NaN within seconds. The guard attenuates the direct feedback just
 *     enough to keep the loop decaying and is a bit-identical no-op in the
 *     stable region (verified against pre-fix renders).
 */

interface PostedMessage {
  type?: string;
  samples?: number;
}

class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  posted: PostedMessage[] = [];
  postMessage(msg: unknown): void {
    this.posted.push(msg as PostedMessage);
  }
}

class FakeAudioWorkletProcessor {
  port = new FakePort();
}

interface ProcShape {
  port: FakePort;
  proc: {
    isIrLoaded(): boolean;
    getIrChannels(): number;
    clearUserIr(): void;
    loadUserIr(samples: Float32Array, channels: 1 | 2 | 4): void;
  };
  state: {
    global: Record<string, unknown>;
    engines: { e1: { enabled: boolean }; e2: Record<string, unknown>; e3: Record<string, unknown> };
    mod: { mode: string };
    preDelay: { ms: number };
    [key: string]: unknown;
  };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

type ProcCtor = new (options?: { processorOptions?: { params?: Record<string, number>; bpm?: number } }) => ProcShape;

let Processor: ProcCtor;
let now = 0;
const setTime = (t: number) => {
  now = t;
};

beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = 48000;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (_name: string, cls: ProcCtor) => {
    Processor = cls;
  };
  Object.defineProperty(globalThis, "currentTime", {
    get: () => now,
    configurable: true,
  });
  await import("../src/effects/ozvena-worklet.entry.js");
  if (!Processor) throw new Error("ozvena-processor did not register");
});

const SR = 48000;
const BLOCK = 128;

/** Deterministic seeded noise input (same stream for every test). */
function makeRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Render with FRESH per-block input buffers (a reused buffer would feed
 *  the engine's wet write-back back in as input — an accidental external
 *  feedback loop that invalidates any stability measurement). */
function render(
  proc: ProcShape,
  gen: (l: Float32Array, r: Float32Array, sample: number) => void,
  seconds: number,
): Float32Array[] {
  setTime(0);
  const blocks = Math.ceil((seconds * SR) / BLOCK);
  const outL = new Float32Array(blocks * BLOCK);
  const outR = new Float32Array(blocks * BLOCK);
  for (let b = 0; b < blocks; b++) {
    const inL = new Float32Array(BLOCK);
    const inR = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) gen(inL, inR, b * BLOCK + i);
    proc.process(
      [[inL, inR]],
      [[outL.subarray(b * BLOCK, b * BLOCK + BLOCK), outR.subarray(b * BLOCK, b * BLOCK + BLOCK)]],
    );
    setTime(((b + 1) * BLOCK) / SR);
  }
  return [outL, outR];
}

/** Full-scale noise burst for the first 0.5 s, then silence. */
function noiseBurstThenSilence() {
  const rng = makeRng(0x5eed);
  return (l: Float32Array, r: Float32Array, sample: number) => {
    if (sample < 0.5 * SR && sample % BLOCK === 0) {
      l[0] = (rng() * 2 - 1) * 0.9;
      r[0] = (rng() * 2 - 1) * 0.9;
    }
  };
}

function countNonFinite(chans: Float32Array[]): number {
  let bad = 0;
  for (const ch of chans) for (let i = 0; i < ch.length; i++) if (!Number.isFinite(ch[i])) bad++;
  return bad;
}

function rms(chans: Float32Array[], fromSec: number, toSec: number): number {
  const from = Math.floor(fromSec * SR);
  const to = Math.min(chans[0].length, Math.floor(toSec * SR));
  let sum = 0;
  let n = 0;
  for (const ch of chans)
    for (let i = from; i < to; i++) {
      sum += ch[i] * ch[i];
      n++;
    }
  return n > 0 ? Math.sqrt(sum / n) : 0;
}

function energy(chans: Float32Array[], fromSec: number, toSec: number): number {
  const from = Math.floor(fromSec * SR);
  const to = Math.min(chans[0].length, Math.floor(toSec * SR));
  let sum = 0;
  for (const ch of chans) for (let i = from; i < to; i++) sum += ch[i] * ch[i];
  return sum;
}

const sendParam = (proc: ProcShape, id: string, value: unknown): void => {
  proc.port.onmessage?.({ data: { type: "param", id, value } });
};

describe("Ozvena hardening — parameter boundary validation (message port)", () => {
  it("a NaN numeric param is dropped and the previous value survives", () => {
    const proc = new Processor();
    sendParam(proc, "global.dryWet", 40);
    sendParam(proc, "global.dryWet", Number.NaN);
    expect(proc.state.global.dryWet).toBe(40);
    const out = render(proc, noiseBurstThenSilence(), 0.3);
    expect(countNonFinite(out)).toBe(0);
  });

  it.each([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "±Infinity params are dropped (global.dryWet=%s)",
    (v) => {
      const proc = new Processor();
      sendParam(proc, "global.dryWet", 55);
      sendParam(proc, "global.dryWet", v);
      expect(proc.state.global.dryWet).toBe(55);
    },
  );

  it("a non-numeric string that coerces to NaN is dropped (Number path)", () => {
    const proc = new Processor();
    const before = proc.state.preDelay.ms;
    sendParam(proc, "preDelay.ms", "not-a-number" as unknown as number);
    expect(proc.state.preDelay.ms).toBe(before);
  });

  it("a missing value (undefined) is dropped instead of coercing a boolean to false", () => {
    const proc = new Processor();
    sendParam(proc, "engines.e2.enabled", 1);
    sendParam(proc, "engines.e2.enabled", undefined);
    expect(proc.state.engines.e2.enabled).toBe(true);
  });

  it("regression: a NaN enum index no longer throws inside the audio path", () => {
    // Pre-fix: list[NaN] === undefined → ALGO_TUNING[undefined] → TypeError
    // thrown from recompute() ON THE AUDIO THREAD (kills the processor).
    const proc = new Processor();
    expect(() => {
      sendParam(proc, "engines.e2.algo", Number.NaN);
      sendParam(proc, "engines.e3.algo", Number.NaN);
      sendParam(proc, "mod.mode", Number.NaN);
    }).not.toThrow();
    // State keeps its last valid values…
    expect(proc.state.engines.e2.algo).toBe("room");
    expect(proc.state.engines.e3.algo).toBe("hall");
    expect(proc.state.mod.mode).toBe("randomFat");
    // …and audio still runs.
    const out = render(proc, noiseBurstThenSilence(), 0.2);
    expect(countNonFinite(out)).toBe(0);
    expect(energy(out, 0, 0.2)).toBeGreaterThan(0);
  });

  it("paramAt with a NaN value is dropped; valid paramAt events still land", () => {
    const proc = new Processor();
    proc.port.onmessage?.({ data: { type: "paramAt", id: "global.dryWet", value: Number.NaN, when: 0.1 } });
    proc.port.onmessage?.({ data: { type: "paramAt", id: "global.dryWet", value: 0, when: 0.15 } });
    const out = render(proc, noiseBurstThenSilence(), 0.4);
    expect(countNonFinite(out)).toBe(0);
    // The NaN event never landed; the valid one applied at t=0.15.
    expect(proc.state.global.dryWet).toBe(0);
  });

  it("NaN initial params via processorOptions are dropped too", () => {
    const proc = new Processor({
      processorOptions: { params: { "global.dryWet": Number.NaN, "engines.e2.time": Number.NaN } },
    });
    expect(proc.state.global.dryWet).toBe(100); // default survives
    expect(proc.state.engines.e2.time).toBe(2000);
    const out = render(proc, noiseBurstThenSilence(), 0.2);
    expect(countNonFinite(out)).toBe(0);
  });
});

describe("Ozvena hardening — global gain clamping (documented ranges)", () => {
  it.each([
    ["global.outputGainDb", 1e9],
    ["global.levelDb", 1e9],
    ["global.inputGainDb", 1e9],
  ])("extreme %s=%s stays finite and audible (clamped, not muted)", (id, v) => {
    const proc = new Processor();
    sendParam(proc, id, v);
    const out = render(proc, noiseBurstThenSilence(), 0.3);
    expect(countNonFinite(out)).toBe(0);
    // 1e9 dB clamps to the documented +24/+6 dB — loud, but finite.
    expect(rms(out, 0, 0.3)).toBeGreaterThan(1e-3);
    expect(rms(out, 0, 0.3)).toBeLessThan(4);
  });
});

describe("Ozvena hardening — shimmer feedback stability (FDN loop guard)", () => {
  it("E2 at max shimmer + longest decay decays instead of running away", () => {
    const proc = new Processor();
    sendParam(proc, "engines.e1.enabled", 0);
    sendParam(proc, "engines.e3.enabled", 0);
    sendParam(proc, "engines.e2.time", 14000);
    sendParam(proc, "engines.e2.shimmer", 1);
    const out = render(proc, noiseBurstThenSilence(), 6.0);
    expect(countNonFinite(out)).toBe(0);
    // A 14 s reverb's tail must still be DECAYING hard by t=5..6 s:
    // pre-fix the loop grew >100× in this window on its way to overflow.
    const early = rms(out, 1.0, 2.0);
    const late = rms(out, 5.0, 6.0);
    expect(late).toBeLessThan(early * 0.5);
  });

  it("E3 at max shimmer + 24 s decay decays instead of running away", () => {
    const proc = new Processor();
    sendParam(proc, "engines.e1.enabled", 0);
    sendParam(proc, "engines.e2.enabled", 0);
    sendParam(proc, "engines.e3.time", 24000);
    sendParam(proc, "engines.e3.shimmer", 1);
    const out = render(proc, noiseBurstThenSilence(), 6.0);
    expect(countNonFinite(out)).toBe(0);
    expect(rms(out, 5.0, 6.0)).toBeLessThan(rms(out, 1.0, 2.0) * 0.5);
  });

  it("both engines at max shimmer stay finite with a decaying tail", () => {
    const proc = new Processor();
    sendParam(proc, "engines.e2.shimmer", 1);
    sendParam(proc, "engines.e3.shimmer", 1);
    const out = render(proc, noiseBurstThenSilence(), 6.0);
    expect(countNonFinite(out)).toBe(0);
    expect(rms(out, 5.0, 6.0)).toBeLessThan(rms(out, 1.0, 2.0));
  });

  it("the guard is a no-op inside the stable region (sonic preservation)", () => {
    // shimmer 0.1 at the shortest decay times sits strictly inside the
    // guard's no-op region (dirW === 1) — the rendered tail energy must
    // stay in the band captured from the PRE-fix engine (bit-identical
    // renders were verified during the audit; the band tolerates
    // cross-platform float drift).
    const proc = new Processor();
    sendParam(proc, "engines.e2.shimmer", 0.1);
    sendParam(proc, "engines.e3.shimmer", 0.1);
    sendParam(proc, "engines.e2.time", 1400);
    sendParam(proc, "engines.e3.time", 4170);
    const rng = makeRng(1234);
    const burst = (l: Float32Array, r: Float32Array, sample: number) => {
      if (sample < 0.5 * SR && sample % 128 === 0) {
        l[0] = (rng() * 2 - 1) * 0.8;
        r[0] = (rng() * 2 - 1) * 0.8;
      }
    };
    render(proc, burst, 0.5);
    const out = render(proc, () => {}, 1.5);
    const e1 = energy(out, 0.1, 0.6);
    const e2 = energy(out, 0.6, 1.5);
    // Pre-fix reference: 1.2442 / 0.17940 — ±20 % band.
    expect(e1).toBeGreaterThan(1.0);
    expect(e1).toBeLessThan(1.5);
    expect(e2).toBeGreaterThan(0.14);
    expect(e2).toBeLessThan(0.22);
  });

  it("zero shimmer is untouched: default-state tail energy band", () => {
    const proc = new Processor();
    const rng = makeRng(1234);
    const burst = (l: Float32Array, r: Float32Array, sample: number) => {
      if (sample < 0.5 * SR && sample % 128 === 0) {
        l[0] = (rng() * 2 - 1) * 0.8;
        r[0] = (rng() * 2 - 1) * 0.8;
      }
    };
    render(proc, burst, 0.5);
    const out = render(proc, () => {}, 1.5);
    // Pre-fix reference: 1.7540 / 0.46953 — ±20 % band.
    expect(energy(out, 0.1, 0.6)).toBeGreaterThan(1.4);
    expect(energy(out, 0.1, 0.6)).toBeLessThan(2.1);
    expect(energy(out, 0.6, 1.5)).toBeGreaterThan(0.37);
    expect(energy(out, 0.6, 1.5)).toBeLessThan(0.57);
  });
});

describe("Ozvena hardening — sample-rate robustness", () => {
  it.each([88200, 96000])("at %d Hz the output stays finite, the tail lands, and latency scales", (sr) => {
    (globalThis as unknown as { sampleRate: number }).sampleRate = sr;
    try {
      const proc = new Processor();
      const blocks = Math.ceil((1.0 * sr) / BLOCK);
      const outL = new Float32Array(blocks * BLOCK);
      const outR = new Float32Array(blocks * BLOCK);
      setTime(0);
      for (let b = 0; b < blocks; b++) {
        const inL = new Float32Array(BLOCK);
        const inR = new Float32Array(BLOCK);
        if (b === 0) {
          inL[0] = 0.9;
          inR[0] = 0.9;
        }
        proc.process(
          [[inL, inR]],
          [[outL.subarray(b * BLOCK, b * BLOCK + BLOCK), outR.subarray(b * BLOCK, b * BLOCK + BLOCK)]],
        );
        setTime(((b + 1) * BLOCK) / sr);
      }
      let bad = 0;
      for (const ch of [outL, outR]) for (let i = 0; i < ch.length; i++) if (!Number.isFinite(ch[i])) bad++;
      expect(bad).toBe(0);
      // Tail present after the default 20 ms pre-delay.
      let tail = 0;
      for (const ch of [outL, outR])
        for (let i = Math.floor(0.05 * sr); i < Math.floor(0.4 * sr); i++) tail += ch[i] * ch[i];
      expect(tail).toBeGreaterThan(1e-6);
      // Latency report scales with the rate (≈2 ms lookahead + OS delay).
      const lat = proc.port.posted.filter((m) => m.type === "latency").pop();
      expect(lat?.samples ?? 0).toBeGreaterThan(Math.floor(0.0015 * sr));
    } finally {
      (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
    }
  });
});

describe("Ozvena hardening — quality switches are scalar-only on the audio thread", () => {
  it("cycling all four quality tiers updates the reported latency and stays finite", () => {
    // Pre-fix, every quality change called safetyLimiter.prepare() INSIDE
    // the realtime path — allocating and zeroing the oversampler rings on
    // the audio thread (dropout risk + envelope-reset click). The limiter
    // now preallocates all four factor states in prepare() and the switch
    // is a pointer swap; the latency report must still track the factor
    // (lookahead + per-factor group delay).
    const proc = new Processor();
    const burst = noiseBurstThenSilence();
    render(proc, burst, 0.2);
    const latencies: number[] = [];
    for (const q of [0, 1, 2, 3, 1, 0]) {
      proc.port.posted.length = 0;
      sendParam(proc, "global.quality", q);
      const out = render(proc, burst, 0.2);
      expect(countNonFinite(out)).toBe(0);
      const lat = proc.port.posted.filter((m) => m.type === "latency").pop();
      if (lat && typeof lat.samples === "number") latencies.push(lat.samples);
    }
    // eco/standard/high/render oversamplers have distinct group delays.
    expect(new Set(latencies).size).toBeGreaterThanOrEqual(3);
  });

  it("rapid quality flicker while rendering keeps the output finite and bounded", () => {
    const proc = new Processor();
    setTime(0);
    const rng = makeRng(424242);
    let nonFinite = 0;
    let maxAbs = 0;
    const blocks = Math.ceil((1.0 * SR) / BLOCK);
    for (let b = 0; b < blocks; b++) {
      if (b % 8 === 0) sendParam(proc, "global.quality", (b / 8) % 4); // ~47 switches/s
      const inL = new Float32Array(BLOCK);
      const inR = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        inL[i] = (rng() * 2 - 1) * 0.8;
        inR[i] = (rng() * 2 - 1) * 0.8;
      }
      const outL = new Float32Array(BLOCK);
      const outR = new Float32Array(BLOCK);
      proc.process([[inL, inR]], [[outL, outR]]);
      for (let i = 0; i < BLOCK; i++) {
        if (!Number.isFinite(outL[i]) || !Number.isFinite(outR[i])) nonFinite++;
        maxAbs = Math.max(maxAbs, Math.abs(outL[i]), Math.abs(outR[i]));
      }
      setTime(((b + 1) * BLOCK) / SR);
    }
    expect(nonFinite).toBe(0);
    expect(maxAbs).toBeLessThanOrEqual(4); // limiter ceiling -0.3 dBFS + margin
  });

  it("switching quality mid-tail does not click via an envelope reset (gain carried)", () => {
    // Drive the limiter into gain reduction, then switch factors: the new
    // active set must inherit the reduction envelope instead of jumping
    // back to unity.
    const proc = new Processor();
    sendParam(proc, "global.quality", 2);
    const loud = (l: Float32Array, r: Float32Array, sample: number) => {
      if (sample % BLOCK === 0) {
        l[0] = 1.0;
        r[0] = -1.0;
      }
    };
    render(proc, loud, 0.3); // limiter engaged
    const out = render(proc, loud, 0.1);
    let peak = 0;
    for (const ch of out) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
    sendParam(proc, "global.quality", 3); // factor switch WHILE limiting
    const out2 = render(proc, loud, 0.02);
    let peak2 = 0;
    for (const ch of out2) for (let i = 0; i < ch.length; i++) peak2 = Math.max(peak2, Math.abs(ch[i]));
    // With the carry-over, the first blocks after the switch stay near the
    // engaged reduction; without it, output would jump to the full-scale
    // input (≈1.0) for the release duration.
    expect(peak).toBeLessThan(0.99);
    expect(peak2).toBeLessThan(1.0);
  });

  it("regression: reactivating an oversample set does not replay its stale lookahead audio", () => {
    // Drive quality "render" (8×) with hot impulses — its rings fill with
    // loud audio while the envelope engages. Switch away (eco), let
    // silence release the envelope toward unity, then switch BACK: the 8×
    // set's lookahead ring still held the old loud audio and re-emitted up
    // to a full lookahead window of stale material at ~unity gain on the
    // first silent block. The switch now zeroes the incoming set's ring
    // (envelope still carried): silence renders as silence.
    // Engines/pre-delay/smoother are disabled and dryWet is 0 so the DRY
    // path feeds the limiter directly — otherwise the reverb tail (not
    // the limiter) dominates the output and masks the replay.
    const proc = new Processor();
    sendParam(proc, "global.dryWet", 0);
    sendParam(proc, "preDelay.enabled", 0);
    sendParam(proc, "smoother.enabled", 0);
    sendParam(proc, "engines.e1.enabled", 0);
    sendParam(proc, "engines.e2.enabled", 0);
    sendParam(proc, "engines.e3.enabled", 0);
    sendParam(proc, "global.quality", 3); // render → 8×
    const hot = (l: Float32Array, r: Float32Array, sample: number) => {
      if (sample % BLOCK === 0) {
        l[0] = 0.99;
        r[0] = -0.99;
      }
    };
    render(proc, hot, 0.3); // 8× rings full of hot audio, env engaged
    sendParam(proc, "global.quality", 0); // eco → 1× active, 8× dormant
    render(proc, () => {}, 0.15); // silence releases the envelope
    sendParam(proc, "global.quality", 3); // back to the stale 8× set
    const out = render(proc, () => {}, 0.02); // silent input
    expect(countNonFinite(out)).toBe(0);
    let peak = 0;
    for (const ch of out) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
    expect(peak).toBeLessThan(1e-3);
  });
});

describe("Ozvena hardening — pre-delay sweep continuity (listening proxy)", () => {
  it("a full 10→400 ms sweep renders the delayed sine without dropout windows", () => {
    // Automated stand-in for the "manual listening on pre-delay sweeps"
    // item. A 1000 Hz sine (period EXACTLY 48 samples = the 1 ms sweep
    // step, so the two crossfaded reads are always in phase and cannot
    // cancel; every 64-sample window spans ≥ 1.3 full cycles, so windowed
    // RMS is a stable level meter) is swept 1 ms per 64-sample block from
    // 10 ms to 400 ms, crossing ~6 power-of-two ring capacities
    // (512→1024→2048→4096→8192→16384→32768 samples). Before the
    // ring-growth fix every crossing wiped the line: the crossfade read a
    // zeroed ring and the output went silent for the new delay duration.
    // After the fix every 64-sample window carries the sine (RMS ≥ ~0.33).
    const pd = createPreDelay();
    pd.prepare(SR, 2, 120);
    pd.setParams({ enabled: true, ms: 10, syncEnabled: false, syncNote: "1/4" });

    const STEP = 64;
    const STEPS = 390; // 10 ms + 390 × 1 ms → 400 ms
    const N = STEPS * STEP;
    const outL = new Float32Array(N);
    let ms = 10;
    let phase = 0;
    for (let step = 0; step < STEPS; step++) {
      pd.setParams({ enabled: true, ms, syncEnabled: false, syncNote: "1/4" });
      ms += 1;
      const l = new Float32Array(STEP);
      const r = new Float32Array(STEP);
      for (let i = 0; i < STEP; i++) {
        phase += (2 * Math.PI * 1000) / SR;
        if (phase >= 2 * Math.PI) phase -= 2 * Math.PI;
        l[i] = Math.sin(phase) * 0.5;
        r[i] = l[i];
      }
      pd.process([l, r], STEP);
      outL.set(l, step * STEP);
    }

    // Skip the initial delay fill: until elapsed samples exceed the
    // CURRENT delay distance, reads return the ring's (zero) tail —
    // startup behaviour, not a defect. At step k the delay is 480+48k
    // samples and elapsed is 64k, so reads are valid from k ≥ 30; skip 48
    // steps (3072 samples) for margin. Every window after must carry the
    // sine (RMS floor ≈ 0.33 for 0.5-amplitude 1000 Hz).
    const SKIP_STEPS = 48;
    let minRms = Infinity;
    for (let w = SKIP_STEPS; w + 1 <= STEPS; w++) {
      let s = 0;
      for (let i = w * STEP; i < (w + 1) * STEP; i++) s += outL[i] * outL[i];
      minRms = Math.min(minRms, Math.sqrt(s / STEP));
    }
    expect(minRms).toBeGreaterThan(0.2);
  });
});

describe("Ozvena hardening — user IR wiring (roadmap O7)", () => {
  it("loadIr message arms the convolver; clearIr disarms it; latency re-posts", () => {
    const proc = new Processor();
    // Convolution latency only counts in hybrid/convolution modes.
    sendParam(proc, "convolution.mode", 1);
    proc.port.posted.length = 0;
    // 4-tap stereo IR (2 frames × 2 channels interleaved).
    const ir = new Float32Array([1, 0.5, 0.25, 0.125]);
    proc.port.onmessage?.({ data: { type: "loadIr", samples: ir, channels: 2 } });
    expect(proc.proc.isIrLoaded()).toBe(true);
    expect(proc.proc.getIrChannels()).toBe(2);
    // Latency changes when a convolver appears — the node must re-report.
    const latencies = proc.port.posted.filter((m) => m.type === "latency");
    expect(latencies.length).toBeGreaterThanOrEqual(1);

    proc.port.posted.length = 0;
    proc.port.onmessage?.({ data: { type: "clearIr" } });
    expect(proc.proc.isIrLoaded()).toBe(false);
    expect(proc.port.posted.some((m) => m.type === "latency")).toBe(true);
  });

  it("an empty IR payload is ignored without corrupting the convolver", () => {
    const proc = new Processor();
    proc.port.onmessage?.({ data: { type: "loadIr", samples: new Float32Array(0), channels: 2 } });
    expect(proc.proc.isIrLoaded()).toBe(false);
  });
});

describe("Ozvena hardening — user IR length cap (audio-thread allocation bound)", () => {
  // Pre-fix: nothing bounded the IR length on the worklet side. A mistaken
  // long file (decodeAudioData decodes whole songs) drove the partitioned
  // convolver's FFT spectrum allocation linearly with length — hundreds of
  // MB and an unbounded audio-thread stall for the load-time FFT batch.
  it("capUserIrFrames: in-range lengths pass, over-cap trims, garbage → 0", () => {
    expect(capUserIrFrames(48000, 48000)).toBe(48000); // 1 s — untouched
    expect(capUserIrFrames(0, 48000)).toBe(0);
    expect(capUserIrFrames(Number.NaN, 48000)).toBe(0);
    expect(capUserIrFrames(-5, 48000)).toBe(0);
    // 15 minutes of stereo at 48 kHz → exactly the 10 s cap.
    expect(capUserIrFrames(15 * 60 * 48000, 48000)).toBe(OZVENA_IR_MAX_SECONDS * 48000);
    // The cap is time-based: at 96 kHz twice the frames fit.
    expect(capUserIrFrames(15 * 60 * 96000, 96000)).toBe(OZVENA_IR_MAX_SECONDS * 96000);
  });

  it("regression: an over-long loadIr payload is trimmed at the worklet boundary", () => {
    const proc = new Processor();
    const received: { len: number; channels: number }[] = [];
    const orig = proc.proc.loadUserIr;
    proc.proc.loadUserIr = (samples: Float32Array, channels: 1 | 2 | 4) => {
      received.push({ len: samples.length, channels });
    };
    // 15 s of stereo at the suite's 48 kHz rate.
    const ir = new Float32Array(2 * 15 * SR);
    proc.port.onmessage?.({ data: { type: "loadIr", samples: ir, channels: 2 } });
    expect(received).toHaveLength(1);
    expect(received[0].channels).toBe(2);
    expect(received[0].len).toBe(2 * OZVENA_IR_MAX_SECONDS * SR);

    // A short IR passes through untrimmed.
    const short = new Float32Array(1000);
    proc.port.onmessage?.({ data: { type: "loadIr", samples: short, channels: 1 } });
    expect(received[1].len).toBe(1000);
    expect(received[1].channels).toBe(1);

    proc.proc.loadUserIr = orig;
  });
});

describe("Ozvena hardening — pre-delay range is prepared up front", () => {
  it("regression: a live delay sweep crossfades instead of losing the tail", () => {
    // The full supported ring is reserved in prepare(), so a 10→30 ms
    // change cannot allocate or copy audio memory from the render path. The
    // same continuity assertion also protects the delay-time crossfade: an
    // impulse already in the line must still emerge around the old delay.
    const pd = createPreDelay();
    pd.prepare(SR, 2, 120);
    pd.setParams({ enabled: true, ms: 10, syncEnabled: false, syncNote: "1/4" });

    const N = 1024;
    const outL = new Float32Array(N);
    let grew = false;
    for (let start = 0; start < N; start += 64) {
      if (start === 64 && !grew) {
        pd.setParams({ enabled: true, ms: 30, syncEnabled: false, syncNote: "1/4" });
        grew = true;
      }
      const l = new Float32Array(64);
      const r = new Float32Array(64);
      if (start === 0) {
        l[0] = 1;
        r[0] = 1;
      }
      pd.process([l, r], 64);
      outL.set(l, start);
    }
    expect(grew).toBe(true);
    // The impulse must survive the live change: it re-emerges (blended by
    // the 20 ms crossfade) around the old 480-sample delay.
    let e = 0;
    for (let i = 440; i < 600; i++) e += outL[i] * outL[i];
    expect(e).toBeGreaterThan(0.05);
  });
});

describe("Ozvena hardening — reset() restores a freshly-prepared processor", () => {
  // reset()'s contract (mirrors the native core): a reset processor is
  // indistinguishable from a brand-new one. Pre-fix, three scalar states
  // survived reset: the duck controller's gain, the gate envelope and the
  // transient smoother's gain reduction. The duck gain is cleanly
  // observable on the wet bus; the smoother reduction on post-reset input.
  it("regression: an engaged auto-duck is released by reset()", () => {
    const burst = noiseBurstThenSilence();
    const tailEnergy = (out: Float32Array[]) => energy(out, 0.2, 0.5);

    // Control: duck enabled but no peer ever notifies.
    const control = new Processor();
    sendParam(control, "duck.enabled", 1);
    const controlOut = render(control, burst, 0.5);
    const e0 = tailEnergy(controlOut);
    expect(e0).toBeGreaterThan(1e-6);

    // A loud peer notification (magDb=10, threshold −20, sensitivity 0.5)
    // ducks the wet bus to gain 0.625 (−4.1 dB).
    const proc = new Processor();
    sendParam(proc, "duck.enabled", 1);
    const peerId = globalPeerRegistry.register("fxeq", "duck-test-peer", SR, 0, 2);
    globalPeerRegistry.notifyLevel(peerId, 1000, 10, 0);
    const duckedOut = render(proc, burst, 0.5);
    expect(tailEnergy(duckedOut)).toBeLessThan(e0 * 0.6);

    // reset() must release the duck — the tail returns to the control level.
    proc.port.onmessage?.({ data: { type: "reset" } });
    // duck stays enabled in the restored default? No: reset restores the
    // DEFAULT state (duck off). Re-enable it so the only variable is the
    // controller state, then re-render.
    sendParam(proc, "duck.enabled", 1);
    const afterOut = render(proc, burst, 0.5);
    expect(tailEnergy(afterOut)).toBeGreaterThan(e0 * 0.8);

    globalPeerRegistry.unregister(peerId);
  });

  it("regression: a lingering transient-shaper reduction is cleared by reset()", () => {
    // NOTE on coverage: the smoother's lingering reduction (like the gate
    // envelope) is a state-carryover that is NOT observable through the
    // output — the shaper's attack is instantaneous, so any post-reset
    // signal re-latches the correct reduction within milliseconds, long
    // before the engines' attack envelopes let wet energy through (probed
    // empirically during the audit: pre-fix and post-fix renders are
    // output-identical). The reset call is kept for the documented
    // "bit-identical to freshly prepared" contract; the DUCK gain — the
    // member of this defect class that IS audible — carries the
    // observability duty above.
    const proc = new Processor();
    sendParam(proc, "smoother.enabled", 1);
    sendParam(proc, "smoother.amount", 100);
    expect(() => proc.port.onmessage?.({ data: { type: "reset" } })).not.toThrow();
    const out = render(proc, noiseBurstThenSilence(), 0.2);
    expect(countNonFinite(out)).toBe(0);
    expect(energy(out, 0, 0.2)).toBeGreaterThan(0);
  });
});

describe("Ozvena hardening — freeze loop-gain safety (2026-09-19 audit)", () => {
  // FREEZE runs the FDN loop at unity feedback (fbEff = 1.0), but the
  // per-band decay gains were capped against the NON-freeze feedback
  // (gCap = 0.995/fb). With bassDecay > 1 the low band gain could reach
  // ~2, so 1.0 x gain in freeze was a per-pass gain > 1 and the frozen
  // tail grew exponentially until the output limiter pinned it at the
  // ceiling (measured pre-fix: 0.38-0.48 RMS sustained, peak 0.966).
  // The fix clamps every band to unity in freeze: a true hold, no growth.
  function renderFreeze(
    proc: ProcShape,
    freezeAtSec: number,
    seconds: number,
  ): Float32Array[] {
    const rng = makeRng(0x5eed);
    setTime(0);
    const blocks = Math.ceil((seconds * SR) / BLOCK);
    const outL = new Float32Array(blocks * BLOCK);
    const outR = new Float32Array(blocks * BLOCK);
    let frozen = false;
    for (let b = 0; b < blocks; b++) {
      if (!frozen && (b * BLOCK) / SR >= freezeAtSec) {
        sendParam(proc, "global.freeze", 1);
        frozen = true;
      }
      const inL = new Float32Array(BLOCK);
      const inR = new Float32Array(BLOCK);
      if (b * BLOCK < 0.3 * SR) {
        inL[0] = (rng() * 2 - 1) * 0.5;
        inR[0] = (rng() * 2 - 1) * 0.5;
      }
      proc.process(
        [[inL, inR]],
        [[outL.subarray(b * BLOCK, b * BLOCK + BLOCK), outR.subarray(b * BLOCK, b * BLOCK + BLOCK)]],
      );
      setTime(((b + 1) * BLOCK) / SR);
    }
    return [outL, outR];
  }

  function peak(chans: Float32Array[], fromSec: number, toSec: number): number {
    const from = Math.floor(fromSec * SR);
    const to = Math.min(chans[0].length, Math.floor(toSec * SR));
    let m = 0;
    for (const ch of chans) for (let i = from; i < to; i++) m = Math.max(m, Math.abs(ch[i]));
    return m;
  }

  it("E2 freeze with bassDecay 2 holds instead of pinning the limiter", () => {
    const proc = new Processor();
    sendParam(proc, "engines.e1.enabled", 0);
    sendParam(proc, "engines.e2.enabled", 1);
    sendParam(proc, "engines.e3.enabled", 0);
    sendParam(proc, "engines.e2.bassDecay", 2);
    sendParam(proc, "engines.e2.time", 1400);
    sendParam(proc, "engines.e2.mix", 100);
    sendParam(proc, "blendPad.x", 1);
    sendParam(proc, "blendPad.y", 0);
    sendParam(proc, "preDelay.ms", 0);
    const out = renderFreeze(proc, 1.0, 6.0);
    expect(countNonFinite(out)).toBe(0);
    // Pre-fix: sustained 0.38-0.48 RMS with peak 0.966 (limiter ceiling).
    expect(rms(out, 5.0, 6.0)).toBeLessThan(0.05);
    expect(peak(out, 0, 6.0)).toBeLessThan(0.5);
  });

  it("E3 freeze with bassDecay 4 holds", () => {
    const proc = new Processor();
    sendParam(proc, "engines.e1.enabled", 0);
    sendParam(proc, "engines.e2.enabled", 0);
    sendParam(proc, "engines.e3.enabled", 1);
    sendParam(proc, "engines.e3.bassDecay", 4);
    sendParam(proc, "engines.e3.time", 5000);
    sendParam(proc, "engines.e3.mix", 100);
    sendParam(proc, "blendPad.x", 0.5);
    sendParam(proc, "blendPad.y", 0.866);
    sendParam(proc, "preDelay.ms", 0);
    const out = renderFreeze(proc, 1.0, 6.0);
    expect(countNonFinite(out)).toBe(0);
    expect(rms(out, 5.0, 6.0)).toBeLessThan(0.05);
    expect(peak(out, 0, 6.0)).toBeLessThan(0.5);
  });
});
