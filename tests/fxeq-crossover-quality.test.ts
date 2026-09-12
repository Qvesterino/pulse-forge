/**
 * PRISM DSP upgrades: crossover order as a runtime parameter (LR2/LR4/LR8),
 * the allpass phase-EQ toggle with its eco auto-off rule, and the export
 * render-quality bump contract.
 *
 * Reconstruction contract under test: a Linkwitz-Riley split of any
 * supported order sums back to a flat-magnitude allpass — RMS(out)/RMS(in)
 * stays ≈ 1 across LR2/LR4/LR8 — while the higher orders reject more
 * out-of-band energy (LR8 leaks less than LR4 above the split).
 */
import { describe, expect, it } from "vitest";
import { createFxEqProcessor } from "../src/effects/fxeq-core/core/fxEqProcessor";
import { fxeqRenderQualityBumps } from "../src/rendering/renderer";
import { createProjectFromTemplate } from "../src/project-model/templates";

const SR = 48000;
const BLOCK = 128;

function noisePair(seedRef: { seed: number }): Float32Array[] {
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    seedRef.seed ^= seedRef.seed << 13;
    seedRef.seed ^= seedRef.seed >>> 17;
    seedRef.seed ^= seedRef.seed << 5;
    l[i] = ((seedRef.seed >>> 0) / 0x100000000) * 1.0 - 0.5;
    seedRef.seed ^= seedRef.seed << 13;
    seedRef.seed ^= seedRef.seed >>> 17;
    seedRef.seed ^= seedRef.seed << 5;
    r[i] = ((seedRef.seed >>> 0) / 0x100000000) * 1.0 - 0.5;
  }
  return [l, r];
}

function rms(ch: Float32Array): number {
  let sum = 0;
  for (const v of ch) sum += v * v;
  return Math.sqrt(sum / ch.length);
}

function renderInto(params: Record<string, number>, input: Float32Array[], blocks: number): Float32Array[] {
  const proc = createFxEqProcessor();
  proc.prepare(SR, 2, BLOCK);
  proc.loadParameters({ limiterEnabled: 0, globalMix: 100, ...params });
  const out = [new Float32Array(input[0].length), new Float32Array(input[1].length)];
  for (let i = 0; i < blocks; i++) {
    const ch: Float32Array[] = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    for (let c = 0; c < 2; c++) {
      for (let s = 0; s < BLOCK; s++) {
        ch[c][s] = input[c][i * BLOCK + s] ?? 0;
      }
    }
    proc.process(ch, BLOCK);
    for (let c = 0; c < 2; c++) out[c].set(ch[c], i * BLOCK);
  }
  return out;
}

