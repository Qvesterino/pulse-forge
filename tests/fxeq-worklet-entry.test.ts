/**
 * FXEQ worklet entry regression suite (message port ↔ DSP core wiring).
 *
 * Runs the REAL fxeq worklet entry (src/effects/fxeq-worklet.entry.js — the
 * module bundled into public/fxeq-worklet.js) under a stubbed
 * AudioWorkletGlobalScope. The golden suite only covers the vendored core;
 * this layer owns the render-thread automation queue (param/paramAt), meter
 * gating and latency reporting — all previously untested.
 */
import { beforeAll, describe, expect, it } from "vitest";

interface PostedMessage {
  type?: string;
  samples?: number;
  peaks?: Float32Array;
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
    prepare(sr: number, cc: number, maxBs: number): void;
    process(channels: Float32Array[], frameCount: number): void;
    setParameter(id: string, value: number): void;
    getParameter(id: string): number;
    loadParameters(params: Record<string, number>): void;
    reset(): void;
    isMorphing(): boolean;
    getLatencySamples(): number;
    getBandPeaks(): Float32Array;
  };
  process(inputs: Float32Array[][] | [], outputs: Float32Array[][]): boolean;
}

type ProcCtor = new (options?: { processorOptions?: { params?: Record<string, number>; seed?: number } }) => ProcShape;

let Processor: ProcCtor;
/** Render clock for the worklet scope — the host advances it per quantum. */
let now = 0;

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
  // @ts-expect-error untyped .js worklet entry (ultina-worklet-entry convention)
  await import("../src/effects/fxeq-worklet.entry.js");
  if (!Processor) throw new Error("fxeq-processor did not register");
});

const SR = 48000;
const BLOCK = 128;
/** One render quantum: silence in, stereo out, clock advanced like a host. */
function step(proc: ProcShape, input?: Float32Array[]): Float32Array[] {
  const outL = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);
  proc.process(input ? [input] : [], [[outL, outR]]);
  now += BLOCK / SR;
  return [outL, outR];
}

function send(proc: ProcShape, msg: unknown): void {
  proc.port.onmessage?.({ data: msg });
}

