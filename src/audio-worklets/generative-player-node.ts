import type { GenerativeAudioChunk } from "../generative/types";

export interface GenerativePlayerStatus {
  type: "overrun" | "underrun" | "sequence-gap" | "recovered" | "sample-rate-mismatch";
  droppedFrames?: number;
  missingFrames?: number;
  expected?: number;
  received?: number;
  queuedFrames?: number;
}

export interface GenerativePlayerHandle {
  output: AudioNode;
  pushChunk(chunk: GenerativeAudioChunk): void;
  flush(): void;
  subscribeStatus(listener: (status: GenerativePlayerStatus) => void): () => void;
  dispose(): void;
}

/**
 * Create the realtime PCM sink after `loadCoreWorklets()` reports readiness.
 * Providers and React never touch the worklet queue directly; this is the
 * small AudioEngine-facing adapter that keeps ownership and lifecycle clear.
 */
export function createGenerativePlayerNode(
  ctx: BaseAudioContext,
  options: { channels?: number; maxFrames?: number } = {},
): GenerativePlayerHandle {
  const channels = options.channels === 1 ? 1 : 2;
  const maxFrames = Number.isInteger(options.maxFrames)
    ? Math.max(128, Math.min(480000, options.maxFrames ?? 96000))
    : 96000;
  const node = new AudioWorkletNode(ctx, "generative-player", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { channels, maxFrames },
  });
  const listeners = new Set<(status: GenerativePlayerStatus) => void>();
  node.port.onmessage = (event: MessageEvent<GenerativePlayerStatus>) => {
    const status = event.data;
    if (!status || typeof status.type !== "string") return;
    for (const listener of listeners) listener(status);
  };
  let disposed = false;
  return {
    output: node,
    pushChunk(chunk) {
      if (disposed) return;
      if (!Number.isInteger(chunk.frames) || chunk.frames <= 0) return;
      if (chunk.channels !== 1 && chunk.channels !== 2) return;
      if (chunk.data.length !== chunk.frames * chunk.channels) return;
      if (!Number.isSafeInteger(chunk.sampleRate) || chunk.sampleRate <= 0 || chunk.sampleRate > 192000) return;
      for (const sample of chunk.data) {
        if (!Number.isFinite(sample)) return;
      }
      const data = chunk.data.slice();
      node.port.postMessage(
        {
          type: "chunk",
          sequence: chunk.sequence,
          sampleRate: chunk.sampleRate,
          channels: chunk.channels,
          frames: chunk.frames,
          data,
        },
        [data.buffer],
      );
    },
    flush() {
      if (!disposed) node.port.postMessage({ type: "flush" });
    },
    subscribeStatus(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      node.port.onmessage = null;
      node.port.postMessage({ type: "flush" });
      node.disconnect();
    },
  };
}
