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
 * ORDER (the sequence IS the form), the lines between tags → the section's
 * lyrics, and each section's bar count scales with its lyric length (the
 * W2 prosody default: 2 bars per lyric line). Pure and deterministic.
 */

import type { SceneRole } from "../project-model/types";

export interface SunoSection {
  role: SceneRole;
  /** The bracket tag verbatim ("Verse 2"). */
  tag: string;
  /** The lyric lines between this tag and the next. */
  lyrics: string[];
}

export interface SunoFormat {
  sections: SunoSection[];
  /** Lines before the first tag — a free-form prompt, not structure. */
  preamble: string[];
}

const TAG_ROLES: ReadonlyArray<readonly [SceneRole, RegExp]> = [
  ["intro", /^\[?\s*intro\b/i],
  ["verse", /^\[?\s*verse\b/i],
  ["chorus", /^\[?\s*(chorus|hook)\b/i],
  ["bridge", /^\[?\s*bridge\b/i],
  ["break", /^\[?\s*(break|breakdown)\b/i],
  ["drop", /^\[?\s*drop\b/i],
  ["build", /^\[?\s*(build|buildup)\b/i],
  ["outro", /^\[?\s*(outro|end)\b/i],
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
      if (role) {
        current = { role, tag: line.replace(/^\[|\]$/g, "").trim(), lyrics: [] };
        sections.push(current);
        continue;
      }
      // An unknown bracket tag ("[Instrumental]") — a boundary, no role.
      current = { role: "verse", tag: line.replace(/^\[|\]$/g, "").trim(), lyrics: [] };
      sections.push(current);
      continue;
    }
    if (line.length === 0) continue;
    if (current) current.lyrics.push(line);
    else preamble.push(line);
  }
  return sections.length > 0 ? { sections, preamble } : null;
}
