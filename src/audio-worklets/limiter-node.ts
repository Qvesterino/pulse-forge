import type { EffectRuntime } from "../effects/types";
import { safeApplyAudioParam } from "./safeAudioParam";

/**
 * Create a Look-ahead Limiter AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadWorkletModules()` first
 * (callers check `isWorkletReady("limiter", ctx)` before constructing).
 *
 * Latency contract: the processor delays audio by exactly the `lookahead`
 * param (seconds). getLatencySec() feeds the engine's minimal PDC so tracks
 * with a limiter stay sample-aligned with dry tracks. Changing LOOKAHEAD at
 * runtime updates both the node and the reported latency on the next sync.
 */
export function createLimiterNode(ctx: BaseAudioContext, instance: { params: Record<string, number> }): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "limiter-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node).connect(output);

  let lookaheadMs = instance.params.lookaheadMs ?? 5;
  let lastGrDb = 0;
  node.port.onmessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; gr?: number } | null;
    if (data?.type === "gr" && typeof data.gr === "number") lastGrDb = data.gr;
  };

  // Registry speaks ms for LOOKAHEAD; the processor param is seconds.
  safeApplyAudioParam(node, "ceiling", instance.params.ceiling ?? -1);
  safeApplyAudioParam(node, "threshold", instance.params.threshold ?? -6);
  safeApplyAudioParam(node, "release", instance.params.release ?? 0.12);
  safeApplyAudioParam(node, "lookahead", Math.max(1, lookaheadMs) / 1000);
  safeApplyAudioParam(node, "link", instance.params.link ?? 1);
  safeApplyAudioParam(node, "mix", instance.params.mix ?? 1);

  return {
    input,
    output,
    setParameter(id, value) {
      if (id === "lookaheadMs") {
        // A non-finite value would poison getLatencySec() → NaN PDC delay
        // time → TypeError in syncPdc; safeApplyAudioParam drops the param
        // write, so the stored latency must stay on the last valid value.
        if (Number.isFinite(value)) lookaheadMs = value;
        safeApplyAudioParam(node, "lookahead", Math.max(1, value) / 1000, ctx.currentTime);
        return;
      }
      safeApplyAudioParam(node, id, value, ctx.currentTime);
    },
    setParameterAt(id, value, when) {
      if (id === "lookaheadMs") {
        if (Number.isFinite(value)) lookaheadMs = value;
        safeApplyAudioParam(node, "lookahead", Math.max(1, value) / 1000, when);
        return;
      }
      safeApplyAudioParam(node, id, value, when);
    },
    getAudioParam: (paramId: string) => node.parameters.get(paramId) ?? null,
    getLatencySec() {
      // Report the delay the PROCESSOR actually applies: the AudioParam
      // descriptor clamps lookahead to [1, 20] ms, so an out-of-range stored
      // lookaheadMs (e.g. 50) must not over-compensate PDC and shift the
      // track early.
      if (!Number.isFinite(lookaheadMs)) return 0.005;
      return Math.min(20, Math.max(1, lookaheadMs)) / 1000;
    },
    getGainReductionDb() {
      return lastGrDb;
    },
    dispose() {
      node.port.onmessage = null;
      node.port.close();
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}
