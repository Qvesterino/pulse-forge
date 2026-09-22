import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Hardening round 4 — regression pins for the worklet processor / wrapper
 * defects found by the plugin self-audit (PLUGIN_HARDENING_AUDIT.md):
 *
 *  - ducking-delay: `pingpong`/`loopHpfHz` were read in process() but never
 *    declared in parameterDescriptors (the UI knobs were silently dead), and
 *    the ping-pong crossfeed matrix has loop eigenvalue fb*1.7 — uncapped it
 *    diverges at the feedback knob max (0.9 → 1.53).
 *  - autowah: the Chamberlin SVF diverged when f*q >= (4-f²)/2 (high cutoff +
 *    LOW resonance); the ±8 clamps masked it as a harsh limit cycle.
 *  - beatmangler: volume/pitch lanes of different lengths read undefined →
 *    NaN speed/readPos → permanent NaN audio.
 *  - wtvoice: `param` messages could overwrite the function-valued pickLevel
 *    / bookkeeping tableFrames (render-thread TypeError) and NaN note events
 *    wedged the sorted event queue forever.
 *  - granular-voice: uploads advance grains rate-corrected (a 44.1 kHz buffer
 *    in a 48 kHz session played ~+8.8 % sharp); malformed note events are
 *    dropped at the boundary.
 *  - bitcrusher: one shared counter/heldValue across sequential channel loops
 *    offset ch1's hold grid by blockLen % ds (L/R smear) and let a zero-length
 *    channel latch NaN.
 *  - flanger/comb: ring buffers sized from the runtime sample rate (fixed
 *    sizes silently shortened sweeps above ~68 kHz / ~101 kHz).
 *  - granularfreeze: grainStart holds absolute session positions — Float32
 *    quantized them past 2^24 samples (~6 min).
 *
 * Processors run as REAL code under a stubbed AudioWorkletGlobalScope (same
 * host pattern as tests/aliasing-truepeak.test.ts).
 */

class FakePort {
  messages: unknown[] = [];
  onmessage: ((e: unknown) => void) | null = null;
  postMessage(msg: unknown) {
    this.messages.push(msg);
  }
}
class FakeAudioWorkletProcessor {
  port = new FakePort();
}

const registered = new Map<string, new () => any>();

function setSR(sr: number) {
  (globalThis as unknown as { sampleRate: number }).sampleRate = sr;
}
function setClock(t: number) {
  (globalThis as unknown as { currentTime: number }).currentTime = t;
}

beforeAll(async () => {
  setSR(48000);
  setClock(0);
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (name: string, cls: new () => any) => {
    registered.set(name, cls);
  };
  // Load via the file system (the granular-freeze harness pattern) — most of
  // these processors ship no .d.ts, so static imports would fail strict tsc.
  const load = (name: string) => {
    const source = readFileSync(resolve("src/audio-worklets", name), "utf8");
    const host = new Function("registerProcessor", "AudioWorkletProcessor", "globalThis", source);
    host(
      (n: string, cls: new () => any) => registered.set(n, cls),
      FakeAudioWorkletProcessor,
      globalThis,
    );
  };
  for (const name of [
    "ducking-delay-processor.js",
    "autowah-processor.js",
    "beatmangler-processor.js",
    "wtvoice-processor.js",
    "granular-voice-processor.js",
    "bitcrusher-processor.js",
    "flanger-processor.js",
    "comb-processor.js",
    "granularfreeze-processor.js",
  ]) {
    load(name);
    expect(registered.get(name.replace(".js", "")), name).toBeDefined();
  }
});

const BLOCK = 128;
const SR = 48000;

function params(names: string[], values: Record<string, number>): Record<string, Float32Array> {
  const out: Record<string, Float32Array> = {};
  for (const n of names) out[n] = Float32Array.of(values[n] ?? 0);
  return out;
}

function stereoIn(len: number, fill: (i: number) => [number, number]): Float32Array[][] {
  const l = new Float32Array(len);
  const r = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const [a, b] = fill(i);
    l[i] = a;
    r[i] = b;
  }
  return [[l, r]];
}

