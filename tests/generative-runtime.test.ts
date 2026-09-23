import { describe, expect, it } from "vitest";
import { GenerativeRuntime } from "../src/generative/runtime";
import { GenerativeProviderRegistry, createMockGenerativeProvider } from "../src/generative";
import { createDefaultProject } from "../src/project-model/schema";
import { createGenerativeTrack } from "../src/commands/commands";
import { Transport } from "../src/transport/Transport";
import type { GenerativePlayerHandle, GenerativePlayerStatus } from "../src/audio-worklets/generative-player-node";
import type {
  GenerativeAudioSession,
  GenerativeAudioProvider,
  GenerativeCapabilities,
  GenerativeInput,
  GenerativeStatus,
} from "../src/generative/types";
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

function makePlayer(
  log: { pushed: number[]; disposed: number; flushed: number },
  onCreate?: (emit: (status: GenerativePlayerStatus) => void) => void,
): GenerativePlayerHandle {
  const listeners = new Set<(status: GenerativePlayerStatus) => void>();
  onCreate?.((status) => {
    for (const listener of listeners) listener(status);
  });
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

function runtimeFixture(provider = createMockGenerativeProvider({ providerId: "mrt2", modelId: "mrt2_small" })) {
  const { doc, trackId } = fixture();
  const providers = new GenerativeProviderRegistry();
  providers.register(provider);
  const transport = new Transport({ now: () => 0 }, doc.bpm);
  const log = { pushed: [] as number[], disposed: 0, flushed: 0, attached: 0, detached: 0, previewed: 0 };
  let emitPlayerStatus: ((status: GenerativePlayerStatus) => void) | undefined;
  const engine = {
    context: { sampleRate: 48000 } as BaseAudioContext,
    ensureContext: () => ({ sampleRate: 48000 }) as BaseAudioContext,
    attachGenerativeSource: () => {
      log.attached++;
    },
    detachGenerativeSource: () => {
      log.detached++;
    },
    previewBuffer: () => {
      log.previewed++;
    },
  };
  const runtime = new GenerativeRuntime({
    engine: engine as never,
    transport,
    project: () => doc,
    providers,
    loadWorklets: async () => undefined,
    isPlayerReady: () => true,
    createPlayer: () =>
      makePlayer(log, (emit) => {
        emitPlayerStatus = emit;
      }),
  });
  return {
    runtime,
    trackId,
    log,
    doc,
    transport,
    emitPlayerStatus: (status: GenerativePlayerStatus) => emitPlayerStatus?.(status),
  };
}

function inputRecordingProvider(inputs: GenerativeInput[]): GenerativeAudioProvider {
  const capabilities: GenerativeCapabilities = {
    providerId: "mrt2",
    modelIds: ["mrt2_small"],
    supportsRealtime: true,
    supportsCapture: false,
    supportsTextStyle: true,
    supportsAudioStyle: false,
    supportsNoteConditioning: true,
    supportsDrumsMode: false,
    supportsSeed: false,
    outputSampleRates: [48_000],
    outputChannels: [2],
    maxCaptureSeconds: 0,
  };
  return {
    id: "mrt2",
    getCapabilities: () => capabilities,
    createSession: async (config) => {
      let status: GenerativeStatus = { state: "idle" };
      const statusListeners = new Set<(next: GenerativeStatus) => void>();
      const setStatus = (next: GenerativeStatus): void => {
        status = next;
        for (const listener of statusListeners) listener(next);
      };
      return {
        capabilities,
        config,
        getStatus: () => status,
        subscribeStatus: (listener) => {
          statusListeners.add(listener);
          return () => statusListeners.delete(listener);
        },
        subscribeAudio: () => () => undefined,
        updateInput: async (input) => {
          inputs.push(input);
        },
        start: async () => setStatus({ state: "running" }),
        stop: async () => setStatus({ state: "ready" }),
        capture: async () => {
          throw new Error("capture is not supported by this test provider");
        },
        dispose: async () => setStatus({ state: "disposed" }),
      };
    },
  };
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

  it("refreshes conditioning with the current tempo and loop-wrap playhead", async () => {
    const inputs: GenerativeInput[] = [];
    const { runtime, trackId, transport } = runtimeFixture(inputRecordingProvider(inputs));
    await runtime.startTrack(trackId);

    transport.play(1_920, { leadIn: false });
    transport.setBpm(90);
    await runtime.refreshAll();
    expect(inputs.at(-1)).toMatchObject({ bpm: 90, startTick: 1_920 });

    transport.setLoop(true, 960, 1_920);
    // Scheduler re-anchors the transport to loopStart on a loop boundary.
    transport.seek(960);
    await runtime.refreshAll();
    expect(inputs.at(-1)).toMatchObject({ bpm: 90, startTick: 960 });

    await runtime.dispose();
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

  it("surfaces bounded player underrun and recovery as lifecycle states", async () => {
    const { runtime, trackId, emitPlayerStatus } = runtimeFixture();
    await runtime.startTrack(trackId);

    emitPlayerStatus({ type: "underrun", missingFrames: 128 });
    expect(runtime.getStatus(trackId)).toEqual({ state: "buffering", message: "audio underrun (128 frames)" });

    emitPlayerStatus({ type: "recovered", queuedFrames: 512 });
    expect(runtime.getStatus(trackId)).toEqual({ state: "running", message: "audio buffer recovered" });

    await runtime.dispose();
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

  it("reports an unavailable provider before the first play attempt", () => {
    const { doc, trackId } = fixture();
    const providers = new GenerativeProviderRegistry();
    providers.register({
      id: "mrt2",
      getCapabilities: () => ({
        providerId: "mrt2",
        modelIds: ["mrt2_small"],
        supportsRealtime: false,
        supportsCapture: false,
        supportsTextStyle: false,
        supportsAudioStyle: false,
        supportsNoteConditioning: false,
        supportsDrumsMode: false,
        supportsSeed: false,
        macroSupport: {},
        outputSampleRates: [],
        outputChannels: [],
        maxCaptureSeconds: 0,
      }),
      createSession: async () => {
        throw new Error("session must not be created");
      },
    });
    const runtime = new GenerativeRuntime({
      engine: {} as never,
      transport: new Transport({ now: () => 0 }, doc.bpm),
      project: () => doc,
      providers,
    });

    expect(runtime.getStatus(trackId)).toEqual({
      state: "unavailable",
      message: "Provider does not support realtime playback",
    });
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
        ({
          numberOfChannels: 2,
          sampleRate: 48000,
          getChannelData: () => new Float32Array(1),
        }) as unknown as AudioBuffer,
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

  it("removes the durable asset and skips the command when capture decode fails", async () => {
    const { doc, trackId } = fixture();
    const providers = new GenerativeProviderRegistry();
    providers.register(createMockGenerativeProvider({ providerId: "mrt2", modelId: "mrt2_small" }));
    const saved: string[] = [];
    const removed: string[] = [];
    let executeCount = 0;
    const userSamples: IUserSampleRepository = {
      invalidateCache: () => undefined,
      list: async () => [],
      save: async (asset) => {
        saved.push(asset.id);
      },
      loadAudio: async () => undefined,
      listAudio: async () => [],
      remove: async (id) => {
        removed.push(id);
      },
    };
    setAudioDecoder(async () => {
      throw new Error("decode failed");
    });
    try {
      const runtime = new GenerativeRuntime({
        engine: {
          context: { sampleRate: 48000 } as BaseAudioContext,
          ensureContext: () => ({ sampleRate: 48000 }) as BaseAudioContext,
          attachGenerativeSource: () => undefined,
          detachGenerativeSource: () => undefined,
        } as never,
        transport: new Transport({ now: () => 0 }, doc.bpm),
        project: () => doc,
        providers,
        userSamples,
        execute: () => {
          executeCount++;
        },
      });

      await expect(runtime.captureTrack(trackId, 0.1)).rejects.toThrow("decode failed");
      expect(saved).toHaveLength(1);
      expect(removed).toEqual(saved);
      expect(executeCount).toBe(0);
      await runtime.dispose();
    } finally {
      setAudioDecoder(null);
    }
  });

  it("generates resample previews without mutating the project", async () => {
    const { runtime, trackId, log } = runtimeFixture();
    const source = {
      numberOfChannels: 2,
      sampleRate: 48_000,
      duration: 0.1,
      getChannelData: () => new Float32Array([0.1, 0.2, 0.3, 0.4]),
    } as unknown as AudioBuffer;
    const variations = await runtime.generateResampleVariations(trackId, source, { durationSec: 0.02, count: 4 });
    expect(variations.map((variation) => variation.label)).toEqual(["A", "B", "C", "D"]);
    expect(variations[0]?.audio.provenance?.sourceHash).toMatch(/^[0-9a-f]{8}$/u);
    expect(variations[0]?.audio.provenance?.prompt).toBe("dark atmospheric accompaniment");
    expect(runtime.getStatus(trackId).state).toBe("idle");
    setAudioDecoder(
      async () =>
        ({
          numberOfChannels: 2,
          sampleRate: 48000,
          getChannelData: () => new Float32Array(1),
        }) as unknown as AudioBuffer,
    );
    try {
      await runtime.previewResampleVariation(variations[0]!);
      expect(log.previewed).toBe(1);
    } finally {
      setAudioDecoder(null);
    }
    await runtime.dispose();
  });

  it("keeps the last valid conditioning input when a live refresh becomes invalid", async () => {
    const { runtime, trackId, doc } = runtimeFixture();
    await runtime.startTrack(trackId);
    const track = doc.tracks.find((candidate) => candidate.id === trackId);
    if (!track || track.kind !== "generative") throw new Error("generative fixture missing");
    track.generative.style = { kind: "audio", bufferId: "missing-style" };

    await runtime.refreshAll();

    expect(runtime.getStatus(trackId)).toMatchObject({
      state: "running",
      message: expect.stringContaining("fallback"),
    });
    await runtime.dispose();
  });

  it("retires the live graph after a provider refresh stall", async () => {
    const { doc, trackId } = fixture();
    const providers = new GenerativeProviderRegistry();
    const capabilities: GenerativeCapabilities = {
      providerId: "mrt2",
      modelIds: ["mrt2_small"],
      supportsRealtime: true,
      supportsCapture: true,
      supportsTextStyle: true,
      supportsAudioStyle: true,
      supportsNoteConditioning: true,
      supportsDrumsMode: true,
      supportsSeed: true,
      macroSupport: {},
      outputSampleRates: [48_000],
      outputChannels: [2],
      maxCaptureSeconds: 120,
    };
    let createdSessions = 0;
    let stopCalls = 0;
    let disposeCalls = 0;
    let emitProviderStatus: ((status: GenerativeStatus) => void) | undefined;
    providers.register({
      id: "mrt2",
      getCapabilities: () => capabilities,
      createSession: async (config): Promise<GenerativeAudioSession> => {
        createdSessions++;
        let updateCalls = 0;
        let status: GenerativeStatus = { state: "idle" };
        const statusListeners = new Set<(next: GenerativeStatus) => void>();
        return {
          capabilities,
          config,
          getStatus: () => status,
          subscribeStatus: (listener) => {
            statusListeners.add(listener);
            emitProviderStatus = (next) => {
              for (const current of statusListeners) current(next);
            };
            return () => statusListeners.delete(listener);
          },
          subscribeAudio: () => () => undefined,
          updateInput: async () => {
            updateCalls++;
            if (updateCalls >= 3) throw new Error("provider refresh stalled");
          },
          start: async () => {
            status = { state: "running" };
            for (const listener of statusListeners) listener(status);
          },
          stop: async () => {
            stopCalls++;
            status = { state: "ready" };
          },
          capture: async () => {
            throw new Error("capture unused");
          },
          dispose: async () => {
            disposeCalls++;
            status = { state: "disposed" };
          },
        };
      },
    });
    const log = { attached: 0, detached: 0, disposed: 0 };
    const runtime = new GenerativeRuntime({
      engine: {
        context: { sampleRate: 48_000 } as BaseAudioContext,
        ensureContext: () => ({ sampleRate: 48_000 }) as BaseAudioContext,
        attachGenerativeSource: () => log.attached++,
        detachGenerativeSource: () => log.detached++,
      } as never,
      transport: new Transport({ now: () => 0 }, doc.bpm),
      project: () => doc,
      providers,
      providerTimeoutMs: 20,
      loadWorklets: async () => undefined,
      isPlayerReady: () => true,
      createPlayer: () => ({
        output: {} as AudioNode,
        pushChunk: () => undefined,
        flush: () => undefined,
        subscribeStatus: () => () => undefined,
        dispose: () => log.disposed++,
      }),
    });

    await runtime.startTrack(trackId);
    expect(runtime.getStatus(trackId).state).toBe("running");

    await runtime.refreshAll();

    expect(runtime.getStatus(trackId)).toEqual({ state: "error", message: "provider refresh stalled" });
    expect(log.attached).toBe(1);
    expect(log.detached).toBe(1);
    expect(log.disposed).toBe(1);
    expect(stopCalls).toBe(1);
    expect(disposeCalls).toBe(1);

    await runtime.startTrack(trackId);
    expect(createdSessions).toBe(2);
    emitProviderStatus?.({ state: "error", message: "native stream failed" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(runtime.getStatus(trackId)).toEqual({ state: "error", message: "native stream failed" });
    expect(log.detached).toBe(2);
    expect(log.disposed).toBe(2);
    expect(stopCalls).toBe(2);
    expect(disposeCalls).toBe(2);
    await runtime.dispose();
  });
});
