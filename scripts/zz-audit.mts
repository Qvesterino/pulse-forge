import { GROOVE_LIBRARY } from "../src/ai/grooves/index";
import { readFileSync } from "node:fs";

const src = readFileSync("src/intent/text-parser.ts", "utf8");

function extractBlock(name: string): Array<[string, string]> {
  const start = src.indexOf(`const ${name}`);
  const end = src.indexOf(`\n];`, start);
  const block = src.slice(start, end);
  const out: Array<[string, string]> = [];
  const re = /\[\s*(\/[^\n]*?\/[a-z]*)\s*,\s*"([^"]+)"\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) out.push([m[1], m[2]]);
  return out;
}

const stylePhrases = extractBlock("STYLE_PHRASES");
const genrePhrases = extractBlock("GENRE_PHRASES");
console.log("parsed STYLE_PHRASES:", stylePhrases.length, "GENRE_PHRASES:", genrePhrases.length);

const styles = [...new Set(stylePhrases.map(([, s]) => s))];
const grooveStyles = new Set(GROOVE_LIBRARY.map((g) => g.id.split(".")[1]));

console.log("\nDANGLING STYLE TOKENS (no groove id anywhere):");
const dangling = styles.filter((s) => !grooveStyles.has(s));
for (const s of dangling) console.log("  " + s);
console.log("total dangling:", dangling.length, "/", styles.length);

console.log("\nORPHAN GROOVES (no parser style token):");
const orphan = GROOVE_LIBRARY.filter((g) => !styles.includes(g.id.split(".")[1]));
for (const g of orphan) console.log(`  ${g.id} (name: "${g.name}")`);
console.log("total orphan:", orphan.length, "/", GROOVE_LIBRARY.length);

const genres = [...new Set(genrePhrases.map(([, g]) => g))];
const families = [...new Set(GROOVE_LIBRARY.map((g) => g.genre))];
console.log("\nGENRES IN PARSER:", genres.join(", "));
console.log("GROOVE FAMILIES:  ", families.join(", "));
console.log("parser genres missing a groove family:", genres.filter((g) => !families.includes(g as never)).join(", ") || "(none)");
