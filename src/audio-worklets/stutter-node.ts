import type { EffectRuntime } from "../effects/types";

/**
 * Create a Stutter AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadWorkletModules()` first —
 * callers gate construction behind `isWorkletReady("stutter", ctx)`.
 */
export interface StutterHandle extends EffectRuntime {
  setPattern(steps: readonly number[]): void;
}

export function createStutterNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number>; steps?: number[] },
): StutterHandle {
  const node = new AudioWorkletNode(ctx, "stutter-processor", {
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
  setParam("division", instance.params.division ?? 4);
  setParam("mix", instance.params.mix ?? 0.8);
  setParam("feedback", instance.params.feedback ?? 0);

  const steps = instance.steps && instance.steps.length > 0 ? instance.steps : undefined;
  if (steps) node.port.postMessage({ type: "pattern", steps: [...steps] });

  return {
    input,
    output,
    setParameter(id, value) {
      setParam(id, value, ctx.currentTime);
    },
    setParameterAt(id, value, when) {
      setParam(id, value, when);
    },
    getAudioParam: (paramId: string) => node.parameters.get(paramId) ?? null,
    syncBpm(bpm: number) {
      node.port.postMessage({ type: "bpm", bpm });
    },
    onTransportStarted(time: number, beatPhase: number) {
      node.port.postMessage({ type: "align", time, phase: beatPhase });
    },
    setPattern(pattern: readonly number[]) {
      node.port.postMessage({ type: "pattern", steps: [...pattern] });
    },
    dispose() {
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}
