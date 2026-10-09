import { describe, it, expect, afterEach } from "vitest";
import { toJsonObjectSchema, validateModelAction } from "../src/intent/model-schema";
import { disableOllamaIntentProvider, ensureOllamaIntentProvider } from "../src/intent/model-ollama";
import { getIntentModelProvider, setIntentModelProvider } from "../src/intent/model-resolver";

/**
 * OLLAMA PROVIDER (desktop path) — schema generator + adapter wiring tests.
 * The real server smoke lives in scripts/smoke-ollama-intent.mts (needs a
 * running Ollama); here the server boundary is a stubbed fetch.
 */

describe("toJsonObjectSchema (structured outputs contract)", () => {
  const schema = toJsonObjectSchema();

  it("emits a discriminated anyOf with one branch per action kind", () => {
    const branches = schema.anyOf as Array<Record<string, unknown>>;
    expect(Array.isArray(branches)).toBe(true);
    expect(branches.length).toBeGreaterThanOrEqual(21);
    for (const branch of branches) {
      const properties = branch.properties as Record<string, unknown>;
      expect(typeof (properties.kind as { const?: string }).const).toBe("string");
      expect(Array.isArray(branch.required)).toBe(true);
      expect((branch.required as string[])[0]).toBe("kind");
    }
  });

  it("maps the fader slots exactly (enum/int/amount types)", () => {
    const branches = schema.anyOf as Array<Record<string, unknown>>;
    const fader = branches.find(
      (branch) => (branch.properties as Record<string, { const?: string }>).kind.const === "fader",
    )!;
    const properties = fader.properties as Record<string, any>;
    expect(properties.targets).toMatchObject({ type: "array", items: { type: "string", enum: expect.any(Array) } });
    expect(properties.percent).toMatchObject({ type: "integer", minimum: 0, maximum: 100 });
    expect(properties.direction).toMatchObject({ type: "string", enum: ["down", "up", "set"] });
  });

  it("any schema-legal sample validates through validateModelAction (grammar ≈ validator)", () => {
    const branches = schema.anyOf as Array<Record<string, unknown>>;
    // walk every kind's minimal required shape and confirm the validator accepts it
    for (const branch of branches) {
      const properties = branch.properties as Record<string, any>;
      const kind = properties.kind.const as string;
      const sample: Record<string, unknown> = { kind };
      const required = branch.required as string[];
      const fillFrom = (slot: any): unknown => {
        if (slot.enum) return slot.enum[0];
        if (slot.anyOf) return true;
        if (slot.type === "integer" || slot.type === "number") return slot.minimum >= -1e8 ? slot.minimum : 0;
        if (slot.type === "boolean") return true;
        if (slot.type === "string") return "x";
        if (slot.type === "array") return [];
        return null;
      };
      for (const name of required.slice(1)) {
        // compound parts must be a NON-empty array of valid sub-actions
        sample[name] = name === "parts" ? [{ kind: "transport", action: "stop" }] : fillFrom(properties[name]);
      }
      const validation = validateModelAction(sample);
      expect(validation.valid, `${kind}: ${validation.errors.join("; ")}`).toBe(true);
    }
  });
});

describe("ollama provider wiring", () => {
  afterEach(() => {
    localStorage.removeItem("pf:intent-model-ollama");
    setIntentModelProvider(null);
  });

  it("kill switch off → ensure() never probes and never registers", async () => {
    localStorage.setItem("pf:intent-model-ollama", "off");
    let probed = false;
    vi_stubFetch(async () => {
      probed = true;
      throw new Error("should not probe");
    });
    await expect(ensureOllamaIntentProvider()).resolves.toBeNull();
    expect(probed).toBe(false);
    expect(getIntentModelProvider()).toBeNull();
  });

  it("ACTIVE BY DEFAULT: no flag + server with the SFT model → registers", async () => {
    vi_stubFetch(
      async () => new Response(JSON.stringify({ models: [{ name: "kyx-intent-v33-q8" }] }), { status: 200 }),
    );
    await expect(ensureOllamaIntentProvider()).resolves.toBe("kyx-intent-v33-q8");
    expect(getIntentModelProvider()?.id).toBe("ollama.kyx-intent-v33-q8");
  });

  it("server without the model → no registration (the probe is the real gate)", async () => {
    vi_stubFetch(async () => new Response(JSON.stringify({ models: [{ name: "some-other:model" }] }), { status: 200 }));
    await expect(ensureOllamaIntentProvider()).resolves.toBeNull();
    expect(getIntentModelProvider()).toBeNull();
  });

  it("server with the model registers the provider and generate posts the schema", async () => {
    const bodies: any[] = [];
    vi_stubFetch(async (_url, init) => {
      const url = String(_url);
      if (url.endsWith("/api/tags")) {
        return new Response(JSON.stringify({ models: [{ name: "kyx-intent-v33-q8" }] }), { status: 200 });
      }
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ message: { content: '{"kind":"transport","action":"stop"}' } }), {
        status: 200,
      });
    });
    const model = await ensureOllamaIntentProvider();
    expect(model).toBe("kyx-intent-v33-q8");
    const provider = getIntentModelProvider();
    expect(provider?.id).toBe("ollama.kyx-intent-v33-q8");
    const text = await provider!.generate("stop", {} as never);
    expect(JSON.parse(text)).toEqual({ kind: "transport", action: "stop" });
    // NO format constraint (measured 2026-09-29: the schema grammar flips the
    // SFT model's kinds — f27406b9); validation stays with validateModelAction.
    expect(bodies[0].format).toBeUndefined();
    expect(bodies[0].options.temperature).toBe(0);
  });

  it("disable removes only the ollama provider", async () => {
    setIntentModelProvider({ id: "ollama.lfm2:1.2b", version: "test", generate: async () => "{}" });
    await disableOllamaIntentProvider();
    expect(getIntentModelProvider()).toBeNull();
    setIntentModelProvider({ id: "pulse-forge.intent-model", version: "test", generate: async () => "{}" });
    await disableOllamaIntentProvider();
    expect(getIntentModelProvider()?.id).toBe("pulse-forge.intent-model"); // artifact loader untouched
    setIntentModelProvider(null);
  });
});

// tiny fetch stub helper (vitest's vi.stubGlobal keeps this readable)
import { vi } from "vitest";
function vi_stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): void {
  vi.stubGlobal("fetch", vi.fn(impl));
}
