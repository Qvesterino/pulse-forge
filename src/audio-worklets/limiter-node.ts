import type { EffectRuntime } from "../effects/types";

/**
 * Create a Look-ahead Limiter AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadWorkletModules()` first
 * (callers check `isWorkletReady("limiter", ctx)` before constructing).
 *
 * Latency contract: the processor delays audio by exactly the `lookahead`
 * param (seconds). getLatencySec() feeds the engine's minimal PDC so tracks
 * with a limiter stay sample-aligned with dry tracks. Changing LOOKAHEAD at
 * runtime updates both the node and the reported latency on the next sync.
 */
export function createLimiterNode(ctx: BaseAudioContext, instance: { params: Record<string, number> }): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "limiter-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 2,
    channelInterpretation: "speakers",
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node).connect(output);

  let lookaheadMs = instance.params.lookaheadMs ?? 5;
  let lastGrDb = 0;
  node.port.onmessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; gr?: number } | null;
    if (data?.type === "gr" && typeof data.gr === "number") lastGrDb = data.gr;
  };

  // Registry speaks ms for LOOKAHEAD; the processor param is seconds.
  const apply = (id: string, v: number, when: number | undefined) => {
    const p = node.parameters.get(id);
    if (!p) return;
    if (when === undefined) p.value = v;
    else p.setValueAtTime(v, when);
  };
  apply("ceiling", instance.params.ceiling ?? -1, undefined);
  apply("threshold", instance.params.threshold ?? -6, undefined);
  apply("release", instance.params.release ?? 0.12, undefined);
  apply("lookahead", Math.max(1, lookaheadMs) / 1000, undefined);
  apply("link", instance.params.link ?? 1, undefined);
  apply("mix", instance.params.mix ?? 1, undefined);

  return {
    input,
    output,
    setParameter(id, value) {
      if (id === "lookaheadMs") {
        lookaheadMs = value;
        apply("lookahead", Math.max(1, value) / 1000, ctx.currentTime);
        return;
      }
      apply(id, value, ctx.currentTime);
    },
    setParameterAt(id, value, when) {
      if (id === "lookaheadMs") {
        lookaheadMs = value;
        apply("lookahead", Math.max(1, value) / 1000, when);
        return;
      }
      apply(id, value, when);
    },
    getAudioParam: (paramId: string) => node.parameters.get(paramId) ?? null,
    getLatencySec() {
      return Math.max(1, lookaheadMs) / 1000;
    },
    getGainReductionDb() {
      return lastGrDb;
    },
    dispose() {
      node.port.onmessage = null;
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}
