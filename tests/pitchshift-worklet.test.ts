import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

/**
 * PITCH SHIFTER — transposition regression suite.
 *
 * The v1 grain engine anchored every grain with an absolute formula whose
 * anchors advance at rate 1 (no content ever skipped or repeated), so shifts
 * of roughly a semitone and less rendered UNSHIFTED — measured with Goertzel:
 * at +1 semitone the input bin carried 13× the energy of the target bin. The
 * two-tap engine (continuous per-tap delay evolving at 1−ratio, snapping only
 * at the tap's own window-zero grain start) makes the read rate exactly
 * `ratio` between snaps. These tests pin that contract pitch-independently
 * (the per-tap read-rate regression — immune to the inter-tap comb artifacts
 * inherent to granular shifting) plus spectral dominance at large shifts and
 * the unity bit-clean bypass.
 */

const SR = 48_000;
const H = Math.round((55 / 1000) * SR) / 2; // 1320

function makeProcessor(): any {
  const scope: Record<string, unknown> = {
    AudioWorkletProcessor: class {},
    registerProcessor: (_n: string, p: unknown) => {
      scope.__proc = p;
    },
    sampleRate: SR,
    currentFrame: 0,
    currentTime: 0,
  };
  scope.globalThis = scope;
  runInNewContext(readFileSync("src/audio-worklets/pitchshift-processor.js", "utf8"), scope);
  return scope.__proc;
}

const PARAMS = (semis: number): Record<string, Float32Array> => ({
  semitones: Float32Array.from([semis]),
  fine: Float32Array.from([0]),
  grainMs: Float32Array.from([55]),
  width: Float32Array.from([0.5]),
  mix: Float32Array.from([1]),
});

/** Render `blocks` 128-sample blocks of a tone; return mono out + processor. */
function render(semis: number, hz: number, blocks = 1200): { out: Float32Array; proc: any } {
  const proc = new (makeProcessor() as new () => any)();
  const out = new Float32Array(blocks * 128);
  let ph = 0;
  for (let b = 0; b < blocks; b++) {
    const inL = new Float32Array(128);
    for (let i = 0; i < 128; i++) inL[i] = 0.5 * Math.sin((2 * Math.PI * hz * ph++) / SR);
    const o = new Float32Array(128);
    const oR = new Float32Array(128);
    proc.process([[inL]], [[o, oR]], PARAMS(semis));
    out.set(o, b * 128);
  }
  return { out, proc };
}

