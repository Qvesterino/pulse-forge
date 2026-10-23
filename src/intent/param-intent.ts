/**
 * PARAM-LEVEL INTENT (P1 of the param wave, docs plan 2026-10-14) — the
 * producer names a KNOB, not just an effect: "dlhší chvost na reverbe",
 * "set delay time to 375 ms", "suchší dozvuk na leade".
 *
 * Until now `parseEffectIntent` addressed only the ONE primary knob per
 * effect (EFFECT_KNOB) and `namesForeignKnob` DECLINED every other ask.
 * This module owns the ROLE layer that closes that gap:
 *
 *   role (mix/time/tone/drive/width) × effect × target × value
 *
 * The model never sees raw param ids — the role is a closed enum (schema
 * wave P2). Values keep the sacred contract: units (ms/s/Hz/kHz/%) parse
 * deterministically here; percent/delta interpolate in the param's OWN
 * domain (log for taper:"log" knobs — linear math on Hz would lie).
 *
 * Apply compiles into existing MixDecisions (add-if-missing + clamp +
 * setEffectParam + ONE snapshot) — no new command machinery.
 */
import type { EffectType } from "../project-model/types";
import type { ParamDef } from "../effects/types";
import { EFFECT_META, clampEffectParam, defaultParamsOf } from "../effects/definitions";
import type { Command } from "../commands/types";
import {
  effectWordIn,
  applyMixIntent,
  TARGET_WORDS,
  EFFECT_KNOB,
  type DeclinedIntentClarification,
  type MixDecision,
  type MixTarget,
} from "./mix";
import { degreeToEffectAmount, parseDegree, type Degree, type DegreeLevel } from "./degree";
import { calibrationFamily, physicalStep, type CalibrationFamily } from "./semantics/calibration";
import { parseQuantity } from "./semantics/quantity";
import { isPriorDeltaReference } from "./reference-delta";
import { isDescriptiveStatement } from "./declarative";
import { PARAM_ROLES, directionForRole, type ParamRole } from "./semantics/param-registry";
import { trackOrdinalFromText } from "./semantics/target-registry";

export type { ParamRole };

/** Scene role → instrumentation expansion (mirrors mix.ts's private table —
 * a param ask on a section targets the tracks that play it). */
const ROLE_TARGETS: Record<string, MixTarget[]> = {
  intro: ["drums", "bass"],
  outro: ["drums", "bass"],
  verse: ["drums", "bass", "chords"],
  build: ["drums", "bass", "chords"],
  break: ["chords", "lead"],
  bridge: ["chords", "lead"],
  chorus: ["drums", "bass", "chords", "lead"],
  drop: ["drums", "bass", "chords", "lead"],
  fill: ["drums"],
};

export interface ParamIntent {
  effectType: EffectType;
  role: ParamRole;
  paramId: string;
  targets: MixTarget[];
  /** Explicit resolved tracks ("do the same on track three"). */
  trackIds?: string[];
  /** 0-based "track two" when the parser saw an ordinal but had no document. */
  trackOrdinal?: number;
  /** "set" = absolute raw value; "more"/"less" = relative in the param's own domain; "scale" = multiply the current value. */
  mode: "set" | "more" | "less" | "scale";
  /** Multiplier for mode "scale" ("half the decay" = 0.5, "twice" = 2). */
  factor?: number;
  /** Absolute raw param value (mode "set") AFTER clamping — what will land. */
  value?: number;
  /**
   * The value the producer actually asked for, before the ParamDef clamp.
   * Only for mode "set"; lets the plan/read-back say "2.5 → 1 (clamped)"
   * instead of silently presenting the clamped number as the request.
   */
  requestedValue?: number;
  /** Vibe ladder for relative asks (fractions of the param range). */
  amount: "subtle" | "medium" | "huge";
  /**
   * The resolved graduated degree (intent/degree.ts) when the ask NAMED one.
   * `amount` is the coarse class; `degree` is the magnitude the apply path
   * calibrates from in the param's OWN domain (log for taper:"log").
   */
  degree?: Degree;
  /** Explicit percent ("o 20 %") — fraction of the param's range, interpolated
   * in the param's own domain (log for taper:"log"). Wins over `amount`. */
  percent?: number;
  detected: string[];
}

function deaccentLower(text: string): string {
  return ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")} `;
}

function paramDefOf(effectType: EffectType, paramId: string): ParamDef | null {
  return EFFECT_META[effectType]?.params.find((param) => param.id === paramId) ?? null;
}

