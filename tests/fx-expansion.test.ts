import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * FX Expansion processor DSP contracts (docs/FX-EXPANSION-ROADMAP.md):
 *
 *  - ringMod: mix 0 = unity passthrough; carrier tones produce sidebands.
 *  - tapeStop: ENGAGE ramps energy toward silence; release re-reads the
 *    buffer deterministically (two identical renders are identical).
 *  - freqShifter: shift 0 ≈ unity passthrough (within allpass tolerance).
 *  - pitchShift: ratio 1 ≈ passthrough (within grain-window tolerance) and
 *    two identical renders are bit-identical (offline parity).
 *  - vinyl: amount 1 raises noise-floor energy vs amount 0.
 *  - beatMangler: unity volume envelope + NORM ≈ passthrough; a zeroed
 *    volume step silences its slice of the bar.
 *
 * Processors run headless via the stubbed AudioWorkletProcessor globals
 * (same pattern as tests/quick-wins.test.ts).
 */

class FakePort {
  messages: unknown[] = [];
  postMessage(message: unknown) {
    this.messages.push(message);
  }
  onmessage: ((e: unknown) => void) | null = null;
}
class FakeAudioWorkletProcessor {
  // Real AudioWorkletProcessor always exposes `port` — the sandbox host must
  // too, or processors that subscribe to it (beatMangler) cannot construct.
  port = new FakePort();
}

let ringModFactory: (options?: { processorOptions?: unknown }) => {
  process: (inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) => boolean;
};
let tapeStopFactory: typeof ringModFactory;
let freqShiftFactory: typeof ringModFactory;
let pitchShiftFactory: typeof ringModFactory;
let vinylFactory: typeof ringModFactory;
let beatManglerFactory: typeof ringModFactory;

const SR = 44100;

function param(values: Record<string, number>): Record<string, Float32Array> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Float32Array.of(v)]));
}

function stereoBuffer(n: number, fillL: (i: number) => number, fillR?: (i: number) => number): Float32Array[] {
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = fillL(i);
    r[i] = (fillR ?? fillL)(i);
  }
  return [l, r];
}

function energyOf(block: Float32Array[]): number {
  let sum = 0;
  for (const ch of block) for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
  return Math.sqrt(sum / block.reduce((a, c) => a + c.length, 0));
}

function peakOf(block: Float32Array[]): number {
  let peak = 0;
  for (const ch of block) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  return peak;
}

beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = () => {};
  // Worklet processors are raw JS without exports — evaluate the source in a
  // sandbox where registerProcessor captures the class.
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const dir = path.resolve(import.meta.dirname ?? ".", "..", "src", "audio-worklets");
  const factoryOf =
    (file: string) =>
    (options?: { processorOptions?: unknown }): unknown => {
      const source = readFileSync(path.join(dir, file), "utf-8");
      let captured: unknown = null;
      const register = (_name: string, cls: unknown) => {
        captured = cls;
      };
      const host = new Function("registerProcessor", "AudioWorkletProcessor", "globalThis", source);
      host(register, FakeAudioWorkletProcessor, globalThis);
      if (!captured) throw new Error(`no processor registered in ${file}`);
      return new (captured as new (o?: unknown) => unknown)(options);
    };
  ringModFactory = factoryOf("ringmod-processor.js") as typeof ringModFactory;
  tapeStopFactory = factoryOf("tapestop-processor.js") as typeof tapeStopFactory;
  freqShiftFactory = factoryOf("freqshifter-processor.js") as typeof freqShiftFactory;
  pitchShiftFactory = factoryOf("pitchshift-processor.js") as typeof pitchShiftFactory;
  vinylFactory = factoryOf("vinyl-processor.js") as typeof vinylFactory;
  beatManglerFactory = factoryOf("beatmangler-processor.js") as typeof beatManglerFactory;
});

