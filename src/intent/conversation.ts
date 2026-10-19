/**
 * CONVERSATION INTENTS — the producer speaks plain language (GOAL 38).
 *
 * Three everyday requests that used to need the Mixer or the transport:
 *
 *   "zníž basu" / "turn down the bass"   → track FADER (real gain change)
 *   "zníž tempo" / "na 128" / "pomalší"  → project BPM
 *   "popovejšie" / "more pop"            → bright + punchy composite (vibe)
 *
 * Detection rules: a FADER needs BOTH a direction stem and a target noun
 * ("zníž" alone is ambiguous), a TEMPO needs a tempo word, and the POP vibe
 * is its own phrase family ("pop" alone stays a genre word in generation).
 * All detection runs on DE-ACCENTED lowercase — SK stems are written without
 * diacritics on purpose (see text-parser gotcha): "zníž" is detected by the
 * stem "zniz", never by the accented form.
 *
 * Application helpers return undoable Commands; the panel executes them and
 * reports. Never throws.
 */
import type { Command } from "../commands/types";
import { setBpm, setMasterConfig, setPadParams, setReturnGain, setTrackParams, snapshot } from "../commands/commands";
import { parsePercent, parsePercentAllowingZero } from "./percent";
import { calibrateFaderFactor, degreeToFaderAmount, parseDegree, type Degree } from "./degree";
import { intentCarriesGenreSignal } from "./exact";
import { inferPadRole } from "../ai/pad-roles";
import type { DrumTrack, ProjectDocument } from "../project-model/types";
import { MAX_BPM, MIN_BPM } from "../project-model/schema";
import type { ProductionIntent, ProductionTarget } from "./production";
import type { DeclinedIntentClarification } from "./mix";

// ── FADER ("zníž basu", "hlasnejšie bicie", "turn down the drums") ──────────

/**
 * P1-A (control-surface audit 2026-10-13): "vocal" joins the closed family
 * set. Semantics mirror mix.ts MixTarget everywhere: a NAMED vocal track
 * wins; otherwise the tracks carrying the singer's takes (audio-clip
 * bindings), never a positional guess.
 */
export type FaderTarget = "drums" | "bass" | "chords" | "lead" | "vocal" | "master";

/** Per-PAD families inside the drum track ("kick ťažší", "haty tichšie"). */
export type FaderPadFamily = "kick" | "snare" | "clap" | "hat" | "perc" | "tom";

export type FaderAmount = "subtle" | "normal" | "big" | "full";

export interface FaderIntent {
  targets: FaderTarget[];
  /** Per-PAD families ("kick ťažší") — empty when the intent is track-level. */
  pads?: FaderPadFamily[];
  /**
   * P1-A document-derived targets (control-surface audit 2026-10-13): LIVE
   * track ids resolved at route time from the user's own track names (the
   * text named them; `parseNamedTrackFaderIntent` matched them against the
   * document). Applied like any family target — same clamp, same fold, one
   * undo step — and named in the label by their document names.
   */
  trackIds?: string[];
  /**
   * P2-D remainder (parity sweep): return-bus faders ("reverb return to
   * -6 dB"). Same route-time resolution contract as trackIds — the ids are
   * matched against the live `doc.returns` and folded through setReturnGain.
   */
  returnIds?: string[];
  /**
   * "down"/"up" move the fader RELATIVE; "set" is ABSOLUTE — percent IS the
   * gain as a fraction of the fader's own range (0..1.5, so 50% = 0.75).
   */
  direction: "down" | "up" | "set";
  /** Fader step size. Default "normal" (×0.82 down / ×1.22 up). Unused for "set". */
  amount?: FaderAmount;
  /**
   * Explicit percent ("o 10 %") — relative gain change in the parsed
   * direction (up ×1.10 / down ×0.90). For direction "set" it is the
   * absolute target level. Wins over vibe `amount` when present.
   */
  percent?: number;
  /**
   * The resolved graduated degree (intent/degree.ts) when the ask NAMED one.
   * Absent for an unqualified ask, which keeps the documented default.
   *
   * `amount` stays the coarse, schema-pinned bucket (the model classes and
   * tests read it); `degree` is the fine-grained magnitude the fold actually
   * calibrates from. Both are produced from the same vocabulary in one call,
   * so they cannot disagree — see `faderDegree`.
   */
  degree?: Degree;
}

/** ALL SK stems DE-ACCENTED — the parser strips diacritics before matching. */
const FADER_DOWN =
  /\bzniz|\bstis|\bstiah\w*|\bnizs|\btahaj dole|\bdaj dole|\btichs|\bdole\b|\bturn down\b|\bpull down\b|\bbring down\b|\blower\b|\bdial down\b|\bquieter\b|\bquiet down\b|\b(?:take|bring|pull|turn|dial|drop)\b.{0,36}\bdown\b|\bdrop\b.{0,24}\b(?:level|volume|fader)\b|\b(?:less|fewer|menej)\b.{0,28}\b(?:room|space|presence|dominant|prominent|forward|pronounced|vyrazn\w*|vystupujuc\w*)\b|\b(?:too|overly|prilis)\b.{0,20}\b(?:dominant|forward|prominent|vyrazn\w*)\b|\bmore\b.{0,20}\bsubdued\b|\b(?:in|into|do|v)\s+(?:the\s+)?(?:background|pozadi|uzadia)\b|\b(?:recede|recedes|receding|ease back|sit back|sit behind|ustup\w*|zazit do pozadia)\b|\bease\b.{0,36}\bback\b|\bsit\b.{0,24}\b(?:behind|beneath|under(?:neath)?)\b|\btuck\b.{0,36}\b(?:under(?:neath)?|back|down)\b/;