// ── Domain-true interpolation (taper: "log" is slider-only in the UI; here
// it defines how FRACTIONS map to values, so "o 20 % dlhší" lands musically) ──

function fractionOf(param: ParamDef, value: number): number {
  if (param.taper === "log" && param.min > 0 && value > 0) {
    return (Math.log(value) - Math.log(param.min)) / (Math.log(param.max) - Math.log(param.min));
  }
  return (value - param.min) / (param.max - param.min);
}

function valueAtFraction(param: ParamDef, fraction: number): number {
  const clamped = Math.max(0, Math.min(1, fraction));
  if (param.taper === "log" && param.min > 0) {
    return Math.exp(Math.log(param.min) + clamped * (Math.log(param.max) - Math.log(param.min)));
  }
  return param.min + clamped * (param.max - param.min);
}

// ── Value grammar ───────────────────────────────────────────────────────────

interface UnitValue {
  value: number;
  unit: "ms" | "s" | "hz" | "khz" | "pct" | "db";
}

const UNIT_SET =
  /\b(?:na|to|set|nastav|daj|resp\.?)?\s*(-?\d+(?:[.,]\d+)?)\s*(ms|milisek|\bsec(?:ond)?s?\b|\bsek\b|\bs\b|hz|khz|%|percent\w*|procent\w*|db|decibel\w*)\b/;

function parseUnitValue(lower: string): UnitValue | null {
  const match = UNIT_SET.exec(lower);
  if (!match) return null;
  const value = Number(match[1]!.replace(",", "."));
  const rawUnit = match[2]!;
  let unit: UnitValue["unit"];
  if (/ms|milisek/.test(rawUnit)) unit = "ms";
  else if (/sek|sec|s/.test(rawUnit)) unit = "s";
  else if (rawUnit === "hz") unit = "hz";
  else if (rawUnit === "khz") unit = "khz";
  else if (/db|decibel/.test(rawUnit)) unit = "db";
  else unit = "pct";
  return { value, unit };
}

function parsePercentWord(text: string): number | null {
  const match = /\bo?\s*(\d{1,3})\s*(?:%|percent\w*|procent\w*)/.exec(text);
  return match ? Math.max(0, Math.min(100, Number(match[1]))) : null;
}

/** Convert a user-typed unit into the PARAM's own raw unit (delay.time is ms,
 * reverb.decay is s — the ask may phrase either). */
function toParamUnit(value: number, unit: UnitValue["unit"], param: ParamDef): number {
  const target = (param.unit ?? "").toLowerCase();
  // dB does not convert: a threshold ask in dB belongs only on a dB knob.
  if (unit === "db") return target === "db" ? value : Number.NaN;
  if (unit === "ms") return target === "s" ? value / 1000 : value;
  if (unit === "s") return target === "ms" ? value * 1000 : value;
  if (unit === "khz") return target === "hz" ? value * 1000 : value;
  if (unit === "hz") return target === "khz" ? value / 1000 : value;
  return value;
}

/**
 * Parse a param-level ask. Null when the text does not name an effect ×
 * role × target — the generic effect/mix layers keep their behavior.
 */
interface ParamAsk {
  lower: string;
  role: ParamRole;
  effectType: EffectType;
  paramId: string;
  targets: Set<MixTarget>;
}

/**
 * Resolve role × effect × param × targets WITHOUT requiring a target. The
 * parser uses the full result; the target clarification uses the same result
 * when the only missing piece is "which track?" — one vocabulary, no second
 * interpretation.
 */
