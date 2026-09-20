import type { EffectRuntime } from "../effects/types";

/**
 * Create a stock Delay AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadCoreWorklets()` first —
 * callers gate construction behind `isWorkletReady("delay", ctx)`.
 */
export function createStockDelayNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number> },
  bpm: number,
): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "stock-delay-processor", {
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
  setParam("time", instance.params.time ?? 375);
  setParam("sync", instance.params.sync ?? 0);
  setParam("bpm", bpm);
  setParam("pingPong", instance.params.pingPong ?? 0);
  setParam("feedback", instance.params.feedback ?? 0.35);
  setParam("tone", instance.params.tone ?? 4000);
  setParam("mix", instance.params.mix ?? 0.25);

  return {
    input,
    output,
    setParameter: (id, v) => setParam(id, v, ctx.currentTime),
    setParameterAt: (id, v, when) => setParam(id, v, when),
    syncBpm(nextBpm) {
      setParam("bpm", nextBpm, ctx.currentTime);
    },
    getAudioParam: (paramId: string) => node.parameters.get(paramId) ?? null,
    dispose() {
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}
