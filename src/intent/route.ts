import type { ProjectDocument, SceneRole } from "../project-model/types";
import { parseArrangeIntent, parseClipArrangeIntent, type ArrangeOp, type ClipArrangeOp } from "./arrangeWords";
import { parseIntentText, type ParsedIntent } from "./text-parser";
import { parseEffectIntent, parseSendIntent, parseBypassIntent } from "./mix";
import { parseLoudnessIntent } from "./loudness";
import { parseFaderIntent, parseTempoIntent, parsePopIntent, type FaderIntent, type TempoIntent } from "./conversation";
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
  parseGrooveIntent,
  parseMarkerIntent,
  parseQueryIntent,
  parseSectionGrooveIntent,
  parseUndoIntent,
  type AutomateIntent,
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
  /\breverb\b|\bdelay\b|\bcompress(?:ion|or)?\b|\bsaturat|\bpunch(?:ier|y)?\b|\bsidechain\b|\bpump\b|\bdry\b|\bdrier\b|\bwet\b|\bwetter\b|\beq\b|\bmix\b|\bdozvuk|\bozven|\bkompres|\bsaturac|\bpump|\bsuch/;
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
  } else if (/\bmore reverb\b|\bwetter\b|\bwet (?:it )?up\b|\bmokrejs|\bviac (?:dozvuk|ozven)/.test(lower)) {
    overrides.reverb = "more";
    detected.push("more reverb");
  } else if (
    /\bless reverb\b|\bdrier\b|\bdry (?:it )?up\b|\bmake it drier\b|\bsuch|\bmenej (?:dozvuk|ozven)/.test(lower)
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

  if (/\bpunch(?:ier|y)?\b|\bmore punch\b|\btighter\b|\brazantnejsi|\brazant/.test(lower)) {
    overrides.punch = "more";
    detected.push("more punch");
  } else if (/\bsofter (?:drums|mix|hit)\b|\bmenej razant/.test(lower)) {
    overrides.punch = "less";
    detected.push("softer");
  }

  if (
    /\bno pump\b|\bwithout (?:pump|sidechain)\b|\bbez pumpy/.test(lower) ||
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

const REVISE_ENERGY_MORE = /\bmore (?:energetic|energic|energy)\b|\benergickejsi\b|\bviac (?:energie|energicky)\b/;
const REVISE_ENERGY_LESS = /\bless (?:energetic|energic|energy)\b|\bcalmer\b|\bmenej (?:energie|energicky)\b/;
const REVISE_DENSITY_MORE = /\b(?:more )?(?:busier|denser)\b|\bhustejsi\b|\bviac prvkov\b/;
const REVISE_DENSITY_LESS = /\bsparser\b|\bless busy\b|\bmenej hust/;

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
  | { kind: "complaintIntent"; intent: ComplaintIntent }
  | { kind: "queryIntent"; intent: QueryIntent }
  | { kind: "grooveIntent"; intent: GrooveIntent }
  | { kind: "sectionGrooveIntent"; intent: SectionGrooveIntent }
  | { kind: "automateIntent"; intent: AutomateIntent }
  | { kind: "markerIntent"; intent: MarkerIntent }
  | { kind: "stepEditIntent"; intent: StepEditIntent }
  | { kind: "soundSwapIntent"; intent: SoundSwapIntent }
  | { kind: "select"; target: ExactTarget }
  | { kind: "preset"; intent: PresetIntent }
  | { kind: "presetUnknown"; name: string; suggestions: string[] }
  | { kind: "sendIntent"; intent: SendIntent }
  | { kind: "bypassIntent"; intent: BypassIntent }
  | { kind: "clarify"; reason: string; suggestions: string[] }
  | { kind: "tempo"; intent: TempoIntent }
  | { kind: "effectIntent"; intent: EffectIntent }
  | { kind: "loudness"; parse: { direction: "louder" | "quieter"; targetDb?: number; detected: string[] } }
  | { kind: "production"; intent: ProductionIntent }
  | { kind: "mix"; overrides: MixOverrides; detected: string[] }
  | ({ kind: "sectionFlow" } & SectionFlowParse)
  | { kind: "sectionProduction"; targetRole: SceneRole; intent: ProductionIntent; detected: string[] }
  | {
      kind: "revise";
      attribute: ReviseAttribute;
      direction: ReviseDirection;
      detected: string[];
      targetRole: string | null;
    }
  | { kind: "pattern"; input: ParsedIntent["input"]; detected: string[] };

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
export function routeIntentText(text: string, doc: ProjectDocument): RoutedIntent {
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
  // SESSION CONTROL — undo/redo and read-only queries are the most-said
  // producer asks; they must not be gated on anything (a question is always
  // a question). Undo is bounded by the store; queries never mutate.
  const undoIntent = parseUndoIntent(text);
  if (undoIntent) {
    return { kind: "undoIntent", intent: undoIntent };
  }
  const queryIntent = parseQueryIntent(text);
  if (queryIntent) {
    return { kind: "queryIntent", intent: queryIntent };
  }
  // COMPLAINT — the listening loop ("drop pôsobí prázdno", "the lead is
  // harsh"): measured diagnosis + executable bounded proposals as clarify
  // chips. Nothing mutates until the user picks a chip.
  const complaintIntent = parseComplaintIntent(text);
  if (complaintIntent) {
    return { kind: "complaintIntent", intent: complaintIntent };
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
  // through to generation.
  const presetIntent = parsePresetIntent(text);
  if (presetIntent) {
    if (presetIntent.ok) {
      return { kind: "preset", intent: presetIntent.intent };
    }
    return { kind: "presetUnknown", name: presetIntent.name, suggestions: presetIntent.suggestions };
  }
  const fader = parseFaderIntent(text);
  if (fader) {
    return { kind: "fader", intent: fader };
  }
  const loudness = parseLoudnessIntent(text);
  if (loudness) {
    return { kind: "loudness", parse: loudness };
  }
  const tempo = parseTempoIntent(text);
  if (tempo) {
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
  const sendIntent = parseSendIntent(text);
  if (sendIntent) {
    return { kind: "sendIntent", intent: sendIntent };
  }
  const bypassIntent = parseBypassIntent(text);
  if (bypassIntent) {
    return { kind: "bypassIntent", intent: bypassIntent };
  }
  const effectIntent = parseEffectIntent(text);
  if (effectIntent) {
    return { kind: "effectIntent", intent: effectIntent };
  }
  // Genre signal flips production words into generation-time FX ("wobbly
  // drill" GENERATES with the mangler) — same rule as the GENERATE path.
  const pattern = parseIntentText(text);
  const genreSignal = Boolean(pattern.input.genre || pattern.detected.some((chip) => chip.startsWith("♪")));
  const sectionRequests = parseSectionRequests(text);
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
    if (mix.detected.length > 0) {
      return { kind: "mix", overrides: mix.overrides, detected: mix.detected };
    }
  }
  const revise = parseReviseIntent(text);
  if (revise) {
    return { kind: "revise", ...revise };
  }
  // CLARIFICATION LAYER: the text looks like a DECLINED intent (conflicting
  // fader directions, a direction without a target, an effect ask whose
  // track/parameter the engine cannot resolve). Offer the nearest EXECUTABLE
  // interpretations instead of silently falling to generation. Only when the
  // text carries NO genre/beat signal — anything that parses as a prompt
  // stays a prompt.
  if (!genreSignal && pattern.detected.length === 0) {
    const clarification = declinedFaderClarification(text) ?? declinedEffectClarification(text);
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