function resolveParamAsk(text: string): ParamAsk | null {
  if (isDescriptiveStatement(text)) return null;
  const lower = deaccentLower(text);
  // "a little less than last time" must not resolve here (or anywhere) with a
  // guessed fraction — the prior delta is not available to this layer.
  if (isPriorDeltaReference(lower)) return null;

  // The role must be named; the effect comes from an effect noun or the
  // role's implied effect ("wider stereo" implies the widener).
  //
  // ROLE CANDIDATES, NOT FIRST-MATCH: "longer" belongs to the time role AND to
  // compressor release, so "longer compressor release" used to resolve `time`
  // first and then find no `compressor` knob on that role — a null. Pick the
  // first candidate whose EFFECT actually carries the role.
  const namedEffect = effectWordIn(lower);
  const filterNamed = /\bfilter|\bfiltr|\bsvf\b|\bcutoff\b/.test(lower);
  let role: ParamRole | null = null;
  let effectType: EffectType | null = null;
  for (const key of Object.keys(PARAM_ROLES) as ParamRole[]) {
    if (!PARAM_ROLES[key].words.test(lower)) continue;
    const candidateEffect: EffectType | null =
      filterNamed && (key === "cutoff" || key === "q")
        ? "svFilter"
        : (namedEffect ?? PARAM_ROLES[key].impliedEffect ?? null);
    if (!candidateEffect || !PARAM_ROLES[key].params[candidateEffect]) continue;
    // The param layer owns the NON-primary knobs. When the role resolves to
    // the effect's own primary knob (reverb.mix, saturation.drive…), the
    // effectIntent layer already addresses it with identical semantics —
    // stealing those asks would only churn the pinned routes.
    if (EFFECT_KNOB[candidateEffect] === (PARAM_ROLES[key].params[candidateEffect] as string)) continue;
    role = key;
    effectType = candidateEffect;
    break;
  }
  if (!role || !effectType) return null;
  const paramId = PARAM_ROLES[role].params[effectType] as string;
  if (!paramDefOf(effectType, paramId)) return null;

  // Targets: track families + scene-role expansion (same vocabulary as the
  // effect layer — "na leade", "v drope").
  const targets = new Set<MixTarget>();
  for (const [re, target] of TARGET_WORDS) {
    if (re.test(lower)) targets.add(target);
  }
  for (const [sceneRole, expanded] of Object.entries(ROLE_TARGETS)) {
    // \w* tolerance: SK inflections ride on the stem ("v drope", "v breaku").
    if (new RegExp(`\\b${sceneRole}\\w*`).test(lower)) {
      for (const target of expanded) targets.add(target);
    }
  }
  return { lower, role, effectType, paramId, targets };
}

/**
 * TARGET CLARIFICATION (P1, audit 2026-10-20): a named-knob ask with no track
 * ("make the reverb tail a little longer") used to fall through to pattern
 * generation — which replaces the producer's song. The parameter is fully
 * resolved; only the track is missing, so offer the producer's own sentence
 * with each real track family appended. Every chip is re-parsed before it is
 * offered, so a suggestion can never be a guess or a generation prompt.
 */
export function declinedParamIntentClarification(
  text: string,
  doc: Parameters<typeof applyMixIntent>[0],
): DeclinedIntentClarification | null {
  const ask = resolveParamAsk(text);
  if (!ask || ask.targets.size > 0) return null;
  // Never append a second prepositional phrase: "…on the pads on the bass".
  if (/\b(?:on|to|na)\b/i.test(text)) return null;
  const base = text.trim().replace(/[.!?]+$/, "");
  const suggestions = (["drums", "bass", "chords", "lead"] as const)
    .filter((family) => trackIdsForMixTarget(doc, family).length > 0)
    .map((family) => `${base} on the ${family}`)
    .filter((suggestion) => parseParamIntent(suggestion) !== null);
  if (suggestions.length === 0) return null;
  return { reason: "param-target", suggestions };
}

export function parseParamIntent(text: string): ParamIntent | null {
  const intent = parseParamIntentCore(text);
  if (!intent) return null;
  const ordinal = trackOrdinalFromText(text);
  return ordinal != null ? { ...intent, trackOrdinal: ordinal } : intent;
}

