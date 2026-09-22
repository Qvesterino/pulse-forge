import { decodeAudioData } from "../services/audio-decode";
import type { AudioEngine } from "../audio-engine/AudioEngine";
import { createGenerativePlayerNode, type GenerativePlayerHandle } from "../audio-worklets/generative-player-node";
import { isWorkletReady, loadCoreWorklets } from "../audio-worklets/loader";
import { ticksPerBar } from "../project-model/schema";
import { PPQ } from "../project-model/types";
import type { GenerativeTrack, ProjectDocument } from "../project-model/types";
import type { SampleBank } from "../sample-library/factory";
import type { Transport } from "../transport/Transport";
import type { IUserSampleRepository } from "../persistence/contracts";
import { uid } from "../shared/ids";
import { buildGenerativeInput, resolveGenerativeMacrosAtTick } from "./conditioning";
import { persistGeneratedAudioAsClip, type PersistedGeneratedClip } from "./capture";
import type {
  GeneratedAudio,
  GenerativeAudioSession,
  GenerativeCapabilities,
  GenerativeInput,
  GenerativeStatus,
} from "./types";
import { GenerativeProviderRegistry } from "./registry";

const REFRESH_INTERVAL_MS = 40;
const LIVE_WINDOW_BARS = 4;
const PLAYER_QUEUE_FRAMES = 96_000;
const IDLE_STATUS: GenerativeStatus = { state: "idle" };

interface RuntimeEntry {
  trackId: string;
  session: GenerativeAudioSession;
  player: GenerativePlayerHandle;
  unsubscribeAudio: () => void;
  unsubscribeStatus: () => void;
  unsubscribePlayer: () => void;
  refreshTimer: ReturnType<typeof setInterval>;
  refreshing: boolean;
}

export interface GenerativeRuntimeOptions {
  engine: AudioEngine;
  transport: Transport;
  project: () => ProjectDocument;
  providers: GenerativeProviderRegistry;
  bank?: SampleBank;
  userSamples?: IUserSampleRepository;
  execute?: (command: import("../commands/types").Command) => void;
  /** Test seams; production uses the real loader and AudioWorklet node. */
  loadWorklets?: (ctx: BaseAudioContext) => Promise<void>;
  isPlayerReady?: (ctx: BaseAudioContext) => boolean;
  createPlayer?: (ctx: BaseAudioContext, options: { channels: number; maxFrames: number }) => GenerativePlayerHandle;
}

export type GenerativeRuntimeListener = (trackId: string, status: GenerativeStatus) => void;

/**
 * Owns the bridge between serializable generative-track intent and the live
 * provider/audio graph. It deliberately has no React dependency: transport
 * lifecycle calls this object, while project edits only ask it to refresh.
 */
export class GenerativeRuntime {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly pending = new Set<string>();
  private readonly epochs = new Map<string, number>();
  private readonly statuses = new Map<string, GenerativeStatus>();
  private readonly listeners = new Set<GenerativeRuntimeListener>();
  private disposed = false;

  private readonly loadWorklets: (ctx: BaseAudioContext) => Promise<void>;
  private readonly isPlayerReady: (ctx: BaseAudioContext) => boolean;
  private readonly createPlayer: (
    ctx: BaseAudioContext,
    options: { channels: number; maxFrames: number },
  ) => GenerativePlayerHandle;

  constructor(private readonly options: GenerativeRuntimeOptions) {
    this.loadWorklets = options.loadWorklets ?? loadCoreWorklets;
    this.isPlayerReady = options.isPlayerReady ?? ((ctx) => isWorkletReady("generativePlayer", ctx));
    this.createPlayer = options.createPlayer ?? createGenerativePlayerNode;
  }

