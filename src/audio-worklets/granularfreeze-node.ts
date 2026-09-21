import type { EffectRuntime } from "../effects/types";
import { safeApplyAudioParam } from "./safeAudioParam";

/**
 * Create a Granular Freeze AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadCoreWorklets()` first —
 * callers gate construction behind `isWorkletReady("granularFreeze", ctx)`.
 *
 * Send-bus texture hold: the ring buffer records continuously; a `freeze`
 * latch locks a `window` of that recording and a granular cloud plays it
 * forever (drift, scatter, pitch, tone) while the dry path is ducked by the
 * same envelope — a live freeze pad from whatever the bus is carrying.
 */
export function createGranularFreezeNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number>; id?: string },
  env?: { seed?: number },
): EffectRuntime {
  // Instance id seeds the grain scatter — every instance clouds differently
  // but deterministically (offline parity). `env.seed` wins when provided.
  let seed = 11;
  const id = instance.id ?? "";
  for (let i = 0; i < id.length; i++) {
    seed = (Math.imul(seed, 33) + id.charCodeAt(i)) | 0;
  }
  const node = new AudioWorkletNode(ctx, "granularfreeze-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
    processorOptions: { seed: (env?.seed ?? Math.abs(seed)) || 11 },
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node).connect(output);

  for (const param of [
    "freeze",
    "window",
    "position",
    "drift",
    "grainMs",
    "scatter",
    "pitch",
    "tone",
    "level",
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
