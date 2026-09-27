/**
 * Remove a groove object (and its leading comment block) from a groove data
 * file, by groove id. CRLF-safe, idempotent.
 *
 * Usage: node scripts/remove-groove.mjs <file> <grooveId> [...]
 */
import { readFileSync, writeFileSync } from "node:fs";

const [, , targetFile, ...ids] = process.argv;
if (!targetFile || ids.length === 0) {
  console.error("Usage: node scripts/remove-groove.mjs <file> <grooveId> [...]");
  process.exit(2);
}

let src = readFileSync(targetFile, "utf8");
const before = src.length;

for (const id of ids) {
  const marker = `id: ${JSON.stringify(id)},`;
  const idx = src.indexOf(marker);
  if (idx === -1) {
    console.log(`[remove-groove] ${id} not present in ${targetFile} — skipping.`);
    continue;
  }

  // Walk back over the contiguous `// ...` comment lines that document the groove.
  let blockStart = src.lastIndexOf("\n", idx) + 1;
  for (;;) {
    const prevLineEnd = blockStart - 1; // index of the '\n' ending the previous line
    if (prevLineEnd < 0) break;
    const prevLineStart = src.lastIndexOf("\n", prevLineEnd - 1) + 1;
    const line = src.slice(prevLineStart, prevLineEnd).trim();
    if (line.startsWith("//")) blockStart = prevLineStart;
    else break;
  }

  // Walk forward to the groove object's own terminator: the first `\n  },`
  // (2-space indent) after the id marker.
  const closeMarker = "\n  },";
  const closeIdx = src.indexOf(closeMarker, idx);
  if (closeIdx === -1) {
    console.error(`[remove-groove] no object terminator found for ${id}`);
    process.exit(1);
  }
  let blockEnd = closeIdx + closeMarker.length;
  if (src[blockEnd] === "\n") blockEnd += 1;

  src = src.slice(0, blockStart) + src.slice(blockEnd);
  console.log(`[remove-groove] removed ${id} from ${targetFile}`);
}

writeFileSync(targetFile, src, "utf8");
console.log(`[remove-groove] ${targetFile}: ${before} -> ${src.length} bytes`);
