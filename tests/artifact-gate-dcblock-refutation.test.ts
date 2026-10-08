import { describe, expect, it } from "vitest";
import { analyzeArtifacts, evaluateArtifacts } from "../src/audio-engine/artifactGate";

/**
 * The fixed 12 Hz master DC blocker is not the source of the click candidates
 * reported by the full-mix probe. On 2026-10-08, normal-tail Chromium renders
 * produced 4–316 curvature candidates per genre. That PCM-only heuristic
 * cannot establish whether a candidate is an audible defect or an intentional
 * transient, so complete-program checks report those candidates for review.
 *
 * FIRST HYPOTHESIS (tested and REFUTED here): the master chain's fixed 12 Hz
 * DC blocker, which is ALWAYS on (masterChain.ts — "fixed 12 Hz highpass,
 * always on"). Its time constant is 1/(2*pi*12) = 13.3 ms = 585 samples at
 * 44.1 kHz, and the reported cluster sits at 492-502 samples (11.2 ms) — close
 * enough to be worth testing. It is not the cause: a 12 Hz high-pass over a
 * decaying tone is analytically click-free, and the gate agrees
 * (`clickIndices: []`, clean verdict). The timing was never a real match either
 * (585 vs 492).
 *
 * This test is kept so the DC-blocker refutation is permanent. It does not
 * claim to classify the full-mix candidates; resolving those requires either
 * source-aware event analysis or a listening check.
 */

const SR = 44100;

/** RBJ high-pass biquad, matching BiquadFilterNode type=highpass. */
function highpass12(input: Float32Array, sr: number): Float32Array {
  const f0 = 12;
  const Q = 0.5;
  const w0 = (2 * Math.PI * f0) / sr;
  const alpha = Math.sin(w0) / (2 * Q);
  const cosw = Math.cos(w0);
  const b0 = (1 + cosw) / 2;
  const b1 = -(1 + cosw);
  const b2 = (1 + cosw) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw;
  const a2 = 1 - alpha;
  const out = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = (b0 / a0) * x0 + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    out[i] = y0;
  }
  return out;
}

describe("artifact gate — the 12 Hz master DC blocker is NOT the click source", () => {
  const decayingTone = (seconds: number): Float32Array => {
    const n = Math.floor(SR * seconds);
    const sig = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      sig[i] = 0.5 * Math.exp(-i / (SR * 0.4)) * Math.sin((2 * Math.PI * 100 * i) / SR);
    }
    return sig;
  };

  it("a clean one-shot is click-free (control)", () => {
    const r = analyzeArtifacts([decayingTone(2)]);
    expect(r.clickIndices.length).toBe(0);
  });

  it("the 12 Hz highpass introduces no click the gate can see (refutes hypothesis 1)", () => {
    const filtered = highpass12(decayingTone(2), SR);
    const r = analyzeArtifacts([filtered]);
    expect(r.clickIndices, "the master DC blocker must not register as a click source").toEqual([]);
    expect(evaluateArtifacts(r).failures).toEqual([]);
  });

  it("the filter's time constant never actually matched the reported cluster", () => {
    // 1/(2*pi*12) = 585 samples; the gate reports 492-502. The 15 % gap is
    // itself the reason hypothesis 1 should not have looked this promising.
    const tauSamples = SR / (2 * Math.PI * 12);
    expect(tauSamples).toBeGreaterThan(500);
    expect(tauSamples).toBeLessThan(650);
  });
});
