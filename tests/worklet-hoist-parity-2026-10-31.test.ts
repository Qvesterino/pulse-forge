import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * WORKLET HOIST PARITY (audit 2026-10-30/31, follow-up to the sidechain/gate
 * hoists): the reverb and wtvoice processors had per-sample recomputation of
 * block- and voice-INVARIANT math (comb geometry, `pow(2, detune/1200)` per
 * unison copy per sample, `pow(10, level/20)` per voice per sample, envelope
 * coefficients, LFO rate operands). The hoists must be bit-identical:
 *
 *   - reverb: verified against an INLINE REFERENCE of the previous
 *     per-sample loop (copied verbatim below) — the drift SINS stay
 *     per-sample (they ride modPhase); only their constant operands moved
 *     to the constructor.
 *   - wtvoice: the caches are invalidated AT THE PARAM/TABLES/NOTE EVENT
 *     SITE (applyParam / refreshCopies / release), so a queued param event
 *     landing MID-BLOCK retargets exactly at its own sample. The scenario
 *     below exercises that (a `level` change at 9 ms, mid-block) and pins
 *     the output as golden checksums + sentinel samples generated from the
 *     PRE-hoist implementation (git 50edbfcf) — a golden vector, not a
 *     self-check.
 *
 * The `outputs` shape note from the sidechain/gate parity file applies:
 * `outputs` is an array of OUTPUTS, each an array of CHANNELS.
 */

const WORKLET_DIR = resolve(__dirname, "../src/audio-worklets");
const SR = 48000;

function loadProcessorClass(file: string): new () => {
  process: (inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) => boolean;
} {
  const source = readFileSync(resolve(WORKLET_DIR, file), "utf8");
  const registered: Array<new () => unknown> = [];
  const host = new Function("registerProcessor", "AudioWorkletProcessor", "globalThis", source);
  host(
    (_name: string, Class: new () => unknown) => registered.push(Class),
    class {
      port = { postMessage: () => {} };
    },
    globalThis,
  );
  if (registered.length === 0) throw new Error(`${file} registered no processor`);
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
  return registered[registered.length - 1] as never;
}

