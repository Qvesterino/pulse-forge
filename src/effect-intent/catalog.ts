import type { EffectInstance, EffectType } from "../project-model/types";
import { EFFECT_DEFS, clampEffectParam } from "../effects/registry";
import { buildSchema as buildFxEqSchema } from "../effects/fxeq-core/core/parameterSchema";
import {
  ALL_PARAMS as ULTINA_PARAMS,
  clampParam as clampUltinaParam,
} from "../effects/ultina-core/contracts/parameterSchema";
import { defaultOzvenaStateV1 } from "../effects/ozvena-core/v2/types";
import { OZVENA_AUDIO_PARAM_SECTIONS, OZVENA_ENUM_VALUES, ozvenaParamRange } from "../effects/ozvena-params";
import { effectIntentFingerprint } from "./canonical";
import {
  EFFECT_INTENT_MAPPINGS,
  EFFECT_INTENT_PILOT_TYPES,
  effectIntentGoalsForParam,
  effectIntentMappingsForParam,
} from "./capabilities";
import type {
  EffectIntentCatalogCoverageReport,
  EffectIntentCatalogSnapshot,
  EffectIntentParameterDescriptor,
  EffectParameterDescriptor,
} from "./types";

const EQ_LEGACY_ALIASES = new Set(["lowGain", "lowFreq", "midGain", "midFreq", "midQ", "highGain", "highFreq"]);
const FXEQ_DEEP_TOGGLE_IDS = new Set(["fxOnly", "limiterEnabled", "limiterTruePeak"]);
const FXEQ_DEEP_TOGGLE_BAND_SUFFIXES = new Set([
  "enabled",
  "dynEnable",
  "dynEnabled",
  "solo",
  "mute",
  "phaseInvert",
  "satEnabled",
  "lofiEnabled",
  "modEnabled",
  "delayEnabled",
  "revEnabled",
]);
const FXEQ_DEEP_RACK_ALIASES: Readonly<Record<string, string>> = { globalMix: "mix" };

export function supportsEffectIntent(type: EffectType): boolean {
  return EFFECT_INTENT_PILOT_TYPES.includes(type);
}

function getFxEqBandCount(effect: EffectInstance): number {
  const raw = effect.params.bandCount ?? EFFECT_DEFS.fxeq.params.find((param) => param.id === "bandCount")!.default;
  const clamped = clampEffectParam("fxeq", "bandCount", raw);
  return Math.max(2, Math.min(6, Math.round(clamped)));
}

function fxEqDeepKind(id: string, automatable: boolean | undefined): EffectParameterDescriptor["kind"] {
  if (FXEQ_DEEP_TOGGLE_IDS.has(id)) return "toggle";
  const bandMatch = /^band\d+\.(.+)$/.exec(id);
  if (bandMatch && FXEQ_DEEP_TOGGLE_BAND_SUFFIXES.has(bandMatch[1])) return "toggle";
  // The vendored schema does not expose enum values for these parameters.
  // Unknown is safer than presenting a structural numeric range as a knob.
  return automatable === true ? "continuous" : "unknown";
}

function isDescriptorValueValid(
  current: number,
  min: number,
  max: number,
  kind: EffectParameterDescriptor["kind"],
  options?: readonly { value: number }[],
  step?: number,
): boolean {
  if (!Number.isFinite(current) || current < min || current > max) return false;
  if (options?.length && !options.some((option) => option.value === current)) return false;
  if (kind === "toggle" && current !== 0 && current !== 1) return false;
  if (kind === "discrete") {
    const increment = step && step > 0 ? step : 1;
    if (Math.abs((current - min) / increment - Math.round((current - min) / increment)) > 1e-9) return false;
  }
  return true;
}

