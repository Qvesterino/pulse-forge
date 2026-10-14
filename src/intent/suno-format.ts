/**
 * SUNO-FORMAT COMPATIBILITY (W4 of the vocal campaign, 2026-10-12) — the
 * bracketed prompt format the AI-music generation uses:
 *
 *   [Intro]
 *   [Verse 1]
 *   City lights are calling out my name
 *   [Chorus]
 *   We are the ones who light the flame
 *
 * `parseSunoFormat` reads that structure: bracket tags → section roles in
 * ORDER (the sequence IS the form), and the lines between tags → section
 * lyrics. The song builder derives bars from its prosody grid and applies
 * syllable timing to generated lead notes. Pure and deterministic.
 */

import type { SceneRole } from "../project-model/types";

export interface SunoSection {
  role: SceneRole;
  /** The bracket tag verbatim ("Verse 2"). */
  tag: string;
  /** The lyric lines between this tag and the next. */
  lyrics: string[];
  /** "[Chorus x2]" — the tag's own repeat count (1 = absent). */
  repeats: number;
}

export interface SunoFormat {
  sections: SunoSection[];
  /** Lines before the first tag — a free-form prompt, not structure. */
  preamble: string[];
}

const TAG_ROLES: ReadonlyArray<readonly [SceneRole, RegExp]> = [
  // More-specific tags FIRST so [Pre-Chorus] never matches the plain chorus
  // rule and [Post-Chorus] rides the same way.
  ["build", /^\[?\s*pre[- ]?chorus\b/i],
  ["chorus", /^\[?\s*post[- ]?chorus\b/i],
  ["intro", /^\[?\s*intro\b/i],
  ["verse", /^\[?\s*(verse|sloha|strofa)\b/i],
  ["chorus", /^\[?\s*(chorus|hook|refren|refrén)\b/i],
  ["bridge", /^\[?\s*(bridge|mostik|mostík|interlude)\b/i],
  ["break", /^\[?\s*(break|breakdown|instrumental)\b/i],
  ["drop", /^\[?\s*(drop|ad[- ]?lib)\b/i],
  ["build", /^\[?\s*(build|buildup|build-up)\b/i],
  ["outro", /^\[?\s*(outro|end|fade[- ]?out|záver|zaver)\b/i],
];

function tagRole(tag: string): SceneRole | null {
  const lower = tag.toLowerCase();
  for (const [role, re] of TAG_ROLES) {
    if (re.test(lower)) return role;
  }
  return null;
}

export function parseSunoFormat(text: string): SunoFormat | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const tagLines = lines.filter((line) => /^\[.+?\]$/.test(line));
  if (tagLines.length === 0) return null; // no brackets — not this format
  const sections: SunoSection[] = [];
  const preamble: string[] = [];
  let current: SunoSection | null = null;
  for (const line of lines) {
    if (/^\[.+?\]$/.test(line)) {
      const role = tagRole(line);
      const bareTag = line.replace(/^\[|\]$/g, "").trim();
      // "[Chorus x2]" / "[Chorus 2x]" — a repeat suffix on the tag itself.
      const repeatMatch = bareTag.match(/\b(?:x\s*(\d{1,2})|(\d{1,2})\s*x)\b/i);
      const repeats = repeatMatch ? Math.max(1, Math.min(8, Number(repeatMatch[1] ?? repeatMatch[2]))) : 1;
      if (role) {
        current = { role, tag: bareTag, lyrics: [], repeats };
        sections.push(current);
        continue;
      }
      // An unknown bracket tag ("[Spoken Word]", "[Solo]") — a boundary; a
      // solo reads as a bridge-shaped passage, spoken word as a verse.
      const fallbackRole = /\bsolo\b/i.test(bareTag) ? "bridge" : "verse";
      current = { role: fallbackRole, tag: bareTag, lyrics: [], repeats };
      sections.push(current);
      continue;
    }
    if (line.length === 0) continue;
    if (current) current.lyrics.push(line);
    else preamble.push(line);
  }
  return sections.length > 0 ? { sections, preamble } : null;
}
