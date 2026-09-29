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
 * later) remains the primary source. Explicit opt-in:
 * `localStorage["pf:intent-model-ollama"] = "on"`. Structured outputs come
 * from `toJsonObjectSchema()` — the model cannot emit an action outside the
 * schema, the same guarantee GBNF gives llama.cpp-class runtimes.
 *
 * The BASE model (no KYX fine-tune) runs with a few-shot prompt built from
 * golden corpus pairs; the SFT-tuned model replaces the examples later
 * without touching this module.
 */

export type OllamaIntentMode = "off" | "on";

const OLLAMA_BASE = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "hf.co/LiquidAI/LFM2-1.2B-GGUF:Q4_K_M";
const PROBE_TIMEOUT_MS = 3000; // a busy machine (training, installs) can stall the loopback probe
const GENERATE_TIMEOUT_MS = 20_000;

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
    if (localStorage.getItem(OLLAMA_FLAG) === "on") return "on";
  } catch {
    /* storage blocked — default below */
  }
  return "off";
}

export function setOllamaIntentMode(mode: OllamaIntentMode): void {
  try {
    if (mode === "on") localStorage.setItem(OLLAMA_FLAG, "on");
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
        // NO format constraint: measured 2026-09-29 — the JSON-schema grammar
        // FLIPS the SFT'd model's kind distribution (fader→clarify, 90%
        // in-process greedy collapsing to 2-9% through the schema path).
        // The fine-tune already emits valid teacher-shaped JSON greedily;
        // validateModelAction downstream remains the legality gate.
        options: { temperature: 0, num_predict: 256 },
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
