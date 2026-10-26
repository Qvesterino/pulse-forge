import type { AutomationTarget, EffectInstance, ProjectDocument, Track } from "../project-model/types";
import { MAX_ARRANGEMENT_CLIP_BARS, ticksPerBar } from "../project-model/schema";
import { automationTargetKey, effectTargetParamDefs, isAutomationTargetValid } from "../project-model/targets";
import { EFFECT_META } from "../effects/definitions";

export interface PluginAutomationPlan {
  target: AutomationTarget;
  trackName: string;
  effectName: string;
  effectType: EffectInstance["type"];
  effectBypassed: boolean;
  paramLabel: string;
  paramId: string;
  min: number;
  max: number;
  fromValue: number;
  toValue: number;
  startBar: number;
  endBar: number;
  startTick: number;
  endTick: number;
  unitLabel: string;
  formatValue: (value: number) => string;
  usedSelectedTrack: boolean;
}

export type PluginAutomationPlanResult = { plan: PluginAutomationPlan } | { error: string };

interface ParameterCandidate {
  effect: EffectInstance;
  effectName: string;
  paramId: string;
  paramLabel: string;
  min: number;
  max: number;
  default: number;
  unit?: string;
  kind?: string;
  format?: (value: number) => string;
}

const AUTOMATION_VERB = /^(?:please\s+)?(?:automate|automatizuj|automatizovat)\b/;
const ENGLISH_AUTOMATION_GRAMMAR =
  /^\s*(?:please\s+)?automate\s+(.+?)\s+on\s+(.+?)\s+from\s+(-?(?:\d+(?:[.,]\d*)?|[.,]\d+))\s*([a-z%]*)\s+to\s+(-?(?:\d+(?:[.,]\d*)?|[.,]\d+))\s*([a-z%]*)\s+between\s+bars?\s+(\d+)\s+(?:and|to)\s+(\d+)\s*[.!]?\s*$/;
const SLOVAK_AUTOMATION_GRAMMAR =
  /^\s*(?:please\s+)?(?:automatizuj|automatizovat)\s+(.+?)\s+na\s+(.+?)\s+od\s+(-?(?:\d+(?:[.,]\d*)?|[.,]\d+))\s*([a-z%]*)\s+na\s+(-?(?:\d+(?:[.,]\d*)?|[.,]\d+))\s*([a-z%]*)\s+medzi\s+taktmi?\s+(\d+)\s+(?:a|az)\s+(\d+)\s*[.!]?\s*$/;

