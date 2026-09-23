import { beforeAll, describe, expect, it } from "vitest";
import { FeatureExtractor } from "../src/effects/morph-dynamics-core/dsp/analysis";
import { GLOBAL_INPUT_GAIN_DB_ID } from "../src/effects/morph-dynamics-core/contracts/parameterIds";

interface MorphMeters {
  inputPeakDb: number;
  outputPeakDb: number;
  inputEnergy: number;
}

interface PostedMessage {
  type?: string;
}

class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  posted: PostedMessage[] = [];
  postMessage(message: unknown): void {
    this.posted.push(message as PostedMessage);
  }
}

class FakeAudioWorkletProcessor {
  port = new FakePort();
}

interface MorphWorklet {
  port: FakePort;
  proc: { getMeters(): MorphMeters };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

type MorphWorkletCtor = new (options?: { processorOptions?: { params?: Record<string, number> } }) => MorphWorklet;

let Processor!: MorphWorkletCtor;
let workletTime = 0;

beforeAll(async () => {
  const scope = globalThis as typeof globalThis & {
    sampleRate: number;
    AudioWorkletProcessor: unknown;
    registerProcessor: unknown;
  };
  scope.sampleRate = 48_000;
  scope.AudioWorkletProcessor = FakeAudioWorkletProcessor;
  scope.registerProcessor = (_name: string, ctor: MorphWorkletCtor) => {
    Processor = ctor;
  };
  Object.defineProperty(globalThis, "currentTime", {
    get: () => workletTime,
    configurable: true,
  });
  // @ts-expect-error worklet entry is JavaScript bundled for AudioWorkletGlobalScope
  await import("../src/effects/morph-dynamics-worklet.entry.js");
  if (!Processor) throw new Error("morphdynamics-processor did not register");
});

const BLOCK = 128;

function processSine(proc: MorphWorklet, sampleRate: number, blocks: number, amplitude = 0.2): number {
  let outputEnergy = 0;
  let outputSamples = 0;
  for (let block = 0; block < blocks; block++) {
    const inputL = new Float32Array(BLOCK);
    const inputR = new Float32Array(BLOCK);
    const outputL = new Float32Array(BLOCK);
    const outputR = new Float32Array(BLOCK);
    for (let frame = 0; frame < BLOCK; frame++) {
      const time = (block * BLOCK + frame) / sampleRate;
      const sample = amplitude * Math.sin(2 * Math.PI * 440 * time);
      inputL[frame] = sample;
      inputR[frame] = sample;
    }
    proc.process([[inputL, inputR]], [[outputL, outputR]]);
    for (let frame = 0; frame < BLOCK; frame++) {
      expect(Number.isFinite(outputL[frame])).toBe(true);
      expect(Number.isFinite(outputR[frame])).toBe(true);
      outputEnergy += outputL[frame] ** 2 + outputR[frame] ** 2;
      outputSamples += 2;
    }
    workletTime = ((block + 1) * BLOCK) / sampleRate;
  }
  return Math.sqrt(outputEnergy / Math.max(1, outputSamples));
}

function analyzeSingleChannel(frequency: number, channel: "left" | "right"): { body: number; texture: number } {
  const extractor = new FeatureExtractor();
  extractor.prepare(48_000, 1);
  let signals = extractor.processFrame(0, 0);
  for (let frame = 0; frame < 12_000; frame++) {
    const sample = 0.5 * Math.sin((2 * Math.PI * frequency * frame) / 48_000);
    signals = extractor.processFrame(channel === "left" ? sample : 0, channel === "right" ? sample : 0);
  }
  return { body: signals.body, texture: signals.texture };
}

describe("Morph Dynamics worklet and analysis", () => {
  it.each([44_100, 48_000, 96_000])("initializes finite DSP at the host sample rate (%i Hz)", (sampleRate) => {
    (globalThis as typeof globalThis & { sampleRate: number }).sampleRate = sampleRate;
    workletTime = 0;
    const proc = new Processor();
    proc.port.onmessage?.({ data: { type: "setMeters", enabled: true } });

    const rms = processSine(proc, sampleRate, 24);

    expect(rms).toBeGreaterThan(0.02);
    expect(proc.proc.getMeters().inputPeakDb).toBeGreaterThan(-25);
  });

  it("keeps control analysis live while skipping closed-panel meter work", () => {
    (globalThis as typeof globalThis & { sampleRate: number }).sampleRate = 48_000;
    workletTime = 0;
    const proc = new Processor();
    proc.port.onmessage?.({ data: { type: "setMeters", enabled: false } });

    processSine(proc, 48_000, 24);

    expect(proc.proc.getMeters().inputEnergy).toBeGreaterThan(0);
    expect(proc.proc.getMeters().inputPeakDb).toBe(-100);
    expect(proc.port.posted.some((message) => message.type === "meters")).toBe(false);
  });

  it("glides an input-gain change at the audio block rate instead of snapping", () => {
    (globalThis as typeof globalThis & { sampleRate: number }).sampleRate = 48_000;
    workletTime = 0;
    const proc = new Processor();
    proc.port.onmessage?.({ data: { type: "setMeters", enabled: true } });
    proc.port.onmessage?.({ data: { type: "param", id: GLOBAL_INPUT_GAIN_DB_ID, value: -60 } });

    processSine(proc, 48_000, 1);

    // The 30 ms smoother should still be near unity after its first 2.67 ms
    // update. A missing control-rate initialization snaps this below −70 dB.
    expect(proc.proc.getMeters().inputPeakDb).toBeGreaterThan(-25);
  });

  it("analyzes body and texture equally when audio is isolated to either channel", () => {
    const lowLeft = analyzeSingleChannel(180, "left");
    const lowRight = analyzeSingleChannel(180, "right");
    const highLeft = analyzeSingleChannel(8_000, "left");
    const highRight = analyzeSingleChannel(8_000, "right");

    expect(lowLeft.body).toBeGreaterThan(0.05);
    expect(lowRight.body).toBeCloseTo(lowLeft.body, 5);
    expect(highLeft.texture).toBeGreaterThan(0.05);
    expect(highRight.texture).toBeCloseTo(highLeft.texture, 5);
  });

  it("reports the character-oversampling latency and re-reports it when quality changes", () => {
    (globalThis as typeof globalThis & { sampleRate: number }).sampleRate = 48_000;
    workletTime = 0;
    const proc = new Processor();
    const latencyMessages = (): number | undefined => {
      const lat = [...proc.port.posted].reverse().find((m) => (m as { type?: string }).type === "latency");
      return (lat as { samples?: number } | undefined)?.samples;
    };
    // Fresh device: drive is 0 → the character stage hard-bypasses → no OS
    // delay yet. Raising drive engages the 2× halfband → 8 base samples.
    // The bypass state re-evaluates at block rate, so run a silent block
    // after the param before reading the reported latency.
    expect(latencyMessages()).toBe(0);
    proc.port.onmessage?.({ data: { type: "param", id: "char.drive", value: 70 } });
    processSine(proc, 48_000, 2);
    expect(latencyMessages()).toBe(8);
    // ECO drops the oversampling (and its delay) regardless of drive.
    proc.port.onmessage?.({ data: { type: "param", id: "global.quality", value: 0 } });
    processSine(proc, 48_000, 2);
    expect(latencyMessages()).toBe(0);
    proc.port.onmessage?.({ data: { type: "param", id: "global.quality", value: 1 } });
    processSine(proc, 48_000, 2);
    expect(latencyMessages()).toBe(8);
  });

  it("applies time-stamped params when the render clock reaches them (paramAt)", () => {
    (globalThis as typeof globalThis & { sampleRate: number }).sampleRate = 48_000;
    workletTime = 0;
    const proc = new Processor();
    const inputL = new Float32Array(BLOCK);
    const inputR = new Float32Array(BLOCK);
    const outputL = new Float32Array(BLOCK);
    const outputR = new Float32Array(BLOCK);
    const runBlock = (): number => {
      for (let frame = 0; frame < BLOCK; frame++) {
        const time = (workletTime * 48_000 + frame) / 48_000;
        const sample = 0.25 * Math.sin(2 * Math.PI * 440 * time);
        inputL[frame] = sample;
        inputR[frame] = sample;
      }
      proc.process([[inputL, inputR]], [[outputL, outputR]]);
      let sumSq = 0;
      for (let frame = 0; frame < BLOCK; frame++) sumSq += outputL[frame] ** 2;
      workletTime += BLOCK / 48_000;
      return Math.sqrt(sumSq / BLOCK);
    };
    runBlock();
    // Schedule a −24 dB output trim ~10 ms in the future.
    proc.port.onmessage?.({
      data: { type: "paramAt", id: "global.outputGainDb", value: -24, when: workletTime + 0.01 },
    });
    // Before `when`: level unchanged.
    let early = 0;
    for (let b = 0; b < 8; b++) early += runBlock();
    early /= 8;
    // After `when`: level trimmed (−24 dB ≈ ×0.063 linear). The 30 ms
    // output-gain smoother is still gliding right after `when`, so sample
    // only the LAST few blocks, past the glide.
    let late = 0;
    for (let b = 0; b < 24; b++) {
      const blockRms = runBlock();
      if (b >= 16) late += blockRms;
    }
    late /= 8;
    expect(early).toBeGreaterThan(0.12);
    // Relative assertion — the point is TIMING (the trim lands only after
    // `when`), not the exact smoothed level math.
    expect(late).toBeLessThan(early * 0.2);
  });

  it("stops rendering after dispose (process returns false, output silent)", () => {
    (globalThis as typeof globalThis & { sampleRate: number }).sampleRate = 48_000;
    workletTime = 0;
    const proc = new Processor();
    proc.port.onmessage?.({ data: { type: "dispose" } });
    const inputL = new Float32Array(BLOCK).fill(0.5);
    const inputR = new Float32Array(BLOCK).fill(0.5);
    const outputL = new Float32Array(BLOCK);
    const outputR = new Float32Array(BLOCK);
    expect(proc.process([[inputL, inputR]], [[outputL, outputR]])).toBe(false);
    expect(outputL[0]).toBe(0);
    expect(outputR[0]).toBe(0);
  });

  it("survives a MONO input (single channel) and folds the stereo result back — regression", () => {
    // Audit 12 P2: the core used to alias R onto L for mono input, so the
    // right-channel result overwrote the left mid-block. The worklet entry
    // always passes 2 channels, but the core contract must not corrupt the
    // caller's buffer when only one is supplied.
    (globalThis as typeof globalThis & { sampleRate: number }).sampleRate = 48_000;
    workletTime = 0;
    const proc = new Processor();
    let outL = new Float32Array(BLOCK);
    for (let block = 0; block < 40; block++) {
      const inputL = new Float32Array(BLOCK);
      for (let frame = 0; frame < BLOCK; frame++) {
        inputL[frame] = 0.3 * Math.sin(2 * Math.PI * 330 * ((block * BLOCK + frame) / 48_000));
      }
      const outputL = new Float32Array(BLOCK);
      const outputR = new Float32Array(BLOCK);
      proc.process([[inputL]], [[outputL, outputR]]); // mono: single input channel
      outL = outputL;
    }
    for (let i = 0; i < BLOCK; i++) {
      expect(Number.isFinite(outL[i])).toBe(true);
    }
    // The sine fed the whole time — the downmix must carry signal.
    let peak = 0;
    for (const v of outL) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.001);
  });

  it("handles a render quantum that is not 128 (chunked core loop)", () => {
    (globalThis as typeof globalThis & { sampleRate: number }).sampleRate = 48_000;
    workletTime = 0;
    const proc = new Processor();
    const frames = 37; // prime-sized quantum, deliberately != BLOCK
    for (let block = 0; block < 30; block++) {
      const inputL = new Float32Array(frames);
      const inputR = new Float32Array(frames);
      for (let frame = 0; frame < frames; frame++) {
        const time = (block * frames + frame) / 48_000;
        inputL[frame] = 0.25 * Math.sin(2 * Math.PI * 440 * time);
        inputR[frame] = inputL[frame];
      }
      const outputL = new Float32Array(frames);
      const outputR = new Float32Array(frames);
      proc.process([[inputL, inputR]], [[outputL, outputR]]);
      for (let i = 0; i < frames; i++) {
        expect(Number.isFinite(outputL[i])).toBe(true);
        expect(Number.isFinite(outputR[i])).toBe(true);
      }
    }
  });

  it("reads the external sidechain from node input 2 (inputs[1]) — regression", () => {
    // The feed used to be read from inputs[0][2+c] — channels that cannot
    // exist (explicit channelCount 2) — so dyn.sidechainExt ducked against
    // silence. A hot sidechain feed MUST duck the main path; a silent one
    // must not.
    (globalThis as typeof globalThis & { sampleRate: number }).sampleRate = 48_000;
    workletTime = 0;
    const scParams = {
      "macro.pressure": 0,
      "macro.punch": 0,
      "char.enabled": 0,
      "motion.enabled": 0,
      "space.enabled": 0,
      "dyn.sidechainExt": 1,
      "dyn.makeupAuto": 0,
      "dyn.thresholdDb": -20,
      "dyn.ratio": 6,
      "dyn.attackMs": 5,
      "dyn.releaseMs": 150,
    };
    const runWith = (scAmplitude: number): number => {
      const proc = new Processor();
      proc.port.onmessage?.({ data: { type: "params", params: scParams } });
      let sumSq = 0;
      let count = 0;
      for (let block = 0; block < 220; block++) {
        const inputL = new Float32Array(BLOCK);
        const inputR = new Float32Array(BLOCK);
        const scL = new Float32Array(BLOCK);
        const scR = new Float32Array(BLOCK);
        const outputL = new Float32Array(BLOCK);
        const outputR = new Float32Array(BLOCK);
        for (let frame = 0; frame < BLOCK; frame++) {
          const t = (block * BLOCK + frame) / 48_000;
          // Main: quiet sustained tone. Feed: loud tone driving the detector.
          inputL[frame] = 0.15 * Math.sin(2 * Math.PI * 220 * t);
          inputR[frame] = inputL[frame]!;
          scL[frame] = scAmplitude * Math.sin(2 * Math.PI * 55 * t);
          scR[frame] = scL[frame]!;
        }
        // Node wiring: inputs[0] = main (2ch), inputs[1] = sidechain (2ch).
        proc.process(
          [
            [inputL, inputR],
            [scL, scR],
          ],
          [[outputL, outputR]],
        );
        if (block >= 120) {
          for (let frame = 0; frame < BLOCK; frame++) sumSq += outputL[frame] ** 2 + outputR[frame] ** 2;
          count += 2 * BLOCK;
        }
      }
      return Math.sqrt(sumSq / count);
    };
    const ducked = runWith(0.5);
    const open = runWith(0);
    // 14 dB over threshold at 6:1 ≈ −12 dB GR on the feed — far more than
    // the old always-silent feed could ever produce.
    expect(ducked).toBeLessThan(open * 0.4);
    expect(open).toBeGreaterThan(0.1);
  });
});
