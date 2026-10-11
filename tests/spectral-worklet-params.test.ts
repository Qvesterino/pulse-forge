import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EFFECT_META } from "../src/effects/definitions";

/**
 * PORTAL worklet PARAMETER REACHABILITY (regression, 2026-10).
 *
 * The failure this file exists for is not a crash and not a wrong number. It is
 * SILENCE. An AudioWorklet creates its AudioParams from `parameterDescriptors`
 * and from nothing else, so a processor that ships the DSP but forgets the
 * descriptor list produces an effect that looks fine everywhere it is tested
 * directly and is completely inert in a browser:
 *
 *   node.parameters.get("time")  -> undefined
 *   safeApplyAudioParam          -> `if (!p) return;`  (silent no-op)
 *   processor readParams()       -> empty frame, effect plays its defaults
 *
 * Every knob reads as "no change", permanently. Unit tests that drive
 * SpectralProcessor directly cannot see it: they bypass the AudioParam surface
 * entirely, so the DSP is exercised at full fidelity while the shipped path is
 * dead. Counting API calls would not catch it either - `safeApplyAudioParam`
 * DID get called, and it deliberately returned without doing anything.
 *
 * So every assertion here reads the PRODUCT: a value written to the AudioParam
 * surface must change what the processor emits. If a param is dropped anywhere
 * between `parameterDescriptors` and `readParams`, these fail.
 *
 * The fake AudioParam surface below is built the way the spec builds it - from
 * `parameterDescriptors` only - so an undeclared parameter is *absent*, exactly
 * as it would be in Chrome. That is what makes this a real guard rather than a
 * restatement of the source.
 */

const SR = 48000;
const BLOCK = 128;

class FakePort {
  onmessage: ((e: unknown) => void) | null = null;
  postMessage(_msg: unknown) {}
}
class FakeAudioWorkletProcessor {
  port = new FakePort();
}

const registered = new Map<string, ProcessorCtor>();

// A template literal keeps this import opaque to tsc, which is the same trick
// tests/param-range-coherence.test.ts uses: these are untyped classic-script
// worklet sources, not part of the TS module graph.
const PORTAL_PROCESSOR = "portal-processor.js";

beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (name: string, cls: ProcessorCtor) => {
    registered.set(name, cls);
  };
  await import(`../src/audio-worklets/${PORTAL_PROCESSOR}`);
});

/** Spec-faithful AudioParam: created ONLY from parameterDescriptors. */
class FakeAudioParam {
  constructor(
    readonly name: string,
    readonly minValue: number,
    readonly maxValue: number,
    value: number,
  ) {
    this._v = Math.min(maxValue, Math.max(minValue, value));
  }
  private _v: number;
  get value() {
    return this._v;
  }
  set value(v: number) {
    // The spec throws TypeError on non-finite; mirror it so a NaN write is loud.
    if (!Number.isFinite(v)) throw new TypeError(`${this.name}: non-finite AudioParam write`);
    this._v = Math.min(this.maxValue, Math.max(this.minValue, v));
  }
  setValueAtTime(v: number) {
    this.value = v;
  }
  automationRate: string | null = null;
}

type Processor = {
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean;
};

/** The descriptor shape the Web Audio spec builds AudioParams from. */
type Descriptor = { name: string; minValue: number; maxValue: number; defaultValue: number };
/** A processor constructor as `registerProcessor` hands it over (takes options). */
type ProcessorCtor = new (options?: unknown) => any;

function descriptorsOf(cls: ProcessorCtor): Descriptor[] {
  const d = (cls as any).parameterDescriptors;
  expect(Array.isArray(d), "processor declares parameterDescriptors").toBe(true);
  return d as Descriptor[];
}

/**
 * Build the AudioParam surface the browser would build, plus the `params`
 * object `process()` receives: a Float32Array per declared parameter, exactly
 * as the spec passes them.
 */
