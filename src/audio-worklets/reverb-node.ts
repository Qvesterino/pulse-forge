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

  // DAMPING (loop darkening) and TONE (output brightness) are independent
  // processor params now — no legacy tone→damping mirroring. The helper
  // drops non-finite values so a corrupt preset write cannot abort.
  const setParam = (id: string, v: number, when?: number) => {
    safeApplyAudioParam(node, id, v, when);
  };

  setParam("decay", instance.params.decay ?? 1.8);
  setParam("damping", instance.params.damping ?? instance.params.tone ?? 6000);
  setParam("tone", instance.params.tone ?? 9000);
  setParam("diffusion", instance.params.diffusion ?? 0.5);
  setParam("mod", instance.params.mod ?? 0.35);

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
