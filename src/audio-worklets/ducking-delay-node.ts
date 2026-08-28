import type { EffectRuntime } from "../effects/types";

/**
 * Create a Ducking Delay AudioWorkletNode synchronously.
 * Processor must be pre-loaded via `loadWorkletModules()` — callers gate
 * behind `isWorkletReady("duckDelay", ctx)`.
 */
export function createDuckingDelayNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number> },
): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "ducking-delay-processor", {
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
  setParam("time", instance.params.time ?? 375);
  setParam("feedback", instance.params.feedback ?? 0.35);
  setParam("tone", instance.params.tone ?? 4000);
  setParam("duckAmount", instance.params.duckAmount ?? 0.7);
  setParam("duckThresh", instance.params.duckThresh ?? -24);
  setParam("duckAttack", instance.params.duckAttack ?? 0.005);
  setParam("duckRelease", instance.params.duckRelease ?? 0.18);
  setParam("mix", instance.params.mix ?? 0.3);

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
