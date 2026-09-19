import { beforeAll, describe, expect, it } from "vitest";
import { globalPeerRegistry } from "../src/effects/ozvena-core/v2/vocalForgeIpc.js";

/**
 * Runs the REAL Ozvena worklet entry (src/effects/ozvena-worklet.entry.js —
 * the module bundled into public/ozvena-worklet.js) under a stubbed
 * AudioWorkletGlobalScope. This is the layer between the main-thread node
 * and the vendored DSP core; the golden suite only covers the core, which
 * is why an entry-level regression (live param updates being silently
 * dropped) could hide for so long.
 */

interface PostedMessage {
  type?: string;
  samples?: number;
  irId?: string;
  sampleRate?: number;
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
  /** The vendored core processor (public class field). */
  proc: {
    getSpectrumAnalyzer(): { enabled: boolean };
    isIrLoaded(): boolean;
    getIrChannels(): number;
    loadUserIr(samples: Float32Array, channels: 1 | 2 | 4): void;
    loadPrecomputedIr(sets: unknown[], channels: 1 | 2 | 4): void;
    clearUserIr(): void;
  };
  state: {
    engines: { e2: { algo: string }; e3: { algo: string } };
    mod: { mode: string };
    convolution?: { irId: string | null };
    [key: string]: unknown;
  };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

type ProcCtor = new (options?: {
  // Values travel through the entry's setPath, which accepts string state
  // paths (e.g. an initial "convolution.irId") as well as numbers.
  processorOptions?: { params?: Record<string, number | string>; bpm?: number };
}) => ProcShape;

let Processor: ProcCtor;
/** Render clock for the worklet scope — the host advances it per quantum. */
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

/** Feed a single impulse at t=0 then silence; return the accumulated output.
 *  Advances the worklet render clock one quantum per block, like a host. */
function renderImpulse(proc: ProcShape, seconds: number): Float32Array[] {
  setTime(0); // each render starts a fresh clock (tests share module state)
  const frames = Math.round(seconds * SR);
  const blocks = Math.ceil(frames / BLOCK);
  const outL = new Float32Array(blocks * BLOCK);
  const outR = new Float32Array(blocks * BLOCK);
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
    setTime(b * BLOCK * (1 / SR) + BLOCK / SR);
  }
  return [outL, outR];
}

function energy(chans: Float32Array[], fromSec: number, toSec: number): number {
  const from = Math.floor(fromSec * SR);
  const to = Math.min(chans[0].length, Math.floor(toSec * SR));
  let sum = 0;
  for (const ch of chans) for (let i = from; i < to; i++) sum += ch[i] * ch[i];
  return sum;
}

function sendParam(proc: ProcShape, id: string, value: number | string): void {
  proc.port.onmessage?.({ data: { type: "param", id, value } });
}

