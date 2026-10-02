import { describe, it, expect, afterEach, vi } from "vitest";
import { toGbnfGrammar } from "../src/intent/model-schema";
import {
  buildIntentModelPrompt,
  isIntentModelManifest,
  manifestGrammarDrift,
  sha256Mismatch,
  type IntentModelManifest,
} from "../src/intent/model-loader-types";
import {
  ensureIntentModelProvider,
  intentModelMode,
  onIntentModelStateChange,
  resetIntentModelLoader,
  setIntentModelMode,
  setIntentModelTimeoutsForTests,
  setIntentModelWorkerFactoryForTests,
} from "../src/intent/model-loader";
import { getIntentModelProvider, setIntentModelProvider, tryModelRoute } from "../src/intent/model-resolver";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { IntentModelRequest, IntentModelResponse } from "../src/intent/model-loader-types";

/**
 * LOCAL INTENT MODEL — LOADER tests. The provider contract itself (adapt →
 * route → execute) is pinned by tests/intent-model-resolver.test.ts with
 * fake providers; THIS spec pins the loader around it: the OFF-by-default
 * flag, the availability probe, timeout budgets, the circuit breaker and
 * the provider registration — everything between "a trained model exists
 * on the origin" and "setIntentModelProvider got called".
 *
 * jsdom has no Worker and no model artifact: the worker seam is injected
 * (scripted fake), fetch is stubbed. The worker module's own message
 * handling is tested directly against self.onmessage.
 */

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const GRAMMAR_SHA = await sha256Hex(toGbnfGrammar());

function validManifest(overrides: Partial<IntentModelManifest> = {}): IntentModelManifest {
  return {
    intentModelVersion: "intent-model.v1",
    schemaVersion: 1,
    grammarSha256: GRAMMAR_SHA,
    runtime: { kind: "wllama-gguf", module: "/models/llm/runtime.js", export: "createIntentLlmRuntime" },
    model: { url: "/models/llm/intent-model-v1.q4_k_s.gguf", bytes: 8, sha256: "b".repeat(64) },
    prompt: { system: "SYSTEM", instructionTemplate: "TASK: {instruction}" },
    generation: { maxTokens: 96, temperature: 0 },
    report: { gatePassed: true },
    ...overrides,
  };
}

/** Scripted fake worker: handlers per message type, async replies. */
class FakeModelWorker {
  seen: IntentModelRequest[] = [];
  private listeners = new Map<string, EventListener>();
  onMessage: ((request: IntentModelRequest, reply: (response: IntentModelResponse) => void) => void) | null = null;
  terminated = false;
  postMessage(payload: IntentModelRequest): void {
    this.seen.push(payload);
    if (!this.onMessage) return;
    const reply = (response: IntentModelResponse) => {
      setTimeout(() => {
        const event = { data: response } as MessageEvent<IntentModelResponse>;
        this.listeners.get("message")?.(event as unknown as Event);
      }, 0);
    };
    this.onMessage(payload, reply);
  }
  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener);
  }
  removeEventListener(type: string): void {
    this.listeners.delete(type);
  }
  terminate(): void {
    this.terminated = true;
  }
}

afterEach(() => {
  resetIntentModelLoader();
  setIntentModelWorkerFactoryForTests(null);
  setIntentModelProvider(null);
  setIntentModelTimeoutsForTests(null);
  localStorage.removeItem("pf:intent-model");
  vi.unstubAllGlobals();
});

describe("manifest contract", () => {
  it("isIntentModelManifest accepts the pinned shape and rejects malformed manifests", () => {
    expect(isIntentModelManifest(validManifest())).toBe(true);
    expect(isIntentModelManifest({ ...validManifest(), grammarSha256: "nothex" })).toBe(false);
    expect(isIntentModelManifest({ ...validManifest(), schemaVersion: 0 })).toBe(false);
    expect(isIntentModelManifest({ ...validManifest(), model: { ...validManifest().model, bytes: 0 } })).toBe(false);
    expect(
      isIntentModelManifest({
        ...validManifest(),
        prompt: { ...validManifest().prompt, instructionTemplate: "no slot" },
      }),
    ).toBe(false);
    expect(isIntentModelManifest(null)).toBe(false);
  });

  it("manifestGrammarDrift passes for this build's grammar and refuses a stale pin", async () => {
    expect(await manifestGrammarDrift(validManifest())).toBeNull();
    const stale = validManifest({ grammarSha256: "0".repeat(64) });
    const drift = await manifestGrammarDrift(stale);
    expect(drift).toContain("grammar drift");
  });

  it("sha256Mismatch verifies weights before init", async () => {
    const weights = new TextEncoder().encode("weights!");
    const good = await sha256Hex(weights);
    expect(await sha256Mismatch(weights.buffer as ArrayBuffer, good)).toBeNull();
    expect(await sha256Mismatch(weights.buffer as ArrayBuffer, "0".repeat(64))).toContain("model hash mismatch");
  });

  it("buildIntentModelPrompt fills the instruction slot", () => {
    const prompt = buildIntentModelPrompt(validManifest(), "mute the drums");
    expect(prompt).toBe("SYSTEM\nTASK: mute the drums");
  });
});