function parseParamIntentCore(text: string): ParamIntent | null {
  const ask = resolveParamAsk(text);
  if (!ask) return null;
  const { lower, role, effectType, paramId, targets } = ask;
  if (targets.size === 0 && trackOrdinalFromText(text) == null) return null;
  const param = paramDefOf(effectType, paramId);
  if (!param) return null;

  const detected: string[] = [`${role} → ${effectType}.${paramId}`, `→ ${[...targets].join("+")}`];

  // SET with a unit ("375 ms", "2.6 s", "5 khz", "-20 db") or a percent word
  // for 0-1 knobs. The unit owns the value — no guessing across domains.
  const unitValue = parseUnitValue(lower);
  const percent = parsePercentWord(text);
  const bareDb =
    role === "threshold" && (param.unit ?? "").toLowerCase() === "db"
      ? /\b(?:threshold|prah)\b\s*(?:na|to|at|=)?\s*(-?\d+(?:[.,]\d+)?)\b/.exec(lower)
      : null;
  const bareQ =
    role === "q" ? /\b(?:q|sharpness|rezonancia)\b\s*(?:na|to|at|=)?\s*(-?\d+(?:[.,]\d+)?)\b/.exec(lower) : null;
  const setCue = /\b(?:set|nastav|daj)\b/.test(lower);
  const quantity = parseQuantity(lower);
  const directionVerb =
    /\b(?:by|o|lower|raise|reduce|boost|increase|decrease|down|up|higher|less|more|longer|shorter|faster|slower|brighter|darker|wetter|drier|wider|narrower|vyssie|nizsie|viac|menej)\b/.test(
      lower,
    );
  const relativeDb = quantity?.kind === "db" && !quantity.absolute && !setCue && directionVerb;
  const relativePercent = quantity?.kind === "percent" && !quantity.absolute && !setCue && directionVerb;

  // SCALE first: "half the decay" is a multiplication of the CURRENT value,
  // not a range fraction. It is legal only when the producer did not say
  // "set" (a set with half is malformed and falls through to decline).
  if (quantity?.kind === "factor" && !setCue) {
    detected.push(`×${quantity.value}`);
    return {
      effectType,
      role,
      paramId,
      targets: [...targets],
      mode: "scale",
      factor: quantity.value,
      amount: "medium",
      detected,
    };
  }

  // EXPLICIT dB movement ("lower the threshold by 2 dB"). This must run before
  // the unit-set branch: "by 2 dB" contains a valid unit and used to be read
  // as an ABSOLUTE set to 2 dB.
  if (relativeDb && quantity?.kind === "db") {
    const value = quantity.value;
    const mode = value < 0 ? "less" : directionForRole(role, lower);
    const range = param.max - param.min;
    if (!(range > 0)) return null;
    const pct = Math.min(100, (Math.abs(value) / range) * 100);
    detected.push(`${value > 0 ? "+" : ""}${value} dB relative`);
    return {
      effectType,
      role,
      paramId,
      targets: [...targets],
      mode,
      percent: pct,
      amount: "medium",
      detected,
    };
  }

  // EXPLICIT percent movement ("by 20 %") is relative, unlike a bare "20%"
  // which the set branch owns.
  if (relativePercent && quantity?.kind === "percent") {
    const mode = quantity.value < 0 ? "less" : directionForRole(role, lower);
    detected.push(`${quantity.value > 0 ? "+" : ""}${quantity.value}% relative`);
    return {
      effectType,
      role,
      paramId,
      targets: [...targets],
      mode,
      percent: Math.min(100, Math.abs(quantity.value)),
      amount: "medium",
      detected,
    };
  }

  if ((setCue || unitValue || bareDb || bareQ) && !relativeDb && !relativePercent) {
    if (unitValue && unitValue.unit !== "pct") {
      const value = toParamUnit(unitValue.value, unitValue.unit, param);
      if (!Number.isFinite(value)) return null;
      const clamped = clampEffectParam(effectType, paramId, value);
      detected.push(`${param.unit ?? param.id} → ${clamped}`);
      return {
        effectType,
        role,
        paramId,
        targets: [...targets],
        mode: "set",
        value: clamped,
        requestedValue: value,
        amount: "medium",
        detected,
      };
    }
    const bare = bareQ ?? bareDb;
    if (bare) {
      const raw = Number((bare[1] ?? "").replace(",", "."));
      if (Number.isFinite(raw)) {
        const clamped = clampEffectParam(effectType, paramId, raw);
        detected.push(`${param.unit ?? param.id} → ${clamped}`);
        return {
          effectType,
          role,
          paramId,
          targets: [...targets],
          mode: "set",
          value: clamped,
          requestedValue: raw,
          amount: "medium",
          detected,
        };
      }
    }
    if (percent != null) {
      const value = valueAtFraction(param, percent / 100);
      detected.push(`${percent}% of range → ${value.toFixed(param.max <= 1 ? 2 : 0)}`);
      return {
        effectType,
        role,
        paramId,
        targets: [...targets],
        mode: "set",
        value,
        requestedValue: value,
        amount: "medium",
        percent,
        detected,
      };
    }
    // "set the threshold lower" names no value — declining is safer than
    // silently applying the default relative step.
    if (setCue) return null;
  }

  // RELATIVE — role-aware direction. Drier/wetter own the mix role; attack and
  // release read faster/slower; cutoff reads darker/brighter; Q reads
  // sharper/wider. Without this, "faster attack" defaulted to MORE (a LONGER
  // attack) and "darker cutoff" defaulted to MORE (a brighter filter).
  const direction = directionForRole(role, lower);
  // Graduated degree, resolved through the shared taxonomy (intent/degree.ts).
  // The regexes this replaced (`subtle|trochu|malic` / `huge|a lot|obri|vela|
  // velmi|really`) were missing "slightly", "a little" and "a bit" — so
  // "slightly more delay" landed on MEDIUM here while mix.ts called the very
  // same word SUBTLE on the primary knob. Same sentence, two magnitudes. The
  // taxonomy is the union of both vocabularies plus "barely"/"much"/"a touch".
  const degree = parseDegree(text);
  const amount: ParamIntent["amount"] = degree ? degreeToEffectAmount(degree.level) : "medium";
  detected.push(
    direction,
    percent != null ? `${percent}%` : degree ? `${degree.name} (${degree.matched.trim()})` : amount,
  );
  return {
    effectType,
    role,
    paramId,
    targets: [...targets],
    mode: direction,
    amount,
    ...(degree ? { degree } : {}),
    ...(percent != null ? { percent } : {}),
    detected,
  };
}

