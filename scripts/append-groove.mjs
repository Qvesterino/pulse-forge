/**
 * Append a new groove to a groove data file (before the closing `];`).
 * Idempotent — refuses to append if the groove id already exists.
 *
 * Usage: node scripts/append-groove.mjs <file> <grooveJson>
 *   <file>       e.g. src/ai/grooves/ambient.ts
 *   <grooveJson> path to a .json file containing the GrooveData object
 *
 * CRLF-safe: operates on raw bytes, preserves the file's existing EOL style.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const [, , targetFile, jsonFile] = process.argv;
if (!targetFile || !jsonFile) {
  console.error("Usage: node scripts/append-groove.mjs <file> <grooveJson>");
  process.exit(2);
}

const raw = readFileSync(targetFile, "utf8");
const groove = JSON.parse(readFileSync(jsonFile, "utf8"));

if (raw.includes(`"${groove.id}"`)) {
  console.log(`[append-groove] ${groove.id} already present in ${targetFile} — skipping.`);
  process.exit(0);
}

// Match the file's existing EOL so we don't introduce mixed line endings.
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
const lines = raw.split(/\r?\n/);

// Find the LAST line that is exactly "];" (the GROOVE_LIBRARY terminator).
let closeIdx = -1;
for (let i = lines.length - 1; i >= 0; i--) {
  if (lines[i].trim() === "];") {
    closeIdx = i;
    break;
  }
}
if (closeIdx === -1) {
  console.error(`[append-groove] no top-level "];" terminator found in ${targetFile}`);
  process.exit(1);
}

const body = JSON.stringify(groove, null, 2)
  .split("\n")
  // Strip the outer braces — we splice the fields into the array literal.
  .slice(1, -1)
  .map((l) => "  " + l);

const block = ["  {", ...body.map((l) => (l.startsWith("  ") ? "  " + l : l)), "  },", ""];

lines.splice(closeIdx, 0, ...block);
writeFileSync(targetFile, lines.join(eol), "utf8");
console.log(`[append-groove] appended ${groove.id} to ${targetFile} (eol=${JSON.stringify(eol)})`);
