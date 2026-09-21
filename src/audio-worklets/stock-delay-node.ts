import type { EffectRuntime } from "../effects/types";
import { safeApplyAudioParam } from "./safeAudioParam";

/**
 * Create a stock Delay AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadCoreWorklets()` first —
 * callers gate construction behind `isWorkletReady("delay", ctx)`.
 */
export function createStockDelayNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number> },
  bpm: number,
): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "stock-delay-processor", {
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
  safeApplyAudioParam(node, "time", instance.params.time ?? 375);
  safeApplyAudioParam(node, "sync", instance.params.sync ?? 0);
  safeApplyAudioParam(node, "bpm", bpm);
  safeApplyAudioParam(node, "pingPong", instance.params.pingPong ?? 0);
  safeApplyAudioParam(node, "feedback", instance.params.feedback ?? 0.35);
  safeApplyAudioParam(node, "tone", instance.params.tone ?? 4000);
  safeApplyAudioParam(node, "mix", instance.params.mix ?? 0.25);

  return {
    input,
    output,
    setParameter: (id, v) => safeApplyAudioParam(node, id, v, ctx.currentTime),
    setParameterAt: (id, v, when) => safeApplyAudioParam(node, id, v, when),
    syncBpm(nextBpm, when) {
      safeApplyAudioParam(node, "bpm", nextBpm, when ?? ctx.currentTime);
    },
    getAudioParam: (paramId: string) => node.parameters.get(paramId) ?? null,
    dispose() {
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}
