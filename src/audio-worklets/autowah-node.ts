import type { EffectRuntime } from "../effects/types";

/**
 * Create an Autowah AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadWorkletModules()` first —
 * callers gate construction behind `isWorkletReady("autowah", ctx)`.
 */
export function createAutowahNode(ctx: BaseAudioContext, instance: { params: Record<string, number> }): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "autowah-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 2,
    channelInterpretation: "speakers",
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
  setParam("minFreq", instance.params.minFreq ?? 300);
  setParam("maxFreq", instance.params.maxFreq ?? 2500);
  setParam("resonance", instance.params.resonance ?? 0.7);
  setParam("attack", instance.params.attack ?? 0.01);
  setParam("release", instance.params.release ?? 0.15);
  setParam("sensitivity", instance.params.sensitivity ?? 1.5);
  setParam("mode", instance.params.mode ?? 0);
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
