/**
 * Insert a raw TypeScript block into a groove data file, immediately before
 * the closing `];` of the groove array literal.
 *
 * Idempotent — refuses to insert if a sentinel string is already present.
 * CRLF-safe — preserves the file's existing EOL style.
 *
 * Usage: node scripts/insert-groove-block.mjs <file> <blockFile> [sentinel]
 *   <file>       e.g. src/ai/grooves/ambient.ts
 *   <blockFile>  path to a .ts file holding the object literal + trailing comma
 *   <sentinel>   optional unique id string; if found in <file>, skip
 */
import { readFileSync, writeFileSync } from "node:fs";

const [, , targetFile, blockFile, sentinel] = process.argv;
if (!targetFile || !blockFile) {
  console.error("Usage: node scripts/insert-groove-block.mjs <file> <blockFile> [sentinel]");
  process.exit(2);
}

const raw = readFileSync(targetFile, "utf8");
if (sentinel && raw.includes(sentinel)) {
  console.log(`[insert-groove-block] sentinel "${sentinel}" already in ${targetFile} — skipping.`);
  process.exit(0);
}

const block = readFileSync(blockFile, "utf8").replace(/\s+$/, "");

const eol = raw.includes("\r\n") ? "\r\n" : "\n";
const lines = raw.split(/\r?\n/);

// Find the LAST line whose trimmed value is "];" — the groove array terminator.
let closeIdx = -1;
for (let i = lines.length - 1; i >= 0; i--) {
  if (lines[i].trim() === "];") {
    closeIdx = i;
    break;
  }
}
if (closeIdx === -1) {
  console.error(`[insert-groove-block] no "];" terminator found in ${targetFile}`);
  process.exit(1);
}

const blockLines = block.split(/\r?\n/);
lines.splice(closeIdx, 0, ...blockLines, "");
writeFileSync(targetFile, lines.join(eol), "utf8");
console.log(`[insert-groove-block] inserted ${blockLines.length} lines into ${targetFile}`);
