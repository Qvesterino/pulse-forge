import type { EffectRuntime } from "../effects/types";
import { safeApplyAudioParam } from "./safeAudioParam";

/**
 * Create a Vinyl Suite AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadCoreWorklets()` first —
 * callers gate construction behind `isWorkletReady("vinyl", ctx)`.
 *
 * The instance id seeds the noise RNG — every instance crackles differently
 * but deterministically (offline parity). The engine passes a project-scoped
 * `env.seed` when available; the id hash is the documented fallback.
 */
export function createVinylNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number>; id?: string },
  env?: { seed?: number },
): EffectRuntime {
  let seed = 7;
  const id = instance.id ?? "";
  for (let i = 0; i < id.length; i++) {
    seed = (Math.imul(seed, 33) + id.charCodeAt(i)) | 0;
  }
  const node = new AudioWorkletNode(ctx, "vinyl-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
    processorOptions: { seed: (env?.seed ?? Math.abs(seed)) || 7 },
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node).connect(output);

  // Replay every descriptor parameter present in the instance so partial
  // documents (older schemas, presets) keep their defaults from the worklet.
  for (const param of [
    "amount",
    "crackle",
    "crackleTone",
    "crackleDecay",
    "hiss",
    "hissTone",
    "rumble",
    "rumbleTone",
    "wowRate",
    "wow",
    "flutterRate",
    "flutter",
    "drive",
    "year",
    "toneLp",
    "toneHp",
    "width",
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
