import type { EffectRuntime } from "../effects/types";

/**
 * Create a Bus Compressor AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadWorkletModules()` first —
 * callers gate construction behind `isWorkletReady("compressor", ctx)`.
 *
 * Sidechain contract (mirrors the Sidechain effect): the engine wires the
 * detector source into input 1 via `setSidechainInput`; `null` disconnects.
 * The internal SC HPF filters the detector path only.
 *
 * GR metering: port messages { type: "gr", gr } → `getGainReductionDb()`
 * (same protocol as the look-ahead limiter).
 */
export interface CompressorHandle extends EffectRuntime {
  setSidechainInput(node: AudioNode | null): void;
}

export function createCompressorNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number> },
): CompressorHandle {
  const node = new AudioWorkletNode(ctx, "compressor-processor", {
    numberOfInputs: 2,
    numberOfOutputs: 1,
    channelCount: 2,
    channelInterpretation: "speakers",
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node); // main audio → input 0
  node.connect(output);

  let lastSidechainSource: AudioNode | null = null;
  let lastGrDb = 0;
  node.port.onmessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; gr?: number } | null;
    if (data?.type === "gr" && typeof data.gr === "number") lastGrDb = data.gr;
  };

  const apply = (id: string, v: number, when: number | undefined) => {
    const p = node.parameters.get(id);
    if (!p) return;
    if (when === undefined) p.value = v;
    else p.setValueAtTime(v, when);
  };
  apply("threshold", instance.params.threshold ?? -18, undefined);
  apply("ratio", instance.params.ratio ?? 3, undefined);
  apply("attack", instance.params.attack ?? 0.01, undefined);
  apply("release", instance.params.release ?? 0.2, undefined);
  apply("knee", instance.params.knee ?? 6, undefined);
  // Registry speaks dB for MAKEUP; the processor param is linear.
  apply("makeup", Math.pow(10, (instance.params.makeup ?? 0) / 20), undefined);
  apply("mix", instance.params.mix ?? 1, undefined);
  apply("detector", instance.params.detector ?? 0, undefined);
  apply("scHpf", instance.params.scHpf ?? 20, undefined);

  return {
    input,
    output,
    setParameter(id, value) {
      if (id === "makeup") {
        apply("makeup", Math.pow(10, value / 20), ctx.currentTime);
        return;
      }
      apply(id, value, ctx.currentTime);
    },
    setParameterAt(id, value, when) {
      if (id === "makeup") {
        apply("makeup", Math.pow(10, value / 20), when);
        return;
      }
      apply(id, value, when);
    },
    setSidechainInput(source: AudioNode | null) {
      if (lastSidechainSource) {
        try {
          lastSidechainSource.disconnect(node);
        } catch { /* not connected */ }
        lastSidechainSource = null;
      }
      if (source) {
        source.connect(node, 0, 1);
        lastSidechainSource = source;
      }
    },
    getGainReductionDb() {
      return lastGrDb;
    },
    dispose() {
      node.port.onmessage = null;
      if (lastSidechainSource) {
        try {
          lastSidechainSource.disconnect(node);
        } catch { /* already gone */ }
        lastSidechainSource = null;
      }
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}
