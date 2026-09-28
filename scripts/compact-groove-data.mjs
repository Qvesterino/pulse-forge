/**
 * Losslessly compact the built-in groove velocity arrays into sparse strings.
 *
 * Run `node scripts/compact-groove-data.mjs --write` after editing groove
 * source. Every row is decoded and compared to its numeric source before any
 * file is changed; the normal build then exercises the runtime decoder.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const GROOVE_DIR = join(ROOT, "src", "ai", "grooves");
const COMPACT_MODULE = join(GROOVE_DIR, "compact.ts");
const WRITE = process.argv.includes("--write");
const sourceFiles = readdirSync(GROOVE_DIR).filter(
  (name) => name.endsWith(".ts") && name !== "index.ts" && name !== "dedup.ts" && name !== "compact.ts",
);

const compactSource = readFileSync(COMPACT_MODULE, "utf8");
const compactFile = ts.createSourceFile(COMPACT_MODULE, compactSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const getStringConstant = (name) => {
  for (const statement of compactFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name || !declaration.initializer) continue;
      let initializer = declaration.initializer;
      while (ts.isAsExpression(initializer) || ts.isParenthesizedExpression(initializer)) {
        initializer = initializer.expression;
      }
      if (ts.isStringLiteral(initializer)) return initializer.text;
      if (ts.isArrayLiteralExpression(initializer)) {
        return initializer.elements.map((element) => Number(element.getText(compactFile)));
      }
    }
  }
  throw new Error(`Could not read ${name} from src/ai/grooves/compact.ts`);
};

const ALPHABET = getStringConstant("GROOVE_CODEC_ALPHABET");
const VELOCITIES = getStringConstant("GROOVE_VELOCITIES");
if (ALPHABET.length !== 64 || !Array.isArray(VELOCITIES)) throw new Error("Unexpected groove codec configuration");

const encodeRow = (row) => {
  if (row.length >= ALPHABET.length) throw new Error(`Groove row too long: ${row.length}`);
  let encoded = ALPHABET[row.length];
  for (let position = 0; position < row.length; position++) {
    const velocity = row[position];
    if (velocity === 0) continue;
    const velocityIndex = VELOCITIES.indexOf(velocity);
    if (velocityIndex <= 0) throw new Error(`Velocity ${velocity} is missing from the compact palette`);
    encoded += `${ALPHABET[position]}${ALPHABET[velocityIndex]}`;
  }
  return encoded;
};

const decodeRow = (encoded) => {
  const length = ALPHABET.indexOf(encoded[0]);
  if (length < 0 || (encoded.length - 1) % 2 !== 0) throw new Error(`Invalid encoded groove row ${encoded}`);
  const row = new Array(length).fill(0);
  for (let offset = 1; offset < encoded.length; offset += 2) {
    const position = ALPHABET.indexOf(encoded[offset]);
    const velocity = VELOCITIES[ALPHABET.indexOf(encoded[offset + 1])];
    if (position < 0 || position >= length || velocity === undefined || velocity <= 0) {
      throw new Error(`Invalid hit in encoded groove row ${encoded}`);
    }
    row[position] = velocity;
  }
  return row;
};

const readNumberRow = (node, sourceFile) => {
  if (!ts.isArrayLiteralExpression(node) || !node.elements.every(ts.isNumericLiteral)) return null;
  return node.elements.map((element) => Number(element.text));
};

const filesToWrite = [];
let totalRows = 0;
let totalValues = 0;
let sourceBytes = 0;
let packedBytes = 0;

for (const name of sourceFiles) {
  const path = join(GROOVE_DIR, name);
  const source = readFileSync(path, "utf8");
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const alreadyCompacted = source.includes('import { decodeGrooves } from "./compact";');
  const replacements = [];
  let targetInitializer;

  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text.endsWith("_GROOVES")) {
      const wrapped =
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === "decodeGrooves";
      const initializer = wrapped ? node.initializer.arguments[0] : node.initializer;
      if (!initializer || !ts.isArrayLiteralExpression(initializer)) {
        throw new Error(`${name}: expected a groove array initializer`);
      }
      targetInitializer = initializer;
      for (const groove of initializer.elements) {
        if (!ts.isObjectLiteralExpression(groove)) continue;
        const patterns = groove.properties.find(
          (property) =>
            ts.isPropertyAssignment(property) &&
            (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
            property.name.text === "patterns",
        );
        if (!patterns || !ts.isPropertyAssignment(patterns) || !ts.isArrayLiteralExpression(patterns.initializer))
          continue;
        for (const pattern of patterns.initializer.elements) {
          if (!ts.isObjectLiteralExpression(pattern)) continue;
          for (const property of pattern.properties) {
            if (!ts.isPropertyAssignment(property)) continue;
            const row = readNumberRow(property.initializer, sourceFile);
            if (!row) continue;
            if (alreadyCompacted)
              throw new Error(`${name}: found an uncompressed numeric row alongside decoder import`);
            const encoded = encodeRow(row);
            const decoded = decodeRow(encoded);
            if (row.length !== decoded.length || row.some((velocity, index) => velocity !== decoded[index])) {
              throw new Error(`${name}: round-trip mismatch in a numeric groove row`);
            }
            const from = property.initializer.getStart(sourceFile);
            const to = property.initializer.getEnd();
            replacements.push({ from, to, text: JSON.stringify(encoded) });
            totalRows++;
            totalValues += row.length;
            sourceBytes += source.slice(from, to).length;
            packedBytes += JSON.stringify(encoded).length;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (alreadyCompacted) {
    if (replacements.length > 0) throw new Error(`${name}: partial compaction detected`);
    continue;
  }
  if (!targetInitializer || replacements.length === 0) continue;

  const firstImport = sourceFile.statements.find(ts.isImportDeclaration);
  if (!firstImport) throw new Error(`${name}: no import to insert the decoder after`);
  const importEnd = source.indexOf("\n", firstImport.end);
  const importPosition = importEnd < 0 ? firstImport.end : importEnd + 1;
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  replacements.push({
    from: targetInitializer.getStart(sourceFile),
    to: targetInitializer.getStart(sourceFile),
    text: "decodeGrooves(",
  });
  replacements.push({ from: targetInitializer.getEnd(), to: targetInitializer.getEnd(), text: ")" });
  replacements.push({
    from: importPosition,
    to: importPosition,
    text: `import { decodeGrooves } from "./compact";${newline}`,
  });
  replacements.sort((a, b) => b.from - a.from || b.to - a.to);

  let output = source;
  for (const replacement of replacements) {
    output = output.slice(0, replacement.from) + replacement.text + output.slice(replacement.to);
  }
  filesToWrite.push({ path, name, output, rows: replacements.length - 3 });
}

if (filesToWrite.length > 0 && !WRITE) {
  console.error(
    `Found ${totalRows} numeric groove rows in ${filesToWrite.length} files. Re-run with --write to compact them.`,
  );
  process.exit(1);
}
for (const file of filesToWrite) writeFileSync(file.path, file.output, "utf8");
console.log(
  `${WRITE ? "Compacted" : "Verified"} ${totalRows} velocity rows (${totalValues} values); ` +
    `${sourceBytes} source bytes → ${packedBytes} packed bytes (${sourceBytes - packedBytes} bytes saved) across ${filesToWrite.length} files.`,
);
