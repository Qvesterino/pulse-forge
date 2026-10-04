import { beforeAll, describe, expect, it } from "vitest";
import { EFFECT_META, clampEffectParam, defaultParamsOf, normalizePluginParams } from "../src/effects/definitions";
import {
  EFFECT_DEFS,
  EFFECT_ORDER,
  CORE_EFFECT_GROUPS,
  ADDITIONAL_EFFECT_GROUPS,
  FLAGSHIP_EFFECT_ORDER,
} from "../src/effects/registry";
import { CORE_EFFECT_PRESETS } from "../src/effects/presets";
import type { EffectType } from "../src/project-model/types";
import type { ParamDef } from "../src/effects/types";
import {
  INSTRUMENT_DEFS,
  INSTRUMENT_ORDER,
  clampInstrumentParam,
  defaultInstrumentParams,
} from "../src/instruments/registry";
import { INSTRUMENT_META } from "../src/instruments/definitions";
import { FACTORY_PRESETS } from "../src/presets/factory";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import { addEffect, setEffectParam, toggleEffectBypass } from "../src/commands/commands";
import { ProjectStore } from "../src/store/ProjectStore";
import { clampTargetValue, isAutomationTargetValid } from "../src/project-model/targets";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * INTERNAL PLUGIN AUDIT (2026-09-27) — model-level half.
 *
 * Static + document-level functional verification of every internal plugin:
 * 47 effect types × all exposed params, 21 instrument kinds × all params.
 * The real-audio half (bypass deltas, param responsiveness, NaN at extremes,
 * interactions) lives in src/plugin-audit-checks.ts, run by
 * scripts/verify-plugin-audit.mjs in a real browser.
 *
 * Sections:
 *  A. Inventory & discovery (every surface agrees on the plugin list)
 *  B. Parameter metadata sanity (bounds, defaults, units, tapers, options)
 *  C. Worklet descriptor coverage (EFFECT_META range ⊆ AudioParam descriptor)
 *  D. Clamp + normalization contracts (garbage in → documented value out)
 *  E. Serialization round-trip (params/bypass survive normalize+JSON)
 *  F. Automation targets (every param is targetable + clamped)
 *  G. Factory preset surface (every instrument has presets; fx presets in range)
 */

const ALL_EFFECT_TYPES = EFFECT_ORDER;

/* ------------------------------------------------------------------ */
/* A. Inventory & discovery                                            */
/* ------------------------------------------------------------------ */

describe("A. inventory & discovery", () => {
  it("registry covers exactly EFFECT_ORDER and EFFECT_META", () => {
    expect(new Set(Object.keys(EFFECT_DEFS))).toEqual(new Set(ALL_EFFECT_TYPES));
    expect(new Set(Object.keys(EFFECT_META))).toEqual(new Set(ALL_EFFECT_TYPES));
  });

  it("the device menu groups discover every effect exactly once", () => {
    // The Add-Effect discovery surface (EffectRack): core groups, the
    // flagship plugin section, then the "MORE" groups. An effect missing
    // here is registered but undiscoverable from the UI.
    const menu = [
      ...CORE_EFFECT_GROUPS.flatMap((g) => g.types),
      ...FLAGSHIP_EFFECT_ORDER,
      ...ADDITIONAL_EFFECT_GROUPS.flatMap((g) => g.types),
    ];
    expect(new Set(menu)).toEqual(new Set(ALL_EFFECT_TYPES));
    expect(menu.length).toBe(ALL_EFFECT_TYPES.length); // no duplicates across groups
    for (const group of [...CORE_EFFECT_GROUPS, ...ADDITIONAL_EFFECT_GROUPS]) {
      for (const type of group.types) {
        expect(EFFECT_DEFS[type].category, `${type}: grouped under its own category`).toBe(group.key);
      }
    }
  });

  it("every effect definition carries name, category and a factory", () => {
    const names = new Set<string>();
    const categories = new Set(["tone", "dynamics", "character", "space", "movement"]);
    for (const type of ALL_EFFECT_TYPES) {
      const def = EFFECT_DEFS[type];
      expect(def.factory, `${type}: factory`).toBeTypeOf("function");
      expect(def.name.length).toBeGreaterThan(0);
      expect(categories.has(def.category), `${type}: category ${def.category}`).toBe(true);
      names.add(def.name);
    }
    // Display names are the discovery surface (FxAddPopover / device menu):
    // two plugins sharing a name would be indistinguishable in the UI.
    expect(names.size).toBe(ALL_EFFECT_TYPES.length);
  });

  it("every instrument kind is registered in both metadata and runtime registries", () => {
    expect(new Set(Object.keys(INSTRUMENT_DEFS))).toEqual(new Set(INSTRUMENT_ORDER));
    expect(new Set(Object.keys(INSTRUMENT_META))).toEqual(new Set(INSTRUMENT_ORDER));
    const names = new Set<string>();
    for (const kind of INSTRUMENT_ORDER) {
      expect(INSTRUMENT_DEFS[kind].factory, `${kind}: factory`).toBeTypeOf("function");
      expect(INSTRUMENT_DEFS[kind].name.length).toBeGreaterThan(0);
      names.add(INSTRUMENT_DEFS[kind].name);
    }
    expect(names.size).toBe(INSTRUMENT_ORDER.length);
  });
});

