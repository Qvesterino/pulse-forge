import type { EffectType, InstrumentKind, ProjectDocument } from "./project-model/types";
import { EFFECT_META, EFFECT_PRIMARY_KNOB } from "./effects/definitions";
import type { ParamDef } from "./effects/types";
import { INSTRUMENT_META, INSTRUMENT_ORDER } from "./instruments/definitions";
import { buildCapabilityMatrix } from "./intent/semantics/param-registry";
import { targetTrackIds } from "./intent/semantics/target-resolution";
import { MIX_TARGET_IDS, type MixTargetId } from "./intent/semantics/target-registry";

export const EFFECT_CATALOG_TYPES = Object.keys(EFFECT_META) as EffectType[];

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
  primaryKnob: string | null;
  primaryRole: string | null;
  parameters: PluginCatalogParameter[];
  intentControls: Array<{
    role: string;
    paramId: string;
    min: number;
    max: number;
    default: number;
    unit: string | null;
  }>;
}

export interface InstrumentCatalogEntry {
  kind: InstrumentKind;
  name: string;
  parameters: PluginCatalogParameter[];
}

export interface InstalledEffectParameter extends PluginCatalogParameter {
  value: number;
}

/** A canonical read-only view of one effect instance in the current project. */
export interface InstalledEffectInstance {
  trackId: string;
  trackName: string;
  trackOrdinal: number;
  targets: MixTargetId[];
  instance: number;
  effectId: string;
  type: EffectType;
  name: string;
  category: EffectCatalogEntry["category"];
  bypassed: boolean;
  invalidParameters: string[];
  parameters: InstalledEffectParameter[];
}

const EFFECT_CAPABILITY_MATRIX = buildCapabilityMatrix();

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
  return EFFECT_CATALOG_TYPES.map((type) => getEffectCatalogEntry(type)!);
}

export function getEffectCatalogEntry(type: string): EffectCatalogEntry | null {
  if (!Object.prototype.hasOwnProperty.call(EFFECT_META, type)) return null;
  const meta = EFFECT_META[type as EffectType];
  // Deprecated aliases are NOT settable agent surface — the canonical id is
  // the one the runtime consumes; the aliases exist for old documents and
  // are remapped inside the command layer (R-08: same rule as the
  // instrument catalog below).
  const parameters = meta.params.filter((param) => param.deprecated !== true).map(pluginCatalogParameter);
  const parameterById = new Map(parameters.map((parameter) => [parameter.id, parameter]));
  const primaryKnob = EFFECT_PRIMARY_KNOB[meta.type] ?? null;
  const primaryRole = primaryKnob
    ? (EFFECT_CAPABILITY_MATRIX.find(
        (row) => row.effectType === type && row.paramId === primaryKnob && row.exposedBy === "effect",
      )?.role ?? null)
    : null;
  const intentControls = EFFECT_CAPABILITY_MATRIX.filter((row) => row.effectType === type && row.exposedBy === "param")
    .map((row) => {
      const parameter = parameterById.get(row.paramId);
      return parameter
        ? {
            role: row.role,
            paramId: parameter.id,
            min: parameter.min,
            max: parameter.max,
            default: parameter.default,
            unit: parameter.unit,
          }
        : null;
    })
    .filter((control): control is NonNullable<typeof control> => control !== null);
  return {
    type: meta.type,
    name: meta.name,
    category: meta.category,
    primaryKnob,
    primaryRole,
    parameters,
    intentControls,
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

/**
 * Resolve intent families to the same concrete tracks used by effect and
 * parameter intents. MCP effect tools call this too, so family targets cannot
 * drift between the conversational and structured-tool surfaces.
 */
export function pluginTargetTrackIds(doc: ProjectDocument, targets: readonly MixTargetId[]): string[] {
  return targetTrackIds(doc, targets);
}

/** Resolve only tracks in the requested families that already carry an FX. */
export function installedEffectTrackIds(
  doc: ProjectDocument,
  type: string,
  targets: readonly MixTargetId[],
  explicitTrackIds?: readonly string[],
  trackOrdinal?: number,
): string[] {
  if (!getEffectCatalogEntry(type)) return [];
  const candidates = new Set(targetTrackIds(doc, targets, explicitTrackIds, trackOrdinal));
  return doc.tracks
    .filter((track) => candidates.has(track.id) && track.effects.some((effect) => effect.type === type))
    .map((track) => track.id);
}

/**
 * Snapshot the full installed FX chain using catalog-owned parameter
 * contracts. Unknown/stale effect types are omitted instead of inventing a
 * parameter schema for them.
 */
export function listInstalledEffectInstances(
  doc: ProjectDocument,
  selectedTrackIds?: readonly string[],
): InstalledEffectInstance[] {
  const selected = selectedTrackIds == null ? null : new Set(selectedTrackIds);
  const result: InstalledEffectInstance[] = [];
  let trackOrdinal = 0;

  for (const track of doc.tracks) {
    if (track.kind === "group") continue;
    trackOrdinal += 1;
    if (selected && !selected.has(track.id)) continue;

    const typeCounts = new Map<string, number>();
    for (const effect of track.effects ?? []) {
      const catalog = getEffectCatalogEntry(effect.type);
      if (!catalog) continue;
      const instance = (typeCounts.get(effect.type) ?? 0) + 1;
      typeCounts.set(effect.type, instance);
      const parameters = catalog.parameters.map((parameter) => {
        const stored = effect.params?.[parameter.id];
        return {
          ...parameter,
          value: typeof stored === "number" && Number.isFinite(stored) ? stored : parameter.default,
        };
      });
      const invalidParameters = catalog.parameters
        .filter((parameter) => {
          const stored = effect.params?.[parameter.id];
          return stored !== undefined && (typeof stored !== "number" || !Number.isFinite(stored));
        })
        .map((parameter) => parameter.id);
      const targets = MIX_TARGET_IDS.filter((target) => targetTrackIds(doc, [target]).includes(track.id));
      result.push({
        trackId: track.id,
        trackName: track.name,
        trackOrdinal,
        targets,
        instance,
        effectId: effect.id,
        type: catalog.type,
        name: catalog.name,
        category: catalog.category,
        bypassed: effect.bypassed === true,
        invalidParameters,
        parameters,
      });
    }
  }

  return result;
}
