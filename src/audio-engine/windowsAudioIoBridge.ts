import type { AudioEngine } from "./AudioEngine";
import {
  validateWindowsAudioIoNegotiation,
  type WindowsAudioIoNegotiation,
  type WindowsAudioIoRequest,
} from "./windowsAudioIo";

export interface WindowsAudioIoBridgeSnapshot {
  nativeState: string;
  nativeCaptureQueuedFrames: number;
  nativeRenderQueuedFrames: number;
  nativeRenderUnderrunPeriods: number;
  nativeCaptureOverrunPackets: number;
  nativeCaptureDiscontinuities: number;
  bridgeRenderDroppedPeriods: number;
  utilityRenderRejectedPackets: number;
  bridgeCaptureDroppedPackets: number;
  bridgeQueuedCapturePackets: number;
  bridgeFreeRenderBuffers: number;
  bridgeReady: boolean;
  bridgeRenderSequence: number;
  bridgeRenderInFlightPackets: number;
  bridgeCaptureInvalidPackets: number;
  bridgeProcessCalls: number;
}

export type WindowsAudioIoBridgeEvent =
  | { type: "ready"; negotiation: WindowsAudioIoNegotiation }
  | { type: "status"; snapshot: WindowsAudioIoBridgeSnapshot }
  | { type: "device-lost"; message: string }
  | { type: "error"; message: string }
  | { type: "stopped" };

export interface WindowsAudioIoEngineConnection {
  sessionId: string;
  captureStream: MediaStream;
  /** Negotiated endpoint format, buffers and any endpoint-reported latency. */
  negotiation: WindowsAudioIoNegotiation;
  subscribe(listener: (event: WindowsAudioIoBridgeEvent) => void): () => void;
  stop(): void;
}

const moduleLoads = new WeakMap<BaseAudioContext, Promise<void>>();
const activeEngineConnections = new WeakMap<AudioEngine, WindowsAudioIoEngineConnection>();
const captureConnectionsByContext = new WeakMap<AudioContext, WindowsAudioIoEngineConnection>();
const WORKLET_PATH = "/windows-audio-io-bridge.js";
const READY_TIMEOUT_MS = 8_000;
const MAX_PACKET_FRAMES = 8_192;
const nativeSessionPorts = new Map<string, MessagePort>();
const nativeSessionPortWaiters = new Map<string, Array<(port: MessagePort | null, error?: Error) => void>>();
const discardedNativeSessionPorts = new Set<string>();
const MAX_DISCARDED_NATIVE_SESSIONS = 64;

function receiveNativeSessionPort(event: MessageEvent): void {
  if (event.source !== window || event.origin !== location.origin || !event.data || typeof event.data !== "object")
    return;
  const message = event.data as { type?: unknown; sessionId?: unknown; port?: unknown };
  if (
    message.type !== "kyx:audio:windows-session-port" ||
    typeof message.sessionId !== "string" ||
    typeof MessagePort === "undefined" ||
    !(message.port instanceof MessagePort)
  )
    return;
  if (discardedNativeSessionPorts.has(message.sessionId)) {
    discardedNativeSessionPorts.delete(message.sessionId);
    message.port.close();
    return;
  }
  const waiters = nativeSessionPortWaiters.get(message.sessionId);
  const waiter = waiters?.shift();
  if (waiters && waiters.length === 0) nativeSessionPortWaiters.delete(message.sessionId);
  if (waiter) waiter(message.port);
  else {
    nativeSessionPorts.get(message.sessionId)?.close();
    nativeSessionPorts.set(message.sessionId, message.port);
    while (nativeSessionPorts.size > 4) {
      const oldest = nativeSessionPorts.keys().next().value as string | undefined;
      if (!oldest) break;
      nativeSessionPorts.get(oldest)?.close();
      nativeSessionPorts.delete(oldest);
    }
  }
}

if (typeof window !== "undefined") window.addEventListener("message", receiveNativeSessionPort);