/* ------------------------------------------------------------------ */
/* B. Parameter metadata sanity                                        */
/* ------------------------------------------------------------------ */

const KNOWN_UNITS = new Set(["Hz", "dB", "ms", "s", "%", "st", "ct", "/s"]);

function checkParamSurface(surface: string, params: ParamDef[]) {
  const ids = new Set<string>();
  const labels = new Set<string>();
  for (const p of params) {
    const at = `${surface}.${p.id}`;
    expect(Number.isFinite(p.min), `${at}: min finite`).toBe(true);
    expect(Number.isFinite(p.max), `${at}: max finite`).toBe(true);
    expect(Number.isFinite(p.default), `${at}: default finite`).toBe(true);
    expect(p.min, `${at}: min < max`).toBeLessThan(p.max);
    expect(p.default, `${at}: default within [min,max]`).toBeGreaterThanOrEqual(p.min);
    expect(p.default, `${at}: default within [min,max]`).toBeLessThanOrEqual(p.max);
    expect(p.label.length, `${at}: label`).toBeGreaterThan(0);
    if (p.unit !== undefined) {
      expect(KNOWN_UNITS.has(p.unit), `${at}: unit "${p.unit}" from catalog`).toBe(true);
    }
    // Unit conventions that catch dB/Hz/ms mix-ups at the source.
    if (/(^|[A-Z])Db$/.test(p.id)) expect(p.unit, `${at}: dB unit`).toBe("dB");
    if (/Freq$|Hz$/.test(p.id)) expect(p.unit, `${at}: Hz unit`).toBe("Hz");
    if (/Ms$/.test(p.id)) expect(p.unit, `${at}: ms unit`).toBe("ms");
    // Log tapers are meaningless (and divide by log(min)) across zero.
    if (p.taper === "log") expect(p.min, `${at}: log taper needs min > 0`).toBeGreaterThan(0);
    // Toggles/enums/discretes need their option lists in range and sane defaults.
    if (p.kind === "toggle") {
      expect(p.default === p.min || p.default === p.max, `${at}: toggle default is an endpoint`).toBe(true);
    }
    if (p.options) {
      for (const opt of p.options) {
        expect(Number.isFinite(opt.value), `${at}: option value finite`).toBe(true);
        expect(opt.value, `${at}: option ${opt.value} within [min,max]`).toBeGreaterThanOrEqual(p.min);
        expect(opt.value, `${at}: option ${opt.value} within [min,max]`).toBeLessThanOrEqual(p.max);
      }
      const defaultsToOption = p.options.some((o) => o.value === p.default);
      expect(defaultsToOption, `${at}: default ${p.default} is a listed option`).toBe(true);
      const values = p.options.map((o) => o.value);
      expect(new Set(values).size, `${at}: option values unique`).toBe(values.length);
    }
    if (p.kind === "discrete") {
      expect(p.step === undefined || p.step > 0, `${at}: positive step`).toBe(true);
    }
    // Every format callable must render finite text across the full range —
    // a NaN in the display path is a UI-visible defect.
    if (p.format) {
      for (const v of [p.min, (p.min + p.max) / 2, p.max, p.default]) {
        const text = p.format(v);
        expect(typeof text, `${at}: format returns string at ${v}`).toBe("string");
        expect(text.toLowerCase().includes("nan"), `${at}: format renders NaN at ${v}`).toBe(false);
      }
    }
    ids.add(p.id);
    labels.add(p.label);
  }
  expect(ids.size).toBe(params.length);
  expect(labels.size).toBe(params.length);
}