describe("Ozvena worklet entry (message port ↔ DSP core wiring)", () => {
  it("reports DSP latency over the port at construction", () => {
    const proc = new Processor();
    const latencies = proc.port.posted.filter((m) => m.type === "latency");
    expect(latencies.length).toBeGreaterThanOrEqual(1);
    expect(latencies[0].samples).toBeGreaterThan(0);
  });

  it("this host consumes no analyzer taps — the entry disables them", () => {
    const proc = new Processor();
    expect(proc.proc.getSpectrumAnalyzer().enabled).toBe(false);
  });

  it("regression: post-construction param updates reach the DSP core", () => {
    // The vendored core detects state changes by section REFERENCE. The
    // entry used to mutate the state in place, so loadState(sameRef) was a
    // silent no-op — a live preDelay change (and with it most of the
    // Reverb Assistant patch) never reached the audio.
    const control = new Processor();
    const controlOut = renderImpulse(control, 0.5);
    // Default 20 ms pre-delay: the reverb tail is clearly audible before 0.4 s.
    const controlEnergy = energy(controlOut, 0, 0.4);
    expect(controlEnergy).toBeGreaterThan(1e-8);

    const proc = new Processor();
    sendParam(proc, "preDelay.ms", 450); // ← the regression path
    const out = renderImpulse(proc, 0.5);
    // 450 ms pre-delay, dryWet 100 (pure wet): the impulse cannot reach the
    // engines before 0.45 s, so the first 0.4 s must be silent.
    expect(energy(out, 0, 0.4)).toBeLessThan(1e-12);
  });

  it("initial params via processorOptions reach the DSP core", () => {
    const proc = new Processor({ processorOptions: { params: { "preDelay.ms": 450 } } });
    const out = renderImpulse(proc, 0.5);
    expect(energy(out, 0, 0.4)).toBeLessThan(1e-12);
  });

  it("maps numeric enum indices per full path (E2 vs E3 vs mod.mode)", () => {
    const proc = new Processor();
    sendParam(proc, "engines.e2.algo", 2);
    expect(proc.state.engines.e2.algo).toBe("plate");
    sendParam(proc, "engines.e3.algo", 1);
    // Must stay inside E3's own enum — an E2 index here used to produce an
    // invalid algo that throws inside the hall engine's recompute().
    expect(proc.state.engines.e3.algo).toBe("hall");
    sendParam(proc, "mod.mode", 1);
    expect(proc.state.mod.mode).toBe("pitch");
    // Out-of-range indices clamp to the last entry.
    sendParam(proc, "engines.e2.algo", 99);
    expect(proc.state.engines.e2.algo).toBe("plate");
  });

  it("unknown params do not throw and do not corrupt the state root", () => {
    const proc = new Processor();
    expect(() => sendParam(proc, "no.such.path", 1)).not.toThrow();
    expect(() => sendParam(proc, "engines.e2.nope", 1)).not.toThrow();
    // Audio still runs after the bogus messages.
    const out = renderImpulse(proc, 0.2);
    expect(energy(out, 0, 0.2)).toBeGreaterThan(0);
  });

  it("dispose releases the module-global IPC peer and stops processing", () => {
    const peersBefore = globalPeerRegistry.getPeers().length;
    const proc = new Processor();
    // The entry's IPC module must be the SAME instance this test imports —
    // otherwise the peer-count assertions below are vacuous.
    expect(globalPeerRegistry.getPeers().length).toBe(peersBefore + 1);

    proc.port.onmessage?.({ data: { type: "dispose" } });
    expect(globalPeerRegistry.getPeers().length).toBe(peersBefore);

    // Processors must not keep producing (or crash) after teardown.
    const out = new Float32Array(BLOCK);
    expect(proc.process([[new Float32Array(BLOCK), new Float32Array(BLOCK)]], [[out, out]])).toBe(false);
    // Messages after dispose are ignored without throwing.
    expect(() => sendParam(proc, "preDelay.ms", 100)).not.toThrow();
  });

  it("reset restores the default state", () => {
    const proc = new Processor();
    sendParam(proc, "engines.e2.algo", 2);
    proc.port.onmessage?.({ data: { type: "reset" } });
    expect(proc.state.engines.e2.algo).toBe("room");
  });

  // ── Bug regression: tempo-synced pre-delay must follow project BPM ──
  // The core's setBpm() was unreachable from the message port, so a synced
  // pre-delay always computed at the hardcoded init 120 BPM.
  it("regression: bpm message retimes the tempo-synced pre-delay", () => {
    // "1/4" = 1 beat: 0.5 s at 120 BPM, 0.25 s at 240 BPM.
    const at120 = new Processor();
    sendParam(at120, "preDelay.syncEnabled", 1);
    const out120 = renderImpulse(at120, 1.0);
    expect(energy(out120, 0, 0.35)).toBeLessThan(1e-12);
    expect(energy(out120, 0.55, 0.95)).toBeGreaterThan(1e-9);

    const at240 = new Processor();
    sendParam(at240, "preDelay.syncEnabled", 1);
    at240.port.onmessage?.({ data: { type: "bpm", bpm: 240 } });
    const out240 = renderImpulse(at240, 1.0);
    expect(energy(out240, 0, 0.2)).toBeLessThan(1e-12);
    expect(energy(out240, 0.26, 0.45)).toBeGreaterThan(1e-9);
  });

  it("regression: initial bpm rides processorOptions", () => {
    const proc = new Processor({
      processorOptions: { params: { "preDelay.syncEnabled": 1 }, bpm: 240 },
    });
    const out = renderImpulse(proc, 1.0);
    expect(energy(out, 0, 0.2)).toBeLessThan(1e-12);
    expect(energy(out, 0.26, 0.45)).toBeGreaterThan(1e-9);
  });

  it("bpm messages clamp to the core's 20..300 range", () => {
    const proc = new Processor();
    sendParam(proc, "preDelay.syncEnabled", 1);
    proc.port.onmessage?.({ data: { type: "bpm", bpm: 9999 } }); // → 300 → 1/4 = 0.2 s
    const out = renderImpulse(proc, 1.0);
    expect(energy(out, 0, 0.16)).toBeLessThan(1e-12);
    expect(energy(out, 0.22, 0.45)).toBeGreaterThan(1e-9);
  });

  // ── Bug regression: time-stamped params (offline automation timing) ──
  // Without setParameterAt the engine posted every automation point as an
  // immediate message — offline exports heard each point at POST time, not
  // project time (effectively the last value from second zero).
  it("regression: paramAt events apply at their scheduled time, not on arrival", () => {
    const proc = new Processor();
    // dryWet 100 default (pure wet). Mute the wet bus a quarter second in.
    proc.port.onmessage?.({ data: { type: "paramAt", id: "global.dryWet", value: 0, when: 0.25 } });
    const out = renderImpulse(proc, 0.6);
    // Still wet before the scheduled point — proof the event was NOT
    // applied when it arrived.
    expect(energy(out, 0.05, 0.2)).toBeGreaterThan(1e-9);
    // Wet bus (the whole reverb tail) is gone after the scheduled point;
    // dry is silence past the impulse block.
    expect(energy(out, 0.32, 0.55)).toBeLessThan(1e-12);
  });

  it("paramAt events due in the past apply on the next block", () => {
    const proc = new Processor();
    proc.port.onmessage?.({ data: { type: "paramAt", id: "global.dryWet", value: 0, when: 0 } });
    const out = renderImpulse(proc, 0.4);
    expect(energy(out, 0.05, 0.35)).toBeLessThan(1e-12);
  });

  it("a manual param cancels later paramAt events for the same id", () => {
    const proc = new Processor();
    proc.port.onmessage?.({ data: { type: "paramAt", id: "global.dryWet", value: 0, when: 0.4 } });
    // User touches the mixer before the event fires — the future event must go.
    proc.port.onmessage?.({ data: { type: "param", id: "global.dryWet", value: 100 } });
    const out = renderImpulse(proc, 0.8);
    expect(energy(out, 0.5, 0.75)).toBeGreaterThan(1e-9);
  });

  it("reset clears pending paramAt events", () => {
    const proc = new Processor();
    proc.port.onmessage?.({ data: { type: "paramAt", id: "global.dryWet", value: 0, when: 0.4 } });
    proc.port.onmessage?.({ data: { type: "reset" } });
    const out = renderImpulse(proc, 0.8);
    expect(energy(out, 0.5, 0.75)).toBeGreaterThan(1e-9);
  });

  it("sequential paramAt events fire in order across blocks", () => {
    const proc = new Processor();
    proc.port.onmessage?.({ data: { type: "paramAt", id: "global.dryWet", value: 0, when: 0.1 } });
    proc.port.onmessage?.({ data: { type: "paramAt", id: "global.dryWet", value: 100, when: 0.3 } });
    const out = renderImpulse(proc, 0.8);
    expect(energy(out, 0.14, 0.26)).toBeLessThan(1e-12); // muted window
    expect(energy(out, 0.35, 0.6)).toBeGreaterThan(1e-9); // wet restored
  });

  // ── Factory IR generation moved off the audio thread ──
  // The port handler runs ON the audio rendering thread: generating a
  // factory IR there (noise + envelope over up to 3 s × 4 ch, then the
  // partition FFTs) was a few-millisecond dropout on the first selection
  // of every (IR, rate). The entry now installs a provider that requests
  // generation from the main thread ("irNeeded") and loads the payload
  // when the reply lands; until then the CURRENT IR keeps playing.
  //
  // The payload cache is MODULE-scope in the entry (one per worklet
  // scope), and "reset" clears it — every test below resets at
  // construction so the suite is hermetic regardless of ordering.
  const replyFactoryIr = (proc: ProcShape, irId: string, frames = 512, channels: 1 | 2 | 4 = 2) => {
    const samples = new Float32Array(frames * channels);
    let l1 = 0;
    for (let i = 0; i < frames; i++) {
      const v = Math.exp(-i / 96);
      l1 += v;
      for (let c = 0; c < channels; c++) samples[i * channels + c] = v;
    }
    // L1-normalised smooth decay: worst-case wet ≤ max|x| and adjacent
    // sample steps stay small — the continuity proxy below needs a
    // physically sane IR, not an amplifying one.
    const inv = 1 / l1;
    for (let i = 0; i < samples.length; i++) samples[i] *= inv;
    proc.port.onmessage?.({ data: { type: "factoryIr", irId, samples, channels } });
  };

  /** Fresh processor with an empty module-scope payload cache. */
  const freshIrProc = (options?: ConstructorParameters<ProcCtor>[0]) => {
    const proc = new Processor(options);
    proc.port.onmessage?.({ data: { type: "reset" } });
    return proc;
  };

  it("regression: selecting a factory IR requests off-thread generation instead of generating inline", () => {
    const proc = freshIrProc();
    proc.port.posted.length = 0;
    sendParam(proc, "convolution.mode", 1); // hybrid
    sendParam(proc, "convolution.irId", "hall");
    const needed = proc.port.posted.find((m) => m.type === "irNeeded");
    expect(needed?.irId).toBe("hall");
    expect(needed?.sampleRate).toBe(SR);
    // Pre-fix: generation ran inline and the IR was armed immediately on
    // the audio thread. Post-fix: nothing is loaded until the reply.
    expect(proc.proc.isIrLoaded()).toBe(false);

    replyFactoryIr(proc, "hall");
    expect(proc.proc.isIrLoaded()).toBe(true);
    expect(proc.proc.getIrChannels()).toBe(2);
  });

  it("an initial irId via processorOptions requests generation at construction", () => {
    // No reset here — it would wipe the processorOptions state under test.
    // ("plate" is not used by any other factory-IR test, so the module
    // cache cannot short-circuit the request.)
    const proc = new Processor({
      processorOptions: { params: { "convolution.irId": "plate" } },
    });
    const needed = proc.port.posted.find((m) => m.type === "irNeeded");
    expect(needed?.irId).toBe("plate");
    expect(proc.proc.isIrLoaded()).toBe(false);
  });

  it("stale replies are not armed or cached; re-selection requests a fresh payload", () => {
    const proc = freshIrProc();
    sendParam(proc, "convolution.irId", "hall");
    sendParam(proc, "convolution.irId", "cathedral"); // selection moved on while hall is in flight
    let loads = 0;
    const orig = proc.proc.loadUserIr;
    proc.proc.loadUserIr = () => {
      loads++;
    };
    replyFactoryIr(proc, "hall"); // stale — current selection is cathedral
    expect(loads).toBe(0);
    proc.proc.loadUserIr = orig;
    replyFactoryIr(proc, "cathedral");
    expect(proc.proc.isIrLoaded()).toBe(true);

    // Re-selecting hall must request a new payload. The worklet cannot cache
    // mutable blockSpectra safely across instances/reloads; the main thread
    // owns the immutable spectra template and supplies a fresh ring.
    proc.port.posted.length = 0;
    sendParam(proc, "convolution.irId", "hall");
    expect(proc.proc.isIrLoaded()).toBe(true);
    expect(proc.port.posted.some((m) => m.type === "irNeeded" && m.irId === "hall")).toBe(true);
  });

  it("unknown factory ids clear the convolution instead of looping requests", () => {
    const proc = freshIrProc();
    sendParam(proc, "convolution.irId", "hall");
    replyFactoryIr(proc, "hall");
    expect(proc.proc.isIrLoaded()).toBe(true);
    proc.port.posted.length = 0;
    sendParam(proc, "convolution.irId", "not-an-ir");
    expect(proc.proc.isIrLoaded()).toBe(false);
    expect(proc.port.posted.some((m) => m.type === "irNeeded")).toBe(false);
  });

  it("malformed factoryIr replies are dropped without corrupting state", () => {
    const proc = freshIrProc();
    sendParam(proc, "convolution.irId", "hall");
    proc.port.onmessage?.({ data: { type: "factoryIr", irId: "hall", samples: null, channels: 2 } });
    proc.port.onmessage?.({
      // non-multiple length for 2 channels
      data: { type: "factoryIr", irId: "hall", samples: new Float32Array(7), channels: 2 },
    });
    expect(proc.proc.isIrLoaded()).toBe(false);
    // The selection can still be satisfied by a well-formed reply.
    replyFactoryIr(proc, "hall");
    expect(proc.proc.isIrLoaded()).toBe(true);
  });

  it("switching factory IRs during playback stays finite, bounded and continuous (listening proxy)", () => {
    // The convolution engine crossfades IR swaps over ~50 ms and a pending
    // selection keeps the old IR audible — a mid-playback factory switch
    // must produce no non-finite sample, no level explosion and no
    // sample-to-sample discontinuity beyond what the crossfade implies.
    const proc = freshIrProc();
    sendParam(proc, "convolution.mode", 2); // convolution
    sendParam(proc, "convolution.irId", "hall");
    replyFactoryIr(proc, "hall");

    const rngState = { s: 0x51de };
    const noise = (l: Float32Array, r: Float32Array) => {
      for (let i = 0; i < BLOCK; i++) {
        rngState.s = (Math.imul(rngState.s, 1664525) + 1013904223) >>> 0;
        l[i] = ((rngState.s / 4294967296) * 2 - 1) * 0.5;
        r[i] = l[i];
      }
    };
    const blocks = Math.ceil((0.6 * SR) / BLOCK);
    const out = new Float32Array(blocks * BLOCK);
    let maxAbs = 0;
    let maxJump = 0;
    let prev = 0;
    for (let b = 0; b < blocks; b++) {
      // Mid-render: select a second factory IR and deliver it a few
      // blocks later (simulated main-thread latency).
      if (b === Math.floor(blocks * 0.3)) sendParam(proc, "convolution.irId", "cathedral");
      if (b === Math.floor(blocks * 0.35)) replyFactoryIr(proc, "cathedral");
      const inL = new Float32Array(BLOCK);
      const inR = new Float32Array(BLOCK);
      noise(inL, inR);
      const oL = out.subarray(b * BLOCK, b * BLOCK + BLOCK);
      proc.process([[inL, inR]], [[oL, new Float32Array(BLOCK)]]);
      for (let i = 0; i < BLOCK; i++) {
        if (!Number.isFinite(oL[i])) throw new Error(`non-finite sample at block ${b}`);
        maxAbs = Math.max(maxAbs, Math.abs(oL[i]));
        maxJump = Math.max(maxJump, Math.abs(oL[i] - prev));
        prev = oL[i];
      }
    }
    expect(maxAbs).toBeLessThanOrEqual(1.0); // safety limiter ceiling
    // A 50 ms equal-gain crossfade between two ≤1 IRs cannot step more
    // than ~1.0 between adjacent samples; a hard IR swap would.
    expect(maxJump).toBeLessThanOrEqual(0.7);
    expect(energy([out], 0.1, 0.6)).toBeGreaterThan(1e-6); // tail kept flowing
  });
});

