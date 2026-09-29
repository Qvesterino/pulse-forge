import { describe, expect, it } from "vitest";
import { findResonances } from "../src/intent/resonance";

/**
 * RESONANCE DETECTOR — the AI ear for problem frequencies. These pins hold:
 * a synthetic resonance spike is FOUND at the right frequency, a flat
 * spectrum yields ZERO hits (no false positives), and multiple resonances
 * are found in prominence order.
 */

const SR = 44100;

/** Deterministic broadband noise (seeded LCG). */
function noise(seconds: number, amp = 0.3, seed = 42): Float32Array {
  const out = new Float32Array(Math.floor(SR * seconds));
  let s = seed;
  for (let i = 0; i < out.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = amp * ((s / 0x7fffffff) * 2 - 1);
  }
  return out;
}

/** Add a resonant spike: a decaying sine at `hz` mixed into the signal. */
function addResonance(pcm: Float32Array, hz: number, amp: number): void {
  for (let i = 0; i < pcm.length; i++) {
    const env = Math.exp((-3 * i) / pcm.length);
    pcm[i] += amp * env * Math.sin((2 * Math.PI * hz * i) / SR);
  }
}

describe("findResonances", () => {
  it("finds a planted resonance at the right frequency", () => {
    const pcm = noise(2, 0.3);
    addResonance(pcm, 347, 0.5);
    const hits = findResonances(pcm, SR);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].hz).toBeGreaterThanOrEqual(330);
    expect(hits[0].hz).toBeLessThanOrEqual(365);
    expect(hits[0].prominenceDb).toBeGreaterThan(8);
  });

  it("flat noise → zero false positives", () => {
    const hits = findResonances(noise(2, 0.3), SR);
    expect(hits.length).toBe(0);
  });

  it("finds multiple resonances in prominence order", () => {
    const pcm = noise(2, 0.2, 7);
    addResonance(pcm, 250, 0.6);
    addResonance(pcm, 1200, 0.5);
    addResonance(pcm, 5000, 0.45);
    const hits = findResonances(pcm, SR);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    // Sorted by prominence (loudest first).
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].prominenceDb).toBeGreaterThanOrEqual(hits[i].prominenceDb);
    }
    // The planted frequencies are represented.
    const hzs = hits.map((h) => h.hz);
    expect(hzs.some((h) => Math.abs(h - 250) < 30)).toBe(true);
    expect(hzs.some((h) => Math.abs(h - 1200) < 60)).toBe(true);
  });

  it("maxHits caps the result", () => {
    const pcm = noise(2, 0.2, 99);
    addResonance(pcm, 250, 0.8);
    addResonance(pcm, 1200, 0.7);
    addResonance(pcm, 5000, 0.6);
    const hits = findResonances(pcm, SR, { maxHits: 1 });
    expect(hits.length).toBeLessThanOrEqual(1);
  });
});