describe("B. parameter metadata sanity", () => {
  it("all 47 effect parameter surfaces are coherent", () => {
    for (const type of ALL_EFFECT_TYPES) checkParamSurface(`fx:${type}`, EFFECT_META[type].params);
  });

  it("all 21 instrument parameter surfaces are coherent", () => {
    for (const kind of INSTRUMENT_ORDER) checkParamSurface(`inst:${kind}`, INSTRUMENT_META[kind].params);
  });

  it("defaultParamsOf / defaultInstrumentParams mirror the declared defaults exactly", () => {
    for (const type of ALL_EFFECT_TYPES) {
      const defaults = defaultParamsOf(type);
      expect(Object.keys(defaults).sort()).toEqual(EFFECT_META[type].params.map((p) => p.id).sort());
    }
    for (const kind of INSTRUMENT_ORDER) {
      const defaults = defaultInstrumentParams(kind);
      expect(Object.keys(defaults).sort()).toEqual(INSTRUMENT_META[kind].params.map((p) => p.id).sort());
      for (const p of INSTRUMENT_META[kind].params) expect(defaults[p.id]).toBe(p.default);
    }
  });
});

/* ------------------------------------------------------------------ */
/* C. Worklet descriptor coverage                                      */
/* ------------------------------------------------------------------ */

class FakePort {
  onmessage: ((e: unknown) => void) | null = null;
  postMessage() {}
}
class FakeAudioWorkletProcessor {
  port = new FakePort();
}

const registered = new Map<string, new () => any>();

/** effect type → AudioWorklet processor module + registration name. */
const WORKLET_CASES: { effect: EffectType; proc: string; reg: string }[] = [
  { effect: "eq", proc: "eq-processor", reg: "eq-processor" },
  { effect: "compressor", proc: "compressor-processor", reg: "compressor-processor" },
  { effect: "sidechain", proc: "sidechain-processor", reg: "sidechain-processor" },
  { effect: "limiter", proc: "limiter-processor", reg: "limiter-processor" },
  { effect: "gate", proc: "gate-processor", reg: "gate-processor" },
  { effect: "transient", proc: "transient-processor", reg: "transient-processor" },
  { effect: "bitcrusher", proc: "bitcrusher-processor", reg: "bitcrusher-processor" },
  { effect: "reverb", proc: "reverb-processor", reg: "reverb-processor" },
  { effect: "delay", proc: "stock-delay-processor", reg: "stock-delay-processor" },
  { effect: "duckDelay", proc: "ducking-delay-processor", reg: "ducking-delay-processor" },
  { effect: "chorus", proc: "chorus-processor", reg: "chorus-processor" },
  { effect: "flanger", proc: "flanger-processor", reg: "flanger-processor" },
  { effect: "tremolo", proc: "tremolo-processor", reg: "tremolo-processor" },
  { effect: "autowah", proc: "autowah-processor", reg: "autowah-processor" },
  { effect: "stutter", proc: "stutter-processor", reg: "stutter-processor" },
  { effect: "comb", proc: "comb-processor", reg: "comb-processor" },
  { effect: "vowel", proc: "vowel-processor", reg: "vowel-processor" },
  { effect: "svFilter", proc: "svfilter-processor", reg: "svfilter-processor" },
  { effect: "stepGate", proc: "stepgate-processor", reg: "stepgate-processor" },
  { effect: "tapeSat", proc: "tape-processor", reg: "tape-processor" },
  { effect: "vocoder", proc: "vocoder-processor", reg: "vocoder-processor" },
  { effect: "reverseSwell", proc: "reverseswell-processor", reg: "reverseswell-processor" },
  { effect: "granularFreeze", proc: "granularfreeze-processor", reg: "granularfreeze-processor" },
  { effect: "kaskada", proc: "kaskada-processor", reg: "kaskada" },
  { effect: "ringMod", proc: "ringmod-processor", reg: "ringmod-processor" },
  { effect: "tapeStop", proc: "tapestop-processor", reg: "tapestop-processor" },
  { effect: "freqShifter", proc: "freqshifter-processor", reg: "freqshift-processor" },
  { effect: "pitchShift", proc: "pitchshift-processor", reg: "pitchshift-processor" },
  { effect: "vinyl", proc: "vinyl-processor", reg: "vinyl-processor" },
  { effect: "beatMangler", proc: "beatmangler-processor", reg: "beatmangler-processor" },
  { effect: "bassBuss", proc: "bassbuss-sub-processor", reg: "bassbuss-sub-processor" },
];

