import { describe, expect, it } from "vitest";
import { SampleBank } from "../src/sample-library/factory";
import { loadUserSampleMono } from "../src/mcp/sample-mono";
import type { Services } from "../src/services";

function fakeBuffer(channels: number[][], sampleRate = 44100): AudioBuffer {
  return {
    length: channels[0]?.length ?? 0,
    numberOfChannels: channels.length,
    sampleRate,
    duration: (channels[0]?.length ?? 0) / sampleRate,
    getChannelData: (index: number) => Float32Array.from(channels[index] ?? []),
    copyFromChannel: () => undefined,
    copyToChannel: () => undefined,
  } as unknown as AudioBuffer;
}

function servicesWith(bank: SampleBank, loadAudio: (id: string) => Promise<ArrayBuffer | Blob | undefined>) {
  return { bank, userSamples: { loadAudio } } as unknown as Pick<Services, "bank" | "userSamples">;
}

describe("UN-SUNO sample loader", () => {
  it("mixes a decoded stereo bank sample to mono without changing the sample rate", async () => {
    const bank = new SampleBank();
    bank.add(
      "user.take",
      fakeBuffer(
        [
          [1, 0.5],
          [0, 0.5],
        ],
        48000,
      ),
    );
    const loaded = await loadUserSampleMono(
      servicesWith(bank, async () => undefined),
      "user.take",
    );
    expect(loaded?.sampleRate).toBe(48000);
    expect(loaded?.mono[0]).toBeCloseTo(0.5, 6);
    expect(loaded?.mono[1]).toBeCloseTo(0.5, 6);
  });

  it("falls back to the repository bytes, decodes, and caches the sample in the bank", async () => {
    const bank = new SampleBank();
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const decoded = fakeBuffer([[0.25], [0.75]], 44100);
    const loaded = await loadUserSampleMono(
      servicesWith(bank, async () => bytes),
      "user.imported",
      async () => decoded,
    );
    expect(loaded?.mono[0]).toBeCloseTo(0.5, 6);
    expect(bank.get("user.imported")).toBe(decoded);
  });

  it("returns null for an unknown sample instead of inventing audio", async () => {
    const bank = new SampleBank();
    await expect(
      loadUserSampleMono(
        servicesWith(bank, async () => undefined),
        "user.missing",
      ),
    ).resolves.toBeNull();
  });
});
