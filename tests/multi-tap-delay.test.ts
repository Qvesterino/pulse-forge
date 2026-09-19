import { describe, expect, it } from "vitest";
import { EFFECT_DEFS, defaultParamsOf, multitapDelaySec } from "../src/effects/registry";
import { presetsForEffect } from "../src/effects/presets";
import type { EffectInstance } from "../src/project-model/types";

const SR = 44100;

function instanceOf(patch: Record<string, number>): EffectInstance {
  return {
    id: "mt-test",
    type: "multiTapDelay",
    bypassed: false,
    params: { ...defaultParamsOf("multiTapDelay"), ...patch },
  };
}

function fakeAudioParam(initialValue = 0) {
  return {
    value: initialValue,
    targetValues: [] as number[],
    scheduledValues: [] as Array<{ value: number; time: number }>,
    setValueAtTime(value: number, time = 0) {
      this.value = value;
      this.scheduledValues.push({ value, time });
    },
    setTargetAtTime(value: number) {
      this.targetValues.push(value);
      this.value = value;
    },
  };
}

function fakeAudioContext() {
  const panners: ReturnType<typeof fakeAudioParam>[] = [];
  const delays: ReturnType<typeof fakeAudioParam>[] = [];
  const node = () => ({
    connect(destination: unknown) {
      return destination;
    },
    disconnect() {},
  });
  const context = {
    currentTime: 0,
    createGain() {
      return Object.assign(node(), { gain: fakeAudioParam(1) });
    },
    createDelay() {
      const delayTime = fakeAudioParam();
      delays.push(delayTime);
      return Object.assign(node(), { delayTime });
    },
    createStereoPanner() {
      const pan = fakeAudioParam();
      panners.push(pan);
      return Object.assign(node(), { pan });
    },
    createBiquadFilter() {
      return Object.assign(node(), { type: "lowpass", frequency: fakeAudioParam() });
    },
  };
  return { context: context as unknown as BaseAudioContext, panners, delays };
}

