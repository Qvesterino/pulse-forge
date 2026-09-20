import type { EffectRuntime } from "../effects/types";
import { safeApplyAudioParam } from "./safeAudioParam";

/**
 * Create an Autowah AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadWorkletModules()` first —
 * callers gate construction behind `isWorkletReady("autowah", ctx)`.
 */
export function createAutowahNode(ctx: BaseAudioContext, instance: { params: Record<string, number> }): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "autowah-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node).connect(output);

  safeApplyAudioParam(node, "minFreq", instance.params.minFreq ?? 300);
  safeApplyAudioParam(node, "maxFreq", instance.params.maxFreq ?? 2500);
  safeApplyAudioParam(node, "resonance", instance.params.resonance ?? 0.7);
  safeApplyAudioParam(node, "attack", instance.params.attack ?? 0.01);
  safeApplyAudioParam(node, "release", instance.params.release ?? 0.15);
  safeApplyAudioParam(node, "sensitivity", instance.params.sensitivity ?? 1.5);
  safeApplyAudioParam(node, "mode", instance.params.mode ?? 0);
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
