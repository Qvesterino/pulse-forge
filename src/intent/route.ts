import type { ProjectDocument } from "../project-model/types";
import { parseArrangeIntent, type ArrangeOp } from "./arrangeWords";
import { parseIntentText, type ParsedIntent } from "./text-parser";
import { parseEffectIntent } from "./mix";
import type { EffectIntent, MixOverrides } from "./mix";

/**
 * Mix-intent vocabulary (INTENT_ENGINE.md D1): words that mean "change the
 * MIX", not "generate a pattern". Tone adjectives ALONE ("dark techno") stay
 * pattern intents — mix routing fires on mix NOUNS/VERBS (reverb, punch,
 * pump, compress…) or explicit comparatives ("darker", "brighter"), which
 * signal "change what exists".
 *
 * EN + SK stems, de-accented by the caller where needed.
 */

interface MixParse {
  overrides: MixOverrides;
  detected: string[];
}

const MIX_NOUN_VERB =
  /\breverb\b|\bdelay\b|\bcompress(?:ion|or)?\b|\bsaturat|\bpunch(?:ier|y)?\b|\bsidechain\b|\bpump\b|\bdry\b|\bwet\b|\beq\b|\bmix\b|\bdozvuk|\bozven|\bkompres|\bsaturac|\bpumpa|\bsuch/;
const COMPARATIVE =
  /\bdarker\b|\bbrighter\b|\bwarmer\b|\bcolder\b|\btmavsi|\bsvetlejsi|\bteplejsi|\bstudenlejsi|\brazantnejsi/;

export function isMixIntentText(text: string): boolean {
  const normalized = text.toLowerCase();
  return MIX_NOUN_VERB.test(normalized) || COMPARATIVE.test(normalized);
}

/** Parse explicit mix requests into profile overrides. */
export function parseMixIntent(text: string): MixParse {
  const lower = ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")} `;
  const overrides: MixOverrides = {};
  const detected: string[] = [];

  if (/\bhuge (?:reverb|space)\b|\bobri dozvuk/.test(lower)) {
    overrides.reverb = "huge";
    detected.push("huge reverb");
  } else if (/\bmore reverb\b|\bwetter\b|\bviac (?:dozvuk|ozven)/.test(lower)) {
    overrides.reverb = "more";
    detected.push("more reverb");
  } else if (/\bless reverb\b|\bdrier\b|\bdry (?:it )?up\b|\bmenej (?:dozvuk|ozven)|\bsuchs?\b/.test(lower)) {
    overrides.reverb = "less";
    detected.push("drier");
  }

  if (/\bdarker\b|\btmavsi/.test(lower)) {
    overrides.tone = "dark";
    detected.push("darker tone");
  } else if (/\bbrighter\b|\bsvetlejsi/.test(lower)) {
    overrides.tone = "bright";
    detected.push("brighter tone");
  } else if (/\bwarmer\b|\bteplejsi/.test(lower)) {
    overrides.tone = "warm";
    detected.push("warmer tone");
  } else if (/\bcolder\b|\bstuden/.test(lower)) {
    overrides.tone = "cold";
    detected.push("colder tone");
  }

  if (/\bpunch(?:ier|y)?\b|\bmore punch\b|\btighter\b|\brazantnejsi|\brazant/.test(lower)) {
    overrides.punch = "more";
    detected.push("more punch");
  } else if (/\bsofter (?:drums|mix|hit)\b|\bmenej razant/.test(lower)) {
    overrides.punch = "less";
    detected.push("softer");
  }

  if (/\bno pump\b|\bwithout (?:pump|sidechain)\b|\bbez pumpy/.test(lower)) {
    overrides.pump = "off";
    detected.push("pump off");
  } else if (/\b(?:sidechain|pump|duck)(?:ing)?\b/.test(lower)) {
    overrides.pump = "on";
    detected.push("pump on");
  }

  return { overrides, detected };
}

// ── REVISE intent (C2): "more energetic" = change the LAST result, keep
// its identity (same seed), just shift a content slider. Deliberately
// SEPARATE from mix: tone words are SOUND processing, energy/density words
// are NOTE CONTENT.
// C3 targeted revise: a SECTION ROLE word in the text ("make bridge more
// energic") targets that scene instead of the last result.
export type ReviseAttribute = "energy" | "density";
export type ReviseDirection = "more" | "less";

export interface ReviseParse {
  attribute: ReviseAttribute;
  direction: ReviseDirection;
  detected: string[];
  /** Section role named in the text — null = global (last result). */
  targetRole: string | null;
}

/** Per-revise slider step (clamped at apply time). */
export const REVISE_DELTA = 0.15;