/**
 * COMPARATIVE DOWN ("even less", "still less", "ešte menej") — a FURTHER
 * relative step, not a repeat of an absolute target. The existing `less` rule
 * only fired when the sentence named a mix noun ("less room", "less
 * presence"), so a bare "make it even less" — or a bare repeat,
 * "a little less again" — matched no direction stem at all and fell through
 * to generation. The fader still needs a target noun after it ("even less
 * BASS"), so this cannot make a target-less sentence mutate.
 *
 * The REPEAT form is another phrasing of the same intent, not a memory
 * feature: "a little less again" asks for the same step again, which the
 * degree ladder already expresses. "half as much as LAST TIME" would need
 * real conversation memory (what the previous delta actually was) and is
 * deliberately NOT faked here — that still declines rather than guessing a
 * percentage of the range.
 */
const FADER_DOWN_COMPARATIVE =
  /\b(?:even|still)\s+(?:less|fewer|menej)\b|\beste\s+menej\b|\b(?:less|fewer|menej)\b.{0,16}\b(?:again|once more|znova|znovu)\b/;
/**
 * COMPARATIVE UP ("even more", "still more") — the mirror of
 * FADER_DOWN_COMPARATIVE. Bare "more" is deliberately NOT an up stem (it is
 * also the voice of "more reverb", "more sub", "more punch"), so the
 * comparative only resolves when it is qualified. Kept OUT of
 * FADER_UP_DIRECTIONAL on purpose: a qualified "even more" next to a down stem
 * is a soft follow-up, not the hard conflict that must decline.
 */
const FADER_UP_COMPARATIVE = /\b(?:even|still)\s+more\b|\beste\sviac\b/;
const FADER_UP =
  /\bzvis\b|\bzvys|\bvyss\b|\btazs\w*|\bpotiahni hore|\btahaj hore|\bdaj hore|\bhlasnej|\bhlasit|\bhore\b|\bturn up\b|\bbring up\b|\braise\b|\blift\b|\bpush up\b|\blouder\b|\b(?:bring|turn|push|move)\b.{0,36}\bup\b|\btake\b.{0,36}\bup\b(?!\s+(?:less|fewer)\b)|\b(?:bring|move|push)\b.{0,28}\bforward\b|\bcloser\b.{0,24}\b(?:front|foreground)\b/;
const SK_ADD_FADER = /\bpridaj\s+(?:(?:hlasitos\w*|volume)\s+)?(?:bas\w*|lead\w*|master\w*|bic\w*)\b/;
/** UP stems that unambiguously name a direction (loud-words excluded). */
const FADER_UP_DIRECTIONAL =
  /\bzvis\b|\bzvys|\bvyss\b|\btazs\w*|\bpotiahni hore|\btahaj hore|\bdaj hore|\bhore\b|\bturn up\b|\bbring up\b|\braise\b|\bpush up\b|\blouder\b|\b(?:bring|turn|push|move)\b.{0,36}\bup\b|\btake\b.{0,36}\bup\b(?!\s+(?:less|fewer)\b)|\bpridaj\s+(?:(?:hlasitos\w*|volume)\s+)?(?:bas\w*|lead\w*|master\w*|bic\w*)\b|\b(?:bring|move|push)\b.{0,28}\bforward\b/;

const FADER_TARGETS: ReadonlyArray<readonly [RegExp, FaderTarget]> = [
  [/\bbas(?:u|e|y|ov|om)?\b|\bbass\w*|\b808\w*/, "bass"],
  [/\bbic(?:i|ie|ich)?\b|\bbubn\w*|\bdrums?\b|\bbeat\b/, "drums"],
  [/\bklaves|\bakord\w*|\bchords?\b|\bkeys\b|\bpadov?\b/, "chords"],
  [/\blead\w*\b|\bmelodi\w*|\bsynth\w*\b/, "lead"],
  // "vocal" — but never the volume NOUN/ADJECTIVE ("hlasnejšie", "hlasitosť"
  // are loud-words, not the voice; the lookahead keeps "zníž hlasitosť basu"
  // a BASS ask). Deaccented SK: spev/hlas/vokal.
  [/\bvocals?\b|\bvox\b|\bvokal\w*|\bspev\w*|\bhlas(?!nej|it|ilo)\w*/, "vocal"],
  [
    /\bmaster\w*|\bvsetk\w*|\bcely (?:mix|beat)\b|\beverything\b|\bwhole (?:mix|beat)\b|\bmaster (?:fader|gain)\b/,
    "master",
  ],
];