// ── Precomputed-spectra IR path (the FFT batch moved off the audio thread) ──
// The partitioned convolver's load-time work (one forward FFT per IR
// partition) used to run inside the port handler — ON the audio thread —
// a 2–8 ms dropout on the first selection of every IR. The main thread now
// ships PRECOMPUTED frequency-domain partitions; arming the convolver here
// does no FFT work. The node-side generation lives in
// tests/ozvena-ir-spectra.test.ts (bit-identical parity is proven there).
import { precomputeConvolverSpectra } from "../src/effects/ozvena-core/dsp/fftPartitioned.js";

const IR_FRAMES = 512;

/** Smooth decaying mono IR, L1-normalized (bounded wet output). */
function makeMonoIr(seed: number): Float32Array {
  const out = new Float32Array(IR_FRAMES);
  let l1 = 0;
  for (let i = 0; i < IR_FRAMES; i++) {
    const v = Math.exp(-i / 96) * Math.sin(i * 0.11 + seed);
    l1 += Math.abs(v);
    out[i] = v;
  }
  const inv = 1 / l1;
  for (let i = 0; i < IR_FRAMES; i++) out[i] *= inv;
  return out;
}

/** Precomputed sets for the stereo-bus layout, channels 1/2/4. */
function makeSets(channels: 1 | 2 | 4, seed = 3) {
  const ps = 2048;
  const np = Math.ceil(IR_FRAMES / (ps / 2));
  const sources =
    channels === 1
      ? [makeMonoIr(seed)]
      : channels === 2
        ? [makeMonoIr(seed), makeMonoIr(seed + 1)]
        : [makeMonoIr(seed), makeMonoIr(seed + 1), makeMonoIr(seed + 2), makeMonoIr(seed + 3)];
  const spectra = sources.map(
    (ch) => precomputeConvolverSpectra(ch, { partitionSize: ps, irLengthSamples: IR_FRAMES }).irSpectra,
  );
  const sets = [];
  for (let slot = 0; slot < (channels === 1 ? 2 : channels); slot++) {
    sets.push({
      irSpectra: spectra[Math.min(slot, spectra.length - 1)],
      blockSpectra: new Float64Array(np * ps * 2),
      numPartitions: np,
      partitionSize: ps,
      irLengthSamples: IR_FRAMES,
    });
  }
  return { sets, interleaved: sources };
}

