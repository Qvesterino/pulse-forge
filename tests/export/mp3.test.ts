import { describe, expect, it, vi } from "vitest";
import { encodeMp3 } from "../../src/export/mp3";

function fakeBuffer(seconds: number, channels = 2, sampleRate = 44100): AudioBuffer {
  const length = Math.floor(seconds * sampleRate);
  const datas = Array.from({ length: channels }, (_, c) => {
    const d = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      d[i] = 0.7 * Math.sin((i / sampleRate) * 440 * 2 * Math.PI * (c === 1 ? 1.005 : 1));
    }
    return d;
  });
  return {
    duration: seconds,
    sampleRate,
    numberOfChannels: channels,
    length,
    getChannelData: (c: number) => datas[Math.min(c, channels - 1)],
  } as unknown as AudioBuffer;
}

async function firstBytes(blob: Blob, n: number): Promise<number[]> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return Array.from(bytes.subarray(0, n));
}

describe("encodeMp3", () => {
  it("produces a valid MP3 stream (MPEG frame sync 0xFF Ex/Fx)", async () => {
    const blob = await encodeMp3(fakeBuffer(1), { kbps: 192 });
    expect(blob.type).toBe("audio/mpeg");
    expect(blob.size).toBeGreaterThan(10_000); // ~1 s @ 192 kbps ≈ 24 kB
    const [b0, b1] = await firstBytes(blob, 2);
    expect(b0).toBe(0xff);
    expect(b1! & 0xe0).toBe(0xe0); // MPEG audio frame sync (layer + version bits)
  });

  it("encodes mono buffers", async () => {
    const blob = await encodeMp3(fakeBuffer(0.5, 1), { kbps: 128 });
    expect(blob.size).toBeGreaterThan(3_000);
    const [b0] = await firstBytes(blob, 1);
    expect(b0).toBe(0xff);
  });

  it("rejects 96 kHz instead of encoding an invalid MPEG sample rate", async () => {
    await expect(encodeMp3(fakeBuffer(0.1, 2, 96_000))).rejects.toThrow(/MP3 export does not support 96000 Hz/);
  });

  it("higher bitrate produces a larger file", async () => {
    const low = await encodeMp3(fakeBuffer(2), { kbps: 128 });
    const high = await encodeMp3(fakeBuffer(2), { kbps: 320 });
    expect(high.size).toBeGreaterThan(low.size * 1.8);
  });

  it("is dramatically smaller than 16-bit WAV of the same audio", async () => {
    // 2 s stereo 44.1 kHz 16-bit WAV = 44100 * 2 * 2 * 2 ≈ 353 kB payload.
    const blob = await encodeMp3(fakeBuffer(2), { kbps: 192 });
    expect(blob.size).toBeLessThan(353_000 / 4);
  });

  it("reports progress reaching 1, monotonically", async () => {
    const fractions: number[] = [];
    await encodeMp3(fakeBuffer(1.5), { kbps: 192, onProgress: (f) => fractions.push(f) });
    expect(fractions.length).toBeGreaterThan(0);
    expect(fractions[fractions.length - 1]).toBe(1);
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]);
    }
  });
});

describe("encodeMp3 — cancellation (release roadmap 1.4)", () => {
  it("aborts at the next yield point without producing a Blob", async () => {
    const controller = new AbortController();
    // Abort right after the first yield — the encode loop must stop there.
    let yielded = false;
    const blobPromise = encodeMp3(fakeBuffer(30), {
      signal: controller.signal,
      onProgress: () => {
        if (!yielded) {
          yielded = true;
          controller.abort();
        }
      },
    });
    await expect(blobPromise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("clears a pending quantization yield and aborts without waiting for its timer", async () => {
    const controller = new AbortController();
    const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
    const originalClearTimeout = globalThis.clearTimeout.bind(globalThis);
    let reachedYield: (() => void) | null = null;
    let blockedTimer: ReturnType<typeof setTimeout> | null = null;
    let timerCleared = false;
    const yielded = new Promise<void>((resolve) => {
      reachedYield = resolve;
    });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, timeout) => {
      if (timeout === 0 && blockedTimer === null) {
        blockedTimer = 73 as unknown as ReturnType<typeof setTimeout>;
        return blockedTimer;
      }
      return originalSetTimeout(handler, timeout);
    });
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
      if (timer === blockedTimer) {
        timerCleared = true;
        return;
      }
      originalClearTimeout(timer);
    });

    try {
      const encoding = encodeMp3(fakeBuffer(4), {
        signal: controller.signal,
        onProgress: (fraction) => {
          if (fraction > 0 && reachedYield) {
            reachedYield();
            reachedYield = null;
          }
        },
      });
      await yielded;
      controller.abort();
      await expect(encoding).rejects.toMatchObject({ name: "AbortError" });
      expect(timerCleared).toBe(true);
    } finally {
      controller.abort();
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it("a signal that never aborts produces a normal Blob", async () => {
    const controller = new AbortController();
    const blob = await encodeMp3(fakeBuffer(0.5), { signal: controller.signal, kbps: 128 });
    expect(blob.type).toBe("audio/mpeg");
    expect(blob.size).toBeGreaterThan(3_000);
  });
});
