import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs the RAW wtvoice-processor.js (the exact script served to
 * AudioWorklet.addModule) inside Node: `currentTime` comes from a getter on
 * globalThis, the processor gets a mock message port, and audio runs through
 * 128-sample blocks like the real render loop.
 */
type Proc = {
  process(inputs: unknown, outputs: Float32Array[][]): boolean;
  handleMessage: (msg: Record<string, unknown>) => void;
};

let Processor: new () => Proc;
let now = 0;
const SR = 44100;
const BLOCK = 128;

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
  Object.defineProperty(globalThis, "currentTime", {
    get: () => now,
    configurable: true,
  });
  const file = join(dirname(fileURLToPath(import.meta.url)), "../src/audio-worklets/wtvoice-processor.js");
  const src = readFileSync(file, "utf8");
  let registered: (new () => Proc) | null = null;
  const registerProcessor = (_name: string, cls: new () => Proc) => {
    registered = cls;
  };
  class AudioWorkletProcessor {
    port = { onmessage: null as unknown, postMessage: (_m: unknown) => {} };
  }
  new Function("registerProcessor", "AudioWorkletProcessor", src)(
    registerProcessor,
    AudioWorkletProcessor as unknown as object,
  );
  if (!registered) throw new Error("wtvoice-processor did not register");
  Processor = registered;
});

/** Sine Grow-style test table: 4 frames, harmonics 1..8, one mip level. */
function makeTables(): { levels: Float32Array[][]; ks: number[] } {
  const frameCount = 4;
  const frames: Float32Array[] = [];
  for (let k = 0; k < frameCount; k++) {
    const harmonics = 2 + k * 3; // 2, 5, 8, 11
    const frame = new Float32Array(1024);
    for (let i = 0; i < frame.length; i++) {
      let v = 0;
      for (let h = 1; h <= harmonics; h++) v += Math.sin((2 * Math.PI * h * i) / frame.length) / h;
      frame[i] = v * 0.4;
    }
    frames.push(frame);
  }
  // one mip level that strips everything above the fundamental
  const pure: Float32Array[] = frames.map((f) => {
    const out = new Float32Array(f.length);
    for (let i = 0; i < f.length; i++) out[i] = 0.6 * Math.sin((2 * Math.PI * i) / f.length);
    return out;
  });
  return { levels: [frames, pure], ks: [11, 1] };
}

function run(
  params: Record<string, number>,
  notes: Array<{ pitch: number; velocity: number; when: number; dur: number }>,
  duration: number,
  pressure?: { pitch: number; value: number; at: number },
): Float32Array {
  const proc = new Processor();
  const tables = makeTables();
  // Reset the shared clock BEFORE dispatching — `when` values are clamped to
  // currentTime at handle time, so a stale clock would push events away.
  now = 0;
  proc.handleMessage({ type: "tables", levels: tables.levels, ks: tables.ks });
  for (const [name, value] of Object.entries(params)) {
    proc.handleMessage({ type: "param", name, value });
  }
  for (const n of notes) {
    proc.handleMessage({ type: "noteOn", pitch: n.pitch, velocity: n.velocity, when: n.when });
    proc.handleMessage({ type: "noteOff", pitch: n.pitch, when: n.when + n.dur });
  }
  // Pressure is aftertouch — dispatch it mid-render when the voice exists
  const deferredPressure = pressure ? { ...pressure, done: false } : null;
  console.log("DBG run:", JSON.stringify(params), "notes:", notes.length, "nowAfter:", now.toFixed(3));

  const total = Math.ceil(duration * SR);
  const out = new Float32Array(total);
  const outR = new Float32Array(total);
  for (let start = 0; start < total; start += BLOCK) {
    const size = Math.min(BLOCK, total - start);
    const outL = new Float32Array(size);
    const blockR = new Float32Array(size);
    if (deferredPressure && !deferredPressure.done && now >= deferredPressure.at) {
      deferredPressure.done = true;
      proc.handleMessage({ type: "pressure", pitch: deferredPressure.pitch, value: deferredPressure.value });
    }
    proc.process([], [[outL, blockR]]);
    out.set(outL, start);
    outR.set(blockR, start);
    now = (start + BLOCK) / SR;
  }
  void outR;
  return out;
}

function peak(data: Float32Array, from = 0, to = data.length): number {
  let v = 0;
  for (let i = from; i < to; i++) v = Math.max(v, Math.abs(data[i]));
  return v;
}

