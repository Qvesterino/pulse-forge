import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function boot(srcPath: string, scope: Record<string, unknown>): any {
  runInNewContext(readFileSync(srcPath, "utf8"), scope);
  return scope["pitchcorrect-processor"];
}

function renderRatio(proc: any, ratio: number, sr = 44100): Float32Array {
  const BLOCK = 128;
  const blocks = Math.ceil((sr * 1) / BLOCK);
  const out: number[] = [];
  const params = {
    amount: Float32Array.from([1]),
    speed: Float32Array.from([1]),
    root: Float32Array.from([0]),
    scaleMode: Float32Array.from([1]),
    mix: Float32Array.from([1]),
  };
  for (let b = 0; b < blocks; b++) {
    const inp = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) inp[i] = 0.5 * Math.sin((2 * Math.PI * 323.95 * (b * BLOCK + i)) / sr);
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    proc.process([[inp, inp]] as unknown, [[outL, outR]] as never, params);
    for (let i = 0; i < BLOCK; i++) out.push(outL[i]);
  }
  void ratio;
  return Float32Array.from(out);
}

function peakBin(out: Float32Array, sr: number, from: number, to: number): { hz: number; amp: number } {
  // coarse Goertzel sweep 300..350 Hz at 1 Hz
  const seg = out.slice(Math.floor(out.length * 0.5));
  let best = { hz: 0, amp: 0 };
  for (let f = from; f <= to; f++) {
    const k = (2 * Math.PI * f) / sr;
    const coeff = 2 * Math.cos(k);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < seg.length; i++) {
      const s0 = seg[i] + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const amp = Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / seg.length;
    if (amp > best.amp) best = { hz: f, amp };
  }
  return best;
}

describe("pitchCorrect rendering spectrum (diagnostic)", () => {
  it("renders and reports the spectral peak at ratio 1.0187", () => {
    const scope: Record<string, unknown> = {};
    runInNewContext(
      'this.AudioWorkletProcessor = class {}; this.registerProcessor = (name, p) => { this[name] = p; };',
      scope,
    );
    const Processor = boot("src/audio-worklets/pitchcorrect-processor.js", scope);
    const proc = new Processor({ processorOptions: {} });
    const out = renderRatio(proc, 1.0187);
    const peak = peakBin(out, 44100, 300, 350);
    console.log(`spectrum peak: ${peak.hz} Hz amp ${peak.amp.toFixed(4)}`);
    expect(peak.amp).toBeGreaterThan(0.01);
  });
});