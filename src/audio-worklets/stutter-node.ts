import type { EffectRuntime } from "../effects/types";

import { attachProcessorErrorGuard } from "./processor-errors";
import { safeApplyAudioParam } from "./safeAudioParam";

/**
 * Create a Stutter AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadWorkletModules()` first —
 * callers gate construction behind `isWorkletReady("stutter", ctx)`.
 */
export interface StutterHandle extends EffectRuntime {
  setPattern(steps: readonly number[]): void;
}

export function createStutterNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number>; steps?: number[] },
): StutterHandle {
  const node = new AudioWorkletNode(ctx, "stutter-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
  });
  // Runtime processor-error containment (GOAL 07/LONGEVITY §3): the
  // browser silently kills a throwing processor — surface + count it.
  attachProcessorErrorGuard(node, "stutter-processor");

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node).connect(output);

  // safeApplyAudioParam guards non-finite writes (defence-in-depth)
  safeApplyAudioParam(node, "division", instance.params.division ?? 4);
  safeApplyAudioParam(node, "mix", instance.params.mix ?? 0.8);
  safeApplyAudioParam(node, "feedback", instance.params.feedback ?? 0);
  safeApplyAudioParam(node, "smooth", instance.params.smooth ?? 0.003);

  let lastSteps: readonly number[] | undefined;
  const pushPattern = (pattern: readonly number[] | undefined) => {
    // Reference compare — the engine's sync loop calls this every project
    // sync; an unchanged pattern must not re-post to the audio thread.
    if (pattern === lastSteps) return;
    lastSteps = pattern;
    if (pattern && pattern.length > 0) node.port.postMessage({ type: "pattern", steps: [...pattern] });
  };
  pushPattern(instance.steps);

  return {
    input,
    output,
    setParameter(id, value) {
      safeApplyAudioParam(node, id, value, ctx.currentTime);
    },
    setParameterAt(id, value, when) {
      safeApplyAudioParam(node, id, value, when);
    },
    getAudioParam: (paramId: string) => node.parameters.get(paramId) ?? null,
    syncBpm(bpm: number) {
      node.port.postMessage({ type: "bpm", bpm });
    },
    onTransportStarted(time: number, beatPhase: number) {
      node.port.postMessage({ type: "align", time, phase: beatPhase });
    },
    setPattern(pattern: readonly number[]) {
      pushPattern(pattern);
    },
    dispose() {
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}
