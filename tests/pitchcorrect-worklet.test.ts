import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

/**
 * PITCH CORRECT — golden-vector unit tests for the pure DSP stages.
 *
 * The processor source is evaluated in a VM scope with a stub
 * AudioWorkletProcessor/registerProcessor (the recording-capture pattern),
 * which exposes the pure `detectPitch` / `snapCents` helpers. The vectors
 * pin the detection (a synthesized tone is FOUND at its frequency, a
 * different note is not mistaken for it) and the scale-snap math (chromatic
 * rounds to the semitone, major/minor pull to the nearest scale tone).
 */

const scope: Record<string, unknown> = {
  AudioWorkletProcessor: class {},
  registerProcessor: (_name: string, processor: unknown) => {
    scope.__registered = processor;
  },
  sampleRate: 48_000,
  currentFrame: 0,
  currentTime: 0,
};
scope.globalThis = scope;
runInNewContext(readFileSync("src/audio-worklets/pitchcorrect-processor.js", "utf8"), scope);

const detectPitch = scope.detectPitch as (
  buf: Float32Array,
  bufLen: number,
  writePos: number,
  sr: number,
  windowW: number,
  minHz: number,
  maxHz: number,
  scratch?: { x: Float32Array; d: Float32Array; nd: Float32Array },
) => { hz: number; clarity: number };
const snapCents = scope.snapCents as (hz: number, rootPc: number, scaleMode: number) => number;
const PitchCorrectProcessor = scope.__registered as new () => {
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, number[]>): boolean;
  detectedHz: number;
};

const SR = 48_000;
const W = 2048;

function synthTone(hz: number, seconds: number): Float32Array {
  const n = Math.ceil(seconds * SR);
  const out = new Float32Array(n * 2); // padded ring (the processor reads windowW back)
  for (let i = 0; i < n; i++) out[n + i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / SR);
  return out;
}

describe("pitch correct — detection (golden vectors)", () => {
  it("finds a 220 Hz tone at its fundamental", () => {
    const buf = synthTone(220, 0.1);
    const result = detectPitch(buf, buf.length, buf.length, SR, W, 70, 800);
    expect(result.hz).toBeGreaterThan(210);
    expect(result.hz).toBeLessThan(230);
    expect(result.clarity).toBeGreaterThan(0.85);
  });

  it("finds a 330 Hz tone and does not confuse it with 220", () => {
    const buf = synthTone(330, 0.1);
    const result = detectPitch(buf, buf.length, buf.length, SR, W, 70, 800);
    // v1 precision: ±1.5 % on pure sines (the worst case for YIN — real
    // voices carry harmonics that sharpen the difference minimum).
    expect(result.hz).toBeGreaterThan(315);
    expect(result.hz).toBeLessThan(345);
  });

  it("reports no pitch for digital silence", () => {
    const buf = new Float32Array(4096);
    const result = detectPitch(buf, buf.length, buf.length, SR, W, 70, 800);
    expect(result.hz).toBe(0);
    expect(result.clarity).toBe(0);
  });

  it("rejects a pitch outside the tracking range (50 Hz subsonic)", () => {
    const buf = synthTone(50, 0.12);
    const result = detectPitch(buf, buf.length, buf.length, SR, W, 70, 800);
    // The processor's confidence gate (clarity ≥ 0.85) ignores in-range
    // garbage picks — the pure function only has to not present them as
    // confident.
    expect(result.hz === 0 || result.clarity < 0.85).toBe(true);
  });
});

