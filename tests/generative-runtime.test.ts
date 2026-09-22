import { describe, expect, it } from "vitest";
import { GenerativeRuntime } from "../src/generative/runtime";
import { GenerativeProviderRegistry, createMockGenerativeProvider } from "../src/generative";
import { createDefaultProject } from "../src/project-model/schema";
import { createGenerativeTrack } from "../src/commands/commands";
import { Transport } from "../src/transport/Transport";
import type { GenerativePlayerHandle, GenerativePlayerStatus } from "../src/audio-worklets/generative-player-node";
import type { ProjectDocument } from "../src/project-model/types";
import type { IUserSampleRepository } from "../src/persistence/contracts";
import { setAudioDecoder } from "../src/services/audio-decode";

function fixture(): { doc: ProjectDocument; trackId: string } {
  const base = createDefaultProject();
  const doc = createGenerativeTrack(base).execute(base);
  const track = doc.tracks.find((candidate) => candidate.kind === "generative");
  if (!track || track.kind !== "generative") throw new Error("generative fixture missing");
  return { doc, trackId: track.id };
}

function makePlayer(log: { pushed: number[]; disposed: number; flushed: number }): GenerativePlayerHandle {
  const listeners = new Set<(status: GenerativePlayerStatus) => void>();
  return {
    output: {} as AudioNode,
    pushChunk: (chunk) => log.pushed.push(chunk.sequence),
    flush: () => {
      log.flushed++;
    },
    subscribeStatus: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => {
      log.disposed++;
      listeners.clear();
    },
  };
}

function runtimeFixture() {
  const { doc, trackId } = fixture();
  const providers = new GenerativeProviderRegistry();
  providers.register(createMockGenerativeProvider({ providerId: "mrt2", modelId: "mrt2_small" }));
  const transport = new Transport({ now: () => 0 }, doc.bpm);
  const log = { pushed: [] as number[], disposed: 0, flushed: 0, attached: 0, detached: 0 };
  const engine = {
    context: { sampleRate: 48000 } as BaseAudioContext,
    ensureContext: () => ({ sampleRate: 48000 }) as BaseAudioContext,
    attachGenerativeSource: () => {
      log.attached++;
    },
    detachGenerativeSource: () => {
      log.detached++;
    },
  };
  const runtime = new GenerativeRuntime({
    engine: engine as never,
    transport,
    project: () => doc,
    providers,
    loadWorklets: async () => undefined,
    isPlayerReady: () => true,
    createPlayer: () => makePlayer(log),
  });
  return { runtime, trackId, log };
}

describe("generative runtime", () => {
  it("starts a provider session, forwards chunks and detaches on stop", async () => {
    const { runtime, trackId, log } = runtimeFixture();

    await runtime.startTrack(trackId);

    expect(runtime.getStatus(trackId).state).toBe("running");
    expect(log.attached).toBe(1);
    expect(log.pushed).toEqual([0]);

    await runtime.stopTrack(trackId);

    expect(runtime.getStatus(trackId).state).toBe("ready");
    expect(log.flushed).toBe(1);
    expect(log.disposed).toBe(1);
    expect(log.detached).toBe(1);
  });

  it("invalidates an in-flight start so a late provider cannot reattach audio", async () => {
    const { doc, trackId } = fixture();
    const providers = new GenerativeProviderRegistry();
    const provider = createMockGenerativeProvider({ providerId: "mrt2", modelId: "mrt2_small" });
    providers.register(provider);
    const transport = new Transport({ now: () => 0 }, doc.bpm);
    let releaseLoad: (() => void) | undefined;
    const load = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const log = { pushed: [] as number[], disposed: 0, flushed: 0, attached: 0, detached: 0 };
    const runtime = new GenerativeRuntime({
      engine: {
        context: { sampleRate: 48000 } as BaseAudioContext,
        ensureContext: () => ({ sampleRate: 48000 }) as BaseAudioContext,
        attachGenerativeSource: () => log.attached++,
        detachGenerativeSource: () => log.detached++,
      } as never,
      transport,
      project: () => doc,
      providers,
      loadWorklets: () => load,
      isPlayerReady: () => true,
      createPlayer: () => makePlayer(log),
    });
    const pending = runtime.startTrack(trackId);
    await runtime.stopTrack(trackId);
    releaseLoad?.();
    await pending;

    expect(log.attached).toBe(0);
    expect(log.disposed).toBe(0);
    expect(runtime.getStatus(trackId).state).toBe("ready");
  });

  it("surfaces a missing provider explicitly instead of silently falling back", async () => {
    const { doc, trackId } = fixture();
    const runtime = new GenerativeRuntime({
      engine: {} as never,
      transport: new Transport({ now: () => 0 }, doc.bpm),
      project: () => doc,
      providers: new GenerativeProviderRegistry(),
    });

    await runtime.startTrack(trackId);

    expect(runtime.getStatus(trackId)).toEqual({ state: "unavailable", message: "Provider mrt2 is not installed" });
  });

  it("captures through the provider and commits one normal AudioClip command", async () => {
    const { doc, trackId } = fixture();
    let currentDoc = doc;
    const providers = new GenerativeProviderRegistry();
    providers.register(createMockGenerativeProvider({ providerId: "mrt2", modelId: "mrt2_small" }));
    const saved: string[] = [];
    const userSamples: IUserSampleRepository = {
      invalidateCache: () => undefined,
      list: async () => [],
      save: async (asset) => {
        saved.push(asset.id);
      },
      loadAudio: async () => undefined,
      listAudio: async () => [],
      remove: async () => undefined,
    };
    const bank = { add: (id: string) => saved.push(`bank:${id}`) };
    setAudioDecoder(
      async () =>
        ({ numberOfChannels: 2, sampleRate: 48000, getChannelData: () => new Float32Array(1) }) as AudioBuffer,
    );
    try {
      const runtime = new GenerativeRuntime({
        engine: {
          context: { sampleRate: 48000 } as BaseAudioContext,
          ensureContext: () => ({ sampleRate: 48000 }) as BaseAudioContext,
          attachGenerativeSource: () => undefined,
          detachGenerativeSource: () => undefined,
        } as never,
        transport: new Transport({ now: () => 0 }, doc.bpm),
        project: () => currentDoc,
        providers,
        bank: bank as never,
        userSamples,
        execute: (command) => {
          currentDoc = command.execute(currentDoc);
        },
      });

      const result = await runtime.captureTrack(trackId, 0.1, 3);

      expect(result.asset.origin).toBe("generated");
      expect(saved.some((id) => id === result.asset.id)).toBe(true);
      expect(saved.some((id) => id === `bank:${result.asset.id}`)).toBe(true);
      expect(currentDoc.arrangement.audioClips?.[0]).toMatchObject({
        trackId,
        bufferId: result.asset.id,
        startBar: 3,
      });
      await runtime.dispose();
    } finally {
      setAudioDecoder(null);
    }
  });
});