const REVISE_ENERGY_MORE =
  /\bmore (?:energetic|energic|energy)\b|\benergickejsi\b|\bviac (?:energie|energicky)\b/;
const REVISE_ENERGY_LESS =
  /\bless (?:energetic|energic|energy)\b|\bcalmer\b|\bmenej (?:energie|energicky)\b/;
const REVISE_DENSITY_MORE = /\b(?:more )?(?:busier|denser)\b|\bhustejsi\b|\bviac prvkov\b/;
const REVISE_DENSITY_LESS = /\bsparser\b|\bless busy\b|\bmenej hust/;

/** Section-role words that turn a global revise into a TARGETED one. */
const REVISE_ROLE_WORDS: ReadonlyArray<readonly [string, RegExp]> = [
  ["bridge", /\b(bridge|most|mostik)\b/],
  ["chorus", /\b(chorus|hook|refren)\b/],
  ["verse", /\b(verse|zloh)/],
  ["intro", /\bintro\b/],
  ["outro", /\b(outro|zaver|koncovka)\b/],
  ["build", /\b(build|buildup|stavb)/],
  ["break", /\b(break|breakdown|brejk)\b/],
  ["drop", /\bdrop\b/],
];

function reviseRoleIn(lower: string): string | null {
  for (const [role, re] of REVISE_ROLE_WORDS) {
    if (re.test(lower)) return role;
  }
  return null;
}

/** Parse "more energetic"-style content revisions. Null = not a revise. */
export function parseReviseIntent(text: string): ReviseParse | null {
  const lower = ` ${text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")} `;
  const targetRole = reviseRoleIn(lower);
  const detected = targetRole ? [`${targetRole} §`] : [];
  if (REVISE_ENERGY_MORE.test(lower)) {
    return { attribute: "energy", direction: "more", detected, targetRole };
  }
  if (REVISE_ENERGY_LESS.test(lower)) {
    return { attribute: "energy", direction: "less", detected, targetRole };
  }
  if (REVISE_DENSITY_MORE.test(lower)) {
    return { attribute: "density", direction: "more", detected, targetRole };
  }
  if (REVISE_DENSITY_LESS.test(lower)) {
    return { attribute: "density", direction: "less", detected, targetRole };
  }
  return null;
}

export type RoutedIntent =
  | { kind: "arrange"; ops: ArrangeOp[]; unrecognized: string[] }
  | { kind: "effectIntent"; intent: EffectIntent }
  | { kind: "mix"; overrides: MixOverrides; detected: string[] }
  | { kind: "revise"; attribute: ReviseAttribute; direction: ReviseDirection; detected: string[]; targetRole: string | null }
  | { kind: "pattern"; input: ParsedIntent["input"]; detected: string[] };

/**
 * UNIFIED INTENT BAR router (INTENT_ENGINE.md D3): one text input, five
 * executors. Priority:
 *   1. ARRANGE — the doc has scenes and the text parses into arrangement ops
 *      ("shorten the intro", "add a break before the drop").
 *   2. EFFECT INTENT (D1 v2a) — a TARGETED effect request: effect noun ×
 *      target × direction ("viac delayu na leade", "remove reverb from the
 *      bass") — more specific than the mix profile, so it wins over it.
 *   3. MIX — mix nouns/verbs or tone comparatives without a target ("more
 *      reverb", "punchier", "darker mix") — SOUND processing.
 *   4. REVISE — "more/less energetic|busy" — CONTENT sliders on the LAST
 *      result, same seed (identity preserved).
 *   5. PATTERN — everything else is a generation intent (default).
 * Ambiguity is resolved toward the LEAST destructive interpretation: arrange
 * ops only fire when they parse cleanly; mix only on explicit mix vocabulary;
 * revise only on comparative + attribute pairs.
 */
export function routeIntentText(text: string, doc: ProjectDocument): RoutedIntent {
  if (doc.scenes.length > 0) {
    const arrange = parseArrangeIntent(text, doc);
    if (arrange.ops.length > 0) {
      return { kind: "arrange", ops: arrange.ops, unrecognized: arrange.unrecognized };
    }
  }
  const effectIntent = parseEffectIntent(text);
  if (effectIntent) {
    return { kind: "effectIntent", intent: effectIntent };
  }
  if (isMixIntentText(text)) {
    const mix = parseMixIntent(text);
    return { kind: "mix", overrides: mix.overrides, detected: mix.detected };
  }
  const revise = parseReviseIntent(text);
  if (revise) {
    return { kind: "revise", ...revise };
  }
  const pattern = parseIntentText(text);
  return { kind: "pattern", input: pattern.input, detected: pattern.detected };
}
