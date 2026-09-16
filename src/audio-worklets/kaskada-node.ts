import type { EffectRuntime } from "../effects/types";

/**
 * Main-thread wrapper for the KYX Kaskáda AudioWorklet delay processor.
 *
 * All parameters are k-rate — set via node.parameters.get(id).setValueAtTime().
 * `bpm` is a hidden parameter used to resolve tempo-synced delay times.
 * `syncBpm` on the runtime pushes the effective (scene) tempo from Wave 1.
 */
export function createKaskadaNode(ctx: BaseAudioContext, instance: { params: Record<string, number> }): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "kaskada", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node);
  node.connect(output);

  const setParam = (id: string, v: number, when?: number) => {
    const param = node.parameters.get(id);
    if (!param) return;
    if (when === undefined) param.value = v;
    else param.setValueAtTime(v, when);
  };

  // Apply initial params
  for (const [id, v] of Object.entries(instance.params)) setParam(id, v);

  return {
    input,
    output,
    setParameter: (id, value) => setParam(id, value),
    setParameterAt: (id, value, when) => setParam(id, value, when),
    syncBpm: (bpm) => setParam("bpm", bpm),
    dispose: () => {
      input.disconnect();
      output.disconnect();
      node.disconnect();
    },
  };
}
