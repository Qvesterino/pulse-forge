import type { EffectRuntime } from "../effects/types";
import { safeApplyAudioParam } from "./safeAudioParam";
import { createLfoSyncController } from "../effects/tempo-sync";

/**
 * Create a Chorus AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadCoreWorklets()` first —
 * callers gate construction behind `isWorkletReady("chorus", ctx)`.
 */
export function createChorusNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number> },
  bpm?: number,
): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "chorus-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
  });

  const input = ctx.createGain();
  const out = ctx.createGain();
  input.connect(node).connect(out);

  // C2 tempo-sync: the rate param stays Hz; a musical `sync` locks the LFO
  // to the transport and follows bpm pushes via the engine hook (replaces
  // the old always-on 1/4-beat snap that ignored the user's rate).
  const lfoSync = createLfoSyncController({
    rateParamId: "rate",
    defaultRate: 0.6,
    initialRate: instance.params.rate,
    initialSync: instance.params.sync,
    initialBpm: bpm,
    write: (paramId, value, when) =>
      when == null ? safeApplyAudioParam(node, paramId, value) : safeApplyAudioParam(node, paramId, value, when),
  });
  lfoSync.parameter("rate", instance.params.rate ?? 0.6, null);

  safeApplyAudioParam(node, "depth", instance.params.depth ?? 0.5);
  safeApplyAudioParam(node, "spread", instance.params.spread ?? 1);
  safeApplyAudioParam(node, "mix", instance.params.mix ?? 0.5);
  out.gain.value = Math.pow(10, (instance.params.output ?? 0) / 20);

  const smoothOut = (v: number, when: number) => out.gain.setTargetAtTime(Math.pow(10, v / 20), when, 0.02);

  return {
    input,
    output: out,
    setParameter: (id, v) => {
      if (id === "output") {
        smoothOut(v, ctx.currentTime);
        return;
      }
      if (lfoSync.parameter(id, v, ctx.currentTime)) return;
      safeApplyAudioParam(node, id, v, ctx.currentTime);
    },
    setParameterAt: (id, v, when) => {
      if (id === "output") {
        smoothOut(v, when);
        return;
      }
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
      out.disconnect();
    },
  };
}
