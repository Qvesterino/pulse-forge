import { describe, expect, it } from "vitest";
import { createMockGenerativeProvider } from "../src/generative/mock-provider";
import { persistGeneratedAudio, generatedAudioToWav, persistGeneratedAudioAsClip } from "../src/generative/capture";
import { createDefaultProject } from "../src/project-model/schema";
import type { IUserSampleRepository } from "../src/persistence/contracts";
import type { UserSampleAsset, UserSampleAudio } from "../src/persistence/UserSampleRepository";

function memoryRepository(): {
  repository: IUserSampleRepository;
  saved: { asset: UserSampleAsset; data?: ArrayBuffer | Blob }[];
} {
  const assets: UserSampleAsset[] = [];
  const audio = new Map<string, ArrayBuffer | Blob>();
  const saved: { asset: UserSampleAsset; data?: ArrayBuffer | Blob }[] = [];
  const repository: IUserSampleRepository = {
    invalidateCache: () => undefined,
    list: async () => assets,
    save: async (asset, data) => {
      assets.push(asset);
      if (data) audio.set(asset.id, data);
      saved.push({ asset, data });
    },
    loadAudio: async (id) => audio.get(id),
    listAudio: async (): Promise<UserSampleAudio[]> => [...audio.entries()].map(([id, data]) => ({ id, data })),
    remove: async (id) => {
      audio.delete(id);
    },
  };
  return { repository, saved };
}

describe("generated audio capture", () => {
  it("persists provider output as a user sample with provenance", async () => {
    const provider = createMockGenerativeProvider({ sampleRate: 8000, channels: 2 });
    const session = await provider.createSession({ modelId: "mock-small", outputSampleRate: 8000, outputChannels: 2 });
    const input = {
      bpm: 120,
      frameRateHz: 25 as const,
      startTick: 0,
      style: { kind: "text" as const, text: "dark pad" },
      noteFrames: [{ frameIndex: 0, pitchState: new Array<number>(128).fill(0) }],
      drumsMode: "off" as const,
      macros: { energy: 0.5, density: 0.3, variation: 0.2, texture: 0.6 },
    };
    const generated = await session.capture({ input, durationSec: 0.1 });
    const memory = memoryRepository();
    const generatedWithProvenance = {
      ...generated,
      provenance: { sourceHash: "ref-1234", prompt: "dark pad", providerVersion: "mock-v1" },
    };

    const asset = await persistGeneratedAudio(memory.repository, generatedWithProvenance, "AI / pad: take 1", {
      assetId: "generated-test-1",
      createdAt: "2026-09-22T00:00:00.000Z",
    });

    expect(asset.origin).toBe("generated");
    expect(asset.generated).toEqual({
      providerId: "mock-generative",
      modelId: "mock-small",
      inputHash: generated.inputHash,
      sourceHash: "ref-1234",
      prompt: "dark pad",
      providerVersion: "mock-v1",
    });
    expect(asset.fileName).toBe("AI-pad-take-1.wav");
    expect(memory.saved).toHaveLength(1);
    const data = memory.saved[0]?.data;
    expect(data).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(data as ArrayBuffer).slice(0, 4)).toEqual(new Uint8Array([82, 73, 70, 70]));
    await session.dispose();
  });

  it("rejects non-finite or shape-mismatched PCM before writing", () => {
    const invalid = {
      sampleRate: 48000,
      channels: 2,
      frames: 2,
      durationSec: 2 / 48000,
      data: new Float32Array([0, 0, Number.NaN]),
      providerId: "mrt2",
      modelId: "mrt2_small",
      inputHash: "deadbeef",
    };
    expect(() => generatedAudioToWav(invalid)).toThrow("PCM");
  });

  it("returns a normal undoable audio-clip command without mutating the document", async () => {
    const provider = createMockGenerativeProvider({ sampleRate: 8000, channels: 2 });
    const session = await provider.createSession({ modelId: "mock-small", outputSampleRate: 8000, outputChannels: 2 });
    const input = {
      bpm: 120,
      frameRateHz: 25 as const,
      startTick: 0,
      style: { kind: "text" as const, text: "dark pad" },
      noteFrames: [{ frameIndex: 0, pitchState: new Array<number>(128).fill(0) }],
      drumsMode: "off" as const,
      macros: { energy: 0.5, density: 0.3, variation: 0.2, texture: 0.6 },
    };
    const generated = await session.capture({ input, durationSec: 0.1 });
    const doc = createDefaultProject();
    const track = doc.tracks[0];
    if (!track) throw new Error("Expected a starter track");
    const memory = memoryRepository();

    const result = await persistGeneratedAudioAsClip(memory.repository, doc, generated, "generated pad", {
      assetId: "generated-clip-1",
      placement: { trackId: track.id, startBar: 2, lengthBars: 4 },
    });

    expect(doc.arrangement.audioClips ?? []).toHaveLength(0);
    const next = result.command.execute(doc);
    expect(next.arrangement.audioClips?.[0]).toMatchObject({
      trackId: track.id,
      bufferId: "generated-clip-1",
      startBar: 2,
      lengthBars: 4,
    });
    expect(result.asset.id).toBe("generated-clip-1");
    expect(result.wav.byteLength).toBeGreaterThan(44);
    await session.dispose();
  });

  it("survives the durable sample reload boundary before the project clip is restored", async () => {
    const provider = createMockGenerativeProvider({ sampleRate: 8000, channels: 2 });
    const session = await provider.createSession({ modelId: "mock-small", outputSampleRate: 8000, outputChannels: 2 });
    const input = {
      bpm: 120,
      frameRateHz: 25 as const,
      startTick: 0,
      style: { kind: "text" as const, text: "reloadable pad" },
      noteFrames: [{ frameIndex: 0, pitchState: new Array<number>(128).fill(0) }],
      drumsMode: "off" as const,
      macros: { energy: 0.5, density: 0.3, variation: 0.2, texture: 0.6 },
    };
    const generated = await session.capture({ input, durationSec: 0.1 });
    const memory = memoryRepository();
    await persistGeneratedAudio(memory.repository, generated, "reloadable", { assetId: "generated-reload-1" });

    const reloadedAssets = await memory.repository.list();
    const reloadedAudio = await memory.repository.loadAudio("generated-reload-1");
    expect(reloadedAssets[0]).toMatchObject({ id: "generated-reload-1", origin: "generated" });
    expect(reloadedAudio).toBeInstanceOf(ArrayBuffer);
    expect((reloadedAudio as ArrayBuffer).byteLength).toBeGreaterThan(44);
    await session.dispose();
  });
});
