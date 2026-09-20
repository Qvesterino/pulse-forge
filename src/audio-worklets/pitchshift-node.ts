import type { EffectRuntime } from "../effects/types";
import { safeApplyAudioParam } from "./safeAudioParam";

/**
 * Create a Pitch Shifter AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadCoreWorklets()` first —
 * callers gate construction behind `isWorkletReady("pitchShift", ctx)`.
 *
 * The instance id seeds the grain phase offset, so two instances of the same
 * preset stacked on different tracks don't sum their artifacts in phase.
 */
export function createPitchShiftNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number>; id?: string },
): EffectRuntime {
  let seed = 1;
  const id = instance.id ?? "";
  for (let i = 0; i < id.length; i++) {
    seed = (Math.imul(seed, 31) + id.charCodeAt(i)) | 0;
  }
  const node = new AudioWorkletNode(ctx, "pitchshift-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
    processorOptions: { seed: Math.abs(seed) || 1 },
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node).connect(output);

  // safeApplyAudioParam guards non-finite writes (defence-in-depth)
  safeApplyAudioParam(node, "semitones", instance.params.semitones ?? 0);
  safeApplyAudioParam(node, "fine", instance.params.fine ?? 0);
  safeApplyAudioParam(node, "grainMs", instance.params.grainMs ?? 55);
  safeApplyAudioParam(node, "width", instance.params.width ?? 0.5);
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
