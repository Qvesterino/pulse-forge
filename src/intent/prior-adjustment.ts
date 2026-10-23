/**
 * PRIOR-ADJUSTMENT RESOLVER — turn "half that adjustment", "a little less than
 * last time", "do the same on track two" and "one step further" into a NEW,
 * validated intent.
 *
 * The session ledger remembers the measured last RELATIVE move: a fader
 * factor, an effect-knob step or a param range fraction. This module scales or
 * reuses it. Everything here is a PLAN — execution still goes through the
 * canonical appliers (clamps, one snapshot, read-back).
 *
 * Target switching:
 *   - fader: family/pad names, ordinal tracks ("track two"), or the prior target
 *   - effect/param: family names, or the prior family; an ordinal track is not
 *     silently treated as a family (it needs a track-id targeting contract, so
 *     it clarifies instead)
 */
import type { ProjectDocument } from "../project-model/types";
import {
  calibrateFaderFactor,
  degreeForLevel,
  degreeToEffectAmount,
  degreeToFaderAmount,
  type DegreeLevel,
} from "./degree";
import { lastAdjustment, type EffectRecord, type FaderRecord, type ParamRecord } from "./adjustment-ledger";
import {
  faderTargetsIn,
  trackIdsForTarget,
  type FaderIntent,
  type FaderPadFamily,
  type FaderTarget,
} from "./conversation";
import { TARGET_WORDS, type EffectIntent, type MixTarget } from "./mix";
import { trackIdsForMixTarget, type ParamIntent } from "./param-intent";
import { isPriorDeltaReference } from "./reference-delta";
import { trackOrdinalFromText } from "./semantics/target-registry";

export type PriorResolution =
  | { kind: "fader"; intent: FaderIntent }
  | { kind: "effect"; intent: EffectIntent }
  | { kind: "param"; intent: ParamIntent }
  | { kind: "clarify"; reason: string };

type Scale = { kind: "half" } | { kind: "rungs"; count: 1 | 2 } | { kind: "reuse" };

const HALF =
  /\bhalf\s+(?:of\s+)?(?:that|the|your|last)\s+(?:adjustment|change|amount|step|delta)\b|\bhalf\s+as\s+much\s+as\s+(?:last|before|the\s+last)\b/;
const MUCH_LESS = /\b(?:much|way|a\s+lot|far)\s+less\s+than\s+(?:the\s+)?(?:last|previous|prior)\b/;
const LESS_THAN = /\bless\s+than\s+(?:the\s+)?(?:last|previous|prior)\b/;
const REUSE =
  /\b(?:do|apply|use|repeat)\s+(?:the\s+)?same\b|\b(?:same|identical)\s+(?:adjustment|change)\s+as\b|\b(?:same|that|it)\s+again\b|\bdo\s+(?:that|it)\s+again\b|\bas\s+much\s+as\s+(?:the\s+)?(?:last|previous|prior)\b|\brepeat\s+(?:that|it|the\s+last\b)|\b(?:same|identical)\s+(?:amount|volume|level|value|delta)\s+as\b|\bone\s+(?:more\s+)?step\b|\banother\s+step\b|\bagain\s*[.!?]?\s*$/;

function normalized(text: string): string {
  return ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")} `;
}

function scaleOf(text: string): Scale | null {
  const lower = normalized(text);
  if (HALF.test(lower)) return { kind: "half" };
  if (MUCH_LESS.test(lower)) return { kind: "rungs", count: 2 };
  if (LESS_THAN.test(lower)) return { kind: "rungs", count: 1 };
  if (REUSE.test(lower)) return { kind: "reuse" };
  return null;
}

interface FaderTargets {
  targets: FaderTarget[];
  pads: FaderPadFamily[];
  trackIds: string[];
  returnIds: string[];
}