/** Track mentions inside a comparison describe a reference, not an edit target. */
const FADER_REFERENCE_CLAUSE =
  /\b(?:behind|beneath|under(?:neath)?|ahead of|in front of|compared with|compared to|than|za|pred|oproti)\b.{0,48}/g;

const FADER_PADS: ReadonlyArray<readonly [RegExp, FaderPadFamily]> = [
  [/\bkick\w*/, "kick"],
  [/\bsnare\w*/, "snare"],
  [/\bclap\w*/, "clap"],
  [/\bhat\w*|\bhi.?hat\w*|\bcinel\w*/, "hat"],
  [/\btoms?\b/, "tom"],
  [/\bperc(?:ussion\w*|s)?\b|\bperkus\w*/, "perc"],
];

/**
 * Amount modifiers, resolved through the shared degree taxonomy
 * (intent/degree.ts). The three local regexes this replaced
 * (AMOUNT_FULL / AMOUNT_BIG / AMOUNT_SUBTLE) each carried their own vocabulary
 * and none of them knew about "barely", "a touch", "considerably" or "much" —
 * "much less" only worked HERE, and "slightly more reverb" meant one thing in
 * the fader and another in the effect layer. The taxonomy is the union of all
 * four vocabularies, so no word loses its old bucket:
 *
 *   subtle ← trochu / kusok / jemne / slightly / a bit / a little   (unchanged)
 *   big    ← o dosť / veľmi / hodne / a lot / much / way / heavily   (unchanged)
 *   full   ← úplne / plne / maximálne / complete / fully            (unchanged)
 *   normal ← anything else, including an unqualified ask             (unchanged)
 *
 * The magnitude comes from `degree` when present; see `foldFaderIntent`.
 */
function faderDegree(text: string): { amount: FaderAmount; degree?: Degree } {
  const degree = parseDegree(text);
  if (!degree) return { amount: "normal" };
  return { amount: degreeToFaderAmount(degree.level), degree };
}

/**
 * A stated dB magnitude ("by 2 dB", "o 3 db") as the fold's RELATIVE fader
 * percent — true dB semantics through the multiplicative percent (−2 dB =
 * ×10^(−2/20) ≈ −20.6 %). The fader path owns vocal asks, and a vocal ask
 * that NAMES a number must apply that number: the old fallthrough to the
 * vibe step (×0.82 for "by 2 dB") silently substituted the user's magnitude
 * (SILENT-DEFAULT rule). Null when the ask names no dB magnitude — the vibe
 * amount stays the documented default.
 */
function dBPercent(text: string, direction: "down" | "up"): number | undefined {
  const m = /\b(?:by|o)\s+(\d+(?:[.,]\d+)?)\s*db\b/i.exec(text);
  if (!m) return undefined;
  const db = Math.min(24, Number(m[1]!.replace(",", ".")));
  if (!Number.isFinite(db) || db <= 0) return undefined;
  const factor = direction === "down" ? Math.pow(10, -db / 20) : Math.pow(10, db / 20);
  const percent = direction === "down" ? (1 - factor) * 100 : (factor - 1) * 100;
  return Math.round(percent * 10) / 10;
}

/** Effect nouns — an absolute-set ask naming one belongs to the effectIntent
 * set-mode ("set reverb mix to 25%" is a KNOB ask, not a fader ask). */
const EFFECT_NOUN = /\b(?:reverb|dozvuk|delay|chorus|compress|saturat|filtr|\beq\b|pump|drive)\b/;