  subscribe(listener: GenerativeRuntimeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getStatus(trackId: string): GenerativeStatus {
    return this.statuses.get(trackId) ?? IDLE_STATUS;
  }

  async startAll(): Promise<void> {
    if (this.disposed) return;
    const tracks = this.options
      .project()
      .tracks.filter((track): track is GenerativeTrack => track.kind === "generative");
    await Promise.all(tracks.map((track) => this.startTrack(track.id)));
  }

  async startTrack(trackId: string): Promise<void> {
    if (this.disposed || this.entries.has(trackId) || this.pending.has(trackId)) return;
    const track = this.generativeTrack(trackId);
    if (!track) {
      this.setStatus(trackId, { state: "error", message: "Generative track not found" });
      return;
    }
    const provider = this.options.providers.get(track.generative.providerId);
    if (!provider) {
      this.setStatus(trackId, {
        state: "unavailable",
        message: `Provider ${track.generative.providerId} is not installed`,
      });
      return;
    }
    const capabilities = provider.getCapabilities();
    if (!capabilities.supportsRealtime) {
      this.setStatus(trackId, { state: "unavailable", message: "Provider does not support realtime playback" });
      return;
    }

    const epoch = (this.epochs.get(trackId) ?? 0) + 1;
    this.epochs.set(trackId, epoch);
    this.pending.add(trackId);
    this.setStatus(trackId, { state: "starting" });
    let session: GenerativeAudioSession | null = null;
    let player: GenerativePlayerHandle | null = null;
    try {
      const ctx = this.options.engine.context ?? this.options.engine.ensureContext();
      await this.loadWorklets(ctx);
      if (!this.isCurrent(trackId, epoch)) return;
      if (!this.isPlayerReady(ctx)) {
        this.setStatus(trackId, { state: "unavailable", message: "Generative AudioWorklet is unavailable" });
        return;
      }
      const config = this.sessionConfig(capabilities, track, ctx.sampleRate);
      if (!config) {
        this.setStatus(trackId, {
          state: "unavailable",
          message: `Provider output does not match ${ctx.sampleRate} Hz audio`,
        });
        return;
      }
      const input = this.buildInput(track);
      session = await provider.createSession(config);
      player = this.createPlayer(ctx, { channels: config.outputChannels, maxFrames: PLAYER_QUEUE_FRAMES });
      if (!this.isCurrent(trackId, epoch)) return;

      const entry: RuntimeEntry = {
        trackId,
        session,
        player,
        unsubscribeAudio: () => undefined,
        unsubscribeStatus: () => undefined,
        unsubscribePlayer: () => undefined,
        refreshTimer: setInterval(() => undefined, REFRESH_INTERVAL_MS),
        refreshing: false,
      };
      clearInterval(entry.refreshTimer);
      this.entries.set(trackId, entry);
      this.options.engine.attachGenerativeSource(trackId, player.output);
      entry.unsubscribeAudio = session.subscribeAudio((chunk) => player?.pushChunk(chunk));
      entry.unsubscribeStatus = session.subscribeStatus((status) => this.setStatus(trackId, status));
      entry.unsubscribePlayer = player.subscribeStatus((status) => {
        const current = this.getStatus(trackId);
        if (current.state === "running" || current.state === "ready") {
          this.setStatus(trackId, { state: current.state, message: `audio ${status.type}` });
        }
      });
      await session.updateInput(input);
      if (!this.isCurrent(trackId, epoch)) return;
      await session.start();
      if (!this.isCurrent(trackId, epoch)) return;
      // A provider may not emit until its first post-start conditioning update.
      await session.updateInput(input);
      entry.refreshTimer = setInterval(() => {
        void this.refreshTrack(trackId, epoch);
      }, REFRESH_INTERVAL_MS);
      this.setStatus(trackId, { state: "running" });
    } catch (error) {
      if (this.isCurrent(trackId, epoch)) {
        const entry = this.entries.get(trackId);
        if (entry) {
          clearInterval(entry.refreshTimer);
          this.entries.delete(trackId);
          entry.unsubscribeAudio();
          entry.unsubscribeStatus();
          entry.unsubscribePlayer();
        }
        this.setStatus(trackId, {
          state: "error",
          message: error instanceof Error ? error.message : "Generative start failed",
        });
      }
    } finally {
      this.pending.delete(trackId);
      if (!this.isCurrent(trackId, epoch) || !this.entries.has(trackId)) {
        await this.disposeResources(trackId, session, player);
      }
    }
  }

  async stopAll(): Promise<void> {
    const ids = new Set([...this.entries.keys(), ...this.pending]);
    await Promise.all([...ids].map((trackId) => this.stopTrack(trackId)));
  }

  async stopTrack(trackId: string): Promise<void> {
    this.epochs.set(trackId, (this.epochs.get(trackId) ?? 0) + 1);
    const entry = this.entries.get(trackId);
    this.entries.delete(trackId);
    if (!entry) {
      this.setStatus(trackId, { state: "ready" });
      return;
    }
    clearInterval(entry.refreshTimer);
    this.options.engine.detachGenerativeSource(trackId, entry.player.output);
    entry.player.flush();
    entry.unsubscribeAudio();
    entry.unsubscribeStatus();
    entry.unsubscribePlayer();
    entry.player.dispose();
    try {
      await entry.session.stop();
      await entry.session.dispose();
    } catch {
      /* provider teardown is best effort after the source is detached */
    }
    this.setStatus(trackId, { state: "ready" });
  }

  async refreshAll(): Promise<void> {
    if (this.disposed) return;
    if (this.options.transport.playing) {
      await this.startAll();
    }
    await Promise.all(
      [...this.entries.keys()].map((trackId) => this.refreshTrack(trackId, this.epochs.get(trackId) ?? 0)),
    );
  }

  /** Capture a provider take and commit it as a normal arrangement AudioClip. */
  async captureTrack(trackId: string, durationSec: number, startBar?: number): Promise<PersistedGeneratedClip> {
    if (this.disposed) throw new Error("Generative runtime is disposed");
    const track = this.generativeTrack(trackId);
    if (!track) throw new Error(`Generative track ${trackId} not found`);
    if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error("Capture duration must be positive");
    const provider = this.options.providers.get(track.generative.providerId);
    if (!provider) throw new Error(`Provider ${track.generative.providerId} is not installed`);
    const capabilities = provider.getCapabilities();
    if (!capabilities.supportsCapture) throw new Error("Provider does not support capture");
    const ctx = this.options.engine.context ?? this.options.engine.ensureContext();
    const config = this.sessionConfig(capabilities, track, ctx.sampleRate);
    if (!config) throw new Error(`Provider output does not match ${ctx.sampleRate} Hz audio`);
    const sourceDoc = this.options.project();
    const barTicks = ticksPerBar(sourceDoc);
    const startTick = Math.max(0, Math.floor(this.options.transport.position / barTicks) * barTicks);
    const durationTicks = Math.max(1, Math.round((durationSec * sourceDoc.bpm * PPQ) / 60));
    const input = this.buildInput(track, startTick, durationTicks);
    const active = this.entries.get(trackId);
    let session = active?.session;
    let temporary = false;
    if (!session) {
      session = await provider.createSession(config);
      temporary = true;
      await session.updateInput(input);
    } else {
      await session.updateInput(input);
    }
    let audio: GeneratedAudio;
    try {
      audio = await session.capture({ input, durationSec });
    } finally {
      if (temporary) await session.dispose();
    }
    if (sourceDoc !== this.options.project()) throw new Error("Project changed during generative capture");
    const assetId = uid("generated");
    if (!this.options.userSamples || !this.options.execute) {
      throw new Error("Generated capture persistence is unavailable");
    }
    const clipBars = Math.max(0.25, durationTicks / barTicks);
    const persisted = await persistGeneratedAudioAsClip(
      this.options.userSamples,
      sourceDoc,
      audio,
      `${track.name} take`,
      {
        assetId,
        placement: {
          trackId,
          startBar: startBar ?? Math.floor(startTick / barTicks),
          lengthBars: clipBars,
        },
      },
    );
    try {
      const decoded = await decodeAudioData(persisted.wav.slice(0), ctx.sampleRate);
      this.options.bank?.add(persisted.asset.id, decoded);
      if (sourceDoc !== this.options.project()) throw new Error("Project changed during generated capture commit");
      this.options.execute(persisted.command);
    } catch (error) {
      await this.options.userSamples.remove(persisted.asset.id).catch(() => undefined);
      throw error;
    }
    return persisted;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.stopAll();
    this.listeners.clear();
    this.statuses.clear();
  }

  private async refreshTrack(trackId: string, epoch: number): Promise<void> {
    const entry = this.entries.get(trackId);
    const track = this.generativeTrack(trackId);
    if (!entry || !track || !this.isCurrent(trackId, epoch) || entry.refreshing) return;
    entry.refreshing = true;
    try {
      await entry.session.updateInput(this.buildInput(track));
    } catch (error) {
      if (this.isCurrent(trackId, epoch)) {
        this.setStatus(trackId, {
          state: "error",
          message: error instanceof Error ? error.message : "Generative update failed",
        });
      }
    } finally {
      entry.refreshing = false;
    }
  }

  private buildInput(
    track: GenerativeTrack,
    startTick = this.options.transport.position,
    durationTicks?: number,
  ): GenerativeInput {
    const doc = this.options.project();
    const barTicks = ticksPerBar(doc);
    const safeStartTick = Math.max(0, startTick);
    return buildGenerativeInput(doc, track, safeStartTick, durationTicks ?? barTicks * LIVE_WINDOW_BARS, {
      macros: resolveGenerativeMacrosAtTick(doc, track, safeStartTick),
      resolveAudioStyle: (bufferId) => {
        const buffer = this.options.bank?.get(bufferId);
        if (!buffer) throw new Error(`Audio style asset ${bufferId} is unavailable`);
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
          buffer.getChannelData(channel),
        );
        return { kind: "audio", sampleRate: buffer.sampleRate, channels };
      },
    });
  }

