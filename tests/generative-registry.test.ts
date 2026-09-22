import { describe, expect, it } from "vitest";
import { createMockGenerativeProvider } from "../src/generative/mock-provider";
import { createUnavailableGenerativeProvider, GenerativeProviderRegistry } from "../src/generative/registry";

describe("generative provider registry", () => {
  it("registers providers by id and exposes capabilities without storing project state", () => {
    const registry = new GenerativeProviderRegistry();
    const provider = createMockGenerativeProvider({ providerId: "mrt2-mock" });
    registry.register(provider);

    expect(registry.get("mrt2-mock")).toBe(provider);
    expect(registry.capabilities("mrt2-mock")?.supportsRealtime).toBe(true);
    expect(registry.list()).toEqual([provider]);
    expect(() => registry.register(provider)).toThrow("already registered");
    expect(registry.unregister("mrt2-mock")).toBe(true);
    expect(registry.get("mrt2-mock")).toBeUndefined();
  });

  it("represents an unavailable host explicitly instead of silently falling back", async () => {
    const provider = createUnavailableGenerativeProvider("mrt2", "MRT2 requires an Apple Silicon host", "mrt2_small");
    const session = await provider.createSession({ modelId: "mrt2_small", outputSampleRate: 48000, outputChannels: 2 });
    const statuses: string[] = [];
    session.subscribeStatus((status) => statuses.push(status.state));

    expect(session.getStatus()).toEqual({ state: "unavailable", message: "MRT2 requires an Apple Silicon host" });
    await expect(session.start()).rejects.toThrow("Apple Silicon");
    expect(statuses).toEqual(["unavailable"]);
    await session.dispose();
    expect(session.getStatus().state).toBe("disposed");
  });
});