const VALID_MIX_TARGETS: readonly MixTarget[] = ["drums", "bass", "chords", "lead", "vocal"];

/**
 * Rebuild a full ParamIntent from the MODEL's decoded action record (param
 * wave P2). The model emits only the closed enums + numbers; this resolves
 * role → paramId, re-applies the primary-knob shadow rule and the clamps —
 * the same guards the parser runs, so a model hit can never bypass them.
 * Null ⇒ the resolver abstains (deterministic layer owns the row).
 */
export function paramIntentFromModel(
  effect: string,
  role: string,
  targets: readonly string[],
  mode: "set" | "more" | "less",
  value?: number,
  percent?: number,
): ParamIntent | null {
  const def = PARAM_ROLES[role as ParamRole];
  const effectType = effect as EffectType;
  if (!def || !def.params[effectType]) return null;
  const paramId = def.params[effectType] as string;
  if (EFFECT_KNOB[effectType] === paramId) return null; // primary ⇒ effect layer
  const param = paramDefOf(effectType, paramId);
  if (!param) return null;
  const validTargets = targets.filter((target): target is MixTarget =>
    (VALID_MIX_TARGETS as readonly string[]).includes(target),
  );
  if (validTargets.length === 0) return null;
  const clampedPercent = percent === undefined ? undefined : Math.max(0, Math.min(100, Math.round(percent)));
  const clampedValue =
    mode === "set" && value !== undefined && Number.isFinite(value)
      ? clampEffectParam(effectType, paramId, value)
      : undefined;
  return {
    effectType,
    role: role as ParamRole,
    paramId,
    targets: validTargets,
    mode,
    ...(clampedValue !== undefined ? { value: clampedValue } : {}),
    amount: "medium",
    ...(clampedPercent !== undefined ? { percent: clampedPercent } : {}),
    detected: [`${role} → ${effectType}.${paramId}`, `→ ${validTargets.join("+")}`],
  };
}

// ── Apply ───────────────────────────────────────────────────────────────────

function currentParamValue(
  doc: Parameters<typeof applyMixIntent>[0],
  trackId: string,
  effectType: EffectType,
  paramId: string,
): number {
  const track = doc.tracks.find((candidate) => candidate.id === trackId);
  if (track && "effects" in track) {
    const instance = track.effects.find((effect) => effect.type === effectType);
    if (instance && instance.params[paramId] !== undefined) return instance.params[paramId];
  }
  return defaultParamsOf(effectType)[paramId] ?? 0;
}

export function trackIdsForMixTarget(doc: Parameters<typeof applyMixIntent>[0], target: MixTarget): string[] {
  // Reuses the mix layer's resolution through a one-decision profile apply —
  // but resolution must not mutate, so resolve ids directly.
  const ids: string[] = [];
  for (const track of doc.tracks) {
    if (target === "drums" && track.kind === "drum") ids.push(track.id);
    if (target !== "drums" && track.kind === "instrument") {
      const name = track.name.toLowerCase();
      if (
        (target === "bass" && /bas|808/.test(name)) ||
        (target === "chords" && /chord|keys|pad|akord/.test(name)) ||
        (target === "lead" && /lead|synth|melod/.test(name)) ||
        (target === "vocal" && /vocal|voice|spev|vokal/.test(name))
      ) {
        ids.push(track.id);
      }
    }
  }
  return ids;
}