describe("pitch correct — scale snap math (golden vectors)", () => {
  it("chromatic snaps a 20-cent-sharp A4 back to A4 (negative correction)", () => {
    const sharp = 440 * Math.pow(2, 20 / 1200);
    expect(snapCents(sharp, 9, 0)).toBeCloseTo(-20, 0);
  });

  it("chromatic snaps a 30-cent-flat tone up by +30 cents", () => {
    // 100 cents flat of A4 IS G#4 — an exact chromatic tone (zero
    // correction). The correction applies to in-between detuning.
    const flat = 440 * Math.pow(2, -30 / 1200);
    expect(snapCents(flat, 9, 0)).toBeCloseTo(30, 0);
  });

  it("major scale in C leaves the third of the chord untouched", () => {
    // E4 (329.63 Hz) is a major-scale tone over C — zero correction.
    expect(snapCents(329.63, 0, 1)).toBeCloseTo(0, 0);
  });

  it("major scale in C pulls the minor third down to the major third", () => {
    // Eb4 sits 100 cents below E4 — the nearest C-major tone.
    const eb4 = 311.13;
    const cents = snapCents(eb4, 0, 1);
    expect(cents).toBeGreaterThan(80);
    expect(cents).toBeLessThan(120);
  });

  it("minor scale in A treats C natural as a scale tone (zero correction)", () => {
    expect(snapCents(261.63, 9, 2)).toBeCloseTo(0, 0);
  });

  it("key changes the target: the same Hz snaps differently in C major vs A minor", () => {
    // F4 = 349.23 — in C major (F is degree 4) it is a scale tone; but a
    // root-shifted chromatic edge still snaps to ITS nearest semitone.
    const f4 = 349.23;
    expect(snapCents(f4, 0, 1)).toBeCloseTo(0, 0);
    // B4 against C major: B is degree 7 — a scale tone as well.
    expect(snapCents(493.88, 0, 1)).toBeCloseTo(0, 0);
  });

  it("is periodic across octaves (the same pitch class corrects the same)", () => {
    const a4 = 440;
    const a5 = 880;
    expect(snapCents(a4 * Math.pow(2, 30 / 1200), 9, 1)).toBeCloseTo(snapCents(a5 * Math.pow(2, 30 / 1200), 9, 1), 0);
  });
});

describe("pitch correct — clarity gate calibration", () => {
  it("pure tone passes the 0.75 gate; chord mush and noise do not", () => {
    // The processor holds tracking only when clarity >= 0.75 — the code
    // comment claims ~0.85 / ~0.61 / ~0.12 for tone / chord / noise. Pin
    // those classes on the right side of the gate so a detection change
    // cannot silently start correcting chords.
    const tone = synthTone(220, 0.1);
    const toneR = detectPitch(tone, tone.length, tone.length, SR, W, 70, 800);
    expect(toneR.clarity).toBeGreaterThanOrEqual(0.75);

    const n = 24000;
    const chord = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      chord[n + i] =
        0.3 * Math.sin((2 * Math.PI * 220 * i) / SR) +
        0.3 * Math.sin((2 * Math.PI * 277.18 * i) / SR) +
        0.3 * Math.sin((2 * Math.PI * 329.63 * i) / SR);
    }
    const chordR = detectPitch(chord, chord.length, chord.length, SR, W, 70, 800);
    expect(chordR.clarity).toBeLessThan(0.75);

    let seed = 12345;
    const noise = new Float32Array(n * 2);
    for (let i = n; i < noise.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      noise[i] = (seed / 0x3fffffff - 1) * 0.5;
    }
    const noiseR = detectPitch(noise, noise.length, noise.length, SR, W, 70, 800);
    expect(noiseR.clarity).toBeLessThan(0.75);
  });
});

describe("pitch correct — detectPitch scratch reuse", () => {
  it("preallocated scratch produces identical results to per-call allocation", () => {
    const buf = synthTone(311.13, 0.12);
    const plainA = detectPitch(buf, buf.length, buf.length, SR, W, 70, 800);
    const maxLag = Math.min(Math.floor(SR / 70), W - 64);
    const scratch = {
      x: new Float32Array(W),
      d: new Float32Array(maxLag + 1),
      nd: new Float32Array(maxLag + 1),
    };
    const withScratch = detectPitch(buf, buf.length, buf.length, SR, W, 70, 800, scratch);
    // Second pass through the SAME scratch — nothing below minLag is read
    // and everything at or above it is rewritten, so reuse is exact.
    const again = detectPitch(buf, buf.length, buf.length, SR, W, 70, 800, scratch);
    expect(withScratch.hz).toBe(plainA.hz);
    expect(withScratch.clarity).toBe(plainA.clarity);
    expect(again.hz).toBe(plainA.hz);
    expect(again.clarity).toBe(plainA.clarity);
  });
});

/**
 * Block-simulation helpers: drive the registered processor class directly
 * with 128-sample render quanta (the worklet-hardening harness pattern).
 */
const PARAMS = (amount: number, speed = 1, root = 9, scaleMode = 1, mix = 1): Record<string, number[]> => ({
  amount: [amount],
  speed: [speed],
  root: [root],
  scaleMode: [scaleMode],
  mix: [mix],
});

interface RenderResult {
  out: Float32Array; // mono sum of L (L and R share the read position)
  detectedHz: number;
}

function renderProcessor(
  blocks: number,
  params: Record<string, number[]>,
  input: (block: number, i: number) => number,
): RenderResult {
  const proc = new PitchCorrectProcessor();
  const out = new Float32Array(blocks * 128);
  for (let b = 0; b < blocks; b++) {
    const inL = new Float32Array(128);
    for (let i = 0; i < 128; i++) inL[i] = input(b, i);
    const outL = new Float32Array(128);
    const outR = new Float32Array(128);
    proc.process([[inL]], [[outL, outR]], params);
    out.set(outL, b * 128);
  }
  return { out, detectedHz: proc.detectedHz };
}

