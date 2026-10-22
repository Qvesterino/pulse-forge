import type { ProjectDocument, SceneRole } from "../project-model/types";
import {
  deaccent,
  parseArrangeIntent,
  parseClipArrangeIntent,
  parseSelectedClipArrangeIntent,
  parseSelectedAudioClipFadeIntent,
  parseSelectedTimeRangeIntent,
  type ArrangeOp,
  type ClipArrangeOp,
  type SelectedTimeRangeOperation,
} from "./arrangeWords";
import { parseIntentText, type ParsedIntent } from "./text-parser";
import {
  canApplySendIntent,
  effectWordIn,
  parseEffectIntent,
  parseSendIntent,
  parseBypassIntent,
  TARGET_WORDS,
} from "./mix";
import { declinedParamIntentClarification, parseParamIntent, type ParamIntent } from "./param-intent";
import { parseLoudnessIntent } from "./loudness";
import {
  parseFaderIntent,
  parseNamedTrackFaderIntent,
  parseTempoIntent,
  parsePopIntent,
  splitIntentClauses,
  type FaderIntent,
  type TempoIntent,
} from "./conversation";
import type { EffectIntent, MixOverrides } from "./mix";
import type { SendIntent, BypassIntent } from "./mix";
import { namesProductionTarget, parseProductionIntent, type ProductionIntent } from "./production";
import {
  parseExactIntent,
  parseExportIntent,
  parseRecordIntent,
  parseSaveIntent,
  parseSelectIntent,
  parseTransportIntent,
  type ExactIntentPlan,
  type ExactTarget,
  type ExportFormat,
  type TransportAction,
} from "./exact";
import {
  parseAutomateIntent,
  parseCheckpointIntent,
  parseGrooveIntent,
  parseMarkerIntent,
  parseSceneIntensityIntent,
  parseQueryIntent,
  parseSectionGrooveIntent,
  parseUndoIntent,
  type AutomateIntent,
  type CheckpointIntent,
  type GrooveIntent,
  type MarkerIntent,
  type QueryIntent,
  type SectionGrooveIntent,
  type UndoIntent,
} from "./studio-words";
import { parseSoundSwapIntent, parseStepEditIntent, type SoundSwapIntent, type StepEditIntent } from "./sound-words";
import { declinedFaderClarification } from "./conversation";
import { declinedEffectClarification } from "./mix";
import { parseCompoundIntent, type CompoundPart } from "./compound";
import { parseComplaintIntent, type ComplaintIntent } from "./complaints";
import { parsePresetIntent, type PresetIntent } from "./preset-intent";
import { typoCorrections } from "./typo";
import { parseSectionRequests } from "./sections";
import { parseSelectedStepIntent, type SelectedStepIntent } from "../assist/selected-step-intent";
import { stripPriorDeltaReference } from "./reference-delta";
import { isDescriptiveStatement } from "./declarative";
import { resolvePriorAdjustment } from "./prior-adjustment";

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
  /\breverb|\bdelay\b|\bcompress(?:ion|or)?\b|\bsaturat|\bpunch(?:ier|y)?\b|\bsidechain\b|\bpump\b|\bdry\b|\bdrier\b|\bwet\b|\bwetter\b|\beq\b|\bmix\b|\bdozvuk|\bozven|\bkompres|\bsaturac|\bpump|\bsuch/;
const COMPARATIVE =
  /\bdarker\b|\bbrighter\b|\bwarmer\b|\bcolder\b|\btmavsi|\bsvetlejsi|\bteplejsi|\bstudenlejsi|\brazantnejsi/;
const HYPOTHETICAL_ACTION_QUESTION =
  /^\s*(?:(?:would|could|might)\s+(?:(?!you\b)(?:(?:a|an|the|this|that)\s+|[a-z]+ing\b|we\b))|should\s+(?:we|i|you)\b|what\s+if\b|maybe\b)[\s\S]*\b(?:help|make|improve|work|sound|feel|add|remove|delete|change|raise|lower|increase|decrease|mute|unmute|pan|move|set|turn|bypass|apply|insert)\b[\s\S]*\?\s*$/i;
/**
 * A fence — "turn down the drums and DON'T TOUCH the bass" — must stop the
 * command, not narrow it.
 *
 * This is an ALLOWLIST of mutation verbs, so any fence whose verb is missing
 * here simply does not fire and the sentence mutates everything it named. The
 * audit (2026-10-19) found exactly that: "don't touch the bass" was invisible
 * because the list ended at `record` and never learned that "touch" (or
 * "leave", "affect", "touch up") is the most natural way to fence a track in
 * this product. Measured: the sentence routed to `fader` with targets
 * ["bass","drums"], direction down — the user's explicit carve-out executed.
 *
 * When a fence is present the whole sentence declines, which is deliberate:
 * splitting the clause to apply only the first half is a guess about which
 * half the user meant, and the product rule is to ask rather than mutate.
 */
