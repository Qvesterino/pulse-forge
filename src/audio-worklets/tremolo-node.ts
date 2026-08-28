import type { EffectRuntime } from "../effects/types";

/**
 * Create a Tremolo AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadWorkletModules()` first —
 * callers gate construction behind `isWorkletReady("tremolo", ctx)`.
 */
export function createTremoloNode(ctx: BaseAudioContext, instance: { params: Record<string, number> }): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "tremolo-processor", {
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
  setParam("rate", instance.params.rate ?? 5);
  setParam("depth", instance.params.depth ?? 0.7);
  setParam("shape", instance.params.shape ?? 0);
  setParam("mode", instance.params.mode ?? 0);
  setParam("mix", instance.params.mix ?? 1);

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
