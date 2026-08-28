import { kWeightingCoefficients } from "../audio-engine/kweighting";
import { MIN_DB } from "../audio-engine/metering";

/**
 * Create the K-weighted loudness meter sink AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadWorkletModules()` first —
 * callers gate construction behind `isWorkletReady("kwmeter", ctx)`.
 *
 * The exact BS.1770 biquad coefficients are computed HERE (shared
 * kweighting.ts math, per-context sample rate) and shipped to the raw-JS
 * processor via processorOptions — no filter design duplicated on the audio
 * thread. Sink node: no outputs, master bus connects INTO it.
 */
export interface KwLoudness {
  /** Momentary (400 ms), LUFS. */
  m: number;
  /** Short-term (3 s), LUFS. */
  s: number;
  /** Integrated (gated), LUFS. */
  i: number;
}

export interface KwMeterHandle {
  input: AudioNode;
  getLoudness(): KwLoudness;
  reset(): void;
  dispose(): void;
}

const SILENT: KwLoudness = { m: MIN_DB, s: MIN_DB, i: MIN_DB };

export function createKwMeterNode(ctx: BaseAudioContext): KwMeterHandle {
  const [s1, s2] = kWeightingCoefficients(ctx.sampleRate);
  const node = new AudioWorkletNode(ctx, "kwmeter-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 2,
    channelInterpretation: "speakers",
    processorOptions: {
      s1: [s1.b0, s1.b1, s1.b2, s1.a1, s1.a2],
      s2: [s2.b0, s2.b1, s2.b2, s2.a1, s2.a2],
    },
  });

  let last: KwLoudness = { ...SILENT };
  node.port.onmessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; m?: number; s?: number; i?: number } | null;
    if (
      data?.type === "loudness" &&
      typeof data.m === "number" &&
      typeof data.s === "number" &&
      typeof data.i === "number"
    ) {
      last = { m: data.m, s: data.s, i: data.i };
    }
  };

  return {
    input: node,
    getLoudness: () => last,
    reset() {
      node.port.postMessage({ type: "reset" });
      last = { ...SILENT };
    },
    dispose() {
      node.port.onmessage = null;
      node.disconnect();
    },
  };
}
