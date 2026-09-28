/**
 * Shorten only the internal keys of the static ArtistPreset source table.
 * decodeArtistPresets() restores the unchanged public object shape at runtime.
 * Run `node scripts/compact-artist-presets.mjs --write` after editing it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FILE = resolve(ROOT, "src/intent/artists.ts");
const WRITE = process.argv.includes("--write");
const source = readFileSync(FILE, "utf8");
const sourceFile = ts.createSourceFile(FILE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const aliases = new Map([
  ["names", "n"],
  ["genre", "g"],
  ["style", "s"],
  ["productionProfile", "p"],
  ["mood", "m"],
  ["energy", "e"],
  ["density", "d"],
  ["bpmRange", "b"],
  ["flow", "f"],
  ["label", "l"],
  ["fx", "x"],
]);
const compactKeys = new Set(aliases.values());
let declaration;

function locate(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "ARTIST_PRESETS") {
    declaration = node;
  }
  ts.forEachChild(node, locate);
}
locate(sourceFile);
if (!declaration?.initializer) throw new Error("Could not find ARTIST_PRESETS initializer");

const wrapped =
  ts.isCallExpression(declaration.initializer) &&
  ts.isIdentifier(declaration.initializer.expression) &&
  declaration.initializer.expression.text === "decodeArtistPresets";
const rows = wrapped ? declaration.initializer.arguments[0] : declaration.initializer;
if (!rows || !ts.isArrayLiteralExpression(rows)) throw new Error("Unexpected ARTIST_PRESETS source shape");

const edits = [];
let presetCount = 0;
let keyCount = 0;
let savedCharacters = 0;
let aliasCount = 0;
for (const preset of rows.elements) {
  if (!ts.isObjectLiteralExpression(preset)) throw new Error("Expected an artist preset object");
  presetCount++;
  const seen = new Set();
  for (const property of preset.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) {
      throw new Error("Unexpected artist preset property syntax");
    }
    const oldName = property.name.text;
    const alias = aliases.get(oldName);
    if (!alias && !compactKeys.has(oldName)) throw new Error(`Unknown ArtistPreset key ${oldName}`);
    const nextName = alias ?? oldName;
    if (seen.has(nextName)) throw new Error(`Duplicate compact ArtistPreset key ${nextName}`);
    seen.add(nextName);
    if (alias) {
      const from = property.name.getStart(sourceFile);
      const to = property.name.getEnd();
      edits.push({ from, to, text: alias });
      savedCharacters += oldName.length - alias.length;
      keyCount++;
    }
    if (nextName === "n" && ts.isArrayLiteralExpression(property.initializer)) {
      if (wrapped && ts.isStringLiteral(property.initializer)) continue;
      const names = property.initializer.elements.map((element) => {
        if (!ts.isStringLiteral(element)) throw new Error("Artist aliases must remain plain strings");
        if (element.text.includes("|") || element.text.includes("~")) {
          throw new Error("Artist alias contains a reserved compact-name delimiter");
        }
        return element.text.endsWith(" type beat") ? `${element.text.slice(0, -10)}~` : element.text;
      });
      const compactValue = JSON.stringify(names.join("|"));
      const from = property.initializer.getStart(sourceFile);
      const to = property.initializer.getEnd();
      edits.push({ from, to, text: compactValue });
      savedCharacters += property.initializer.getText(sourceFile).length - compactValue.length;
      aliasCount++;
    } else if (nextName === "n" && !ts.isStringLiteral(property.initializer)) {
      throw new Error("Compact artist aliases must be a pipe-delimited string");
    }
  }
  for (const required of ["n", "g", "l"]) {
    if (!seen.has(required)) throw new Error(`ArtistPreset is missing required compact key ${required}`);
  }
}

if (wrapped && keyCount === 0 && aliasCount === 0) {
  console.log(`Verified ${presetCount} compact artist presets; no changes needed.`);
} else if (!WRITE) {
  console.error(
    `Found ${presetCount} artist presets with ${keyCount} long keys and ${aliasCount} expanded alias lists. ` +
      "Re-run with --write to compact them.",
  );
  process.exit(1);
} else {
  if (!wrapped) {
    edits.push({ from: rows.getStart(sourceFile), to: rows.getStart(sourceFile), text: "decodeArtistPresets(" });
    edits.push({ from: rows.getEnd(), to: rows.getEnd(), text: ")" });
  }
  edits.sort((a, b) => b.from - a.from || b.to - a.to);
  let output = source;
  for (const edit of edits) output = output.slice(0, edit.from) + edit.text + output.slice(edit.to);
  writeFileSync(FILE, output, "utf8");
  console.log(`Compacted ${presetCount} artist presets (${keyCount} keys, ${savedCharacters} characters saved).`);
}
