/**
 * Ultina render-parity — proves every code path that can render Ultina audio
 * produces the SAME samples:
 *
 *  1. Real worklet entry (the bundled file) vs raw UltinaProcessor — the
 *     entry adds block staging and param plumbing; parity here + the golden
 *     vectors (core vs upstream oracle) close the chain: browser == oracle.
 *  2. 512-sample host blocks vs 128-sample blocks on the raw processor —
 *     OfflineAudioContexts/hosts may drive larger quanta; the processor's
 *     internal chunking must be transparent.
 *  3. Entry driven with a 256-sample quantum vs 128 — pins the chunk-loop
 *     hardening (spec allows hosts to exceed the 128 render quantum).
 *  4. trueEnvelope detection is documented as block-size-dependent (it reads
 *     sample[i+1] at the block edge); the divergence is QUANTIFIED here so a
 *     future upstream fix shows up as this number shrinking.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { UltinaProcessor } from "../src/effects/ultina-core/dsp/ultinaProcessor.js";
import { registerCoreModules } from "../src/effects/ultina-core/dsp/moduleFactories.js";

const SR = 48000;

const PARAMS: Record<string, number> = {
  "global.inputGainDb": -2,
  "global.outputGainDb": 1.5,
  "eq.enabled": 1,
  "eq.band0.gainDb": 3,
  "eq.band0.freq": 800,
  "comp.enabled": 1,
  "comp.thresholdDb": -40,
  "comp.band0.thresholdDb": -40,
  "comp.band1.thresholdDb": -40,
  "comp.band2.thresholdDb": -40,
  "comp.ratio": 20,
  "comp.detectionMode": 0, // peak — see the trueEnvelope case below
  "exciter.enabled": 1,
};

class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  postMessage(_msg: unknown): void {}
}
class FakeAudioWorkletProcessor {
  port = new FakePort();
}
interface ProcShape {
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
type ProcCtor = new (options?: { processorOptions?: { params?: Record<string, number> } }) => ProcShape;

let Processor: ProcCtor;

beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
  // Render clock global — present in the real AudioWorkletGlobalScope, and
  // the entry's scheduled-parameter queue reads it every process() call.
  // A static 0 keeps the (empty) paramAt queue inert in these renders.
  Object.defineProperty(globalThis, "currentTime", { value: 0, configurable: true });
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (_name: string, cls: ProcCtor) => {
    Processor = cls;
  };
  // @ts-expect-error untyped .js worklet entry (gallery-server.test.ts convention)
  await import("../src/effects/ultina-worklet.entry.js");
  if (!Processor) throw new Error("ultina-processor did not register");
});

/** Deterministic stereo signal generator shared by all render paths. */
function makeSignal(totalFrames: number): Float32Array[] {
  const chans = [new Float32Array(totalFrames), new Float32Array(totalFrames)];
  let s = 12345;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 2 - 1;
  };
  for (let i = 0; i < totalFrames; i++) {
    const t = i / SR;
    // Signal content starts after 100 ms — module state is settled identically
    // everywhere by then, and the first samples catch init-time differences.
    const env = i < SR / 10 ? 0 : 1;
    const v = env * 0.3 * (Math.sin(2 * Math.PI * 440 * t) + 0.5 * rand());
    chans[0][i] = v;
    chans[1][i] = v;
  }
  return chans;
}

/** Raw processor reference: graph enabled from params, mirroring the entry. */
function renderRaw(signal: Float32Array[], blockFrames: number, hostBlockFrames = blockFrames): Float32Array[] {
  const proc = new UltinaProcessor();
  registerCoreModules(proc);
  proc.prepare({ sampleRate: SR, maxBlockSize: blockFrames, channelCount: 2, qualityMode: 1 });
  proc.loadState(PARAMS);
  for (const type of ["eq", "comp", "exciter"]) {
    proc.getGraphRuntime().setModuleEnabled(type as never, proc.getParameter(`${type}.enabled`) >= 0.5);
  }
  const total = signal[0].length;
  const out: Float32Array[] = [new Float32Array(total), new Float32Array(total)];
  const io: Float32Array[] = [new Float32Array(hostBlockFrames), new Float32Array(hostBlockFrames)];
  for (let off = 0; off < total; off += hostBlockFrames) {
    const frames = Math.min(hostBlockFrames, total - off);
    io[0].set(signal[0].subarray(off, off + frames));
    io[1].set(signal[1].subarray(off, off + frames));
    proc.process(io, frames);
    out[0].set(io[0].subarray(0, frames), off);
    out[1].set(io[1].subarray(0, frames), off);
  }
  return out;
}

