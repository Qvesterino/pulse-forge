import type { EffectRuntime } from "../effects/types";
import { safeApplyAudioParam } from "./safeAudioParam";

/**
 * Create a Frequency Shifter AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadCoreWorklets()` first —
 * callers gate construction behind `isWorkletReady("freqShifter", ctx)`.
 *
 * Single-sideband Hilbert shifter (Bode-style): shift + fine detune the
 * spectrum without preserving harmonic ratios, with a pro sideband select,
 * sweep LFO, feedback delay loop, drive, wet tone trim and stereo spread.
 */
export function createFreqShiftNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number> },
): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "freqshift-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node).connect(output);

  // Replay every descriptor parameter present in the instance so partial
  // documents (older schemas, presets) keep their defaults from the worklet.
  for (const param of [
    "shift",
    "fine",
    "side",
    "lfoRate",
    "lfoDepth",
    "feedback",
    "delayTime",
    "drive",
    "tone",
    "spread",
    "mix",
  ] as const) {
    const v = instance.params[param];
    if (Number.isFinite(v)) safeApplyAudioParam(node, param, v);
  }

  return {
    input,
    output,
    setParameter: (id, v) => safeApplyAudioParam(node, id, v, ctx.currentTime),
    setParameterAt: (id, v, when) => safeApplyAudioParam(node, id, v, when),
    getAudioParam: (paramId: string) => node.parameters.get(paramId) ?? null,
    dispose() {
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}
