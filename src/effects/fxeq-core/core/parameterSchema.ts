/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/fxeq. Do not edit by hand — this is a
 * byte-faithful copy of the upstream DSP oracle so Pulse Forge and VocalForge
 * validate against the SAME golden fixtures (tests/fxeq-golden/). Fix DSP
 * issues upstream, then re-vendor via scripts/vendor-fxeq.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// FXEQ — Parameter schema + routing table
//
// The full parameter surface is large (~135 params for 6 bands) and
// hierarchical. To avoid collisions (every module has an "enabled" and
// "mix"), module params are namespaced with their module key:
//   band{n}.<moduleKey><CapitalizedParamId>   e.g. band2.satDriveDb
// Band scalars stay bare: band{n}.gainDb / enabled / mix.
//
// buildSchema() returns both the flat FxEqParamDef list and a routing
// table mapping each full id → its target (global / band scalar / module).
// ═══════════════════════════════════════════════════════════

import type { FxEqParamDef } from "../dsp/types.js";
import { MODULE_FACTORIES, MODULE_KEYS, type ModuleKey } from "./signalFlow.js";
import { MAX_BANDS } from "./crossover.js";

export type RouteKind = "global" | "bandScalar" | "module";

export interface RouteEntry {
  band: number; // 0 for global, 1..bandCount otherwise
  kind: RouteKind;
  moduleKey?: ModuleKey;
  /** The raw (unprefixed, un-namespaced) param id for the target. */
  rawId: string;
}

export interface FxEqSchema {
  defs: FxEqParamDef[];
  /** Def lookup by id — O(1). The worklet message port runs on the audio
   *  rendering thread, so loadParameters must not linear-scan defs per param
   *  (a full preset load used to cost ~60k string comparisons there). */
  defById: Map<string, FxEqParamDef>;
  routes: Map<string, RouteEntry>;
  defaultParams: Record<string, number>;
}

// ── Global parameters ────────────────────────────────────────
export const GLOBAL_PARAM_DEFS: readonly FxEqParamDef[] = [
  { id: "inputGainDb", name: "Input Gain", defaultValue: 0, minValue: -24, maxValue: 24, unit: "dB", automatable: true },
  { id: "outputGainDb", name: "Output Gain", defaultValue: 0, minValue: -24, maxValue: 24, unit: "dB", automatable: true },
  { id: "bandCount", name: "Active Bands", defaultValue: 6, minValue: 2, maxValue: MAX_BANDS, automatable: false },
  { id: "crossoverFreq2", name: "Xover 2", defaultValue: 400, minValue: 80, maxValue: 800, unit: "Hz", automatable: true },
  { id: "crossoverFreq3", name: "Xover 3", defaultValue: 1200, minValue: 300, maxValue: 3000, unit: "Hz", automatable: true },
  { id: "crossoverFreq4", name: "Xover 4", defaultValue: 4000, minValue: 1500, maxValue: 6000, unit: "Hz", automatable: true },
  { id: "crossoverFreq5", name: "Xover 5", defaultValue: 8000, minValue: 4000, maxValue: 12000, unit: "Hz", automatable: true },
  { id: "globalMix", name: "Wet/Dry Mix", defaultValue: 100, minValue: 0, maxValue: 100, unit: "%", automatable: true },
  { id: "fxOnly", name: "FX Only", defaultValue: 0, minValue: 0, maxValue: 1, automatable: false },
  { id: "limiterEnabled", name: "Limiter", defaultValue: 1, minValue: 0, maxValue: 1, automatable: false },
  { id: "limiterCeilDb", name: "Limiter Ceiling", defaultValue: -0.3, minValue: -6, maxValue: 0, unit: "dB", automatable: true },
  { id: "limiterTruePeak", name: "True Peak", defaultValue: 1, minValue: 0, maxValue: 1, automatable: false },
  { id: "limiterLookaheadMs", name: "Lookahead", defaultValue: 2, minValue: 0, maxValue: 5, unit: "ms", automatable: false },
  { id: "limiterPdr", name: "Limiter PDR", defaultValue: 0, minValue: 0, maxValue: 1, automatable: true },
] as const;

