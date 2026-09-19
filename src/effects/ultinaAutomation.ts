/**
 * Automation-lane surface for the Ultina plugin's deep parameter space.
 *
 * The registry exposes only the 7 rack parameters of an Ultina device; the
 * vendored parameterSchema (`ultina-core/contracts/parameterSchema`) is the
 * authoritative source for every namespaced parameter ("eq.band3.gainDb",
 * "comp.thresholdDb", …). This module adapts that schema into lane-target
 * choices for the ModPanel (grouped by module prefix, filterable) and
 * range/formatter lookups for the lane point editor.
 *
 * Values are PLAIN-UNIT — the same domain setUltinaParam and the engine's
 * fxParam writers use — so a lane, the panel and the DSP never disagree on
 * the value domain.
 */
import { ALL_PARAMS, tryGetParamDef, type UltinaParamDef } from "./ultina-core/contracts/parameterSchema";

export interface UltinaLaneParam {
  /** Full namespaced parameter id ("comp.thresholdDb"). */
  id: string;
  /** Human label from the schema ("Threshold"). */
  label: string;
  /** Module prefix ("comp") — the grouping key for the picker. */
  module: string;
  min: number;
  max: number;
  unit: UltinaParamDef["unit"];
}

/** Pretty module name per parameter prefix, in signal-flow order. */
const MODULE_NAMES: Record<string, string> = {
  global: "Global",
  eq: "EQ",
  comp: "Comp",
  gate: "Gate",
  exciter: "Exciter",
  transient: "Transient",
  clipper: "Clipper",
  density: "Density",
  sculptor: "Sculptor",
  phase: "Phase",
  unmask: "Unmask",
};

function moduleIdOf(id: string): string {
  const dot = id.indexOf(".");
  return dot === -1 ? id : id.slice(0, dot);
}

function moduleName(prefix: string): string {
  return MODULE_NAMES[prefix] ?? prefix;
}

/** Every automatable Ultina parameter as a lane-target choice.
 * The schema's `automatable` flag already excludes booleans/enums whose
 * stepped semantics make no sense as continuous lanes. */
export function ultinaLaneParams(): UltinaLaneParam[] {
  return ALL_PARAMS.filter((d) => d.automatable).map((d) => ({
    id: d.id,
    label: d.name,
    module: moduleName(moduleIdOf(d.id)),
    min: d.minValue,
    max: d.maxValue,
    unit: d.unit,
  }));
}

/** Grouped, filterable `<option>` list for one Ultina instance.
 * Groups keep the ~200-deep surface navigable; `filter` matches the label
 * or the raw id, case-insensitively. */
export function ultinaOptionGroups(
  fxId: string,
  filter: string,
): Array<{ module: string; options: { value: string; label: string }[] }> {
  const f = filter.trim().toLowerCase();
  const byModule = new Map<string, { value: string; label: string }[]>();
  for (const p of ultinaLaneParams()) {
    if (f && !p.label.toLowerCase().includes(f) && !p.id.toLowerCase().includes(f)) continue;
    let list = byModule.get(p.module);
    if (!list) {
      list = [];
      byModule.set(p.module, list);
    }
    // Raw id in the label: band-numbered names ("Band 4 Gain") repeat across
    // groups, the id is what the user copies/recognizes in lane lists.
    list.push({ value: `fxParam:${fxId}:${p.id}`, label: `${p.label} · ${p.id}` });
  }
  return [...byModule.entries()].map(([module, options]) => ({ module, options }));
}

/** Lane-editor range + formatter for an Ultina parameter, or null when the
 * id is not part of the vendored schema (caller falls back to registry defs). */
export function ultinaLaneRange(paramId: string): { min: number; max: number; format: (v: number) => string } | null {
  const def = tryGetParamDef(paramId);
  if (!def) return null;
  return { min: def.minValue, max: def.maxValue, format: (v) => formatUltinaParam(def.unit, v) };
}

/** Plain-unit formatter shared by the lane editor's value readout. */
export function formatUltinaParam(unit: UltinaParamDef["unit"], v: number): string {
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
    case "degrees":
      return `${Math.round(v)}°`;
    case "boolean":
      return v >= 0.5 ? "ON" : "OFF";
    case "enum":
      return String(Math.round(v));
    default:
      return v.toFixed(2);
  }
}
