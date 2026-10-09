import {
  getIntentModelProvider,
  setIntentModelProvider,
  tryModelRoute,
  type IntentModelProvider,
} from "./model-resolver";
import { toJsonObjectSchema } from "./model-schema";
void toJsonObjectSchema; // kept exported for the manifest grammar pin + tests
import type { ProjectDocument } from "../project-model/types";

/**
 * LOCAL INTENT MODEL — OLLAMA PROVIDER (desktop path, pipeline step [C]).
 *
 * Ollama runs llama.cpp-class models as a native local server
 * (http://127.0.0.1:11434). This adapter bridges it into the SAME injectable
 * provider contract the artifact loader uses — the resolver bridge, the
 * validators and the executors cannot tell the backends apart, and every
 * output still passes `validateModelAction` → adapters → canonical commands.
 *
 * This is the DESKTOP path (a native side process the user installed), not
 * the web-offline path — the browser artifact loader (ONNX now, wllama-GGUF
 * later) remains the primary source and wins provider ties. ACTIVE BY
 * DEFAULT (2026-10-01): the SFT model below answers only when the local
 * Ollama server actually has it — the probe is the real gate — and every
 * output still passes `validateModelAction` → adapters → canonical commands.
 * `localStorage["pf:intent-model-ollama"] = "off"` is the kill switch;
 * a model-routed action always announces itself (🤖 status in the panel).
 *
 * The DEFAULT_MODEL is `kyx-intent-v33-q8`: LFM2.5-1.2B-Instruct + LoRA
 * r32/α64, 4 epochs on the 1790-pair wave-8 corpus, in Q8_0.
 *
 * Measured 2026-10-09 on the FULL 298-row val, all four candidates on one
 * instrument (scripts/eval-ollama-intent.mts --limit 298, each model warmed
 * before measuring so the cold VRAM load could not pollute the result):
 *
 *   model              quant  attempted-exact   wrongKind  abstain   VRAM
 *   kyx-intent-v30-q8  Q8_0      215/240 89.6%   7        58/298   1.71 GB
 *   kyx-intent-v31     F16       219/240 91.3%   6        58/298   2.64 GB
 *   kyx-intent-v33     F16       219/239 91.6%   3        59/298   2.73 GB
 *   kyx-intent-v33-q8  Q8_0      220/240 91.7%   3        58/298   1.71 GB   <-- default
 *
 * The previous default (v30-q8) was the WEAKEST of the four. Its claimed
 * 95.6%/wrongKind 0/abstain 1 and 92.5%/abstain 0.7% never reproduced: it
 * measures 89.6% with wrongKind 7 and abstain 58/298 here, and two
 * independent runs gave byte-identical numbers, so this is the instrument
 * being deterministic, not the docs being close.
 *
 * v33-q8 wins on every metric at the SAME VRAM and disk footprint as the old
 * default, which is what made v30-q8 attractive in the first place (f16 fights
 * everything else for VRAM on the 6GB card).
 *
 * Pinned evidence, one report per model:
 *   scripts/data/intent-sft/lfm-eval-{v30-q8,v31,v33,v33-q8}-2026-10-09.json
 * The few-shot examples below are PART OF THE TRAINING PROMPT (prompt.txt is
 * built from them) — never edit them without retraining.
 */

export type OllamaIntentMode = "off" | "on";

const OLLAMA_BASE = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "kyx-intent-v33-q8";
const PROBE_TIMEOUT_MS = 10_000; // a busy machine (training, model import, inference) can stall the loopback probe — 3s was measurably too tight
const GENERATE_TIMEOUT_MS = 45_000; // the FIRST generate on a cold server pays the VRAM model load (2.3GB f16 ≫ 20s once); keep_alive keeps the rest fast

export const OLLAMA_FLAG = "pf:intent-model-ollama";
export const OLLAMA_MODEL_FLAG = "pf:intent-model-ollama-model";

let modeOverride: OllamaIntentMode | null = null;

/** Test/shadow hook: force the mode regardless of localStorage (node has no
 * storage; mirrors the semantic client's override pattern). */
export function setOllamaIntentModeOverride(mode: OllamaIntentMode | null): void {
  modeOverride = mode;
}

export function ollamaIntentMode(): OllamaIntentMode {
  if (modeOverride) return modeOverride;
  try {
    // kill switch only — the probe (server + model presence) is the real
    // gate, so the default is ACTIVE: machines without Ollama fail the
    // probe in milliseconds and everything falls back unchanged
    if (localStorage.getItem(OLLAMA_FLAG) === "off") return "off";
  } catch {
    /* storage blocked — default below */
  }
  return "on";
}

export function setOllamaIntentMode(mode: OllamaIntentMode): void {
  try {
    if (mode === "off") localStorage.setItem(OLLAMA_FLAG, "off");
    else localStorage.removeItem(OLLAMA_FLAG);
  } catch {
    /* storage blocked — the in-session flip below still works */
  }
  if (mode === "off") void disableOllamaIntentProvider();
}

export function ollamaIntentModel(): string {
  try {
    const value = localStorage.getItem(OLLAMA_MODEL_FLAG);
    if (value) return value;
  } catch {
    /* storage blocked — default below */
  }
  return DEFAULT_MODEL;
}

export function setOllamaIntentModel(name: string): void {
  try {
    localStorage.setItem(OLLAMA_MODEL_FLAG, name);
  } catch {
    /* storage blocked — the in-session value below still applies */
  }
  ollamaModelOverride = name;
}
let ollamaModelOverride: string | null = null;

