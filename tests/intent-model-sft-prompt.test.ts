import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ollamaSystemPrompt } from "../src/intent/model-ollama";

/**
 * SFT PROMPT DRIFT GUARD — the fine-tune trains on the system prompt in
 * scripts/data/intent-sft/prompt.txt; the tuned model must see the IDENTICAL
 * prompt at inference. If the provider's prompt changes, this test fails and
 * the trainer must be re-run (scripts/write-intent-sft-prompt.mts + retrain).
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const promptPath = path.join(ROOT, "scripts", "data", "intent-sft", "prompt.txt");

describe("SFT prompt pin", () => {
  it("prompt.txt exists (run scripts/write-intent-sft-prompt.mts before training)", () => {
    expect(existsSync(promptPath)).toBe(true);
  });

  it("the Ollama provider sends the exact prompt the SFT model was trained on", () => {
    const pinned = readFileSync(promptPath, "utf8");
    expect(pinned.length).toBeGreaterThan(100);
    expect(ollamaSystemPrompt()).toBe(pinned);
  });
});
