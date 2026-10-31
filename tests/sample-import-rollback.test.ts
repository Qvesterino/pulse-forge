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

  it("restores the previously playable buffer when a same-id re-import fails", async () => {
    const id = "user.same-audio";
    const previous = {
      duration: 1,
      sampleRate: 44100,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array([0.25]),
    };
    const replacement = {
      ...previous,
      getChannelData: () => new Float32Array([0.75]),
    };
    const bank = new SampleBank();
    bank.add(id, previous as unknown as AudioBuffer);
    const services = {
      engine: { context: { decodeAudioData: async () => replacement } },
      bank,
      userSamples: {
        save: async () => {
          throw new Error("write failed");
        },
      },
    } as unknown as Services;

    await expect(importAudioFile(services, wav("same.wav"), { id, detectBpm: false })).rejects.toThrow("write failed");

    expect(bank.get(id)).toBe(previous);
  });

  it("serializes concurrent imports with the same id so rollback cannot remove the later buffer", async () => {
    const id = "user.same-audio";
    const firstBuffer = {
      duration: 1,
      sampleRate: 44100,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array([0.25]),
    };
    const secondBuffer = {
      ...firstBuffer,
      getChannelData: () => new Float32Array([0.75]),
    };
    const bank = new SampleBank();
    const firstSave = deferred<void>();
    let saveCount = 0;
    const save = vi.fn(async () => {
      if (saveCount++ === 0) await firstSave.promise;
    });
    let decoded = 0;
    const services = {
      engine: {
        context: {
          decodeAudioData: async () => (decoded++ === 0 ? firstBuffer : secondBuffer),
        },
      },
      bank,
      userSamples: { save },
    } as unknown as Services;

    const first = importAudioFile(services, wav("same.wav"), { id, detectBpm: false });
    const second = importAudioFile(services, wav("same.wav"), { id, detectBpm: false });
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    firstSave.reject(new Error("first write failed"));

    await expect(first).rejects.toThrow("first write failed");
    await expect(second).resolves.toMatchObject({ id });
    expect(save).toHaveBeenCalledTimes(2);
    expect(bank.get(id)).toBe(secondBuffer);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
