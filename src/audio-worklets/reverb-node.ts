import type { EffectRuntime } from "../effects/types";
import { safeApplyAudioParam } from "./safeAudioParam";

/**
 * Create a Reverb FDN AudioWorkletNode synchronously.
 * Processor must be pre-loaded via `loadWorkletModules()` — callers gate
 * behind `isWorkletReady("reverb", ctx)`.
 */
export function createReverbNode(ctx: BaseAudioContext, instance: { params: Record<string, number> }): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "reverb-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node).connect(output);

  const setParam = (id: string, v: number, when?: number) => {
    // Map legacy `tone` to `damping`+`tone` for compat. The helper drops
    // non-finite values so a corrupt preset write cannot abort the chain.
    if (id === "tone") {
      safeApplyAudioParam(node, "tone", v, when);
      const dp = node.parameters.get("damping");
      if (dp && Number.isFinite(v)) {
        if (when === undefined) dp.value = v;
        else dp.setValueAtTime(v, when);
      }
      return;
    }
    safeApplyAudioParam(node, id, v, when);
  };

  setParam("decay", instance.params.decay ?? 1.8);
  // Prefer explicit damping, else tone
  const damp = instance.params.damping ?? instance.params.tone ?? 6000;
  setParam("damping", damp);
  setParam("tone", damp);
  setParam("diffusion", instance.params.diffusion ?? 0.5);

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