function peakAbs(data: Float32Array): number {
  let p = 0;
  for (let i = 0; i < data.length; i++) p = Math.max(p, Math.abs(data[i]));
  return p;
}

function allFinite(data: Float32Array): boolean {
  for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i])) return false;
  return true;
}

/** Render `seconds` of mono noise through a (inputs, outputs, params) processor. */
function soakNoise(
  proc: { process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean },
  seconds: number,
  prm: Record<string, Float32Array>,
): { L: Float32Array; R: Float32Array } {
  const blocks = Math.ceil((seconds * SR) / BLOCK);
  const L = new Float32Array(blocks * BLOCK);
  const R = new Float32Array(blocks * BLOCK);
  let state = 222;
  for (let b = 0; b < blocks; b++) {
    const input = stereoIn(BLOCK, () => {
      state = (1103515245 * state + 12345) & 0x7fffffff;
      const v = 0.9 * (state / 0x3fffffff - 1);
      return [v, v];
    });
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    proc.process(input, [[outL, outR]], prm);
    L.set(outL, b * BLOCK);
    R.set(outR, b * BLOCK);
  }
  return { L, R };
}

describe("ducking-delay — declared params + ping-pong loop stability", () => {
  it("parameterDescriptors declares pingpong + loopHpfHz (the wrapper writes them; undeclared params never reach process)", () => {
    const descriptors = (registered.get("ducking-delay-processor") as any).parameterDescriptors as { name: string }[];
    const names = descriptors.map((d) => d.name);
    expect(names).toContain("pingpong");
    expect(names).toContain("loopHpfHz");
  });

  it("pingpong at feedback max stays finite and bounded (loop eigenvalue capped below unity)", () => {
    const proc = new (registered.get("ducking-delay-processor")!)();
    const prm = params(
      [
        "time",
        "feedback",
        "tone",
        "duckAmount",
        "duckThresh",
        "duckAttack",
        "duckRelease",
        "mix",
        "pingpong",
        "loopHpfHz",
      ],
      {
        time: 100,
        feedback: 0.9,
        tone: 8000,
        duckAmount: 0,
        duckThresh: -60,
        duckAttack: 0.005,
        duckRelease: 0.1,
        mix: 1,
        pingpong: 1,
        loopHpfHz: 20,
      },
    );
    const { L, R } = soakNoise(proc as any, 4, prm);
    expect(allFinite(L)).toBe(true);
    expect(allFinite(R)).toBe(true);
    // Steady-state build on hot noise at loop eigenvalue 0.9 peaks ≈ 2;
    // the pre-fix uncapped matrix (eigenvalue 1.53) diverges to NaN well
    // inside the 4 s soak — allFinite is the divergence discriminator.
    expect(peakAbs(L)).toBeLessThan(3);
    expect(peakAbs(R)).toBeLessThan(3);
  });

  it("plain mode at feedback max still sustains a long finite tail (regression pin)", () => {
    const proc = new (registered.get("ducking-delay-processor")!)();
    const prm = params(
      [
        "time",
        "feedback",
        "tone",
        "duckAmount",
        "duckThresh",
        "duckAttack",
        "duckRelease",
        "mix",
        "pingpong",
        "loopHpfHz",
      ],
      {
        time: 100,
        feedback: 0.9,
        tone: 8000,
        duckAmount: 0,
        duckThresh: -60,
        duckAttack: 0.005,
        duckRelease: 0.1,
        mix: 1,
        pingpong: 0,
        loopHpfHz: 20,
      },
    );
    // Single impulse in, then silence: the echo train decays by fb per
    // repeat (100 ms → 10 repeats/s; at 1.2 s ≈ 12 repeats, 0.9^12 ≈ 0.28).
    const blocks = Math.ceil((1.5 * SR) / BLOCK);
    const L = new Float32Array(blocks * BLOCK);
    for (let b = 0; b < blocks; b++) {
      const inL = new Float32Array(BLOCK);
      const inR = new Float32Array(BLOCK);
      if (b === 0) {
        inL[0] = 1;
        inR[0] = 1;
      }
      const outL = new Float32Array(BLOCK);
      const outR = new Float32Array(BLOCK);
      (proc as any).process([[inL, inR]], [[outL, outR]], prm);
      L.set(outL, b * BLOCK);
    }
    expect(allFinite(L)).toBe(true);
    const late = L.slice(Math.floor(SR * 1.2));
    expect(peakAbs(late)).toBeGreaterThan(0.01);
    expect(peakAbs(late)).toBeLessThan(0.9);
  });

  it("ring is sized from the runtime sample rate (1000 ms max delay must fit at 192 kHz)", () => {
    setSR(192000);
    try {
      const proc = new (registered.get("ducking-delay-processor")!)() as any;
      expect(proc.bufSize).toBeGreaterThanOrEqual(192000 * 1.05);
    } finally {
      setSR(SR);
    }
  });
});