function resolveFaderTargets(text: string, doc: ProjectDocument, entry: FaderRecord): FaderTargets | null {
  const found = faderTargetsIn(text);
  if (found.targets.length > 0 || found.pads.length > 0) {
    return { ...found, trackIds: [], returnIds: [] };
  }
  const index = trackOrdinalFromText(text);
  if (index != null) {
    const tracks = doc.tracks.filter((track) => track.kind !== "group");
    const track = tracks[index];
    if (!track) return null;
    return { targets: [], pads: [], trackIds: [track.id], returnIds: [] };
  }
  return {
    targets: [...entry.targets],
    pads: [...entry.pads],
    trackIds: [...(entry.trackIds ?? [])],
    returnIds: [...(entry.returnIds ?? [])],
  };
}

function faderTargetsExist(doc: ProjectDocument, chosen: FaderTargets): boolean {
  if (chosen.trackIds.length > 0) return chosen.trackIds.some((id) => doc.tracks.some((track) => track.id === id));
  if (chosen.returnIds.length > 0) return chosen.returnIds.some((id) => doc.returns.some((item) => item.id === id));
  if (chosen.targets.length > 0) return chosen.targets.some((target) => trackIdsForTarget(doc, target).length > 0);
  if (chosen.pads.length > 0) return doc.tracks.some((track) => track.kind === "drum");
  return false;
}

function mixTargetsIn(text: string): MixTarget[] {
  const lower = normalized(text);
  const targets = new Set<MixTarget>();
  for (const [pattern, target] of TARGET_WORDS) {
    if (pattern.test(lower)) targets.add(target);
  }
  return [...targets];
}

interface MixTargetChoice {
  targets: MixTarget[];
  trackIds: string[];
}

function resolveMixTargets(
  text: string,
  doc: ProjectDocument,
  entry: EffectRecord | ParamRecord,
): MixTargetChoice | null {
  const named = mixTargetsIn(text);
  if (named.length > 0) return { targets: named, trackIds: [] };
  const ordinal = trackOrdinalFromText(text);
  if (ordinal != null) {
    const track = doc.tracks.filter((candidate) => candidate.kind !== "group")[ordinal];
    if (!track) return null;
    return { targets: [], trackIds: [track.id] };
  }
  return { targets: [...entry.targets], trackIds: [...(entry.trackIds ?? [])] };
}

function mixTargetsExist(doc: ProjectDocument, choice: MixTargetChoice): boolean {
  if (choice.trackIds.some((id) => doc.tracks.some((track) => track.id === id))) return true;
  return choice.targets.some((target) => trackIdsForMixTarget(doc, target).length > 0);
}

/**
 * Recover which semantic rung produced the measured factor. The ledger keeps
 * the number, not the words; the calibration curve is monotone, so nearest
 * anchor is the rung.
 */
function levelFromFactor(factor: number, direction: "up" | "down"): DegreeLevel {
  let best: DegreeLevel = 5;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const level of [1, 2, 3, 4, 5, 6, 7] as DegreeLevel[]) {
    const candidate = calibrateFaderFactor(degreeForLevel(level).value, direction);
    const distance = Math.abs(candidate - factor);
    if (distance < bestDistance - 1e-9) {
      bestDistance = distance;
      best = level;
    }
  }
  return best;
}

function rungLevel(prior: DegreeLevel, count: 1 | 2): DegreeLevel {
  return Math.max(1, prior - count) as DegreeLevel;
}

function resolveFader(text: string, doc: ProjectDocument, entry: FaderRecord, scale: Scale): PriorResolution {
  const chosen = resolveFaderTargets(text, doc, entry);
  if (!chosen || !faderTargetsExist(doc, chosen)) {
    return { kind: "clarify", reason: "prior-adjustment-target" };
  }
  const base = { ...chosen };
  if (scale.kind === "half") {
    if (!(entry.factor > 0)) return { kind: "clarify", reason: "last-adjustment-reference" };
    const factor = Math.sqrt(entry.factor);
    return { kind: "fader", intent: { ...base, direction: factor < 1 ? "down" : "up", factor } };
  }
  if (scale.kind === "rungs") {
    const level = rungLevel(levelFromFactor(entry.factor, entry.direction), scale.count);
    return {
      kind: "fader",
      intent: {
        ...base,
        direction: entry.direction,
        degree: degreeForLevel(level),
        amount: degreeToFaderAmount(level),
      },
    };
  }
  return { kind: "fader", intent: { ...base, direction: entry.direction, factor: entry.factor } };
}

