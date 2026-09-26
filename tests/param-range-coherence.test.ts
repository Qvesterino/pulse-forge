import { beforeAll, describe, expect, it } from "vitest";
import { EFFECT_META } from "../src/effects/definitions";
import type { EffectType } from "../src/project-model/types";

/**
 * Param-range coherence (docs/PARAM-VALUE-AUDIT-2026-09.md, Wave 1).
 *
 * Pins the contract that was broken before the audit: a def range widened
 * in `EFFECT_META` must be covered by the backing AudioWorklet descriptor.
 * The historical failure shape was a 2000 ms def against a 1000 ms
 * descriptor/ring (the engine silently clamped) and a 20 s decay def
 * against a 6 s descriptor. This test fails whenever someone widens a def
 * and forgets the engine side (or narrows the engine under a wide def).
 */

class FakePort {
  onmessage: ((e: unknown) => void) | null = null;
  postMessage() {}
}
class FakeAudioWorkletProcessor {
  port = new FakePort();
}

const registered = new Map<string, new () => any>();

const PROC_CASES: { effect: EffectType; proc: string; params: string[] }[] = [
  { effect: "reverb", proc: "reverb-processor", params: ["decay", "damping", "tone"] },
  { effect: "delay", proc: "stock-delay-processor", params: ["time"] },
  { effect: "duckDelay", proc: "ducking-delay-processor", params: ["time"] },
  { effect: "compressor", proc: "compressor-processor", params: ["attack", "release"] },
  { effect: "sidechain", proc: "sidechain-processor", params: ["attack", "release"] },
  { effect: "limiter", proc: "limiter-processor", params: ["ceiling", "release"] },
  { effect: "pitchShift", proc: "pitchshift-processor", params: ["fine"] },
  { effect: "eq", proc: "eq-processor", params: ["lowMidQ", "highMidQ"] },
];

const EPS = 1e-9;

beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = 48000;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (name: string, cls: new () => any) => {
    registered.set(name, cls);
  };
  for (const c of PROC_CASES) {
    await import(`../src/audio-worklets/${c.proc}.js`);
  }
});

describe("worklet descriptors cover EFFECT_META ranges", () => {
  for (const { effect, proc, params } of PROC_CASES) {
    it(`${effect}: ${params.join(", ")} descriptor bounds cover the def`, () => {
      const cls = registered.get(proc);
      expect(cls, `${proc} self-registered at import`).toBeDefined();
      const descriptors = new Map(
        ((cls as any).parameterDescriptors as { name: string; minValue: number; maxValue: number }[]).map((d) => [
          d.name,
          d,
        ]),
      );
      for (const paramId of params) {
        const def = EFFECT_META[effect].params.find((p) => p.id === paramId);
        expect(def, `${effect}.${paramId} exists in EFFECT_META`).toBeDefined();
        const desc = descriptors.get(paramId);
        expect(desc, `${proc} declares "${paramId}"`).toBeDefined();
        expect(desc!.minValue).toBeLessThanOrEqual(def!.min + EPS);
        expect(desc!.maxValue).toBeGreaterThanOrEqual(def!.max - EPS);
      }
    });
  }

  it("headline audit values are pinned (Wave 1)", () => {
    const defOf = (effect: EffectType, id: string) => {
      const p = EFFECT_META[effect].params.find((q) => q.id === id);
      expect(p).toBeDefined();
      return p!;
    };
    // Pro-reference ranges from docs/PARAM-VALUE-AUDIT-2026-09.md:
    expect(defOf("reverb", "decay").max).toBe(20); // Pro-R 60 s / Room 100 s class
    expect(defOf("delay", "time").max).toBe(2000); // EchoBoy/H3000 class, ring 2 s
    expect(defOf("duckDelay", "time").max).toBe(2000);
    expect(defOf("reverb", "tone").min).toBe(200); // dark-plate floor
    expect(defOf("reverb", "damping").max).toBe(18000); // glassy-hall ceiling
    expect(defOf("compressor", "attack").min).toBe(0.0002); // FET-click class
    expect(defOf("limiter", "ceiling").min).toBe(-24); // Pro-L 2 class
    expect(defOf("pitchShift", "fine").max).toBe(100); // H3000/AlterBoy ct
    expect(defOf("eq", "midQ").max).toBe(16); // surgical-notch class
    expect(defOf("msEq", "midLowGain").max).toBe(15); // aligned with core EQ
  });
});