/** Resolve the one-use native PCM port transferred for this session. */
export function waitForWindowsAudioSessionPort(sessionId: string, timeoutMs = READY_TIMEOUT_MS): Promise<MessagePort> {
  if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 128)
    return Promise.reject(new Error("The native audio session ID is invalid"));
  if (discardedNativeSessionPorts.has(sessionId))
    return Promise.reject(new Error("Native audio session was cancelled before port transfer"));
  const queued = nativeSessionPorts.get(sessionId);
  if (queued) {
    nativeSessionPorts.delete(sessionId);
    return Promise.resolve(queued);
  }
  return new Promise<MessagePort>((resolve, reject) => {
    const waiters = nativeSessionPortWaiters.get(sessionId) ?? [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (port?: MessagePort | null, error?: Error) => {
      if (timer) clearTimeout(timer);
      const current = nativeSessionPortWaiters.get(sessionId);
      if (current) {
        const index = current.indexOf(onPort);
        if (index >= 0) current.splice(index, 1);
        if (current.length === 0) nativeSessionPortWaiters.delete(sessionId);
      }
      if (port) resolve(port);
      else reject(error ?? new Error("The desktop shell did not transfer a native audio port"));
    };
    const onPort = (port: MessagePort | null, error?: Error) => finish(port, error);
    waiters.push(onPort);
    nativeSessionPortWaiters.set(sessionId, waiters);
    timer = setTimeout(() => finish(), timeoutMs);
  });
}

/** Reject a pending port wait and close any port that arrived before startup was cancelled. */
export function discardWindowsAudioSessionPort(sessionId: string): void {
  if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 128) return;
  const queued = nativeSessionPorts.get(sessionId);
  if (queued) {
    nativeSessionPorts.delete(sessionId);
    queued.close();
  }
  const waiters = nativeSessionPortWaiters.get(sessionId);
  if (!queued) {
    discardedNativeSessionPorts.add(sessionId);
    while (discardedNativeSessionPorts.size > MAX_DISCARDED_NATIVE_SESSIONS) {
      const oldest = discardedNativeSessionPorts.values().next().value as string | undefined;
      if (!oldest) break;
      discardedNativeSessionPorts.delete(oldest);
    }
  }
  if (waiters?.length) {
    nativeSessionPortWaiters.delete(sessionId);
    for (const waiter of waiters) waiter(null, new Error("Native audio session was cancelled before port transfer"));
  }
}

function workletUrl(): string {
  const base = typeof location === "undefined" ? "http://localhost/" : location.href;
  return new URL(WORKLET_PATH, base).href;
}

