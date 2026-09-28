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

function desktopSurface(): DesktopPcmSurface {
  const surface = (globalThis as { kyxDesktop?: { pcm?: DesktopPcmSurface } }).kyxDesktop?.pcm;
  if (!surface) throw new PcmPlaybackUnavailableError();
  return surface;
}

const RING_CAPACITY = 32768; // ≥ OS pipe buffer in frames (ADR 0018 sizing contract)

export class PcmPlaybackController {
  private node: AudioWorkletNode | null = null;
  private sessionId: string | null = null;
  private moduleLoaded = new WeakSet<BaseAudioContext>();

  constructor(private readonly getContext: () => BaseAudioContext) {}

  get active(): boolean {
    return this.node !== null;
  }

  /**
   * Start an external source and route it to the speakers. `host` is an
   * allowlisted kind ("pcm-gen" tone, "asio-host" for the ASIO fixture via
   * --dll); extra args ride the same validation as any other client.
   */
  async start(host: "pcm-gen" | "asio-host", args: string[] = []): Promise<void> {
    const surface = desktopSurface();
    if (this.node) await this.stop();

    const context = this.getContext();
    const rate = context.sampleRate;
    const format = { channels: 2, capacityFrames: RING_CAPACITY, sampleRate: rate };
    const sab = createPcmRingBuffer(format);
    new PcmRingHeader(sab).init(format);

    await this.ensureModule(context);
    const node = new AudioWorkletNode(context, "pcm-playback", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.port.postMessage({ type: "attach", sab });

    const result = await surface.start({ sab, host, args: [...args, "--rate", String(rate)] });
    if (!result.ok) {
      node.disconnect();
      throw new Error(result.error ?? "external source refused to start");
    }

    node.connect(context.destination);
    this.node = node;
    this.sessionId = result.id ?? null;
  }

  async stop(): Promise<void> {
    const surface = desktopSurface();
    if (this.sessionId) {
      await surface.stop(this.sessionId).catch(() => undefined);
      this.sessionId = null;
    }
    if (this.node) {
      this.node.port.postMessage({ type: "detach" });
      this.node.disconnect();
      this.node = null;
    }
  }

  private async ensureModule(context: BaseAudioContext): Promise<void> {
    if (this.moduleLoaded.has(context)) return;
    await context.audioWorklet.addModule(new URL(assetUrl("/pcm-playback-worklet.js"), import.meta.url).href);
    this.moduleLoaded.add(context);
  }
}
