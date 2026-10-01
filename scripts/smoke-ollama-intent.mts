/**
 * REAL-SERVER SMOKE — the local Ollama LFM2 1.2B as the intent model [C].
 *
 * Requires: Ollama running + `ollama pull hf.co/LiquidAI/LFM2-1.2B-GGUF:Q4_K_M`.
 * Drives the PRODUCTION adapter (model-ollama.ts): structured outputs from
 * toJsonObjectSchema(), few-shot system prompt, then the full resolver bridge
 * (validateModelAction → adapters → RoutedIntent). Prints one verdict line
 * per instruction. This is a measurement, not a gate — the base model is
 * expected to be hit-or-miss; the SFT-tuned student is the real artifact.
 *
 * Run: npx vite-node scripts/smoke-ollama-intent.mts
 */
import { setOllamaIntentModeOverride, ensureOllamaIntentProvider } from "../src/intent/model-ollama";
import { getIntentModelProvider } from "../src/intent/model-resolver";
import { tryModelRoute } from "../src/intent/model-resolver";
import { validateModelAction } from "../src/intent/model-schema";
import { createProjectFromTemplate } from "../src/project-model/templates";

const CASES: Array<{ instruction: string; expect: string }> = [
  { instruction: "turn down the drums", expect: "fader" },
  { instruction: "zníž basu", expect: "fader" },
  { instruction: "more reverb on the lead", expect: "effectIntent" },
  { instruction: "set tempo to 140", expect: "exact" },
  { instruction: "mute the drums and zníž basu", expect: "compound" },
  { instruction: "make the bass deeper", expect: "production" },
  { instruction: "stop", expect: "transport" },
  { instruction: "more compression", expect: "clarify" },
];

const doc = createProjectFromTemplate("house");
setOllamaIntentModeOverride("on");
// registration retries: under machine load (vite transform storms, training)
// the first probe can time out — the eval scripts have always retried, this
// one silently didn't
let model: string | null = null;
for (let retry = 0; retry < 4 && !model; retry += 1) {
  model = await ensureOllamaIntentProvider();
  if (!model) await new Promise((resolve) => setTimeout(resolve, 1500));
}
if (!model) {
  console.error("ollama not reachable or model missing — check the server and the configured model:");
  console.error("  curl http://127.0.0.1:11434/api/tags   (default expectation: kyx-intent-v30)");
  process.exit(1);
}
console.log(`provider: ${getIntentModelProvider()?.id}\n`);

let schemaOK = 0;
let kindOK = 0;
let expected = 0;
for (const { instruction, expect } of CASES) {
  const provider = getIntentModelProvider();
  let raw = "";
  try {
    raw = await provider!.generate(instruction, doc);
  } catch (err) {
    console.log(`✗ "${instruction}" → generate failed: ${(err as Error).message}`);
    continue;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.log(`✗ "${instruction}" → not JSON: ${raw.slice(0, 80)}`);
    continue;
  }
  const validation = validateModelAction(parsed);
  if (!validation.valid) {
    console.log(`✗ "${instruction}" → schema-invalid: ${validation.errors[0]}`);
    continue;
  }
  schemaOK += 1;
  const route = await tryModelRoute(instruction, doc);
  const kind = route?.kind ?? "null";
  const mark = kind === expect ? "✓" : kind === "clarify" ? "~" : "✗";
  if (kind === expect) expected += 1;
  console.log(
    `${mark} "${instruction}" → ${kind}${route?.kind === "exact" && "plan" in route ? ` (${(route.plan as { ops: unknown[] }).ops.length} op)` : ""}   [${JSON.stringify(parsed).slice(0, 90)}]`,
  );
}

console.log(`\nschema-legal: ${schemaOK}/${CASES.length}   expected-kind: ${expected}/${CASES.length}`);
