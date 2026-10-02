import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileCreativeTaskHumanTrainingCorpus,
  HumanCorpusValidationError,
  MAX_REVIEW_CORPUS_BYTES,
} from "./creative-task-human-corpus";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRIVATE_ROOT = path.join(ROOT, ".sft", "creative-human-review");
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function parseArgs(args: string[]): { inputArg: string; name: string } {
  let inputArg: string | undefined;
  let name: string | undefined;
  let confirmed = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--input" && args[index + 1]) inputArg = args[++index];
    else if (arg === "--name" && args[index + 1]) name = args[++index];
    else if (arg === "--confirm-training-consent") confirmed = true;
    else throw new Error("Expected --input, --name, and --confirm-training-consent; no other options are accepted.");
  }
  if (!inputArg || !name || !confirmed || !NAME_PATTERN.test(name)) {
    throw new Error(
      "Usage: npm run creative-task:human-training-compile -- --input .sft/creative-human-review/reviewed.jsonl --name run-01 --confirm-training-consent",
    );
  }
  return { inputArg, name };
}

function main(): void {
  const { inputArg, name } = parseArgs(process.argv.slice(2));
  let privateRoot: string;
  let inputPath: string;
  try {
    privateRoot = realpathSync(PRIVATE_ROOT);
    inputPath = realpathSync(path.resolve(process.cwd(), inputArg));
  } catch {
    throw new Error("Private review input or its ignored .sft directory is unavailable.");
  }
  if (!isWithin(privateRoot, inputPath)) {
    throw new Error("Refusing review data outside the ignored .sft/creative-human-review directory.");
  }

  let input: Buffer;
  try {
    const info = statSync(inputPath);
    if (!info.isFile() || info.size > MAX_REVIEW_CORPUS_BYTES) {
      throw new Error("Review input must be a regular file no larger than 8 MiB.");
    }
    input = readFileSync(inputPath);
  } catch {
    throw new Error("Could not read the private review corpus.");
  }

  const compiled = compileCreativeTaskHumanTrainingCorpus(input);
  if (compiled.rows.train.length === 0 || compiled.rows.validation.length === 0) {
    throw new Error("Human SFT compilation requires non-empty train and validation splits; held-out stays excluded.");
  }

  const derivedRoot = path.join(privateRoot, "derived");
  mkdirSync(derivedRoot, { recursive: true });
  const realDerivedRoot = realpathSync(derivedRoot);
  const outputPath = path.join(realDerivedRoot, name);
  if (!isWithin(privateRoot, outputPath)) throw new Error("Refusing derived output outside the ignored private root.");
  mkdirSync(outputPath);

  const { rows, systemPrompt, ...manifest } = compiled;
  const files: ReadonlyArray<[string, string]> = [
    ["train.jsonl", `${rows.train.map((row) => JSON.stringify(row)).join("\n")}\n`],
    ["validation.jsonl", `${rows.validation.map((row) => JSON.stringify(row)).join("\n")}\n`],
    ["prompt.txt", systemPrompt],
    ["manifest.json", `${JSON.stringify(manifest, null, 2)}\n`],
  ];
  for (const [filename, content] of files) {
    writeFileSync(path.join(outputPath, filename), content, { encoding: "utf8", flag: "wx" });
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        task: compiled.task,
        sourceCorpusSha256: compiled.sourceCorpusSha256,
        outputDirectory: path.relative(ROOT, outputPath).split(path.sep).join("/"),
        trainRows: compiled.splits.train.rows,
        trainFamilies: compiled.splits.train.families.length,
        validationRows: compiled.splits.validation.rows,
        validationFamilies: compiled.splits.validation.families.length,
        heldOutRowsExcluded: compiled.heldOutRowsExcluded,
        rawExamplesPrinted: false,
        modelPromotionEligible: false,
      },
      null,
      2,
    )}\n`,
  );
}

try {
  main();
} catch (error) {
  if (error instanceof HumanCorpusValidationError) process.stderr.write(`${error.message}\n`);
  else if (error instanceof Error) process.stderr.write(`${error.message}\n`);
  else process.stderr.write("Human SFT compilation failed.\n");
  process.exitCode = 1;
}
