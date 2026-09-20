import type { EffectRuntime } from "../effects/types";
import { safeApplyAudioParam } from "./safeAudioParam";

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
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node).connect(output);

  safeApplyAudioParam(node, "time", instance.params.time ?? 375);
  safeApplyAudioParam(node, "feedback", instance.params.feedback ?? 0.35);
  safeApplyAudioParam(node, "tone", instance.params.tone ?? 4000);
  safeApplyAudioParam(node, "duckAmount", instance.params.duckAmount ?? 0.7);
  safeApplyAudioParam(node, "duckThresh", instance.params.duckThresh ?? -24);
  safeApplyAudioParam(node, "duckAttack", instance.params.duckAttack ?? 0.005);
  safeApplyAudioParam(node, "duckRelease", instance.params.duckRelease ?? 0.18);
  safeApplyAudioParam(node, "mix", instance.params.mix ?? 0.3);

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