export function parseFaderIntent(text: string): FaderIntent | null {
  const lower = ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")} `;
  // A semicolon can separate context from a direct final command. Resolve
  // targets from that command so a reference mentioned earlier does not get
  // treated as another fader target.
  const finalClause = lower.split(";").at(-1)?.trim();
  const commandText = finalClause && (FADER_DOWN.test(finalClause) || FADER_UP.test(finalClause)) ? finalClause : lower;
  // LUFS is an absolute mastering target, never a track-fader unit. Let the
  // loudness route handle it instead of applying a generic relative nudge.
  if (/\blufs\b/.test(lower)) return null;
  // ABSOLUTE SET ("set the bass to 50%", "nastav master na 80 %"): set-verb +
  // explicit percent + a fader target. The percent is the gain as a fraction
  // of the fader range (0..1.5). Effect nouns decline — knob asks belong to
  // the effectIntent set-mode; pan declines (pan direction is its own axis).
  const setFaderVerb =
    /\bset\b|\bnastav\b/.test(lower) ||
    (/\b(?:drop|put|place)\b.{0,32}\b(?:to|at)\b/.test(lower) && parsePercentAllowingZero(text) != null) ||
    (/\bdaj\b.{0,24}\bna\b/.test(lower) && parsePercentAllowingZero(text) != null);
  if (setFaderVerb && !/\bpan\b/.test(lower) && !EFFECT_NOUN.test(lower)) {
    const setPercent = parsePercentAllowingZero(text);
    if (setPercent != null) {
      const targetText = lower.replace(FADER_REFERENCE_CLAUSE, " ");
      const targets = FADER_TARGETS.filter(([pattern]) => pattern.test(targetText)).map(([, target]) => target);
      const pads = FADER_PADS.filter(([pattern]) => pattern.test(targetText)).map(([, family]) => family);
      if (targets.length > 0 || pads.length > 0) {
        return { targets, pads, direction: "set", percent: setPercent };
      }
    }
    // "set X to N%" without a fader family → not a fader ask (tempo/effects
    // own their own set-modes); fall through below for the relative stems.
  }
  const down = FADER_DOWN.test(commandText) || FADER_DOWN_COMPARATIVE.test(commandText);
  const up =
    !down && (FADER_UP.test(commandText) || FADER_UP_COMPARATIVE.test(commandText) || SK_ADD_FADER.test(commandText));
  if (!down && !up) return null;
  // CONFLICTING directions ("zníž basu a zvýš lead") must not silently take
  // the down-priority and move BOTH targets the same way — decline instead.
  // The loud-words ("hlasnejšie"/"hlasitosť") are excluded from the conflict
  // check: "zníž hlasitosť basu" names the volume NOUN, not an up-direction.
  if (down && FADER_UP_DIRECTIONAL.test(commandText)) return null;
  const targetText = commandText.replace(FADER_REFERENCE_CLAUSE, " ");
  const targets = FADER_TARGETS.filter(([pattern]) => pattern.test(targetText)).map(([, target]) => target);
  const pads = FADER_PADS.filter(([pattern]) => pattern.test(targetText)).map(([, family]) => family);
  if (targets.length === 0 && pads.length === 0) return null; // "zniz" alone is ambiguous
  const { amount, degree } = faderDegree(commandText);
  // Explicit numbers beat vibe words ("o 10 %" wins over "trochu"); a
  // stated dB magnitude converts to the same relative percent.
  const percent = parsePercent(commandText) ?? dBPercent(commandText, down ? "down" : "up");
  return {
    targets,
    pads,
    direction: down ? "down" : "up",
    amount,
    ...(degree ? { degree } : {}),
    ...(percent != null ? { percent } : {}),
  };
}

/**
 * P1-A DOCUMENT-DERIVED TARGETS (control-surface audit 2026-10-13, GAP-03's
 * root fix): the family tables above are closed, but the document is open.
 * When no family word matched, the ask can still name one of the USER'S OWN
 * tracks — "turn down the fx return bus", "zníž Reed 200 o 10 %". Match the
 * text against the live track names (deaccented, phrase-bounded); a hit
 * becomes a fader intent whose `trackIds` are resolved HERE, at route time,
 * against the same document the command will execute on.
 *
 * Runs only after `parseFaderIntent` declined (so family-owned names like
 * "bass" never double-resolve here) and BEFORE the loudness parser in
 * route.ts — "lower the fx return bus by 2 db" is a fader ask, not a master
 * loudness nudge. Null unless a direction stem AND a live track name both
 * match: no guess, no fallback to whichever track sits first.
 */
export function parseNamedTrackFaderIntent(text: string, doc: ProjectDocument): FaderIntent | null {
  const lower = ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")} `;
  if (/\blufs\b/.test(lower)) return null;
  // An ask that names an effect AND one of ITS knobs ("set the lead reverb mix
  // to 25%") belongs to the effectIntent grammar (see mix.ts: percent IS the
  // knob's fraction), never to the track fader. The effect word ALONE is not
  // enough — "turn down the Reverb Bus" (a track named that) stays a fader
  // ask; this is the same collision the returns path gates on "return" below.
  if (
    /\b(?:reverb|delay|echo|chorus|compress(?:or|ion)?|saturat\w*|sidechain|pump|eq)\b[\s\S]{0,24}\b(?:mix|amount|wet|decay|feedback|time|rate|depth|tone|thresh\w*|ratio)\b/.test(
      lower,
    ) ||
    /\b(?:mix|amount|wet|decay|feedback|time|rate|depth|tone|thresh\w*|ratio)\b[\s\S]{0,24}\b(?:reverb|delay|echo|chorus|compress(?:or|ion)?|saturat\w*|sidechain|pump|eq)\b/.test(
      lower,
    )
  ) {
    return null;
  }
  // ABSOLUTE SET on a named track/return ("set reverb return to 50%") —
  // the same set-verb gate as parseFaderIntent; direction "set" makes
  // percent the absolute fraction of the fader range.
  const isSet = /\bset\b|\bnastav\b/i.test(lower);
  const down = FADER_DOWN.test(lower);
  const up = !down && (FADER_UP.test(lower) || SK_ADD_FADER.test(lower));
  if (!down && !up && !isSet) return null; // no stem and no absolute set ask
  if (down && FADER_UP_DIRECTIONAL.test(lower)) return null; // conflicting directions decline
  const named = doc.tracks.filter((track) => {
    if (track.kind === "group") return false;
    const name = ` ${track.name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()} `;
    // Phrase-bounded: "fx return bus" must appear as a phrase. The 3-char
    // floor keeps two-letter names ("To") from hijacking every sentence.
    return name.trim().length >= 3 && lower.includes(name);
  });
  // P2-D remainder: return BUSES are faders too ("reverb return to -6 dB").
  // Matched the same phrase-bounded way against doc.returns; routed through
  // returnIds (setReturnGain fold — same clamp as track faders). GATED on
  // the literal word "return": "set reverb to 25%" is the FX MIX (an
  // effectIntent ask — the SFT golden pins it); only "…return…" names the
  // bus fader.
  const namesReturn = /\breturn\b/i.test(lower);
  const namedReturns = namesReturn
    ? doc.returns.filter((item) => {
        const name = ` ${item.name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim()} `;
        return name.trim().length >= 3 && lower.includes(name);
      })
    : [];
  if (named.length === 0 && namedReturns.length === 0) return null;
  const direction: "down" | "up" | "set" = isSet ? "set" : down ? "down" : "up";
  const { amount, degree } = faderDegree(lower);
  const percent = isSet
    ? parsePercentAllowingZero(text)
    : (parsePercent(text) ?? dBPercent(text, down ? "down" : "up"));
  return {
    targets: [],
    trackIds: named.map((track) => track.id),
    returnIds: namedReturns.map((item) => item.id),
    direction,
    ...(amount !== "normal" ? { amount } : {}),
    ...(degree ? { degree } : {}),
    ...(percent != null ? { percent } : {}),
  };
}