describe("loader flag + probe", () => {
  it("the model is ON by default (gate-passed activation); explicit off persists and costs nothing", async () => {
    // Default ON since the 2026-10-01 release gate pass — the manifest's
    // gatePassed pin is the real gate; the flag only toggles intent.
    expect(intentModelMode()).toBe("on");
    setIntentModelMode("off");
    expect(intentModelMode()).toBe("off");
    const factory = vi.fn(() => null);
    setIntentModelWorkerFactoryForTests(factory);
    await expect(ensureIntentModelProvider()).resolves.toBe(false);
    expect(factory).not.toHaveBeenCalled();
    expect(getIntentModelProvider()).toBeNull();
  });

  it("a manifest WITHOUT a passed release gate is refused — a candidate is not an actor", async () => {
    setIntentModelMode("on");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(validManifest({ report: { gatePassed: false } }))),
    );
    const factory = vi.fn(() => null);
    setIntentModelWorkerFactoryForTests(factory);
    await expect(ensureIntentModelProvider()).resolves.toBe(false);
    expect(factory).not.toHaveBeenCalled(); // never even spawns the worker
    expect(getIntentModelProvider()).toBeNull();
  });

  it("a missing artifact memoizes unavailability — one 404 per session, not per prompt", async () => {
    setIntentModelMode("on");
    const fetchMock = vi.fn(async () => new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(ensureIntentModelProvider()).resolves.toBe(false);
    await expect(ensureIntentModelProvider()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getIntentModelProvider()).toBeNull();
  });
});

describe("loader registration + timeouts + breaker", () => {
  it("a scripted model registers the resolver provider and routes through it", async () => {
    setIntentModelMode("on");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(validManifest())),
    );
    const worker = new FakeModelWorker();
    worker.onMessage = (request, reply) => {
      if (request.type === "load") reply({ type: "load", requestId: request.requestId, ok: true });
      if (request.type === "generate") {
        reply({
          type: "generate",
          requestId: request.requestId,
          ok: true,
          text: JSON.stringify({ kind: "transport", action: "stop" }),
        });
      }
    };
    setIntentModelWorkerFactoryForTests(() => worker as unknown as Worker);
    await expect(ensureIntentModelProvider()).resolves.toBe(true);
    const provider = getIntentModelProvider();
    expect(provider?.id).toBe("pulse-forge.intent-model");
    expect(provider?.version).toBe("intent-model.v1");
    // The registered provider is the resolver bridge's input — a model-form
    // action adapts into a real RoutedIntent the executors consume.
    const doc = createProjectFromTemplate("house");
    const route = await tryModelRoute("halt everything now", doc);
    expect(route?.kind).toBe("transport");
    expect(worker.seen.some((request) => request.type === "generate")).toBe(true);
  });

  it("a generate timeout is a controlled miss, never a throw into the caller", async () => {
    setIntentModelMode("on");
    setIntentModelTimeoutsForTests({ generateMs: 25 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(validManifest())),
    );
    const worker = new FakeModelWorker();
    worker.onMessage = (request, reply) => {
      if (request.type === "load") reply({ type: "load", requestId: request.requestId, ok: true });
      // generate: never replies → warm timeout
    };
    setIntentModelWorkerFactoryForTests(() => worker as unknown as Worker);
    await expect(ensureIntentModelProvider()).resolves.toBe(true);
    const provider = getIntentModelProvider();
    expect(provider).not.toBeNull();
    const doc = createProjectFromTemplate("house");
    await expect(provider!.generate("anything", doc)).rejects.toThrow(/timeout/);
    await expect(tryModelRoute("halt everything now", doc)).resolves.toBeNull();
  });

  it("a cold load timeout does not trip the breaker — the next ensure recovers", async () => {
    setIntentModelMode("on");
    setIntentModelTimeoutsForTests({ coldLoadMs: 25 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(validManifest())),
    );
    let answerLoads = false;
    const worker = new FakeModelWorker();
    worker.onMessage = (request, reply) => {
      if (request.type === "load" && answerLoads) reply({ type: "load", requestId: request.requestId, ok: true });
    };
    setIntentModelWorkerFactoryForTests(() => worker as unknown as Worker);
    await expect(ensureIntentModelProvider()).resolves.toBe(false); // cold timeout
    expect(worker.terminated).toBe(false); // still loading in the background
    answerLoads = true; // weights land while we wait
    await expect(ensureIntentModelProvider()).resolves.toBe(true);
    expect(getIntentModelProvider()).not.toBeNull();
  });

  it("repeated load failures trip the circuit breaker for the session", async () => {
    setIntentModelMode("on");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(validManifest())),
    );
    let spawns = 0;
    setIntentModelWorkerFactoryForTests(() => {
      spawns += 1;
      const worker = new FakeModelWorker();
      worker.onMessage = (request, reply) => {
        if (request.type === "load") {
          reply({ type: "load", requestId: request.requestId, ok: false, error: "model artifact corrupt" });
        }
      };
      return worker as unknown as Worker;
    });
    await expect(ensureIntentModelProvider()).resolves.toBe(false);
    await expect(ensureIntentModelProvider()).resolves.toBe(false);
    const spawnsAfterBreaker = spawns;
    await expect(ensureIntentModelProvider()).resolves.toBe(false);
    expect(spawns).toBe(spawnsAfterBreaker); // worker no longer respawned
    expect(getIntentModelProvider()).toBeNull();
  });

  it("state transitions are observable for the panel chip", async () => {
    const states: string[] = [];
    setIntentModelMode("off");
    const unsubscribe = onIntentModelStateChange((state) => states.push(state));
    expect(states.at(-1)).toBe("off");
    setIntentModelMode("on");
    expect(states.at(-1)).toBe("unavailable");
    unsubscribe();
  });
});

