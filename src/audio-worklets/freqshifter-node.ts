import type { EffectRuntime } from "../effects/types";
import { safeApplyAudioParam } from "./safeAudioParam";

/**
 * Create a Frequency Shifter AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadCoreWorklets()` first —
 * callers gate construction behind `isWorkletReady("freqShifter", ctx)`.
 */
export function createFreqShiftNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number> },
): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "freqshift-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node).connect(output);

  safeApplyAudioParam(node, "shift", instance.params.shift ?? 0);
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