  private sessionConfig(
    capabilities: GenerativeCapabilities,
    track: GenerativeTrack,
    contextSampleRate: number,
  ): { modelId: string; outputSampleRate: number; outputChannels: number } | null {
    if (!capabilities.modelIds.includes(track.generative.modelId)) return null;
    if (!capabilities.outputSampleRates.includes(contextSampleRate)) return null;
    const outputChannels = capabilities.outputChannels.includes(2) ? 2 : capabilities.outputChannels[0];
    if (!outputChannels) return null;
    return { modelId: track.generative.modelId, outputSampleRate: contextSampleRate, outputChannels };
  }

  private generativeTrack(trackId: string): GenerativeTrack | undefined {
    const track = this.options.project().tracks.find((candidate) => candidate.id === trackId);
    return track?.kind === "generative" ? track : undefined;
  }

  private isCurrent(trackId: string, epoch: number): boolean {
    return !this.disposed && this.epochs.get(trackId) === epoch;
  }

  private setStatus(trackId: string, status: GenerativeStatus): void {
    this.statuses.set(trackId, status);
    for (const listener of this.listeners) listener(trackId, status);
  }

  private async disposeResources(
    trackId: string,
    session: GenerativeAudioSession | null,
    player: GenerativePlayerHandle | null,
  ): Promise<void> {
    if (player) {
      this.options.engine.detachGenerativeSource(trackId, player.output);
      player.dispose();
    }
    if (session) {
      try {
        await session.stop();
        await session.dispose();
      } catch {
        /* stale provider teardown is best effort */
      }
    }
  }
}