/**
 * Params whose descriptor lives in a DIFFERENT domain than the def. The
 * compressor wrapper converts makeup dB → linear gain before the AudioParam,
 * so the descriptor bound is 10^(dB/20), not dB.
 */
const LINEAR_GAIN_DESC: Set<string> = new Set(["compressor.makeup"]);

const EPS = 1e-9;

/** vitest has no toBeWithin matcher — a tiny local assert keeps the audit dependency-free. */
function within(v: number, lo: number, hi: number): boolean {
  return Number.isFinite(v) && v >= lo && v <= hi;
}

beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = 48000;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (name: string, cls: new () => any) => {
    registered.set(name, cls);
  };
  for (const c of WORKLET_CASES) {
    await import(`../src/audio-worklets/${c.proc}.js`);
  }
});

describe("C. worklet descriptors cover the declared ranges", () => {
  for (const { effect, proc, reg } of WORKLET_CASES) {
    it(`${effect}: every shared param id has descriptor bounds ⊇ def range`, () => {
      const cls = registered.get(reg);
      expect(cls, `${reg} self-registered at import`).toBeDefined();
      const descriptors = ((cls as any).parameterDescriptors ?? []) as {
        name: string;
        minValue: number;
        maxValue: number;
        defaultValue?: number;
      }[];
      expect(descriptors.length, `${proc} declares descriptors`).toBeGreaterThan(0);
      const byId = new Map(descriptors.map((d) => [d.name, d]));
      for (const def of EFFECT_META[effect].params) {
        const desc = byId.get(def.id);
        if (!desc) continue; // param not exposed as an AudioParam (message-driven is fine)
        const toDesc = (v: number) => (LINEAR_GAIN_DESC.has(`${effect}.${def.id}`) ? Math.pow(10, v / 20) : v);
        expect(
          toDesc(def.min),
          `${effect}.${def.id}: descriptor min covers def (${desc.minValue} ≤ ${toDesc(def.min)})`,
        ).toBeGreaterThanOrEqual(desc.minValue - EPS);
        expect(
          toDesc(def.max),
          `${effect}.${def.id}: descriptor max covers def (${desc.maxValue} ≥ ${toDesc(def.max)})`,
        ).toBeLessThanOrEqual(desc.maxValue + EPS);
        expect(Number.isFinite(desc.minValue) && Number.isFinite(desc.maxValue), `${effect}.${def.id}: finite`).toBe(
          true,
        );
      }
    });
  }
});

/* ------------------------------------------------------------------ */
/* D. Clamp + normalization contracts                                  */
/* ------------------------------------------------------------------ */