/**
 * INSPECTABLE MOVE — the arithmetic the command is about to perform.
 *
 * The degree ladder only says "small"; the delta a producer can check is a
 * fraction of THIS param's range, applied in the param's OWN domain. For a
 * log-tapered knob (delay.time, reverb.tone) the fraction is geometric, so the
 * same "slightly" is a constant RATIO; for a linear knob (reverb.decay) it is a
 * constant ADDITIVE step. Exposing that lets the plan/read-back say what will
 * happen, and lets tests prove the two domains do not get swapped.
 */
export interface ParamMovePreview {
  effectType: EffectType;
  paramId: string;
  mode: ParamIntent["mode"];
  domain: "log" | "linear";
  /** The physical calibration family used for the move. */
  family: CalibrationFamily;
  /** Fraction of the param's range in its own domain; null for an absolute set. */
  fraction: number | null;
  /** Human physical delta: "+0.75 dB", "+10%", "+2 pts", "to limit". */
  deltaLabel: string;
  current: number;
  /** Destination before the ParamDef clamp. */
  proposed: number;
  /** What the command actually writes (clamped). */
  next: number;
}

/** Legacy amount class → the semantic degree it always meant. */
const AMOUNT_DEGREE: Readonly<Record<ParamIntent["amount"], DegreeLevel>> = {
  subtle: 3,
  medium: 5,
  huge: 6,
};

export function paramMovePreview(intent: ParamIntent, current: number): ParamMovePreview | null {
  const param = paramDefOf(intent.effectType, intent.paramId);
  if (!param) return null;
  const domain: ParamMovePreview["domain"] = param.taper === "log" ? "log" : "linear";
  const family = calibrationFamily(param, intent.role);
  if (intent.mode === "set") {
    const proposed = intent.requestedValue ?? intent.value ?? current;
    return {
      effectType: intent.effectType,
      paramId: intent.paramId,
      mode: "set",
      domain,
      family,
      fraction: null,
      deltaLabel: "set",
      current,
      proposed,
      next: clampEffectParam(intent.effectType, intent.paramId, proposed),
    };
  }
  // SCALE — multiply the CURRENT value ("half the decay", "twice the cutoff").
  if (intent.mode === "scale") {
    const factor = intent.factor ?? 1;
    const proposed = current * factor;
    const next = clampEffectParam(intent.effectType, intent.paramId, proposed);
    const fraction = Math.abs(fractionOf(param, next) - fractionOf(param, current));
    return {
      effectType: intent.effectType,
      paramId: intent.paramId,
      mode: "scale",
      domain,
      family,
      fraction,
      deltaLabel: `×${Math.round(factor * 1000) / 1000}`,
      current,
      proposed,
      next,
    };
  }
  // An explicit percent is a RANGE fraction; it stays the caller's unit.
  if (intent.percent != null) {
    const fraction = intent.percent / 100;
    const step = intent.mode === "less" ? -fraction : fraction;
    const proposed = valueAtFraction(param, fractionOf(param, current) + step);
    return {
      effectType: intent.effectType,
      paramId: intent.paramId,
      mode: intent.mode,
      domain,
      family,
      fraction,
      deltaLabel: `${intent.mode === "less" ? "−" : "+"}${intent.percent}% range`,
      current,
      proposed,
      next: clampEffectParam(intent.effectType, intent.paramId, proposed),
    };
  }
  // Qualitative degree → PHYSICAL family step, not a fraction of the range.
  // The old range-fraction made "much" on a 60 dB threshold a 19.2 dB jump;
  // the family ladder makes it 4 dB (see semantics/calibration.ts).
  const degree = intent.degree?.level ?? AMOUNT_DEGREE[intent.amount] ?? 5;
  const physical = physicalStep(param, intent.role, degree, current, intent.mode);
  const next = clampEffectParam(intent.effectType, intent.paramId, physical.next);
  const fraction = Math.abs(fractionOf(param, next) - fractionOf(param, current));
  return {
    effectType: intent.effectType,
    paramId: intent.paramId,
    mode: intent.mode,
    domain,
    family,
    fraction,
    deltaLabel: physical.deltaLabel,
    current,
    proposed: physical.proposed,
    next,
  };
}

/**
 * A value's position in the param's own range (0..1), used by the adjustment
 * ledger to measure the delta that ACTUALLY landed after clamping.
 */
export function paramValueFraction(effectType: EffectType, paramId: string, value: number): number | null {
  const param = paramDefOf(effectType, paramId);
  return param ? fractionOf(param, value) : null;
}

