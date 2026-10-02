import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HumanCorpusValidationError,
  MAX_REVIEW_CORPUS_BYTES,
  validateCreativeTaskHumanCorpus,
} from "./creative-task-human-corpus";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRIVATE_ROOT = path.join(ROOT, ".sft", "creative-human-review");

function main(): void {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--input" || !args[1]) {
    throw new Error(
      "Usage: npm run creative-task:human-review-validate -- --input .sft/creative-human-review/reviewed.jsonl",
    );
  }

  let privateRoot: string;
  let inputPath: string;
  try {
    privateRoot = realpathSync(PRIVATE_ROOT);
    inputPath = realpathSync(path.resolve(process.cwd(), args[1]));
  } catch {
    throw new Error("Private review input or its ignored .sft directory is unavailable.");
  }
  const relative = path.relative(privateRoot, inputPath);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("Refusing review data outside the ignored .sft/creative-human-review directory.");
  }

  let input: Buffer;
  try {
    if (!statSync(inputPath).isFile() || statSync(inputPath).size > MAX_REVIEW_CORPUS_BYTES) {
      throw new Error("Review input must be a regular file no larger than 8 MiB.");
    }
    input = readFileSync(inputPath);
  } catch {
    throw new Error("Could not read the private review corpus.");
  }
  const summary = validateCreativeTaskHumanCorpus(input);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  if (error instanceof HumanCorpusValidationError) {
    process.stderr.write(`${error.message}\n`);
  } else if (error instanceof Error) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write("Human review corpus validation failed.\n");
  }
  process.exitCode = 1;
}
