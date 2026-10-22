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

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
};

const ORDINAL_WORDS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
};

/** 1-based "track two" / "track 2" / "second track" → 0-based index. */
function ordinalTrackIndex(text: string): number | null {
  const lower = normalized(text);
  const direct = /\b(?:track|channel|stopa|stope|stopy)\s*#?\s*(\d{1,2}|[a-z]+)\b/.exec(lower);
  if (direct) {
    const raw = direct[1] ?? "";
    const value = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
    if (value != null && value >= 1) return value - 1;
  }
  const named = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?:track|channel)\b/.exec(
    lower,
  );
  if (named) {
    const value = ORDINAL_WORDS[named[1] ?? ""];
    if (value != null) return value - 1;
  }
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
  const index = ordinalTrackIndex(text);
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

function resolveMixTargets(text: string, entry: EffectRecord | ParamRecord): MixTarget[] | null {
  const named = mixTargetsIn(text);
  if (named.length > 0) return named;
  // An ordinal track has no family id; do not guess that "track two" is the
  // bass family. The caller gets a focused target clarification instead.
  if (ordinalTrackIndex(text) != null) return null;
  return [...entry.targets];
}

function mixTargetsExist(doc: ProjectDocument, targets: readonly MixTarget[]): boolean {
  return targets.some((target) => trackIdsForMixTarget(doc, target).length > 0);
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
  const targets = resolveMixTargets(text, entry);
  if (!targets || !mixTargetsExist(doc, targets)) {
    return { kind: "clarify", reason: "prior-adjustment-target" };
  }
  const amount = degreeToEffectAmount(entry.degreeLevel);
  const detected = [`prior ${scale.kind}`, `${entry.effectType} ${entry.direction}`];
  if (scale.kind === "half") {
    if (!(entry.stepFraction > 0)) return { kind: "clarify", reason: "last-adjustment-reference" };
    return {
      kind: "effect",
      intent: {
        effectType: entry.effectType,
        targets,
        direction: entry.direction,
        amount,
        percent: Math.max(0, Math.min(100, entry.stepFraction * 50)),
        detected,
      },
    };
  }
  if (scale.kind === "rungs") {
    const level = rungLevel(entry.degreeLevel, scale.count);
    return {
      kind: "effect",
      intent: {
        effectType: entry.effectType,
        targets,
        direction: entry.direction,
        degree: degreeForLevel(level),
        amount: degreeToEffectAmount(level),
        detected,
      },
    };
  }
  if (!(entry.stepFraction > 0)) return { kind: "clarify", reason: "last-adjustment-reference" };
  return {
    kind: "effect",
    intent: {
      effectType: entry.effectType,
      targets,
      direction: entry.direction,
      amount,
      percent: Math.max(0, Math.min(100, entry.stepFraction * 100)),
      detected,
    },
  };
}

function resolveParam(text: string, doc: ProjectDocument, entry: ParamRecord, scale: Scale): PriorResolution {
  const targets = resolveMixTargets(text, entry);
  if (!targets || !mixTargetsExist(doc, targets)) {
    return { kind: "clarify", reason: "prior-adjustment-target" };
  }
  const amount = degreeToEffectAmount(entry.degreeLevel);
  const detected = [`prior ${scale.kind}`, `${entry.effectType}.${entry.paramId} ${entry.mode}`];
  const base = {
    effectType: entry.effectType,
    role: entry.role,
    paramId: entry.paramId,
    targets,
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