function collectUltinaDescriptors(effect: EffectInstance): EffectParameterDescriptor[] {
  const schemaId = `ultina-${effectIntentFingerprint(
    ULTINA_PARAMS.map((def) => ({
      id: def.id,
      name: def.name,
      defaultValue: def.defaultValue,
      minValue: def.minValue,
      maxValue: def.maxValue,
      unit: def.unit,
      automatable: def.automatable,
      step: def.step,
      enumValues: def.enumValues,
    })),
  )}`;
  return ULTINA_PARAMS.map((def) => {
    const current = effect.params[def.id] ?? def.defaultValue;
    const enumOptions = def.enumValues?.map((label, index) => ({ value: def.minValue + index, label }));
    const kind: EffectParameterDescriptor["kind"] =
      def.unit === "boolean" ? "toggle" : enumOptions?.length ? "enum" : def.step ? "discrete" : "continuous";
    const schemaDescribesEnum =
      !def.enumValues ||
      (Number.isInteger(def.minValue) &&
        Number.isInteger(def.maxValue) &&
        def.enumValues.length === def.maxValue - def.minValue + 1);
    const effectiveKind = schemaDescribesEnum ? kind : "unknown";
    const options = schemaDescribesEnum
      ? (enumOptions ??
        (effectiveKind === "toggle"
          ? [
              { value: 0, label: "Off" },
              { value: 1, label: "On" },
            ]
          : undefined))
      : undefined;

    return {
      id: def.id,
      label: def.name,
      min: def.minValue,
      max: def.maxValue,
      default: def.defaultValue,
      current,
      ...(def.unit !== "generic" && def.unit !== "boolean" ? { unit: def.unit } : {}),
      kind: effectiveKind,
      taper: "unknown" as const,
      ...(def.step ? { step: def.step } : {}),
      ...(options?.length ? { options } : {}),
      source: "ultina" as const,
      schemaId,
      currentValidation: effectiveKind === "unknown" ? ("rangeOnly" as const) : ("complete" as const),
      automationSupported: def.automatable,
      currentIsValid:
        clampUltinaParam(def.id, current) === current &&
        isDescriptorValueValid(current, def.minValue, def.maxValue, effectiveKind, options, def.step),
    };
  });
}

interface OzvenaSchemaField {
  id: string;
  label: string;
  default: number;
  min: number;
  max: number;
  kind: "continuous" | "toggle" | "enum";
  options?: Array<{ value: number; label: string }>;
}

