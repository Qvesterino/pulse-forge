import { describe, expect, it, vi } from "vitest";
import { detectTransientsAsync } from "../src/audio-workers/onset-detector-client";
import { detectTransients } from "../src/audio-workers/onset-detector";

describe("detectTransientsAsync", () => {
  it("falls back to the pure detector when module workers are unavailable", async () => {
    const data = new Float32Array(44_100 * 2);
    data[4_410] = 1;
    const result = await detectTransientsAsync(data, 44_100);
    expect(result).toEqual(detectTransients(data, 44_100));
  });

  it("transfers a copy to a worker and terminates it after a response", async () => {
    const posted: Array<{ message: unknown; transfer: Transferable[] }> = [];
    const terminate = vi.fn();
    class FakeWorker {
      onmessage: ((event: MessageEvent<{ times: number[] }>) => void) | null = null;
      onerror: (() => void) | null = null;
      postMessage(message: unknown, transfer: Transferable[]) {
        posted.push({ message, transfer });
        this.onmessage?.({ data: { times: [0.1, Number.NaN, 0.4] } } as MessageEvent<{ times: number[] }>);
      }
      terminate = terminate;
    }
    vi.stubGlobal("Worker", FakeWorker);
    try {
      const data = new Float32Array(44_100 * 2);
      const result = await detectTransientsAsync(data, 44_100);
      expect(result).toEqual([0.1, 0.4]);
      expect(posted).toHaveLength(1);
      expect(posted[0]?.transfer).toHaveLength(1);
      expect(posted[0]?.message).toMatchObject({ sampleRate: 44_100, sensitivity: 1 });
      expect(terminate).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("terminates a pending worker when the caller aborts", async () => {
    const terminate = vi.fn();
    class PendingWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      terminate = terminate;
      postMessage() {}
    }
    vi.stubGlobal("Worker", PendingWorker);
    try {
      const controller = new AbortController();
      const pending = detectTransientsAsync(new Float32Array(44_100 * 2), 44_100, 1, controller.signal);
      controller.abort();
      await expect(pending).resolves.toEqual([]);
      expect(terminate).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