describe("Ozvena worklet entry — precomputed IR spectra path", () => {
  // Local aliases — the equivalents above live inside the earlier describe.
  const freshIrProc = (options?: ConstructorParameters<ProcCtor>[0]) => {
    const proc = new Processor(options);
    proc.port.onmessage?.({ data: { type: "reset" } });
    return proc;
  };
  const sendParam = (proc: ProcShape, id: string, value: number | string): void => {
    proc.port.onmessage?.({ data: { type: "param", id, value } });
  };

  it("a factoryIr reply with spectra sets arms the convolver with no time-domain samples", () => {
    const proc = freshIrProc();
    sendParam(proc, "convolution.mode", 1);
    sendParam(proc, "convolution.irId", "hall");
    expect(proc.port.posted.some((m) => m.type === "irNeeded")).toBe(true);

    const { sets } = makeSets(2);
    proc.port.onmessage?.({
      data: { type: "factoryIr", irId: "hall", channels: 2, sets },
    });
    expect(proc.proc.isIrLoaded()).toBe(true);
    expect(proc.proc.getIrChannels()).toBe(2);
  });

  it("the spectra path renders BIT-IDENTICAL audio to the legacy samples path", () => {
    // Same synthetic IR delivered both ways; the convolver consumes the
    // same frequency-domain data either way, so the renders must match
    // sample for sample.
    const { sets, interleaved } = makeSets(2);
    const viaSets = freshIrProc();
    sendParam(viaSets, "convolution.mode", 2);
    sendParam(viaSets, "convolution.irId", "hall");
    viaSets.port.onmessage?.({ data: { type: "factoryIr", irId: "hall", channels: 2, sets } });
    const outSets = renderImpulse(viaSets, 0.4);

    const viaSamples = freshIrProc();
    sendParam(viaSamples, "convolution.mode", 2);
    sendParam(viaSamples, "convolution.irId", "hall");
    const interleavedL1 = new Float32Array(IR_FRAMES * 2);
    for (let i = 0; i < IR_FRAMES; i++) {
      interleavedL1[i * 2] = interleaved[0][i];
      interleavedL1[i * 2 + 1] = interleaved[1][i];
    }
    viaSamples.port.onmessage?.({
      data: { type: "factoryIr", irId: "hall", channels: 2, samples: interleavedL1 },
    });
    const outSamples = renderImpulse(viaSamples, 0.4);

    expect(outSets[0].length).toBe(outSamples[0].length);
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < outSets[c].length; i++) {
        expect(outSets[c][i]).toBe(outSamples[c][i]);
      }
    }
  });

  it("a re-selection requests a fresh mutable block-spectrum ring", () => {
    const proc = freshIrProc();
    sendParam(proc, "convolution.irId", "hall");
    const { sets: hallSets } = makeSets(2);
    proc.port.onmessage?.({ data: { type: "factoryIr", irId: "hall", channels: 2, sets: hallSets } });
    expect(proc.proc.isIrLoaded()).toBe(true);

    // Load a different IR so the next HALL selection is a real reload rather
    // than the core's already-loaded fast path.
    proc.port.posted.length = 0;
    sendParam(proc, "convolution.irId", "cathedral");
    expect(proc.port.posted.some((m) => m.type === "irNeeded" && m.irId === "cathedral")).toBe(true);
    const { sets: cathedralSets } = makeSets(2, 9);
    proc.port.onmessage?.({ data: { type: "factoryIr", irId: "cathedral", channels: 2, sets: cathedralSets } });

    proc.port.posted.length = 0;
    sendParam(proc, "convolution.irId", "hall");
    expect(proc.proc.isIrLoaded()).toBe(true); // cathedral remains audible while HALL is pending
    expect(proc.port.posted.some((m) => m.type === "irNeeded" && m.irId === "hall")).toBe(true);

    const { sets: hallReloadSets } = makeSets(2, 17);
    proc.port.onmessage?.({ data: { type: "factoryIr", irId: "hall", channels: 2, sets: hallReloadSets } });
    expect(proc.proc.isIrLoaded()).toBe(true);
  });

  it("the consume-once blockSpectra handover keeps re-loads correct (finite render)", () => {
    const proc = freshIrProc();
    sendParam(proc, "convolution.mode", 2);
    sendParam(proc, "convolution.irId", "hall");
    const { sets } = makeSets(2);
    proc.port.onmessage?.({ data: { type: "factoryIr", irId: "hall", channels: 2, sets } });
    sendParam(proc, "convolution.irId", "cathedral");
    sendParam(proc, "convolution.irId", "hall"); // reload: fresh rings arrive from the main thread

    const out = renderImpulse(proc, 0.3);
    let nonFinite = 0;
    let peak = 0;
    for (const ch of out) {
      for (let i = 0; i < ch.length; i++) {
        if (!Number.isFinite(ch[i])) nonFinite++;
        peak = Math.max(peak, Math.abs(ch[i]));
      }
    }
    expect(nonFinite).toBe(0);
    expect(peak).toBeLessThanOrEqual(1.0);
    expect(energy(out, 0.05, 0.3)).toBeGreaterThan(1e-6);
  });

  it("malformed spectra sets are dropped; the legacy samples path still arms", () => {
    const proc = freshIrProc();
    sendParam(proc, "convolution.irId", "hall");
    const { sets } = makeSets(2);
    const broken = sets.map((s) => ({
      ...s,
      irSpectra: s.irSpectra.subarray(0, s.irSpectra.length - 8),
    }));
    proc.port.onmessage?.({ data: { type: "factoryIr", irId: "hall", channels: 2, sets: broken } });
    expect(proc.proc.isIrLoaded()).toBe(false);

    const interleavedL1 = new Float32Array(IR_FRAMES * 2);
    const { interleaved } = makeSets(2);
    for (let i = 0; i < IR_FRAMES; i++) {
      interleavedL1[i * 2] = interleaved[0][i];
      interleavedL1[i * 2 + 1] = interleaved[1][i];
    }
    proc.port.onmessage?.({
      data: { type: "factoryIr", irId: "hall", channels: 2, samples: interleavedL1 },
    });
    expect(proc.proc.isIrLoaded()).toBe(true);
  });

  it("an over-cap spectra payload is rejected at the IR length cap", () => {
    const proc = freshIrProc();
    sendParam(proc, "convolution.irId", "hall");
    const { sets } = makeSets(2);
    const overCap = sets.map((s) => ({ ...s, irLengthSamples: 15 * 60 * SR }));
    proc.port.onmessage?.({ data: { type: "factoryIr", irId: "hall", channels: 2, sets: overCap } });
    expect(proc.proc.isIrLoaded()).toBe(false);
  });

  it("the loadIr message accepts spectra sets directly (user IR path)", () => {
    const proc = freshIrProc();
    const { sets } = makeSets(2, 9);
    proc.port.onmessage?.({ data: { type: "loadIr", channels: 2, sets } });
    expect(proc.proc.isIrLoaded()).toBe(true);
    expect(proc.proc.getIrChannels()).toBe(2);

    // Quad user IR: four convolver slots.
    const proc4 = freshIrProc();
    const { sets: sets4 } = makeSets(4, 9);
    proc4.port.onmessage?.({ data: { type: "loadIr", channels: 4, sets: sets4 } });
    expect(proc4.proc.isIrLoaded()).toBe(true);
    expect(proc4.proc.getIrChannels()).toBe(4);
  });
});

