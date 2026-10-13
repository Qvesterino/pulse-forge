import type { RoutedIntent } from "./route";
import type { IntentInput } from "./types";

const MUSICAL_OBJECT =
  /\b(?:beat|instrumental|song|melody|groove|loop|music|hook|chorus|verse|vocal|vocals|vocalist|sing|singer|spev|hlas|type[- ]?beat|drums?|bass|chords?|lead|kick|hats?|808)\b/;
const COMPOSITION_VERB =
  /\b(?:create|generate|compose|build|write|produce|sprav(?:i|te)?|urob(?:i|te)?|vytvor(?:i|te)?|zloz(?:i|te)?|skladaj|napis(?:i|te)?)\b|\bmake\s+(?:me|us|a|an|some|another)\b/;
const ACTION_VERB =
  /\b(?:mute|solo|unmute|unsolo|delete|remove|move|copy|duplicate|rename|select|load|bypass|export|save|record|transpose|pan|set|turn|lower|raise|increase|decrease|automate|insert|fix|ease|park|shove|calm|tame|nudge|pull|push|lift|drop|stis(?:i|te)?|zni[zž](?:i|te)?|zv[yý]s(?:i|te)?|odstr[aá]n(?:i|te)?|pres[uú]n(?:i|te)?|premenuj|vyber|na[cč][ií]taj|vypni|zapni|oto[cč](?:i|te)?|pos[uú]n(?:i|te)?|pridaj|uber|zme[nň](?:i|te)?)\b/;
const EDIT_COMPARATIVE =
  /\b(?:louder|quieter|softer|darker|brighter|wider|narrower|warmer|colder|drier|wetter|punchier|harder|energetic|energic|busier|denser|sparser|metallic|grittier|crunchy|robotic|deeper|lofi|vinyl|dominant|prominent|subdued|subtle|tucked|hlasnejsi|tichsi|tmavsi|svetlejsi|sirsi|uzsi|teplejsi|suchsi|mokrejsi|razantnejsi|hustejsi|riedsi|energickejsi)\b/;
const VOCAL_CONTEXT =
  /\b(?:for|under|over|around|space|room|leave|leaves|sing|vocal|vocals|vocalist|singer|spev|hlas|pod|pre|miesto|priestor|spev[aá]k|spev[aá]ck)\b/;
const ACTION_SOUND_OBSERVATION =
  /\b(?:can't|cannot)\s+feel\s+(?:the\s+)?(?:kick|bass|drums?|lead|chords?|808)\b|\b(?:could use|needs?|lacks?|has|have|is|are|sounds?|feels?|sit|sits|znie|posobi|su|je|ma|prehlus\w*|overpowers?|dominates?|drowns? out|disappears?|vanishes?)\b.{0,40}\b(?:boomy|woolly|muddy|cloudy|glassy|hollow|thin|harsh|sharp|piercing|brittle|shrill|weak|weightless|lightweight|impact|punch|weight|empty|energy|dominant|prominent|subdued|upfront|forward|buried|lost|under|underneath|overwhelming|too much level|(?:more|too much) body up front|too loud|loud|back|prilis|vpredu|zanika|uder|zahmlen\w*)\b|\b(?:kick|bass|drums?|lead|chords?|808|kopak|basa|bicie)\b.{0,28}\b(?:overpowers?|dominates?|drowns? out|disappears?|vanishes?|gets? lost|zanika|reze|prehlus\w*|prekriku\w*|nema|chyba|straca)\b/i;
const READ_ONLY_QUERY =
  /^(?:(?:what|which|how many|where|give me)\b.{0,80}\b(?:tempo|bpm|pulse|tonic|key|scale|tonal center|harmonic home|tracks?|lanes?|channels?|markers?|effects?|plugins?|processors?|devices?|groove|swing|change|action)\b|(?:tell me|identify|report|count|list|name)\b.{0,80}\b(?:tempo|bpm|pulse|tonic|key|scale|tonal center|harmonic home|tracks?|lanes?|channels?|markers?|effects?|plugins?|processors?|devices?|groove|swing|change|action)\b)/i;
const PRESET_LOOKUP =
  /\b(?:give|get|find|choose|pick)\s+(?:me|us|the|a|an|that)?\s*[^.]{0,32}\b(?:preset|patch|sound|tone|kit)\b/;
const SETTING_EDIT =
  /\b(?:more|less|add|remove|increase|decrease|turn up|turn down)\s+(?:reverb|delay|saturation|distortion|chorus|flanger|phaser|tremolo|bitcrusher|compress(?:ion|or)?|sidechain|pump|eq|filter)\b|\b(?:reverb|delay)\s+send\b/;
const ADD_TRACK_COMMAND = /\badd\b.{0,32}\b(?:tracks?|instrument)\b/;
const EXISTING_SOUND_EDIT =
  /\b(?:make|let|help)\s+(?:the|my|this|that)?\s*(?:low end|sub|bass|drums?|lead|chords?)\b.{0,28}\b(?:feel|sound|sit|land|hit|warmer|darker|brighter|wider|grittier|metallic|crunchy|robotic|deeper|punchier|lofi)\b/;

function normalizedText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function hasStructuredCreativeBrief(input: IntentInput): boolean {
  return Boolean(input.genre || input.style || input.artist || input.key || input.bpmRange || input.length || input.fx);
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
  if (
    PRESET_LOOKUP.test(normalized) ||
    SETTING_EDIT.test(normalized) ||
    ADD_TRACK_COMMAND.test(normalized) ||
    EXISTING_SOUND_EDIT.test(normalized)
  )
    return false;

  // An explicit composition request is stronger than incidental parser
  // matches such as “bass” being read as a generation role.
  if (COMPOSITION_VERB.test(normalized) && hasMusicalObject) return true;

  // Read-only questions remain eligible even when they mention instruments,
  // tracks, or other music nouns that also occur in creative briefs.
  if (READ_ONLY_QUERY.test(normalized)) return false;

  // Natural-language observations can express a bounded mixer action or a
  // listening-loop complaint without using an imperative verb.
  if (ACTION_SOUND_OBSERVATION.test(normalized)) return false;

  // A well-formed musical brief already carries stronger evidence than an
  // incidental edit verb inside the same sentence (“dark trap, remove hats”).
  if (route.kind === "pattern" && hasStructuredCreativeBrief(route.input)) return true;

  // Clear edit verbs take precedence over incidental parser fields.
  if (hasActionVerb || EDIT_COMPARATIVE.test(normalized)) return false;

  if (route.kind === "pattern") {
    if (route.input.roles || route.input.preserve) return true;
  }
  if (!hasMusicalObject) return false;

  // Singer-led prompts are often indirect (“something I can sing over”);
  // keep them out of the action schema even without “make me a beat”.
  if (VOCAL_CONTEXT.test(normalized)) return true;

  // Music nouns alone are enough to classify an otherwise non-command brief.
  return true;
}

/** True only for the unmatched route where a command model could be useful. */
export function shouldTryActionModelFallback(text: string, route: RoutedIntent): boolean {
  return route.kind === "pattern" && !isCreativeBriefRoute(text, route);
}