describe("autowah — Chamberlin SVF stability at the max-damping corner", () => {
  it("resonance 0 + hot signal sweeps to maxFreq without the ±8 limit cycle", () => {
    const proc = new (registered.get("autowah-processor")!)();
    const prm = params(
      ["minFreq", "maxFreq", "resonance", "attack", "release", "sensitivity", "mode", "direction", "drive", "mix"],
      {
        minFreq: 300,
        maxFreq: 8000,
        resonance: 0,
        attack: 0.001,
        release: 0.15,
        sensitivity: 3,
        mode: 0,
        direction: 0,
        drive: 0,
        mix: 1,
      },
    );
    const blocks = Math.ceil(SR / BLOCK);
    const L = new Float32Array(blocks * BLOCK);
    let phase = 0;
    for (let b = 0; b < blocks; b++) {
      const input = stereoIn(BLOCK, () => {
        phase += (2 * Math.PI * 100) / SR;
        const v = 0.9 * Math.sin(phase);
        return [v, v];
      });
      const outL = new Float32Array(BLOCK);
      const outR = new Float32Array(BLOCK);
      (proc as any).process(input, [[outL, outR]], prm);
      L.set(outL, b * BLOCK);
    }
    expect(allFinite(L)).toBe(true);
    // Pre-fix the divergent state hit the ±8 clamps and buzzed at ~8; the
    // damped-safe filter peaks well below that on the same input.
    expect(peakAbs(L)).toBeLessThan(6);
    expect(peakAbs(L)).toBeGreaterThan(0.01);
  });
});

describe("beatmangler — mismatched step lanes are padded at the boundary", () => {
  it("a short pitch lane is hold-last padded to the volume lane length (no undefined → NaN)", () => {
    const proc = new (registered.get("beatmangler-processor")!)() as any;
    proc.port.onmessage?.({
      data: {
        type: "steps",
        volume: [1, 0.8, 0.6, 0.4, 1, 0.8, 0.6, 0.4, 1, 0.8, 0.6, 0.4, 1, 0.8, 0.6, 0.4],
        pitch: [12, -12, 12, -12, 12, -12, 12, -12],
      },
    });
    expect(proc.stepsPerBar).toBe(16);
    expect(proc.pitchSteps).toHaveLength(16);
    expect(proc.pitchSteps[15]).toBe(proc.pitchSteps[7]);
    expect(proc.pitchSteps[15]).toBe(-12);
    // And rendering the mangled buffer stays finite.
    const prm = params(["mix", "trigger", "interval", "offset", "chance", "gate"], {
      mix: 1,
      trigger: 0,
      interval: 0,
      chance: 1,
      gate: 2,
    });
    const { L, R } = soakNoise(proc, 2, prm);
    expect(allFinite(L)).toBe(true);
    expect(allFinite(R)).toBe(true);
  });
});

