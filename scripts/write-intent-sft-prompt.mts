/**
 * Writes scripts/data/intent-sft/prompt.txt — the EXACT system prompt the
 * Ollama provider sends (src/intent/model-ollama.ts ollamaSystemPrompt()).
 * The SFT trainer reads this file and trains on it; the SFT prompt-pin test
 * fails if the two drift. Run before training whenever the prompt changes.
 * Run: npx vite-node scripts/write-intent-sft-prompt.mts
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ollamaSystemPrompt } from "../src/intent/model-ollama";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(ROOT, "scripts", "data", "intent-sft", "prompt.txt");
writeFileSync(out, ollamaSystemPrompt(), "utf8");
console.log(`prompt.txt written (${ollamaSystemPrompt().length} chars)`);
