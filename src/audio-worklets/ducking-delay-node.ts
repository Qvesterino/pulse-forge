import type { EffectRuntime } from "../effects/types";
import { safeApplyAudioParam } from "./safeAudioParam";
import { LFO_SYNC_DIVISIONS, lfoSyncIndex } from "../effects/tempo-sync";

/**
 * Create a Ducking Delay AudioWorkletNode synchronously.
 * Processor must be pre-loaded via `loadWorkletModules()` — callers gate
 * behind `isWorkletReady("duckDelay", ctx)`.
 */
export function createDuckingDelayNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number> },
  bpm?: number,
): EffectRuntime {
  // D1 tempo-sync: a musical `sync` division converts to a delay TIME in ms
  // (division mult = cycles per beat → for a delay we use beat length ÷
  // mult, i.e. 1/4 = one beat, 1/8 = half beat …). OFF keeps the ms knob.
  const bpmVal = typeof bpm === "number" && Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  const delayMsFromSync = (): number => {
    const idx = lfoSyncIndex(instance.params.sync);
    const mult = LFO_SYNC_DIVISIONS[idx]?.mult ?? 0;
    if (mult <= 0) return instance.params.time ?? 375;
    return Math.max(30, Math.min(1000, ((60 / bpmVal) * 1000) / mult));
  };
  const node = new AudioWorkletNode(ctx, "ducking-delay-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node).connect(output);

  safeApplyAudioParam(node, "time", delayMsFromSync());
  safeApplyAudioParam(node, "feedback", instance.params.feedback ?? 0.35);
  safeApplyAudioParam(node, "tone", instance.params.tone ?? 4000);
  safeApplyAudioParam(node, "duckAmount", instance.params.duckAmount ?? 0.7);
  safeApplyAudioParam(node, "duckThresh", instance.params.duckThresh ?? -24);
  safeApplyAudioParam(node, "duckAttack", instance.params.duckAttack ?? 0.005);
  safeApplyAudioParam(node, "duckRelease", instance.params.duckRelease ?? 0.18);
  safeApplyAudioParam(node, "mix", instance.params.mix ?? 0.3);
  safeApplyAudioParam(node, "pingpong", instance.params.pingpong ?? 0);
  safeApplyAudioParam(node, "loopHpfHz", instance.params.loopHpfHz ?? 40);

  return {
    input,
    output,
    setParameter: (id, v) => safeApplyAudioParam(node, id, v, ctx.currentTime),
    setParameterAt: (id, v, when) => safeApplyAudioParam(node, id, v, when),
    // BPM push: a synced delay re-computes its ms (OFF keeps the knob).
    syncBpm: (next: number) => {
      if (lfoSyncIndex(instance.params.sync) === 0) return;
      const nextMs = Math.max(
        30,
        Math.min(
          1000,
          ((60 / next) * 1000) / Math.max(1, LFO_SYNC_DIVISIONS[lfoSyncIndex(instance.params.sync)]?.mult ?? 1),
        ),
      );
      safeApplyAudioParam(node, "time", nextMs, ctx.currentTime);
    },
    getAudioParam: (paramId: string) => node.parameters.get(paramId) ?? null,
    dispose() {
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}
