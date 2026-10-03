import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

/**
 * Block-by-block simulation of the pitchCorrect processor at the offline
 * render rate (128-sample blocks, 44.1 kHz) — the rendering contract the
 * golden vectors cannot cover (they test the pure math on whole buffers).
 *
 * The v1 rendering gap (near-unity corrections rendered unshifted — the
 * granular anchors advanced at rate 1) is CLOSED: the two-tap engine now
 * evolves each tap's read delay continuously at (1 - ratio) per sample and
 * snaps only at the tap's own window-zero grain start, so the correction is
 * audible in the rendered spectrum (target bin dominates the off-key bin).
 * The browser check for the audible correction was un-parked with it.
 */

function bootProcessor(srcPath: string, scope: Record<string, unknown>): any {
  runInNewContext(readFileSync(srcPath, "utf8"), scope);
  return scope[srcPath.endsWith("pitchshift-processor.js") ? "pitchshift-processor" : "pitchcorrect-processor"];
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
  let s1 = 0,
    s2 = 0;
  for (let i = 0; i < seg.length; i++) {
    const s0 = seg[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / seg.length;
}

describe("pitchCorrect block simulation (44100, offline-like)", () => {
  it("detects the input pitch and decides the E4 snap target", () => {
    const scope: Record<string, unknown> = {};
    runInNewContext(
      "this.AudioWorkletProcessor = class {}; this.registerProcessor = (name, p) => { this[name] = p; };",
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
    void out; // the decision contract asserts proc state — the render warms the ring
    // The decision contract: the detector pins the input pitch (±6 cents —
    // the pure-sine worst case for YIN) and the ratio encodes the snap.
    expect(proc.detectedHz).toBeGreaterThan(318);
    expect(proc.detectedHz).toBeLessThan(330);
    expect(proc.clarity).toBeGreaterThan(0.75);
    // 323.95 Hz → midi 63.68 → nearest C-major tone E4 (64) → +32 cents.
    const expectedRatio = Math.pow(2, 32 / 1200);
    expect(proc.ratioSmooth).toBeGreaterThan(expectedRatio * 0.999);
    expect(proc.ratioSmooth).toBeLessThan(expectedRatio * 1.001);
  });

  // The rendering contract (previously the KNOWN v1 GAP, skipped): the E4
  // target bin must dominate the off-key bin in the rendered spectrum.
  it("renders the correction: the E4 target bin dominates the off-key bin", () => {
    const scope: Record<string, unknown> = {};
    runInNewContext(
      "this.AudioWorkletProcessor = class {}; this.registerProcessor = (name, p) => { this[name] = p; };",
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
    expect(target).toBeGreaterThan(off);
  });
});
