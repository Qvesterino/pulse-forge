import { beforeAll, describe, expect, it } from "vitest";
import { EFFECT_META } from "../src/effects/definitions";
import { scaleBridgeFor, toDescriptorValue } from "../src/effects/scale-bridges";
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
  { effect: "chorus", proc: "chorus-processor", params: ["rate", "base", "voices"] },
  { effect: "bitcrusher", proc: "bitcrusher-processor", params: ["downsample"] },
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

  it("headline audit values are pinned (Wave 2)", () => {
    const defOf = (effect: EffectType, id: string) => {
      const p = EFFECT_META[effect].params.find((q) => q.id === id);
      expect(p).toBeDefined();
      return p!;
    };
    // B1/B3: inserts land neutral — pro defaults.
    expect(defOf("freqShifter", "shift").default).toBe(0);
    expect(defOf("distortion", "character").default).toBe(0);
    // A5: chorus character axis.
    expect(defOf("chorus", "voices").max).toBe(6);
    expect(defOf("chorus", "rate").min).toBe(0.05);
    expect(defOf("chorus", "base").default).toBe(0); // legacy-exact at insert
    // A8: musical powers of two, Decimort convention.
    const crush = defOf("bitcrusher", "downsample");
    expect(crush.max).toBe(64);
    expect(crush.options?.map((o) => o.value)).toEqual([1, 2, 4, 8, 16, 32, 64]);
    // B2: time-domain params carry the log taper (Hz params already did).
    expect(defOf("delay", "time").taper).toBe("log");
    expect(defOf("compressor", "attack").taper).toBe("log");
    expect(defOf("compressor", "release").taper).toBe("log");
    expect(defOf("haasWidener", "delayMs").taper).toBe("log");
    expect(defOf("comb", "delayMs").taper).toBe("log");
  });

  it("chorus renders finite + bounded at the new extremes (6 voices, +20 ms BASE)", async () => {
    const cls = registered.get("chorus-processor");
    expect(cls).toBeDefined();
    const proc = new (cls as any)();
    const descriptors = (cls as any).parameterDescriptors as { name: string; defaultValue: number }[];
    const params: Record<string, Float32Array> = {};
    for (const d of descriptors) {
      params[d.name] = Float32Array.from([
        d.name === "voices" ? 6 : d.name === "base" ? 20 : d.name === "rate" ? 0.05 : d.defaultValue,
      ]);
    }
    const sr = 48000;
    const block = 128;
    let peak = 0;
    for (let b = 0; b < 40; b++) {
      const input = [new Float32Array(block).map((_, i) => Math.sin((2 * Math.PI * 220 * (b * block + i)) / sr))];
      const output = [new Float32Array(block), new Float32Array(block)];
      proc.process([input], [output], params);
      for (const ch of output)
        for (const v of ch) {
          expect(Number.isFinite(v)).toBe(true);
          peak = Math.max(peak, Math.abs(v));
        }
    }
    expect(peak).toBeGreaterThan(0); // audible
    expect(peak).toBeLessThan(4); // bounded (norm + panning sum)
  });

  it("bitcrusher CRUSH snaps stored legacy values to the nearest power", async () => {
    const { clampEffectParam } = await import("../src/effects/definitions");
    expect(clampEffectParam("bitcrusher", "downsample", 7)).toBe(8);
    expect(clampEffectParam("bitcrusher", "downsample", 50)).toBe(64);
    expect(clampEffectParam("bitcrusher", "downsample", 3)).toBe(4);
    expect(clampEffectParam("bitcrusher", "downsample", 2)).toBe(2);
    expect(clampEffectParam("bitcrusher", "downsample", 1)).toBe(1);
    expect(clampEffectParam("bitcrusher", "downsample", 64)).toBe(64);
    expect(clampEffectParam("bitcrusher", "downsample", Number.NaN)).toBe(1); // default
  });
});

describe("scale-bridge registry (Phase 5)", () => {
  it("every registered bridge maps def endpoints into the descriptor range", () => {
    // Def↔descriptor pairs with a registered crossing are verified in the
    // BRIDGE domain: def endpoints transformed by the bridge must land
    // inside the worklet descriptor's [min, max].
    let checked = 0;
    for (const { effect, proc, params } of PROC_CASES) {
      const cls = registered.get(proc);
      expect(cls, `${proc} registered`).toBeDefined();
      const descriptors = new Map(
        ((cls as any).parameterDescriptors as { name: string; minValue: number; maxValue: number }[]).map((d) => [
          d.name,
          d,
        ]),
      );
      for (const paramId of params) {
        const def = EFFECT_META[effect].params.find((p) => p.id === paramId);
        const desc = descriptors.get(paramId);
        if (!def || !desc) continue;
        const bridge = scaleBridgeFor(effect, paramId);
        if (!bridge) continue; // identity pairs covered by the main sweep
        for (const endpoint of [def.min, def.max]) {
          const descValue = toDescriptorValue(effect, paramId, endpoint);
          expect(
            descValue,
            `${effect}.${paramId}(${endpoint}) bridges into [${desc.minValue}, ${desc.maxValue}]`,
          ).toBeGreaterThanOrEqual(desc.minValue - 1e-6);
          expect(descValue).toBeLessThanOrEqual(desc.maxValue + 1e-6);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("known dual-domain params are registered — nothing dual-domain may hide", () => {
    // The historical audit bugs lived exactly here: a def in one domain, a
    // descriptor in another, and no bridge. Any param whose descriptor range
    // does NOT cover the def range must be registered, and the registered
    // bridge must map the def range INTO the descriptor range.
    const workload: [EffectType, string, string][] = [
      ["compressor", "compressor-processor", "makeup"],
      ["ultina", "ultina-processor", "global.mix"],
      ["fxeq", "fxeq-processor", "mix"],
      ["ozvena", "ozvena-processor", "global.dryWet"],
      ["morphdynamics", "morph-dynamics-processor", "global.mix"],
      ["bitcrusher", "bitcrusher-processor", "downsample"],
    ];
    // The plugin processors register through their own bundles — import the
    // vendored processors the same way the plugin bundle does.
    for (const [effect, proc, paramId] of workload) {
      const bridge = scaleBridgeFor(effect, paramId);
      expect(bridge, `${effect}.${paramId}: dual-domain param must be registered`).toBeDefined();
      if (!bridge) continue;
      const def = EFFECT_META[effect].params.find((p) => p.id === paramId)!;
      if (bridge.toDescriptor) {
        for (const endpoint of [def.min, def.max]) {
          const v = bridge.toDescriptor(endpoint);
          expect(Number.isFinite(v), `${effect}.${paramId}: bridge output finite`).toBe(true);
        }
      }
      void proc;
    }
  });
});