describe("wtvoice — param allowlist + note event validation", () => {
  function makeVoiced(): any {
    const proc = new (registered.get("wtvoice-processor")!)();
    const frames = Array.from({ length: 8 }, (_, f) =>
      Float32Array.from({ length: 64 }, (_, i) => Math.sin((i / 64) * 2 * Math.PI * (f + 1))),
    );
    proc.port.onmessage?.({ data: { type: "tables", levels: [frames], ks: [1, 2] } });
    return proc;
  }

  it("a `param` message cannot overwrite pickLevel — the next noteOn must not throw on the render thread", () => {
    const proc = makeVoiced();
    proc.port.onmessage?.({ data: { type: "param", name: "pickLevel", value: 1 } });
    setClock(5);
    proc.port.onmessage?.({ data: { type: "noteOn", pitch: 60, velocity: 0.8, when: 5 } });
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    expect(() => (proc as any).process([[]], [[outL, outR]])).not.toThrow();
    expect(peakAbs(outL)).toBeGreaterThan(0.001);
  });

  it("tableFrames and non-finite param values are rejected", () => {
    const proc = makeVoiced();
    proc.port.onmessage?.({ data: { type: "param", name: "tableFrames", value: 999999 } });
    proc.port.onmessage?.({ data: { type: "param", name: "cutoff", value: NaN } });
    expect(proc.params.tableFrames).toBe(8);
    expect(proc.params.cutoff).toBe(12000);
  });

  it("a NaN `when` note is dropped instead of wedging the queue — the next valid note still sounds", () => {
    const proc = makeVoiced();
    setClock(5);
    proc.port.onmessage?.({ data: { type: "noteOn", pitch: 60, velocity: 0.8, when: NaN } });
    proc.port.onmessage?.({ data: { type: "noteOn", pitch: 64, velocity: 0.8, when: 5 } });
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    (proc as any).process([[]], [[outL, outR]]);
    expect(peakAbs(outL)).toBeGreaterThan(0.001);
    expect(allFinite(outL)).toBe(true);
  });
});

describe("granular-voice — rate-corrected playback + boundary event validation", () => {
  function makeProc(): any {
    return new (registered.get("granular-voice-processor")!)();
  }

  it("a 44.1 kHz buffer plays at true pitch in the 48 kHz session (was ~+8.8% sharp)", () => {
    const proc = makeProc();
    const bufRate = 44100;
    const len = Math.floor(bufRate * 0.5);
    const ch0 = new Float32Array(len);
    for (let i = 0; i < len; i++) ch0[i] = 0.8 * Math.sin((2 * Math.PI * 440 * i) / bufRate);
    proc.port.onmessage?.({ data: { type: "sample", ch0, ch1: null, sampleRate: bufRate } });
    setClock(1);
    proc.port.onmessage?.({ data: { type: "noteOn", pitch: 60, velocity: 0.9, when: 1, seed: 12345 } });
    const blocks = Math.ceil((SR * 0.5) / BLOCK);
    const L = new Float32Array(blocks * BLOCK);
    for (let b = 0; b < blocks; b++) {
      setClock(1 + (b * BLOCK) / SR);
      const outL = new Float32Array(BLOCK);
      const outR = new Float32Array(BLOCK);
      proc.process([[]], [[outL, outR]]);
      L.set(outL, b * BLOCK);
    }
    expect(peakAbs(L)).toBeGreaterThan(0.05);
    let crossings = 0;
    for (let i = 1; i < L.length; i++) if (L[i - 1] <= 0 && L[i] > 0) crossings++;
    const hz = crossings / 0.5;
    expect(hz).toBeGreaterThan(410);
    expect(hz).toBeLessThan(465);
  });

  it("malformed note events (NaN when/pitch) are dropped at the boundary", () => {
    const proc = makeProc();
    proc.port.onmessage?.({ data: { type: "noteOn", pitch: NaN, velocity: 0.8, when: 1 } });
    proc.port.onmessage?.({ data: { type: "noteOn", pitch: 60, velocity: 0.8, when: NaN } });
    proc.port.onmessage?.({ data: { type: "noteOff", pitch: 60, when: undefined } });
    expect(proc.events).toHaveLength(0);
  });
});