/** Few-shot examples — golden corpus pairs, teacher-verified (pinned
 * literals so the prompt is byte-stable; update alongside the corpus). */
const FEW_SHOT: Array<{ instruction: string; action: Record<string, unknown> }> = [
  {
    instruction: "turn down the drums",
    action: { kind: "fader", intent: { targets: ["drums"], pads: [], direction: "down", amount: "normal" } },
  },
  {
    instruction: "viac delayu na leade",
    action: {
      kind: "effectIntent",
      intent: { effectType: "delay", targets: ["lead"], direction: "more", amount: "medium", detected: ["AI"] },
    },
  },
  {
    instruction: "set tempo to 140",
    action: { kind: "exact", ops: [{ kind: "tempo", bpm: 140 }] },
  },
];

/** The exact system prompt the provider sends — exported so the SFT
 * trainer (scripts/train-intent-sft.py) trains on the IDENTICAL prompt the
 * tuned model will see at inference; tests/intent-model-sft-prompt.test.ts
 * pins the two together via scripts/data/intent-sft/prompt.txt. */
export function ollamaSystemPrompt(): string {
  return systemPromptInternal();
}

function systemPromptInternal(): string {
  const examples = FEW_SHOT.map(
    (shot) => `Instruction: ${shot.instruction}\nAction: ${JSON.stringify(shot.action)}`,
  ).join("\n\n");
  return (
    "You map a music-production instruction (English or Slovak) to ONE canonical KYX action JSON object. " +
    'Output only the JSON object, no prose. Use "clarify" with suggestions when the ask is ambiguous.\n\n' +
    `Examples:\n${examples}`
  );
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string }>;
}

interface OllamaChatResponse {
  message?: { content?: string };
  error?: string;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), timeoutMs);
  try {
    return await fetch(url, controller ? { ...init, signal: controller.signal } : init);
  } finally {
    clearTimeout(timer);
  }
}

/** Probe the local server + model presence. Null = Ollama not usable. */
export async function probeOllama(): Promise<string | null> {
  try {
    const response = await fetchWithTimeout(`${OLLAMA_BASE}/api/tags`, { method: "GET" }, PROBE_TIMEOUT_MS);
    if (!response.ok) return null;
    const tags = (await response.json()) as OllamaTagsResponse;
    const wanted = ollamaModelOverride ?? ollamaIntentModel();
    const present = (tags.models ?? []).some((entry) => entry.name === wanted || entry.name?.startsWith(`${wanted}:`));
    return present ? wanted : null;
  } catch {
    return null;
  }
}

async function generate(instruction: string, _doc: ProjectDocument): Promise<string> {
  const model = ollamaModelOverride ?? ollamaIntentModel();
  const response = await fetchWithTimeout(
    `${OLLAMA_BASE}/api/chat`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: "30m",
        // NO format constraint: measured 2026-09-29 — the JSON-schema grammar
        // FLIPS the SFT'd model's kind distribution (fader→clarify, 90%
        // in-process greedy collapsing to 2-9% through the schema path).
        // The fine-tune already emits valid teacher-shaped JSON greedily;
        // validateModelAction downstream remains the legality gate.
        //
        // num_predict stays >= 300 per SFT runbook §8 "Grammar responses need
        // tokens" (80 truncates schema-forced JSON). Note: raising 256 → 384
        // on 2026-10-09 changed NOTHING measurable — the smoke script's
        // `[${JSON.stringify(parsed).slice(0, 90)}]` preview looked like a
        // mid-value cut, but the raw output was already fully parsed and
        // schema-legal (8/8). The two apparent failures there are a wrong
        // routed `kind` from tryModelRoute, not a token budget problem. Do
        // not "fix" this number again on the strength of that preview.
        options: { temperature: 0, num_predict: 384 },
        messages: [
          { role: "system", content: systemPromptInternal() },
          { role: "user", content: instruction },
        ],
      }),
    },
    GENERATE_TIMEOUT_MS,
  );
  if (!response.ok) throw new Error(`ollama chat failed (${response.status})`);
  const payload = (await response.json()) as OllamaChatResponse;
  const content = payload.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error(payload.error ?? "empty ollama completion");
  return content;
}

/**
 * Register the Ollama provider when the flag is on and the server has the
 * model. Idempotent, never overwrites an already-registered provider (the
 * artifact loader wins ties), never throws. Resolves the model name or null.
 */
export async function ensureOllamaIntentProvider(): Promise<string | null> {
  if (ollamaIntentMode() === "off") return null;
  if (getIntentModelProvider()) return null;
  const model = await probeOllama();
  if (!model) return null;
  const provider: IntentModelProvider = {
    id: `ollama.${model}`,
    version: "ollama-structured-v1",
    generate,
  };
  setIntentModelProvider(provider);
  return model;
}

export async function disableOllamaIntentProvider(): Promise<void> {
  const active = getIntentModelProvider();
  if (active?.id.startsWith("ollama.")) setIntentModelProvider(null);
}

/** Test/diagnostic hook — is the CURRENT provider the Ollama one? */
export function ollamaProviderActive(): boolean {
  return getIntentModelProvider()?.id.startsWith("ollama.") === true;
}

/** Re-export for panel/debug surfaces that want one canonical entry point. */
export { tryModelRoute };
