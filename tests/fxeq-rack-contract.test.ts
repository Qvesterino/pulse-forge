/**
 * FXEQ rack ↔ core parameter contract.
 *
 * The rack (registry EFFECT_DEFS.fxeq.params) and the vendored core
 * (buildSchema) use separate id spaces. Anything the rack exposes must
 * REACH the core — an id the core does not know is silently dropped by
 * setParameter/loadParameters (schema.routes.get miss), which is exactly
 * how the rack's MIX knob once went dead (rack "mix" vs core "globalMix").
 *
 * The translation lives in fxEqNode.RACK_TO_CORE; this suite fails when a
 * registry param is neither a core id nor translated, or when the
 * translation points at a nonexistent core id.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { EFFECT_DEFS } from "../src/effects/registry";
import { createFxEqProcessor } from "../src/effects/fxeq-core/core/fxEqProcessor";
import { buildSchema, GLOBAL_PARAM_DEFS } from "../src/effects/fxeq-core/core/parameterSchema";
import { createFxEqNode } from "../src/effects/fxeqNode";
import type { EffectInstance } from "../src/project-model/types";

class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  posted: Array<{ type: string; id?: string; value?: number; params?: Record<string, number> }> = [];
  closed = false;
  postMessage(msg: { type: string; id?: string; value?: number; params?: Record<string, number> }) {
    this.posted.push(msg);
  }
  close() {
    this.closed = true;
  }
}

let lastPort: FakePort | null = null;
class FakeAudioWorkletNode {
  port = new FakePort();
  constructor(_ctx: unknown, _name: string, _opts: Record<string, unknown>) {
    lastPort = this.port;
  }
  connect() {}
  disconnect() {}
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeCtx() {
  const gain = () => ({ connect() {}, disconnect() {} });
  return { sampleRate: 48000, createGain: gain } as unknown as BaseAudioContext;
}

function instance(params: Record<string, number>): EffectInstance {
  return { id: "fx1", type: "fxeq", bypassed: false, params };
}

describe("fxeq rack ↔ core parameter contract", () => {
  const rackParams = EFFECT_DEFS.fxeq.params.map((p) => p.id);
  const coreIds = new Set(buildSchema(6).routes.keys());

  it("every rack param id resolves to a core id through the node translation", () => {
    // Import the translation map the same way the node uses it: feed each
    // rack id through a constructed node and inspect what reaches the port.
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    const rt = createFxEqNode(fakeCtx(), instance({}), {});
    expect(rackParams.length).toBeGreaterThan(0);
    for (const id of rackParams) {
      lastPort!.posted.length = 0;
      rt.setParameter(id, 42);
      const msg = lastPort!.posted[0];
      expect(msg, `rack param ${id} produced no port message`).toBeTruthy();
      expect(
        coreIds.has(msg.id!),
        `rack param "${id}" was forwarded as core id "${msg.id}", which the core schema does not know (silently dead knob)`,
      ).toBe(true);
    }
    rt.dispose();
  });

  it("translates rack mix → core globalMix in live changes", () => {
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    const rt = createFxEqNode(fakeCtx(), instance({ mix: 35 }), {});
    lastPort!.posted.length = 0;
    rt.setParameter("mix", 55);
    expect(lastPort!.posted[0]).toEqual({ type: "param", id: "globalMix", value: 55 });
    rt.dispose();
  });

  it("initial processorOptions params are translated (mix → globalMix)", () => {
    const constructed: Array<Record<string, unknown>> = [];
    class Capturing extends FakeAudioWorkletNode {
      constructor(ctx: unknown, name: string, opts: Record<string, unknown>) {
        super(ctx, name, opts);
        constructed.push(opts);
      }
    }
    vi.stubGlobal("AudioWorkletNode", Capturing);
    const rt = createFxEqNode(fakeCtx(), instance({ mix: 35 }), { mix: 100 });
    const opts = constructed[0] as { processorOptions?: { params?: Record<string, number> } };
    const params = opts.processorOptions!.params!;
    expect(params.globalMix).toBe(35); // instance param wins, translated
    expect(params.mix).toBeUndefined(); // untranslated rack id must not leak
    rt.dispose();
  });

  it("forwards the host seed in processorOptions for deterministic per-instance DSP", () => {
    const constructed: Array<Record<string, unknown>> = [];
    class Capturing extends FakeAudioWorkletNode {
      constructor(ctx: unknown, name: string, opts: Record<string, unknown>) {
        super(ctx, name, opts);
        constructed.push(opts);
      }
    }
    vi.stubGlobal("AudioWorkletNode", Capturing);
    const rt = createFxEqNode(fakeCtx(), instance({}), {}, 0x12345678);
    const opts = constructed[0] as { processorOptions?: { seed?: number } };
    expect(opts.processorOptions?.seed).toBe(0x12345678);
    rt.dispose();
  });

  it("every translated rack id is live on the real core (end-to-end)", () => {
    const proc = createFxEqProcessor();
    proc.prepare(48000, 2, 128);
    const midOf = (min: number, max: number): number => min + (max - min) * 0.5;
    for (const p of EFFECT_DEFS.fxeq.params) {
      const mid = midOf(p.min, p.max);
      const input = p.id === "bandCount" ? Math.round(mid) : mid;
      proc.setParameter(p.id === "mix" ? "globalMix" : p.id, input);
      const coreId = p.id === "mix" ? "globalMix" : p.id;
      const expected =
        p.id === "crossoverOrder" ? 4 : p.id === "crossoverEqualize" ? 1 : p.id === "bandCount" ? input : mid;
      expect(proc.getParameter(coreId), `core did not accept rack param ${p.id} (as ${coreId})`).toBeCloseTo(expected, 6);
    }
  });

  it("core global params stay covered by the rack surface (through the translation) or are explicitly editor-only", () => {
    // Guard the other direction: the core's top-level surface must not grow
    // an id that the rack silently ignores. New global core params require a
    // rack param (possibly via RACK_TO_CORE) or an explicit entry in the
    // editor-only list below.
    const coreGlobals = GLOBAL_PARAM_DEFS.map((d) => d.id);
    // Mirror the node's translation without importing the private map:
    // resolve each rack id the same way fxEqNode does.
    const rackToCore: Record<string, string> = { mix: "globalMix" };
    const resolvedRackIds = rackParams.map((id) => rackToCore[id] ?? id);
    const editorOnly = new Set([
      // FX-only mode has no rack knob (panel/preset domain).
      "fxOnly",
    // Crossover split frequencies are preset/paint-editor domain.
    "crossoverFreq2",
    "crossoverFreq3",
    "crossoverFreq4",
    "crossoverFreq5",
    "crossoverFreq6",
      // Limiter internals beyond the enable/ceiling rack knobs.
      "limiterTruePeak",
      "limiterLookaheadMs",
      // Q4 program-dependent release — panel/preset domain (default 0).
      "limiterPdr",
    ]);
    const uncovered = coreGlobals.filter((id) => !resolvedRackIds.includes(id) && !editorOnly.has(id));
    expect(uncovered, `core global params with no rack coverage: ${uncovered.join(", ")}`).toEqual([]);
  });
});