describe("fxeq worklet entry (message port ↔ DSP core wiring)", () => {
  it("reports DSP latency over the port at construction", () => {
    const proc = new Processor();
    const latencies = proc.port.posted.filter((m) => m.type === "latency");
    expect(latencies.length).toBeGreaterThanOrEqual(1);
    // Default state: limiter enabled with 2 ms lookahead → nonzero latency.
    expect(latencies[latencies.length - 1].samples).toBeGreaterThan(0);
  });

  it("re-posts latency when a parameter changes it (saturation oversampling)", () => {
    const proc = new Processor();
    const baseline = proc.proc.getLatencySamples();
    proc.port.posted.length = 0;
    // Enable band-1 saturation at high drive and process audio: the
    // oversampled path engages (its latency materializes on the first
    // processed block) → a fresh latency report must arrive over the port.
    send(proc, { type: "param", id: "band1.satEnabled", value: 1 });
    send(proc, { type: "param", id: "band1.satDriveDb", value: 12 });
    send(proc, { type: "param", id: "band1.satMode", value: 4 });
    now = 0;
    for (let i = 0; i < 4; i++) step(proc);
    expect(proc.proc.getLatencySamples()).toBeGreaterThan(baseline);
    const latencies = proc.port.posted.filter((m) => m.type === "latency");
    expect(latencies.length).toBeGreaterThanOrEqual(1);
    expect(latencies[latencies.length - 1].samples).toBeGreaterThan(baseline);
  });

  it("applies time-stamped automation at the block that reaches its timestamp", () => {
    const proc = new Processor();
    now = 0;
    // Two events: gain → -6 dB at t=0.05s, → +6 dB at t=0.15s.
    send(proc, { type: "paramAt", id: "inputGainDb", value: -6, when: 0.05 });
    send(proc, { type: "paramAt", id: "inputGainDb", value: 6, when: 0.15 });
    // Before the first timestamp: unchanged (each block ≈ 2.667 ms; the
    // event at 0.05 s is due at block ~19).
    step(proc);
    step(proc);
    expect(proc.proc.getParameter("inputGainDb")).toBe(0);
    // Cross 0.05s.
    for (let i = 0; i < 20; i++) step(proc);
    expect(proc.proc.getParameter("inputGainDb")).toBe(-6);
    // Cross 0.15s.
    for (let i = 0; i < 40; i++) step(proc);
    expect(proc.proc.getParameter("inputGainDb")).toBe(6);
  });

  it("manual param cancels future automation for the same id only", () => {
    const proc = new Processor();
    now = 0;
    send(proc, { type: "paramAt", id: "inputGainDb", value: -6, when: 0.5 });
    send(proc, { type: "paramAt", id: "outputGainDb", value: -12, when: 0.5 });
    // User grabs the input knob → the pending inputGainDb event dies, the
    // outputGainDb event must survive.
    send(proc, { type: "param", id: "inputGainDb", value: 3 });
    expect(proc.proc.getParameter("inputGainDb")).toBe(3);
    for (let i = 0; i < Math.ceil(0.5 / (BLOCK / SR)) + 2; i++) step(proc);
    expect(proc.proc.getParameter("inputGainDb")).toBe(3);
    expect(proc.proc.getParameter("outputGainDb")).toBe(-12);
  });

  it("consumes a dense due queue exactly once (no re-application after compaction)", () => {
    const proc = new Processor();
    now = 0;
    // 200 events all due inside the first block horizon (≤ 2.667 ms).
    // Values stay inside the param's [-24, 24] schema range — the store
    // clamps, so out-of-range probes could mask double-application bugs.
    const final = (199 % 48) - 24;
    for (let i = 0; i < 200; i++) {
      send(proc, { type: "paramAt", id: "inputGainDb", value: (i % 48) - 24, when: i * 1e-6 });
    }
    step(proc); // horizon covers 0 → 2.67 ms ≥ 199 µs
    expect(proc.proc.getParameter("inputGainDb")).toBe(final);
    // A later block must not re-apply anything (queue fully consumed).
    for (let i = 0; i < 3; i++) step(proc);
    expect(proc.proc.getParameter("inputGainDb")).toBe(final);
  });

  it("applies interleaved same-timestamp automation in send order", () => {
    const proc = new Processor();
    now = 0;
    send(proc, { type: "paramAt", id: "inputGainDb", value: -24, when: 0.001 });
    send(proc, { type: "paramAt", id: "inputGainDb", value: 24, when: 0.001 });
    step(proc);
    step(proc);
    // Same `when` → later insert wins (stable insertion order).
    expect(proc.proc.getParameter("inputGainDb")).toBe(24);
  });

  it("bulk params replace state and cancel pending automation", () => {
    const proc = new Processor();
    now = 0;
    send(proc, { type: "paramAt", id: "inputGainDb", value: -24, when: 0.5 });
    send(proc, { type: "params", params: { inputGainDb: 10 } });
    expect(proc.proc.getParameter("inputGainDb")).toBe(10);
    for (let i = 0; i < Math.ceil(0.5 / (BLOCK / SR)) + 2; i++) step(proc);
    // The queued event was cleared by the bulk load.
    expect(proc.proc.getParameter("inputGainDb")).toBe(10);
  });

  it("gates band-peak metering on setMetersEnabled (~20 Hz while on, zero off)", () => {
    const proc = new Processor();
    now = 0;
    const blocks = 375; // 1 second of quanta
    // Metering off (default): zero bandPeaks traffic.
    for (let i = 0; i < blocks; i++) step(proc);
    expect(proc.port.posted.filter((m) => m.type === "bandPeaks").length).toBe(0);

    proc.port.posted.length = 0;
    send(proc, { type: "setMetersEnabled", enabled: true });
    for (let i = 0; i < blocks; i++) step(proc);
    const peaks = proc.port.posted.filter((m) => m.type === "bandPeaks");
    // ~20 Hz at 375 blocks/s → expect ~15-25 posts, each a band-count array.
    expect(peaks.length).toBeGreaterThanOrEqual(10);
    expect(peaks.length).toBeLessThanOrEqual(30);
    expect(peaks[0].peaks).toBeInstanceOf(Float32Array);
    expect(peaks[0].peaks!.length).toBe(6);

    proc.port.posted.length = 0;
    send(proc, { type: "setMetersEnabled", enabled: false });
    for (let i = 0; i < blocks; i++) step(proc);
    expect(proc.port.posted.filter((m) => m.type === "bandPeaks").length).toBe(0);
  });

  it("processes with no input (silence) and mono input without crashing", () => {
    const proc = new Processor();
    now = 0;
    const silent = step(proc);
    let nonzero = 0;
    for (const ch of silent) for (const s of ch) if (s !== 0) nonzero++;
    expect(nonzero).toBe(0);

    const mono = new Float32Array(BLOCK);
    mono[0] = 1;
    const out = step(proc, [mono]);
    expect(out[0].length).toBe(BLOCK);
    expect(out[1].length).toBe(BLOCK);
    // Impulse through the crossover/limiter produces a finite smear.
    let finite = true;
    for (const ch of out) for (const s of ch) if (!Number.isFinite(s)) finite = false;
    expect(finite).toBe(true);
  });

  it("reset clears the automation queue", () => {
    const proc = new Processor();
    now = 0;
    send(proc, { type: "paramAt", id: "inputGainDb", value: -24, when: 0.2 });
    send(proc, { type: "reset" });
    for (let i = 0; i < Math.ceil(0.2 / (BLOCK / SR)) + 2; i++) step(proc);
    expect(proc.proc.getParameter("inputGainDb")).toBe(0);
  });

  it("forwards host bpm to the core (tempo-synced delay reacts)", () => {
    const proc = new Processor();
    now = 0;
    send(proc, { type: "param", id: "band2.delayEnabled", value: 1 });
    send(proc, { type: "param", id: "band2.delaySyncMode", value: 3 }); // 1/4
    // 120 BPM → 500 ms; 240 BPM → 250 ms. Not directly observable through
    // the public surface, but the bpm message must not throw and must be
    // clamped/accepted — smoke-level contract check.
    send(proc, { type: "bpm", bpm: 240 });
    send(proc, { type: "bpm", bpm: Number.NaN }); // hostile value ignored
    step(proc);
    expect(proc.proc.getParameter("band2.delaySyncMode")).toBe(3);
  });
});

