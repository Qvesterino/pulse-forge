import { createPcmRingBuffer, PcmRingHeader } from "./pcmRing";
import { assetUrl } from "../shared/assetUrls";

/**
 * External PCM playback controller (ADR 0018 wave 3 — the "hear it" wiring).
 *
 * The renderer owns the ring (it knows the AudioContext's rate), hands the
 * SAB to the desktop shell over `kyx:pcm:start`, and attaches the
 * `pcm-playback` worklet to the LIVE context — the external source becomes
 * ordinary output audio. Rate contract: the source is started AT the
 * context's rate, so the ring never resamples (wave 3.5 resampling covers
 * mismatched sources when one appears).
 *
 * Desktop-only by nature: without `window.kyxDesktop.pcm` every call throws
 * PcmPlaybackUnavailableError — callers surface that honestly.
 */

export class PcmPlaybackUnavailableError extends Error {
  constructor() {
    super("External PCM playback lives in the desktop shell (Electron) — the browser has no native source access");
    this.name = "PcmPlaybackUnavailableError";
  }
}

interface DesktopPcmSurface {
  start: (request: {
    sab: SharedArrayBuffer;
    host: string;
    args: string[];
  }) => Promise<{ ok: boolean; id?: string; error?: string }>;
  stop: (id: string) => Promise<unknown>;
}

let shared: PcmPlaybackController | null = null;
let sharedContextGetter: (() => BaseAudioContext) | null = null;

/**
 * The app-wide controller (statusbar chip AND intent verbs share one
 * session — a new start from either surface stops the previous source).
 */
export function getSharedPcmPlayback(getContext: () => BaseAudioContext): PcmPlaybackController {
  sharedContextGetter = getContext;
  if (!shared) shared = new PcmPlaybackController(() => (sharedContextGetter ?? getContext)());
  return shared;
}

function desktopSurface(): DesktopPcmSurface {
  const surface = optionalDesktopSurface();
  if (!surface) throw new PcmPlaybackUnavailableError();
  return surface;
}

function optionalDesktopSurface(): DesktopPcmSurface | null {
  return (globalThis as { kyxDesktop?: { pcm?: DesktopPcmSurface } }).kyxDesktop?.pcm ?? null;
}

const RING_CAPACITY = 32768; // ≥ OS pipe buffer in frames (ADR 0018 sizing contract)

function contextIsClosed(context: BaseAudioContext): boolean {
  return context.state === "closed";
}

export type PcmPlaybackState = "off" | "starting" | "on";

export class PcmPlaybackController {
  private node: AudioWorkletNode | null = null;
  /** Node allocated for an async start that has not committed yet. */
  private pendingNode: AudioWorkletNode | null = null;
  private sessionId: string | null = null;
  private moduleLoaded = new WeakSet<BaseAudioContext>();
  private state: PcmPlaybackState = "off";
  private readonly stateListeners = new Set<(state: PcmPlaybackState) => void>();
  /** Invalidates in-flight starts when Stop or a newer Play arrives. */
  private operation = 0;
  /** Serializes native starts so stale sessions are stopped before a new one starts. */
  private startTail: Promise<void> = Promise.resolve();

  constructor(private readonly getContext: () => BaseAudioContext) {}

  get active(): boolean {
    return this.node !== null;
  }

  getState(): PcmPlaybackState {
    return this.state;
  }

