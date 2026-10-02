import type { RoutedIntent } from "./route";
import type { IntentInput } from "./types";

const MUSICAL_OBJECT =
  /\b(?:beat|instrumental|song|melody|groove|loop|music|hook|chorus|verse|vocal|vocals|vocalist|sing|singer|spev|hlas|type[- ]?beat|drums?|bass|chords?|lead|kick|hats?|808)\b/;
const COMPOSITION_VERB =
  /\b(?:create|generate|compose|build|write|produce|sprav(?:i|te)?|urob(?:i|te)?|vytvor(?:i|te)?|zloz(?:i|te)?|skladaj|napis(?:i|te)?)\b|\bmake\s+(?:me|us|a|an|some|another)\b/;
const ACTION_VERB =
  /\b(?:mute|solo|delete|remove|move|copy|duplicate|rename|select|load|bypass|export|save|record|transpose|pan|set|turn|lower|raise|increase|decrease|automate|insert|ease|park|shove|calm|tame|nudge|pull|push|lift|drop|stis(?:i|te)?|zni[zž](?:i|te)?|zv[yý]s(?:i|te)?|odstr[aá]n(?:i|te)?|pres[uú]n(?:i|te)?|premenuj|vyber|na[cč][ií]taj|vypni|zapni|oto[cč](?:i|te)?|pos[uú]n(?:i|te)?|pridaj|uber|zme[nň](?:i|te)?)\b/;
const EDIT_COMPARATIVE =
  /\b(?:louder|quieter|softer|darker|brighter|wider|narrower|warmer|colder|drier|wetter|punchier|harder|energetic|energic|busier|denser|sparser|hlasnejsi|tichsi|tmavsi|svetlejsi|sirsi|uzsi|teplejsi|suchsi|mokrejsi|razantnejsi|hustejsi|riedsi|energickejsi)\b/;
const VOCAL_CONTEXT =
  /\b(?:for|under|over|around|space|room|leave|leaves|sing|vocal|vocals|vocalist|singer|spev|hlas|pod|pre|miesto|priestor|spev[aá]k|spev[aá]ck)\b/;

function normalizedText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function hasStructuredCreativeBrief(input: IntentInput): boolean {
  return Boolean(
    input.genre ||
    input.style ||
    input.artist ||
    input.key ||
    input.bpmRange ||
    input.length ||
      input.fx,
  );
}

/**
 * The local LFM action model is allowed to interpret editor commands, not
 * creative briefs. A pattern route with parsed musical fields is already a
 * creative request; obvious natural-language composition/vocal requests are
 * protected too, even when the deterministic parser extracts no fields.
 */
export function isCreativeBriefRoute(text: string, route: RoutedIntent): boolean {
  // Resolver tests and some internal callers pass serialized model fixtures
  // as the instruction; those are not user-facing creative briefs.
  if (/^\s*[\[{]/.test(text)) return false;

  const normalized = normalizedText(text);
  const hasMusicalObject = MUSICAL_OBJECT.test(normalized);
  const hasActionVerb = ACTION_VERB.test(normalized);
  if (route.kind === "pattern") {
    if (hasStructuredCreativeBrief(route.input)) return true;
    if ((route.input.roles || route.input.preserve) && !hasActionVerb && !EDIT_COMPARATIVE.test(normalized)) return true;
  }
  if (!hasMusicalObject) return false;

  // A creation verb wins over generic music nouns, except an unmistakable
  // comparative edit such as “make the beat louder”.
  if (COMPOSITION_VERB.test(normalized) && !EDIT_COMPARATIVE.test(normalized)) return true;

  // Singer-led prompts are often indirect (“something I can sing over”);
  // keep them out of the action schema even without “make me a beat”.
  if (VOCAL_CONTEXT.test(normalized) && !hasActionVerb) return true;

  // Music nouns alone are enough to classify an otherwise non-command brief.
  return !hasActionVerb && !EDIT_COMPARATIVE.test(normalized);
}

/** True only for the unmatched route where a command model could be useful. */
export function shouldTryActionModelFallback(text: string, route: RoutedIntent): boolean {
  return route.kind === "pattern" && !isCreativeBriefRoute(text, route);
}