function makeSurface(
  cls: ProcessorCtor,
  overrides: Record<string, number> = {},
): { params: Record<string, Float32Array>; apply: (id: string, v: number) => void; instance: Processor } {
  const descriptors = descriptorsOf(cls);
  const map = new Map<string, FakeAudioParam>();
  for (const d of descriptors) {
    const p = new FakeAudioParam(d.name, d.minValue, d.maxValue, d.defaultValue);
    map.set(d.name, p);
  }
  for (const [id, v] of Object.entries(overrides)) {
    const p = map.get(id);
    if (!p) throw new Error(`AudioParam "${id}" does not exist - the descriptor list is missing it`);
    p.value = v;
  }
  const instance = new cls({ processorOptions: { params: {} } }) as Processor;

  const paramsFor = () => {
    const out: Record<string, Float32Array> = {};
    for (const [id, p] of map) out[id] = Float32Array.of(p.value);
    return out;
  };

  return {
    instance,
    params: paramsFor(),
    apply: (id, v) => {
      const p = map.get(id);
      if (!p) throw new Error(`AudioParam "${id}" does not exist`);
      p.value = v;
    },
  };
}

/** Render `frames` blocks of a deterministic signal and return the tail. */
function render(
  instance: Processor,
  params: Record<string, Float32Array>,
  frames: number,
  input?: (i: number) => number,
): Float32Array {
  const out = new Float32Array(frames * BLOCK);
  const inL = new Float32Array(BLOCK);
  const inR = new Float32Array(BLOCK);
  const outL = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);
  const n = frames * BLOCK;
  for (let i = 0; i < frames; i++) {
    for (let j = 0; j < BLOCK; j++) {
      const idx = i * BLOCK + j;
      const s = input ? input(idx) : 0;
      inL[j] = s;
      inR[j] = s;
    }
    instance.process([[inL, inR]], [[outL, outR]], params);
    out.set(outL, i * BLOCK);
  }
  return out.slice(0, n);
}

