/**
 * Property-based fuzz for sanitizeFilename (private to src/export/project-io.ts).
 *
 * `sanitizeFilename` is not exported from src/export/project-io.ts (kept
 * private because it's an internal filename-massaging helper). To exercise
 * it without changing the source, this file:
 *   1. Reads the source file as text.
 *   2. Locates the `function sanitizeFilename` body.
 *   3. Compiles it via `new Function(...)` so the test runs against the
 *      *exact* implementation currently in source — drift in the body
 *      triggers a compile error and the test suite fails loudly.
 *
 * Test invariant: for any input containing the explicit-strip characters
 * (\u0000-\u001F, \u007F-\u009F, \u200B-\u200F, \u202A-\u202E, \u2066-\u2069,
 * \uFEFF), the sanitised result MUST NOT contain those characters.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Pull the function out of the source by exporting it through a wrapper.
const SOURCE = readFileSync(resolve(__dirname, "../../src/export/project-io.ts"), "utf8");
function stripJsComments(s: string): string {
  // Remove /* … */ and // …\n comments. Good enough for the small
  // bodies we parse here; doesn't have to be a full TS scanner.
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// Match the sanitizeFilename definition including its body.
const FN_RE = /function sanitizeFilename\(name: string\): string\s*\{([\s\S]*?)\n\}/;
const m = SOURCE.match(FN_RE);
if (!m) throw new Error("Could not locate sanitizeFilename in src/export/project-io.ts");

const cleaned = stripJsComments(m[1]);

// The body is `return ( <expression> );`. Capture the expression so we
// can use it as an expression (not a statement) inside `new Function`.
const RETURN_RE = /return\s*\(([\s\S]*?)\)\s*;/;
const exprMatch = cleaned.match(RETURN_RE);
if (!exprMatch) throw new Error("Could not parse sanitizeFilename body");

const expr = exprMatch[1].replace(/\s+/g, " ").trim();
const sanitizeFilename: (name: string) => string = new Function(
  "name",
  `return (${expr});`,
) as (name: string) => string;

/** All character ranges the contract guarantees stripped. */
const STRIPPED_RANGES: Array<[number, number, string]> = [
  [0x00, 0x1f, "control C0"],
  [0x7f, 0x9f, "DEL + C1 control"],
  [0x200b, 0x200f, "zero-width / directional format"],
  [0x202a, 0x202e, "RTL embedding / isolate marks"],
  [0x2066, 0x2069, "directional isolates"],
  [0xfeff, 0xfeff, "BOM"],
];

describe("security: sanitizeFilename strips control / format / RTL chars", () => {
  describe("each character in each range is removed individually", () => {
    for (const [lo, hi, label] of STRIPPED_RANGES) {
      for (let cp = lo; cp <= hi; cp++) {
        // Sample one in 4 to keep the suite fast; the property holds for
        // all code points in the range by regex construction.
        if ((cp - lo) % Math.max(1, Math.floor((hi - lo + 1) / 8)) !== 0 && cp !== hi) continue;
        it(`strips U+${cp.toString(16).toUpperCase().padStart(4, "0")} (${label})`, () => {
          const input = `prefix${String.fromCodePoint(cp)}suffix`;
          const out = sanitizeFilename(input);
          expect(out).not.toContain(String.fromCodePoint(cp));
        });
      }
    }
  });

  it("strips a BOM that V8 \\s would otherwise preserve (regression for U+FEFF)", () => {
    // Before the fix, "my\uFEFFfile" → "my-file" — V8's \\s regex class
    // matched U+FEFF (BOM), so the negated [^\w\s-] gate let it through
    // and the subsequent \s+→- replace turned it into a literal dash.
    // After the fix, BOM is in the explicit-strip range, so it's gone
    // entirely and the two words collapse together.
    expect(sanitizeFilename("my\uFEFFfile")).not.toContain("\uFEFF");
    expect(sanitizeFilename("my\uFEFFfile")).toBe("myfile");
  });

  it("strips every stripped range even when wrapped in regular chars", () => {
    const name = "proj" +
      "\u0000" +
      "ect" +
      "\u200B" +
      "name" +
      "\u202E" +
      "rtl" +
      "\uFEFF" +
      ".wav";
    const out = sanitizeFilename(name);
    expect(out).not.toMatch(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/);
    // The remaining chars collapse to the word + dash glue.
    expect(out.startsWith("projectname")).toBe(true);
  });

  describe("fuzz: random injection of stripped chars produces no survivors", () => {
    it("50+ random inputs all pass the no-stripped-char invariant", () => {
      const strippedChars: string[] = [];
      for (const [lo, hi] of STRIPPED_RANGES) {
        for (let cp = lo; cp <= hi; cp++) strippedChars.push(String.fromCodePoint(cp));
      }
      const fillers = ["abc", "test", "My Beat", "drop-2026", "song (v2)", "KYX track"];
      const stripRegex = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;
      for (let i = 0; i < 60; i++) {
        const filler = fillers[Math.floor(Math.random() * fillers.length)];
        // Inject 1–5 random stripped chars at random positions.
        const chars: string[] = [];
        for (let j = 0; j < 1 + Math.floor(Math.random() * 5); j++) {
          chars.push(strippedChars[Math.floor(Math.random() * strippedChars.length)]);
        }
        const input = chars.join("") + filler + chars.reverse().join("");
        const out = sanitizeFilename(input);
        expect(stripRegex.test(out)).toBe(false);
      }
    });
  });

  describe("positive controls: ordinary names pass through cleanly", () => {
    it("ASCII letters / digits / spaces / hyphens preserved (collapsed)", () => {
      expect(sanitizeFilename("My Beat 2026")).toBe("My-Beat-2026");
    });

    it("falls back to 'project' on fully-stripped input", () => {
      // All chars in the input are in the stripped range.
      const input = "\u0000\u200B\u202E\uFEFF";
      expect(sanitizeFilename(input)).toBe("project");
    });

    it("truncates to 60 chars", () => {
      const long = "a".repeat(200);
      expect(sanitizeFilename(long).length).toBe(60);
    });
  });
});