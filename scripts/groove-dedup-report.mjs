#!/usr/bin/env node
/**
 * Groove library health report — run before adding a genre's groove wave.
 *
 *   node scripts/groove-dedup-report.mjs
 *
 * Reports the things that are cheap to get wrong when extending the library:
 * duplicate ids, malformed tempo windows, grooves the engine cannot tell
 * apart, and (the one that actually bites) styles the parser can emit that
 * resolve to no groove at all.
 *
 * Exit code is 0 unless a HARD problem is found, so it is safe in a pre-commit
 * hook. The advisory section is informational by design.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { GROOVE_LIBRARY, getGrooveById } = await import(pathToFileURL(join("src/ai/grooves/index.ts")).href);
const { findGrooveDuplicates } = await import(pathToFileURL(join("src/ai/grooves/dedup.ts")).href);

const hard = [];
const advisory = [];

/* ---- ids ---------------------------------------------------------------- */
const seen = new Map();
for (const g of GROOVE_LIBRARY) {
  const prior = seen.get(g.id);
  if (prior) hard.push(`duplicate id: ${g.id} (${prior} and ${g.name})`);
  seen.set(g.id, g.name);
}

/* ---- tempo windows ------------------------------------------------------ */
for (const g of GROOVE_LIBRARY) {
  const [lo, hi] = g.bpm;
  if (!(lo > 0 && hi > lo)) hard.push(`bad tempo window: ${g.id} ${JSON.stringify(g.bpm)}`);
  if (!g.name.trim()) hard.push(`missing name: ${g.id}`);
  if (!Number.isFinite(g.swing)) hard.push(`non-finite swing: ${g.id}`);
  if (!Array.isArray(g.activePads) || g.activePads.length === 0) hard.push(`no active pads: ${g.id}`);
}

/* ---- indistinguishable grooves ----------------------------------------- */
const dupes = findGrooveDuplicates();
for (const d of dupes) {
  advisory.push(`indistinguishable: ${d.a.id} ~ ${d.b.id} — ${d.reason}; engine picks the same pocket for both`);
}

/* ---- parser styles that resolve to nothing ----------------------------- */
const { parseIntentText } = await import(pathToFileURL(join("src/intent/text-parser.ts")).href);
// Read the style vocabulary out of the parser's own source rather than
// duplicating it here — STYLE_PHRASES is module-private and a copied list
// would rot. Slice ONLY that array: the file has ROLE_PHRASES and MOOD_PHRASES
// after it, whose tokens are not groove styles.
const parserSrc = readFileSync(join("src/intent/text-parser.ts"), "utf8");
const start = parserSrc.indexOf("const STYLE_PHRASES");
const end = parserSrc.indexOf("];", start);
if (start < 0 || end < 0) {
  hard.push("could not locate STYLE_PHRASES in src/intent/text-parser.ts — report is stale");
}
const styleBlock = start >= 0 && end > start ? parserSrc.slice(start, end) : "";
// Entries look like:  [/\breggae\b|\bska\b/, "reggae"],
const styleTokens = [
  ...new Set(
    [...styleBlock.matchAll(/\/\S*?\/[a-z]*\s*,\s*"([a-z0-9 ._-]+)"/gi)].map((m) => m[1].trim()).filter(Boolean),
  ),
];

const dangling = [];
for (const style of styleTokens) {
  // Ask the parser itself — the same lookup resolveGroove* performs.
  const parsed = parseIntentText(style).input;
  const genre = parsed.genre;
  if (!genre) continue;
  const resolved = parsed.style ?? style.toLowerCase().replace(/\s+/g, "");
  if (!getGrooveById(`${genre}.${resolved}`)) dangling.push(`"${style}" -> ${genre}.${resolved}`);
}
for (const d of dangling) hard.push(`dangling style: ${d} (parser emits it, no groove carries it)`);

/* ---- report ------------------------------------------------------------- */
console.log(`Groove library: ${GROOVE_LIBRARY.length} grooves, ${styleTokens.length} parser styles\n`);

if (advisory.length) {
  console.log(`ADVISORY (${advisory.length}) — worth a listen before you delete anything:`);
  for (const a of advisory) console.log(`  · ${a}`);
  console.log("");
}
if (hard.length) {
  console.log(`HARD (${hard.length}) — fix before committing:`);
  for (const h of hard) console.log(`  ✗ ${h}`);
  process.exit(1);
}
console.log("No duplicate ids, no malformed grooves, no dangling parser styles.");