describe("model worker message handling", () => {
  /** Drive the worker module directly: jsdom has self but no worker glue. */
  async function loadThroughWorker(manifest: IntentModelManifest, weights: Uint8Array): Promise<IntentModelResponse> {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(weights as unknown as BodyInit, { status: 200 })),
    );
    const replies: IntentModelResponse[] = [];
    (self as unknown as { postMessage: (message: IntentModelResponse) => void }).postMessage = (message) => {
      if (message.type !== "progress") replies.push(message);
    };
    await import("../src/intent/model-worker");
    const onmessage = (self as unknown as { onmessage: (event: { data: unknown }) => Promise<void> }).onmessage;
    expect(onmessage).toBeTypeOf("function");
    await onmessage({ data: { type: "load", requestId: 7, manifest } as IntentModelRequest });
    return replies.find((reply) => reply.requestId === 7)!;
  }

  it("refuses a load whose weights fail the SHA-256 pin (defensive boundary, full chain)", async () => {
    const manifest = validManifest({ model: { url: "/models/llm/m.gguf", bytes: 8, sha256: "0".repeat(64) } });
    const response = await loadThroughWorker(manifest, new TextEncoder().encode("weights!"));
    expect(response).toMatchObject({ type: "load", requestId: 7, ok: false });
    if (response.type === "load" && response.ok === false) expect(response.error).toContain("model hash mismatch");
  });

  it("refuses a load whose manifest pins a grammar this build does not generate", async () => {
    const manifest = validManifest({ grammarSha256: "0".repeat(64) });
    const response = await loadThroughWorker(manifest, new TextEncoder().encode("weights!"));
    expect(response.type).toBe("load");
    if (response.type === "load" && response.ok === false) expect(response.error).toContain("grammar drift");
  });

  it("drops malformed messages silently and answers generate-before-load with a controlled error", async () => {
    const replies: IntentModelResponse[] = [];
    (self as unknown as { postMessage: (message: IntentModelResponse) => void }).postMessage = (message) => {
      if (message.type !== "progress") replies.push(message);
    };
    await import("../src/intent/model-worker");
    const onmessage = (self as unknown as { onmessage: (event: { data: unknown }) => Promise<void> }).onmessage;
    await onmessage({ data: { nonsense: true } });
    await onmessage({ data: { type: "generate", requestId: 3, instruction: "hi" } });
    const generateReply = replies.find((reply) => reply.requestId === 3);
    expect(generateReply).toMatchObject({ type: "generate", requestId: 3, ok: false });
    if (generateReply?.type === "generate" && generateReply.ok === false) {
      expect(generateReply.error).toContain("model not loaded");
    }
  });
});