// ── Per-band scalar parameters ───────────────────────────────
export const BAND_SCALAR_DEFS: readonly FxEqParamDef[] = [
  { id: "gainDb", name: "Band Gain", defaultValue: 0, minValue: -48, maxValue: 12, unit: "dB", automatable: true },
  { id: "enabled", name: "Band Enable", defaultValue: 1, minValue: 0, maxValue: 1, automatable: false },
  { id: "mix", name: "Band Mix", defaultValue: 100, minValue: 0, maxValue: 100, unit: "%", automatable: true },
  { id: "midSide", name: "M/S Mode", defaultValue: 0, minValue: 0, maxValue: 2, automatable: false },
  { id: "dynEnable", name: "Dynamic EQ", defaultValue: 0, minValue: 0, maxValue: 1, automatable: false },
  { id: "dynThresholdDb", name: "Dyn Threshold", defaultValue: -20, minValue: -60, maxValue: 0, unit: "dB", automatable: true },
  { id: "dynRangeDb", name: "Dyn Range", defaultValue: -6, minValue: -24, maxValue: 0, unit: "dB", automatable: true },
  { id: "dynAttackMs", name: "Dyn Attack", defaultValue: 10, minValue: 0.1, maxValue: 100, unit: "ms", automatable: true },
  { id: "dynReleaseMs", name: "Dyn Release", defaultValue: 100, minValue: 10, maxValue: 1000, unit: "ms", automatable: true },
  { id: "solo", name: "Solo", defaultValue: 0, minValue: 0, maxValue: 1, automatable: false },
  { id: "mute", name: "Mute", defaultValue: 0, minValue: 0, maxValue: 1, automatable: false },
  { id: "phaseInvert", name: "Phase Invert", defaultValue: 0, minValue: 0, maxValue: 1, automatable: false },
  { id: "sidechainMode", name: "Sidechain", defaultValue: 0, minValue: 0, maxValue: 1, automatable: false },
  { id: "quality", name: "Quality", defaultValue: 1, minValue: 0, maxValue: 3, automatable: false },
  { id: "linkGroup", name: "Link Group", defaultValue: 0, minValue: 0, maxValue: 5, automatable: false },
];

/** Cache each module's parameter defs (one stateless probe per module). */
const MODULE_PARAM_DEFS: Record<ModuleKey, readonly FxEqParamDef[]> = (() => {
  const out = {} as Record<ModuleKey, readonly FxEqParamDef[]>;
  for (const key of MODULE_KEYS) out[key] = MODULE_FACTORIES[key]().parameterDefs;
  return out;
})();

/** Capitalize the first letter of a param id for namespacing. */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Build the full flat param defs + routing table for `bandCount` bands. */
export function buildSchema(bandCount: number): FxEqSchema {
  const defs: FxEqParamDef[] = [];
  const defById = new Map<string, FxEqParamDef>();
  const routes = new Map<string, RouteEntry>();
  const defaultParams: Record<string, number> = {};

  for (const def of GLOBAL_PARAM_DEFS) {
    defs.push(def);
    defById.set(def.id, def);
    routes.set(def.id, { band: 0, kind: "global", rawId: def.id });
    defaultParams[def.id] = def.defaultValue;
  }

  for (let b = 1; b <= bandCount; b++) {
    const bandPrefix = `band${b}.`;
    // Band scalars.
    for (const def of BAND_SCALAR_DEFS) {
      const fullId = bandPrefix + def.id;
      const fullDef = { ...def, id: fullId, name: `B${b} ${def.name}` };
      defs.push(fullDef);
      defById.set(fullId, fullDef);
      routes.set(fullId, { band: b, kind: "bandScalar", rawId: def.id });
      defaultParams[fullId] = def.defaultValue;
    }
    // Module params, namespaced by module key.
    for (const key of MODULE_KEYS) {
      for (const mdef of MODULE_PARAM_DEFS[key]) {
        const fullId = bandPrefix + key + capitalize(mdef.id);
        const fullDef = { ...mdef, id: fullId, name: `B${b} ${mdef.name}` };
        defs.push(fullDef);
        defById.set(fullId, fullDef);
        routes.set(fullId, { band: b, kind: "module", moduleKey: key, rawId: mdef.id });
        defaultParams[fullId] = mdef.defaultValue;
      }
    }
  }

  return { defs, defById, routes, defaultParams };
}

/** Strip a `bandN.` prefix; returns the band index + remainder, or null. */
export function stripBandPrefix(fullId: string): { band: number; id: string } | null {
  const m = /^band(\d+)\.(.+)$/.exec(fullId);
  if (!m) return null;
  return { band: Number(m[1]), id: m[2] };
}