describe("crossover order parameter", () => {
  it("defaults to LR4 with phase EQ on (existing renders preserved)", () => {
    const proc = createFxEqProcessor();
    proc.prepare(SR, 2, BLOCK);
    const all = proc.getParameters();
    expect(all.crossoverOrder).toBe(4);
    expect(all.crossoverEqualize).toBe(1);
  });

  it("snaps host values onto {2,4,8} and writes the snap back", () => {
    const proc = createFxEqProcessor();
    proc.prepare(SR, 2, BLOCK);
    proc.setParameter("crossoverOrder", 5);
    expect(proc.getParameter("crossoverOrder")).toBe(4);
    proc.setParameter("crossoverOrder", 1);
    expect(proc.getParameter("crossoverOrder")).toBe(2);
    proc.setParameter("crossoverOrder", 8);
    expect(proc.getParameter("crossoverOrder")).toBe(8);
    proc.setParameter("crossoverOrder", Number.NaN);
    expect(proc.getParameter("crossoverOrder")).toBe(8); // hostile value rejected
  });

  it.each([2, 4, 8] as const)("reconstructs a 2-band LR%i split at unit magnitude", (order) => {
    const frames = BLOCK * 48;
    const input: Float32Array[] = [new Float32Array(frames), new Float32Array(frames)];
    let phase = 0;
    for (let i = 0; i < frames; i++) {
      // Log sweep 60 Hz … 12 kHz — spans both sides of the 1200 Hz split.
      phase += (2 * Math.PI * 60 * Math.pow(200, i / frames)) / SR;
      input[0][i] = 0.5 * Math.sin(phase);
      input[1][i] = 0.5 * Math.sin(phase + 0.01);
    }
    const out = renderInto({ bandCount: 2, crossoverFreq2: 1200, crossoverOrder: order }, input, 48);
    const inRms = rms(input[0].subarray(BLOCK * 8, BLOCK * 40));
    const outRms = rms(out[0].subarray(BLOCK * 8, BLOCK * 40));
    // Flat-magnitude allpass reconstruction; 12% headroom covers sweep-edge
    // roll-off and startup transients.
    expect(outRms).toBeGreaterThan(inRms * 0.88);
    expect(outRms).toBeLessThan(inRms * 1.12);
    for (const v of out[0]) expect(Number.isFinite(v)).toBe(true);
  });

  it("keeps LR2 complementary at its split frequency", () => {
    const frames = BLOCK * 48;
    const input: Float32Array[] = [new Float32Array(frames), new Float32Array(frames)];
    for (let i = 0; i < frames; i++) {
      input[0][i] = 0.5 * Math.sin((2 * Math.PI * 1_200 * i) / SR);
      input[1][i] = input[0][i];
    }
    const out = renderInto({ bandCount: 2, crossoverFreq2: 1200, crossoverOrder: 2 }, input, 48);
    const inRms = rms(input[0].subarray(BLOCK * 8, BLOCK * 40));
    const outRms = rms(out[0].subarray(BLOCK * 8, BLOCK * 40));
    expect(outRms / inRms).toBeGreaterThan(0.95);
    expect(outRms / inRms).toBeLessThan(1.05);
  });

  it("LR8 rejects out-of-band energy harder than LR4", () => {
    const tone = (hz: number): Float32Array[] => {
      const frames = BLOCK * 48;
      const input: Float32Array[] = [new Float32Array(frames), new Float32Array(frames)];
      for (let i = 0; i < frames; i++) {
        input[0][i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / SR);
        input[1][i] = input[0][i];
      }
      return input;
    };
    const leak = (order: number): number => {
      const proc = createFxEqProcessor();
      proc.prepare(SR, 2, BLOCK);
      proc.loadParameters({
        bandCount: 2,
        crossoverFreq2: 1200,
        crossoverOrder: order,
        "band1.solo": 1,
      });
      const input = tone(4000); // 1.7 octaves above the split
      let acc = 0;
      let count = 0;
      for (let i = 0; i < 48; i++) {
        const ch: Float32Array[] = [
          input[0].subarray(i * BLOCK, i * BLOCK + BLOCK).slice(),
          input[1].subarray(i * BLOCK, i * BLOCK + BLOCK).slice(),
        ];
        proc.process(ch, BLOCK);
        if (i >= 16) {
          acc += rms(ch[0]) ** 2;
          count++;
        }
      }
      return Math.sqrt(acc / count);
    };
    const lr4 = leak(4);
    const lr8 = leak(8);
    expect(lr4).toBeGreaterThan(0);
    expect(lr8).toBeLessThan(lr4 * 0.5);
  });

  it("switching order mid-stream stays finite (state recreation is safe)", () => {
    const proc = createFxEqProcessor();
    proc.prepare(SR, 2, BLOCK);
    proc.loadParameters({ bandCount: 3, limiterEnabled: 1 });
    const seedRef = { seed: 0xbeef };
    for (let i = 0; i < 20; i++) proc.process(noisePair(seedRef), BLOCK);
    proc.setParameter("crossoverOrder", 8);
    for (let i = 0; i < 20; i++) {
      const ch = noisePair(seedRef);
      proc.process(ch, BLOCK);
      for (const v of ch[0]) expect(Number.isFinite(v)).toBe(true);
    }
    proc.setParameter("crossoverOrder", 2);
    for (let i = 0; i < 20; i++) {
      const ch = noisePair(seedRef);
      proc.process(ch, BLOCK);
      for (const v of ch[0]) expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe("allpass phase-EQ toggle + eco auto-off", () => {
  function impulseRun(params: Record<string, number>): Float32Array[] {
    const proc = createFxEqProcessor();
    proc.prepare(SR, 2, BLOCK);
    proc.loadParameters({ bandCount: 4, limiterEnabled: 0, globalMix: 100, ...params });
    const frames = BLOCK * 32;
    const out = [new Float32Array(frames), new Float32Array(frames)];
    const impulse: Float32Array[] = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    impulse[0][10] = 0.9;
    impulse[1][10] = 0.9;
    for (let i = 0; i < 32; i++) {
      const ch: Float32Array[] = [new Float32Array(impulse[0]), new Float32Array(impulse[1])];
      proc.process(ch, BLOCK);
      out[0].set(ch[0], i * BLOCK);
      out[1].set(ch[1], i * BLOCK);
    }
    return out;
  }

  it("the toggle changes the render (phase paths differ) while staying bounded", () => {
    const on = impulseRun({ crossoverEqualize: 1 });
    const off = impulseRun({ crossoverEqualize: 0 });
    let maxDiff = 0;
    let peak = 0;
    for (let i = 0; i < on[0].length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(on[0][i] - off[0][i]));
      peak = Math.max(peak, Math.abs(off[0][i]));
    }
    expect(maxDiff).toBeGreaterThan(1e-5); // equalization is audible in the phase domain
    expect(peak).toBeLessThan(1.2); // reconstruction stays bounded without it
  });

  it("an eco band disables equalization exactly like the explicit toggle", () => {
    // Bit-equality: the eco rule must be pure sugar over crossoverEqualize=0.
    const explicitOff = impulseRun({ crossoverEqualize: 0 });
    const ecoOff = impulseRun({ "band1.quality": 0, "band2.quality": 0 });
    for (let i = 0; i < explicitOff[0].length; i++) {
      expect(explicitOff[0][i]).toBe(ecoOff[0][i]);
      expect(explicitOff[1][i]).toBe(ecoOff[1][i]);
    }
  });

  it("eco auto-off recovers when quality leaves eco (no latch)", () => {
    const proc = createFxEqProcessor();
    proc.prepare(SR, 2, BLOCK);
    proc.loadParameters({ bandCount: 2, limiterEnabled: 0 });
    proc.setParameter("band1.quality", 0);
    // Eco active → raising quality back to standard must re-enable the EQ.
    // Observable through the same toggle equivalence: after recovery, a
    // render matches an eq-on reference bit-for-bit.
    proc.setParameter("band1.quality", 1);
    const reference = impulseRun({ crossoverEqualize: 1, bandCount: 2 });
    const frames = BLOCK * 8;
    const impulse: Float32Array[] = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    impulse[0][10] = 0.9;
    impulse[1][10] = 0.9;
    for (let i = 0; i < 8; i++) {
      const ch: Float32Array[] = [new Float32Array(impulse[0]), new Float32Array(impulse[1])];
      proc.process(ch, BLOCK);
      for (let s = 0; s < BLOCK; s++) {
        expect(ch[0][s]).toBe(reference[0][i * BLOCK + s]);
      }
    }
    void frames;
  });
});

describe("PRISM export render-quality bump", () => {
  it("emits quality=3 for every band of every active PRISM instance", () => {
    const doc = createProjectFromTemplate("house");
    const track = doc.tracks.find((t) => t.kind === "instrument")!;
    track.effects = [
      { id: "fx1", type: "fxeq", bypassed: false, params: { bandCount: 3 } },
      { id: "fx2", type: "fxeq", bypassed: true, params: { bandCount: 4 } },
      { id: "fx3", type: "delay", bypassed: false, params: {} },
    ];
    const bumps = fxeqRenderQualityBumps(doc);
    expect(bumps).toHaveLength(3); // fx1 only, 3 bands (fx2 bypassed, fx3 not PRISM)
    expect(bumps[0]).toEqual({ trackId: track.id, fxId: "fx1", paramId: "band1.quality", value: 3 });
    expect(bumps.map((b) => b.paramId)).toEqual(["band1.quality", "band2.quality", "band3.quality"]);
  });
});