async function ensureBridgeWorklet(ctx: AudioContext): Promise<void> {
  if (!ctx.audioWorklet || typeof AudioWorkletNode === "undefined")
    throw new Error("This runtime does not support AudioWorklet output routing");
  let pending = moduleLoads.get(ctx);
  if (!pending) {
    pending = ctx.audioWorklet.addModule(workletUrl());
    moduleLoads.set(ctx, pending);
    void pending.catch(() => moduleLoads.delete(ctx));
  }
  await pending;
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function readSnapshot(native: unknown, bridge: unknown): WindowsAudioIoBridgeSnapshot {
  const source = native && typeof native === "object" ? (native as Record<string, unknown>) : {};
  const bridgeSource = bridge && typeof bridge === "object" ? (bridge as Record<string, unknown>) : {};
  return {
    nativeState: typeof source.state === "string" ? source.state : "unknown",
    nativeCaptureQueuedFrames: readCount(source.captureQueuedFrames),
    nativeRenderQueuedFrames: readCount(source.renderQueuedFrames),
    nativeRenderUnderrunPeriods: readCount(source.renderUnderrunPeriods),
    nativeCaptureOverrunPackets: readCount(source.captureOverrunPackets),
    nativeCaptureDiscontinuities: readCount(source.captureDiscontinuities),
    bridgeRenderDroppedPeriods: readCount(bridgeSource.renderDroppedPeriods),
    utilityRenderRejectedPackets: readCount(bridgeSource.utilityRenderRejectedPackets),
    bridgeCaptureDroppedPackets: readCount(bridgeSource.captureDroppedPackets),
    bridgeQueuedCapturePackets: readCount(bridgeSource.queuedCapturePackets),
    bridgeFreeRenderBuffers: readCount(bridgeSource.freeRenderBuffers),
    bridgeReady: bridgeSource.ready === true,
    bridgeRenderSequence: readCount(bridgeSource.renderSequence),
    bridgeRenderInFlightPackets: readCount(bridgeSource.inFlightRenderPackets),
    bridgeCaptureInvalidPackets: readCount(bridgeSource.captureInvalidPackets),
    bridgeProcessCalls: readCount(bridgeSource.processCalls),
  };
}

/**
 * Connects the validated native utility-process port to the actual KYX master
 * output and exposes its capture stream to the recording path. PCM never
 * passes through React state or ordinary IPC.
 */
export async function connectWindowsAudioIoToEngine(
  engine: AudioEngine,
  sessionId: string,
  port: MessagePort,
  request: WindowsAudioIoRequest,
): Promise<WindowsAudioIoEngineConnection> {
  const previousConnection = activeEngineConnections.get(engine) ?? null;
  const ctx = engine.getLiveAudioContext();
  if (!ctx || ctx.state === "closed") throw new Error("Start the studio audio engine before opening native I/O");
  if (ctx.sampleRate !== request.sampleRateHz)
    throw new Error(`Native device runs at ${request.sampleRateHz} Hz but KYX audio runs at ${ctx.sampleRate} Hz`);
  if (
    request.periodFrames < 1 ||
    request.periodFrames > MAX_PACKET_FRAMES ||
    request.inputChannelMap.length < 1 ||
    request.inputChannelMap.length > 2 ||
    request.outputChannelMap.length !== 2
  ) {
    throw new Error(
      "The live PCM bridge currently supports bounded periods, mono/stereo capture and stereo master output",
    );
  }

  await ensureBridgeWorklet(ctx);
  const node = new AudioWorkletNode(ctx, "kyx-windows-audio-io-bridge", {
    numberOfInputs: 1,
    numberOfOutputs: 2,
    channelCount: 2,
    channelCountMode: "explicit",
    channelInterpretation: "discrete",
    outputChannelCount: [2, request.inputChannelMap.length],
    processorOptions: {
      sessionId,
      periodFrames: request.periodFrames,
      captureChannels: request.inputChannelMap.length,
      poolSize: 6,
    },
  });
  const captureDestination = ctx.createMediaStreamDestination();
  try {
    captureDestination.channelCount = request.inputChannelMap.length;
    captureDestination.channelCountMode = "explicit";
  } catch {
    /* Some implementations expose a fixed stereo MediaStream destination. */
  }
  const listeners = new Set<(event: WindowsAudioIoBridgeEvent) => void>();
  let stopped = false;
  let readyResolve: (() => void) | null = null;
  let readyReject: ((error: Error) => void) | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  let contextUnsubscribe: (() => void) | null = null;
  let sawReady = false;
  let connection: WindowsAudioIoEngineConnection | null = null;
  let acceptedNegotiation: WindowsAudioIoNegotiation | null = null;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const emit = (event: WindowsAudioIoBridgeEvent) => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        /* UI observers cannot break the realtime audio bridge. */
      }
    }
  };
  const stop = (restoreOutput = true, notifyStopped = true) => {
    if (stopped) {
      if (restoreOutput) {
        try {
          engine.clearLiveAudioOutputSink(node);
        } catch {
          /* context loss or engine teardown */
        }
      }
      return;
    }
    stopped = true;
    if (!sawReady) readyReject?.(new Error("Native Windows audio stopped before the bridge became ready"));
    if (readyTimer) clearTimeout(readyTimer);
    readyTimer = null;
    contextUnsubscribe?.();
    contextUnsubscribe = null;
    node.port.onmessage = null;
    node.port.onmessageerror = null;
    node.onprocessorerror = null;
    try {
      port.close();
    } catch {
      /* already closed */
    }
    if (restoreOutput) {
      try {
        engine.clearLiveAudioOutputSink(node);
      } catch {
        /* context loss or engine teardown */
      }
    }
    try {
      node.disconnect();
      captureDestination.disconnect();
    } catch {
      /* graph already disconnected */
    }
    for (const track of captureDestination.stream.getTracks()) track.stop();
    node.port.close();
    if (connection && activeEngineConnections.get(engine) === connection) activeEngineConnections.delete(engine);
    if (connection && captureConnectionsByContext.get(ctx) === connection) captureConnectionsByContext.delete(ctx);
    if (notifyStopped) emit({ type: "stopped" });
  };
  node.port.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data as Record<string, unknown> | null;
    if (!message || typeof message !== "object") return;
    if (message.type === "ready") {
      const validation = validateWindowsAudioIoNegotiation(request, message.negotiation);
      if (validation.ok) {
        acceptedNegotiation = validation.value;
        sawReady = true;
        if (readyTimer) clearTimeout(readyTimer);
        readyTimer = null;
        readyResolve?.();
        readyResolve = null;
        readyReject = null;
        emit({ type: "ready", negotiation: validation.value });
      } else readyReject?.(new Error(`Native audio negotiation was rejected: ${validation.errors.join("; ")}`));
      return;
    }
    if (message.type === "status") {
      emit({ type: "status", snapshot: readSnapshot(message.snapshot, message.bridge) });
      return;
    }
    if (message.type === "device-lost") {
      const text = typeof message.message === "string" ? message.message : "The selected Windows audio device was lost";
      emit({ type: "device-lost", message: text });
      stop(false, false);
      return;
    }
    if (message.type === "error") {
      const text = typeof message.message === "string" ? message.message : "Native Windows audio bridge failed";
      if (!sawReady) readyReject?.(new Error(text));
      emit({ type: "error", message: text });
      if (sawReady) stop(false, false);
    }
  };
  node.port.onmessageerror = () => {
    const message = "The Windows audio bridge received an invalid transferred message";
    if (!sawReady) readyReject?.(new Error(message));
    emit({ type: "error", message });
    if (sawReady) stop(false, false);
  };
  node.onprocessorerror = () => {
    const message = "The Windows audio AudioWorklet processor failed";
    if (!sawReady) readyReject?.(new Error(message));
    emit({ type: "error", message });
    if (sawReady) stop(false, false);
  };
  node.port.start();
  try {
    node.connect(ctx.destination, 0, 0);
    node.connect(captureDestination, 1, 0);
    engine.setLiveAudioOutputSink(node);
    contextUnsubscribe = engine.subscribeLiveContext((current) => {
      if (current === ctx || stopped) return;
      emit({
        type: "error",
        message: "The live AudioContext changed while native audio was active; the native session has stopped",
      });
      stop(false, false);
    });
    node.port.postMessage({ type: "attach", port }, [port]);
    readyTimer = setTimeout(
      () => readyReject?.(new Error("Native Windows audio did not become ready within eight seconds")),
      READY_TIMEOUT_MS,
    );
    await ready;
    if (!acceptedNegotiation) throw new Error("Native audio became ready without a validated negotiation");
    if (stopped) throw new Error("Native Windows audio stopped while the bridge was starting");
  } catch (error) {
    stop();
    previousConnection?.stop();
    throw error;
  }

  connection = {
    sessionId,
    captureStream: captureDestination.stream,
    negotiation: acceptedNegotiation,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop: () => stop(true),
  };
  activeEngineConnections.set(engine, connection);
  captureConnectionsByContext.set(ctx, connection);
  previousConnection?.stop();
  return connection;
}

export function getWindowsAudioIoEngineConnection(engine: AudioEngine): WindowsAudioIoEngineConnection | null {
  return activeEngineConnections.get(engine) ?? null;
}

/** The active native capture stream for this engine context, if selected. */
export function getWindowsAudioCaptureStream(ctx: AudioContext): MediaStream | null {
  return captureConnectionsByContext.get(ctx)?.captureStream ?? null;
}

/** Subscribe to device loss while a native-backed recording is armed. */
export function subscribeWindowsAudioCaptureFailure(
  ctx: AudioContext,
  listener: (message: string) => void,
): () => void {
  const connection = captureConnectionsByContext.get(ctx);
  if (!connection) return () => undefined;
  return connection.subscribe((event) => {
    if (event.type === "device-lost" || event.type === "error") listener(event.message);
  });
}
