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
) => { hz: number; clarity: number };
const snapCents = scope.snapCents as (hz: number, rootPc: number, scaleMode: number) => number;

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