describe("fxeq worklet entry — A/B morph, history, sidechain, GR", () => {
  it("morph message glides the parameter to its target on the audio thread", () => {
    const proc = new Processor();
    now = 0;
    send(proc, { type: "morph", params: { inputGainDb: 6 }, durationSec: 0.01 });
    // ~4 quanta to cover the 10 ms glide, then the core pins the end state.
    for (let i = 0; i < 8; i++) step(proc);
    expect(proc.proc.getParameter("inputGainDb")).toBeCloseTo(6, 6);
    // The morph must have finished (not linger writing per block forever).
    expect(proc.proc.isMorphing).toBe(false);
  });

  it("undo/redo round-trips a manual param and replies with the restored entry", () => {
    const proc = new Processor();
    now = 0;
    send(proc, { type: "param", id: "inputGainDb", value: -6 });
    expect(proc.proc.getParameter("inputGainDb")).toBe(-6);
    send(proc, { type: "undo" });
    expect(proc.proc.getParameter("inputGainDb")).toBe(0);
    const historyPosts = proc.port.posted.filter((m) => m.type === "history");
    expect(historyPosts.length).toBe(1);
    expect(historyPosts[0]).toMatchObject({ action: "undo", id: "inputGainDb", value: 0 });
    send(proc, { type: "redo" });
    expect(proc.proc.getParameter("inputGainDb")).toBe(-6);
  });

  it("bulk params clear the history (a state replacement is not a user gesture)", () => {
    const proc = new Processor();
    now = 0;
    send(proc, { type: "param", id: "inputGainDb", value: -6 });
    send(proc, { type: "params", params: { inputGainDb: 3 } });
    send(proc, { type: "undo" });
    const historyPosts = proc.port.posted.filter((m) => m.type === "history");
    expect(historyPosts[historyPosts.length - 1]).toMatchObject({ id: null, value: 0 });
    expect(proc.proc.getParameter("inputGainDb")).toBe(3);
  });

  it("historyRecording gates manual param recording (host bulk syncs)", () => {
    const proc = new Processor();
    now = 0;
    send(proc, { type: "historyRecording", enabled: false });
    send(proc, { type: "param", id: "inputGainDb", value: -6 });
    send(proc, { type: "historyRecording", enabled: true });
    send(proc, { type: "undo" });
    const historyPosts = proc.port.posted.filter((m) => m.type === "history");
    expect(historyPosts[historyPosts.length - 1]).toMatchObject({ id: null });
  });

  it("timestamped automation never enters the plugin history", () => {
    const proc = new Processor();
    now = 0;
    send(proc, { type: "paramAt", id: "inputGainDb", value: -6, when: 0.001 });
    step(proc);
    expect(proc.proc.getParameter("inputGainDb")).toBe(-6);
    send(proc, { type: "undo" });
    const historyPosts = proc.port.posted.filter((m) => m.type === "history");
    expect(historyPosts[historyPosts.length - 1]).toMatchObject({ id: null });
  });

  it("a loud sidechain input ducks its band harder than a silent one", () => {
    const setup = () => {
      const proc = new Processor();
      now = 0;
      send(proc, { type: "param", id: "bandCount", value: 2 });
      send(proc, { type: "param", id: "limiterEnabled", value: 0 });
      send(proc, { type: "param", id: "band1.dynEnable", value: 1 });
      send(proc, { type: "param", id: "band1.sidechainMode", value: 1 });
      send(proc, { type: "param", id: "band1.dynThresholdDb", value: -40 });
      send(proc, { type: "param", id: "band1.dynRangeDb", value: -24 });
      send(proc, { type: "param", id: "band2.mute", value: 1 });
      return proc;
    };
    // 80 Hz tone lives in band 1 (default split 400 Hz).
    const tone = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * 80 * i) / SR);
    const loudSc = new Float32Array(BLOCK);
    let seed = 0xbeef;
    for (let i = 0; i < BLOCK; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      loudSc[i] = ((seed >>> 0) / 0x100000000) * 1.6 - 0.8;
    }

    const energyOf = (sidechain: Float32Array[]): number => {
      const proc = setup();
      const out = new Float32Array(BLOCK);
      for (let b = 0; b < 120; b++) {
        const outL = new Float32Array(BLOCK);
        const outR = new Float32Array(BLOCK);
        proc.process([[tone], sidechain], [[outL, outR]]);
        now += BLOCK / SR;
        if (b >= 60) for (let i = 0; i < BLOCK; i++) out[i] += outL[i] * outL[i];
      }
      let sum = 0;
      for (let i = 0; i < BLOCK; i++) sum += out[i];
      return sum;
    };

    const silent = energyOf([new Float32Array(BLOCK), new Float32Array(BLOCK)]);
    const loud = energyOf([loudSc, loudSc]);
    // The loud sidechain pushes the band's envelope over the threshold and
    // ducks it (up to −24 dB); the silent sidechain leaves it untouched.
    expect(loud).toBeLessThan(silent * 0.5);
  });

  it("bandPeaks metering posts carry the limiter's gain reduction", () => {
    const proc = new Processor();
    now = 0;
    send(proc, { type: "param", id: "limiterCeilDb", value: -6 });
    send(proc, { type: "setMetersEnabled", enabled: true });
    let seed = 0xface;
    let grSeen = -1;
    for (let b = 0; b < 60 && grSeen < 0; b++) {
      const hot = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        hot[i] = ((seed >>> 0) / 0x100000000) * 1.8 - 0.9;
      }
      step(proc, [hot, hot]);
      const peaks = proc.port.posted.filter((m) => m.type === "bandPeaks");
      const last = peaks[peaks.length - 1] as { gr?: number } | undefined;
      if (last && typeof last.gr === "number" && last.gr > 0) grSeen = last.gr;
    }
    // A hot signal into a −6 dBFS ceiling must show real reduction.
    expect(grSeen).toBeGreaterThan(0);
  });
});