const NEGATED_MUTATION_COMMAND =
  /(?:^|[,;.!?]\s*|\b(?:and|but|while)\s+)(?:please\s+)?(?:do\s+not|don't|dont|never)\b[\s\S]*?\b(?:touch|touches|touching|leave|leaves|affect|affects|make|makes|boost|cut|drop|push|pull|dial|adjust|mute|unmute|solo|delete|remove|add|raise|lower|turn|change|set|increase|decrease|move|pan|bypass|apply|insert|undo|redo|start|stop|record)\b/i;

/**
 * The command half of a fenced sentence, as standalone executable prompts.
 *
 * "turn down the drums and don't touch the bass" → ["turn down the drums"].
 *
 * Only clauses that actually PARSE as a fader ask are offered, so every
 * suggestion the producer can click is a sentence the engine can execute. A
 * clause that carries the negation is dropped — offering "don't touch the
 * bass" as a clickable chip would re-run the fence that produced this decline.
 *
 * Empty when no clause stands alone as a command ("never change the master"
 * leaves nothing to offer) — the decline then shows its message and no chip.
 */
function negatedClauseSuggestions(text: string): string[] {
  const suggestions = splitIntentClauses(text)
    .filter((clause) => !/\b(?:do\s+not|don't|dont|never)\b/i.test(clause))
    .filter((clause) => parseFaderIntent(clause) !== null);
  return suggestions.slice(0, 3);
}

/**
 * Complete preset asks — the producer's own sentence with the target filled in.
 *
 * The previous suggestions were FRAGMENTS ("on the bass", "na akordy") meant to
 * complete the sentence by hand. But the UI sends a clicked chip to the router
 * STANDALONE, so the fragment lost the sentence it was completing. Measured
 * 2026-10-19: every one of the six fragments routed to a creative brief, so
 * clicking one GENERATED A NEW BEAT and replaced the producer's song — the
 * exact P0-A failure the miss path is guarded against everywhere else.
 *
 * A chip is therefore a whole sentence: the producer's own words plus the
 * target, in the producer's own language (the preset verbs decide SK vs EN).
 */
function presetTargetSuggestions(text: string): string[] {
  const base = text.trim().replace(/\s+/g, " ");
  const slovak = /\b(?:nacitaj|pouzi|nahraj)\b/.test(base.toLowerCase());
  const targets = slovak ? ["bas", "808", "akordy", "bicie", "lead"] : ["bass", "808", "chords", "drums", "lead"];
  const joiner = slovak ? " na " : " on the ";
  return targets.map((family) => `${base}${joiner}${family}`);
}

export function isMixIntentText(text: string): boolean {
  // Same normalization parseMixIntent applies — the guard must never be
  // stricter than the parser (an accented "tmavší zvuk" used to fail here
  // and fall through to generation — INTENT-AUDIT-2026-10 D6).
  const normalized = ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")} `;
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

  if (/\bhuge (?:reverb|space)\b|\bobr[a-z]* dozvuk/.test(lower)) {
    overrides.reverb = "huge";
    detected.push("huge reverb");
  } else if (
    /\bmore reverb\b|\bwetter\b|\bwet (?:it )?up\b|\bmokrejs|\bviac reverbu\b|\bviac (?:dozvuk|ozven)/.test(lower)
  ) {
    overrides.reverb = "more";
    detected.push("more reverb");
  } else if (
    /\bless reverb\b|\bdrier\b|\bdry (?:it )?up\b|\bmake it drier\b|\bsuch|\bmenej reverbu\b|\bmenej (?:dozvuk|ozven)/.test(
      lower,
    )
  ) {
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

  if (
    /\bpunch(?:ier|y)?\b|\bmore punch\b|\btighter\b|\brazantnejsi|\brazant|\b(?:viac |more )?kompres|\bsquash/.test(
      lower,
    )
  ) {
    overrides.punch = "more";
    detected.push("more punch");
  } else if (/\bsofter (?:drums|mix|hit)\b|\bmenej razant|\bmenej kompres|\bless compress/.test(lower)) {
    overrides.punch = "less";
    detected.push("softer");
  }

  if (
    /\bno pump\b|\bwithout (?:pump|sidechain)\b|\bbez pumpy\b|\b(?:take|remove)\b.{0,24}\bpump\b.{0,24}\bout\b/.test(
      lower,
    ) ||
    /\bsidechain (?:off|vypni)\b|\bpump(?:a|u)? (?:off|vypni)\b|\bvypni (?:sidechain|pump(?:a|u)?)\b/.test(lower)
  ) {
    overrides.pump = "off";
    detected.push("pump off");
  } else if (/\b(?:sidechain|pump|duck)(?:ing)?\b|\bsidechain zapni\b/.test(lower)) {
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

export type SectionFlow = "straight" | "triplet" | "offbeat";

export interface SectionFlowParse {
  targetRole: SceneRole;
  flow: SectionFlow;
  detected: string[];
}

const REVISE_ENERGY_MORE = /\bmore (?:energetic|energic|energy)\b|\benergetick|\bviac (?:energie|energicky)\b/;
const REVISE_ENERGY_LESS =
  /\bless (?:energetic|energic|energy)\b|\bcalmer\b|\bpokojnejs|\bmenej (?:energie|energick)\b/;
const REVISE_DENSITY_MORE = /\b(?:more )?(?:busier|denser)\b|\bhustejs|\bviac prvkov\b/;
const REVISE_DENSITY_LESS = /\bsparser\b|\bless busy\b|\bless dense\b|\bmenej hust/;

/** Section-role words that turn a global revise into a TARGETED one. */
const REVISE_ROLE_WORDS: ReadonlyArray<readonly [SceneRole, RegExp]> = [
  ["bridge", /\b(bridge|most|mostik)\b/],
  ["chorus", /\b(chorus|hook|refren)\b/],
  ["verse", /\b(verse|zloh)/],
  ["intro", /\bintro\b/],
  ["outro", /\b(outro|zaver|koncovka)\b/],
  ["build", /\b(build|buildup|stavb)/],
  ["break", /\b(break|breakdown|brejk)\b/],
  ["drop", /\bdrop\b/],
];

function reviseRoleIn(lower: string): SceneRole | null {
  for (const [role, re] of REVISE_ROLE_WORDS) {
    if (re.test(lower)) return role;
  }
  return null;
}

/** Parse an explicit lead-flow request scoped to one named song section. */
export function parseSectionFlowIntent(text: string): SectionFlowParse | null {
  const lower = ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")} `;
  const targetRole = reviseRoleIn(lower);
  if (!targetRole) return null;

  const flow: SectionFlow | null = /\btriplet(?:y|ovy)?(?: flow)?\b/.test(lower)
    ? "triplet"
    : /\boff(?:-)?beat(?: flow)?\b/.test(lower)
      ? "offbeat"
      : /\bstraight flow\b/.test(lower)
        ? "straight"
        : null;
  if (!flow) return null;
  return { targetRole, flow, detected: [`${targetRole} §`, `${flow} flow`] };
}

export type SectionTransitionKind = "fill" | "riser" | "break";

export interface SectionTransitionParse {
  targetRole: SceneRole;
  transition: SectionTransitionKind;
  detected: string[];
}

const SECTION_TRANSITION_WORDS: ReadonlyArray<readonly [SectionTransitionKind, RegExp]> = [
  // The NOUN phrases producers say — "drum fill", "snare roll", "build-up" —
  // each maps to a treatment even without the bare kind word.
  ["fill", new RegExp("\\bfill(?:y|ov)?\\b|\\bfil(?:l|luj)\\b|\\b(?:drum|snare) ?roll\\b|\\broll(?:uj)?\\b")],
  ["riser", new RegExp("\\bris(?:er|y)?\\b|\\brywajz\\b|\\bbuild[- ]?up\\b")],
  ["break", new RegExp("\\bbreak\\b|\\bbrejk\\b|\\bdropout\\b|\\bticho\\b")],
];
/**
 * NOUN PHRASES are self-identifying — they carry the intent without a verb
 * ("snare roll into the drop"). Bare kind words still require the verb, or
 * every "break" in every sentence would hijack the route.
 */
const SECTION_TRANSITION_NOUN_PHRASES = /\b(?:drum|snare|tom) ?roll\b|\bdrum ?fill\b|\bbuild-?up\b|\bdropout\b/;
const SECTION_TRANSITION_VERB = new RegExp("\\b(?:add|pridaj|daj|insert|vkldaj|zapni|put|give|vloz|sprav|urob)\\b");

/**
 * STRUCTURAL ARRANGEMENT COMMAND (2026-10-11): "add a fill before every
 * chorus" / "pridaj riser pred drop" — a transition KIND targeting the
 * section it leads INTO. Fill/riser/break paint onto the PREDECESSOR
 * section's pattern (the same treatments the song builder bakes); drop and
 * impact are cue-asset transitions with no pattern shape and are
 * deliberately not part of this grammar.
 */
export function parseSectionTransitionIntent(text: string): SectionTransitionParse | null {
  const lower = ` ${text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")} `;
  const targetRole = reviseRoleIn(lower);
  if (!targetRole) return null;
  // A noun phrase speaks for itself; a bare kind word needs the verb.
  const hasNoun = SECTION_TRANSITION_NOUN_PHRASES.test(lower);
  if (!hasNoun && !SECTION_TRANSITION_VERB.test(lower)) return null;
  for (const [transition, re] of SECTION_TRANSITION_WORDS) {
    if (re.test(lower)) {
      return { targetRole, transition, detected: [`${transition} → ${targetRole} §`] };
    }
  }
  return null;
}

/** Parse "more energetic"-style content revisions. Null = not a revise. */
export function parseReviseIntent(text: string): ReviseParse | null {
  const lower = ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")} `;
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
  | { kind: "clips"; ops: ClipArrangeOp[] }
  | { kind: "exact"; plan: ExactIntentPlan }
  | { kind: "fader"; intent: FaderIntent }
  | { kind: "compound"; parts: CompoundPart[] }
  | { kind: "transport"; action: TransportAction }
  | { kind: "save" }
  | { kind: "export"; format: ExportFormat }
  | { kind: "record"; arm: boolean }
  | { kind: "undoIntent"; intent: UndoIntent }
  | { kind: "checkpointIntent"; intent: CheckpointIntent }
  | { kind: "complaintIntent"; intent: ComplaintIntent }
  | { kind: "queryIntent"; intent: QueryIntent }
  | { kind: "grooveIntent"; intent: GrooveIntent }
  | { kind: "sectionGrooveIntent"; intent: SectionGrooveIntent }
  | { kind: "automateIntent"; intent: AutomateIntent }
  | { kind: "markerIntent"; intent: MarkerIntent }
  | { kind: "stepEditIntent"; intent: StepEditIntent }
  | { kind: "selectedStepAssist"; intent: SelectedStepIntent }
  | { kind: "selectedClipArrange"; clipId: string; ops: ClipArrangeOp[] }
  | {
      kind: "selectedRangeArrange";
      range: { fromTick: number; toTick: number };
      operation: SelectedTimeRangeOperation;
    }
  | { kind: "soundSwapIntent"; intent: SoundSwapIntent }
  | { kind: "select"; target: ExactTarget }
  | { kind: "sceneIntensity"; sceneName: string; percent: number }
  | { kind: "preset"; intent: PresetIntent }
  | { kind: "presetUnknown"; name: string; suggestions: string[] }
  | { kind: "sendIntent"; intent: SendIntent }
  | { kind: "bypassIntent"; intent: BypassIntent }
  | {
      kind: "clarify";
      /**
       * MACHINE KEY. Stable, snake-case, and part of the SFT teacher's
       * compacted action — so it must NOT be reworded. It groups declines in
       * the mining log; the producer reads `clarifyMessage(reason)` instead
       * (see intent/clarify-messages.ts — the one home for that vocabulary).
       *
       * A few declines use a full SENTENCE as their reason (the unmatched-route
       * clarify, the section-scoped ones). Those read as-is.
       */
      reason: string;
      /**
       * SUGGESTIONS.
       *
       * Two kinds were mixed in one list, and the difference is not something a
       * reader can infer from the wording:
       *
       *   COMMAND  "turn down the drums" — a complete ask the engine runs.
       *   ADVICE   "name the track or layer" — an instruction in prose.
       *
       * Rendered as one list of chips, clicking an advice item re-routed
       * English prose back into the engine, and clicking a sentence FRAGMENT
       * ("on the bass" — the tail of "load the Warm Sub preset on the bass")
       * routed to a creative brief: measured 2026-10-19, that GENERATED A NEW
       * BEAT and replaced the producer's song.
       *
       * So the KIND IS DECLARED, not inferred: `advice` lists the items that
       * are prose. Everything else in `suggestions` is a command and becomes a
       * chip. `suggestions` itself is unchanged (the SFT teacher pins it).
       */
      suggestions: string[];
      /** The subset of `suggestions` that is ADVICE, not a command. */
      advice?: string[];
      choices?: IntentClarificationChoice[];
    }
  | { kind: "tempo"; intent: TempoIntent }
  | { kind: "effectIntent"; intent: EffectIntent }
  | { kind: "paramIntent"; intent: ParamIntent }
  | { kind: "loudness"; parse: { direction: "louder" | "quieter"; targetDb?: number; detected: string[] } }
  | { kind: "production"; intent: ProductionIntent }
  | { kind: "mix"; overrides: MixOverrides; detected: string[] }
  | ({ kind: "sectionFlow" } & SectionFlowParse)
  | ({ kind: "sectionTransition" } & SectionTransitionParse)
  | { kind: "sectionProduction"; targetRole: SceneRole; intent: ProductionIntent; detected: string[] }
  | {
      kind: "revise";
      attribute: ReviseAttribute;
      direction: ReviseDirection;
      detected: string[];
      targetRole: string | null;
    }
  | { kind: "pattern"; input: ParsedIntent["input"]; detected: string[] };

export type IntentClarificationChoice = {
  label: string;
  route: { kind: "sendIntent"; intent: SendIntent } | { kind: "fader"; intent: FaderIntent };
};

function ambiguousSendReturnChoices(text: string, doc: ProjectDocument): IntentClarificationChoice[] {
  const lower = ` ${deaccent(text)
    .toLowerCase()
    .replace(/[^a-z0-9%\s'-]/g, " ")
    .replace(/\s+/g, " ")} `;
  const effectType = effectWordIn(lower);
  const target = TARGET_WORDS.find(([pattern]) => pattern.test(lower))?.[1];
  const parsedFader = parseFaderIntent(text);
  if (!effectType || !target) return [];

  const isUp = parsedFader?.direction === "up" || /\b(?:raise|increase|turn up)\b/.test(lower);
  const direction = isUp ? "up" : "down";
  const matchingReturns = doc.returns.filter((item) => item.effects.some((effect) => effect.type === effectType));
  const choices: IntentClarificationChoice[] = [];
  const sendText = `${isUp ? "more" : "less"} ${effectType} send on ${target}`;
  const sendIntent = parseSendIntent(sendText);
  const explicitMagnitude = /\b(?:by|to|at|o)\s+\d/.test(lower);
  if (sendIntent && parsedFader?.percent == null && !explicitMagnitude && canApplySendIntent(doc, sendIntent)) {
    choices.push({
      label: `${isUp ? "Increase" : "Reduce"} ${effectType} send on ${target}`,
      route: { kind: "sendIntent", intent: sendIntent },
    });
  }
  if (matchingReturns.length > 0) {
    const returnLabel = matchingReturns.length === 1 ? matchingReturns[0]!.name : `${effectType} returns`;
    choices.push({
      label: `${isUp ? "Raise" : "Lower"} ${returnLabel} return level`,
      route: {
        kind: "fader",
        intent: {
          targets: [],
          returnIds: matchingReturns.map((item) => item.id),
          direction,
          ...(parsedFader?.amount ? { amount: parsedFader.amount } : {}),
          ...(parsedFader?.percent != null ? { percent: parsedFader.percent } : {}),
        },
      },
    });
  }
  return choices;
}

/**
 * PRIOR-DELTA DECLINE — the fallback when the ledger cannot answer.
 *
 * "a little less than last time", "half that adjustment" and "do the same on
 * track two" are resolved by `resolvePriorAdjustment` when the last successful
 * move is still known. When there is no usable record (fresh session, project
 * switch, undo, deleted target) the honest answer is a focused clarification —
 * never the phrase's own nominal step, and never pattern generation.
 *
 * The suggestion is the producer's own sentence with the reference phrase
 * removed, and only when that sentence actually re-parses as an executable
 * intent — a chip must never be a guess. Everything else is declared ADVICE.
 */
function clarifyPriorReference(text: string, reason: string): Extract<RoutedIntent, { kind: "clarify" }> {
  const stripped = stripPriorDeltaReference(text);
  const suggestions: string[] = [];
  if (stripped && stripped !== text.trim()) {
    const executable =
      parseFaderIntent(stripped) !== null ||
      parseParamIntent(stripped) !== null ||
      parseEffectIntent(stripped) !== null;
    if (executable) suggestions.push(stripped);
  }
  const advice = ["Name the target and the amount you want", "Say 'undo that' to remove the last change"];
  return { kind: "clarify", reason, suggestions, advice };
}

function clarifyAmbiguousCommand(text: string, doc: ProjectDocument): RoutedIntent | null {
  const lower = ` ${deaccent(text)
    .toLowerCase()
    .replace(/[^a-z0-9%\s'-]/g, " ")
    .replace(/\s+/g, " ")} `;
  // Every suggestion in THIS helper is an instruction in prose ("name the
  // track or layer", "give a percentage or dB value"). They are declared as
  // ADVICE so the UI shows them as text instead of as clickable chips — a
  // chip would send the prose back into the router.
  //
  // Measured 2026-10-19: "choose louder or quieter" routes to a LOUDNESS
  // action and "say faster or slower" routes to a TEMPO action, so probing the
  // router for "is this executable" cannot tell prose from a command here.
  // The kind has to be declared.
  const clarify = (reason: string, suggestions: string[]): Extract<RoutedIntent, { kind: "clarify" }> => ({
    kind: "clarify",
    reason,
    suggestions,
    advice: suggestions,
  });
  const targets = [
    /\b(?:bass|808|sub)\b/,
    /\b(?:drums?|kick|snare|clap|hats?)\b/,
    /\b(?:lead|synth)\b/,
    /\b(?:chords?|keys|pads?)\b/,
    /\b(?:vocals?|voice|vox)\b/,
    /\bmaster\b/,
  ].filter((pattern) => pattern.test(lower));

  if (
    /\b(?:set|put)\b.{0,36}\b(?:master|bass|lead|drums?|chords?|vocal|snare|kick)\b.{0,48}\b(?:\d{1,3}|zero|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s*(?:%|percent)?\b.{0,28}\b(?:and|or)\b.{0,18}\b(?:\d{1,3}|zero|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s*(?:%|percent)\b.{0,32}\b(?:at the same time|at once|simultaneously|both)\b/.test(
      lower,
    )
  ) {
    return clarify("conflicting-values", ["state one target value", "split the changes into separate commands"]);
  }
  if (
    targets.length === 1 &&
    /\b(?:but|and|while)\b/.test(lower) &&
    ((/\b(?:mute|muted)\b/.test(lower) &&
      (/\b(?:audible|playing|unmuted)\b/.test(lower) ||
        /\b(?:not|never|don't|dont|without)\b[\s\S]{0,30}\bsilent\b/.test(lower))) ||
      (/\bunmute\b/.test(lower) && /\bmuted\b/.test(lower)))
  ) {
    return clarify("conflicting-actions", ["mute the track", "keep the track audible"]);
  }
  if (
    targets.length === 1 &&
    /\bpan\b/.test(lower) &&
    /\bleft\b/.test(lower) &&
    /\bright\b/.test(lower) &&
    /\b(?:and|but|at once|simultaneously)\b/.test(lower)
  ) {
    return clarify("conflicting-pan-directions", ["choose left or right"]);
  }
  if (
    targets.length === 1 &&
    /\b(?:louder|raise|increase|turn up|boost|lift|bring up)\b/.test(lower) &&
    /\b(?:quieter|lower|reduce|decrease|less|turn down|pull down|drop)\b/.test(lower) &&
    /\b(?:and|but|while)\b/.test(lower)
  ) {
    return clarify("conflicting-level-directions", ["choose louder or quieter"]);
  }
  if (
    /\b(?:set|put)\b[\s\S]*\b(?:right|correct|appropriate|sensible|reasonable)\s+level\b/.test(lower) &&
    !/\d/.test(lower)
  ) {
    return clarify("missing-level-value", ["give a percentage or dB value"]);
  }
  if (/\b(?:move|pan)\b.{0,24}\b(?:it|that|this|the other layer)\b[\s\S]*\b(?:left|right)\b/.test(lower)) {
    return clarify("missing-pan-target", ["name the track or layer"]);
  }
  if (/\b(?:set|put|place)\s+(?:it|that|this)\b[\s\S]*\b\d{1,3}\s*(?:%|percent)\b/.test(lower)) {
    return clarify("missing-level-target", ["name the track or layer"]);
  }
  if (/\b(?:lower|raise|turn down|turn up|pull back)\b[\s\S]{0,24}\b(?:it|that|this)\b/.test(lower)) {
    return clarify("missing-fader-target", ["name the track or layer"]);
  }
  if (
    /\b(?:make|bring|turn|raise|lower|lift)\b[\s\S]*\bthe other (?:layer|one)\b[\s\S]*\b(?:prominent|louder|quieter|forward|back|down|up)\b/.test(
      lower,
    )
  ) {
    return clarify("missing-layer-target", ["name the track or layer"]);
  }
  if (/\b(?:add|apply|more|increase)\b[\s\S]*\bthat effect\b/.test(lower)) {
    return clarify("missing-effect-target", ["name the effect and track"]);
  }
  if (/\b(?:pan|move)\b[\s\S]*\b(?:somewhere|somewhere over)\b[\s\S]*\b(?:left|right)\b/.test(lower)) {
    return clarify("missing-pan-amount", ["give a pan amount or percentage"]);
  }
  if (
    /\btempo\b[\s\S]*\b(?:comfortable|appropriate|right|good|usual|normal|default)\s+(?:speed|pace)\b/.test(lower) &&
    !/\d/.test(lower)
  ) {
    return clarify("missing-tempo-value", ["give a BPM value", "say faster or slower"]);
  }
  if (/\bsend\b[\s\S]*\b(?:sensible|reasonable|appropriate)\s+amount\b/.test(lower)) {
    return clarify("missing-send-value", ["name the effect and track, then give a level", "say more or less send"]);
  }
  if (
    /\bset\b[\s\S]*\b(?:reverb|delay|echo|chorus|compress(?:ion|or)?|saturation|flanger|phaser)\b[\s\S]*\b(?:sensible|reasonable|appropriate|good|right)\s+amount\b/.test(
      lower,
    ) &&
    !/\d/.test(lower)
  ) {
    return clarify("missing-effect-value", ["give a percentage", "say more or less"]);
  }
  if (
    /\b(?:raise|lower|increase|decrease|turn up|turn down)\b[\s\S]{0,40}\b(?:reverb|delay|echo|chorus)\s+return\b/.test(
      lower,
    )
  ) {
    return {
      ...clarify("ambiguous-send-return", ["change the track's send level", "change the effect return channel"]),
      choices: ambiguousSendReturnChoices(text, doc),
    };
  }
  if (/\b(?:could you|can you|please)\s+pull\s+(?:it|that|this)\s+back\b/.test(lower)) {
    return clarify("missing-fader-target", ["name the track or effect to pull back"]);
  }
  if (
    /\b(?:intro|verse|chorus|drop|bridge|outro)\b[\s\S]*\b(?:short|long)\s+length\b/.test(lower) &&
    !/\d/.test(lower)
  ) {
    return clarify("missing-section-length", ["give a bar count", "say shorter or longer"]);
  }
  return null;
}

/**
 * UNIFIED INTENT BAR router (INTENT_ENGINE.md D3): one text input, five
 * executors. Priority:
 *   1. ARRANGE — the doc has scenes and the text parses into arrangement ops
 *      ("shorten the intro", "add a break before the drop").
 *   2. EXACT — explicit mixer commands with explicit targets/values ("mute
 *      the drums", "pan the bass left 30", "transpose the lead up one
 *      octave", "set tempo to 142").
 *   3. FADER — a NAMED track fader ask ("zníž basu", "hlasitosť 808s o 10 %"):
 *      targeted beats global, so it wins over the loudness loop below.
 *   3b. COMPOUND — several clause asks in one sentence, every clause parses
 *      on its own ("zníž tempo a zvýš lead") — one undo step, mixed executors.
 *   4. LOUDNESS — untargeted louder/quieter shouts ("make it louder") and
 *      explicit targets ("loudness na −9") — the master measure→trim loop.
 *   5. TEMPO / POP VIBE — "tempo na 128", "popovejšie".
 *   6. EFFECT INTENT (D1 v2a) — a TARGETED effect request: effect noun ×
 *      target × direction ("viac delayu na leade", "remove reverb from the
 *      bass") — more specific than the mix profile, so it wins over it.
 *   7. PRODUCTION — a production concept ("darker", "punchier", "deeper"…)
 *      with an EXPLICIT target track named ("make the drums darker") and no
 *      genre signal: the user said WHERE, so the change lands on that track's
 *      FX (mirrors the GENERATE button's production path). Without a named
 *      target, tone comparatives stay with the mix profile.
 *   8. MIX — mix nouns/verbs or tone comparatives without a target ("more
 *      reverb", "punchier", "darker mix") — SOUND processing. Only when the
 *      text actually parses into a mix decision (see the branch below).
 *   9. REVISE — "more/less energetic|busy" — CONTENT sliders on the LAST
 *      result, same seed (identity preserved).
 *  10. PATTERN — everything else is a generation intent (default).
 * Ambiguity is resolved toward the LEAST destructive interpretation: arrange
 * ops only fire when they parse cleanly; mix only on explicit mix vocabulary;
 * revise only on comparative + attribute pairs.
 */
export function routeIntentText(
  text: string,
  doc: ProjectDocument,
  context: {
    hasSelectedStepSelection?: boolean;
    selectedClipId?: string | null;
    selectedRange?: { fromTick: number; toTick: number } | null;
  } = {},
): RoutedIntent {
  if (NEGATED_MUTATION_COMMAND.test(text)) {
    // The producer's OWN carve-out is in the sentence, so the sentence holds
    // both a change and an exception ("turn down the drums AND don't touch the
    // bass"). Applying either half is a guess, so the whole thing declines.
    //
    // What we CAN offer is the half that IS a command: the non-negated clause,
    // verbatim, as an executable prompt. The producer clicks it to choose —
    // that is a question, not a guess. (Measured 2026-10-19: the previous
    // suggestions here were PROSE — "state the change you want" — and the UI
    // rendered prose as clickable chips, so clicking one re-routed English
    // prose back into the router.)
    return {
      kind: "clarify",
      reason: "negated-mutation-command",
      suggestions: negatedClauseSuggestions(text),
    };
  }
  const ambiguousCommand = clarifyAmbiguousCommand(text, doc);
  if (ambiguousCommand) return ambiguousCommand;
  // A hypothetical or conditional question is not consent to mutate the
  // project (Would lowering the snare help? Should we add a bridge?). Catch
  // it before greedy effect/arrangement scanners. Polite direct commands
  // such as Could you lower the snare? remain eligible for normal routing.
  if (HYPOTHETICAL_ACTION_QUESTION.test(text)) {
    return {
      kind: "clarify",
      reason: "hypothetical-action-question",
      suggestions: ["apply a specific change", "compare a preview first"],
      // Prose, not commands — see the `clarify()` helper in
      // clarifyAmbiguousCommand for why the kind is declared.
      advice: ["apply a specific change", "compare a preview first"],
    };
  }
  // TRANSPORT — bare-word runtime commands ("stop", "play", "pauza",
  // "metronome on"). Anchored to the WHOLE text: "stop the beat" is a
  // generation prompt, never a transport command. Transport is runtime
  // service state — the panel dispatches straight to services.transport.
  const transportAction = parseTransportIntent(text);
  if (transportAction) {
    return { kind: "transport", action: transportAction };
  }
  // SAVE / EXPORT / RECORD — bare-word app commands ("save", "export wav",
  // "record", "stop recording"). Save flushes the autosave lifecycle,
  // export drives the async render+encode+download pipeline, record arms
  // the pattern recorder — runtime/persistence state, never document state.
  if (parseSaveIntent(text)) {
    return { kind: "save" };
  }
  const exportFormat = parseExportIntent(text);
  if (exportFormat) {
    return { kind: "export", format: exportFormat };
  }
  const recordIntent = parseRecordIntent(text);
  if (recordIntent) {
    return { kind: "record", arm: recordIntent.arm };
  }
  // STUDIO WORDS — groove/swing, gain automation ramps, markers. Unambiguous
  // command verbs (automate/groove/marker), so the gate is genre-only:
  // "more swing on a dark techno beat" is a generation prompt, not a groove
  // ask (a detected "bass" chip must NOT block "automate the bass volume").
  const studioPattern = parseIntentText(text);
  const studioGenreSignal = Boolean(
    studioPattern.input.genre || studioPattern.detected.some((chip) => chip.startsWith("♪")),
  );
  // An explicit creation verb plus a musical artifact noun means the user is
  // describing a new beat. Mixer vocabulary inside that brief must not be
  // mistaken for an edit to the current project.
  if (
    /^\s*(?:please\s+)?(?:generate|create|compose|write|make\s+me)\b[\s\S]*\b(?:beat|track|song|groove|instrumental)\b/i.test(
      text,
    )
  ) {
    return { kind: "pattern", input: studioPattern.input, detected: studioPattern.detected };
  }
  // SESSION CONTROL — undo/redo and read-only queries are the most-said
  // producer asks; they must not be gated on anything (a question is always
  // a question). Undo is bounded by the store; queries never mutate.
  const undoIntent = parseUndoIntent(text);
  if (undoIntent) {
    return { kind: "undoIntent", intent: undoIntent };
  }
  const checkpointIntent = parseCheckpointIntent(text);
  if (checkpointIntent) {
    return { kind: "checkpointIntent", intent: checkpointIntent };
  }
  const queryIntent = parseQueryIntent(text);
  const descriptiveTrackBrief =
    studioGenreSignal &&
    /^\s*give\s+(?:me\s+)?(?:the\s+)?track\b/.test(deaccent(text).toLowerCase()) &&
    /\b(?:atmosphere|vibe|sound|style|beat|groove)\b/.test(deaccent(text).toLowerCase());
  if (queryIntent && !descriptiveTrackBrief) {
    return { kind: "queryIntent", intent: queryIntent };
  }
  // A sequencer selection is an explicit musical context. Reuse Assist's
  // narrow parser here only when such a selection exists; the same language
  // without one remains an ordinary generation prompt.
  if (context.hasSelectedStepSelection) {
    const selectedStepIntent = parseSelectedStepIntent(text);
    if (selectedStepIntent) return { kind: "selectedStepAssist", intent: selectedStepIntent };
  }
  if (context.selectedClipId) {
    const ops = parseSelectedClipArrangeIntent(text, doc, context.selectedClipId);
    if (ops) return { kind: "selectedClipArrange", clipId: context.selectedClipId, ops };
    // AUDIO-CLIP FADE ("fade the selected clip over its final bar") — fades
    // live only on audio clips, so the same selection id is resolved against
    // arrangement.audioClips here; a scene-clip selection returns null and
    // the pattern-clip handling below stays authoritative. Executes through
    // the "clips" path (one undoable command, non-destructive).
    const audioFadeOps = parseSelectedAudioClipFadeIntent(text, doc, context.selectedClipId);
    if (audioFadeOps) return { kind: "clips", ops: audioFadeOps };
    const normalized = deaccent(text);
    if (
      /\b(?:selected|this|the|tomto|vybranom|vybrany|vybrana|vybrate)\s+(?:arrangement\s+)?(?:clip|klip\w*)\b/.test(
        normalized,
      ) &&
      /\b(?:swing\w*|groov\w*|humaniz\w*)\b/.test(normalized)
    ) {
      return {
        kind: "clarify",
        reason: "That selected-clip groove request is ambiguous or combines unsupported actions; nothing was changed.",
        suggestions: [
          "more swing on this selected clip",
          "less swing on this selected clip",
          "set swing to 60% on this selected clip",
        ],
      };
    }
  }
  if (context.selectedRange) {
    const operation = parseSelectedTimeRangeIntent(text);
    if (operation) return { kind: "selectedRangeArrange", range: context.selectedRange, operation };
  }
  // COMPLAINT — the listening loop ("drop pôsobí prázdno", "the lead is
  // harsh"): measured diagnosis + executable bounded proposals as clarify
  // chips. Nothing mutates until the user picks a chip.
  const complaintIntent = parseComplaintIntent(text);
  if (complaintIntent) {
    return { kind: "complaintIntent", intent: complaintIntent };
  }
  // P0 (semantic precision audit 2026-10-20): a DESCRIPTION is not a command.
  // "the bass is quieter than the lead" moved the bass fader and "the pads
  // have too much reverb" added MORE reverb, because the parsers match
  // direction words without sentence mood. The complaint route above still
  // gets first refusal; everything else declines here without mutating.
  if (isDescriptiveStatement(text)) {
    return {
      kind: "clarify",
      reason: "descriptive-not-a-command",
      suggestions: [],
      advice: ['Say what to change, for example "turn down the bass".'],
    };
  }
  // P2 (domain calibration 2026-10-20): a fully resolved EFFECT × KNOB ×
  // TARGET is more specific than a generic fader/tempo ask and must win.
  // Measured before this move: "much faster compressor attack on the drums"
  // changed the TEMPO, "lower filter cutoff on the lead" moved the LEAD FADER,
  // and "set compressor attack to 5 ms" hit the fader path. The param parser
  // already declines without all three of effect, role and target, so this
  // cannot capture a plain "turn down the bass".
  const paramIntent = parseParamIntent(text);
  if (paramIntent) {
    return { kind: "paramIntent", intent: paramIntent };
  }
  // A non-structural request that says the arrangement needs more or less
  // energy/density is a content revision. The noun "arrangement" alone must
  // not trigger auto-arrange when scenes exist.
  if (!studioGenreSignal && /\barrangement\b.{0,48}\b(?:needs?|could use|would benefit from)\b/.test(deaccent(text))) {
    const revise = parseReviseIntent(text);
    if (revise) return { kind: "revise", ...revise };
  }
  if (!studioGenreSignal) {
    // SECTION-SCOPED groove first ("more swing in the drop") — more specific
    // than the global groove ask; falls through to global when unscoped.
    const sectionGrooveIntent = parseSectionGrooveIntent(text);
    if (sectionGrooveIntent) {
      return { kind: "sectionGrooveIntent", intent: sectionGrooveIntent };
    }
    const grooveIntent = parseGrooveIntent(text);
    if (grooveIntent) {
      return { kind: "grooveIntent", intent: grooveIntent };
    }
    const automateIntent = parseAutomateIntent(text);
    if (automateIntent) {
      return { kind: "automateIntent", intent: automateIntent };
    }
    const markerIntent = parseMarkerIntent(text);
    if (markerIntent) {
      return { kind: "markerIntent", intent: markerIntent };
    }
    // STEP EDITS + SOUND SWAPS (Phase B) — drum-family nouns with explicit
    // position/swap verbs; the genre gate above keeps "remove the kick in a
    // dark techno beat" as a generation prompt.
    const stepEditIntent = parseStepEditIntent(text);
    if (stepEditIntent) {
      return { kind: "stepEditIntent", intent: stepEditIntent };
    }
    const soundSwapIntent = parseSoundSwapIntent(text);
    if (soundSwapIntent) {
      return { kind: "soundSwapIntent", intent: soundSwapIntent };
    }
  }
  if (doc.scenes.length > 0) {
    // CLIP-LEVEL ops first ("copy the intro clip to bar 5", "trim the clip
    // at bar 5 to 2 bars") — clip wording is more specific than scene
    // wording, and the arrange path would otherwise answer a clip copy with
    // a scene-variation duplicate. Clip ops keep ABSOLUTE positions (no
    // contiguous relayout).
    const clipOps = parseClipArrangeIntent(text, doc);
    if (clipOps) {
      return { kind: "clips", ops: clipOps };
    }
    const arrange = parseArrangeIntent(text, doc);
    if (arrange.ops.length > 0) {
      return { kind: "arrange", ops: arrange.ops, unrecognized: arrange.unrecognized };
    }
  }
  // CROSS-EXECUTOR COMPOUND ("zníž tempo a zvýš lead", "viac delayu na leade
  // a zníž basu", "mute the drums and zníž basu"): EVERY clause resolves on
  // its own (fader | tempo | effect | single exact plan) → execute them all
  // in ONE undoable command. This sits BEFORE the exact, fader, loudness and
  // tempo whole-text routes: those would otherwise partial-apply their half
  // of the sentence and silently drop the rest ("zníž tempo" winning while
  // "zvýš lead" vanishes; the fader's greedy target words swallowing "leade"
  // out of "delayu na leade"; an exact mute plan dropping the fader clause).
  // All-tempo clause sets stay with the tempo route (first-match-wins is the
  // honest reading of "tempo na 128 a pomalší"); partially parseable asks
  // fall to the clarification probe — a compound never silently drops what
  // it did not parse.
  const compound = parseCompoundIntent(text);
  if (compound) {
    return { kind: "compound", parts: compound };
  }
  // EXACT intents (master doc §4.1 — "prefer exact extraction first"):
  // explicit mixer commands with explicit targets/values ("mute the drums",
  // "pan the bass left 30", "transpose the lead up one octave", "add a bass
  // track", "rename the bass to sub"). Without this branch they fell through
  // to PATTERN GENERATION — an explicit "mute the drums" produced a new beat
  // instead of a mute. Exact runs before fader so "lower drums by 2 dB"
  // keeps its precise dB semantics over the ×0.82 vibe step; its vocabulary
  // is deliberately narrow (verb + target [+ number]), so prompts like
  // "dark techno at 140" never match.
  const exact = parseExactIntent(text);
  if (exact) {
    return { kind: "exact", plan: exact };
  }
  // SELECT — explicit track selection ("select the bass", "vyber bicie").
  // UI state (SelectionStore), not document state: no undo, no mutation.
  const selectTarget = parseSelectIntent(text);
  if (selectTarget) {
    return { kind: "select", target: selectTarget };
  }
  // PRESET — "load the Warm Sub preset on the bass". Requires the word
  // "preset" and an explicit target family. An unknown name is an EXPLICIT
  // presetUnknown route (with family suggestions) — never a silent fall
  // through to generation. Two guards keep that promise (D7): the bank can
  // be COLD (parsePresetIntent throws before warmFactoryPresets — the ask
  // becomes a clarify, not a beat), and a target-less ask clarifies the
  // family instead of silently generating new music.
  const lowerText = ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")} `;
  if (/\bpresets?\b/.test(lowerText) && /\b(?:load|apply|use|nacitaj|pouzi|nahraj)\b/.test(lowerText)) {
    let presetIntent: ReturnType<typeof parsePresetIntent> = null;
    let bankCold = false;
    try {
      presetIntent = parsePresetIntent(text);
    } catch {
      bankCold = true;
    }
    if (presetIntent) {
      if (presetIntent.ok) {
        return { kind: "preset", intent: presetIntent.intent };
      }
      return { kind: "presetUnknown", name: presetIntent.name, suggestions: presetIntent.suggestions };
    }
    if (bankCold) {
      return {
        kind: "clarify",
        reason: "preset-bank-cold",
        suggestions: [
          "preset banka sa ešte načítava — skús to o chvíľu",
          "preset bank is still warming up — try again",
        ],
        // Prose — the bank is warming up, there is no ask to run.
        advice: ["preset banka sa ešte načítava — skús to o chvíľu", "preset bank is still warming up — try again"],
      };
    }
    if (!/\b(?:on|to|na)\b/.test(lowerText)) {
      return {
        kind: "clarify",
        reason: "preset-target",
        suggestions: presetTargetSuggestions(text),
      };
    }
  }
  // SCENE INTENSITY — explicit "intensity/energy … N%" phrasing naming a
  // scene (P2-D remainder: kyx_sections intensity had no NL route).
  const sceneIntensity = parseSceneIntensityIntent(text, doc);
  if (sceneIntensity) {
    return { kind: "sceneIntensity", sceneName: sceneIntensity.sceneName, percent: sceneIntensity.percent };
  }
  const sendIntent = parseSendIntent(text);
  if (sendIntent) {
    return { kind: "sendIntent", intent: sendIntent };
  }
  // A reference to an EARLIER adjustment: resolve it through the session
  // ledger when possible; otherwise decline before any parser can apply the
  // phrase's own step as a guess.
  const priorAdjustment = resolvePriorAdjustment(text, doc);
  if (priorAdjustment) {
    if (priorAdjustment.kind === "clarify") return clarifyPriorReference(text, priorAdjustment.reason);
    if (priorAdjustment.kind === "effect") return { kind: "effectIntent", intent: priorAdjustment.intent };
    if (priorAdjustment.kind === "param") return { kind: "paramIntent", intent: priorAdjustment.intent };
    return priorAdjustment;
  }
  const fader = parseFaderIntent(text);
  if (fader) {
    return { kind: "fader", intent: fader };
  }
  // P1-A DOCUMENT-DERIVED TARGETS — the family tables are closed, the
  // document is open: an ask naming one of the USER'S OWN tracks ("turn
  // down the fx return bus") becomes a fader intent with pre-resolved ids.
  // Must sit BEFORE the loudness parser, which would otherwise claim
  // "lower the … by 2 db" as a master loudness nudge.
  const namedTrackFader = parseNamedTrackFaderIntent(text, doc);
  if (namedTrackFader) {
    return { kind: "fader", intent: namedTrackFader };
  }
  // A bare Slovak comparative is often a request to adjust an unspecified
  // track fader. Ask which track before the broader loudness parser treats
  // the word as a master-level loudness nudge. Full phrases such as
  // "urob to hlasnejšie" still route to loudness below.
  if (/^\s*hlasnejsie(?:\s+prosim)?\s*[.!]?\s*$/i.test(deaccent(text))) {
    const clarification = declinedFaderClarification(text);
    if (clarification) {
      return { kind: "clarify", reason: clarification.reason, suggestions: clarification.suggestions };
    }
  }
  const loudness = parseLoudnessIntent(text);
  if (loudness) {
    return { kind: "loudness", parse: loudness };
  }
  const tempo = parseTempoIntent(text);
  const creativeBriefWithMoodTempo =
    /^\s*(?:make\s+me|create|generate|compose|write)\s+(?:a|an|the)?[\s\S]{0,100}\b(?:beat|track|song|groove|instrumental)\b/i.test(
      text,
    ) && !/\b(?:set|lock|fix|hold|change)\s+(?:the\s+)?tempo\b/i.test(text);
  if (tempo && !creativeBriefWithMoodTempo) {
    return { kind: "tempo", intent: tempo };
  }
  const popVibe = parsePopIntent(text);
  if (popVibe) {
    return { kind: "production", intent: popVibe };
  }
  // SEND / BYPASS — mixer-routing asks with their own explicit vocabulary
  // ("more reverb send on the lead", "bypass the delay on the lead"). These
  // MUST parse before the effectIntent: its greedy effect×target read would
  // otherwise claim "more reverb send on the lead" as a return-MIX knob ask
  // — a completely different parameter from the send level.
  const bypassIntent = parseBypassIntent(text);
  if (bypassIntent) {
    return { kind: "bypassIntent", intent: bypassIntent };
  }
  // PARAM-LEVEL (param wave P1): a NAMED KNOB beats the primary-knob path —
  // "set delay time to 375 ms", "dlhší chvost na reverbe" address the exact
  // param instead of turning the effect's primary knob. This is the SAME
  // parse that now runs early (above), so a param ask cannot be stolen by
  // tempo/fader/send on the way here.
  const effectIntent = parseEffectIntent(text);
  const normalizedEffectText = deaccent(text).toLowerCase();
  const hasExplicitEffectVerb =
    /\b(?:add|apply|insert|remove|take out|less|more|reduce|ease off|pull|turn down|bypass|disable|increase|decrease|set)\b.{0,32}\b(?:reverb|delay|echo|chorus|compress(?:ion|or)?|saturat\w*|sidechain|pump|eq|bass.?harmon|koren|harmonik)\b/.test(
      normalizedEffectText,
    ) ||
    /\b(?:reverb|delay|echo|chorus|compress(?:ion|or)?|saturat\w*|sidechain|pump|eq|bass.?harmon|koren|harmonik)\b.{0,32}\b(?:less|more|reduce|ease off|pull back|turn down|bypass|disable|increase|decrease)\b/.test(
      normalizedEffectText,
    );
  if (effectIntent && (!studioGenreSignal || hasExplicitEffectVerb)) {
    return { kind: "effectIntent", intent: effectIntent };
  }
  // Genre signal flips production words into generation-time FX ("wobbly
  // drill" GENERATES with the mangler) — same rule as the GENERATE path.
  const pattern = parseIntentText(text);
  const genreSignal = Boolean(pattern.input.genre || pattern.detected.some((chip) => chip.startsWith("♪")));
  const sectionRequests = parseSectionRequests(text);
  // STRUCTURAL ARRANGEMENT COMMANDS before content revises — "add a fill
  // before every chorus" is an arrangement statement, not a slider move.
  const sectionTransition = parseSectionTransitionIntent(text);
  if (sectionTransition) {
    return { kind: "sectionTransition", ...sectionTransition };
  }
  const sectionFlow = parseSectionFlowIntent(text);
  if (sectionFlow && sectionRequests?.scopedFx.length) {
    return {
      kind: "clarify",
      reason: "A section can be changed in one audition-first operation at a time.",
      suggestions: ["Set the section's lead flow", "Set the section's sound/FX"],
    };
  }
  if (sectionFlow) {
    return { kind: "sectionFlow", ...sectionFlow };
  }
  if (!genreSignal && sectionRequests?.scopedFx.length) {
    if (sectionRequests.requests.length > 0 || sectionRequests.scopedFx.length > 1) {
      return {
        kind: "clarify",
        reason: "Apply one section-scoped sound change at a time; mixed structure and FX edits are not combined yet.",
        suggestions: ["Apply the section sound change", "Change the song structure"],
      };
    }
    const [scoped] = sectionRequests.scopedFx;
    if (scoped) {
      return {
        kind: "sectionProduction",
        targetRole: scoped.role,
        intent: scoped.fx,
        detected: [`${scoped.role} §`, ...scoped.fx.goals.map((goal) => goal.concept)],
      };
    }
  }
  if (!genreSignal) {
    const production = parseProductionIntent(text);
    if (production && namesProductionTarget(text)) {
      return { kind: "production", intent: production };
    }
  }
  // MIX only when the text actually PARSED into a mix decision. isMixIntentText
  // alone is not enough: nouns it merely matches on ("delay", "compression",
  // "eq") have no parseMixIntent branch, so a request like "more delay on the
  // trumpets" reached the mix executor with EMPTY overrides — and the profile
  // planner then applied its genre/energy defaults (house + energy 0.7 ⇒ a
  // sidechain pump on bass+chords) that the user never asked for. No detected
  // decision ⇒ fall through to the clarification probe / generation below.
  if (isMixIntentText(text)) {
    const mix = parseMixIntent(text);
    // D8 (owner decision 2026-10-11, "genre wins"): inside a genre prompt a
    // TONE comparative is a descriptive adjective — "darker techno at 130"
    // generates a darker beat, it does not re-EQ existing tracks. Explicit
    // mix NOUNS (reverb/punch/pump — a direct object ask) still route to mix
    // even with a genre signal, and a bare comparative without a genre keeps
    // the legacy mix route.
    const toneOnly = mix.detected.length > 0 && mix.detected.every((entry) => entry.endsWith("tone"));
    if (mix.detected.length > 0 && !(genreSignal && toneOnly)) {
      return { kind: "mix", overrides: mix.overrides, detected: mix.detected };
    }
  }
  if (!genreSignal) {
    const revise = parseReviseIntent(text);
    if (revise) {
      return { kind: "revise", ...revise };
    }
  }
  // CLARIFICATION LAYER: the text looks like a DECLINED intent (conflicting
  // fader directions, a direction without a target, an effect ask whose
  // track/parameter the engine cannot resolve). Offer the nearest EXECUTABLE
  // interpretations instead of silently falling to generation. Only when the
  // text carries NO genre/beat signal — anything that parses as a prompt
  // stays a prompt.
  if (!genreSignal && pattern.detected.length === 0) {
    const clarification =
      declinedParamIntentClarification(text, doc) ??
      declinedFaderClarification(text) ??
      declinedEffectClarification(text);
    if (clarification) {
      return { kind: "clarify", reason: clarification.reason, suggestions: clarification.suggestions };
    }
    // TYPO LAYER — "mut the drums" is one edit from a command verb. Offer the
    // corrected sentence ONLY when the fix actually parses into an
    // executable intent (re-routed here must land non-pattern); offer-only,
    // never auto-executed. Recursion is bounded: each correction fixes one
    // token into a vocabulary verb, which is never corrected again.
    for (const candidate of typoCorrections(text)) {
      const corrected = routeIntentText(candidate, doc);
      if (corrected.kind !== "pattern" && corrected.kind !== "clarify") {
        return { kind: "clarify", reason: `did you mean "${candidate}"?`, suggestions: [candidate] };
      }
    }
  }
  return { kind: "pattern", input: pattern.input, detected: pattern.detected };
}