describe("bitcrusher — per-channel hold phase + NaN latch guard", () => {
  it("L and R hold on the SAME samples for non-power-of-2 downsample (was offset by blockLen % ds)", () => {
    const proc = new (registered.get("bitcrusher-processor")!)();
    const prm = params(["bits", "downsample"], { bits: 16, downsample: 7 });
    const blocks = 4;
    const L = new Float32Array(blocks * BLOCK);
    const R = new Float32Array(blocks * BLOCK);
    for (let b = 0; b < blocks; b++) {
      const n = b * BLOCK;
      const input = stereoIn(BLOCK, (i) => [((n + i) % 16) / 16, ((n + i) % 16) / 16]);
      const outL = new Float32Array(BLOCK);
      const outR = new Float32Array(BLOCK);
      (proc as any).process(input, [[outL, outR]], prm);
      L.set(outL, b * BLOCK);
      R.set(outR, b * BLOCK);
    }
    let maxDiff = 0;
    for (let i = 0; i < L.length; i++) maxDiff = Math.max(maxDiff, Math.abs(L[i] - R[i]));
    expect(maxDiff).toBe(0);
  });

  it("a zero-length channel cannot latch NaN into the hold state", () => {
    const proc = new (registered.get("bitcrusher-processor")!)();
    const prm = params(["bits", "downsample"], { bits: 8, downsample: 4 });
    const inL = Float32Array.from({ length: BLOCK }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR));
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    (proc as any).process([[inL, new Float32Array(0)]], [[outL, outR]], prm);
    expect(allFinite(outL)).toBe(true);
    expect(allFinite(outR)).toBe(true);
  });

  it("a missing channel (mono input, stereo output) mirrors ch0 instead of going stale", () => {
    const proc = new (registered.get("bitcrusher-processor")!)();
    const prm = params(["bits", "downsample"], { bits: 8, downsample: 4 });
    const inL = Float32Array.from({ length: BLOCK }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR));
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    (proc as any).process([[inL]], [[outL, outR]], prm);
    expect(allFinite(outR)).toBe(true);
    let maxDiff = 0;
    for (let i = 0; i < BLOCK; i++) maxDiff = Math.max(maxDiff, Math.abs(outL[i] - outR[i]));
    expect(maxDiff).toBe(0);
  });
});

describe("ring buffers sized from the runtime sample rate", () => {
  it("flanger at 96 kHz keeps the full 30 ms sweep (4096 ring)", () => {
    setSR(96000);
    try {
      const proc = new (registered.get("flanger-processor")!)() as any;
      expect(proc.divisor).toBe(4096);
    } finally {
      setSR(SR);
    }
  });

  it("flanger at 48 kHz keeps the legacy 2048 ring (no sonic change at common rates)", () => {
    const proc = new (registered.get("flanger-processor")!)() as any;
    expect(proc.divisor).toBe(2048);
  });

  it("comb at 192 kHz sizes for 60 ms × 1.35 spread (16384 ring; 8192 still covers 81 ms up to ~101 kHz)", () => {
    setSR(96000);
    const at96 = new (registered.get("comb-processor")!)() as any;
    expect(at96.size).toBe(8192);
    setSR(192000);
    try {
      const proc = new (registered.get("comb-processor")!)() as any;
      expect(proc.size).toBe(16384);
    } finally {
      setSR(SR);
    }
  });

  it("granularfreeze grain positions are float64 (absolute session positions outgrow Float32)", () => {
    const proc = new (registered.get("granularfreeze-processor")!)() as any;
    expect(proc.grainStart).toBeInstanceOf(Float64Array);
  });
});

describe("node wrappers — guard pins (source contract)", () => {
  const src = (p: string) => readFileSync(resolve(p), "utf8");

  it("ducking-delay node intercepts the UI-only `sync` param and re-pushes the derived time", () => {
    const s = src("src/audio-worklets/ducking-delay-node.ts");
    expect(s).toContain('id === "sync"');
    expect(s).toContain("delayMsFromSync(v)");
  });

  it("limiter node stores only finite lookahead and reports a finite latency", () => {
    const s = src("src/audio-worklets/limiter-node.ts");
    expect(s).toContain("if (Number.isFinite(value)) lookaheadMs = value;");
    expect(s).toContain("Number.isFinite(lookaheadMs)");
  });

  it("bitcrusher + chorus nodes guard their native (non-worklet) param writes", () => {
    expect(src("src/audio-worklets/bitcrusher-node.ts")).toContain("Number.isFinite(v)");
    expect(src("src/audio-worklets/chorus-node.ts")).toContain("Number.isFinite(v)");
  });
});
