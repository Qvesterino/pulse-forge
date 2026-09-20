import type { EffectRuntime } from "../effects/types";
import { safeApplyAudioParam } from "./safeAudioParam";

/**
 * Create an SVF (TPT State Variable Filter) AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadWorkletModules()` first —
 * callers gate construction behind `isWorkletReady("svFilter", ctx)`.
 */
export function createSvFilterNode(ctx: BaseAudioContext, instance: { params: Record<string, number> }): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "svfilter-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node).connect(output);

  // safeApplyAudioParam guards non-finite writes (defence-in-depth)
  safeApplyAudioParam(node, "cutoff", instance.params.cutoff ?? 2000);
  safeApplyAudioParam(node, "resonance", instance.params.resonance ?? 0.3);
  safeApplyAudioParam(node, "mode", instance.params.mode ?? 0);
  safeApplyAudioParam(node, "drive", instance.params.drive ?? 0);
  safeApplyAudioParam(node, "mix", instance.params.mix ?? 1);

  return {
    input,
    output,
    setParameter: (id, v) => safeApplyAudioParam(node, id, v, ctx.currentTime),
    setParameterAt: (id, v, when) => safeApplyAudioParam(node, id, v, when),
    getAudioParam: (paramId: string) => node.parameters.get(paramId) ?? null,
    dispose() {
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}
