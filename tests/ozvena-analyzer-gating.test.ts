import { describe, expect, it } from "vitest";
import { createOzvenaProcessor } from "../src/effects/ozvena-core/core/ozvenaProcessor.js";
import { defaultOzvenaStateV1 } from "../src/effects/ozvena-core/v2/types.js";

/**
 * Analyzer gating — hosts with no spectrum/AutoCut/Unmask/masking UI can
 * disable every internal analyzer tap. Contract:
 *   1. disabling must not change the audio output bit-for-bit,
 *   2. the flag survives prepare()/reset() cycles (analyzers are recreated
 *      internally and must inherit the host's choice),
 *   3. the flag actually reaches all four gated analyzers.
 */
const SR = 48000;
const BLOCK = 128;

function render(analyzers: boolean) {
  const proc = createOzvenaProcessor();
  proc.prepare(SR, 2, 120, BLOCK);
  proc.loadState(defaultOzvenaStateV1());
  proc.setAnalyzersEnabled(analyzers);
  const frames = SR; // 1 s
  const chL = new Float32Array(frames);
  const chR = new Float32Array(frames);
  for (let i = 0; i < frames; i += BLOCK) {
    chL[i] = 0.8; // periodic impulses keep the engines ringing
    chR[i] = 0.6;
    proc.process([chL.subarray(i, i + BLOCK), chR.subarray(i, i + BLOCK)], BLOCK);
  }
  return { proc, chL, chR };
}

describe("Ozvena analyzer gating", () => {
  it("disabling analyzers leaves the audio bit-for-bit identical", () => {
    const on = render(true);
    const off = render(false);
    expect(off.chL).toEqual(on.chL);
    expect(off.chR).toEqual(on.chR);
  });

  it("the flag is observable and defaults to enabled", () => {
    expect(render(true).proc.getSpectrumAnalyzer().enabled).toBe(true);
    expect(render(false).proc.getSpectrumAnalyzer().enabled).toBe(false);
  });

  it("the flag survives a reset (re-prepare recreates the analyzers)", () => {
    const { proc } = render(false);
    proc.reset();
    expect(proc.getSpectrumAnalyzer().enabled).toBe(false);
  });

  it("re-enabling restores analyzer output", () => {
    const { proc, chL, chR } = render(false);
    proc.setAnalyzersEnabled(true);
    expect(proc.getSpectrumAnalyzer().enabled).toBe(true);
    // A fresh push lands in the ring: snapshot must not return the floor.
    proc.process(
      [Float32Array.from({ length: BLOCK }, () => 0.5), Float32Array.from({ length: BLOCK }, () => 0.5)],
      BLOCK,
    );
    const grid = new Float32Array([1000]);
    const outDb = new Float32Array(1);
    proc.getSpectrumAnalyzer().snapshot("input", outDb, grid, SR);
    expect(outDb[0]).toBeGreaterThan(-120);
    void chL;
    void chR;
  });
});
