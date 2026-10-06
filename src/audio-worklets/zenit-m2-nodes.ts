import type { EffectRuntime } from "../effects/types";

import { attachProcessorErrorGuard } from "./processor-errors";
import { safeApplyAudioParam } from "./safeAudioParam";

/**
 * M2 mastering DSP node wrappers (ADR 0020 lineage): APEKS maximizer,
 * ŠÍRKA per-band imager, PRÚD dynamic EQ. All three are stereo worklets with
 * plain AudioParam surfaces — the shared defensive writer drops non-finite
 * values and no-ops unknown ids, exactly like every other effect node.
 * The processor module MUST be pre-loaded (core bundle) before construction.
 */
function makeStereoWorkletRuntime(
  ctx: BaseAudioContext,
  processorName: string,
  instance: { params: Record<string, number> },
  paramIds: string[],
): EffectRuntime {
  const node = new AudioWorkletNode(ctx, processorName, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
  });
  attachProcessorErrorGuard(node, processorName);
  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node);
  node.connect(output);
  for (const id of paramIds) safeApplyAudioParam(node, id, instance.params[id] ?? 0);
  return {
    input,
    output,
    setParameter(id, value) {
      safeApplyAudioParam(node, id, value, ctx.currentTime);
    },
    setParameterAt(id, value, when) {
      safeApplyAudioParam(node, id, value, when);
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

const APEKS_PARAMS = ["drive", "ceiling", "release", "preserve", "mix", "output"];

/** Create the APEKS maximizer worklet node (M2). */
export function createApeksNode(ctx: BaseAudioContext, instance: { params: Record<string, number> }): EffectRuntime {
  return makeStereoWorkletRuntime(ctx, "apeks-processor", instance, APEKS_PARAMS);
}

const SIRKA_PARAMS = ["lowFreq", "highFreq", "lowWidth", "midWidth", "highWidth", "mix"];

/** Create the ŠÍRKA per-band imager worklet node (M2). */
export function createSirkaNode(ctx: BaseAudioContext, instance: { params: Record<string, number> }): EffectRuntime {
  return makeStereoWorkletRuntime(ctx, "sirka-processor", instance, SIRKA_PARAMS);
}

const PRUD_PARAMS = [
  "freq1",
  "thresh1",
  "amount1",
  "q1",
  "freq2",
  "thresh2",
  "amount2",
  "q2",
  "attack",
  "release",
  "output",
];

/** Create the PRÚD dynamic EQ worklet node (M2). */
export function createPrudNode(ctx: BaseAudioContext, instance: { params: Record<string, number> }): EffectRuntime {
  return makeStereoWorkletRuntime(ctx, "prud-processor", instance, PRUD_PARAMS);
}
