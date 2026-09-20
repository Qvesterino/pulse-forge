import type { EffectRuntime } from "../effects/types";
import { safeApplyAudioParam } from "./safeAudioParam";

/**
 * Create a Vowel Filter AudioWorkletNode synchronously.
 * Processor must be pre-loaded via `loadWorkletModules()` — callers gate
 * behind `isWorkletReady("vowel", ctx)`.
 */
export function createVowelNode(ctx: BaseAudioContext, instance: { params: Record<string, number> }): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "vowel-processor", {
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
  safeApplyAudioParam(node, "vowel", instance.params.vowel ?? 0);
  safeApplyAudioParam(node, "resonance", instance.params.resonance ?? 0.5);
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
