import type { EffectRuntime } from "../effects/types";
import { safeApplyAudioParam } from "./safeAudioParam";

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

  safeApplyAudioParam(node, "division", instance.params.division ?? 4);
  safeApplyAudioParam(node, "depth", instance.params.depth ?? 1);
  safeApplyAudioParam(node, "smooth", instance.params.smooth ?? 0.15);
  safeApplyAudioParam(node, "mix", instance.params.mix ?? 1);

  return {
    input,
    output,
    setParameter(id, value) {
      safeApplyAudioParam(node, id, value, ctx.currentTime);
    },
    setParameterAt(id, value, when) {
      safeApplyAudioParam(node, id, value, when);
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
