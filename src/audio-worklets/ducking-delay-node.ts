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
  const delayMsFromSync = (syncOverride?: number): number => {
    const idx = lfoSyncIndex(syncOverride ?? instance.params.sync);
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
    setParameter: (id, v) => {
      // `sync` is a UI-only param (no AudioParam on the processor): a change
      // must re-push the derived delay TIME. The fall-through used to hit
      // safeApplyAudioParam, which silently no-ops on unknown ids — the SYNC
      // knob and BPM-follow never engaged after construction (the other
      // tempo-synced effects intercept it via lfoSync; this is the same
      // contract, hand-rolled for a time division).
      if (id === "sync") {
        safeApplyAudioParam(node, "time", delayMsFromSync(v), ctx.currentTime);
        return;
      }
      safeApplyAudioParam(node, id, v, ctx.currentTime);
    },
    setParameterAt: (id, v, when) => {
      if (id === "sync") {
        safeApplyAudioParam(node, "time", delayMsFromSync(v), when);
        return;
      }
      safeApplyAudioParam(node, id, v, when);
    },
    // BPM push: a synced delay re-computes its ms (OFF keeps the knob).
    // `when` (offline scene lanes) schedules the write at the window start.
    syncBpm: (next: number, when?: number) => {
      if (lfoSyncIndex(instance.params.sync) === 0) return;
      const nextMs = Math.max(
        30,
        Math.min(
          1000,
          ((60 / next) * 1000) / Math.max(1, LFO_SYNC_DIVISIONS[lfoSyncIndex(instance.params.sync)]?.mult ?? 1),
        ),
      );
      safeApplyAudioParam(node, "time", nextMs, when ?? ctx.currentTime);
    },
    getAudioParam: (paramId: string) => node.parameters.get(paramId) ?? null,
    dispose() {
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}
