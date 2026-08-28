import type { EffectRuntime } from "../effects/types";

/**
 * Create a Reverb FDN AudioWorkletNode synchronously.
 * Processor must be pre-loaded via `loadWorkletModules()` — callers gate
 * behind `isWorkletReady("reverb", ctx)`.
 */
export function createReverbNode(ctx: BaseAudioContext, instance: { params: Record<string, number> }): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "reverb-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 2,
    channelInterpretation: "speakers",
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node).connect(output);

  const setParam = (id: string, v: number, when?: number) => {
    // Map legacy `tone` to `damping`+`tone` for compat
    const targetId = id === "tone" ? "tone" : id;
    const p = node.parameters.get(targetId);
    if (!p) {
      // Fallback: tone alias drives damping as well
      if (id === "tone") {
        const dp = node.parameters.get("damping");
        if (dp) {
          if (when === undefined) dp.value = v;
          else dp.setValueAtTime(v, when);
        }
      }
      return;
    }
    if (when === undefined) p.value = v;
    else p.setValueAtTime(v, when);
  };

  setParam("decay", instance.params.decay ?? 1.8);
  // Prefer explicit damping, else tone
  const damp = instance.params.damping ?? instance.params.tone ?? 6000;
  setParam("damping", damp);
  setParam("tone", damp);
  setParam("diffusion", instance.params.diffusion ?? 0.5);

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
