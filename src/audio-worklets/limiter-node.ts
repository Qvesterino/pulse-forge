import type { EffectRuntime } from "../effects/types";

import { attachProcessorErrorGuard } from "./processor-errors";
import { safeApplyAudioParam } from "./safeAudioParam";

const LIMITER_LOOKAHEAD_DEFAULT_MS = 5;
const LIMITER_LOOKAHEAD_MIN_MS = 1;
const LIMITER_LOOKAHEAD_MAX_MS = 20;

function clampLimiterLookaheadMs(value: number): number {
  if (!Number.isFinite(value)) return LIMITER_LOOKAHEAD_DEFAULT_MS;
  return Math.min(LIMITER_LOOKAHEAD_MAX_MS, Math.max(LIMITER_LOOKAHEAD_MIN_MS, value));
}

/**
 * Create a Look-ahead Limiter AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadWorkletModules()` first
 * (callers check `isWorkletReady("limiter", ctx)` before constructing).
 *
 * Latency contract: the processor rounds `lookahead` to a whole sample.
 * getLatencySec() reports that realized delay so the engine's minimal PDC
 * keeps tracks with a limiter sample-aligned with dry tracks.
 */
export function createLimiterNode(ctx: BaseAudioContext, instance: { params: Record<string, number> }): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "limiter-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
  });
  // Runtime processor-error containment (GOAL 07/LONGEVITY §3): the
  // browser silently kills a throwing processor — surface + count it.
  attachProcessorErrorGuard(node, "limiter-processor");

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node).connect(output);

  let lookaheadMs = instance.params.lookaheadMs ?? LIMITER_LOOKAHEAD_DEFAULT_MS;
  let lastGrDb = 0;
  node.port.onmessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; gr?: number } | null;
    if (data?.type === "gr" && typeof data.gr === "number") lastGrDb = data.gr;
  };

  // Registry speaks ms for LOOKAHEAD; the processor param is seconds.
  safeApplyAudioParam(node, "ceiling", instance.params.ceiling ?? -1);
  safeApplyAudioParam(node, "threshold", instance.params.threshold ?? -6);
  safeApplyAudioParam(node, "release", instance.params.release ?? 0.12);
  safeApplyAudioParam(node, "lookahead", clampLimiterLookaheadMs(lookaheadMs) / 1000);
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
        if (!Number.isFinite(value)) return;
        lookaheadMs = value;
        safeApplyAudioParam(node, "lookahead", clampLimiterLookaheadMs(value) / 1000, ctx.currentTime);
        return;
      }
      safeApplyAudioParam(node, id, value, ctx.currentTime);
    },
    setParameterAt(id, value, when) {
      if (id === "lookaheadMs") {
        if (!Number.isFinite(value)) return;
        lookaheadMs = value;
        safeApplyAudioParam(node, "lookahead", clampLimiterLookaheadMs(value) / 1000, when);
        return;
      }
      safeApplyAudioParam(node, id, value, when);
    },
    getAudioParam: (paramId: string) => node.parameters.get(paramId) ?? null,
    getLatencySec() {
      // Worklet AudioParam values arrive as Float32Array values. Mirror that
      // conversion before rounding to samples, or PDC can differ by one sample
      // at rates such as 44.1 kHz where 5 ms is 220.5 samples in JS precision.
      const effectiveMs = clampLimiterLookaheadMs(lookaheadMs);
      const workletLookaheadSec = Math.fround(effectiveMs / 1000);
      return Math.round(workletLookaheadSec * ctx.sampleRate) / ctx.sampleRate;
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