function plain(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNumber(value: string): number {
  return Number(value.replace(",", "."));
}

function percentSemantics(def: Pick<ParameterCandidate, "min" | "max" | "unit" | "format">): boolean {
  if (unitKey(def.unit) === "%") return true;
  try {
    return def.format?.(def.max).includes("%") ?? false;
  } catch {
    return false;
  }
}

function unitKey(value: string | undefined): string {
  const unit = plain(value ?? "").replace(/\s/g, "");
  if (unit === "%" || unit === "percent" || unit === "percentage") return "%";
  if (unit === "db" || unit === "decibel" || unit === "decibels") return "db";
  if (unit === "hz" || unit === "hertz") return "hz";
  if (unit === "khz") return "khz";
  if (unit === "ms" || unit === "millisecond" || unit === "milliseconds") return "ms";
  if (unit === "s" || unit === "sec" || unit === "second" || unit === "seconds") return "s";
  if (unit === "st" || unit === "semitone" || unit === "semitones") return "st";
  return unit;
}

function valueInTargetUnits(value: number, inputUnit: string, def: ParameterCandidate): number | null {
  const from = unitKey(inputUnit);
  const to = unitKey(def.unit);
  if (!from) return value;
  if (from === "%" && !to && percentSemantics(def)) return value / 100;
  if (from === to) {
    if (from === "%" && def.max <= 1 && def.min >= 0) return value / 100;
    return value;
  }
  if (from === "khz" && to === "hz") return value * 1000;
  if (from === "hz" && to === "khz") return value / 1000;
  if (from === "s" && to === "ms") return value * 1000;
  if (from === "ms" && to === "s") return value / 1000;
  return null;
}

function parameterNamesMatch(phrase: string, effectName: string, paramId: string, paramLabel: string): boolean {
  const normalizedPhrase = plain(phrase);
  const label = plain(paramLabel);
  const id = plain(paramId);
  const effect = plain(effectName);
  return (
    normalizedPhrase === label ||
    normalizedPhrase === id ||
    normalizedPhrase === `${effect} ${label}` ||
    normalizedPhrase === `${effect} ${id}`
  );
}

function trackNameMatches(track: Track, value: string): boolean {
  return plain(track.name) === plain(value).replace(/^(?:the|a|an)\s+/, "");
}

function targetValueFormatter(def: ParameterCandidate, unitLabel: string): (value: number) => string {
  return (value) => {
    if (def.format) return def.format(value);
    const shown = unitLabel === "%" && def.max <= 1 && def.min >= 0 ? value * 100 : value;
    const rounded = Number(shown.toFixed(3)).toString();
    return unitLabel === "native" ? rounded : `${rounded}${unitLabel === "%" ? "%" : ` ${unitLabel}`}`;
  };
}

/**
 * Parse and resolve an explicit plugin-automation request against the live
 * document. The parser is intentionally exact: it only proposes a target
 * whose track, inserted effect instance, parameter and bar range are known.
 * Returns null for unrelated text so the normal Intent router can continue.
 */
export function planPluginAutomationIntent(
  text: string,
  doc: ProjectDocument,
  selectedTrackId?: string | null,
): PluginAutomationPlanResult | null {
  const normalized = plain(text);
  if (!AUTOMATION_VERB.test(normalized)) return null;

  const isEnglish = /^\s*(?:please\s+)?automate\b/.test(normalized);
  const hasBoundedRange = isEnglish ? /\bbetween\s+bars?\b/.test(normalized) : /\bmedzi\s+taktmi?\b/.test(normalized);
  if (!hasBoundedRange) return null;
  const match = normalized.match(isEnglish ? ENGLISH_AUTOMATION_GRAMMAR : SLOVAK_AUTOMATION_GRAMMAR);
  if (!match) {
    return {
      error:
        "Use: automate <effect parameter> on <track> from <value> to <value> between bars <start> and <end> (or Slovak: automatizuj <parameter> na <stopa> od <hodnota> na <hodnota> medzi taktmi <start> a <end>).",
    };
  }

  const [, parameterPhrase, trackPhrase, rawFrom, fromUnit, rawTo, toUnit, rawStartBar, rawEndBar] = match;
  const selectedReference =
    /^(?:(?:the\s+)?(?:selected|current)\s+track|(?:vybrana|aktualna)\s+stopa|(?:vybranu|aktualnu)\s+stopu)$/.test(
      trackPhrase!,
    );
  const requestedTrackId = selectedReference ? (selectedTrackId ?? "") : "";
  const matchingTracks = selectedReference
    ? doc.tracks.filter((track) => track.id === requestedTrackId)
    : doc.tracks.filter((track) => trackNameMatches(track, trackPhrase!));
  if (matchingTracks.length === 0) {
    return {
      error: selectedReference
        ? "Select exactly one track, or name the track in the automation request."
        : `No track is named "${trackPhrase}". Use its exact track name.`,
    };
  }
  if (matchingTracks.length > 1)
    return { error: `More than one track is named "${trackPhrase}"; rename or select the exact target.` };
  const track = matchingTracks[0]!;

  const candidates: ParameterCandidate[] = [];
  for (const effect of track.effects) {
    const effectName = EFFECT_META[effect.type].name;
    for (const def of effectTargetParamDefs(effect)) {
      if (!parameterNamesMatch(parameterPhrase!, effectName, def.id, def.label)) continue;
      candidates.push({
        effect,
        effectName,
        paramId: def.id,
        paramLabel: def.label,
        min: def.min,
        max: def.max,
        default: def.default,
        unit: def.unit,
        kind: def.kind,
        format: def.format,
      });
    }
  }
  if (candidates.length === 0) {
    return {
      error: `"${parameterPhrase}" is not an automatable parameter on an inserted effect in ${track.name}. Check the live chain with Sounds/FX or kyx_automation op:listTargets.`,
    };
  }
  if (candidates.length > 1) {
    const sameParamOnRepeatedInstances =
      new Set(candidates.map((candidate) => `${candidate.effect.type}:${candidate.paramId}`)).size < candidates.length;
    return {
      error: sameParamOnRepeatedInstances
        ? `Several ${candidates[0]!.effectName} instances expose "${candidates[0]!.paramLabel}" on ${track.name}; use a unique chain or remove the ambiguity before planning.`
        : `"${parameterPhrase}" matches multiple inserted effect parameters on ${track.name}; name the effect and parameter more specifically.`,
    };
  }
  const candidate = candidates[0]!;
  if (candidate.kind && ["toggle", "enum", "discrete", "unknown"].includes(candidate.kind)) {
    return {
      error: `${candidate.effectName} ${candidate.paramLabel} is discrete and cannot be planned as a continuous ramp.`,
    };
  }
  if (!Number.isFinite(candidate.min) || !Number.isFinite(candidate.max) || candidate.max <= candidate.min) {
    return { error: `${candidate.effectName} ${candidate.paramLabel} has no valid continuous range.` };
  }

  const fromValue = valueInTargetUnits(parseNumber(rawFrom!), fromUnit!, candidate);
  const toValue = valueInTargetUnits(parseNumber(rawTo!), toUnit!, candidate);
  if (fromValue === null || toValue === null) {
    const unit = candidate.unit ?? (percentSemantics(candidate) ? "%" : "native units");
    return {
      error: `Values for ${candidate.paramLabel} must use ${unit}; Hz/kHz and seconds/milliseconds are converted automatically.`,
    };
  }
  if (![fromValue, toValue].every(Number.isFinite)) return { error: "Automation values must be finite numbers." };
  if (fromValue < candidate.min || fromValue > candidate.max || toValue < candidate.min || toValue > candidate.max) {
    return {
      error: `${candidate.effectName} ${candidate.paramLabel} accepts ${candidate.min}..${candidate.max}${candidate.unit ? ` ${candidate.unit}` : ""}; the request is outside that range and was not clamped.`,
    };
  }

  const startBar = Number(rawStartBar);
  const endBar = Number(rawEndBar);
  if (
    !Number.isSafeInteger(startBar) ||
    !Number.isSafeInteger(endBar) ||
    startBar < 1 ||
    endBar <= startBar ||
    endBar > MAX_ARRANGEMENT_CLIP_BARS
  ) {
    return { error: `Bar range must satisfy 1 ≤ start < end ≤ ${MAX_ARRANGEMENT_CLIP_BARS}.` };
  }

  const target: AutomationTarget = {
    kind: "fxParam",
    trackId: track.id,
    fxId: candidate.effect.id,
    paramId: candidate.paramId,
  };
  if (!isAutomationTargetValid(doc, target))
    return { error: "The inserted effect target changed while planning; request a fresh plan." };
  if (doc.automation.some((lane) => automationTargetKey(lane.target) === automationTargetKey(target))) {
    return {
      error: `An automation lane already exists for ${track.name} · ${candidate.effectName} · ${candidate.paramLabel}. Edit that lane or choose another parameter.`,
    };
  }

  const ticksPerProjectBar = ticksPerBar(doc);
  const unitLabel = candidate.unit ?? (percentSemantics(candidate) ? "%" : "native");
  return {
    plan: {
      target,
      trackName: track.name,
      effectName: candidate.effectName,
      effectType: candidate.effect.type,
      effectBypassed: candidate.effect.bypassed,
      paramLabel: candidate.paramLabel,
      paramId: candidate.paramId,
      min: candidate.min,
      max: candidate.max,
      fromValue,
      toValue,
      startBar,
      endBar,
      startTick: (startBar - 1) * ticksPerProjectBar,
      endTick: (endBar - 1) * ticksPerProjectBar,
      unitLabel,
      formatValue: targetValueFormatter(candidate, unitLabel),
      usedSelectedTrack: selectedReference,
    },
  };
}