describe("multiTapDelay registry entry", () => {
  it("is registered with taps, per-tap divisions, spread, feedback, tone, mix", () => {
    const def = EFFECT_DEFS.multiTapDelay;
    expect(def.name).toBe("Multi-Tap");
    expect(def.category).toBe("space");
    const ids = new Set(def.params.map((p) => p.id));
    for (const id of ["taps", "t1Div", "t2Div", "t3Div", "t4Div", "spread", "feedback", "tone", "mix"]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it("has four character presets", () => {
    const presets = presetsForEffect("multiTapDelay");
    expect(presets.length).toBeGreaterThanOrEqual(4);
    for (const p of presets) {
      expect(p.type).toBe("multiTapDelay");
      // Every preset param must be a real parameter of the effect.
      for (const id of Object.keys(p.params)) {
        expect(
          EFFECT_DEFS.multiTapDelay.params.some((d) => d.id === id),
          `${p.id}.${id}`,
        ).toBe(true);
      }
    }
  });
});

describe("multiTapDelay division timing (pure math)", () => {
  it("maps note-value divisions to seconds at 120 BPM (regression: bar-multiple 4× bug)", () => {
    const at120 = (div: number) => multitapDelaySec(div, 120);
    // 120 BPM → 0.5 s per beat. Labels are note values:
    expect(at120(0)).toBeCloseTo(1.0, 5); // 1/2 note = 2 beats
    expect(at120(1)).toBeCloseTo(2 / 3, 5); // 1/2T
    expect(at120(2)).toBeCloseTo(0.5, 5); // 1/4 = 1 beat
    expect(at120(3)).toBeCloseTo(1 / 3, 5); // 1/4T
    expect(at120(4)).toBeCloseTo(0.25, 5); // 1/8
    expect(at120(5)).toBeCloseTo(1 / 6, 5); // 1/8T
    expect(at120(6)).toBeCloseTo(0.125, 5); // 1/16
    expect(at120(7)).toBeCloseTo(1 / 12, 5); // 1/16T
  });

  it("scales inversely with BPM and clamps out-of-range indices", () => {
    expect(multitapDelaySec(2, 60)).toBeCloseTo(1.0, 5);
    expect(multitapDelaySec(2, 240)).toBeCloseTo(0.25, 5);
    expect(multitapDelaySec(-5, 120)).toBeCloseTo(multitapDelaySec(0, 120), 5);
    expect(multitapDelaySec(99, 120)).toBeCloseTo(multitapDelaySec(7, 120), 5);
    // BPM 0/NaN falls back to 124 rather than Infinity.
    expect(multitapDelaySec(2, 0)).toBeCloseTo((60 / 124) * 1, 5);
    expect(Number.isFinite(multitapDelaySec(2, Number.NaN))).toBe(true);
  });
});

describe.skipIf(typeof OfflineAudioContext === "undefined")("multiTapDelay timing", () => {
  /** Impulse → rendered impulse response; returns the sample index of each burst peak. */
  async function tapPeaks(patch: Record<string, number>, seconds = 2): Promise<number[]> {
    const ctx = new OfflineAudioContext(1, Math.ceil(SR * seconds), SR);
    const rt = EFFECT_DEFS.multiTapDelay.factory(ctx, instanceOf(patch), { bpm: 120 });
    const impulse = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, 8, SR);
    buf.getChannelData(0)[0] = 1;
    impulse.buffer = buf;
    impulse.connect(rt.input);
    rt.output.connect(ctx.destination);
    impulse.start(0);
    const rendered = await ctx.startRendering();
    rt.dispose();
    const data = rendered.getChannelData(0);
    const peaks: number[] = [];
    const threshold = 0.01;
    for (let i = 1; i < data.length - 1; i++) {
      const v = Math.abs(data[i]);
      if (v < threshold) continue;
      if (v >= Math.abs(data[i - 1]) && v >= Math.abs(data[i + 1])) {
        // One peak per burst: skip anything within 10 ms of the previous peak.
        if (peaks.length === 0 || i - peaks[peaks.length - 1] > SR * 0.01) peaks.push(i);
      }
    }
    return peaks;
  }

  it("spaces taps by note values, not bar multiples (regression: 4× too long)", async () => {
    // 120 BPM → 0.5 s/beat. 1/4 = 1 beat = 0.5 s, 1/8 = 0.25 s, 1/2 = 1 s.
    const peaks = await tapPeaks({ taps: 3, t1Div: 4, t2Div: 6, t3Div: 0, t4Div: 0, mix: 1, feedback: 0 }, 2.5);
    const times = peaks.map((i) => i / SR);
    // First non-dry peak is tap 1 (1/8 = 0.25 s), then 1/4 (0.5 s), then 1/2 (1.0 s).
    expect(
      times.some((t) => Math.abs(t - 0.25) < 0.02),
      `no 0.25 s tap in ${times.join(", ")}`,
    ).toBe(true);
    expect(
      times.some((t) => Math.abs(t - 0.5) < 0.02),
      `no 0.5 s tap in ${times.join(", ")}`,
    ).toBe(true);
    expect(
      times.some((t) => Math.abs(t - 1.0) < 0.02),
      `no 1.0 s tap in ${times.join(", ")}`,
    ).toBe(true);
    // And nothing at the buggy 4× positions (2 s / 1 s / 4 s were wrong for 1/8).
    expect(times.some((t) => Math.abs(t - 2.0) < 0.05)).toBe(false);
  });

  it("taps count mutes the unused taps", async () => {
    const one = await tapPeaks({ taps: 1, t1Div: 6, t2Div: 2, t3Div: 2, t4Div: 2, mix: 1, feedback: 0 }, 1.5);
    // With one tap only, later divisions must not fire (taps 2-4 muted).
    const times = one.map((i) => i / SR);
    expect(times.some((t) => Math.abs(t - 0.25) < 0.02)).toBe(true); // 1/8
    expect(times.some((t) => Math.abs(t - 0.5) < 0.02)).toBe(false); // would be tap 2's 1/4
  });
});

describe("multiTapDelay live parameter synchronization", () => {
  it("re-centers active taps when the tap count changes and updates spread live", () => {
    const { context, panners } = fakeAudioContext();
    const rt = EFFECT_DEFS.multiTapDelay.factory(context, instanceOf({ taps: 3 }), { bpm: 120 });

    rt.setParameter("taps", 1);
    expect(panners[0].value).toBeCloseTo(0, 6);

    rt.setParameter("taps", 4);
    expect(panners.map((pan) => pan.value)).toEqual([
      expect.closeTo(-0.63, 6),
      expect.closeTo(-0.21, 6),
      expect.closeTo(0.21, 6),
      expect.closeTo(0.63, 6),
    ]);

    rt.setParameter("spread", 0.5);
    expect(panners.map((pan) => pan.value)).toEqual([
      expect.closeTo(-0.45, 6),
      expect.closeTo(-0.15, 6),
      expect.closeTo(0.15, 6),
      expect.closeTo(0.45, 6),
    ]);
    rt.dispose();
  });

  it("retains the latest note division when tempo changes", () => {
    const { context, delays } = fakeAudioContext();
    const rt = EFFECT_DEFS.multiTapDelay.factory(context, instanceOf({ taps: 1, t1Div: 2 }), { bpm: 60 });
    expect(delays[0].value).toBeCloseTo(1, 6);

    rt.setParameter("t1Div", 4);
    expect(delays[0].targetValues.at(-1)).toBeCloseTo(0.5, 6);

    rt.syncBpm?.(120);
    expect(delays[0].targetValues.at(-1)).toBeCloseTo(0.25, 6);
    rt.dispose();
  });

  it("schedules tap-count and division automation at the requested audio time", () => {
    const { context, delays, panners } = fakeAudioContext();
    const rt = EFFECT_DEFS.multiTapDelay.factory(context, instanceOf({ taps: 3 }), { bpm: 120 });

    rt.setParameterAt!("taps", 1, 0.4);
    expect(panners[0].scheduledValues.at(-1)).toEqual({ value: 0, time: 0.4 });

    rt.setParameterAt!("t1Div", 6, 0.8);
    expect(delays[0].scheduledValues.at(-1)?.time).toBe(0.8);
    expect(delays[0].scheduledValues.at(-1)?.value).toBeCloseTo(0.125, 6);
    rt.dispose();
  });
});
