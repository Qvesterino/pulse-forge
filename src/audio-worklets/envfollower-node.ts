/**
 * Create an Envelope Follower AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadWorkletModules()` first —
 * callers gate construction behind `isWorkletReady("envFollower", ctx)` and
 * fall back to a degraded, inert runtime entry otherwise (surfaced via
 * engine.getDegradedFx → UI warning badge).
 *
 * Output contract: mono control signal 0..~1 (audio-rate). The ENGINE owns the
 * depth Gain and the destination AudioParam wiring, mirroring oscillator LFOs.
 */
import { safeApplyAudioParam } from "./safeAudioParam";

export interface EnvFollowerHandle {
  input: AudioNode;
  output: AudioNode;
  /** Latest envelope value 0..1 (from port message polling). */
  getEnvelope(): number;
  getAudioParam?(paramId: string): AudioParam | null;
  dispose(): void;
}

export function createEnvFollowerNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number> },
): EnvFollowerHandle {
  const node = new AudioWorkletNode(ctx, "envfollower-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 2,
    channelInterpretation: "speakers",
    outputChannelCount: [1],
  });

  // safeApplyAudioParam guards non-finite writes (defensive layer for
  // automation curves / preset applies against corrupt stored values).
  safeApplyAudioParam(node, "attack", Math.max(0.001, instance.params.attackMs ?? 12) / 1000);
  safeApplyAudioParam(node, "release", Math.max(0.01, instance.params.releaseMs ?? 180) / 1000);
  safeApplyAudioParam(node, "sensitivity", instance.params.sensitivity ?? 1.5);

  let lastEnv = 0;
  node.port.onmessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; value?: number } | null;
    if (data?.type === "env" && typeof data.value === "number") lastEnv = data.value;
  };

  return {
    input: node,
    output: node,
    getEnvelope: () => lastEnv,
    getAudioParam: (paramId: string) => node.parameters.get(paramId) ?? null,
    dispose() {
      node.port.onmessage = null;
      node.disconnect();
    },
  } as EnvFollowerHandle & { getAudioParam: (id: string) => AudioParam | null };
}
