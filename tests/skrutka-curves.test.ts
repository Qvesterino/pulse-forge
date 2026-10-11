import { beforeAll, describe, expect, it } from "vitest";
import { createSkrutkaNode } from "../src/audio-worklets/skrutka-node";
import { defaultParamsOf } from "../src/effects/registry";
import { sanitizeDeviceState } from "../src/project-model/schema";
import { skrutkaParams } from "../src/effects/definitions";
import {
  TWIST_CURVE_PARAM_IDS,
  TWIST_CURVES_KIND,
  morphTwistParams,
  pickTwistCurveParams,
  readTwistCurvesState,
} from "../src/effects/skrutka-curves";

/**
 * TWIST CURVE SNAPSHOTS (v2.3) — model + persistence + node-level pins.
 *
 * The snapshot surface must stay in lockstep with the rack params (a new DSP
 * param can never silently fall out of the capture), the sanitizer must
 * survive hostile blobs like the other deviceState kinds, and the node must
 * morph A/B through the `morph` param — including automation writes via
 * `setParameterAt` — while a curve-less node is a strict no-op.
 */

class FakePort {
  onmessage: ((e: unknown) => void) | null = null;
  posted: unknown[] = [];
  postMessage(message: unknown) {
    this.posted.push(message);
  }
}

describe("TWIST curve snapshots — pure model", () => {
  it("the capture surface is exactly skrutkaParams minus morph", () => {
    const expected = skrutkaParams.filter((p) => p.id !== "morph").map((p) => p.id);
    expect([...TWIST_CURVE_PARAM_IDS]).toEqual(expected);
  });

  it("pickTwistCurveParams keeps known finite ids only", () => {
    const picked = pickTwistCurveParams({
      dispersion: 0.8,
      field: -0.5,
      morph: 0.9,
      junk: 1,
      bad: Number.NaN,
    });
    expect(picked).toEqual({ dispersion: 0.8, field: -0.5 });
  });

  it("sanitizeDeviceState validates the twist-curves-v1 kind", () => {
    const state = sanitizeDeviceState({
      kind: TWIST_CURVES_KIND,
      data: { slots: { A: { dispersion: 0.9, junk: "x", nan: Number.NaN }, B: null } },
    });
    expect(state).toBeDefined();
    expect(state!.kind).toBe(TWIST_CURVES_KIND);
    const slots = state!.data.slots as Record<string, Record<string, number> | undefined>;
    expect(slots.A?.dispersion).toBe(0.9);
    expect(slots.A?.junk).toBeUndefined();
    expect(slots.A?.nan).toBeUndefined();
    expect(slots.B).toBeUndefined();
    // Hostile blobs drop entirely.
    expect(sanitizeDeviceState({ kind: TWIST_CURVES_KIND, data: {} })).toBeUndefined();
    expect(sanitizeDeviceState({ kind: TWIST_CURVES_KIND, data: { slots: [] } })).toBeUndefined();
  });

  it("readTwistCurvesState mirrors the sanitized blob into A/B slots", () => {
    const read = readTwistCurvesState({
      kind: TWIST_CURVES_KIND,
      data: { slots: { A: { focusHz: 100 }, B: { focusHz: 900 } } },
    });
    expect(read?.slots.A?.focusHz).toBe(100);
    expect(read?.slots.B?.focusHz).toBe(900);
    expect(readTwistCurvesState(null)).toBeUndefined();
    expect(readTwistCurvesState({ kind: "other", data: {} })).toBeUndefined();
  });

  it("morphTwistParams follows the documented semantics", () => {
    const base = { focusHz: 220, dispersion: 0.35 };
    // No snapshots → the base map itself (morph is a no-op).
    expect(morphTwistParams(base, null, 0.5)).toBe(base);
    const a = { focusHz: 100 };
    // Only A: morph blends A → live base.
    expect(morphTwistParams(base, { slots: { A: a } }, 0).focusHz).toBe(100);
    expect(morphTwistParams(base, { slots: { A: a } }, 1).focusHz).toBe(220);
    expect(morphTwistParams(base, { slots: { A: a } }, 0.5).focusHz).toBeCloseTo(Math.sqrt(100 * 220));
    // Missing ids fall back to base (dispersion is not in A).
    expect(morphTwistParams(base, { slots: { A: a } }, 0).dispersion).toBe(0.35);
    // Both: A → B.
    const b = { focusHz: 900 };
    expect(morphTwistParams(base, { slots: { A: a, B: b } }, 0.5).focusHz).toBeCloseTo(300);
    // Garbage morph clamps.
    expect(morphTwistParams(base, { slots: { A: a, B: b } }, Number.NaN).focusHz).toBe(100);
    expect(morphTwistParams(base, { slots: { A: a, B: b } }, 5).focusHz).toBe(900);
  });

  it("uses perceptual interpolation for frequencies and midpoint switching for enums and AUTO", () => {
    const curves = {
      slots: {
        A: { focusHz: 100, lfoRate: 0.25, shape: 0, keyMode: 0, lfoSync: 0, lfoShape: 0, punchHz: 0 },
        B: { focusHz: 900, lfoRate: 4, shape: 2, keyMode: 2, lfoSync: 4, lfoShape: 2, punchHz: 1200 },
      },
    };
    const before = morphTwistParams({}, curves, 0.49);
    const midpoint = morphTwistParams({}, curves, 0.5);
    expect(before.focusHz).toBeCloseTo(100 * Math.pow(9, 0.49));
    expect(before.lfoRate).toBeCloseTo(0.25 * Math.pow(16, 0.49));
    expect(midpoint.focusHz).toBeCloseTo(300);
    expect(midpoint.lfoRate).toBeCloseTo(1);
    for (const [id, value] of [
      ["shape", 2],
      ["keyMode", 2],
      ["lfoSync", 4],
      ["lfoShape", 2],
      ["punchHz", 1200],
    ] as const) {
      expect(before[id]).toBe(0);
      expect(midpoint[id]).toBe(value);
    }
  });
});

