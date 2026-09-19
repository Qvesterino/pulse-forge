import type { EffectRuntime } from "../effects/types";

/**
 * Create a Vinyl / Lo-Fi AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadCoreWorklets()` first —
 * callers gate construction behind `isWorkletReady("vinyl", ctx)`.
 *
 * The instance id seeds the crackle RNG — every instance crackles differently
 * but deterministically (offline parity).
 */
export function createVinylNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number>; id?: string },
): EffectRuntime {
  let seed = 7;
  const id = instance.id ?? "";
  for (let i = 0; i < id.length; i++) {
    seed = (Math.imul(seed, 33) + id.charCodeAt(i)) | 0;
  }
  const node = new AudioWorkletNode(ctx, "vinyl-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 2,
    channelInterpretation: "speakers",
    processorOptions: { seed: Math.abs(seed) || 7 },
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node).connect(output);

  const setParam = (id: string, v: number, when?: number) => {
    const p = node.parameters.get(id);
    if (!p) return;
    if (when === undefined) p.value = v;
    else p.setValueAtTime(v, when);
  };
  setParam("amount", instance.params.amount ?? 0.5);
  setParam("crackle", instance.params.crackle ?? 0.5);
  setParam("wow", instance.params.wow ?? 0.5);
  setParam("year", instance.params.year ?? 0.8);
  setParam("mix", instance.params.mix ?? 1);

  return {
    input,
    output,
    setParameter: (id, v) => setParam(id, v, ctx.currentTime),
    setParameterAt: (id, v, when) => setParam(id, v, when),
    getAudioParam: (paramId: string) => node.parameters.get(paramId) ?? null,
    dispose() {
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}