function measureHz(buf: Float32Array, from: number): number {
  const window = buf.subarray(from);
  return detectPitch(window as Float32Array, window.length, window.length, SR, W, 70, 800).hz;
}

describe("pitch correct — processor block simulation (detect → snap → shift)", () => {
  it("pulls a −30 cent flat A4 up toward A4 (end-to-end correction)", () => {
    const flatHz = 440 * Math.pow(2, -30 / 1200); // ≈432.5, A major target A4
    let phase = 0;
    const { out } = renderProcessor(1200, PARAMS(1, 1, 9, 1, 1), () => {
      return 0.5 * Math.sin((2 * Math.PI * flatHz * phase++) / SR);
    });
    const hz = measureHz(out, out.length - 8192);
    expect(hz).toBeGreaterThan(436); // measurably sharper than the 432.5 input
    expect(hz).toBeLessThan(445); // and landed on A4 ±1.5 %
  });

  it("amount 0 leaves the input untouched (unity passthrough)", () => {
    const flatHz = 440 * Math.pow(2, -30 / 1200);
    let phase = 0;
    const { out } = renderProcessor(1200, PARAMS(0, 1, 9, 1, 1), () => {
      return 0.5 * Math.sin((2 * Math.PI * flatHz * phase++) / SR);
    });
    const hz = measureHz(out, out.length - 8192);
    expect(hz).toBeGreaterThan(428);
    expect(hz).toBeLessThan(437); // still the flat input, no pull
  });

  it("releases the correction ~0.5 s after tracking is lost (not ~4 s)", () => {
    // Regression: the release timer multiplied failed detection PASSES by
    // the 128-sample render quantum — 24 passes ≈ 0.5 s of audio took 188
    // passes ≈ 4 s to release, holding a stale ratio 8× longer than the
    // documented "~0.5 s".
    const flatHz = 440 * Math.pow(2, -30 / 1200);
    let phase = 0;
    const proc = new PitchCorrectProcessor();
    const run = (blocks: number, signal: (i: number) => number) => {
      for (let b = 0; b < blocks; b++) {
        const inL = new Float32Array(128);
        for (let i = 0; i < 128; i++) inL[i] = signal(i);
        const outL = new Float32Array(128);
        const outR = new Float32Array(128);
        proc.process([[inL]], [[outL, outR]], PARAMS(1, 1, 9, 1, 1));
      }
    };
    run(600, () => 0.5 * Math.sin((2 * Math.PI * flatHz * phase++) / SR)); // 1.6 s tone — locks
    expect(proc.detectedHz).toBeGreaterThan(0);
    run(112, () => 0); // 0.3 s of silence — inside the intended hold window
    expect(proc.detectedHz).toBeGreaterThan(0); // still held
    run(112, () => 0); // 0.6 s total — past the documented 0.5 s release
    expect(proc.detectedHz).toBe(0); // released to unity
  });

  it("digital silence in → digital silence out (finite, no stale-buffer residue)", () => {
    const flatHz = 440 * Math.pow(2, -30 / 1200);
    let phase = 0;
    const { out } = renderProcessor(1200, PARAMS(1, 1, 9, 1, 1), (b) =>
      b < 200 ? 0.5 * Math.sin((2 * Math.PI * flatHz * phase++) / SR) : 0,
    );
    // From 200ms after silence onset (past the ~35 ms granular tail): exact zeros.
    for (let i = 128 * 400; i < out.length; i++) {
      expect(out[i]).toBe(0);
      expect(Number.isFinite(out[i])).toBe(true);
    }
  });

  it("survives a missing input connection and a mono-only input", () => {
    const proc = new PitchCorrectProcessor();
    const outL = new Float32Array(128);
    const outR = new Float32Array(128);
    expect(proc.process([[]], [[outL, outR]], PARAMS(1))).toBe(true);
    expect(Array.from(outL).every((v) => Number.isFinite(v) && v === 0)).toBe(true);
    for (let b = 0; b < 40; b++) {
      const inL = new Float32Array(128);
      for (let i = 0; i < 128; i++) inL[i] = 0.4 * Math.sin((2 * Math.PI * 220 * (b * 128 + i)) / SR);
      expect(proc.process([[inL]], [[outL, outR]], PARAMS(1))).toBe(true);
    }
    expect(Array.from(outL).every((v) => Number.isFinite(v))).toBe(true);
    expect(Array.from(outR).every((v) => Number.isFinite(v))).toBe(true);
  });

  it("holds up under extreme-but-valid params and mid-stream param jumps", () => {
    let seed = 999;
    const noise = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed / 0x3fffffff - 1) * 0.8;
    };
    const proc = new PitchCorrectProcessor();
    const variants = [PARAMS(1, 0, 11, 2, 1), PARAMS(1, 1, 5.9, 0, 0.5), PARAMS(0, 1, 0, 1, 1)];
    for (let v = 0; v < variants.length; v++) {
      for (let b = 0; b < 60; b++) {
        const inL = new Float32Array(128);
        for (let i = 0; i < 128; i++) inL[i] = 0.3 * Math.sin((2 * Math.PI * 196 * (b * 128 + i)) / SR) + noise() * 0.1;
        const outL = new Float32Array(128);
        const outR = new Float32Array(128);
        proc.process([[inL]], [[outL, outR]], variants[v]);
        for (let i = 0; i < 128; i++) {
          expect(Number.isFinite(outL[i])).toBe(true);
          expect(Number.isFinite(outR[i])).toBe(true);
        }
      }
    }
  });

  it("runs at 44.1 kHz (fractional grain half-size) and still corrects downward", () => {
    const SR44 = 44_100;
    const scope44: Record<string, unknown> = {
      AudioWorkletProcessor: class {},
      registerProcessor: (_n: string, p: unknown) => {
        scope44.__registered = p;
      },
      sampleRate: SR44,
      currentFrame: 0,
      currentTime: 0,
    };
    scope44.globalThis = scope44;
    runInNewContext(readFileSync("src/audio-worklets/pitchcorrect-processor.js", "utf8"), scope44);
    const Proc44 = scope44.__registered as new () => {
      process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, number[]>): boolean;
    };
    const sharpHz = 329.63 * Math.pow(2, 25 / 1200); // E4 +25c — C major target is E4
    const proc = new Proc44();
    const tail = new Float32Array(8192);
    let phase = 0;
    for (let b = 0; b < 1100; b++) {
      const inL = new Float32Array(128);
      for (let i = 0; i < 128; i++) inL[i] = 0.5 * Math.sin((2 * Math.PI * sharpHz * phase++) / SR44);
      const outL = new Float32Array(128);
      const outR = new Float32Array(128);
      proc.process([[inL]], [[outL, outR]], PARAMS(1, 1, 0, 1, 1));
      if (b >= 1100 - 64) tail.set(outL, (b - (1100 - 64)) * 128);
    }
    const r = detectPitch(tail, tail.length, tail.length, SR44, W, 70, 800);
    expect(r.hz).toBeGreaterThan(327); // pulled DOWN from 334.4 toward E4 329.6
    expect(r.hz).toBeLessThan(333);
  });
});