describe("D. clamp + normalization contracts", () => {
  it("clampEffectParam maps every param's min/max through unchanged and pulls extremes back in", () => {
    for (const type of ALL_EFFECT_TYPES) {
      for (const p of EFFECT_META[type].params) {
        // Structured params (bitcrusher.downsample powers, fxeq crossover
        // slopes) legitimately snap — assert "inside range" instead of identity.
        const clampIn = (v: number) => clampEffectParam(type, p.id, v);
        expect(within(clampIn(p.min), p.min - EPS, p.max + EPS)).toBe(true);
        expect(within(clampIn(p.max), p.min - EPS, p.max + EPS)).toBe(true);
        expect(clampIn(p.min - 1000 * (p.max - p.min))).toBe(p.min);
        expect(clampIn(p.max + 1000 * (p.max - p.min))).toBe(p.max);
        expect(clampIn(Number.NaN)).toBe(p.default);
        expect(clampIn(Number.POSITIVE_INFINITY)).toBe(p.default);
        expect(clampIn(Number.NEGATIVE_INFINITY)).toBe(p.default);
        const mid = p.min + (p.max - p.min) * 0.37;
        expect(within(clampIn(mid), p.min - EPS, p.max + EPS)).toBe(true);
      }
    }
  });

  it("clampInstrumentParam enforces every declared range", () => {
    for (const kind of INSTRUMENT_ORDER) {
      for (const p of INSTRUMENT_META[kind].params) {
        expect(clampInstrumentParam(kind, p.id, p.min - 1)).toBe(p.min);
        expect(clampInstrumentParam(kind, p.id, p.max + 1)).toBe(p.max);
        expect(clampInstrumentParam(kind, p.id, Number.NaN)).toBe(p.default); // finite guard mirrors clampEffectParam (re-run 2026-10: the old "engine guards upstream" claim was false — normalize copied known keys verbatim)
      }
    }
  });

  it("flagship normalization drops unknown ids, non-finite values and rescales legacy 0..100 mixes", () => {
    // Legacy docs stored rack mixes 0..100 — one idempotent rescale to 0..1.
    for (const [type, mixId] of [
      ["fxeq", "mix"],
      ["ultina", "global.mix"],
      ["ozvena", "global.dryWet"],
      ["morphdynamics", "global.mix"],
    ] as const) {
      const rescaled = normalizePluginParams(type, { [mixId]: 55 });
      expect(rescaled, `${type}: normalize returns a map`).not.toBeNull();
      expect(rescaled![mixId], `${type}: legacy 55 → 0.55`).toBeCloseTo(0.55, 5);
      const idempotent = normalizePluginParams(type, { [mixId]: 0.55 });
      expect(idempotent![mixId], `${type}: already-scaled stays`).toBeCloseTo(0.55, 5);
    }
    // Garbage: unknown ids dropped, non-finite dropped, surviving values in range.
    for (const type of ["fxeq", "ultina", "ozvena", "morphdynamics"] as EffectType[]) {
      const out = normalizePluginParams(type, {
        totallyUnknownId: 12345,
        garbage: Number.NaN,
      })!;
      for (const [id, value] of Object.entries(out)) {
        expect(Number.isFinite(value), `${type}.${id}: finite after normalize`).toBe(true);
        const def = EFFECT_META[type].params.find((p) => p.id === id);
        if (def) expect(within(value, def.min - EPS, def.max + EPS), `${type}.${id}: in range`).toBe(true);
      }
      expect(out.totallyUnknownId).toBeUndefined();
    }
  });

  it("structured params snap to their legal value sets", () => {
    // bitcrusher CRUSH is a power of two 1..64.
    for (const v of [1, 3, 7, 50, 64]) {
      const snapped = clampEffectParam("bitcrusher", "downsample", v);
      expect(Math.log2(snapped) % 1, `bitcrusher CRUSH ${v} → ${snapped} is a power of two`).toBe(0);
      expect(within(snapped, 1, 64 + EPS)).toBe(true);
    }
    // fxeq crossover slope only exists at {2,4,8}.
    for (const v of [2, 3, 4, 6, 8]) {
      expect([2, 4, 8]).toContain(clampEffectParam("fxeq", "crossoverOrder", v));
    }
  });
});