describe("TWIST curve snapshots — node wrapper", () => {
  class FakeParam {
    value = 0;
    scheduled: number[] = [];
    setValueAtTime(v: number) {
      this.scheduled.push(v);
    }
  }
  class FakeWorkletNode {
    static instances: FakeWorkletNode[] = [];
    port = new FakePort();
    pmap = new Map<string, FakeParam>();
    parameters = {
      get: (id: string) => {
        let p = this.pmap.get(id);
        if (!p) {
          p = new FakeParam();
          this.pmap.set(id, p);
        }
        return p;
      },
    };
    onprocessorerror: (() => void) | null = null;
    options: unknown;
    constructor(_ctx: unknown, _name: string, options: unknown) {
      this.options = options;
      FakeWorkletNode.instances.push(this);
    }
    connect() {}
    disconnect() {}
  }

  beforeAll(() => {
    (globalThis as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = FakeWorkletNode;
  });

  const makeCtx = () =>
    ({
      createGain: () => ({ gain: { value: 1 }, connect: () => {}, disconnect: () => {} }),
      currentTime: 0,
      sampleRate: 48000,
    }) as unknown as BaseAudioContext;

  /** The most recent write to a param — value or the last scheduled time. */
  const lastWrite = (node: FakeWorkletNode, id: string): number | undefined => {
    const p = node.pmap.get(id)!;
    return p.scheduled.length > 0 ? p.scheduled.at(-1) : p.value;
  };

  it("applies the morphed map on construction, morph moves, and setParameterAt schedules", () => {
    const runtime = createSkrutkaNode(
      makeCtx(),
      {
        params: { ...defaultParamsOf("skrutka"), morph: 0 },
        deviceState: {
          kind: TWIST_CURVES_KIND,
          data: { slots: { A: { focusHz: 100 }, B: { focusHz: 900 } } },
        },
      },
      { bpm: 120 },
    );
    const node = FakeWorkletNode.instances.at(-1)!;
    expect(node.pmap.get("focusHz")?.scheduled.at(-1)).toBe(100); // morph 0 → curve A
    runtime.setParameter("morph", 0.5);
    expect(node.pmap.get("focusHz")?.scheduled.at(-1)).toBeCloseTo(300);
    runtime.setParameterAt?.("morph", 1, 7);
    expect(lastWrite(node, "focusHz")).toBe(900);
    // A knob edit updates the base; the two-slot morph still wins (morph = 1 → B).
    runtime.setParameter("focusHz", 300);
    expect(lastWrite(node, "focusHz")).toBe(900);
    // Clearing restores the live knobs.
    runtime.setCurves(null, null);
    expect(lastWrite(node, "focusHz")).toBe(300);
    runtime.dispose();
  });

  it("setCurves re-seeds a stored side live", () => {
    const runtime = createSkrutkaNode(makeCtx(), { params: { ...defaultParamsOf("skrutka"), morph: 0.5 } });
    const node = FakeWorkletNode.instances.at(-1)!;
    expect(lastWrite(node, "focusHz")).toBe(220); // no snapshots → base
    runtime.setCurves({ focusHz: 600 }, null); // A → live at morph 0.5
    expect(node.pmap.get("focusHz")?.scheduled.at(-1)).toBeCloseTo(Math.sqrt(600 * 220));
    runtime.setCurves({ focusHz: 600 }, { focusHz: 1000 });
    expect(node.pmap.get("focusHz")?.scheduled.at(-1)).toBeCloseTo(Math.sqrt(600 * 1000));
    runtime.dispose();
  });

  it("a curve-less node treats morph as a strict no-op", () => {
    const runtime = createSkrutkaNode(makeCtx(), { params: { ...defaultParamsOf("skrutka"), morph: 0 } });
    const node = FakeWorkletNode.instances.at(-1)!;
    const writesBefore = node.pmap.get("focusHz")?.scheduled.length ?? 0;
    runtime.setParameter("morph", 1);
    expect(node.pmap.get("focusHz")?.value).toBe(220); // unchanged
    expect(node.pmap.get("focusHz")?.scheduled.length ?? 0).toBe(writesBefore);
    runtime.dispose();
  });
});
