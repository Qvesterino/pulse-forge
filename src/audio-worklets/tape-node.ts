import type { EffectRuntime } from "../effects/types";

/**
 * Create a Tape Saturation AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadWorkletModules()` first —
 * callers gate construction behind `isWorkletReady("tapeSat", ctx)`.
 */
export function createTapeNode(ctx: BaseAudioContext, instance: { params: Record<string, number> }): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "tape-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
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
  setParam("drive", instance.params.drive ?? 0.4);
  setParam("hysteresis", instance.params.hysteresis ?? 0.3);
  setParam("tone", instance.params.tone ?? 6500);
  setParam("mix", instance.params.mix ?? 1);
  setParam("output", instance.params.output ?? 0);

  return {
    input,
    output,
    // 4× oversampling FIR cascade: 32 samples of group delay at 4× =
    // exactly 8 base-rate samples (the dry path inside is aligned too —
    // this is only so the engine's PDC can align OTHER chains with us).
    getLatencySec: () => 8 / ctx.sampleRate,
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
