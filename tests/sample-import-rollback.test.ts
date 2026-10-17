import { describe, expect, it, vi } from "vitest";
import { importAudioFile } from "../src/ui/sample-import";
import { SampleBank } from "../src/sample-library/factory";
import type { Services } from "../src/services";

/**
 * Failure recovery for the shared sample-import path (DropZone / intake tray /
 * TSAR forge). The buffer is added to the in-memory bank BEFORE persistence;
 * when the IndexedDB write fails, the old code left that buffer in the bank as
 * a ghost sample — playable now, gone on the next reload, silently out of sync
 * with what is stored. The import must roll the bank back.
 */

function makeServices(save: (asset: unknown, raw: ArrayBuffer) => Promise<void>) {
  const bank = new SampleBank();
  const buffer = {
    duration: 1,
    sampleRate: 44100,
    numberOfChannels: 1,
    getChannelData: () => new Float32Array(64),
  };
  const services = {
    engine: { context: { decodeAudioData: async () => buffer } },
    bank,
    userSamples: { save },
  } as unknown as Services;
  return { services, bank };
}

function wav(name: string): File {
  return new File([new Uint8Array(16)], name, { type: "audio/wav" });
}

describe("importAudioFile persistence rollback", () => {
  it("removes the in-memory buffer when persistence fails", async () => {
    const { services, bank } = makeServices(async () => {
      throw new Error("QuotaExceededError");
    });

    await expect(importAudioFile(services, wav("kick.wav"))).rejects.toThrow("QuotaExceededError");

    expect(bank.size).toBe(0);
  });

  it("keeps the buffer when persistence succeeds", async () => {
    const save = vi.fn(async () => {});
    const { services, bank } = makeServices(save);

    const asset = await importAudioFile(services, wav("snare.wav"));

    expect(save).toHaveBeenCalledOnce();
    expect(bank.has(asset.id)).toBe(true);
    expect(bank.size).toBe(1);
  });
});
