import type { EffectType, InstrumentKind } from "./project-model/types";
import { EFFECT_META } from "./effects/definitions";
import type { ParamDef } from "./effects/types";
import { INSTRUMENT_META, INSTRUMENT_ORDER } from "./instruments/definitions";

/** JSON-safe parameter data shared by MCP discovery and intent context. */
export interface PluginCatalogParameter {
  id: string;
  label: string;
  min: number;
  max: number;
  default: number;
  unit: string | null;
  description: string | null;
  kind: ParamDef["kind"] | null;
  step: number | null;
  taper: ParamDef["taper"] | null;
  options: Array<{ value: number; label: string }>;
}

export interface EffectCatalogEntry {
  type: EffectType;
  name: string;
  category: (typeof EFFECT_META)[EffectType]["category"];
  parameters: PluginCatalogParameter[];
}

export interface InstrumentCatalogEntry {
  kind: InstrumentKind;
  name: string;
  parameters: PluginCatalogParameter[];
}

export function pluginCatalogParameter(param: ParamDef): PluginCatalogParameter {
  return {
    id: param.id,
    label: param.label,
    min: param.min,
    max: param.max,
    default: param.default,
    unit: param.unit ?? null,
    description: param.description ?? null,
    kind: param.kind ?? null,
    step: param.step ?? null,
    taper: param.taper ?? null,
    options: (param.options ?? []).map((option) => ({ value: option.value, label: option.label })),
  };
}

export function listEffectCatalogEntries(): EffectCatalogEntry[] {
  return (Object.keys(EFFECT_META) as EffectType[]).map((type) => {
    const meta = EFFECT_META[type];
    return {
      type,
      name: meta.name,
      category: meta.category,
      parameters: meta.params.map(pluginCatalogParameter),
    };
  });
}

export function getEffectCatalogEntry(type: string): EffectCatalogEntry | null {
  if (!Object.prototype.hasOwnProperty.call(EFFECT_META, type)) return null;
  const meta = EFFECT_META[type as EffectType];
  return {
    type: meta.type,
    name: meta.name,
    category: meta.category,
    parameters: meta.params.map(pluginCatalogParameter),
  };
}

export function listInstrumentCatalogEntries(): InstrumentCatalogEntry[] {
  return INSTRUMENT_ORDER.map((kind) => getInstrumentCatalogEntry(kind)!);
}

export function getInstrumentCatalogEntry(kind: string): InstrumentCatalogEntry | null {
  if (!Object.prototype.hasOwnProperty.call(INSTRUMENT_META, kind)) return null;
  const meta = INSTRUMENT_META[kind as InstrumentKind];
  return {
    kind: meta.kind,
    name: meta.name,
    parameters: meta.params.filter((param) => param.deprecated !== true).map(pluginCatalogParameter),
  };
}