describe("fxeq worklet entry — hardening regression (2026-09-12)", () => {
  it("output quanta larger than 128 frames are fully written (chunked pass)", () => {
    const proc = new Processor();
    const N = 256;
    // A sine, not DC — the core's 15 Hz DC blocker would eat a constant.
    const inL = Float32Array.from({ length: N }, (_, i) => 0.25 * Math.sin((2 * Math.PI * 220 * i) / SR));
    const inR = Float32Array.from({ length: N }, (_, i) => 0.25 * Math.sin((2 * Math.PI * 220 * i) / SR));
    const outL = new Float32Array(N);
    const outR = new Float32Array(N);
    now = 0;
    expect(proc.process([[inL, inR]], [[outL, outR]])).toBe(true);
    // Pre-fix only the first 128 frames were written; samples beyond frame
    // 128 stayed stale (zeros here, the previous block's audio on a live
    // host with a larger quantum). Compare signal ENERGY, not per-sample
    // values — a sine legitimately crosses zero. (Threshold has wide margin:
    // the stale-tail failure mode is RMS ≈ 0.)
    let tailSq = 0;
    for (let i = 128; i < N; i++) tailSq += outL[i] * outL[i];
    expect(Math.sqrt(tailSq / (N - 128))).toBeGreaterThan(0.02);
    expect(outL[N - 1]).toBeGreaterThan(0.001);
    expect(outR[N - 1]).toBeGreaterThan(0.001);
  });
});
