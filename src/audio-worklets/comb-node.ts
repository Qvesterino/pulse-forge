import type { EffectRuntime } from "../effects/types";

/**
 * Create a Comb Filter AudioWorkletNode synchronously.
 * Processor must be pre-loaded via `loadWorkletModules()` — callers gate
 * behind `isWorkletReady("comb", ctx)`.
 */
export function createCombNode(ctx: BaseAudioContext, instance: { params: Record<string, number> }): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "comb-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 2,
    channelInterpretation: "speakers",
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node).connect(output);

  const setParam = (id: string, v: number, when?: number) => {
    const p = node.parameters.get(id);
    if (!p) return;
    if (when === undefined) p.value = v;
    else p.setValueAtTime(v, when);
  };
  setParam("delayMs", instance.params.delayMs ?? 12);
  setParam("feedback", instance.params.feedback ?? 0.5);
  setParam("damp", instance.params.damp ?? 6500);
  setParam("mix", instance.params.mix ?? 0.5);

  return {
    input,
    output,
    setParameter: (id, v) => setParam(id, v, ctx.currentTime),
    setParameterAt: (id, v, when) => setParam(id, v, when),
    getAudioParam: (paramId: string) => node.parameters.get(paramId) ?? null,
    dispose() {
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}
