import type { EffectRuntime } from "../effects/types";

/**
 * Create a Step Gate (trance gate) AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadWorkletModules()` first —
 * callers gate construction behind `isWorkletReady("stepGate", ctx)`.
 *
 * Transport sync: the engine calls `syncBpm` (BPM changes) and
 * `onTransportStarted` (play/seek) — both are forwarded to the processor via
 * the port. The processor's default anchor (phase 0 at time 0) keeps offline
 * renders deterministic; live playback re-anchors to the transport grid.
 * Pattern data flows through `setPattern` (port message).
 */
export interface StepGateHandle extends EffectRuntime {
  setPattern(steps: readonly number[]): void;
}

export function createStepGateNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number> },
): StepGateHandle {
  const node = new AudioWorkletNode(ctx, "stepgate-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node).connect(output);

  const apply = (id: string, v: number, when: number | undefined) => {
    const p = node.parameters.get(id);
    if (!p) return;
    if (when === undefined) p.value = v;
    else p.setValueAtTime(v, when);
  };
  apply("division", instance.params.division ?? 4, undefined);
  apply("depth", instance.params.depth ?? 1, undefined);
  apply("smooth", instance.params.smooth ?? 0.15, undefined);
  apply("mix", instance.params.mix ?? 1, undefined);

  return {
    input,
    output,
    setParameter(id, value) {
      apply(id, value, ctx.currentTime);
    },
    setParameterAt(id, value, when) {
      apply(id, value, when);
    },
    getAudioParam: (paramId: string) => node.parameters.get(paramId) ?? null,
    syncBpm(bpm: number) {
      node.port.postMessage({ type: "bpm", bpm });
    },
    onTransportStarted(time: number, beatPhase: number) {
      node.port.postMessage({ type: "align", time, phase: beatPhase });
    },
    setPattern(steps: readonly number[]) {
      node.port.postMessage({ type: "pattern", steps: [...steps] });
    },
    dispose() {
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}
