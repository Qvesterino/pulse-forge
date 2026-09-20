import { describe, expect, it } from "vitest";
import { normalizePluginParams } from "../src/effects/registry";

describe("PRISM rack MIX persistence", () => {
  it("keeps the rack mix id and mirrors it to globalMix", () => {
    const out = normalizePluginParams("fxeq", { bandCount: 4, mix: 42, inputGainDb: -6 });
    expect(out).not.toBeNull();
    expect(out!.mix).toBe(42);
    expect(out!.globalMix).toBe(42);
    expect(out!.inputGainDb).toBe(-6);
  });
  it("defaults mix to 100 when absent", () => {
    const out = normalizePluginParams("fxeq", { bandCount: 4 });
    expect(out!.mix).toBe(100);
    expect(out!.globalMix).toBe(100);
  });
  it("clamps out-of-range mix", () => {
    expect(normalizePluginParams("fxeq", { mix: 500 })!.mix).toBe(100);
    expect(normalizePluginParams("fxeq", { mix: -20 })!.mix).toBe(0);
  });
});
