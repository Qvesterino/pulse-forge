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
import { effectWordIn, applyMixIntent, TARGET_WORDS, EFFECT_KNOB, type MixDecision, type MixTarget } from "./mix";

export type ParamRole = "mix" | "time" | "tone" | "drive" | "width";

interface ParamRoleDef {
  /** SK+EN stems (deaccented, prefix matches like every other table). */
  words: RegExp;
  /** role → paramId per effect type. Only listed effects carry the role. */
  params: Partial<Record<EffectType, string>>;
  /** When the role word itself IS the effect ask ("wider stereo" names no
   * effect noun), this effect is implied. */
  impliedEffect?: EffectType;
}

/**
 * The five producer-facing roles of the first wave. Deliberately NOT the
 * raw param registry: a role names what the ASK means ("dlhší chvost"),
 * the per-effect map names the knob that implements it.
 */
const PARAM_ROLES: Record<ParamRole, ParamRoleDef> = {
  mix: {
    words: /\bmix\b|\bwet\b|\bdry\b|\bsuch|\bmokr|\bpercent(?:a|u|e)? dozvuk|\bpodiel/,
    params: {
      reverb: "mix",
      delay: "mix",
      chorus: "mix",
      flanger: "mix",
      phaser: "mix",
      tremolo: "mix",
      saturation: "mix",
    },
  },
  time: {
    words: /\btime\b|\bcas|\bdecay\b|\bchvost|\btail\b|\bdlh|\bkratk|\blong(?:er)?\b|\bshort(?:er)?\b/,
    params: { reverb: "decay", delay: "time" },
  },
  tone: {
    words: /\btone\b|\bton\b|\btmavs|\bjasnejs|\bsvetlejs|\bdarker\b|\bbrighter\b|\bdark\b|\bbright\b/,
    params: { reverb: "tone", delay: "tone", saturation: "tone" },
  },
  drive: {
    words:
      /\bdrive\b|\bdriv\b|\btekut|\bspinav|\bsaturac|\bzahriat|\bgrit\b|\bdirty\b|\bliquid\b|\bwarm(?:er)?\b|\btepl(?:ej|n|s)/,
    params: { saturation: "drive", distortion: "drive", bassHarmonic: "drive" },
  },
  width: {
    words: /\bwidth\b|\bsirka|\bsirs|\bsirok|\bmono\b|\bstereo\b|\bwider\b|\buzs/,
    params: { haasWidener: "width" },
    // NOTE: no impliedEffect — a bare "wider hats/stereo" ask belongs to the
    // production layer's richer semantic moves; the width role fires only
    // when the widener effect is actually named.
  },
};

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
  /** "set" = absolute raw value; "more"/"less" = relative in the param's own domain. */
  mode: "set" | "more" | "less";
  /** Absolute raw param value (mode "set"). */
  value?: number;
  /** Vibe ladder for relative asks (fractions of the param range). */
  amount: "subtle" | "medium" | "huge";
  /** Explicit percent ("o 20 %") — fraction of the param's range, interpolated
   * in the param's own domain (log for taper:"log"). Wins over `amount`. */
  percent?: number;
  detected: string[];
}

const AMOUNT_FRACTION: Record<ParamIntent["amount"], number> = { subtle: 0.08, medium: 0.18, huge: 0.32 };

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
  unit: "ms" | "s" | "hz" | "khz" | "pct";
}

const UNIT_SET =
  /\b(?:na|to|set|nastav|daj|resp\.?)?\s*(\d+(?:[.,]\d+)?)\s*(ms|milisek|\bsec(?:ond)?s?\b|\bsek\b|\bs\b|hz|khz|%|percent\w*|procent\w*)\b/;