describe("Ozvena worklet entry — hardening regressions (2026-09-12)", () => {
  it("a numeric update to a non-enum string leaf is dropped, not String()-coerced", () => {
    const proc = new Processor();
    // A corrupt document writing a NUMBER into a string leaf used to install
    // garbage like "1000000000" as the sync note via String(value) coercion.
    sendParam(proc, "preDelay.syncNote", 1e9);
    const preDelay = (proc.state as { preDelay?: { syncNote: string } }).preDelay;
    expect(preDelay?.syncNote).toBe("1/4");
    // Enum paths still convert numeric indices per the ENUM_BY_PATH map.
    sendParam(proc, "mod.mode", 1);
    expect(proc.state.mod.mode).toBe("pitch");
  });

  it("output quanta larger than 128 frames are fully written (chunked pass)", () => {
    const proc = new Processor();
    // Pure dry → the output must mirror the input sample-for-sample.
    sendParam(proc, "global.dryWet", 0);
    const N = 256;
    const inL = new Float32Array(N).fill(0.5);
    const inR = new Float32Array(N).fill(0.5);
    const outL = new Float32Array(N);
    const outR = new Float32Array(N);
    setTime(0);
    expect(proc.process([[inL, inR]], [[outL, outR]])).toBe(true);
    // Pre-fix only the first 128 frames were written; samples beyond frame
    // 128 stayed stale (zeros here, the previous block's audio on a live
    // host with a larger quantum).
    let tailMin = Infinity;
    for (let i = HALF_N; i < N; i++) tailMin = Math.min(tailMin, Math.abs(outL[i]));
    expect(tailMin).toBeGreaterThan(0.1);
    expect(outL[N - 1]).toBeCloseTo(0.5, 6);
    expect(outR[N - 1]).toBeCloseTo(0.5, 6);
  });
  const HALF_N = 128;
});