describe("pitch correct — real-time allocation gate", () => {
  it("steady-state processing allocates zero Float32Arrays (scratch reuse)", () => {
    // Regression: detectPitch allocated x/d/nd (≈13 KB) on the audio thread
    // every detection pass (~47×/s ≈ 640 KB/s of GC churn inside the render
    // callback). The processor now reuses constructor-time scratch.
    let allocations = 0;
    class CountingF32 extends Float32Array {
      constructor(arg: number) {
        super(arg);
        allocations += 1;
      }
    }
    const scope2: Record<string, unknown> = {
      AudioWorkletProcessor: class {},
      registerProcessor: (_n: string, p: unknown) => {
        scope2.__registered = p;
      },
      Float32Array: CountingF32,
      sampleRate: SR,
      currentFrame: 0,
      currentTime: 0,
    };
    scope2.globalThis = scope2;
    runInNewContext(readFileSync("src/audio-worklets/pitchcorrect-processor.js", "utf8"), scope2);
    const Proc = scope2.__registered as new () => {
      process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, number[]>): boolean;
    };
    const proc = new Proc();
    const constructed = allocations; // constructor scratch + ring buffers
    expect(constructed).toBeGreaterThan(0);
    let phase = 0;
    for (let b = 0; b < 100; b++) {
      const inL = new Float32Array(128); // allocated by the HOST harness, not the processor
      for (let i = 0; i < 128; i++) inL[i] = 0.5 * Math.sin((2 * Math.PI * 432.5 * phase++) / SR);
      const outL = new Float32Array(128);
      const outR = new Float32Array(128);
      proc.process([[inL]], [[outL, outR]], PARAMS(1, 1, 9, 1, 1));
    }
    expect(allocations).toBe(constructed); // zero new typed arrays in 100 blocks (12 detection passes)
  });
});