function renderEntry(signal: Float32Array[], quantum: number): Float32Array[] {
  const proc = new Processor({ processorOptions: { params: { ...PARAMS } } });
  const total = signal[0].length;
  const out: Float32Array[] = [new Float32Array(total), new Float32Array(total)];
  for (let off = 0; off < total; off += quantum) {
    // A real host delivers a FRESH quantum-sized input/output pair per call —
    // stage views of exactly that shape (the entry reads inputs relative to
    // its own internal chunk loop, so oversized buffers would read wrong).
    const frames = Math.min(quantum, total - off);
    const inputs = [[signal[0].subarray(off, off + frames), signal[1].subarray(off, off + frames)]];
    const outputs = [[new Float32Array(frames), new Float32Array(frames)]];
    proc.process(inputs, outputs);
    out[0].set(outputs[0][0], off);
    out[1].set(outputs[0][1], off);
  }
  return out;
}

function maxAbsDiff(a: Float32Array[], b: Float32Array[]): number {
  let max = 0;
  for (let ch = 0; ch < a.length; ch++) {
    for (let i = 0; i < a[ch].length; i++) {
      const d = Math.abs(a[ch][i] - b[ch][i]);
      if (d > max) max = d;
    }
  }
  return max;
}

const FRAMES = SR; // 1 s render

describe("Ultina render parity", () => {
  it("worklet entry output is bit-identical to the raw processor", () => {
    const signal = makeSignal(FRAMES);
    const diff = maxAbsDiff(renderEntry(signal, 128), renderRaw(signal, 128));
    expect(diff).toBeLessThanOrEqual(1e-9);
  });

  it("512-sample host blocks render identically to 128-sample blocks", () => {
    const signal = makeSignal(FRAMES);
    const diff = maxAbsDiff(renderRaw(signal, 128, 512), renderRaw(signal, 128, 128));
    expect(diff).toBeLessThanOrEqual(1e-9);
  });

  it("entry driven with a 256-sample quantum renders identically to 128", () => {
    const signal = makeSignal(FRAMES);
    const diff = maxAbsDiff(renderEntry(signal, 256), renderEntry(signal, 128));
    expect(diff).toBeLessThanOrEqual(1e-9);
  });

  it("trueEnvelope boundary artifact is fixed to an inaudible residual (regression)", () => {
    // Regression: the trueEnvelope detector used to fabricate s2 = 0 for the
    // LAST sample of every internal processing block (the next sample does
    // not exist there). That read as a cliff edge and produced a periodic
    // false peak once per maxBlockSize — measured: maxDiff 6.6e-5 (−73 dB
    // rel.) between 128- and 512-frame renderings of the same stream, first
    // divergence right after the first block boundary.
    //
    // The boundary sample now uses the RAW peak (no interpolation). A fully
    // block-size-transparent detector is structurally impossible with
    // in-place streaming (a lookahead sample cannot retroactively scale the
    // previous block's buffer), so the honest bound is the residual
    // interpolation loss at boundaries: measured 1.7e-5 (−85 dB rel.) after
    // the fix. Assert under that with margin — a regression to the old
    // fabricated-cliff behavior (6.6e-5) fails this.
    const teParams = { ...PARAMS, "comp.detectionMode": 2 };
    const signal = makeSignal(FRAMES);
    const renderRawTe = (blockFrames: number): Float32Array[] => {
      const proc = new UltinaProcessor();
      registerCoreModules(proc);
      proc.prepare({ sampleRate: SR, maxBlockSize: blockFrames, channelCount: 2, qualityMode: 1 });
      proc.loadState(teParams);
      proc.getGraphRuntime().setModuleEnabled("comp" as never, true);
      proc.getGraphRuntime().setModuleEnabled("eq" as never, true);
      proc.getGraphRuntime().setModuleEnabled("exciter" as never, true);
      const total = FRAMES;
      const out: Float32Array[] = [new Float32Array(total), new Float32Array(total)];
      const io: Float32Array[] = [new Float32Array(blockFrames), new Float32Array(blockFrames)];
      for (let off = 0; off < total; off += blockFrames) {
        const frames = Math.min(blockFrames, total - off);
        io[0].set(signal[0].subarray(off, off + frames));
        io[1].set(signal[1].subarray(off, off + frames));
        proc.process(io, frames);
        out[0].set(io[0].subarray(0, frames), off);
        out[1].set(io[1].subarray(0, frames), off);
      }
      return out;
    };
    const diff = maxAbsDiff(renderRawTe(512), renderRawTe(128));
    expect(diff).toBeLessThan(5e-5);
    expect(maxAbsDiff(renderRawTe(512), renderRawTe(384))).toBeLessThan(5e-5);
  });
});
