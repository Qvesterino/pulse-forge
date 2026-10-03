import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

/**
 * Block-by-block simulation of the pitchCorrect processor at the offline
 * render rate (128-sample blocks, 44.1 kHz) — the rendering contract the
 * golden vectors cannot cover (they test the pure math on whole buffers).
 * Regression-locked: the first browser check used Eb4 as the test tone —
 * EXACTLY between D4 and E4 in C major (a nearest-tone tie) — and the flat
 * v1 detection resolved the tie toward D4, hiding a working corrector.
 * The simulation reproduces that class of failure in vitest, no browser.
 */

function bootProcessor(srcPath: string, scope: Record<string, unknown>): any {
  runInNewContext(readFileSync(srcPath, "utf8"), scope);
  return scope["pitchcorrect-processor"];
}

function render(proc: any, params: Record<string, Float32Array>, sr: number): number[] {
  const BLOCK = 128;
  const blocks = Math.ceil((sr * 1) / BLOCK);
  const out: number[] = [];
  for (let b = 0; b < blocks; b++) {
    const inp = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      inp[i] = 0.5 * Math.sin((2 * Math.PI * 323.95 * (b * BLOCK + i)) / sr); // E4 − 30 cents
    }
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    proc.process([[inp, inp]] as unknown, [[outL, outR]] as never, params);
    for (let i = 0; i < BLOCK; i++) out.push(outL[i]);
  }
  return out;
}

function binPower(out: number[], freq: number, sr: number): number {
  const seg = out.slice(Math.floor(out.length * 0.5));
  const k = (2 * Math.PI * freq) / sr;
  const coeff = 2 * Math.cos(k);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < seg.length; i++) {
    const s0 = seg[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / seg.length;
}

function zeroCrossHz(out: number[], sr: number): number {
  const seg = out.slice(Math.floor(out.length * 0.75));
  let crossings = 0;
  for (let i = 1; i < seg.length; i++) {
    if (seg[i - 1] < 0 && seg[i] >= 0) crossings += 1;
  }
  return (crossings * sr) / seg.length;
}

describe("pitchCorrect block simulation (44100, offline-like)", () => {
  it("snaps an E4−30c tone onto E4 through 128-sample blocks", () => {
    const scope: Record<string, unknown> = {};
    runInNewContext(
      'this.AudioWorkletProcessor = class {}; this.registerProcessor = (name, p) => { this[name] = p; };',
      scope,
    );
    const Processor = bootProcessor("src/audio-worklets/pitchcorrect-processor.js", scope);
    const proc = new Processor({ processorOptions: {} });
    const out = render(
      proc,
      {
        amount: Float32Array.from([1]),
        speed: Float32Array.from([1]),
        root: Float32Array.from([0]),
        scaleMode: Float32Array.from([1]),
        mix: Float32Array.from([1]),
      },
      44_100,
    );
    const off = binPower(out, 323.95, 44_100);
    const target = binPower(out, 329.63, 44_100);
    // RETUNE 1 must move the spectral peak onto the E4 target.
    expect(target).toBeGreaterThan(off);
  });

  it("the engine shifts at a LARGE correction too (+234 cents, root F#)", () => {
    const scope: Record<string, unknown> = {};
    runInNewContext(
      'this.AudioWorkletProcessor = class {}; this.registerProcessor = (name, p) => { this[name] = p; };',
      scope,
    );
    const Processor = bootProcessor("src/audio-worklets/pitchcorrect-processor.js", scope);
    const proc = new Processor({ processorOptions: {} });
    const out = render(
      proc,
      {
        amount: Float32Array.from([1]),
        speed: Float32Array.from([1]),
        root: Float32Array.from([6]), // F# — pulls the 323.95 Hz input +234 cents up to F#4
        scaleMode: Float32Array.from([1]),
        mix: Float32Array.from([1]),
      },
      44_100,
    );
    const outputHz = zeroCrossHz(out, 44_100);
    console.log(`big-ratio output pitch ≈ ${outputHz.toFixed(1)} Hz (input 323.95, target 369.99)`);
    // A +234 cent correction on 323.95 Hz must land near F#4 (369.99 Hz),
    // far from the input pitch.
    expect(outputHz).toBeGreaterThan(340);
  });
});
