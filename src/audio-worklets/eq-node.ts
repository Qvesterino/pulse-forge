import type { EffectRuntime } from "../effects/types";

/**
 * Create a stock EQ AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadCoreWorklets()` first —
 * callers gate construction behind `isWorkletReady("eq", ctx)`.
 *
 * Legacy alias params (lowGain/lowFreq/…) resolve to their canonical bands
 * with the same precedence the native graph used: an alias only applies
 * when the canonical id is absent from the instance params.
 */
const EQ_ALIASES: Record<string, string> = {
  lowGain: "lowShelfGain",
  lowFreq: "lowShelfFreq",
  midGain: "lowMidGain",
  midFreq: "lowMidFreq",
  midQ: "lowMidQ",
  highGain: "highShelfGain",
  highFreq: "highShelfFreq",
};

const EQ_CANONICAL = [
  "hpFreq",
  "lpFreq",
  "lowShelfFreq",
  "lowShelfGain",
  "lowMidFreq",
  "lowMidGain",
  "lowMidQ",
  "highMidFreq",
  "highMidGain",
  "highMidQ",
  "highShelfFreq",
  "highShelfGain",
];

export function resolveEqParams(params: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of EQ_CANONICAL) {
    if (params[id] !== undefined) {
      out[id] = params[id];
      continue;
    }
    const alias = Object.keys(EQ_ALIASES).find((a) => EQ_ALIASES[a] === id && params[a] !== undefined);
    if (alias !== undefined) out[id] = params[alias];
  }
  return out;
}

export function createEqNode(ctx: BaseAudioContext, instance: { params: Record<string, number> }): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "eq-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node).connect(output);

  const resolved = resolveEqParams(instance.params);
  // Legacy precedence, frozen at construction: an alias drives its band
  // only when the canonical id was absent from the instance params (the
  // native graph consulted the same construction-time snapshot per set).
  const locked = new Set(EQ_CANONICAL.filter((id) => instance.params[id] !== undefined));
  const setParam = (id: string, v: number, when?: number) => {
    const p = node.parameters.get(id);
    if (!p) return;
    if (when === undefined) p.value = v;
    else p.setValueAtTime(v, when);
  };
  for (const id of EQ_CANONICAL) {
    const p = node.parameters.get(id);
    if (p && resolved[id] !== undefined) p.value = resolved[id];
  }

  const applyParam = (id: string, v: number, when: number | undefined) => {
    const canonical = EQ_ALIASES[id] ?? id;
    if (!EQ_CANONICAL.includes(canonical)) return;
    if (EQ_ALIASES[id] !== undefined && locked.has(canonical)) return;
    setParam(canonical, v, when);
  };

  const audioParamFor = (paramId: string): AudioParam | null => {
    const canonical = EQ_ALIASES[paramId] ?? paramId;
    return node.parameters.get(canonical) ?? null;
  };

  return {
    input,
    output,
    setParameter: (id, v) => applyParam(id, v, ctx.currentTime),
    setParameterAt: (id, v, when) => applyParam(id, v, when),
    getAudioParam: audioParamFor,
    dispose() {
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}