/**
 * P3 — THE INSPECTABLE PLAN, before execution.
 *
 * The UI renders these lines from the typed text, so the producer sees the
 * inferred target, the CURRENT value, the destination and the range fraction
 * in the param's own domain BEFORE anything is applied. `clamped` and `add`
 * are stated because they change what actually lands.
 */
export interface ParamPlanLine {
  target: MixTarget | string;
  /** The resolved track name (the label the producer sees), or the family. */
  trackName: string;
  effectType: EffectType;
  paramId: string;
  domain: "log" | "linear";
  /** The physical calibration family used for the move. */
  family: CalibrationFamily;
  /** Percent of the param's range in its own domain; null for an absolute set. */
  fractionPct: number | null;
  /** Human physical delta: "+0.75 dB", "+10%", "+2 pts", "to limit". */
  deltaLabel: string;
  current: number;
  proposed: number;
  next: number;
  clamped: boolean;
  adding: boolean;
  label: string;
}

interface ParamTargetEntry {
  target: MixTarget | string;
  trackName: string;
  trackId: string | null;
}

/** Family first-id rows + explicit/ordinal tracks, deduplicated. */
function paramTargetEntries(
  doc: Parameters<typeof applyMixIntent>[0],
  intent: ParamIntent,
): ParamTargetEntry[] {
  const entries: ParamTargetEntry[] = [];
  const covered = new Set<string>();
  for (const target of intent.targets) {
    const ids = trackIdsForMixTarget(doc, target);
    const trackId = ids[0] ?? null;
    if (trackId) covered.add(trackId);
    entries.push({
      target,
      trackName: trackId ? (doc.tracks.find((track) => track.id === trackId)?.name ?? target) : target,
      trackId,
    });
  }
  const explicit = new Set<string>(intent.trackIds ?? []);
  if (intent.trackOrdinal != null) {
    const track = doc.tracks.filter((candidate) => candidate.kind !== "group")[intent.trackOrdinal];
    if (track) explicit.add(track.id);
  }
  for (const trackId of explicit) {
    if (covered.has(trackId)) continue;
    const track = doc.tracks.find((candidate) => candidate.id === trackId);
    if (!track) continue;
    covered.add(trackId);
    entries.push({ target: track.name, trackName: track.name, trackId });
  }
  return entries;
}

export function paramPlan(intent: ParamIntent, doc: Parameters<typeof applyMixIntent>[0]): ParamPlanLine[] {
  const param = paramDefOf(intent.effectType, intent.paramId);
  if (!param) return [];
  const domain: ParamPlanLine["domain"] = param.taper === "log" ? "log" : "linear";
  const fmt = (value: number): string =>
    param.format?.(value) ?? (param.unit ? `${value.toFixed(param.max <= 1 ? 2 : 1)} ${param.unit}` : value.toFixed(2));
  const lines: ParamPlanLine[] = [];
  for (const entry of paramTargetEntries(doc, intent)) {
    if (entry.trackId == null) {
      lines.push({
        target: entry.target,
        trackName: entry.trackName,
        effectType: intent.effectType,
        paramId: intent.paramId,
        domain,
        family: calibrationFamily(param, intent.role),
        fractionPct: null,
        deltaLabel: "—",
        current: 0,
        proposed: 0,
        next: 0,
        clamped: false,
        adding: false,
        label: `${entry.target}: no matching track`,
      });
      continue;
    }
    const trackId = entry.trackId;
    const track = doc.tracks.find((candidate) => candidate.id === trackId);
    const trackName = entry.trackName;
    const adding = !(track && "effects" in track && track.effects.some((effect) => effect.type === intent.effectType));
    const current = currentParamValue(doc, trackId, intent.effectType, intent.paramId);
    const preview = paramMovePreview(intent, current);
    if (!preview) continue;
    const fractionPct = preview.fraction != null ? Math.round(preview.fraction * 1000) / 10 : null;
    const clamped = Math.abs(preview.next - preview.proposed) > 1e-9;
    const values =
      preview.mode === "set" && clamped
        ? `${fmt(preview.current)} → ${fmt(preview.proposed)} (clamped to ${fmt(preview.next)})`
        : `${fmt(preview.current)} → ${fmt(preview.next)}`;
    const label =
      `${trackName}: ${intent.effectType}.${intent.paramId} ${values} · ` +
      `${preview.deltaLabel}${preview.family === "normalized" ? "" : ` (${preview.family})`}` +
      `${clamped && preview.mode !== "set" ? " (clamped)" : ""}${adding ? " (add)" : ""}`;
    lines.push({
      target: entry.target,
      trackName,
      effectType: intent.effectType,
      paramId: intent.paramId,
      domain,
      family: preview.family,
      fractionPct,
      deltaLabel: preview.deltaLabel,
      current: preview.current,
      proposed: preview.proposed,
      next: preview.next,
      clamped,
      adding,
      label,
    });
  }
  return lines;
}

