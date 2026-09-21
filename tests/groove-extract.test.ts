/**
 * Groove extraction — "steal the groove" from an imported loop.
 *
 * `extractGroove` is pure math on top of the shared transient detector. The
 * output is three parallel arrays (timing, accent, swing) consumed by the
 * pattern editor's microtiming and velocity lanes. The interesting
 * edge cases are the early-return guards and the −1..1 timing clamp.
 */
import { describe, expect, it } from "vitest";
import { extractGroove } from "../src/audio-engine/groove-extract";

const SR = 44100;

function makeClickTrack(bpm: number, seconds: number, subdivision = 1): Float32Array {
  const n = Math.floor(SR * seconds);
  const out = new Float32Array(n);
  const beatSec = 60 / bpm;
  const stepSec = beatSec / subdivision;
  for (let t = 0; t < seconds; t += stepSec) {
    const start = Math.round(t * SR);
    for (let i = 0; i < Math.floor(SR * 0.025); i++) {
      const idx = start + i;
      if (idx >= n) break;
      out[idx] += Math.sin((2 * Math.PI * 1000 * i) / SR) * Math.exp(-i / (SR * 0.004));
    }
  }
  return out;
}

describe("extractGroove — happy path", () => {
  it("returns a 16-step timing/accent map and a swing hint for a steady kick loop", () => {
    const map = extractGroove(makeClickTrack(120, 8), SR, 120);
    expect(map).not.toBeNull();
    expect(map!.timing).toHaveLength(16);
    expect(map!.accent).toHaveLength(16);
    expect(map!.swing).toBeGreaterThanOrEqual(0);
    expect(map!.swing).toBeLessThanOrEqual(1);
  });

  it("all timing values stay inside the −1..1 range even on a swung input", () => {
    // A loop with the offbeat 16ths pushed 1/3 step late should saturate
    // the timing array toward +1 on the offbeat slots. The clamp must
    // prevent overflow — a regression that dropped the clamp would push
    // ±∞ into stepMeta.microtiming and silently flip the swing direction.
    const map = extractGroove(makeClickTrack(120, 8, 2), SR, 120, 16);
    expect(map).not.toBeNull();
    for (const t of map!.timing) {
      expect(t).toBeGreaterThanOrEqual(-1);
      expect(t).toBeLessThanOrEqual(1);
    }
  });

  it("accents are normalised to 0..1 (relative to the loop's loudest attack)", () => {
    const map = extractGroove(makeClickTrack(120, 8), SR, 120);
    expect(map).not.toBeNull();
    for (const a of map!.accent) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
    }
    // The loudest frame must reach near-1 (it's the anchor that defines
    // the normalisation). A regression that forgot to divide would clip
    // every accent to a small value.
    expect(Math.max(...map!.accent)).toBeGreaterThan(0.9);
  });

  it("steps parameter changes the output width (chop into 32 instead of 16)", () => {
    const map = extractGroove(makeClickTrack(120, 8), SR, 120, 32);
    expect(map).not.toBeNull();
    expect(map!.timing).toHaveLength(32);
    expect(map!.accent).toHaveLength(32);
  });

  it("is deterministic (same input → same output)", () => {
    const data = makeClickTrack(124, 6);
    const a = extractGroove(data, SR, 124);
    const b = extractGroove(data, SR, 124);
    expect(a).toEqual(b);
  });
});

describe("extractGroove — input guards (null returns)", () => {
  it("returns null for sampleRate = 0 (would divide by zero in stepSec)", () => {
    expect(extractGroove(makeClickTrack(120, 4), 0, 120)).toBeNull();
  });

  it("returns null for sampleRate = NaN or Infinity", () => {
    expect(extractGroove(makeClickTrack(120, 4), NaN, 120)).toBeNull();
    expect(extractGroove(makeClickTrack(120, 4), Infinity, 120)).toBeNull();
    expect(extractGroove(makeClickTrack(120, 4), -Infinity, 120)).toBeNull();
  });

  it("returns null for BPM = 0 or negative", () => {
    expect(extractGroove(makeClickTrack(120, 4), SR, 0)).toBeNull();
    expect(extractGroove(makeClickTrack(120, 4), SR, -120)).toBeNull();
  });

  it("returns null for BPM = NaN or Infinity (poisoned tempo)", () => {
    expect(extractGroove(makeClickTrack(120, 4), SR, NaN)).toBeNull();
    expect(extractGroove(makeClickTrack(120, 4), SR, Infinity)).toBeNull();
  });

  it("returns null for a buffer shorter than 0.5× sampleRate seconds", () => {
    // The detector needs at least 4 onsets → 4 stepSec of material.
    // Anything shorter is rejected before the transient scan wastes time.
    expect(extractGroove(makeClickTrack(120, 0.1), SR, 120)).toBeNull();
  });

  it("returns null for silence (no onsets above the adaptive threshold)", () => {
    expect(extractGroove(new Float32Array(SR * 2), SR, 120)).toBeNull();
  });

  it("returns null for a loop too short to cover 0.4 bars", () => {
    // At 120 BPM one bar = 0.5 s; 0.4 × barSec = 0.2 s. A 0.1 s click at
    // 120 BPM is shorter than 40% of a bar and the guard rejects it.
    const data = makeClickTrack(120, 0.1);
    expect(extractGroove(data, SR, 120)).toBeNull();
  });

  it("returns null for non-finite BPM without throwing", () => {
    // The guard runs before any arithmetic — NaN/Inf would otherwise
    // produce NaN timing values that propagate into stepMeta.
    expect(() => extractGroove(makeClickTrack(120, 4), SR, NaN)).not.toThrow();
    expect(extractGroove(makeClickTrack(120, 4), SR, NaN)).toBeNull();
  });
});

describe("extractGroove — non-trivial audio inputs", () => {
  it("survives a buffer with non-finite samples without throwing", () => {
    // A poisoned sample (NaN/Inf) in the loop must not crash the detector;
    // either the function returns a valid map or null, but must NEVER throw.
    const data = makeClickTrack(120, 4);
    data[100] = Number.NaN;
    data[500] = Number.POSITIVE_INFINITY;
    const map: ReturnType<typeof extractGroove> = extractGroove(data, SR, 120);
    expect(() => extractGroove(data, SR, 120)).not.toThrow();
    if (map !== null) {
      for (const t of map.timing) expect(Number.isFinite(t)).toBe(true);
      for (const a of map.accent) expect(Number.isFinite(a)).toBe(true);
      expect(Number.isFinite(map.swing)).toBe(true);
    }
  });

  it("survives a buffer of all zeros without throwing", () => {
    // Digital black — the transient detector should see zero onsets and
    // return null gracefully rather than divide-by-zero on the
    // maxStrength normaliser.
    expect(() => extractGroove(new Float32Array(SR * 4), SR, 120)).not.toThrow();
  });
});
