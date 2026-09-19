import type { EffectRuntime } from "../effects/types";

/**
 * Create a Pitch Shifter AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadCoreWorklets()` first —
 * callers gate construction behind `isWorkletReady("pitchShift", ctx)`.
 *
 * The instance id seeds the grain phase offset, so two instances of the same
 * preset stacked on different tracks don't sum their artifacts in phase.
 */
export function createPitchShiftNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number>; id?: string },
): EffectRuntime {
  let seed = 1;
  const id = instance.id ?? "";
  for (let i = 0; i < id.length; i++) {
    seed = (Math.imul(seed, 31) + id.charCodeAt(i)) | 0;
  }
  const node = new AudioWorkletNode(ctx, "pitchshift-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 2,
    channelInterpretation: "speakers",
    processorOptions: { seed: Math.abs(seed) || 1 },
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
  setParam("semitones", instance.params.semitones ?? 0);
  setParam("fine", instance.params.fine ?? 0);
  setParam("grainMs", instance.params.grainMs ?? 55);
  setParam("width", instance.params.width ?? 0.5);
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
