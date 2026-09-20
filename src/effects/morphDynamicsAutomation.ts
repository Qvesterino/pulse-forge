/**
 * Automation-lane surface for MORPH DYNAMICS' deep parameter space.
 *
 * The registry exposes the 8 rack macros; the parameterSchema
 * (morph-dynamics-core/contracts/parameterSchema) is the authoritative
 * source for every namespaced parameter ("dyn.thresholdDb",
 * "space.decayS", "routes.1.amount", …). This module adapts that schema
 * into lane-target choices for the ModPanel (grouped by module prefix)
 * and range/formatter lookups for the lane point editor.
 *
 * Values are PLAIN-UNIT — the same domain setMorphDynamicsParam and the
 * engine's fxParam writers use — so a lane, the panel and the DSP never
 * disagree on the value domain.
 */
import { ALL_PARAMS, tryGetParamDef, type MorphParamDef } from "./morph-dynamics-core/contracts/parameterSchema";

export interface MorphLaneParam {
  /** Full namespaced parameter id ("dyn.thresholdDb"). */
  id: string;
  /** Human label from the schema ("Threshold"). */
  label: string;
  /** Module prefix ("dyn") — the grouping key for the picker. */
  module: string;
  min: number;
  max: number;
  unit: MorphParamDef["unit"];
}

/** Pretty module name per parameter prefix, in signal-flow order. */
const MODULE_NAMES: Record<string, string> = {
  global: "Global",
  macro: "Macros",
  analysis: "Analysis",
  dyn: "Dynamics",
  char: "Character",
  motion: "Motion",
  space: "Space",
  routes: "Mod Matrix",
};

function moduleIdOf(id: string): string {
  const dot = id.indexOf(".");
  return dot === -1 ? id : id.slice(0, dot);
}

function moduleName(prefix: string): string {
  return MODULE_NAMES[prefix] ?? prefix;
}

/**
 * Route slots collapse to slot 1's params as representative lanes — 8×5
 * route lanes would drown the picker; authors target slot 1 and re-point
 * the route in the panel's matrix view.
 */
function isRepresentativeRouteParam(id: string): boolean {
  return id.startsWith("routes.1.");
}

/** Every automatable MORPH parameter as a lane-target choice. The schema's
 * `automatable` flag already excludes booleans/enums whose stepped
 * semantics make no sense as continuous lanes. */
export function morphLaneParams(): MorphLaneParam[] {
  return ALL_PARAMS.filter(
    (d) => d.automatable && (!d.id.startsWith("routes.") || isRepresentativeRouteParam(d.id)),
  ).map((d) => ({
    id: d.id,
    label: d.name,
    module: moduleName(moduleIdOf(d.id)),
    min: d.minValue,
    max: d.maxValue,
    unit: d.unit,
  }));
}

/** Grouped, filterable `<option>` list for one MORPH instance.
 * Groups keep the ~60-deep surface navigable; `filter` matches the label
 * or the raw id, case-insensitively. */
export function morphOptionGroups(
  fxId: string,
  filter: string,
): Array<{ module: string; options: { value: string; label: string }[] }> {
  const f = filter.trim().toLowerCase();
  const byModule = new Map<string, { value: string; label: string }[]>();
  for (const p of morphLaneParams()) {
    if (f && !p.label.toLowerCase().includes(f) && !p.id.toLowerCase().includes(f)) continue;
    let list = byModule.get(p.module);
    if (!list) {
      list = [];
      byModule.set(p.module, list);
    }
    list.push({ value: `fxParam:${fxId}:${p.id}`, label: `${p.label} · ${p.id}` });
  }
  return [...byModule.entries()].map(([module, options]) => ({ module, options }));
}

/** Lane-editor range + formatter for a MORPH parameter, or null when the
 * id is not part of the schema (caller falls back to registry defs). */
export function morphLaneRange(paramId: string): { min: number; max: number; format: (v: number) => string } | null {
  const def = tryGetParamDef(paramId);
  if (!def) return null;
  return { min: def.minValue, max: def.maxValue, format: (v) => formatMorphParam(def.unit, v) };
}

/** Plain-unit formatter shared by the lane editor's value readout. */
export function formatMorphParam(unit: MorphParamDef["unit"], v: number): string {
  if (!Number.isFinite(v)) return "–";
  switch (unit) {
    case "db":
      return `${v >= 0 ? "+" : ""}${v.toFixed(1)} dB`;
    case "hz":
      return v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`;
    case "ms":
      return `${v.toFixed(v < 10 ? 1 : 0)} ms`;
    case "percent":
      return `${Math.round(v)}%`;
    case "ratio":
      return `${v.toFixed(2)}:1`;
    case "sec":
      return `${v.toFixed(2)} s`;
    case "boolean":
      return v >= 0.5 ? "ON" : "OFF";
    case "enum":
      return String(Math.round(v));
    default:
      return v.toFixed(2);
  }
}