function goertzel(buf: Float32Array, hz: number): number {
  const k = (2 * Math.PI * hz) / SR;
  const coeff = 2 * Math.cos(k);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const s0 = buf[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / (buf.length / 2);
}

describe("pitch shifter — transposition (regression: v1 rendered ≤1 st unshifted)", () => {
  it("each tap's read position advances at exactly `ratio` (engine contract)", () => {
    // Regression: v1's absolute-formula anchors advanced at rate 1.0000 no
    // matter the ratio — the engine contract below is what makes shifting
    // real. Measured per tap via a readAt wrapper (the pitch-independent
    // contract; spectral tests at ±1 st are comb-sensitive).
    for (const semis of [-1, 1]) {
      const proc = new (makeProcessor() as new () => any)();
      const ratio = Math.pow(2, semis / 12);
      const records: { A: number; pos: number; tap: number }[] = [];
      const orig = proc.readAt.bind(proc);
      proc.readAt = (pos: number, channel: number) => {
        // first L-call of each sample = grain k, second = grain k−1 (4
        // calls/sample: 2 grains × 2 channels, loop order k then k−1)
        records.push({ A: -1, pos, tap: -1 });
        return orig(pos, channel);
      };
      const total = 100_000;
      let ph = 0;
      for (let A = 0; A < total; A += 128) {
        const inL = new Float32Array(128);
        for (let i = 0; i < 128; i++) inL[i] = 0.5 * Math.sin((2 * Math.PI * 311.13 * ph++) / SR);
        const o = new Float32Array(128);
        const oR = new Float32Array(128);
        const before = records.length;
        proc.process([[inL]], [[o, oR]], PARAMS(semis));
        if (A >= total - 3 * 128) {
          for (let r = before; r < records.length; r++) {
            const callInBlock = r - before;
            const s = Math.floor(callInBlock / 4); // sample within block
            const grainCall = callInBlock % 4; // 0,1 = grain k; 2,3 = grain k−1
            if (grainCall % 2 !== 0) continue; // L-channel calls only
            const Aabs = A + s;
            const k = Math.floor(Aabs / H);
            records[r].A = Aabs;
            records[r].tap = grainCall < 2 ? k & 1 : 1 - (k & 1);
          }
        }
      }
      for (const tap of [0, 1]) {
        const pts = records.filter((r) => r.tap === tap && r.A >= total - 128);
        expect(pts.length).toBeGreaterThanOrEqual(64);
        const n = pts.length;
        const mA = pts.reduce((s, p) => s + p.A, 0) / n;
        const mP = pts.reduce((s, p) => s + p.pos, 0) / n;
        let num = 0;
        let den = 0;
        for (const p of pts) {
          num += (p.A - mA) * (p.pos - mP);
          den += (p.A - mA) ** 2;
        }
        const rate = num / den;
        expect(rate).toBeGreaterThan(ratio * 0.999);
        expect(rate).toBeLessThan(ratio * 1.001);
      }
    }
  });

  it("never reads ahead of the write line (defense invariant)", () => {
    const proc = new (makeProcessor() as new () => any)();
    let maxRead = -Infinity;
    const orig = proc.readAt.bind(proc);
    proc.readAt = (pos: number, channel: number) => {
      if (channel === 0 && pos > maxRead) maxRead = pos;
      return orig(pos, channel);
    };
    let ph = 0;
    for (let b = 0; b < 400; b++) {
      const inL = new Float32Array(128);
      for (let i = 0; i < 128; i++) inL[i] = 0.5 * Math.sin((2 * Math.PI * 196 * ph++) / SR);
      const o = new Float32Array(128);
      const oR = new Float32Array(128);
      proc.process([[inL]], [[o, oR]], PARAMS(7)); // aggressive up-shift
      expect(maxRead).toBeLessThanOrEqual(proc.writePos);
    }
  });

  it("+12 semitones: the octave-up bin dominates the input bin", () => {
    const { out } = render(12, 311.13);
    const tail = out.subarray(out.length - 16384);
    const target = goertzel(tail, 622.25);
    const input = goertzel(tail, 311.13);
    expect(target).toBeGreaterThan(input * 3);
  });

  it("−12 semitones: the octave-down bin dominates the input bin", () => {
    const { out } = render(-12, 311.13);
    const tail = out.subarray(out.length - 16384);
    const target = goertzel(tail, 155.56);
    const input = goertzel(tail, 311.13);
    expect(target).toBeGreaterThan(input * 3);
  });

  it("0 semitones is a bit-clean passthrough (unity bypass)", () => {
    const proc = new (makeProcessor() as new () => any)();
    let ph = 0;
    for (let b = 0; b < 200; b++) {
      const inL = new Float32Array(128);
      for (let i = 0; i < 128; i++) inL[i] = 0.5 * Math.sin((2 * Math.PI * 220 * ph++) / SR);
      const o = new Float32Array(128);
      const oR = new Float32Array(128);
      proc.process([[inL]], [[o, oR]], PARAMS(0));
      for (let i = 0; i < 128; i++) {
        expect(o[i]).toBe(inL[i]);
        expect(oR[i]).toBe(inL[i]);
      }
    }
  });

  it("deterministic: identical input renders identical output", () => {
    const a = render(3, 311.13, 400).out;
    const b = render(3, 311.13, 400).out;
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]);
  });

  it("digital silence in → silence out, all finite", () => {
    const { out } = render(5, 0, 400);
    for (let i = 128 * 300; i < out.length; i++) {
      expect(Number.isFinite(out[i])).toBe(true);
      expect(out[i]).toBe(0);
    }
  });
});
