import type { EffectRuntime } from "../effects/types";

import { attachProcessorErrorGuard } from "./processor-errors";
import { safeApplyAudioParam } from "./safeAudioParam";

/**
 * Create the Wow & Flutter AudioWorkletNode synchronously.
 * The processor ships inside the CORE worklet bundle (`core-processor.js`), so
 * callers gate construction behind `isWorkletReady("tapeSat", ctx)` the same way
 * they do for the other core-bundled character effects.
 *
 * The instance id seeds the drift RNG: every instance wanders differently, and
 * identically for the same seed, so the live/offline bit-identity contract
 * holds. The engine passes a project-scoped `env.seed` when available.
 */
export function createWowFlutterNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number>; id?: string },
  env?: { seed?: number },
): EffectRuntime {
  let seed = 11;
  const id = instance.id ?? "";
  for (let i = 0; i < id.length; i++) {
    seed = (Math.imul(seed, 33) + id.charCodeAt(i)) | 0;
  }
  const node = new AudioWorkletNode(ctx, "wowflutter-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
    processorOptions: { seed: (env?.seed ?? Math.abs(seed)) || 11 },
  });
  attachProcessorErrorGuard(node, "wowflutter-processor");

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node).connect(output);

  // Replay every descriptor parameter present in the instance so partial
  // documents (older schemas, presets) keep their defaults from the worklet.
  for (const param of ["wowRate", "wowDepth", "flutterRate", "flutterDepth", "drift", "mix", "output"] as const) {
    const v = instance.params[param];
    if (Number.isFinite(v)) safeApplyAudioParam(node, param, v);
  }

  return {
    input,
    output,
    setParameter: (p, v) => safeApplyAudioParam(node, p, v, ctx.currentTime),
    setParameterAt: (p, v, when) => safeApplyAudioParam(node, p, v, when),
    getAudioParam: (paramId: string) => node.parameters.get(paramId) ?? null,
    dispose() {
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}