function flattenOzvenaNumericFields(value: unknown, prefix = "", out: OzvenaSchemaField[] = []): OzvenaSchemaField[] {
  if (value === null || value === undefined || Array.isArray(value)) return out;
  if (typeof value === "number" || typeof value === "boolean") {
    if (!prefix) return out;
    const defaultValue = typeof value === "boolean" ? (value ? 1 : 0) : value;
    const range = ozvenaParamRange(prefix, value);
    const toggle =
      typeof value === "boolean" || /(?:^|\.)(?:enabled|syncEnabled|bypass|freeze|gate|fxOnly)$/.test(prefix);
    out.push({
      id: prefix,
      label: prefix.split(".").at(-1) ?? prefix,
      default: defaultValue,
      min: range.min,
      max: range.max,
      kind: toggle ? "toggle" : "continuous",
      ...(toggle
        ? {
            options: [
              { value: 0, label: "Off" },
              { value: 1, label: "On" },
            ],
          }
        : {}),
    });
    return out;
  }
  if (typeof value !== "object") return out;
  for (const [key, child] of Object.entries(value)) {
    flattenOzvenaNumericFields(child, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

function getOzvenaPathValue(state: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[key];
  }, state);
}

function collectOzvenaDescriptors(effect: EffectInstance): EffectParameterDescriptor[] {
  const state = defaultOzvenaStateV1();
  const numericFields = OZVENA_AUDIO_PARAM_SECTIONS.flatMap((section) =>
    flattenOzvenaNumericFields(state[section], section),
  );
  const enumFields: OzvenaSchemaField[] = Object.entries(OZVENA_ENUM_VALUES).flatMap(([id, values]) => {
    const defaultValue = getOzvenaPathValue(state, id);
    const defaultIndex = typeof defaultValue === "string" ? (values as readonly string[]).indexOf(defaultValue) : -1;
    if (defaultIndex < 0) return [];
    return [
      {
        id,
        label: id.split(".").at(-1) ?? id,
        default: defaultIndex,
        min: 0,
        max: values.length - 1,
        kind: "enum" as const,
        options: values.map((label, value) => ({ value, label })),
      },
    ];
  });
  const fields = [...numericFields, ...enumFields];
  const schemaId = `ozvena-${String(state.schemaVersion)}-${effectIntentFingerprint(fields)}`;

  return fields.map((field) => {
    const current = effect.params[field.id] ?? field.default;
    return {
      id: field.id,
      label: field.label,
      min: field.min,
      max: field.max,
      default: field.default,
      current,
      kind: field.kind,
      taper: "unknown" as const,
      ...(field.options?.length ? { options: field.options } : {}),
      source: "ozvena" as const,
      schemaId,
      currentValidation: field.kind === "continuous" ? ("rangeOnly" as const) : ("complete" as const),
      currentIsValid: isDescriptorValueValid(current, field.min, field.max, field.kind, field.options),
    };
  });
}

function rackSchemaShape(effectType: EffectType) {
  return EFFECT_DEFS[effectType].params.map((param) => ({
    id: param.id,
    label: param.label,
    min: param.min,
    max: param.max,
    default: param.default,
    unit: param.unit,
    taper: param.taper,
    kind: param.kind,
    step: param.step,
    options: param.options?.map((option) => ({ value: option.value, label: option.label })),
  }));
}

/**
 * Normalize the technical metadata from the existing rack ParamDef for every
 * built-in effect. This is descriptive only: it does not authorize natural-
 * language edits, and malformed persisted values are reported, not repaired.
 */
export function effectParameterDescriptorCatalog(effect: EffectInstance): EffectParameterDescriptor[] {
  const bandCount = effect.type === "fxeq" ? getFxEqBandCount(effect) : null;
  const fxEqSchema = bandCount === null ? null : buildFxEqSchema(bandCount);
  const rackShape = rackSchemaShape(effect.type);
  const fxEqSchemaId = fxEqSchema
    ? `fxeq-band-${bandCount}-${effectIntentFingerprint({
        rack: rackShape,
        deep: fxEqSchema.defs.map((def) => ({
          id: def.id,
          name: def.name,
          minValue: def.minValue,
          maxValue: def.maxValue,
          defaultValue: def.defaultValue,
          unit: def.unit,
          logScale: def.logScale,
          automatable: def.automatable,
        })),
      })}`
    : null;
  const rackSchemaId = `rack-${effect.type}-${effectIntentFingerprint(rackShape)}`;
  const rackDescriptors = EFFECT_DEFS[effect.type].params.map((param) => {
    const current = effect.params[param.id] ?? param.default;
    let options = param.options?.map((option) => ({ value: option.value, label: option.label }));
    const kind: EffectParameterDescriptor["kind"] = param.kind ?? (options?.length ? "enum" : "continuous");
    const step = param.step;
    if (kind === "toggle" && !options?.length) {
      options = [
        { value: 0, label: "Off" },
        { value: 1, label: "On" },
      ];
    }
    if (effect.type === "fxeq" && param.id === "bandCount") {
      options = Array.from({ length: param.max - param.min + 1 }, (_, index) => {
        const value = param.min + index;
        return { value, label: `${value} bands` };
      });
    }
    const schemaId = fxEqSchemaId ?? rackSchemaId;
    const schemaDef =
      effect.type === "fxeq"
        ? (fxEqSchema!.defById.get(param.id) ?? fxEqSchema!.defById.get(FXEQ_DEEP_RACK_ALIASES[param.id]))
        : undefined;
    const currentIsValid =
      clampEffectParam(effect.type, param.id, current) === current &&
      isDescriptorValueValid(current, param.min, param.max, kind, options, step);

    return {
      id: param.id,
      label: param.label,
      min: param.min,
      max: param.max,
      default: param.default,
      current,
      ...(param.unit ? { unit: param.unit } : {}),
      ...(param.format ? { format: param.format } : {}),
      kind,
      taper: param.taper ?? "linear",
      ...(step ? { step } : {}),
      ...(options?.length ? { options } : {}),
      source: "rack" as const,
      schemaId,
      currentValidation:
        kind === "unknown" || (kind === "enum" && !options?.length) ? ("rangeOnly" as const) : ("complete" as const),
      ...(schemaDef ? { automationSupported: schemaDef.automatable === true } : {}),
      currentIsValid,
    };
  });

  if (effect.type === "ultina") {
    const ultinaDescriptors = collectUltinaDescriptors(effect);
    const byId = new Map(ultinaDescriptors.map((descriptor) => [descriptor.id, descriptor]));
    const enrichedRackDescriptors = rackDescriptors.map((rackDescriptor) => {
      const schemaDescriptor = byId.get(rackDescriptor.id);
      if (!schemaDescriptor) return rackDescriptor;
      return {
        ...schemaDescriptor,
        ...rackDescriptor,
        min: schemaDescriptor.min,
        max: schemaDescriptor.max,
        default: schemaDescriptor.default,
        current: schemaDescriptor.current,
        unit: schemaDescriptor.unit ?? rackDescriptor.unit,
        kind: schemaDescriptor.kind,
        taper: schemaDescriptor.taper,
        step: schemaDescriptor.step,
        options: schemaDescriptor.options,
        source: "rack" as const,
        schemaId: schemaDescriptor.schemaId,
        currentValidation: schemaDescriptor.currentValidation,
        automationSupported: schemaDescriptor.automationSupported,
        currentIsValid: schemaDescriptor.currentIsValid,
      };
    });
    const rackIds = new Set(enrichedRackDescriptors.map((descriptor) => descriptor.id));
    return [...enrichedRackDescriptors, ...ultinaDescriptors.filter((descriptor) => !rackIds.has(descriptor.id))];
  }

  if (effect.type === "ozvena") {
    const ozvenaDescriptors = collectOzvenaDescriptors(effect);
    const byId = new Map(ozvenaDescriptors.map((descriptor) => [descriptor.id, descriptor]));
    const enrichedRackDescriptors = rackDescriptors.map((rackDescriptor) => {
      const schemaDescriptor = byId.get(rackDescriptor.id);
      if (!schemaDescriptor) return rackDescriptor;
      return {
        ...schemaDescriptor,
        ...rackDescriptor,
        min: schemaDescriptor.min,
        max: schemaDescriptor.max,
        default: schemaDescriptor.default,
        current: schemaDescriptor.current,
        unit: rackDescriptor.unit,
        kind: schemaDescriptor.kind,
        taper: schemaDescriptor.taper,
        options: schemaDescriptor.options ?? rackDescriptor.options,
        source: "rack" as const,
        schemaId: schemaDescriptor.schemaId,
        currentValidation: schemaDescriptor.currentValidation,
        currentIsValid: schemaDescriptor.currentIsValid,
      };
    });
    const rackIds = new Set(enrichedRackDescriptors.map((descriptor) => descriptor.id));
    return [...enrichedRackDescriptors, ...ozvenaDescriptors.filter((descriptor) => !rackIds.has(descriptor.id))];
  }

  if (!fxEqSchema || !fxEqSchemaId) return rackDescriptors;

  const rackIds = new Set(rackDescriptors.map((descriptor) => descriptor.id));
  const fxEqDescriptors = fxEqSchema.defs
    .filter((def) => !rackIds.has(def.id) && FXEQ_DEEP_RACK_ALIASES[def.id] === undefined)
    .map((def) => {
      const current = effect.params[def.id] ?? def.defaultValue;
      const kind = fxEqDeepKind(def.id, def.automatable);
      const options =
        kind === "toggle"
          ? [
              { value: 0, label: "Off" },
              { value: 1, label: "On" },
            ]
          : undefined;
      return {
        id: def.id,
        label: def.name,
        min: def.minValue,
        max: def.maxValue,
        default: def.defaultValue,
        current,
        ...(def.unit ? { unit: def.unit } : {}),
        kind,
        taper: def.logScale ? ("log" as const) : ("linear" as const),
        ...(options ? { options } : {}),
        ...(kind === "toggle" ? { step: 1 } : {}),
        source: "fxeq" as const,
        schemaId: fxEqSchemaId,
        currentValidation: kind === "unknown" ? ("rangeOnly" as const) : ("complete" as const),
        automationSupported: def.automatable === true,
        currentIsValid: isDescriptorValueValid(current, def.minValue, def.maxValue, kind),
      };
    });

  return [...rackDescriptors, ...fxEqDescriptors];
}

/** Stable identity for the complete technical parameter surface of one device. */
export function effectParameterDescriptorsSchemaFingerprint(
  effectType: EffectType,
  descriptors: readonly Pick<EffectParameterDescriptor, "id" | "schemaId">[],
): string | null {
  if (descriptors.length === 0) return null;

  const shape = descriptors
    .map(({ id, schemaId }) => ({ id, schemaId }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return `effect-${effectType}-${effectIntentFingerprint(shape)}`;
}

export function effectParameterSchemaFingerprint(effect: EffectInstance): string | null {
  return effectParameterDescriptorsSchemaFingerprint(effect.type, effectParameterDescriptorCatalog(effect));
}

/**
 * Build a read-only, normalized view over the existing rack schema. Semantic
 * capabilities are deliberately curated separately: a valid slider is not
 * automatically safe for natural-language control.
 */
function curateIntentDescriptors(
  effect: EffectInstance,
  technicalDescriptors: readonly EffectParameterDescriptor[],
): EffectIntentParameterDescriptor[] {
  if (!supportsEffectIntent(effect.type)) return [];

  return technicalDescriptors
    .filter((descriptor) => !(effect.type === "eq" && EQ_LEGACY_ALIASES.has(descriptor.id)))
    .map((descriptor) => {
      const mappings = effectIntentMappingsForParam(effect.type, descriptor.id);
      return {
        ...descriptor,
        intentGoals: effectIntentGoalsForParam(effect.type, descriptor.id),
        intentMappings: [...mappings],
      };
    });
}

export function effectIntentCatalogSnapshot(effect: EffectInstance): EffectIntentCatalogSnapshot {
  const technicalDescriptors = effectParameterDescriptorCatalog(effect);
  return {
    technicalDescriptors,
    intentDescriptors: curateIntentDescriptors(effect, technicalDescriptors),
    schemaId: effectParameterDescriptorsSchemaFingerprint(effect.type, technicalDescriptors),
  };
}

export function effectIntentParameterCatalog(effect: EffectInstance): EffectIntentParameterDescriptor[] {
  return curateIntentDescriptors(effect, effectParameterDescriptorCatalog(effect));
}

/**
 * Deterministic capability inventory for every registered effect. It includes
 * deep plugin schemas but distinguishes their technical presence from actual
 * intent write support.
 */
export function effectIntentCatalogCoverageReport(): EffectIntentCatalogCoverageReport {
  const byEffect = (Object.keys(EFFECT_DEFS) as EffectType[]).map((effectType) => {
    const paramDefs = EFFECT_DEFS[effectType].params;
    const effect: EffectInstance = {
      id: `effect-intent-coverage-${effectType}`,
      type: effectType,
      bypassed: false,
      params: Object.fromEntries(paramDefs.map((param) => [param.id, param.default])),
    };
    const descriptors = effectParameterDescriptorCatalog(effect);
    const technicalIds = new Set(descriptors.map((descriptor) => descriptor.id));
    const rackIds = new Set(paramDefs.map((param) => param.id));
    const semanticIds = [
      ...new Set(
        EFFECT_INTENT_MAPPINGS.filter((mapping) => mapping.effectType === effectType).map((mapping) => mapping.paramId),
      ),
    ];
    const unmappedSemanticParameterIds = semanticIds.filter((paramId) => !technicalIds.has(paramId));
    const semanticallyMappedParameterCount = semanticIds.filter((paramId) => rackIds.has(paramId)).length;
    const technicallyMappedParameterCount = semanticIds.length - unmappedSemanticParameterIds.length;
    // Both current Effect Intent boundaries consume ordinary rack ParamDefs:
    // apply validates/writes through EFFECT_DEFS and live preview validates
    // through the same rack definitions before touching EffectRuntime.
    const hasRackIntentAdapter =
      supportsEffectIntent(effectType) &&
      semanticIds.length > 0 &&
      semanticIds.every((paramId) => rackIds.has(paramId));
    const intentAdapter: "rack-param-def" | "none" = hasRackIntentAdapter ? "rack-param-def" : "none";
    const parametersBySource: Partial<Record<EffectParameterDescriptor["source"], number>> = {};
    for (const descriptor of descriptors) {
      parametersBySource[descriptor.source] = (parametersBySource[descriptor.source] ?? 0) + 1;
    }
    return {
      effectType,
      rackParameterCount: paramDefs.length,
      technicalParameterCount: descriptors.length,
      deepParameterCount: descriptors.filter((descriptor) => descriptor.source !== "rack").length,
      parametersBySource,
      semanticallyMappedParameterCount,
      technicallyMappedParameterCount,
      intentWriteAdapter: intentAdapter,
      intentPreviewAdapter: intentAdapter,
      intentWriteSupported: hasRackIntentAdapter,
      unmappedSemanticParameterIds,
    };
  });
  const rackParameterCount = byEffect.reduce((total, effect) => total + effect.rackParameterCount, 0);
  const technicalParameterCount = byEffect.reduce((total, effect) => total + effect.technicalParameterCount, 0);
  const semanticallyMappedParameterCount = byEffect.reduce(
    (total, effect) => total + effect.semanticallyMappedParameterCount,
    0,
  );
  const technicallyMappedParameterCount = byEffect.reduce(
    (total, effect) => total + effect.technicallyMappedParameterCount,
    0,
  );

  return {
    effectTypeCount: byEffect.length,
    rackParameterCount,
    technicalParameterCount,
    semanticallyMappedParameterCount,
    technicallyMappedParameterCount,
    semanticCoverage: rackParameterCount === 0 ? 0 : semanticallyMappedParameterCount / rackParameterCount,
    technicalSemanticCoverage:
      technicalParameterCount === 0 ? 0 : technicallyMappedParameterCount / technicalParameterCount,
    byEffect,
  };
}

export function formatEffectIntentValue(effectType: EffectType, paramId: string, value: number): string {
  const param = EFFECT_DEFS[effectType].params.find((candidate) => candidate.id === paramId);
  if (!param) return String(value);
  if (param.format) return param.format(value);
  return param.unit ? `${value.toFixed(2)} ${param.unit}` : value.toFixed(2);
}
