/**
 * Ozvena golden parity — Pulse Forge vendored core vs upstream fixtures.
 *
 * Fixtures are COPIES of VocalForge_DAW/plugins/ozvena's tests/golden/
 * (integration post-conditions: no NaN, bypass settle RMS, reverb tail
 * energy in a time window). This suite re-runs them through the VENDORED
 * core with the same merge/render logic.
 *
 * Refresh: scripts/vendor-ozvena.mjs after upstream changes.
 *
 * POLICY (2026-09-14): the vendored core is intentionally ALLOWED TO DIVERGE
 * from upstream — Pulse Forge treats it as its own hardened copy (owner
 * decision). These fixtures are therefore a HISTORICAL REGRESSION BASELINE:
 * they still match the upstream snapshots where the DSP math is unchanged,
 * and documented deliberate deviations are regenerated via UPDATE_GOLDEN=1
 * with justification in the change notes.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createOzvenaProcessor } from "../src/effects/ozvena-core/core/ozvenaProcessor.js";
import { defaultOzvenaStateV1, type OzvenaStateV1 } from "../src/effects/ozvena-core/v2/types.js";

interface GoldenFixture {
  name: string;
  description: string;
  sampleRate: number;
  blockSize: number;
  state?: Partial<OzvenaStateV1>;
  input: { type: string; amplitudeL: number; amplitudeR: number; clickSample: number };
  expected: {
    noNan?: boolean;
    finite?: boolean;
    bypassSettledRms?: { min: number; max: number };
    tailEnergyWindow?: { startSample: number; endSample: number; min: number };
  };
}

function loadFixtures(): GoldenFixture[] {
  const dir = join(import.meta.dirname, "ozvena-golden");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")) as GoldenFixture);
}

/** Deep-merge a partial state over the upstream defaults (mirrors upstream harness). */
function mergeState(partial: Partial<OzvenaStateV1> | undefined): OzvenaStateV1 {
  const base = defaultOzvenaStateV1();
  if (!partial) return base;
  return {
    ...base,
    ...partial,
    global: { ...base.global, ...(partial.global ?? {}) },
    blendPad: { ...base.blendPad, ...(partial.blendPad ?? {}) },
    engines: {
      e1: { ...base.engines.e1, ...(partial.engines?.e1 ?? {}) },
      e2: { ...base.engines.e2, ...(partial.engines?.e2 ?? {}) },
      e3: { ...base.engines.e3, ...(partial.engines?.e3 ?? {}) },
    },
    preDelay: { ...base.preDelay, ...(partial.preDelay ?? {}) },
    smoother: { ...base.smoother, ...(partial.smoother ?? {}) },
    preEq: {
      ...base.preEq,
      ...(partial.preEq ?? {}),
      autoCut: { ...base.preEq.autoCut, ...(partial.preEq?.autoCut ?? {}) },
      band1: { ...base.preEq.band1, ...(partial.preEq?.band1 ?? {}) },
      band2: { ...base.preEq.band2, ...(partial.preEq?.band2 ?? {}) },
      band3: { ...base.preEq.band3, ...(partial.preEq?.band3 ?? {}) },
    },
    reverbEq: {
      ...base.reverbEq,
      ...(partial.reverbEq ?? {}),
      unmask: { ...base.reverbEq.unmask, ...(partial.reverbEq?.unmask ?? {}) },
      band1: { ...base.reverbEq.band1, ...(partial.reverbEq?.band1 ?? {}) },
      band2: { ...base.reverbEq.band2, ...(partial.reverbEq?.band2 ?? {}) },
      band3: { ...base.reverbEq.band3, ...(partial.reverbEq?.band3 ?? {}) },
    },
    masking: { ...base.masking, ...(partial.masking ?? {}) },
    mod: { ...base.mod, ...(partial.mod ?? {}) },
    assistant: { ...base.assistant, ...(partial.assistant ?? {}) },
  };
}

function generateClick(fixture: GoldenFixture, totalFrames: number): { ch0: Float32Array; ch1: Float32Array } {
  const ch0 = new Float32Array(totalFrames);
  const ch1 = new Float32Array(totalFrames);
  const c = fixture.input.clickSample;
  if (c < totalFrames) {
    ch0[c] = fixture.input.amplitudeL;
    ch1[c] = fixture.input.amplitudeR;
  }
  return { ch0, ch1 };
}

describe("Ozvena golden parity (vendored core vs upstream fixtures)", () => {
  const fixtures = loadFixtures();

  it("found the upstream fixtures", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(2);
  });

  for (const fixture of fixtures) {
    it(`parity: ${fixture.name}`, () => {
      const proc = createOzvenaProcessor();
      const state = mergeState(fixture.state);
      const sr = fixture.sampleRate;
      const N = Math.max(fixture.blockSize * 64, 131072);
      proc.prepare(sr, 2, 120, fixture.blockSize);
      proc.loadState(state);

      const { ch0, ch1 } = generateClick(fixture, N);
      for (let off = 0; off < N; off += fixture.blockSize) {
        const len = Math.min(fixture.blockSize, N - off);
        proc.process([ch0.subarray(off, off + len), ch1.subarray(off, off + len)], len);
      }

      if (fixture.expected.noNan ?? true) {
        for (let i = 0; i < N; i++) {
          expect(Number.isFinite(ch0[i])).toBe(true);
          expect(Number.isFinite(ch1[i])).toBe(true);
        }
      }

      if (fixture.expected.bypassSettledRms) {
        const start = Math.max(0, N - 4096);
        let sumSq = 0;
        for (let i = start; i < N; i++) sumSq += ch0[i] * ch0[i];
        const rms = Math.sqrt(sumSq / (N - start));
        expect(rms).toBeGreaterThan(fixture.expected.bypassSettledRms.min);
        expect(rms).toBeLessThan(fixture.expected.bypassSettledRms.max);
      }

      if (fixture.expected.tailEnergyWindow) {
        const w = fixture.expected.tailEnergyWindow;
        let sumSq = 0;
        for (let i = w.startSample; i < Math.min(N, w.endSample); i++) {
          sumSq += ch0[i] * ch0[i] + ch1[i] * ch1[i];
        }
        const energy = sumSq / Math.max(1, Math.min(N, w.endSample) - w.startSample);
        // Reverb tail must be present in the decay window.
        expect(energy).toBeGreaterThan(w.min);
        console.log(`[ozvena-parity] ${fixture.name}: tailEnergy=${energy.toExponential(2)} (min ${w.min.toExponential(2)})`);
      }
    });
  }
});