function resolveEffect(text: string, doc: ProjectDocument, entry: EffectRecord, scale: Scale): PriorResolution {
  const choice = resolveMixTargets(text, doc, entry);
  if (!choice || !mixTargetsExist(doc, choice)) {
    return { kind: "clarify", reason: "prior-adjustment-target" };
  }
  const amount = degreeToEffectAmount(entry.degreeLevel);
  const detected = [`prior ${scale.kind}`, `${entry.effectType} ${entry.direction}`];
  const base = {
    effectType: entry.effectType,
    targets: choice.targets,
    trackIds: choice.trackIds,
    direction: entry.direction,
    amount,
    detected,
  };
  if (scale.kind === "half") {
    if (!(entry.stepFraction > 0)) return { kind: "clarify", reason: "last-adjustment-reference" };
    return {
      kind: "effect",
      intent: { ...base, percent: Math.max(0, Math.min(100, entry.stepFraction * 50)) },
    };
  }
  if (scale.kind === "rungs") {
    const level = rungLevel(entry.degreeLevel, scale.count);
    return {
      kind: "effect",
      intent: { ...base, degree: degreeForLevel(level), amount: degreeToEffectAmount(level) },
    };
  }
  if (!(entry.stepFraction > 0)) return { kind: "clarify", reason: "last-adjustment-reference" };
  return {
    kind: "effect",
    intent: { ...base, percent: Math.max(0, Math.min(100, entry.stepFraction * 100)) },
  };
}

function resolveParam(text: string, doc: ProjectDocument, entry: ParamRecord, scale: Scale): PriorResolution {
  const choice = resolveMixTargets(text, doc, entry);
  if (!choice || !mixTargetsExist(doc, choice)) {
    return { kind: "clarify", reason: "prior-adjustment-target" };
  }
  const amount = degreeToEffectAmount(entry.degreeLevel);
  const detected = [`prior ${scale.kind}`, `${entry.effectType}.${entry.paramId} ${entry.mode}`];
  const base = {
    effectType: entry.effectType,
    role: entry.role,
    paramId: entry.paramId,
    targets: choice.targets,
    trackIds: choice.trackIds,
    mode: entry.mode,
    amount,
    detected,
  };
  if (scale.kind === "half") {
    if (!(entry.fraction > 0)) return { kind: "clarify", reason: "last-adjustment-reference" };
    return {
      kind: "param",
      intent: { ...base, percent: Math.max(0, Math.min(100, entry.fraction * 50)) },
    };
  }
  if (scale.kind === "rungs") {
    const level = rungLevel(entry.degreeLevel, scale.count);
    return {
      kind: "param",
      intent: { ...base, degree: degreeForLevel(level), amount: degreeToEffectAmount(level) },
    };
  }
  if (!(entry.fraction > 0)) return { kind: "clarify", reason: "last-adjustment-reference" };
  return {
    kind: "param",
    intent: { ...base, percent: Math.max(0, Math.min(100, entry.fraction * 100)) },
  };
}

export function resolvePriorAdjustment(text: string, doc: ProjectDocument): PriorResolution | null {
  if (!isPriorDeltaReference(text)) return null;
  // A bare "again" could be transport ("play again") or a repeat of the last
  // adjustment. It is not specific enough to execute either; ask. Qualified
  // repeats ("same again", "do it again", "one step further") resolve.
  if (/^\s*again(?:\s+please)?\s*[.!?]?\s*$/i.test(text)) {
    return { kind: "clarify", reason: "last-adjustment-reference" };
  }
  const entry = lastAdjustment(doc.id);
  if (!entry) return { kind: "clarify", reason: "last-adjustment-reference" };
  const scale = scaleOf(text);
  if (!scale) return { kind: "clarify", reason: "last-adjustment-reference" };
  switch (entry.kind) {
    case "fader":
      return resolveFader(text, doc, entry, scale);
    case "effect":
      return resolveEffect(text, doc, entry, scale);
    case "param":
      return resolveParam(text, doc, entry, scale);
  }
}

