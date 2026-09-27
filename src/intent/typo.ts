/**
 * TYPO LAYER — "did you mean?" for near-miss COMMAND verbs.
 *
 * "mut the drums" today falls to pattern GENERATION — a typo produces a beat
 * instead of a mute. This module offers the distance-1 correction: when a
 * token is one edit away from a command verb, the corrected sentence is a
 * candidate. The ROUTER decides whether a candidate is real by re-routing
 * it — a correction only surfaces when the fixed sentence parses into an
 * executable (non-pattern) intent. Offer-only: nothing auto-executes.
 *
 * Safety rails:
 *  - VERBS only (a target noun alone never signals a command), EN + SK.
 *  - Tokens already in the vocabulary are never "corrected" again.
 *  - Bounded sentence shape: ≤ 8 tokens keeps prompts out of scope; genre
 *    detection upstream already refuses texts with a genre/beat signal.
 */

const TYPO_VERBS: ReadonlySet<string> = new Set([
  // EN command verbs
  "mute",
  "unmute",
  "solo",
  "pan",
  "rename",
  "delete",
  "remove",
  "drop",
  "duplicate",
  "boost",
  "lower",
  "raise",
  "increase",
  "reduce",
  "transpose",
  "set",
  "stop",
  "play",
  "pause",
  "save",
  "export",
  "record",
  "select",
  "load",
  "apply",
  "use",
  "metronome",
  "tempo",
  // SK command verbs (de-accented stems the parsers match)
  "stis",
  "zapni",
  "zmaz",
  "odstran",
  "premenuj",
  "duplikuj",
  "nastav",
  "nacitaj",
  "uloz",
  "exportuj",
  "zastav",
  "hraj",
  "pauza",
  "nahravaj",
  "vyber",
  "pridaj",
  "zvys",
  "zniz",
]);

const MAX_TOKENS = 8;

/** True when a and b differ by exactly one edit (sub/insert/delete). */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i] && ++diff > 1) return false;
    }
    return diff === 1;
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++;
      j++;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    j++;
  }
  return true;
}

/**
 * Distance-1 corrected sentences for near-miss command verbs. Pure: replaces
 * ONE token per candidate, at most two candidates, preserving the original
 * spacing (regex span swap on the de-accented lowercase form — every parser
 * downstream matches case-insensitively).
 */
export function typoCorrections(text: string): string[] {
  const lower = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const tokens = lower.split(/[^a-z]+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > MAX_TOKENS) return [];
  const candidates: string[] = [];
  for (const match of lower.matchAll(/[a-z]{3,}/g)) {
    const token = match[0];
    if (TYPO_VERBS.has(token)) continue; // already a command verb — no fix
    for (const verb of TYPO_VERBS) {
      if (!withinOneEdit(token, verb)) continue;
      const fixed = lower.slice(0, match.index) + verb + lower.slice(match.index + token.length);
      if (!candidates.includes(fixed)) candidates.push(fixed);
      break; // first matching verb per token is enough
    }
    if (candidates.length >= 2) break;
  }
  return candidates;
}
