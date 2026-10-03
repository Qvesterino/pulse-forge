import type { EffectRuntime } from "../effects/types";

import { attachProcessorErrorGuard } from "./processor-errors";
import { safeApplyAudioParam } from "./safeAudioParam";

/**
 * Create a Pitch Correct AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadCoreWorklets()` first —
 * callers gate construction behind `isWorkletReady("pitchCorrect", ctx)`.
 *
 * Scale-snap correction: the worklet detects the incoming monophonic pitch
 * (YIN-style, control-rate) and pulls it toward the selected scale with a
 * smoothed ratio. No port messages — every control is a k-rate AudioParam,
 * so offline renders are bit-identical to live.
 */
export function createPitchCorrectNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number> },
): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "pitchcorrect-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
  });
  // Runtime processor-error containment (GOAL 07/LONGEVITY §3): the
  // browser silently kills a throwing processor — surface + count it.
  attachProcessorErrorGuard(node, "pitchcorrect-processor");

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node).connect(output);

  // safeApplyAudioParam guards non-finite writes (defence-in-depth)
  safeApplyAudioParam(node, "amount", instance.params.amount ?? 1);
  safeApplyAudioParam(node, "speed", instance.params.speed ?? 0.7);
  safeApplyAudioParam(node, "root", instance.params.root ?? 0);
  safeApplyAudioParam(node, "scaleMode", instance.params.scaleMode ?? 1);
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
