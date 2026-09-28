import type { SmpTeTimecode } from "../midi/smpte";
import { parseSmpTe } from "../midi/smpte";

/**
 * Chase intent (ADR 0017 wave 2 intent surface): natural-language control of
 * the MTC chase feature — "chase my timecode", "sleduj timecode", "go to
 * 1:23". Detection is deaccented + case-insensitive (repo convention), EN
 * anchors with SK extending, same tier as the production-intent parser.
 *
 * Verbs:
 *   arm    — "chase (my) timecode", "sync to timecode", "sleduj timecode",
 *            bare "chase" (it IS the feature's name in this app)
 *   disarm — "stop chasing", "disarm chase", "prestan sledovat timecode"
 *   seek   — "go to 1:23", "jump to 01:23:12:15", "chod na timecode 0:30"
 *            (explicit go/jump/seek verbs win over arm/disarm phrases)
 */

export type ChaseIntent =
  { kind: "arm" } | { kind: "disarm" } | { kind: "seek"; tc: SmpTeTimecode } | { kind: "offset"; seconds: number };

const deaccent = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

/** Loose timecode: "1:23" (mm:ss), "01:23:12" (hh:mm:ss), "01:23:12:15" (+frames). */
export function parseLooseTimecode(token: string): SmpTeTimecode | null {
  const match = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:[;:](\d{1,2}))?$/.exec(token.trim());
  if (!match) return null;
  const a = Number(match[1]);
  const b = Number(match[2]);
  const c = match[3] !== undefined ? Number(match[3]) : null;
  const f = match[4] !== undefined ? Number(match[4]) : 0;
  // "1:23" → mm:ss; "01:23:12" → hh:mm:ss; "01:23:12:15" → +frames.
  const timecode =
    c === null
      ? { hours: 0, minutes: a, seconds: b, frames: f, rate: 25 }
      : { hours: a, minutes: b, seconds: c, frames: f, rate: 25 };
  return parseSmpTe(
    `${String(timecode.hours).padStart(2, "0")}:${String(timecode.minutes).padStart(2, "0")}:${String(timecode.seconds).padStart(2, "0")}:${String(timecode.frames).padStart(2, "0")}`,
    25,
  );
}

const TIMECODE_TOKEN = /\b\d{1,2}:\d{1,2}(?::\d{1,2})?(?:[;:]\d{1,2})?\b/;

/** "timecode offset 1 hour" / "tc offset -30 s" — amount + unit. */
const OFFSET_SET =
  /\b(?:tc|timecode)\s+offset\s*(?:=|to|na)?\s*(-?\d+(?:\.\d+)?)\s*(hours?|hodin\w*|h|min\w*|m|sec\w*|s)\b/;

const OFFSET_RESET =
  /\b(?:reset|clear|remove|vynuluj|zrus)\b[^.]*\b(?:tc|timecode)\s+offset\b|\b(?:tc|timecode)\s+offset\s*(?:zero|reset|vynuluj)\b/;

const UNIT_SECONDS: Record<string, number> = {
  hours: 3600,
  hour: 3600,
  hodin: 3600,
  hodina: 3600,
  h: 3600,
  minutes: 60,
  minute: 60,
  minut: 60,
  min: 60,
  m: 60,
  seconds: 1,
  second: 1,
  sekund: 1,
  sekunda: 1,
  sec: 1,
  s: 1,
};

const SEEK_VERB =
  /\b(?:go(?:ing)?\s+to|goto|jump\s+to|seek(?:\s+to)?|skip\s+to|chod\s+na|skoc\s+na|prejdi\s+na|posun\s+(?:sa\s+)?na)\b/;

const DISARM =
  /\b(?:stop|disable|disarm|turn\s+off|leave|exit|vypni|prestan|zrus|odpoj)\b[^.]*\b(?:chas\w*|timecod\w*|mtc|synchroniz\w*|sync\w*)\b|\b(?:chas\w*|timecod\w*|mtc)\b[^.]*\b(?:off|vypnut)\b/;

const ARM =
  /\b(?:chas\w*|follow|sleduj|nasleduj|sync\w*|synchroniz\w*)\b[^.]*\b(?:timecod\w*|mtc|tc)\b|\btimecod\w*\b[^.]*\b(?:chas\w*|follow|sleduj|sync\w*)\b|^\s*chas\w*\s*[.!]?\s*$|\bchas\w*\s+mode\b/;

/** Detect a chase/seek intent in free text. Returns null for other sentences. */
export function parseChaseIntent(text: string): ChaseIntent | null {
  const lower = deaccent(text);
  if (!lower.trim()) return null;

  // Offset configuration beats seek/arm: "tc offset 1 hour" redefines the
  // TC origin ("reset/clear" returns it to zero).
  const offsetSet = OFFSET_SET.exec(lower);
  if (offsetSet) {
    const unit = UNIT_SECONDS[offsetSet[2]] ?? 1;
    return { kind: "offset", seconds: Number(offsetSet[1]) * unit };
  }
  if (OFFSET_RESET.test(lower)) return { kind: "offset", seconds: 0 };

  // Seek first: an explicit go/jump verb with a timecode token wins over the
  // arm/disarm phrases ("go to timecode 1:23" is a position, not an arming).
  if (SEEK_VERB.test(lower)) {
    const token = TIMECODE_TOKEN.exec(lower)?.[0];
    if (token) {
      const tc = parseLooseTimecode(token);
      if (tc) return { kind: "seek", tc };
    }
  }

  if (DISARM.test(lower)) return { kind: "disarm" };
  if (ARM.test(lower)) return { kind: "arm" };
  return null;
}
