import type { EffectRuntime } from "../effects/types";
import { safeApplyAudioParam } from "./safeAudioParam";

/**
 * Create a Flanger AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadWorkletModules()` first —
 * callers gate construction behind `isWorkletReady("flanger", ctx)`.
 */
export function createFlangerNode(ctx: BaseAudioContext, instance: { params: Record<string, number> }): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "flanger-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node).connect(output);

  safeApplyAudioParam(node, "rate", instance.params.rate ?? 0.5);
  safeApplyAudioParam(node, "depth", instance.params.depth ?? 3);
  safeApplyAudioParam(node, "base", instance.params.base ?? 5);
  safeApplyAudioParam(node, "feedback", instance.params.feedback ?? 0.4);
  safeApplyAudioParam(node, "spread", instance.params.spread ?? 0.7);
  safeApplyAudioParam(node, "mix", instance.params.mix ?? 0.5);

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