// ── CLARIFICATION: nearest interpretation for DECLINED fader asks ───────────

const CLAUSE_SPLIT = /\s+(?:a|alebo|and|but|potom)\s+|,\s*|\s*;\s*/i;

/** Split a request into clauses ("zníž basu a zvýš lead" → two asks). */
export function splitIntentClauses(text: string): string[] {
  return text
    .split(CLAUSE_SPLIT)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

/**
 * Probe for fader asks the parser had to decline. Two shapes:
 * 1. CONFLICTING directions ("zníž basu a zvýš lead") — the nearest
 *    interpretations are the clauses themselves; each parseable clause is
 *    offered as its own executable ask.
 * 2. DIRECTION without a target ("zníž", "hlasnejšie", "turn down") — ask
 *    which fader, offering every family in the parsed direction (SK or EN,
 *    following the text's own language).
 * Null when the text is not a declined fader ask (the caller then falls
 * through to the next route).
 */
export function declinedFaderClarification(text: string): DeclinedIntentClarification | null {
  const lower = ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")} `;
  const down = FADER_DOWN.test(lower);
  const up = FADER_UP.test(lower) || SK_ADD_FADER.test(lower);
  if (!down && !up) return null;

  if (down && FADER_UP_DIRECTIONAL.test(lower)) {
    const suggestions = text
      .split(CLAUSE_SPLIT)
      .map((clause) => clause.trim())
      .filter((clause) => clause.length > 0 && parseFaderIntent(clause) !== null);
    if (suggestions.length > 0) {
      return { reason: "konflikt smerov v jednej vete — rozdel to na kroky:", suggestions };
    }
    return null;
  }

  const hasTarget =
    FADER_TARGETS.some(([pattern]) => pattern.test(lower)) || FADER_PADS.some(([pattern]) => pattern.test(lower));
  if (hasTarget) return null;
  const en = /\b(turn|raise|lower|push|bring|dial|louder|quieter)\b/.test(lower);
  const suggestions = en
    ? down
      ? [
          "turn down the drums",
          "turn down the bass",
          "turn down the vocals",
          "turn down the chords",
          "turn down the lead",
          "turn down the master",
        ]
      : [
          "raise the drums",
          "raise the bass",
          "raise the vocals",
          "raise the chords",
          "raise the lead",
          "raise the master",
        ]
    : down
      ? ["zníž basu", "zníž bicie", "zníž vokál", "zníž lead", "stíš master"]
      : ["zvýš basu", "hlasnejšie bicie", "zvýš vokál", "zvýš lead", "zvýš master"];
  return { reason: en ? "which fader?" : "ktorý fader?", suggestions };
}

// ── TEMPO ("zníž tempo", "pomalší", "zrýchli to", "na 128") ──────────────────

export interface TempoIntent {
  direction: "down" | "up" | "set";
  /** "set" mode: the exact BPM ("tempo na 128", "140 bpm"). */
  bpm?: number;
}

const HAS_TEMPO_WORD =
  /\btempo\b|\bbpm\b|\bpomal|\bspomal|\brychl|\bslow(?:er| down| it down)?\b|\bfaster\b|\bspeed (?:it )?up\b|\bzrychli|\btempa\b/;
const TEMPO_DOWN = /dole|down|nizs|zniz|pomal|slow|spomal/;
const TEMPO_UP = /hore|up|vys|zvys|rychl|faster|speed|zrychli/;
const TEMPO_SET_TEMPO = /\btempo (?:na |to |at )?(\d{2,3})/;
// Bare-number bpm forms are genre-gated at the call site: "hard techno
// 150 bpm" is a generation prompt, not a tempo command.
const TEMPO_SET_BPM = /\bbpm (?:na |to |at )?(\d{2,3})|(\d{2,3}) bpm/;

export function parseTempoIntent(text: string): TempoIntent | null {
  const lower = ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")} `;
  if (!HAS_TEMPO_WORD.test(lower)) return null;
  const setMatch = TEMPO_SET_TEMPO.exec(lower) ?? (intentCarriesGenreSignal(text) ? null : TEMPO_SET_BPM.exec(lower));
  if (setMatch) {
    const bpm = Number(setMatch[1] ?? setMatch[2]);
    // Same window as the exact parser, normalizeProject and setBpm
    // (MIN_BPM..MAX_BPM = 20..300). The old 40..220 gate made "tempo to 250"
    // work through one phrasing but silently decline through another.
    if (bpm >= MIN_BPM && bpm <= MAX_BPM) return { direction: "set", bpm };
  }
  if (TEMPO_DOWN.test(lower)) return { direction: "down" };
  if (TEMPO_UP.test(lower)) return { direction: "up" };
  return null;
}

// ── VIBE ("popovejšie", "more pop") — a composite production intent ──────────

/**
 * "Popovejšie" is not a genre swap — it is a SOUND: brighter top, more punch,
 * a little wider. We express it as a composite production intent over ALL
 * mix tracks so the existing production planner (real DSP on real tracks)
 * does the work — nothing new to maintain.
 */
export function parsePopIntent(text: string): ProductionIntent | null {
  const lower = ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")} `;
  if (!/\bpopov\w*|\bmore pop(?:py|pier)?\b|\bpoppy\b|\bpop(?:py|pier)-?ish\b/.test(lower)) return null;
  const targets: ProductionTarget[] = ["drums", "bass", "chords", "lead"];
  return {
    targets,
    goals: [
      { concept: "brighter", amount: 0.7 },
      { concept: "punchier", amount: 0.6 },
      { concept: "wider", amount: 0.5 },
    ],
    sourceText: text,
  };
}

// ── Application helpers (undoable commands; panel executes) ─────────────────

const GAIN_MIN = 0;
const GAIN_MAX = 1.5;
/** Per-amount fader factors: down multiplies (≤1), up multiplies (≥1). */
const FADER_FACTORS: Record<FaderAmount, { down: number; up: number }> = {
  subtle: { down: 0.92, up: 1.08 },
  normal: { down: 0.82, up: 1.22 },
  big: { down: 0.7, up: 1.35 },
  full: { down: 0.5, up: 1.6 },
};

const clampGain = (value: number): number => Math.round(Math.max(GAIN_MIN, Math.min(GAIN_MAX, value)) * 100) / 100;

const PAD_FAMILY_MATCH: Record<FaderPadFamily, (role: string) => boolean> = {
  kick: (role) => role === "kick",
  snare: (role) => role === "snare",
  clap: (role) => role === "clap",
  hat: (role) => role === "closedHat" || role === "openHat",
  perc: (role) => role === "perc",
  tom: (role) => role === "tom",
};

/**
 * Resolve a fader target to concrete track ids. Named tracks win, then the
 * instrument KIND (808/logdrum ⇒ bass, keys ⇒ chords, pluck/spectral ⇒ lead
 * — same semantics as production's resolveProductionTargets). NO positional
 * fallback: when the named family has no track, the resolver returns [] and
 * the caller fails explicitly — turning down the lead because "the bass is
 * missing" would be an unintended mutation.
 */
function trackIdsForTarget(doc: ProjectDocument, target: FaderTarget): string[] {
  if (target === "drums") {
    return doc.tracks.filter((track) => track.kind === "drum").map((track) => track.id);
  }
  const instruments = doc.tracks.filter(
    (track): track is Extract<typeof track, { kind: "instrument" }> => track.kind === "instrument",
  );
  if (target === "vocal") {
    // Two steps, mirroring the production resolver and mix.ts parity. The
    // name test is the SAME vocabulary the target regexes match in the text
    // ("vox"/"vokál"/"spev" count as vocal names — a naive
    // `name.includes("vocal")` would miss a track named "Vox").
    const vocalNamed = instruments.filter(
      (track) =>
        /\bvocal|\bvox\b|\bvokal|\bspev|hlas(?!nej|itos)/i.test(track.name) || track.instrument === "vocalchop",
    );
    if (vocalNamed.length > 0) return vocalNamed.map((track) => track.id);
    // Unnamed vocals = the singer's takes: the tracks carrying arrangement
    // audio clips. Empty when no take is installed — vocal asks then apply
    // to nothing, they never fall back to a guessed track.
    const clipTrackIds = new Set((doc.arrangement.audioClips ?? []).map((clip) => clip.trackId));
    return doc.tracks.filter((track) => clipTrackIds.has(track.id)).map((track) => track.id);
  }
  const named = instruments.filter((track) => track.name.toLowerCase().includes(target));
  if (named.length > 0) return named.map((track) => track.id);
  const byKind = instruments.filter((track) => {
    if (target === "bass") return ["bass", "808", "logdrum"].includes(track.instrument);
    if (target === "chords") return /\bchord|\bkeys?\b|\bpad\b/i.test(track.name) || track.instrument === "keys";
    return /\blead\b|\bsynth\b|\bpluck\b/i.test(track.name) || ["lead", "pluck", "spectral"].includes(track.instrument);
  });
  return byKind.map((track) => track.id);
}

interface FaderFold {
  next: ProjectDocument;
  faders: number;
  /** Per-intent label fragment, e.g. "↓ [normal]: bass". */
  label: string;
}

/**
 * Fold ONE fader intent over the cursor. All gain reads come from the
 * cursor, so stacked intents compose ("down the drums then up the drums"
 * nets out instead of double-applying against a stale baseline).
 */
function foldFaderIntent(cursor: ProjectDocument, intent: FaderIntent): FaderFold {
  const isSet = intent.direction === "set";
  // SET: percent IS the gain — an absolute fraction of the fader range
  // (0..1.5, so 50% = 0.75). Relative modes: percent = relative gain change
  // in the parsed direction (10 % → ×1.10 up / ×0.90 down); vibe amounts are
  // the fallback when no number is named.
  const absoluteGain = isSet ? clampGain(((intent.percent ?? 0) / 100) * GAIN_MAX) : null;
  const factor = isSet
    ? 1
    : intent.percent != null
      ? intent.direction === "down"
        ? Math.max(0, 1 - intent.percent / 100)
        : 1 + intent.percent / 100
      : (() => {
          // The fine-grained DEGREE wins when the ask named one — that is what
          // separates "barely" (×0.95) from "a little" (×0.92) from "much"
          // (×0.70). The coarse FADER_FACTORS table stays the FALLBACK for a
          // decoded model intent, which carries the schema's `amount` class
          // without any words to re-derive a degree from (model-decoder.ts).
          if (intent.degree)
            return calibrateFaderFactor(intent.degree.value, intent.direction === "down" ? "down" : "up");
          const factors = FADER_FACTORS[intent.amount ?? "normal"];
          return intent.direction === "down" ? factors.down : factors.up;
        })();
  const targetGain = (current: number): number => (isSet ? (absoluteGain as number) : clampGain(current * factor));
  let next = cursor;
  let faders = 0;

  if ((intent.pads?.length ?? 0) > 0) {
    const drumTrack = cursor.tracks.find((track): track is DrumTrack => track.kind === "drum");
    if (drumTrack) {
      for (const [padIndex, pad] of drumTrack.pads.entries()) {
        const role = inferPadRole(pad.name, padIndex);
        if (!(intent.pads ?? []).some((family) => PAD_FAMILY_MATCH[family](role))) continue;
        const gain = targetGain(pad.gain);
        if (gain === pad.gain) continue;
        next = setPadParams(next, pad.id, { gain }).execute(next);
        faders += 1;
      }
    }
  }

  for (const target of intent.targets) {
    if (target === "master") {
      const masterGain = cursor.master?.masterGain ?? 1;
      const gain = Math.max(GAIN_MIN, Math.min(GAIN_MAX, targetGain(masterGain)));
      if (gain !== masterGain) {
        next = setMasterConfig(next, { masterGain: gain }).execute(next);
        faders += 1;
      }
      continue;
    }
    for (const trackId of trackIdsForTarget(cursor, target)) {
      const track = next.tracks.find((track) => track.id === trackId);
      if (!track) continue;
      const gain = targetGain(track.gain);
      if (gain === track.gain) continue;
      next = setTrackParams(next, trackId, { gain }).execute(next);
      faders += 1;
    }
  }

  for (const trackId of intent.trackIds ?? []) {
    // Document-derived targets: the id was resolved against the LIVE doc at
    // route time; a track that vanished since simply applies to nothing.
    const track = next.tracks.find((track) => track.id === trackId);
    if (!track || track.kind === "group") continue;
    const gain = targetGain(track.gain);
    if (gain === track.gain) continue;
    next = setTrackParams(next, trackId, { gain }).execute(next);
    faders += 1;
  }

  for (const returnId of intent.returnIds ?? []) {
    // Return-bus faders ride setReturnGain (0..1.5, same clamp as tracks).
    const ret = next.returns.find((item) => item.id === returnId);
    if (!ret) continue;
    const gain = targetGain(ret.gain);
    if (gain === ret.gain) continue;
    next = setReturnGain(next, returnId, gain).execute(next);
    faders += 1;
  }

  const label = [
    ...intent.targets,
    ...(intent.pads ?? []),
    ...(intent.trackIds ?? []).map((id) => cursor.tracks.find((track) => track.id === id)?.name ?? id),
    ...(intent.returnIds ?? []).map((id) => cursor.returns.find((item) => item.id === id)?.name ?? id),
  ].join(" + ");
  const sizeNote = isSet
    ? `=${intent.percent ?? 0}%`
    : intent.percent != null
      ? `${intent.direction === "down" ? "−" : "+"}${intent.percent}%`
      : (intent.amount ?? "normal");
  return {
    next,
    faders,
    label: `${isSet ? "→" : intent.direction === "down" ? "↓" : "↑"} [${sizeNote}]: ${label}`,
  };
}

/**
 * Apply fader intents → ONE undoable command. PER-PAD families ("kick ťažší",
 * "haty tichšie") drive setPadParams on the matching drum pads; track targets
 * drive setTrackParams / setMasterConfig. Pads first, then tracks, then the
 * next intent — every change folds into a single snapshot so one Ctrl+Z
 * undoes the whole ask (the panel's "(one undo step)" promise must be
 * literally true), including compound asks ("zníž basu a zvýš lead").
 *
 * Returns null when NO pad/track resolved — the caller surfaces an explicit
 * "no matching track" error instead of mutating a guessed substitute.
 */
export function applyFaderIntents(doc: ProjectDocument, intents: FaderIntent[]): Command | null {
  let next = doc;
  let faders = 0;
  const labels: string[] = [];
  for (const intent of intents) {
    const fold = foldFaderIntent(next, intent);
    next = fold.next;
    faders += fold.faders;
    if (fold.faders > 0) labels.push(fold.label);
  }
  if (faders === 0) return null;
  return snapshot("applyFaderIntent", `Fader ${labels.join(" · ")} — ${faders} fader(s)`, doc, next);
}

/** Single-intent convenience wrapper over {@link applyFaderIntents}. */
export function applyFaderIntent(doc: ProjectDocument, intent: FaderIntent): Command | null {
  return applyFaderIntents(doc, [intent]);
}

const readGainOf = (doc: ProjectDocument, trackId: string): number | undefined =>
  doc.tracks.find((track) => track.id === trackId)?.gain;

const fmtGain = (value: number): number => Math.round(value * 100) / 100;

/**
 * VERIFICATION READ-BACK — what the faders ACTUALLY landed on, read from the
 * post-execution document (clamps included). "bass 0.85→0.70" proves the
 * gain moved and shows the real value; dispatch alone proves nothing.
 */
export function faderReadback(before: ProjectDocument, after: ProjectDocument, intent: FaderIntent): string {
  const entries: string[] = [];
  const trackName = (doc: ProjectDocument, id: string): string =>
    doc.tracks.find((track) => track.id === id)?.name ?? id;
  const push = (name: string, gainBefore: number, gainAfter: number) => {
    if (gainBefore !== gainAfter) entries.push(`${name} ${fmtGain(gainBefore)}→${fmtGain(gainAfter)}`);
  };

  for (const target of intent.targets) {
    if (target === "master") {
      push("master", before.master?.masterGain ?? 1, after.master?.masterGain ?? 1);
      continue;
    }
    for (const trackId of trackIdsForTarget(before, target)) {
      const gainBefore = readGainOf(before, trackId);
      const gainAfter = readGainOf(after, trackId);
      if (gainBefore == null || gainAfter == null) continue;
      push(trackName(before, trackId), gainBefore, gainAfter);
    }
  }

  for (const trackId of intent.trackIds ?? []) {
    const gainBefore = readGainOf(before, trackId);
    const gainAfter = readGainOf(after, trackId);
    if (gainBefore == null || gainAfter == null) continue;
    push(trackName(before, trackId), gainBefore, gainAfter);
  }

  for (const returnId of intent.returnIds ?? []) {
    const gainBefore = before.returns.find((item) => item.id === returnId)?.gain;
    const gainAfter = after.returns.find((item) => item.id === returnId)?.gain;
    if (gainBefore == null || gainAfter == null) continue;
    const returnName = before.returns.find((item) => item.id === returnId)?.name ?? returnId;
    push(returnName, gainBefore, gainAfter);
  }

  if ((intent.pads?.length ?? 0) > 0) {
    const drumBefore = before.tracks.find((track): track is DrumTrack => track.kind === "drum");
    const drumAfter = after.tracks.find((track): track is DrumTrack => track.kind === "drum");
    if (drumBefore && drumAfter) {
      for (const [padIndex, pad] of drumBefore.pads.entries()) {
        const role = inferPadRole(pad.name, padIndex);
        if (!(intent.pads ?? []).some((family) => PAD_FAMILY_MATCH[family](role))) continue;
        const padAfter = drumAfter.pads.find((candidate) => candidate.id === pad.id);
        if (padAfter) push(pad.name, pad.gain, padAfter.gain);
      }
    }
  }

  if (entries.length > 4) return `${entries.slice(0, 4).join(", ")} +${entries.length - 4}`;
  return entries.join(", ");
}

const TEMPO_STEP_BPM = 6;

/** Apply a tempo intent → ONE undoable setBpm command (clamped by setBpm). */
export function applyTempoIntent(doc: ProjectDocument, intent: TempoIntent): Command {
  if (intent.direction === "set" && intent.bpm) return setBpm(doc, intent.bpm);
  const delta = intent.direction === "up" ? TEMPO_STEP_BPM : -TEMPO_STEP_BPM;
  return setBpm(doc, doc.bpm + delta);
}