export function paramPlanLines(intent: ParamIntent, doc: Parameters<typeof applyMixIntent>[0]): string[] {
  return paramPlan(intent, doc).map((line) => line.label);
}

/**
 * Apply a param intent → ONE undoable snapshot (the mix layer's apply owns
 * add-if-missing, clamping and idempotency; "changed nothing" propagates).
 */
export function applyParamIntent(doc: Parameters<typeof applyMixIntent>[0], intent: ParamIntent): Command {
  const decisions: MixDecision[] = [];
  const groups: Array<{ target: MixTarget; trackIds?: string[]; label?: string; currentTrackId?: string }> = [];
  for (const target of intent.targets) {
    const ids = trackIdsForMixTarget(doc, target);
    groups.push({ target, currentTrackId: ids[0] });
  }
  const explicit = new Set<string>(intent.trackIds ?? []);
  if (intent.trackOrdinal != null) {
    const track = doc.tracks.filter((candidate) => candidate.kind !== "group")[intent.trackOrdinal];
    if (track) explicit.add(track.id);
  }
  for (const trackId of explicit) {
    // A family already covers this track; do not apply the same value twice.
    if (intent.targets.some((target) => trackIdsForMixTarget(doc, target).includes(trackId))) continue;
    const track = doc.tracks.find((candidate) => candidate.id === trackId);
    if (!track) continue;
    groups.push({ target: "drums", trackIds: [trackId], label: track.name, currentTrackId: trackId });
  }
  for (const group of groups) {
    // One decision per target: resolve the CURRENT value on that target's
    // first matching instance so a relative ask moves from reality.
    const current = group.currentTrackId
      ? currentParamValue(doc, group.currentTrackId, intent.effectType, intent.paramId)
      : (defaultParamsOf(intent.effectType)[intent.paramId] ?? 0);
    const preview = paramMovePreview(intent, current);
    const clamped = preview
      ? preview.next
      : clampEffectParam(intent.effectType, intent.paramId, intent.value ?? current);
    decisions.push({
      target: group.target,
      trackIds: group.trackIds,
      label: group.label,
      effectType: intent.effectType,
      params: { [intent.paramId]: clamped },
    });
  }
  return applyMixIntent(doc, {
    decisions,
    summary: intent.detected,
  });
}

/** Verification read-back in the effect's own unit. */
export function paramReadback(
  before: Parameters<typeof applyMixIntent>[0],
  after: Parameters<typeof applyMixIntent>[0],
  intent: ParamIntent,
): string {
  const param = paramDefOf(intent.effectType, intent.paramId);
  const entries: string[] = [];
  for (const entry of paramTargetEntries(before, intent)) {
    if (!entry.trackId) continue;
    const trackId = entry.trackId;
    const beforeTrack = before.tracks.find((candidate) => candidate.id === trackId);
    const afterTrack = after.tracks.find((candidate) => candidate.id === trackId);
    if (!beforeTrack || !afterTrack || !("effects" in beforeTrack) || !("effects" in afterTrack)) continue;
    const beforeInstance = beforeTrack.effects.find((effect) => effect.type === intent.effectType);
    const afterInstance = afterTrack.effects.find((effect) => effect.type === intent.effectType);
    const beforeValue = beforeInstance?.params[intent.paramId] ?? defaultParamsOf(intent.effectType)[intent.paramId];
    const afterValue = afterInstance?.params[intent.paramId];
    if (afterValue === undefined || beforeValue === afterValue) continue;
    const fmt = (value: number): string =>
      param?.format
        ? param.format(value)
        : param?.unit
          ? `${param.max <= 1 ? value.toFixed(2) : value.toFixed(1)} ${param.unit}`
          : value.toFixed(2);
    entries.push(`${entry.trackName} ${intent.paramId} ${fmt(beforeValue)}→${fmt(afterValue)}`);
  }
  if (entries.length === 0) return "";
  return entries.slice(0, 3).join(", ") + (entries.length > 3 ? ` +${entries.length - 3}` : "");
}