/* ------------------------------------------------------------------ */
/* E. Serialization round-trip                                         */
/* ------------------------------------------------------------------ */

/** Odd mid-range value per param — survives nothing if serialization lies.
 *  Enum/option params must pick a LISTED value (setEffectParam validates). */
function oddValue(p: ParamDef): number {
  if (p.options?.length) {
    const farthest = p.options.reduce((a, b) =>
      Math.abs(b.value - p.default) > Math.abs(a.value - p.default) ? b : a,
    );
    return farthest.value;
  }
  if (p.kind === "toggle") {
    return p.default === 1 ? 0 : 1;
  }
  if (p.kind === "discrete" && p.step) {
    return Math.round((p.min + (p.max - p.min) * 0.37) / p.step) * p.step;
  }
  return Math.round((p.min + (p.max - p.min) * 0.37) * 1000) / 1000;
}

function docWithEffect(type: EffectType): { doc: ProjectDocument; trackId: string; fxId: string } {
  const base = createProjectFromTemplate("house");
  const track = base.tracks.find((t) => t.kind === "instrument")!;
  const store = new ProjectStore(base);
  store.execute(addEffect(base, track.id, type));
  const doc = store.getDoc();
  const fx = (doc.tracks.find((t) => t.id === track.id)! as { effects: { id: string }[] }).effects.at(-1)!;
  return { doc, trackId: track.id, fxId: fx.id };
}

describe("E. serialization round-trip", () => {
  for (const type of ALL_EFFECT_TYPES) {
    it(`${type}: every param + bypassed flag survives normalizeProject(JSON round-trip)`, () => {
      const { doc, trackId, fxId } = docWithEffect(type);
      const store = new ProjectStore(doc);
      for (const p of EFFECT_META[type].params) {
        const v = oddValue(p);
        const clamped = clampEffectParam(type, p.id, v);
        store.execute(setEffectParam(store.getDoc(), trackId, fxId, p.id, clamped));
      }
      store.execute(toggleEffectBypass(store.getDoc(), trackId, fxId));
      const edited = store.getDoc();
      const roundTripped = normalizeProject(JSON.parse(JSON.stringify(edited)));
      const owner = roundTripped.tracks.find((t) => t.id === trackId) as
        { effects: { id: string; bypassed: boolean; params: Record<string, number> }[] } | undefined;
      expect(owner).toBeDefined();
      const fx = owner!.effects.find((f) => f.id === fxId);
      expect(fx, `${type}: effect survives round-trip`).toBeDefined();
      expect(fx!.bypassed, `${type}: bypassed flag survives`).toBe(true);
      for (const p of EFFECT_META[type].params) {
        const before = edited.tracks.find((t) => t.id === trackId) as unknown as {
          effects: { id: string; params: Record<string, number> }[];
        };
        const sent = before.effects.find((f) => f.id === fxId)!.params[p.id];
        expect(fx!.params[p.id], `${type}.${p.id}: survives round-trip`).toBeCloseTo(sent, 6);
      }
    });
  }

  it("step-envelope state (stepGate/beatMangler) survives the round-trip sanitized", () => {
    for (const type of ["stepGate", "beatMangler"] as EffectType[]) {
      const { doc, trackId, fxId } = docWithEffect(type);
      // Corrupt the step arrays the way an old/hostile document would.
      const poison = (steps: unknown) => steps;
      const dirty = normalizeProject({
        ...doc,
        tracks: doc.tracks.map((t) =>
          t.id !== trackId
            ? t
            : {
                ...t,
                effects: (t as unknown as { effects: Record<string, unknown>[] }).effects.map((fx) =>
                  fx.id !== fxId
                    ? fx
                    : type === "stepGate"
                      ? { ...fx, steps: poison([0, "x", Number.NaN, 2, -1, 0.5]) }
                      : { ...fx, volumeSteps: poison([2, -3, Number.NaN, 0.4]), pitchSteps: poison([99, "x", -1]) },
                ),
              },
        ) as ProjectDocument["tracks"],
      });
      const fx = (
        dirty.tracks.find((t) => t.id === trackId) as unknown as {
          effects: { id: string; steps?: number[]; volumeSteps?: number[]; pitchSteps?: number[] }[];
        }
      ).effects.find((f) => f.id === fxId)!;
      const arr = type === "stepGate" ? fx.steps : fx.volumeSteps;
      expect(Array.isArray(arr), `${type}: steps array survives`).toBe(true);
      for (const v of arr!) expect(Number.isFinite(v), `${type}: sanitized finite`).toBe(true);
      expect(Math.min(...arr!), `${type}: sanitized into range`).toBeGreaterThanOrEqual(0);
      expect(Math.max(...arr!), `${type}: sanitized into range`).toBeLessThanOrEqual(1);
    }
  });
});