  subscribe(listener: (state: PcmPlaybackState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  private setState(state: PcmPlaybackState): void {
    this.state = state;
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch (error) {
        console.error("[pcm-playback] state listener failed:", error);
      }
    }
  }

  /**
   * Start an external source and route it to the speakers. `host` is an
   * allowlisted kind ("pcm-gen" tone, "asio-host" for the ASIO fixture via
   * --dll); extra args ride the same validation as any other client.
   */
  start(host: "pcm-gen" | "asio-host" | "clap-player", args: string[] = []): Promise<void> {
    const operation = ++this.operation;
    const pending = this.pendingNode;
    this.pendingNode = null;
    if (pending) this.releaseNode(pending);

    // Keep the current session audible until its own serialized start turn,
    // then stop it before opening the replacement. Concurrent starts queue
    // behind the prior attempt, including cleanup of a late native session.
    const task = this.startTail.catch(() => undefined).then(() => this.startCurrent(operation, host, args));
    this.startTail = task.catch(() => undefined);
    this.setState("starting");
    return task;
  }

  private async startCurrent(
    operation: number,
    host: "pcm-gen" | "asio-host" | "clap-player",
    args: string[],
  ): Promise<void> {
    if (!this.isCurrent(operation)) return;
    await this.stopCurrentSession();
    if (!this.isCurrent(operation)) return;

    let node: AudioWorkletNode | null = null;
    let remoteStarted = false;
    let remoteId: string | null = null;
    let adopted = false;
    let surface: DesktopPcmSurface | null = null;

    try {
      surface = desktopSurface();
      const context = this.getContext();
      if (contextIsClosed(context)) throw new Error("Audio context closed during PCM playback startup");
      const rate = context.sampleRate;
      const format = { channels: 2, capacityFrames: RING_CAPACITY, sampleRate: rate };
      const sab = createPcmRingBuffer(format);
      new PcmRingHeader(sab).init(format);

      await this.ensureModule(context);
      if (!this.isCurrent(operation)) return;
      if (context !== this.getContext() || contextIsClosed(context)) {
        throw new Error("Audio context changed during PCM playback startup");
      }

      node = new AudioWorkletNode(context, "pcm-playback", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      this.pendingNode = node;
      node.port.postMessage({ type: "attach", sab });

      const result = await surface.start({ sab, host, args: [...args, "--rate", String(rate)] });
      if (!result.ok) throw new Error(result.error ?? "external source refused to start");
      remoteStarted = true;
      remoteId = result.id ?? null;

      // Stop may have happened while the desktop host was starting. The
      // request cannot be cancelled, so discard the node and stop the late
      // native session before allowing a queued replacement to proceed.
      if (!this.isCurrent(operation)) return;
      if (context !== this.getContext() || contextIsClosed(context)) {
        throw new Error("Audio context changed during PCM playback startup");
      }

      node.connect(context.destination);
      this.pendingNode = null;
      this.node = node;
      this.sessionId = remoteId;
      this.setState("on");
      adopted = true;
    } finally {
      if (!adopted) {
        if (node && this.pendingNode === node) this.pendingNode = null;
        if (node) this.releaseNode(node);
        if (remoteStarted && remoteId && surface) await stopRemoteSession(surface, remoteId);
        if (this.isCurrent(operation)) this.setState("off");
      }
    }
  }

  async stop(): Promise<void> {
    this.operation += 1;
    const priorStart = this.startTail.catch(() => undefined);
    const stopping = this.stopCurrentSession();
    // A new Play after Stop must not race the old native stop request. Keep
    // that shutdown in the same queue used by later start attempts.
    this.startTail = Promise.all([priorStart, stopping]).then(() => undefined);
    this.setState("off");
    await stopping;
  }

  private isCurrent(operation: number): boolean {
    return this.operation === operation;
  }

  private async stopCurrentSession(): Promise<void> {
    const id = this.sessionId;
    this.sessionId = null;
    const node = this.node ?? this.pendingNode;
    this.node = null;
    this.pendingNode = null;
    if (node) this.releaseNode(node);

    const surface = optionalDesktopSurface();
    if (id && surface) await stopRemoteSession(surface, id);
  }

  private releaseNode(node: AudioWorkletNode): void {
    try {
      node.port.postMessage({ type: "detach" });
    } catch {
      /* worklet port may already be closed */
    }
    try {
      node.disconnect();
    } catch {
      /* context may already be closed */
    }
  }

  private async ensureModule(context: BaseAudioContext): Promise<void> {
    if (this.moduleLoaded.has(context)) return;
    await context.audioWorklet.addModule(new URL(assetUrl("/pcm-playback-worklet.js"), import.meta.url).href);
    this.moduleLoaded.add(context);
  }
}

async function stopRemoteSession(surface: DesktopPcmSurface, id: string): Promise<void> {
  try {
    await surface.stop(id);
  } catch {
    /* a dead desktop bridge must not retain a connected playback node */
  }
}
