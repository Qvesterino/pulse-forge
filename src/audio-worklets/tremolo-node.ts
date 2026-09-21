import type { EffectRuntime } from "../effects/types";
import { safeApplyAudioParam } from "./safeAudioParam";
import { createLfoSyncController } from "../effects/tempo-sync";

/**
 * Create a Tremolo AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadWorkletModules()` first —
 * callers gate construction behind `isWorkletReady("tremolo", ctx)`.
 */
export function createTremoloNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number> },
  bpm?: number,
): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "tremolo-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node).connect(output);

  // C2 tempo-sync: the rate param stays Hz; a musical `sync` locks the
  // LFO to the transport and follows bpm pushes via the engine hook.
  const lfoSync = createLfoSyncController({
    rateParamId: "rate",
    defaultRate: 5,
    initialRate: instance.params.rate,
    initialSync: instance.params.sync,
    initialBpm: bpm,
    write: (paramId, value, when) =>
      when == null ? safeApplyAudioParam(node, paramId, value) : safeApplyAudioParam(node, paramId, value, when),
  });
  lfoSync.parameter("rate", instance.params.rate ?? 5, null);

  safeApplyAudioParam(node, "depth", instance.params.depth ?? 0.7);
  safeApplyAudioParam(node, "shape", instance.params.shape ?? 0);
  safeApplyAudioParam(node, "mode", instance.params.mode ?? 0);
  safeApplyAudioParam(node, "mix", instance.params.mix ?? 1);

  return {
    input,
    output,
    setParameter: (id, v) => {
      if (lfoSync.parameter(id, v, ctx.currentTime)) return;
      safeApplyAudioParam(node, id, v, ctx.currentTime);
    },
    setParameterAt: (id, v, when) => {
      if (lfoSync.parameter(id, v, when)) return;
      safeApplyAudioParam(node, id, v, when);
    },
    syncBpm(next, when) {
      lfoSync.syncBpm(next, when ?? ctx.currentTime);
    },
    getAudioParam: (paramId: string) => node.parameters.get(paramId) ?? null,
    dispose() {
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}