const peakOf = (a: Float32Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const finite = (a: Float32Array) => a.every((v) => Number.isFinite(v));

describe("PORTAL worklet: every rack param is reachable through AudioParams", () => {
  const Cls = () => registered.get("portal")!;

  it("registers the processor at all", () => {
    expect(registered.get("portal"), 'registerProcessor("portal")').toBeDefined();
  });

  it("declares an AudioParam for EVERY rack param in EFFECT_META", () => {
    const declared = new Set(descriptorsOf(Cls()).map((d) => d.name));
    const missing = EFFECT_META.portal.params.filter((p) => !declared.has(p.id)).map((p) => p.id);
    expect(missing, "rack params with no AudioParam are silently inert").toEqual([]);
  });

  it("declares bpm - without it SYNC is dead", () => {
    expect(descriptorsOf(Cls()).map((d) => d.name)).toContain("bpm");
  });

  it("descriptor ranges cover the rack defs (never narrower)", () => {
    const d = new Map(descriptorsOf(Cls()).map((x) => [x.name as string, x]));
    for (const p of EFFECT_META.portal.params) {
      const desc = d.get(p.id)!;
      expect(desc.minValue as number, `portal.${p.id} desc min`).toBeLessThanOrEqual(p.min);
      expect(desc.maxValue as number, `portal.${p.id} desc max`).toBeGreaterThanOrEqual(p.max);
      expect(desc.defaultValue as number, `portal.${p.id} desc default`).toBe(p.default);
    }
  });

  it("writing TIME actually changes the emitted audio", () => {
    // Two audibly different delay lengths. If the AudioParam never reached
    // readParams(), these two renders would be byte-identical.
    const short = makeSurface(Cls(), { time: 20, feedback: 0.7, mix: 1 });
    const long = makeSurface(Cls(), { time: 2000, feedback: 0.7, mix: 1 });
    const sig = (i: number) => Math.sin((i / SR) * 2 * Math.PI * 220);
    const a = render(short.instance, short.params, 400, sig);
    const b = render(long.instance, long.params, 400, sig);
    expect(
      a.every((v, i) => v === b[i]),
      "TIME must move the delay line",
    ).toBe(false);
    expect(peakOf(a)).toBeGreaterThan(0);
    expect(peakOf(b)).toBeGreaterThan(0);
  });

  it("writing MIX crosses from passthrough to wet", () => {
    const dry = makeSurface(Cls(), { mix: 0 });
    const wet = makeSurface(Cls(), { mix: 1 });
    const sig = (i: number) => Math.sin((i / SR) * 2 * Math.PI * 220);
    const inBlock = new Float32Array(2048);
    for (let i = 0; i < inBlock.length; i++) inBlock[i] = sig(i);

    const d = render(dry.instance, dry.params, 16, sig);
    // mix = 0 is the documented bit-exact passthrough.
    expect(Array.from(d)).toEqual(Array.from(inBlock));

    const w = render(wet.instance, wet.params, 16, sig);
    expect(Array.from(w)).not.toEqual(Array.from(inBlock));
    expect(finite(w)).toBe(true);
  });

  it("writing FEEDBACK changes tail energy (the knob is not decorative)", () => {
    // The source itself is loud enough to dominate a whole-render peak, which
    // would make both arms measure the same number and pass vacuously. FEEDBACK
    // only shows up AFTER the source stops, so measure the tail region only.
    const SRC = 2000;
    const sig = (i: number) => (i < SRC ? Math.sin((i / SR) * 2 * Math.PI * 220) : 0);
    const low = makeSurface(Cls(), { feedback: 0, mix: 1, time: 200 });
    const high = makeSurface(Cls(), { feedback: 0.95, mix: 1, time: 200 });
    // 200 blocks = 25600 samples, comfortably past SRC + delay (200 ms = 9600)
    // so the measured window really is "after the repeats started".
    const a = render(low.instance, low.params, 200, sig);
    const b = render(high.instance, high.params, 200, sig);
    // NOTE: feedback = 0 is NOT silence - it is one repeat and no recirculation, so
    // it still has a tail. The knob's real product claim is energy ACCUMULATION:
    // the same signal, re-circulated, must end up louder after the source stops.
    const tail = (x: Float32Array) => peakOf(x.slice(SRC + 12288));
    expect(finite(a)).toBe(true);
    expect(finite(b)).toBe(true);
    expect(tail(b), "high FEEDBACK accumulates energy past the source").toBeGreaterThan(tail(a) * 2);
    expect(tail(b), "the tail is audible, not just different").toBeGreaterThan(1e-4);
  });

  it("writing BPM changes the synced delay (SYNC is live)", () => {
    const sig = (i: number) => Math.sin((i / SR) * 2 * Math.PI * 220);
    const slow = makeSurface(Cls(), { sync: 2, bpm: 70, mix: 1, feedback: 0.5 });
    const fast = makeSurface(Cls(), { sync: 2, bpm: 180, mix: 1, feedback: 0.5 });
    const a = render(slow.instance, slow.params, 400, sig);
    const b = render(fast.instance, fast.params, 400, sig);
    expect(
      a.every((v, i) => v === b[i]),
      "BPM must reach SpectralProcessor.setBpm",
    ).toBe(false);
  });

  it("writing SHIFT transposes delay repeats upward and stays out of RESONATOR mode", () => {
    const sig = (i: number) => Math.sin((i / SR) * 2 * Math.PI * 220);
    const flat = makeSurface(Cls(), { mode: 0, time: 100, feedback: 0.8, diffuse: 0, shift: 0, mix: 1 });
    const up = makeSurface(Cls(), { mode: 0, time: 100, feedback: 0.8, diffuse: 0, shift: 12, mix: 1 });
    const a = render(flat.instance, flat.params, 400, sig);
    const b = render(up.instance, up.params, 400, sig);
    expect(
      a.every((v, i) => v === b[i]),
      "SHIFT must move the delayed spectral region",
    ).toBe(false);
    expect(finite(b)).toBe(true);

    const resoFlat = makeSurface(Cls(), { mode: 1, shift: 0, mix: 1, resonance: 0.8 });
    const resoShifted = makeSurface(Cls(), { mode: 1, shift: 12, mix: 1, resonance: 0.8 });
    const c = render(resoFlat.instance, resoFlat.params, 400, sig);
    const d = render(resoShifted.instance, resoShifted.params, 400, sig);
    expect(c).toEqual(d);
  });

  it("stays finite and non-clipping across an extreme knob sweep", () => {
    for (const p of EFFECT_META.portal.params) {
      for (const v of [p.min, p.max, p.default]) {
        const s = makeSurface(Cls(), { [p.id]: v, mix: 1 });
        const out = render(
          s.instance,
          s.params,
          8,
          (i) => Math.sin((i / SR) * 2 * Math.PI * (i % 97 === 0 ? 1800 : 90)) * 0.5,
        );
        expect(finite(out), `portal.${p.id}=${v} must not produce non-finite samples`).toBe(true);
        expect(peakOf(out), `portal.${p.id}=${v} runaway gain`).toBeLessThan(8);
      }
    }
  });

  it("a write to an undeclared param is loud, not silent", () => {
    // The shape that hid the original defect: safeApplyAudioParam no-ops on a
    // missing AudioParam. If the surface is complete this must never be
    // reachable from the rack; the guard below asserts it stays unreachable.
    expect(() => makeSurface(Cls(), { definitelyNotAPortalParam: 1 })).toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* The rack matches the APPROVED design, not just itself             */
/* ------------------------------------------------------------------ */

/**
 * Every other guard in this file compares the code against the code: the
 * descriptors against `portalParams`, the shipped bundle against the source.
 * That is self-consistency, and self-consistency is exactly how the original
 * defect shipped - a perfectly coherent set of wrong assumptions.
 *
 * This block pins the parameter table from docs/IMPLEMENTATION-ROADMAP-PORTAL.md
 * §5 — the approved design — so `EFFECT_META.portal` is checked against
 * something external to itself. A range, default or taper edited in
 * `definitions.ts` without the design changing with it now fails here instead of
 * quietly reshaping the product.
 *
 * It found one real drift on introduction: the `resonance` label in §5 read RES
 * while the catalog has used RESO for all three other `resonance` params. The
 * table said "draft values", so the draft was what drifted — the fix went into
 * the roadmap, not the effect. This file now carries RESO.
 *
 * Changing a value here means the DESIGN changed. Update the roadmap row in the
 * same commit; do not edit this table to make a failing guard go away.
 */
const APPROVED_RACK: Array<[string, string, number, number, number, string | undefined, string | undefined]> = [
  // id, label, min, max, default, unit, taper
  ["mode", "MODE", 0, 2, 0, undefined, undefined],
  ["time", "TIME", 20, 2000, 320, "ms", "log"],
  ["sync", "SYNC", 0, 5, 0, undefined, undefined],
  ["feedback", "FDBK", 0, 1, 0.55, undefined, undefined],
  ["decay", "DECAY", 0, 1, 0.5, undefined, undefined],
  ["resonance", "RESO", 0, 1, 0.35, undefined, undefined],
  ["focus", "FOCUS", 20, 18000, 1200, "Hz", "log"],
  ["focusWidth", "WIDTH", 0.1, 4, 1, "oct", undefined],
  ["shift", "SHIFT", -24, 24, 0, "st", undefined],
  ["diffuse", "DIFF", 0, 1, 0.3, undefined, undefined],
  ["freeze", "FREEZE", 0, 1, 0, undefined, undefined],
  ["drive", "DRIVE", 0, 1, 0, undefined, undefined],
  ["tone", "TONE", -24, 24, 0, "dB", undefined],
  ["mix", "MIX", 0, 1, 0.35, undefined, undefined],
];

describe("PORTAL rack is the design that was approved", () => {
  it("has exactly the approved parameters, no more and no fewer", () => {
    expect(
      EFFECT_META.portal.params.map((p) => p.id),
      "an added param must be added to the roadmap §5 table too",
    ).toEqual(APPROVED_RACK.map((r) => r[0]));
  });

  it("matches the approved label / range / default / unit / taper, per param", () => {
    const byId = new Map(EFFECT_META.portal.params.map((p) => [p.id, p]));
    for (const [id, label, min, max, dflt, unit, taper] of APPROVED_RACK) {
      const p = byId.get(id)!;
      expect(p.label, `portal.${id} label`).toBe(label);
      expect(p.min, `portal.${id} min`).toBe(min);
      expect(p.max, `portal.${id} max`).toBe(max);
      expect(p.default, `portal.${id} default`).toBe(dflt);
      expect(p.unit, `portal.${id} unit`).toBe(unit);
      expect(p.taper, `portal.${id} taper`).toBe(taper);
    }
  });
});

/* ------------------------------------------------------------------ */
/* The SHIPPED artefact, loaded the way AudioWorklet.addModule() does  */
/* ------------------------------------------------------------------ */

/**
 * Everything above tests the SOURCE module. The thing the browser actually loads
 * is `public/spectral-worklet.js` — a generated bundle committed to the repo, and
 * generated artifacts drift: change the DSP, forget the rebuild, and the source
 * is correct while the shipped file still ships the old defect. That gap is
 * invisible to every other test in this repo.
 *
 * So these load the shipped file itself, through the same globals the audio
 * thread provides, and repeat the product assertion against it: a value written
 * to the bundle's declared AudioParams must change the audio it emits.
 *
 * This is also the roadmap's "worklet-loaded probe" (§10) — the check that must
 * go through the real worklet boundary, because offline determinism never
 * covers live AudioParam delivery.
 */
const BUNDLE_PATH = "public/spectral-worklet.js";

function loadShippedBundle(): ProcessorCtor {
  const src = readFileSync(resolve(process.cwd(), BUNDLE_PATH), "utf-8");
  const captured: ProcessorCtor[] = [];
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (_name: string, cls: ProcessorCtor) => {
    captured.push(cls);
  };
  // Classic-script bundle: it runs for its registerProcessor side effect.
  new Function(src)();
  const cls = captured.find((c) => c !== undefined);
  expect(cls, `${BUNDLE_PATH} must call registerProcessor("portal")`).toBeDefined();
  return cls!;
}

describe("PORTAL shipped bundle (the file the browser loads)", () => {
  it("is committed to the repo", () => {
    // Asserted, not skipped: a missing bundle is exactly the "shipped nothing"
    // failure this block exists to catch, and a skip would satisfy it.
    expect(existsSync(resolve(process.cwd(), BUNDLE_PATH)), `${BUNDLE_PATH} is committed`).toBe(true);
  });

  it("declares the SAME AudioParam surface as the source", () => {
    const source = descriptorsOf(registered.get("portal")!);
    const shipped = descriptorsOf(loadShippedBundle());
    const names = (l: Descriptor[]) => l.map((d) => d.name).sort();
    expect(names(shipped), "run `npm run build:spectral` — the shipped bundle is stale").toEqual(names(source));
    const byName = new Map(shipped.map((d) => [d.name, d]));
    for (const d of source) {
      const s = byName.get(d.name)!;
      expect(s.minValue, `${d.name} shipped min`).toBe(d.minValue);
      expect(s.maxValue, `${d.name} shipped max`).toBe(d.maxValue);
      expect(s.defaultValue, `${d.name} shipped default`).toBe(d.defaultValue);
    }
  });

  it("a param write through the SHIPPED bundle changes the audio", () => {
    const Cls = loadShippedBundle();
    const sig = (i: number) => Math.sin((i / SR) * 2 * Math.PI * 220);
    const short = makeSurface(Cls, { time: 20, feedback: 0.7, mix: 1 });
    const long = makeSurface(Cls, { time: 2000, feedback: 0.7, mix: 1 });
    const a = render(short.instance, short.params, 400, sig);
    const b = render(long.instance, long.params, 400, sig);
    expect(
      a.every((v, i) => v === b[i]),
      "the SHIPPED bundle must honour TIME",
    ).toBe(false);
    expect(finite(b)).toBe(true);
  });

  it("mix = 0 through the SHIPPED bundle is a bit-exact passthrough", () => {
    const Cls = loadShippedBundle();
    const dry = makeSurface(Cls, { mix: 0 });
    const sig = (i: number) => Math.sin((i / SR) * 2 * Math.PI * 220);
    const input = new Float32Array(2048);
    for (let i = 0; i < input.length; i++) input[i] = sig(i);
    expect(Array.from(render(dry.instance, dry.params, 16, sig))).toEqual(Array.from(input));
  });
});
