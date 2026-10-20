/**
 * PRIOR-ADJUSTMENT RESOLVER — turn "half that adjustment", "a little less than
 * last time" and "do the same on track two" into a NEW, validated fader intent.
 *
 * P1 (audit 2026-10-20). These phrases used to apply the phrase's own nominal
 * step as a guess, or fall through to pattern generation. The session ledger
 * remembers the measured last RELATIVE FADER move; this module scales or
 * reuses it. Everything here is a PLAN — execution still goes through the
 * canonical fader applier (clamps, one snapshot, read-back).
 *
 * The ledger is fader-only by design (see `adjustment-ledger.ts`). References
 * after an effect/param change therefore decline with the focused
 * `last-adjustment-reference` message rather than replaying an older fader
 * move. That is honest, and it is the documented boundary of this slice.
 */
import type { ProjectDocument } from "../project-model/types";
import { calibrateFaderFactor, degreeForLevel, degreeToFaderAmount, type DegreeLevel } from "./degree";
import { lastAdjustment } from "./adjustment-ledger";
import {
  faderTargetsIn,
  trackIdsForTarget,
  type FaderIntent,
  type FaderPadFamily,
  type FaderTarget,
} from "./conversation";
import { isPriorDeltaReference } from "./reference-delta";

export type PriorResolution = { kind: "fader"; intent: FaderIntent } | { kind: "clarify"; reason: string };

type Scale = { kind: "half" } | { kind: "rungs"; count: 1 | 2 } | { kind: "reuse" };

const HALF =
  /\bhalf\s+(?:of\s+)?(?:that|the|your|last)\s+(?:adjustment|change|amount|step|delta)\b|\bhalf\s+as\s+much\s+as\s+(?:last|before|the\s+last)\b/;
const MUCH_LESS = /\b(?:much|way|a\s+lot|far)\s+less\s+than\s+(?:the\s+)?(?:last|previous|prior)\b/;
const LESS_THAN = /\bless\s+than\s+(?:the\s+)?(?:last|previous|prior)\b/;
const REUSE =
  /\b(?:do|apply|use|repeat)\s+(?:the\s+)?same\b|\b(?:same|identical)\s+(?:adjustment|change)\s+as\b|\b(?:same|that|it)\s+again\b|\bdo\s+(?:that|it)\s+again\b|\bas\s+much\s+as\s+(?:the\s+)?(?:last|previous|prior)\b|\brepeat\s+(?:that|it|the\s+last\b)|\b(?:same|identical)\s+(?:amount|volume|level|value|delta)\s+as\b|\bagain\s*[.!?]?\s*$/;

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

function resolveFaderTargets(
  text: string,
  doc: ProjectDocument,
  entry: NonNullable<ReturnType<typeof lastAdjustment>>,
): FaderTargets | null {
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
  // Half / "less than last time" always refer to the SAME target; a bare
  // repeat ("the same adjustment") does too.
  return {
    targets: [...entry.targets] as FaderTarget[],
    pads: [...entry.pads] as FaderPadFamily[],
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

/**
 * Recover which semantic rung produced the measured factor. The ledger keeps
 * the number, not the words; the calibration curve is monotone, so nearest
 * anchor is the rung. Rounding in the gain clamp can move the measured factor
 * by ~0.5 %, which never crosses two rungs.
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

export function resolvePriorAdjustment(text: string, doc: ProjectDocument): PriorResolution | null {
  if (!isPriorDeltaReference(text)) return null;
  // A bare "again" could be transport ("play again") or a repeat of the last
  // adjustment. It is not specific enough to execute either; ask. Qualified
  // repeats ("same again", "do it again", "repeat the last change") resolve.
  if (/^\s*again(?:\s+please)?\s*[.!?]?\s*$/i.test(text)) {
    return { kind: "clarify", reason: "last-adjustment-reference" };
  }
  const entry = lastAdjustment(doc.id);
  if (!entry) return { kind: "clarify", reason: "last-adjustment-reference" };
  const scale = scaleOf(text);
  if (!scale) return { kind: "clarify", reason: "last-adjustment-reference" };

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
