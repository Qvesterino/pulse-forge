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
  state: {
    engines: { e2: { algo: string }; e3: { algo: string } };
    mod: { mode: string };
    [key: string]: unknown;
  };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

type ProcCtor = new (
  options?: { processorOptions?: { params?: Record<string, number>; bpm?: number } },
) => ProcShape;

let Processor: ProcCtor;
/** Render clock for the worklet scope — the host advances it per quantum. */
let now = 0;
const setTime = (t: number) => {
  now = t;
};

beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = 48000;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor =
    FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (
    _name: string,
    cls: ProcCtor,
  ) => {
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
      [
        [
          outL.subarray(b * BLOCK, b * BLOCK + BLOCK),
          outR.subarray(b * BLOCK, b * BLOCK + BLOCK),
        ],
      ],
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

function sendParam(proc: ProcShape, id: string, value: number): void {
  proc.port.onmessage?.({ data: { type: "param", id, value } });
}

describe("Ozvena worklet entry (message port ↔ DSP core wiring)", () => {
  it("reports DSP latency over the port at construction", () => {
    const proc = new Processor();
    const latencies = proc.port.posted.filter((m) => m.type === "latency");
    expect(latencies.length).toBeGreaterThanOrEqual(1);
    expect(latencies[0].samples).toBeGreaterThan(0);
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
    expect(proc.process([[new Float32Array(BLOCK), new Float32Array(BLOCK)]], [[out, out]])).toBe(
      false,
    );
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
});