function goertzel(data: Float32Array, freq: number, sampleRate = SR): number {
  const n = data.length;
  const k = Math.round((freq * n) / sampleRate);
  const w = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = data[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

function rms(data: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / Math.max(1, to - from));
}

/** High-frequency energy proxy: RMS of the first difference. */
function hfRms(data: Float32Array, from: number, to: number): number {
  let sum = 0;
  let count = 0;
  for (let i = from + 1; i < to; i++) {
    const d = data[i] - data[i - 1];
    sum += d * d;
    count++;
  }
  return Math.sqrt(sum / Math.max(1, count));
}

describe("wtvoice worklet engine", () => {
  it("renders a bounded, deterministic, sample-accurate voice", () => {
    const notes = [{ pitch: 60, velocity: 0.9, when: 0.05, dur: 0.5 }];
    const a = run({}, notes, 1.2);
    const b = run({}, notes, 1.2);
    expect(peak(a)).toBeGreaterThan(0.01);
    expect(peak(a)).toBeLessThanOrEqual(8);
    // sample-accurate start: nothing before `when` minus one block of slack
    expect(peak(a, 0, Math.floor(0.044 * SR))).toBeLessThan(1e-6);
    let maxDiff = 0;
    for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
    expect(maxDiff).toBeLessThan(1e-9);
  });

  it("releases and dies after noteOff", () => {
    const out = run({}, [{ pitch: 60, velocity: 0.9, when: 0.05, dur: 0.25 }], 1.5);
    console.log("DBG peak whole:", peak(out).toFixed(4), "peak 0-0.3s:", peak(out, 0, Math.floor(0.3 * SR)).toFixed(4));
    expect(peak(out, 0, Math.floor(0.3 * SR))).toBeGreaterThan(0.01);
    expect(peak(out, Math.floor(1.0 * SR))).toBeLessThan(0.001);
  });

  it("mod matrix: LFO -> cutoff actually modulates the filter", () => {
    const notes = [{ pitch: 60, velocity: 0.9, when: 0.05, dur: 0.9 }];
    const base = run({ cutoff: 1500, resonance: 0.6, modASrc: 1, modADst: 1, modAAmt: 0 }, notes, 1.0);
    const modded = run({ cutoff: 1500, resonance: 0.6, modASrc: 1, modADst: 1, modAAmt: 1 }, notes, 1.0);
    expect(rms(base, 0, base.length)).toBeGreaterThan(0.01);
    // the sweep opens the cutoff from 1500 to 4500: harmonic 8 (2093 Hz)
    // sits well above the static cutoff and only enters during the open
    // phase — its energy must clearly rise with the route active
    const h8Base = goertzel(base, 2093);
    const h8Mod = goertzel(modded, 2093);
    expect(h8Mod).toBeGreaterThan(h8Base * 1.5);
  });

  it("mod matrix: env -> morph sweeps the timbre over the note", () => {
    const notes = [{ pitch: 48, velocity: 0.9, when: 0.05, dur: 0.8 }];
    const flat = run({ morph: 0.5, modASrc: 0, modADst: 0, modAAmt: 0 }, notes, 0.9);
    const swept = run({ morph: 0.5, modASrc: 0, modADst: 0, modAAmt: 1 }, notes, 0.9);
    // early window (env ~1 -> morph pushed up) vs late window (env decayed -> morph back)
    const earlySweepHf = hfRms(swept, Math.floor(0.1 * SR), Math.floor(0.3 * SR));
    const earlyFlatHf = hfRms(flat, Math.floor(0.1 * SR), Math.floor(0.3 * SR));
    // env ~1 pushes morph up two pair units: brighter than the static morph
    expect(earlySweepHf).toBeGreaterThan(earlyFlatHf * 1.15);
  });

  it("per-voice isolation: pressure on one note leaves the other untouched", () => {
    const notes = [
      { pitch: 60, velocity: 0.9, when: 0.05, dur: 0.6 },
      { pitch: 72, velocity: 0.9, when: 0.05, dur: 0.6 },
    ];
    const without = run({ cutoff: 800, modASrc: 3, modADst: 1, modAAmt: 1 }, notes, 0.8);
    const withPressure = run({ cutoff: 800, modASrc: 3, modADst: 1, modAAmt: 1 }, notes, 0.8, {
      pitch: 60,
      value: 1,
      at: 0.1,
    });
    // Pressure on note 60 opens ITS filter (800 -> ~2400): the mix must change
    let diff = 0;
    for (let i = 0; i < without.length; i += 7) diff += Math.abs(without[i] - withPressure[i]);
    expect(diff).toBeGreaterThan(0.01);
    expect(peak(withPressure)).toBeLessThanOrEqual(8);
  });

  it("scan engine: position truly traverses the table", () => {
    const notes = [{ pitch: 48, velocity: 0.9, when: 0.05, dur: 1.8 }];
    const out = run({ morph: 0, scanRate: 0.8 }, notes, 2.0);
    const hf = (from: number, to: number) => hfRms(out, Math.floor(from * SR), Math.floor(to * SR));
    const early = hf(0.1, 0.4);
    const mid = hf(0.9, 1.2);
    const late = hf(1.5, 1.8);
    // traversing 4 frames of increasing richness modulates the HF energy twice
    expect(Math.abs(mid - early)).toBeGreaterThan(early * 0.15);
    expect(Math.abs(late - mid)).toBeGreaterThan(0.005);
  });

  it("panic silences everything instantly", () => {
    const proc = new Processor();
    proc.handleMessage({ type: "tables", levels: makeTables().levels, ks: makeTables().ks });
    proc.handleMessage({ type: "noteOn", pitch: 60, velocity: 0.9, when: 0 });
    now = 0.01;
    proc.handleMessage({ type: "panic" });
    const out = new Float32Array(BLOCK);
    proc.process([], [[out]]);
    expect(peak(out)).toBeLessThan(1e-9);
  });
});