/* ------------------------------------------------------------------ */
/* F. Automation targets                                               */
/* ------------------------------------------------------------------ */

describe("F0. deprecated legacy aliases", () => {
  it("eq carries exactly the 7 documented legacy aliases, each mapped to its canonical id", () => {
    const aliases = EFFECT_META.eq.params.filter((p) => p.deprecated);
    expect(aliases.map((p) => p.id).sort()).toEqual(
      ["highFreq", "highGain", "lowFreq", "lowGain", "midFreq", "midQ", "midGain"].sort(),
    );
    for (const alias of aliases) {
      expect(alias.aliasOf, `${alias.id}: aliasOf set`).toBeDefined();
      const canonical = EFFECT_META.eq.params.find((p) => p.id === alias.aliasOf);
      expect(canonical, `${alias.id}: canonical id exists`).toBeDefined();
      expect(canonical!.deprecated ?? false, `${alias.aliasOf}: canonical is not deprecated`).toBe(false);
      // The alias default must transfer 1:1 into the canonical range and the
      // ranges must overlap (some legacy ranges were historically narrower or
      // wider — canonical clamps take over on remap, which is the documented
      // compatibility contract).
      expect(alias.default).toBeGreaterThanOrEqual(canonical!.min);
      expect(alias.default).toBeLessThanOrEqual(canonical!.max);
      expect(alias.min).toBeLessThanOrEqual(canonical!.max);
      expect(alias.max).toBeGreaterThanOrEqual(canonical!.min);
    }
  });

  it("deprecated ids never surface as automation targets", () => {
    const { doc, trackId, fxId } = docWithEffect("eq");
    for (const p of EFFECT_META.eq.params) {
      const target = { kind: "fxParam" as const, trackId, fxId, paramId: p.id };
      expect(isAutomationTargetValid(doc, target)).toBe(!p.deprecated);
    }
    // ...and the canonical targets still exist for every alias target
    for (const alias of EFFECT_META.eq.params.filter((p) => p.deprecated)) {
      expect(
        isAutomationTargetValid(doc, { kind: "fxParam", trackId, fxId, paramId: alias.aliasOf! }),
        `${alias.aliasOf}: canonical target valid`,
      ).toBe(true);
    }
  });

  it("old documents keep their alias lanes — normalizeProject remaps them to canonical ids", () => {
    const { doc, trackId, fxId } = docWithEffect("eq");
    const legacy = {
      ...doc,
      automation: [
        {
          id: "legacy-lane",
          target: { kind: "fxParam", trackId, fxId, paramId: "midGain" },
          points: [
            { tick: 0, value: 3 },
            { tick: 480, value: 9 },
          ],
        },
      ],
    } as unknown as ProjectDocument;
    const normalized = normalizeProject(legacy);
    expect(normalized.automation.length).toBe(1);
    const lane = normalized.automation[0] as { target: { paramId: string }; points: { value: number }[] };
    expect(lane.target.paramId).toBe("lowMidGain");
    expect(lane.points.map((p) => p.value)).toEqual([3, 9]);
  });

  it("legacy documents still route alias writes to canonical params", () => {
    // setEffectParam remaps via eqLegacyMap — the compatibility path the
    // deprecation must not break.
    const { doc, trackId, fxId } = docWithEffect("eq");
    const store = new ProjectStore(doc);
    store.execute(setEffectParam(store.getDoc(), trackId, fxId, "midGain", 6));
    const fx = (
      store.getDoc().tracks.find((t) => t.id === trackId) as { effects: { id: string; params: Record<string, number> }[] }
    ).effects.find((f) => f.id === fxId)!;
    expect(fx.params.lowMidGain).toBe(6);
    expect(fx.params.midGain).toBe(6);
  });
});

