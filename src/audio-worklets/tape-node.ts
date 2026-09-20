import type { EffectRuntime } from "../effects/types";
import { safeApplyAudioParam } from "./safeAudioParam";

/**
 * Create a Tape Saturation AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadWorkletModules()` first —
 * callers gate construction behind `isWorkletReady("tapeSat", ctx)`.
 */
export function createTapeNode(ctx: BaseAudioContext, instance: { params: Record<string, number> }): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "tape-processor", {
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
  safeApplyAudioParam(node, "drive", instance.params.drive ?? 0.4);
  safeApplyAudioParam(node, "hysteresis", instance.params.hysteresis ?? 0.3);
  safeApplyAudioParam(node, "tone", instance.params.tone ?? 6500);
  safeApplyAudioParam(node, "mix", instance.params.mix ?? 1);
  safeApplyAudioParam(node, "output", instance.params.output ?? 0);

  return {
    input,
    output,
    // 4× oversampling FIR cascade: 32 samples of group delay at 4× =
    // exactly 8 base-rate samples (the dry path inside is aligned too —
    // this is only so the engine's PDC can align OTHER chains with us).
    getLatencySec: () => 8 / ctx.sampleRate,
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
