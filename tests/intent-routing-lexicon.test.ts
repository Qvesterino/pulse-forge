import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseIntentText, styleCandidatesForPrompt } from "../src/intent/text-parser";

/**
 * INTENT-ROUTING LEXICON GATE (Package 1, 2026-10-17)
 *
 * The phrase tables in `text-parser.ts` resolve by ORDER, so a token that
 * appears twice with different targets silently loses its second meaning —
 * and nothing failed when that happened. The census that motivated this gate
 * found 7 shadowed duplicates in the shipped tables (grime, ukg/uk garage,
 * grunge/metal/thrash, breakbeat) whose dead alternates sat one careless
 * edit away from flipping a lane to a target with NO groove behind it
 * (the documented "silent random fallback" shape).
 *
 * The gate has three layers:
 *   1. DERIVED   — no token may appear twice in one table with different
 *                  targets; per-table token floors keep the extractor honest
 *                  (an extractor that silently returns 0 would pass forever).
 *   2. ALLOWLIST — cross-lane overlaps that are DELIBERATE dual effects are
 *                  listed explicitly; anything new fails.
 *   3. CORPUS    — realistic prompts pinned to their intended parse, one per
 *                  decision that a shadowing bug would silently break.
 */

const SOURCE = readFileSync(resolve(__dirname, "../src/intent/text-parser.ts"), "utf8");
const LINES = SOURCE.split("\n");

const TABLES = [
  { name: "GENRE", marker: "const GENRE_PHRASES", floor: 340 },
  { name: "STYLE", marker: "const STYLE_PHRASES", floor: 420 },
  { name: "FLOW", marker: "const FLOW_PHRASES", floor: 3 },
  { name: "MOOD", marker: "const MOOD_PHRASES", floor: 80 },
  { name: "TRAIT", marker: "const TRAIT_PHRASES", floor: 120 },
  { name: "ROLE", marker: "const ROLE_PHRASES", floor: 28 },
] as const;