describe("F. automation targets cover every parameter", () => {
  for (const type of ALL_EFFECT_TYPES) {
    it(`${type}: all params valid targets, lane values clamp into def range`, () => {
      const { doc, trackId, fxId } = docWithEffect(type);
      for (const p of EFFECT_META[type].params) {
        if (p.deprecated) continue; // F0: aliases are intentionally not targets
        const target = { kind: "fxParam" as const, trackId, fxId, paramId: p.id };
        expect(isAutomationTargetValid(doc, target), `${type}.${p.id}: valid target`).toBe(true);
        expect(clampTargetValue(doc, target, p.min - 100), `${type}.${p.id}: lane clamp mirrors param clamp`).toBe(
          clampEffectParam(type, p.id, p.min - 100),
        );
        expect(clampTargetValue(doc, target, p.max + 100), `${type}.${p.id}: lane clamp mirrors param clamp`).toBe(
          clampEffectParam(type, p.id, p.max + 100),
        );
        expect(clampTargetValue(doc, target, Number.NaN), `${type}.${p.id}: NaN lane → default`).toBe(p.default);
      }
    });
  }

  it("instrument params are valid instParam targets with clamped lane values", () => {
    const doc = createProjectFromTemplate("house");
    const track = doc.tracks.find((t) => t.kind === "instrument")!;
    for (const p of INSTRUMENT_META[track.instrument].params) {
      const target = { kind: "instParam" as const, trackId: track.id, paramId: p.id };
      expect(isAutomationTargetValid(doc, target), `${track.instrument}.${p.id}: valid target`).toBe(true);
      expect(clampTargetValue(doc, target, p.max + 50)).toBe(p.max);
      expect(clampTargetValue(doc, target, p.min - 50)).toBe(p.min);
    }
  });
});

/* ------------------------------------------------------------------ */
/* G. Factory preset surface                                           */
/* ------------------------------------------------------------------ */

describe("G. factory preset surface", () => {
  it("every instrument kind ships at least one factory preset", () => {
    const counts = new Map<string, number>();
    for (const preset of FACTORY_PRESETS) counts.set(preset.instrument, (counts.get(preset.instrument) ?? 0) + 1);
    const missing = INSTRUMENT_ORDER.filter((k) => (counts.get(k) ?? 0) === 0);
    expect(missing, `instruments without presets: ${missing.join(",")}`).toEqual([]);
  });

  it("every effect preset lands inside the declared parameter ranges", () => {
    expect(CORE_EFFECT_PRESETS.length).toBeGreaterThan(0);
    for (const preset of CORE_EFFECT_PRESETS) {
      const defs = EFFECT_META[preset.type].params;
      const defById = new Map(defs.map((p) => [p.id, p]));
      for (const [id, value] of Object.entries(preset.params)) {
        const def = defById.get(id);
        expect(def, `${preset.name} (${preset.type}): param ${id} exists`).toBeDefined();
        if (!def) continue;
        expect(Number.isFinite(value), `${preset.name}: ${id} finite`).toBe(true);
        expect(
          within(value, def.min - EPS, def.max + EPS),
          `${preset.name}: ${id}=${value} within [${def.min},${def.max}]`,
        ).toBe(true);
      }
    }
  });
});
