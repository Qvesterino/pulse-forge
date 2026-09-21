import type { EffectRuntime } from "../effects/types";
import { safeApplyAudioParam } from "./safeAudioParam";
import { createLfoSyncController } from "../effects/tempo-sync";

/**
 * Create a Flanger AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadWorkletModules()` first —
 * callers gate construction behind `isWorkletReady("flanger", ctx)`.
 */
export function createFlangerNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number> },
  bpm?: number,
): EffectRuntime {
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

  // C2 tempo-sync: the rate param stays Hz; a musical `sync` locks the
  // LFO to the transport and follows bpm pushes via the engine hook.
  const lfoSync = createLfoSyncController({
    rateParamId: "rate",
    defaultRate: 0.5,
    initialRate: instance.params.rate,
    initialSync: instance.params.sync,
    initialBpm: bpm,
    write: (paramId, value, when) => (when == null ? safeApplyAudioParam(node, paramId, value) : safeApplyAudioParam(node, paramId, value, when)),
  });
  // Re-apply the (possibly synced) rate over the plain default above.
  lfoSync.parameter("rate", instance.params.rate ?? 0.5, null);


  safeApplyAudioParam(node, "rate", instance.params.rate ?? 0.5);
  safeApplyAudioParam(node, "depth", instance.params.depth ?? 3);
  safeApplyAudioParam(node, "base", instance.params.base ?? 5);
  safeApplyAudioParam(node, "feedback", instance.params.feedback ?? 0.4);
  safeApplyAudioParam(node, "spread", instance.params.spread ?? 0.7);
  safeApplyAudioParam(node, "mix", instance.params.mix ?? 0.5);

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