function tableRange(marker: string): [number, number] {
  const start = LINES.findIndex((line) => line.includes(marker));
  expect(start, `phrase table not found: ${marker}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let began = false;
  for (let i = start; i < LINES.length; i += 1) {
    for (const ch of LINES[i]!) {
      if (ch === "[") {
        depth += 1;
        began = true;
      } else if (ch === "]") depth -= 1;
    }
    if (began && depth === 0) return [start, i];
  }
  throw new Error(`no table end for ${marker}`);
}

function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    if (ch === "|" && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts;
}

/**
 * Expand one alternative. Handles the optional metacharacters the tables
 * actually use — ` ?` (e.g. `big ?beat` → "bigbeat" + "big beat"), `\s?`,
 * `[- ]?` classes and `(?:a|b)` groups — because an extractor blind to those
 * is exactly what let `big ?beat` shadow the bigbeat style silently.
 */
function expandAlt(text: string): string[] {
  // Optional character class: `[ -]?` in the source text.
  const classOpt = /\[([^\]]*)\]\?/.exec(text);
  // Optional single char: ` ?`, `\s?`, `s?`.
  const optionalChar = /(\\)?(.)\?/.exec(text);
  // Group: `(?:a|b)`, `(a|b)`, or a class without `?`.
  const group = /\\(?:\((?:\?:)?([^()]*)\)|\[([^\]]*)\])/.exec(text);
  if (classOpt && (!optionalChar || classOpt.index <= optionalChar.index)) {
    const members = classOpt[1]!.replace(/\\/g, "");
    const before = text.slice(0, classOpt.index);
    const after = text.slice(classOpt.index + classOpt[0].length);
    const out = [expandAlt(before + after)];
    for (const ch of members) out.push(expandAlt(before + ch + after));
    return out.flat();
  }
  if (optionalChar) {
    const index = optionalChar.index;
    const ch = optionalChar[1] === "\\" && optionalChar[2] === "s" ? " " : optionalChar[2]!;
    const before = text.slice(0, index);
    const after = text.slice(index + optionalChar[0].length);
    return [expandAlt(before + after), expandAlt(before + ch + after)].flat();
  }
  if (group) {
    const raw = (group[1] ?? group[2] ?? "").replace(/\\/g, "");
    const optional = text[group.index + group[0].length] === "?";
    const alts = raw.includes("|") ? raw.split("|") : [raw];
    const before = text.slice(0, group.index);
    const after = text.slice(group.index + group[0].length + (optional ? 1 : 0));
    return alts.flatMap((alt) => expandAlt(before + alt + after));
  }
  return [text];
}

/** Literal tokens an entry's regex can match, e.g. `\bgrime\b|\beski\b` → ["grime","eski"]. */
function expand(source: string): string[] {
  const stripped = source.replace(/\\b/g, "").replace(/\\s\+?/g, " ");
  const out = new Set<string>();
  for (const part of splitTop(stripped)) for (const token of expandAlt(part)) out.add(token);
  return [...out]
    .map((token) =>
      token
        .replace(/[\\()?:|]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase(),
    )
    .filter((token) => token.length > 1 && /^[a-z0-9][a-z0-9 -]*$/.test(token));
}

interface Lexicon {
  /** table name → token → targets claimed in that table */
  tables: Map<string, Map<string, Set<string>>>;
}

function extractLexicon(): Lexicon {
  const tables = new Map<string, Map<string, Set<string>>>();
  for (const table of TABLES) {
    const [start, end] = tableRange(table.marker);
    const body = LINES.slice(start, end + 1).join("\n");
    const tokens = new Map<string, Set<string>>();
    const pair = /\/((?:\\.|[^/\\])+)\/[a-z]*\s*,\s*("([^"]*)"|\{[^}]*\})/g;
    let match: RegExpExecArray | null;
    while ((match = pair.exec(body))) {
      const regexSource = match[1]!;
      const target = match[3] !== undefined ? `"${match[3]}"` : "object";
      let re: RegExp;
      try {
        re = new RegExp(regexSource, "i");
      } catch {
        continue;
      }
      for (const token of expand(regexSource)) {
        if (!re.test(token)) continue; // extraction artifact — drop
        const set = tokens.get(token) ?? new Set<string>();
        set.add(target);
        tokens.set(token, set);
      }
    }
    tables.set(table.name, tokens);
  }
  return { tables };
}

const lexicon = extractLexicon();

describe("intent-routing lexicon gate (Package 1)", () => {
  it("no phrase table shadows a token with a second target (dead-entry gate)", () => {
    for (const table of TABLES) {
      const tokens = lexicon.tables.get(table.name)!;
      expect(
        tokens.size,
        `${table.name} extracted only ${tokens.size} tokens — the extractor broke, and this gate would pass vacuously`,
      ).toBeGreaterThanOrEqual(table.floor);
      const shadowed = [...tokens]
        .filter(([, targets]) => targets.size > 1)
        .map(([token, targets]) => `${token} -> ${[...targets].join(" | ")}`);
      expect(
        shadowed,
        `${table.name} claims the same token twice with different targets; the later entry can never fire`,
      ).toEqual([]);
    }
  });

  it("cross-lane overlaps are exactly the documented dual effects", () => {
    // Style words intentionally also nudge the character sliders (the TRAIT
    // table's own rule for moods extended to sound words), plus two named
    // dual effects. Anything not listed here is an unintended collision.
    const intended = new Set([
      "lush|MOOD|STYLE", // mood lush + the "lux" string style
      "lush|TRAIT|STYLE",
      "peak time|TRAIT|GENRE", // techno genre + festival energy trait
      "driving|TRAIT|STYLE",
      "festival|TRAIT|STYLE",
      "minimalistick|TRAIT|STYLE",
      "minimalny|TRAIT|STYLE", // SK form of the same minimum-density dual effect
      "nostalgick|TRAIT|STYLE",
      "retro|TRAIT|STYLE",
      "rolling|TRAIT|STYLE",
      "roluj|TRAIT|STYLE",
      "sparse|TRAIT|STYLE",
      "staromodn|TRAIT|STYLE",
      "vintage|TRAIT|STYLE",
    ]);
    const derived = new Set<string>();
    const byToken = new Map<string, string[]>();
    for (const table of TABLES) {
      for (const token of lexicon.tables.get(table.name)!.keys()) {
        const lanes = byToken.get(token) ?? [];
        lanes.push(table.name);
        byToken.set(token, lanes);
      }
    }
    for (const [token, lanes] of byToken) {
      // Only pairs where a semantic lane (MOOD/TRAIT/ROLE) meets another lane.
      const semantic = lanes.filter((lane) => lane === "MOOD" || lane === "TRAIT" || lane === "ROLE");
      const other = lanes.filter((lane) => lane !== "MOOD" && lane !== "TRAIT" && lane !== "ROLE");
      for (const a of semantic) for (const b of other) derived.add(`${token}|${a}|${b}`);
      // ROLE words must never double as a genre/style word.
      expect(
        semantic.includes("ROLE") && other.length > 0,
        `ROLE token "${token}" also appears in ${other.join(", ")} — a role word must not steer genre/style`,
      ).toBe(false);
    }
    expect([...derived].sort()).toEqual([...intended].sort());
  });
});

describe("intent-routing precedence corpus (Package 1)", () => {
  const cases: Array<{ prompt: string; genre?: string; style?: string | null; why: string }> = [
    { prompt: "grime 140", genre: "drill", why: "drill.grime groove exists; the house duplicate never fired" },
    { prompt: "eski beat", genre: "house", why: "the surviving eski reading (style grime handles the compound)" },
    { prompt: "uk garage", genre: "ukg", why: "first-class UKG genre since the garage promotion" },
    { prompt: "ukg groove", genre: "ukg", why: "bare ukg is the genre, not the house reading" },
    { prompt: "garage", genre: "house", why: "bare garage stays the house reading" },
    { prompt: "grunge", genre: "house", why: "house.grunge groove owns the bare word" },
    { prompt: "metal", genre: "house", why: "house.metal groove owns the bare word" },
    { prompt: "thrash", genre: "house", why: "house.thrash groove owns the bare word" },
    { prompt: "punk", genre: "rock", why: "bare punk is the rock genre" },
    { prompt: "classic rock", genre: "rock", why: "bare rock family is the rock genre" },
    { prompt: "breakbeat", style: "breakbeat", why: "the earlier style entry owns it; bigbeat is not it" },
    { prompt: "big beat", style: "bigbeat", why: "bigbeat is reached by its own words only" },
    { prompt: "nuskool breaks", style: "bigbeat", why: "the third bigbeat alias" },
  ];
  for (const entry of cases) {
    it(`"${entry.prompt}" → genre ${entry.genre ?? "(none)"}${entry.style ? `, style ${entry.style}` : ""}`, () => {
      const parsed = parseIntentText(entry.prompt).input;
      if (entry.genre !== undefined) expect(parsed.genre).toBe(entry.genre);
      if (entry.style !== undefined) {
        expect(parsed.style).toBe(entry.style);
        expect(styleCandidatesForPrompt(entry.prompt)).toContain(entry.style);
      }
    });
  }

  it("bare swing is a groove modifier, not the jazz genre", () => {
    // The genre table claims jazz compounds only; a bare groove ask must not
    // set a genre (route-level consequences are pinned in studio-words).
    expect(parseIntentText("more swing").input.genre).toBeUndefined();
    expect(parseIntentText("swing jazz").input.genre).toBe("jazz");
  });

  it("a style word also nudges the character sliders (documented dual effect)", () => {
    const lush = parseIntentText("lush pads").input;
    expect(lush.mood).toBe("lush");
    expect(lush.style).toBe("lux");
    expect(lush.density, "the TRAIT half of lush must still apply").toBeGreaterThan(0.5);
    const peak = parseIntentText("peak time techno").input;
    expect(peak.genre).toBe("techno");
    expect(peak.energy, "the TRAIT half of peak time must still apply").toBeGreaterThan(0.9);
  });
});