function fnv32(arr: Float32Array): string {
  let h = 0x811c9dc5;
  const dv = new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
  for (let i = 0; i < dv.byteLength; i++) {
    h ^= dv.getUint8(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function seededNoise(seed: number, length: number, scale: number): Float32Array {
  const out = new Float32Array(length);
  let s = seed >>> 0;
  for (let i = 0; i < length; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    out[i] = ((s / 0xffffffff) * 2 - 1) * scale;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reverb — inline reference of the PREVIOUS per-sample implementation.
// ---------------------------------------------------------------------------

const REVERB_COMB_DELAYS = [1557, 1617, 1491, 1422];
const ALLPASS_DELAYS = [556, 441];

class ReverbReference {
  combFeedback = [0.7, 0.7, 0.7, 0.7];
  combBufs = REVERB_COMB_DELAYS.map(() => [new Float32Array(8192), new Float32Array(8192)]);
  combIdx = [0, 0, 0, 0];
  combDampL = [0, 0, 0, 0];
  combDampR = [0, 0, 0, 0];
  apBufs = ALLPASS_DELAYS.map(() => [new Float32Array(2048), new Float32Array(2048)]);
  apIdx = [0, 0];
  outLpL = 0;
  outLpR = 0;
  modPhase = 0;

  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const outL = output[0];
    const outR = output.length > 1 && output[1] ? output[1] : null;
    const input = inputs[0];
    const inL = input && input[0] && input[0].length ? input[0] : null;
    const inR = input && input.length > 1 && input[1] && input[1].length ? input[1] : null;
    if (!inL && !inR) {
      for (let i = 0; i < outL.length; i++) {
        outL[i] = 0;
        if (outR) outR[i] = 0;
      }
      return true;
    }
    const len = outL.length;
    const sr = (globalThis as { sampleRate?: number }).sampleRate || 44100;
    const decay = Math.max(0.1, Math.min(20, parameters.decay[0]!));
    const dampingFreq = Math.max(200, Math.min(18000, parameters.damping ? parameters.damping[0]! : 6000));
    const diffusion = Math.max(0, Math.min(1, parameters.diffusion ? parameters.diffusion[0]! : 0.5));
    const toneFreq = Math.max(200, Math.min(18000, parameters.tone ? parameters.tone[0]! : 9000));
    const dampAlpha = 1 - Math.exp((-2 * Math.PI * dampingFreq) / sr);
    const toneAlpha = 1 - Math.exp((-2 * Math.PI * toneFreq) / sr);
    for (let c = 0; c < 4; c++) {
      const ms = ((REVERB_COMB_DELAYS[c]! * sr) / 48000 / sr) * 1000;
      this.combFeedback[c] = Math.min(0.995, Math.pow(10, (-3 * ms) / (decay * 1000)));
    }
    const combFeedback = this.combFeedback;
    const apFeedback = 0.3 + diffusion * 0.4;
    const modDepth = Math.max(0, Math.min(1, parameters.mod ? parameters.mod[0]! : 0.35)) * 0.03;
    const modRateRad = (2 * Math.PI * 0.5) / sr;
    const mask = this.combBufs[0]![0]!.length - 1;
    const apMask = 2047;

    for (let i = 0; i < len; i++) {
      let l = inL ? inL[i]! : 0;
      let r = inR ? inR[i]! : l;
      if (!Number.isFinite(l)) l = 0;
      if (!Number.isFinite(r)) r = 0;
      let sumL = 0;
      let sumR = 0;
      this.modPhase += modRateRad;
      if (this.modPhase > 2 * Math.PI) this.modPhase -= 2 * Math.PI;
      for (let c = 0; c < 4; c++) {
        const delaySamples = (REVERB_COMB_DELAYS[c]! * sr) / 48000;
        const fb = combFeedback[c]!;
        const detuneL = 1 - 0.01 * (c % 2 === 0 ? 1 : -1) * 0.5;
        const detuneR = 1 + 0.01 * (c % 2 === 0 ? 1 : -1) * 0.5;
        const driftL = 1 + modDepth * Math.sin(this.modPhase * (1 + c * 0.13) + c * 1.7);
        const driftR = 1 + modDepth * Math.sin(this.modPhase * (1.21 + c * 0.11) + c * 2.3 + 1.1);
        const readL = this.readComb(c, 0, delaySamples * detuneL * driftL, mask);
        const readR = this.readComb(c, 1, delaySamples * detuneR * driftR, mask);
        this.combDampL[c]! += dampAlpha * (readL - this.combDampL[c]!);
        this.combDampR[c]! += dampAlpha * (readR - this.combDampR[c]!);
        if (Math.abs(this.combDampL[c]!) < 1e-20) this.combDampL[c] = 0;
        if (Math.abs(this.combDampR[c]!) < 1e-20) this.combDampR[c] = 0;
        const dampL = this.combDampL[c]!;
        const dampR = this.combDampR[c]!;
        const wL = l + dampL * fb;
        const wR = r + dampR * fb;
        this.writeComb(c, 0, wL, mask);
        this.writeComb(c, 1, wR, mask);
        sumL += dampL;
        sumR += dampR;
      }
      sumL *= 0.25;
      sumR *= 0.25;
      let apL = this.processAllpass(0, 0, sumL, ALLPASS_DELAYS[0]!, apFeedback, apMask);
      let apR = this.processAllpass(0, 1, sumR, ALLPASS_DELAYS[0]!, apFeedback, apMask);
      apL = this.processAllpass(1, 0, apL, ALLPASS_DELAYS[1]!, apFeedback, apMask);
      apR = this.processAllpass(1, 1, apR, ALLPASS_DELAYS[1]!, apFeedback, apMask);
      outL[i] = this.outLpL = this.outLpL + toneAlpha * (apL - this.outLpL);
      if (outR) outR[i] = this.outLpR = this.outLpR + toneAlpha * (apR - this.outLpR);
      if (Math.abs(this.outLpL) < 1e-20) this.outLpL = 0;
      if (Math.abs(this.outLpR) < 1e-20) this.outLpR = 0;
    }
    return true;
  }

  readComb(combIdx: number, ch: number, delaySamples: number, mask: number): number {
    const idx = this.combIdx[combIdx]!;
    const pos = idx - delaySamples;
    const i0 = Math.floor(pos) & mask;
    const i1 = (i0 + 1) & mask;
    const frac = pos - Math.floor(pos);
    const buf = this.combBufs[combIdx]![ch]!;
    return buf[i0]! * (1 - frac) + buf[i1]! * frac;
  }

  writeComb(combIdx: number, ch: number, value: number, mask: number): void {
    const buf = this.combBufs[combIdx]![ch]!;
    const idx = this.combIdx[combIdx]! & mask;
    buf[idx] = value;
    if (ch === 1) this.combIdx[combIdx] = (this.combIdx[combIdx]! + 1) & mask;
  }

  processAllpass(
    apIdx: number,
    ch: number,
    input: number,
    delaySamples: number,
    feedback: number,
    apMask: number,
  ): number {
    const buf = this.apBufs[apIdx]![ch]!;
    const idx = this.apIdx[apIdx]!;
    const readPos = idx - delaySamples;
    const i0 = Math.floor(readPos) & apMask;
    const i1 = (i0 + 1) & apMask;
    const frac = readPos - Math.floor(readPos);
    const delayed = buf[i0]! * (1 - frac) + buf[i1]! * frac;
    const output = -feedback * input + delayed;
    buf[idx & apMask] = input + feedback * delayed;
    if (ch === 1) this.apIdx[apIdx] = (this.apIdx[apIdx]! + 1) & apMask;
    if (Math.abs(output) < 1e-20) return 0;
    return output;
  }
}

describe("worklet hoist parity 2026-10-31 — reverb", () => {
  const BLOCKS = 30;

  function runReverb(processor: {
    process: (inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) => boolean;
  }): { L: Float32Array; R: Float32Array } {
    const params = {
      decay: new Float32Array([2.2]),
      damping: new Float32Array([4500]),
      diffusion: new Float32Array([0.6]),
      tone: new Float32Array([8000]),
      mod: new Float32Array([0.6]),
    };
    const L = new Float32Array(BLOCKS * 128);
    const R = new Float32Array(BLOCKS * 128);
    for (let b = 0; b < BLOCKS; b++) {
      const inL = new Float32Array(128);
      if (b < 4) inL.set(seededNoise(12345 + b, 128, 0.5));
      const channels = [new Float32Array(128), new Float32Array(128)];
      processor.process([[inL, inL]], [channels], params);
      L.set(channels[0]!, b * 128);
      R.set(channels[1]!, b * 128);
    }
    return { L, R };
  }

  it("hoisted comb geometry is bit-identical to the per-sample reference (30 blocks, wet tail fully developed)", () => {
    const Reference = new ReverbReference();
    const UnderTest = new (loadProcessorClass("reverb-processor.js"))();
    const ref = runReverb(Reference);
    const got = runReverb(UnderTest);
    // Sanity: the scenario actually reaches the wet signal (comb delay
    // ≈ 1557 samples at 48k — a too-short scenario would compare zeros).
    expect(Math.max(...ref.L)).toBeGreaterThan(0.05);
    for (let i = 0; i < ref.L.length; i++) {
      expect(got.L[i]).toBe(ref.L[i]);
      expect(got.R[i]).toBe(ref.R[i]);
    }
  });

  it("stays bit-identical with the mod depth pinned to 0 and full", () => {
    for (const mod of [0, 1]) {
      const params = {
        decay: new Float32Array([1.4]),
        damping: new Float32Array([9000]),
        diffusion: new Float32Array([0.2]),
        tone: new Float32Array([12000]),
        mod: new Float32Array([mod]),
      };
      const Reference = new ReverbReference();
      const UnderTest = new (loadProcessorClass("reverb-processor.js"))();
      for (let b = 0; b < 8; b++) {
        const inL = b < 2 ? seededNoise(77 + b, 128, 0.6) : new Float32Array(128);
        const refOut = [new Float32Array(128), new Float32Array(128)];
        const gotOut = [new Float32Array(128), new Float32Array(128)];
        Reference.process([[inL, inL]], [refOut], params);
        UnderTest.process([[inL, inL]], [gotOut], params);
        for (let i = 0; i < 128; i++) {
          expect(gotOut[0]![i]).toBe(refOut[0]![i]);
          expect(gotOut[1]![i]).toBe(refOut[1]![i]);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// wtvoice — golden vector generated from the PRE-hoist implementation.
// ---------------------------------------------------------------------------

interface WtProcessor {
  handleMessage(msg: Record<string, unknown>): void;
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, never>): boolean;
}

function runWtScenario(processor: WtProcessor): { L: Float32Array; R: Float32Array } {
  const frames: Float32Array[] = [];
  for (let j = 0; j < 4; j++) {
    const f = new Float32Array(16);
    for (let k = 0; k < 16; k++) f[k] = Math.sin((2 * Math.PI * (j + 1) * k) / 16);
    frames.push(f);
  }
  processor.handleMessage({ type: "tables", levels: [frames], ks: [1] });
  processor.handleMessage({ type: "param", name: "attack", value: 0.05 });
  processor.handleMessage({ type: "noteOn", pitch: 60, velocity: 0.9, when: 0, releaseVelocity: 0.7, pan: -0.3 });
  // A queued param landing MID-BLOCK (9 ms is inside block 3): the event-sited
  // cache invalidation must retarget the amp exactly at its own sample.
  processor.handleMessage({ type: "param", name: "level", value: -12, when: 0.009 });
  processor.handleMessage({ type: "noteOff", pitch: 60, when: 0.02 });
  const L = new Float32Array(12 * 128);
  const R = new Float32Array(12 * 128);
  const globalTime = globalThis as unknown as { currentTime: number };
  for (let b = 0; b < 12; b++) {
    globalTime.currentTime = (b * 128) / SR;
    const channels = [new Float32Array(128), new Float32Array(128)];
    processor.process([], [channels], {});
    L.set(channels[0]!, b * 128);
    R.set(channels[1]!, b * 128);
  }
  return { L, R };
}

describe("worklet hoist parity 2026-10-31 — wtvoice golden vector", () => {
  // Generated 2026-10-31 from git 50edbfcf's implementation (BEFORE the
  // per-sample hoists) over the scenario above: unison 2, LFO morph+cutoff
  // mod, morph wobble, scan, sub, SVF, stereo pan, mid-block param event,
  // mid-block noteOff. The hoist must reproduce these EXACTLY.
  const GOLDEN = {
    l: "7fe4127d",
    r: "7b44ff61",
    sentinelsL: [
      0.00008304962830152363, -0.018639570102095604, -0.22411973774433136, 0.04618768393993378, 0.17719772458076477,
      -0.25896021723747253, 0.37280941009521484,
    ],
    sentinelIdx: [0, 100, 431, 432, 959, 960, 1400],
  };

  it("reproduces the pre-hoist output sample-exactly (checksums + sentinels)", () => {
    (globalThis as unknown as { currentTime: number }).currentTime = 0;
    const Wt = loadProcessorClass("wtvoice-processor.js") as unknown as new () => WtProcessor;
    const { L, R } = runWtScenario(new Wt());
    // Sanity: the scenario actually produces sound.
    expect(Math.max(...L)).toBeGreaterThan(0.1);
    expect(fnv32(L)).toBe(GOLDEN.l);
    expect(fnv32(R)).toBe(GOLDEN.r);
    GOLDEN.sentinelsL.forEach((value, k) => {
      expect(L[GOLDEN.sentinelIdx[k]!]!).toBe(value);
    });
  });
});
