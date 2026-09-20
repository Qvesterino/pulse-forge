import type { EffectRuntime } from "../effects/types";

/**
 * Create a Chorus AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadCoreWorklets()` first —
 * callers gate construction behind `isWorkletReady("chorus", ctx)`.
 */
export function createChorusNode(ctx: BaseAudioContext, instance: { params: Record<string, number> }): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "chorus-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
  });

  const input = ctx.createGain();
  const out = ctx.createGain();
  input.connect(node).connect(out);

  const setParam = (id: string, v: number, when?: number) => {
    const p = node.parameters.get(id);
    if (!p) return;
    if (when === undefined) p.value = v;
    else p.setValueAtTime(v, when);
  };
  setParam("rate", instance.params.rate ?? 0.6);
  setParam("depth", instance.params.depth ?? 0.5);
  setParam("spread", instance.params.spread ?? 1);
  setParam("mix", instance.params.mix ?? 0.5);
  out.gain.value = Math.pow(10, (instance.params.output ?? 0) / 20);

  const smoothOut = (v: number, when: number) => out.gain.setTargetAtTime(Math.pow(10, v / 20), when, 0.02);

  return {
    input,
    output: out,
    setParameter: (id, v) => {
      if (id === "output") {
        smoothOut(v, ctx.currentTime);
        return;
      }
      setParam(id, v, ctx.currentTime);
    },
    setParameterAt: (id, v, when) => {
      if (id === "output") {
        smoothOut(v, when);
        return;
      }
      setParam(id, v, when);
    },
    syncBpm(bpm) {
      // Snap the LFO to 1/4-beat rate (musical default for chorus motion).
      setParam("rate", bpm / 60 / 4, ctx.currentTime);
    },
    getAudioParam: (paramId: string) => node.parameters.get(paramId) ?? null,
    dispose() {
      node.disconnect();
      input.disconnect();
      out.disconnect();
    },
  };
}
