/**
 * Losslessly compact the static melodic sequence literals.
 *
 * Run `node scripts/compact-melodic-data.mjs --write` after editing the
 * melodic reference data. Each note is round-trip checked before the source
 * file is changed; runtime decoding is covered by groove regression tests.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DATA_FILE = resolve(ROOT, "src/ai/grooves/melodic-data.ts");
const CODEC_FILE = resolve(ROOT, "src/ai/grooves/melodic-codec.ts");
const WRITE = process.argv.includes("--write");
const source = readFileSync(DATA_FILE, "utf8");
const codecSource = readFileSync(CODEC_FILE, "utf8");
const sourceFile = ts.createSourceFile(DATA_FILE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const codecFile = ts.createSourceFile(CODEC_FILE, codecSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const readConstant = (name) => {
  for (const statement of codecFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name || !declaration.initializer) continue;
      let initializer = declaration.initializer;
      while (ts.isAsExpression(initializer) || ts.isParenthesizedExpression(initializer)) {
        initializer = initializer.expression;
      }
      if (ts.isStringLiteral(initializer)) return initializer.text;
      if (ts.isArrayLiteralExpression(initializer)) {
        return initializer.elements.map((element) => {
          if (ts.isNumericLiteral(element)) return Number(element.text);
          if (ts.isPrefixUnaryExpression(element) && ts.isNumericLiteral(element.operand)) {
            return element.operator === ts.SyntaxKind.MinusToken
              ? -Number(element.operand.text)
              : Number(element.operand.text);
          }
          throw new Error(`Unexpected value in ${name}`);
        });
      }
    }
  }
  throw new Error(`Could not read ${name} from melodic-codec.ts`);
};

const ALPHABET = readConstant("MELODIC_CODEC_ALPHABET");
const DEGREES = readConstant("MELODIC_DEGREES");
const DURATIONS = readConstant("MELODIC_DURATIONS");
const VELOCITIES = readConstant("MELODIC_VELOCITIES");
if (ALPHABET.length !== 64 || ![DEGREES, DURATIONS, VELOCITIES].every(Array.isArray)) {
  throw new Error("Unexpected melodic codec configuration");
}

const encodeSequence = (sequence) => {
  let encoded = "";
  for (const note of sequence) {
    const degreeIndex = DEGREES.indexOf(note.degree);
    const durationIndex = DURATIONS.indexOf(note.duration);
    const velocityIndex = VELOCITIES.indexOf(note.velocity);
    if (degreeIndex < 0 || durationIndex < 0 || velocityIndex < 0) {
      throw new Error(`Unsupported melodic note ${note.degree}/${note.duration}/${note.velocity}`);
    }
    const code = (degreeIndex * DURATIONS.length + durationIndex) * VELOCITIES.length + velocityIndex;
    encoded += ALPHABET[Math.floor(code / ALPHABET.length)] + ALPHABET[code % ALPHABET.length];
  }
  return encoded;
};

const decodeSequence = (encoded) => {
  if (encoded.length % 2 !== 0) throw new Error("Encoded sequence has an incomplete note");
  const notes = [];
  for (let offset = 0; offset < encoded.length; offset += 2) {
    const high = ALPHABET.indexOf(encoded[offset]);
    const low = ALPHABET.indexOf(encoded[offset + 1]);
    const code = high * ALPHABET.length + low;
    if (high < 0 || low < 0 || code >= DEGREES.length * DURATIONS.length * VELOCITIES.length) {
      throw new Error(`Invalid encoded melodic note at offset ${offset}`);
    }
    const velocityIndex = code % VELOCITIES.length;
    const durationAndDegree = Math.floor(code / VELOCITIES.length);
    const durationIndex = durationAndDegree % DURATIONS.length;
    const degreeIndex = Math.floor(durationAndDegree / DURATIONS.length);
    notes.push({
      degree: DEGREES[degreeIndex],
      duration: DURATIONS[durationIndex],
      velocity: VELOCITIES[velocityIndex],
    });
  }
  return notes;
};

const numberValue = (node) => {
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
    return node.operator === ts.SyntaxKind.MinusToken ? -Number(node.operand.text) : Number(node.operand.text);
  }
  return null;
};

const readNote = (node) => {
  if (!ts.isObjectLiteralExpression(node)) return null;
  const values = new Map();
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) continue;
    const value = numberValue(property.initializer);
    if (value !== null) values.set(property.name.text, value);
  }
  if (!["degree", "duration", "velocity"].every((key) => values.has(key))) return null;
  return { degree: values.get("degree"), duration: values.get("duration"), velocity: values.get("velocity") };
};

const replacements = [];
let sequenceCount = 0;
let noteCount = 0;
let sourceBytes = 0;
let packedBytes = 0;
let wrappedSequenceCount = 0;
const visit = (node) => {
  if (
    ts.isPropertyAssignment(node) &&
    (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
    node.name.text === "sequences"
  ) {
    if (
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "decodeMelodicSequences"
    ) {
      wrappedSequenceCount +=
        node.initializer.arguments[0] && ts.isArrayLiteralExpression(node.initializer.arguments[0])
          ? node.initializer.arguments[0].elements.length
          : 0;
      return;
    }
    if (!ts.isArrayLiteralExpression(node.initializer)) throw new Error("Unexpected melodic sequences initializer");

    const encoded = [];
    for (const sequence of node.initializer.elements) {
      if (!ts.isArrayLiteralExpression(sequence)) throw new Error("Expected a melodic note sequence array");
      const notes = sequence.elements.map(readNote);
      if (notes.some((note) => note === null)) throw new Error("Unsupported data inside a melodic note sequence");
      const packed = encodeSequence(notes);
      const decoded = decodeSequence(packed);
      if (JSON.stringify(decoded) !== JSON.stringify(notes)) throw new Error("Melodic note round-trip mismatch");
      encoded.push(packed);
      sequenceCount++;
      noteCount += notes.length;
      sourceBytes += sequence.getText(sourceFile).length;
      packedBytes += JSON.stringify(packed).length;
      replacements.push({ from: sequence.getStart(sourceFile), to: sequence.getEnd(), text: JSON.stringify(packed) });
    }
    replacements.push({
      from: node.initializer.getStart(sourceFile),
      to: node.initializer.getStart(sourceFile),
      text: "decodeMelodicSequences(",
    });
    replacements.push({ from: node.initializer.getEnd(), to: node.initializer.getEnd(), text: ")" });
    if (encoded.length !== node.initializer.elements.length) throw new Error("Melodic sequence count mismatch");
  }
  ts.forEachChild(node, visit);
};
visit(sourceFile);

if (replacements.length === 0) {
  if (wrappedSequenceCount > 0 && !source.includes('import { decodeMelodicSequences } from "./melodic-codec";')) {
    throw new Error("Compacted sequences are missing the melodic decoder import");
  }
  console.log("Verified melodic data is already compact; no changes needed.");
} else if (!WRITE) {
  console.error(`Found ${sequenceCount} melodic sequences (${noteCount} notes). Re-run with --write to compact them.`);
  process.exit(1);
} else {
  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  const lastImport = imports[imports.length - 1];
  if (!lastImport) throw new Error("No imports found in melodic-data.ts");
  const lineEnd = source.indexOf("\n", lastImport.end);
  const importPosition = lineEnd < 0 ? lastImport.end : lineEnd + 1;
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  replacements.push({
    from: importPosition,
    to: importPosition,
    text: `import { decodeMelodicSequences } from "./melodic-codec";${newline}`,
  });
  replacements.sort((a, b) => b.from - a.from || b.to - a.to);
  let output = source;
  for (const replacement of replacements) {
    output = output.slice(0, replacement.from) + replacement.text + output.slice(replacement.to);
  }
  writeFileSync(DATA_FILE, output, "utf8");
  console.log(
    `Compacted ${sequenceCount} melodic sequences (${noteCount} notes); ${sourceBytes} source bytes → ` +
      `${packedBytes} packed bytes (${sourceBytes - packedBytes} bytes saved).`,
  );
}