function parseUnitValue(lower: string): UnitValue | null {
  const match = UNIT_SET.exec(lower);
  if (!match) return null;
  const value = Number(match[1].replace(",", "."));
  const rawUnit = match[2];
  let unit: UnitValue["unit"];
  if (/ms|milisek/.test(rawUnit)) unit = "ms";
  else if (/sek|sec|s/.test(rawUnit)) unit = "s";
  else if (rawUnit === "hz") unit = "hz";
  else if (rawUnit === "khz") unit = "khz";
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
export function parseParamIntent(text: string): ParamIntent | null {
  const lower = deaccentLower(text);

  // The role must be named; the effect comes from an effect noun or the
  // role's implied effect ("wider stereo" implies the widener).
  let role: ParamRole | null = null;
  for (const key of Object.keys(PARAM_ROLES) as ParamRole[]) {
    if (!PARAM_ROLES[key].words.test(lower)) continue;
    role = key;
    break;
  }
  if (!role) return null;
  const effectType = effectWordIn(lower) ?? PARAM_ROLES[role].impliedEffect ?? null;
  if (!effectType || !PARAM_ROLES[role].params[effectType]) return null;

  // The param layer owns the NON-primary knobs. When the role resolves to
  // the effect's own primary knob (reverb.mix, saturation.drive…), the
  // effectIntent layer already addresses it with identical semantics —
  // stealing those asks would only churn the pinned routes.
  if (EFFECT_KNOB[effectType] === (PARAM_ROLES[role].params[effectType] as string)) return null;
  const paramId = PARAM_ROLES[role].params[effectType] as string;
  const param = paramDefOf(effectType, paramId);
  if (!param) return null;

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
  if (targets.size === 0) return null;

  const detected: string[] = [`${role} → ${effectType}.${paramId}`, `→ ${[...targets].join("+")}`];

  // SET with a unit ("375 ms", "2.6 s", "5 khz") or a percent word for 0-1
  // knobs. The unit owns the value — no guessing across domains.
  const unitValue = parseUnitValue(lower);
  const percent = parsePercentWord(text);
  if (/\bset\b|\bnastav\b|\bna\s*\d/.test(lower) || unitValue) {
    if (unitValue && unitValue.unit !== "pct") {
      const value = toParamUnit(unitValue.value, unitValue.unit, param);
      const clamped = clampEffectParam(effectType, paramId, value);
      detected.push(`${param.unit ?? param.id} → ${clamped}`);
      return {
        effectType,
        role,
        paramId,
        targets: [...targets],
        mode: "set",
        value: clamped,
        amount: "medium",
        detected,
      };
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
        amount: "medium",
        percent,
        detected,
      };
    }
  }

  // RELATIVE — more/less × ladder or explicit percent. Drier/wetter own the
  // mix role's direction: without them "suchšia saturácia" fell through to
  // the default MORE and turned the wet UP (caught by the real-audio
  // readback — the measured RMS went +268 % on a drier ask).
  const drier = /\bsuch|\bdrier\b|\bdry\b/.test(lower);
  const wetter = /\bmokr|\bwetter\b/.test(lower);
  const less =
    (/\bless\b|\bmenej|\bzniz|\bdown\b|\bdole\b|\bspomals/.test(lower) && role !== "time") ||
    (role === "mix" && drier && !wetter);
  const timeShorter = /\bkrats|\bshort/.test(lower);
  const direction: "more" | "less" = role === "time" ? (timeShorter ? "less" : "more") : less ? "less" : "more";
  let amount: ParamIntent["amount"] = "medium";
  if (/\bsubtle\b|\btrochu\b|\bmalic/.test(lower)) amount = "subtle";
  else if (/\bhuge\b|\ba lot\b|\bobri\b|\bvela\b|\bvelmi\b|\breally\b/.test(lower)) amount = "huge";
  detected.push(direction, percent != null ? `${percent}%` : amount);
  return {
    effectType,
    role,
    paramId,
    targets: [...targets],
    mode: direction,
    amount,
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
 * Apply a param intent → ONE undoable snapshot (the mix layer's apply owns
 * add-if-missing, clamping and idempotency; "changed nothing" propagates).
 */
export function applyParamIntent(doc: Parameters<typeof applyMixIntent>[0], intent: ParamIntent): Command {
  const param = paramDefOf(intent.effectType, intent.paramId);
  const decisions: MixDecision[] = [];
  for (const target of intent.targets) {
    // One decision per target: resolve the CURRENT value on that target's
    // first matching instance so a relative ask moves from reality.
    const trackIds = trackIdsForMixTarget(doc, target);
    const current =
      trackIds.length > 0
        ? currentParamValue(doc, trackIds[0] as string, intent.effectType, intent.paramId)
        : (defaultParamsOf(intent.effectType)[intent.paramId] ?? 0);
    let next: number;
    if (intent.mode === "set") {
      next = intent.value ?? current;
    } else {
      const fraction = intent.percent != null ? intent.percent / 100 : AMOUNT_FRACTION[intent.amount];
      const step = intent.mode === "less" ? -fraction : fraction;
      next = param ? valueAtFraction(param, fractionOf(param, current) + step) : current;
    }
    const clamped = clampEffectParam(intent.effectType, intent.paramId, next);
    decisions.push({ target, effectType: intent.effectType, params: { [intent.paramId]: clamped } });
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
  for (const target of intent.targets) {
    const ids = trackIdsForMixTarget(before, target);
    if (ids.length === 0) continue;
    const beforeTrack = before.tracks.find((candidate) => candidate.id === ids[0]);
    const afterTrack = after.tracks.find((candidate) => candidate.id === ids[0]);
    if (!beforeTrack || !afterTrack || !("effects" in beforeTrack) || !("effects" in afterTrack)) continue;
    const beforeInstance = beforeTrack.effects.find((effect) => effect.type === intent.effectType);
    const afterInstance = afterTrack.effects.find((effect) => effect.type === intent.effectType);
    const beforeValue = beforeInstance?.params[intent.paramId] ?? defaultParamsOf(intent.effectType)[intent.paramId];
    const afterValue = afterInstance?.params[intent.paramId];
    if (afterValue === undefined || beforeValue === afterValue) continue;
    const fmt = (value: number): string =>
      param?.unit ? `${value.toFixed(param.max <= 1 ? 2 : 0)} ${param.unit}` : `${value.toFixed(2)}`;
    entries.push(`${target} ${intent.paramId} ${fmt(beforeValue)}→${fmt(afterValue)}`);
  }
  if (entries.length === 0) return "";
  return entries.slice(0, 3).join(", ") + (entries.length > 3 ? ` +${entries.length - 3}` : "");
}