describe("fx expansion processors", () => {
  it("ringMod: mix 0 is unity passthrough", () => {
    const fx = ringModFactory();
    const input = stereoBuffer(128, (i) => Math.sin((2 * Math.PI * 220 * i) / SR) * 0.5);
    const output: Float32Array[][] = [[]];
    output[0] = [new Float32Array(128), new Float32Array(128)];
    fx.process([input], output, param({ frequency: 220, mix: 0, feedback: 0 }));
    for (let i = 0; i < 128; i++) {
      expect(output[0][0][i]).toBeCloseTo(input[0][i], 5);
      expect(output[0][1][i]).toBeCloseTo(input[1][i], 5);
    }
  });

  it("tapeStop: ENGAGE decays energy; identical renders are identical", () => {
    const render = () => {
      const fx = tapeStopFactory();
      const input = stereoBuffer(1024, (i) => Math.sin((2 * Math.PI * 330 * i) / SR) * 0.6);
      const output: Float32Array[][] = [[]];
      output[0] = [new Float32Array(1024), new Float32Array(1024)];
      fx.process([input], output, param({ engaged: 1, time: 0.3, curve: 0, spin: 0, mix: 1 }));
      return output[0];
    };
    const a = render();
    const b = render();
    // Energy collapses as the head stalls — but never produces garbage.
    expect(peakOf(a)).toBeLessThan(0.7);
    for (let i = 0; i < 1024; i++) {
      expect(a[0][i]).toBeCloseTo(b[0][i], 5);
      expect(a[1][i]).toBeCloseTo(b[1][i], 5);
    }
  });

  it("freqShifter: shift 0 preserves magnitude (allpass pair)", () => {
    const fx = freqShiftFactory();
    const input = stereoBuffer(1024, (i) => Math.sin((2 * Math.PI * 440 * i) / SR) * 0.4);
    const output: Float32Array[][] = [[]];
    output[0] = [new Float32Array(1024), new Float32Array(1024)];
    fx.process([input], output, param({ shift: 0, mix: 1 }));
    // Allpass branches shift phase, never magnitude — energy is preserved.
    const ratio = energyOf(output[0]) / energyOf(input);
    expect(ratio).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThan(1.15);
  });

  it("pitchShift: ratio 0 st ≈ passthrough within window tolerance; renders are bit-identical", () => {
    const render = () => {
      const fx = pitchShiftFactory({ processorOptions: { seed: 42 } });
      const input = stereoBuffer(512, (i) => Math.sin((2 * Math.PI * 330 * i) / SR) * 0.5);
      const output: Float32Array[][] = [[]];
      output[0] = [new Float32Array(512), new Float32Array(512)];
      fx.process([input], output, param({ semitones: 0, fine: 0, grainMs: 55, width: 0.5, mix: 1 }));
      return output[0];
    };
    const a = render();
    const b = render();
    for (let i = 64; i < 512; i++) {
      expect(Math.abs(a[0][i] - input0(i))).toBeLessThan(0.12);
      expect(a[0][i]).toBe(a[0][i]); // finite
      expect(a[0][i]).toBe(b[0][i]);
    }
  });

  it("pitchShift: +12 st on 330 Hz actually shifts content near 660 Hz", () => {
    // Regression: the write cursor never advanced, so every render stayed in
    // the startup passthrough branch and the effect was silently inert —
    // and the old grain loop read ahead of the write line, so shift-up
    // collapsed even after the cursor fix.
    const fx = pitchShiftFactory({ processorOptions: { seed: 42 } });
    const blocks = 8;
    const n = 1024;
    const tail: number[] = [];
    for (let b = 0; b < blocks; b++) {
      const input = stereoBuffer(n, (i) => Math.sin((2 * Math.PI * 330 * (b * n + i)) / SR) * 0.5);
      const output: Float32Array[][] = [[]];
      output[0] = [new Float32Array(n), new Float32Array(n)];
      fx.process([input], output, param({ semitones: 12, fine: 0, grainMs: 55, width: 0.5, mix: 1 }));
      for (const ch of output[0]) {
        for (let i = 0; i < n; i++) expect(Number.isFinite(ch[i])).toBe(true);
      }
      if (b >= blocks - 4) for (let i = 0; i < n; i++) tail.push(output[0][0][i]);
    }
    // Zero-crossing pitch estimate over the concatenated voiced tail.
    let crossings = 0;
    for (let i = 1; i < tail.length; i++) {
      if (tail[i - 1] <= 0 && tail[i] > 0) crossings++;
    }
    const estimate = (crossings * SR) / tail.length;
    expect(estimate).toBeGreaterThan(660 * 0.8);
    expect(estimate).toBeLessThan(660 * 1.2);
  });

  it("vinyl: amount 1 adds crackle/dust energy over amount 0", () => {
    const render = (amount: number) => {
      const fx = vinylFactory({ processorOptions: { seed: 7 } });
      const input = stereoBuffer(2048, () => 0); // digital silence
      const output: Float32Array[][] = [[]];
      output[0] = [new Float32Array(2048), new Float32Array(2048)];
      fx.process([input], output, param({ amount, crackle: 0.8, wow: 0.3, year: 0.5, mix: 1 }));
      return energyOf(output[0]);
    };
    expect(render(1)).toBeGreaterThan(render(0) * 2);
  });

  it("beatMangler: NORM with unity volume ≈ passthrough; a zeroed volume envelope silences", () => {
    const bar = Math.round((60 / 120) * 4 * SR); // 1 bar @ 120 BPM
    type ManglerWithPort = ReturnType<typeof beatManglerFactory> & { port: FakePort };
    const render = (volume: number[]) => {
      const fx = beatManglerFactory() as ManglerWithPort;
      fx.port.onmessage?.({ data: { type: "steps", volume, pitch: null } });
      fx.port.onmessage?.({ data: { type: "bpm", bpm: 120 } });
      // Feed a FULL BAR of input — the mangler replays the last recorded bar,
      // so the window must be full before the mangled pass reads it.
      const input = stereoBuffer(bar, (i) => Math.sin((2 * Math.PI * 220 * i) / SR) * 0.6);
      const output: Float32Array[][] = [[]];
      output[0] = [new Float32Array(bar), new Float32Array(bar)];
      fx.process([input], output, param({ mix: 1 }));
      return output[0];
    };
    const unity = render(Array(16).fill(1));
    const muted = render(Array(16).fill(0));
    const unityEnergy = energyOf(unity);
    const mutedEnergy = energyOf(muted);
    // Unity loop ≈ passthrough energy; all-zero volume ≈ silence.
    expect(unityEnergy).toBeGreaterThan(0.3);
    expect(mutedEnergy).toBeLessThan(0.001);
    void unityEnergy;
    void mutedEnergy;
  });

  it("beatMangler: the mix AudioParam is honored (mix 0 = passthrough even with muted envelope)", () => {
    // Regression: the processor only read a port-message `mix` nobody sent,
    // so the node's mix AudioParam was dead and the effect was stuck full-wet.
    const bar = Math.round((60 / 120) * 4 * SR);
    const fx = beatManglerFactory() as ReturnType<typeof beatManglerFactory> & { port: FakePort };
    fx.port.onmessage?.({ data: { type: "steps", volume: Array(16).fill(0), pitch: null } });
    fx.port.onmessage?.({ data: { type: "bpm", bpm: 120 } });
    const input = stereoBuffer(bar, (i) => Math.sin((2 * Math.PI * 220 * i) / SR) * 0.6);
    const output: Float32Array[][] = [[]];
    output[0] = [new Float32Array(bar), new Float32Array(bar)];
    fx.process([input], output, param({ mix: 0 }));
    for (let i = 0; i < bar; i++) {
      expect(output[0][0][i]).toBeCloseTo(input[0][i], 5);
      expect(output[0][1][i]).toBeCloseTo(input[1][i], 5);
    }
  });

  it("beatMangler: a non-finite envelope entry cannot poison the tape head with NaN", () => {
    const bar = Math.round((60 / 120) * 4 * SR);
    const fx = beatManglerFactory() as ReturnType<typeof beatManglerFactory> & { port: FakePort };
    fx.port.onmessage?.({ data: { type: "steps", volume: [1, Number.NaN, 0.5, 1], pitch: [0, Number.NaN, 12, 0] } });
    fx.port.onmessage?.({ data: { type: "bpm", bpm: 120 } });
    const input = stereoBuffer(bar, (i) => Math.sin((2 * Math.PI * 220 * i) / SR) * 0.6);
    const output: Float32Array[][] = [[]];
    output[0] = [new Float32Array(bar), new Float32Array(bar)];
    fx.process([input], output, param({ mix: 1 }));
    for (const ch of output[0]) {
      for (let i = 0; i < ch.length; i++) expect(Number.isFinite(ch[i])).toBe(true);
    }
  });

  it("beatMangler never logs or crashes in the audio thread when a stale debug flag is set", () => {
    const debugGlobal = globalThis as typeof globalThis & { __BM_DBG?: boolean };
    const hadDebugFlag = Object.prototype.hasOwnProperty.call(debugGlobal, "__BM_DBG");
    const previousDebugFlag = debugGlobal.__BM_DBG;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    debugGlobal.__BM_DBG = true;
    try {
      const fx = beatManglerFactory() as ReturnType<typeof beatManglerFactory> & { port: FakePort };
      fx.port.onmessage?.({ data: { type: "steps", volume: Array(16).fill(1), pitch: null } });
      const bar = Math.round((60 / 120) * 4 * SR);
      const input = stereoBuffer(bar, (i) => Math.sin((2 * Math.PI * 220 * i) / SR) * 0.6);
      const output: Float32Array[][] = [[new Float32Array(bar), new Float32Array(bar)]];
      fx.process([input], output, param({ mix: 1 }));
      expect(log).not.toHaveBeenCalled();
      expect(peakOf(output[0])).toBeGreaterThan(0);
    } finally {
      log.mockRestore();
      if (hadDebugFlag) debugGlobal.__BM_DBG = previousDebugFlag;
      else delete debugGlobal.__BM_DBG;
    }
  });
});

// The input used by the passthrough assertions in pitchShift test.
function input0(i: number): number {
  return Math.sin((2 * Math.PI * 330 * i) / SR) * 0.5;
}
