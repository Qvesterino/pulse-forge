import { useEffect, useRef, useState } from "react";
import { useServices } from "./context";
import { PanelHeader } from "./PanelChrome";
import { EmptyState } from "./PanelChrome";
import {
  applyOutputDevice,
  listOutputDevices,
  loadOutputDeviceId,
  saveOutputDeviceId,
  setSinkIdSupported,
  type OutputDevice,
} from "../audio-engine/outputDevice";
import {
  listRecordingInputDevices,
  loadRecordingInputDeviceId,
  loadRecordingInputGainDb,
  saveRecordingInputDeviceId,
  saveRecordingInputGainDb,
  type RecordingInputDevice,
} from "../audio-engine/recordingInput";
import { clampInputGainDb } from "../audio-engine/PcmMicRecorder";
import { isLiveAudioContext } from "../audio-engine/liveContext";
import type { WindowsAudioIoBridgeEvent, WindowsAudioIoEngineConnection } from "../audio-engine/windowsAudioIoBridge";
import {
  validateWindowsAudioIoRequest,
  type WindowsAudioIoNegotiation,
  type WindowsAudioIoRequest,
} from "../audio-engine/windowsAudioIo";

export function canStopNativeAudioSession(state: string, hasConnection: boolean): boolean {
  return (
    state === "ready" ||
    state === "starting" ||
    state === "stopping" ||
    ((state === "lost" || state === "error") && hasConnection)
  );
}

/**
 * Studio I/O panel (ADR 0017/0018 surfaces) — output device, input device
 * and, on the desktop shell, ASIO driver discovery. The panel only ever
 * READS capabilities and reports them honestly: no ASIO streaming switch
 * (real-hardware streaming is an owner gate, ADR 0017's matrix), no silent
 * fallbacks — a blocked permission or an unsupported setSinkId is a message,
 * not an empty list.
 */

interface AsioDriverDetail {
  name?: string;
  inputChannels?: number;
  outputChannels?: number;
  bufferSize?: { min?: number; max?: number; preferred?: number };
  sampleRate?: number | string;
  [key: string]: unknown;
}

interface AsioListResult {
  registry: { status: string; names?: string[]; message?: string };
  details: { status: string; drivers?: AsioDriverDetail[]; partial?: boolean; message?: string };
}

interface WindowsAudioEndpoint {
  id: string;
  name: string;
  flow: "capture" | "render";
  state: "active" | "disabled" | "not-present" | "unplugged" | "unknown";
  isDefaultConsole: boolean;
  mixFormat: {
    channels: number;
    sampleRateHz: number;
    bitsPerSample: number;
    validBitsPerSample: number;
    floatingPoint: boolean;
    channelMask: number;
    sharedPeriods: { defaultFrames: number; fundamentalFrames: number; minFrames: number; maxFrames: number } | null;
  } | null;
}

interface WindowsAudioEndpointList {
  status: "ok" | "unsupported" | "no-probe" | "timeout" | "invalid-output" | "error";
  endpoints: WindowsAudioEndpoint[];
  message?: string;
}

type DesktopBridge = {
  asio?: { list: () => Promise<AsioListResult> };
  audio?: {
    listWindowsEndpoints: () => Promise<WindowsAudioEndpointList>;
    startWindowsSession: (request: WindowsAudioIoRequest) => Promise<{ status: "starting"; sessionId: string }>;
    stopWindowsSession: (sessionId: string) => Promise<{ status: "stopped" }>;
    onWindowsSessionStage?: (listener: (event: { sessionId: string; stage: string }) => void) => () => void;
  };
};

function greatestCommonDivisor(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function commonWindowsPeriod(input: WindowsAudioEndpoint | null, output: WindowsAudioEndpoint | null): number | null {
  const inputPeriods = input?.mixFormat?.sharedPeriods;
  const outputPeriods = output?.mixFormat?.sharedPeriods;
  if (!inputPeriods || !outputPeriods) return null;
  const minFrames = Math.max(inputPeriods.minFrames, outputPeriods.minFrames);
  const maxFrames = Math.min(inputPeriods.maxFrames, outputPeriods.maxFrames, 8_192);
  const fundamentalFrames =
    (inputPeriods.fundamentalFrames /
      greatestCommonDivisor(inputPeriods.fundamentalFrames, outputPeriods.fundamentalFrames)) *
    outputPeriods.fundamentalFrames;
  if (!Number.isSafeInteger(fundamentalFrames) || fundamentalFrames <= 0) return null;
  const preferred = Math.max(minFrames, inputPeriods.defaultFrames, outputPeriods.defaultFrames);
  const candidate = Math.ceil(preferred / fundamentalFrames) * fundamentalFrames;
  return candidate <= maxFrames ? candidate : null;
}

function channelMapOptions(channelCount: number, stereoOnly: boolean): Array<{ value: string; label: string }> {
  const channels = Math.max(0, Math.min(32, Math.floor(channelCount)));
  const options: Array<{ value: string; label: string }> = [];
  if (!stereoOnly) {
    for (let channel = 0; channel < channels; channel++)
      options.push({ value: String(channel), label: `Channel ${channel + 1} mono` });
  }
  for (let left = 0; left < channels; left++) {
    for (let right = left + 1; right < channels; right++)
      options.push({ value: `${left},${right}`, label: `Channels ${left + 1}–${right + 1} stereo` });
  }
  return options;
}

function parseChannelMap(value: string): number[] {
  return value.split(",").map((channel) => Number(channel));
}

function asioBridge(): DesktopBridge["asio"] | null {
  return (typeof window !== "undefined" ? (window as { kyxDesktop?: DesktopBridge }).kyxDesktop?.asio : null) ?? null;
}

function windowsAudioBridge(): DesktopBridge["audio"] | null {
  return (typeof window !== "undefined" ? (window as { kyxDesktop?: DesktopBridge }).kyxDesktop?.audio : null) ?? null;
}

function formatHz(rate: number | string | undefined): string {
  if (rate === undefined) return "—";
  const num = Number(rate);
  if (!Number.isFinite(num) || num <= 0) return String(rate);
  return num % 1000 === 0 ? `${num / 1000} kHz` : `${num} Hz`;
}

export function formatReportedWindowsAudioLatency(frames: number | undefined, sampleRateHz: number): string {
  if (
    frames === undefined ||
    !Number.isSafeInteger(frames) ||
    frames < 0 ||
    !Number.isFinite(sampleRateHz) ||
    sampleRateHz <= 0
  )
    return "unavailable";
  return `${((frames / sampleRateHz) * 1000).toFixed(2)} ms (${frames} frames)`;
}

export function IoPanel() {
  const services = useServices();
  const engine = services.engine;

  // Context identity in state: setSinkId/device pickers need the LIVE
  // context, and the engine swaps contexts (device lifecycle) behind the
  // same facade — the panel must re-read, not cache, after each swap.
  const [ctx, setCtx] = useState<BaseAudioContext | null>(engine.context);
  useEffect(() => {
    let active = true;
    const subscribe = engine.subscribeLiveContext;
    if (typeof subscribe === "function") {
      const unsubscribe = subscribe.call(engine, (context) => {
        if (active) setCtx((previous) => (previous === context ? previous : context));
      });
      return () => {
        active = false;
        unsubscribe();
      };
    }
    // Lightweight test/legacy-service fallback; the real AudioEngine emits
    // context replacement synchronously through subscribeLiveContext.
    const tick = () => setCtx((previous) => (previous === engine.context ? previous : engine.context));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [engine]);

  const liveCtx = ctx && isLiveAudioContext(ctx) ? ctx : null;
  const sinkSupported = setSinkIdSupported(liveCtx);

  // ----- OUTPUT -----
  const [outputs, setOutputs] = useState<OutputDevice[]>([]);
  const [outputId, setOutputId] = useState<string>(loadOutputDeviceId() || "default");
  const [outputMessage, setOutputMessage] = useState<string | null>(null);
  const [outputsMissingLabels, setOutputsMissingLabels] = useState(false);
  const [outputsLoaded, setOutputsLoaded] = useState(false);
  const outputUnavailable =
    outputsLoaded && outputId !== "default" && !outputs.some((device) => device.deviceId === outputId);
  const outputApplyQueueRef = useRef<Promise<void>>(Promise.resolve());
  const outputSelectionRef = useRef({
    context: liveCtx,
    deviceId: outputId === "default" ? "" : outputId,
    unavailable: outputUnavailable,
  });
  outputSelectionRef.current = {
    context: liveCtx,
    deviceId: outputId === "default" ? "" : outputId,
    unavailable: outputUnavailable,
  };

  const refreshOutputs = () => {
    void listOutputDevices().then((devices) => {
      setOutputs(devices);
      setOutputsLoaded(true);
      // Labels stay empty until the user has played audio in this browser
      // (Chromium's OutputDeviceInfo rule) — say so instead of "Audio output 1".
      setOutputsMissingLabels(devices.filter((d) => d.deviceId !== "default").every((d) => !d.label));
    });
  };
  useEffect(() => {
    refreshOutputs();
    const media = typeof navigator !== "undefined" ? navigator.mediaDevices : null;
    media?.addEventListener?.("devicechange", refreshOutputs);
    return () => media?.removeEventListener?.("devicechange", refreshOutputs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!liveCtx) return;
    // A saved endpoint may take a moment to appear after permission/device
    // enumeration. Keep its identity pinned until it is listed; never route
    // the project to the system default as a recovery shortcut.
    if (outputId !== "default" && !outputsLoaded) return;
    if (outputUnavailable) {
      setOutputMessage(null);
      return;
    }
    if (!sinkSupported) {
      if (outputId !== "default") setOutputMessage("This browser cannot switch audio outputs (no setSinkId)");
      return;
    }

    const requestedDeviceId = outputId === "default" ? "" : outputId;
    let active = true;
    const apply = async () => {
      const current = outputSelectionRef.current;
      if (!active || current.context !== liveCtx || current.deviceId !== requestedDeviceId || current.unavailable)
        return;
      const result = await applyOutputDevice(liveCtx, requestedDeviceId);
      const latest = outputSelectionRef.current;
      if (!active || latest.context !== liveCtx || latest.deviceId !== requestedDeviceId || latest.unavailable) return;
      setOutputMessage(result.status === "ok" ? null : (result.message ?? null));
    };
    const pending = outputApplyQueueRef.current.then(apply, apply);
    outputApplyQueueRef.current = pending.catch(() => {});
    return () => {
      active = false;
    };
  }, [liveCtx, outputId, outputUnavailable, outputsLoaded, sinkSupported]);

  const changeOutput = (deviceId: string) => {
    setOutputId(deviceId);
    saveOutputDeviceId(deviceId === "default" ? "" : deviceId);
    setOutputMessage(null);
  };

  // ----- INPUT -----
  const [inputs, setInputs] = useState<RecordingInputDevice[]>([]);
  const [inputId, setInputId] = useState<string>(loadRecordingInputDeviceId());
  const [inputGainDb, setInputGainDb] = useState<number>(loadRecordingInputGainDb());
  const [inputsMissingLabels, setInputsMissingLabels] = useState(false);
  const [inputsLoaded, setInputsLoaded] = useState(false);
  const inputUnavailable = inputsLoaded && Boolean(inputId) && !inputs.some((device) => device.deviceId === inputId);

  useEffect(() => {
    let cancelled = false;
    void listRecordingInputDevices().then((devices) => {
      if (cancelled) return;
      setInputs(devices);
      setInputsLoaded(true);
      setInputsMissingLabels(devices.every((d) => !d.label || d.label.startsWith("Audio input ")));
    });
    const media = typeof navigator !== "undefined" ? navigator.mediaDevices : null;
    const onChange = () =>
      void listRecordingInputDevices().then((devices) => {
        if (cancelled) return;
        setInputs(devices);
        setInputsLoaded(true);
        setInputsMissingLabels(devices.every((device) => !device.label || device.label.startsWith("Audio input ")));
      });
    media?.addEventListener?.("devicechange", onChange);
    return () => {
      cancelled = true;
      media?.removeEventListener?.("devicechange", onChange);
    };
  }, []);

  const changeInput = (deviceId: string) => {
    setInputId(deviceId);
    saveRecordingInputDeviceId(deviceId);
  };
  const changeInputGain = (db: number) => {
    const clamped = clampInputGainDb(db);
    setInputGainDb(clamped);
    saveRecordingInputGainDb(clamped);
  };

  // ----- ASIO (desktop only) -----
  const bridge = asioBridge();
  const [asio, setAsio] = useState<AsioListResult | null>(null);
  const [asioState, setAsioState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [asioError, setAsioError] = useState<string | null>(null);
  const loadAsio = () => {
    if (!bridge) return;
    setAsioState("loading");
    bridge
      .list()
      .then((result) => {
        setAsio(result);
        setAsioState("done");
      })
      .catch((err: unknown) => {
        setAsioError(err instanceof Error ? err.message : String(err));
        setAsioState("error");
      });
  };
  useEffect(() => {
    if (bridge && asioState === "idle") loadAsio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const detailsByName = new Map<string, AsioDriverDetail>();
  for (const driver of asio?.details.drivers ?? []) {
    if (typeof driver.name === "string") detailsByName.set(driver.name, driver);
  }

  // ----- WINDOWS CORE AUDIO ENDPOINTS AND LIVE SESSION -----
  const nativeAudioBridge = windowsAudioBridge();
  const [nativeEndpoints, setNativeEndpoints] = useState<WindowsAudioEndpointList | null>(null);
  const [nativeEndpointState, setNativeEndpointState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [nativeEndpointError, setNativeEndpointError] = useState<string | null>(null);
  const [nativeCaptureId, setNativeCaptureId] = useState("");
  const [nativeRenderId, setNativeRenderId] = useState("");
  const [nativeCaptureMap, setNativeCaptureMap] = useState("0,1");
  const [nativeRenderMap, setNativeRenderMap] = useState("0,1");
  const [nativeSessionId, setNativeSessionId] = useState<string | null>(null);
  const [nativeSessionState, setNativeSessionState] = useState<
    "idle" | "starting" | "ready" | "stopping" | "lost" | "error"
  >("idle");
  const [nativeSessionError, setNativeSessionError] = useState<string | null>(null);
  const [nativeStartupStage, setNativeStartupStage] = useState<string | null>(null);
  const [nativeNegotiation, setNativeNegotiation] = useState<WindowsAudioIoNegotiation | null>(null);
  const [nativeStats, setNativeStats] = useState<{
    renderUnderflows: number;
    renderDrops: number;
    utilityRejectedPackets: number;
    captureOverruns: number;
    captureDiscontinuities: number;
    captureQueuedFrames: number;
    renderQueuedFrames: number;
    bridgeReady: boolean;
    bridgeRenderSequence: number;
    bridgeRenderInFlightPackets: number;
  } | null>(null);
  const nativeConnectionRef = useRef<WindowsAudioIoEngineConnection | null>(null);
  const nativeConnectionUnsubscribeRef = useRef<(() => void) | null>(null);
  const nativeStageUnsubscribeRef = useRef<(() => void) | null>(null);
  const nativeStartTokenRef = useRef(0);
  const nativeStartingSessionIdRef = useRef<string | null>(null);
  const discardNativeSessionPortRef = useRef<((sessionId: string) => void) | null>(null);

  const observeNativeConnection = (connection: WindowsAudioIoEngineConnection) => {
    nativeConnectionUnsubscribeRef.current?.();
    setNativeNegotiation(connection.negotiation);
    nativeConnectionUnsubscribeRef.current = connection.subscribe((event: WindowsAudioIoBridgeEvent) => {
      if (event.type === "status") {
        setNativeStats({
          renderUnderflows: event.snapshot.nativeRenderUnderrunPeriods,
          renderDrops: event.snapshot.bridgeRenderDroppedPeriods,
          utilityRejectedPackets: event.snapshot.utilityRenderRejectedPackets,
          captureOverruns: event.snapshot.nativeCaptureOverrunPackets,
          captureDiscontinuities: event.snapshot.nativeCaptureDiscontinuities,
          captureQueuedFrames: event.snapshot.nativeCaptureQueuedFrames,
          renderQueuedFrames: event.snapshot.nativeRenderQueuedFrames,
          bridgeReady: event.snapshot.bridgeReady,
          bridgeRenderSequence: event.snapshot.bridgeRenderSequence,
          bridgeRenderInFlightPackets: event.snapshot.bridgeRenderInFlightPackets,
        });
      } else if (event.type === "device-lost") {
        setNativeSessionState("lost");
        setNativeSessionError(event.message);
      } else if (event.type === "error") {
        setNativeSessionState("error");
        setNativeSessionError(event.message);
      } else if (event.type === "stopped") {
        setNativeSessionState("idle");
      }
    });
  };

  useEffect(() => {
    let cancelled = false;
    void import("../audio-engine/windowsAudioIoBridge")
      .then(({ getWindowsAudioIoEngineConnection }) => {
        if (cancelled) return;
        const connection = getWindowsAudioIoEngineConnection(engine);
        if (connection) {
          nativeConnectionRef.current = connection;
          setNativeSessionId(connection.sessionId);
          setNativeSessionState("ready");
          observeNativeConnection(connection);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setNativeSessionState("error");
        setNativeSessionError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
      nativeStartTokenRef.current += 1;
      const startingSessionId = nativeStartingSessionIdRef.current;
      nativeStartingSessionIdRef.current = null;
      if (startingSessionId) {
        discardNativeSessionPortRef.current?.(startingSessionId);
        void nativeAudioBridge?.stopWindowsSession(startingSessionId).catch(() => undefined);
      }
      nativeConnectionUnsubscribeRef.current?.();
      nativeStageUnsubscribeRef.current?.();
    };
    // The singleton engine connection survives panel unmounts; only its UI listener is removed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  const loadNativeEndpoints = () => {
    if (!nativeAudioBridge) return;
    setNativeEndpointState("loading");
    setNativeEndpointError(null);
    nativeAudioBridge
      .listWindowsEndpoints()
      .then((result) => {
        setNativeEndpoints(result);
        setNativeEndpointState("done");
      })
      .catch((error: unknown) => {
        setNativeEndpointError(error instanceof Error ? error.message : String(error));
        setNativeEndpointState("error");
      });
  };
  useEffect(() => {
    if (nativeAudioBridge && nativeEndpointState === "idle") loadNativeEndpoints();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nativeCaptureEndpoints = nativeEndpoints?.endpoints.filter((endpoint) => endpoint.flow === "capture") ?? [];
  const nativeRenderEndpoints = nativeEndpoints?.endpoints.filter((endpoint) => endpoint.flow === "render") ?? [];
  const nativeCaptureEndpoint = nativeCaptureEndpoints.find((endpoint) => endpoint.id === nativeCaptureId) ?? null;
  const nativeRenderEndpoint = nativeRenderEndpoints.find((endpoint) => endpoint.id === nativeRenderId) ?? null;
  const nativePeriodFrames = commonWindowsPeriod(nativeCaptureEndpoint, nativeRenderEndpoint);
  const captureChannelOptions = channelMapOptions(nativeCaptureEndpoint?.mixFormat?.channels ?? 0, false);
  const renderChannelOptions = channelMapOptions(nativeRenderEndpoint?.mixFormat?.channels ?? 0, true);

  useEffect(() => {
    if (!nativeEndpoints || nativeEndpoints.status !== "ok") return;
    setNativeCaptureId((current) => {
      if (current) return current;
      return (
        nativeCaptureEndpoints.find((endpoint) => endpoint.state === "active" && endpoint.isDefaultConsole)?.id ??
        nativeCaptureEndpoints.find((endpoint) => endpoint.state === "active")?.id ??
        ""
      );
    });
    setNativeRenderId((current) => {
      if (current) return current;
      return (
        nativeRenderEndpoints.find((endpoint) => endpoint.state === "active" && endpoint.isDefaultConsole)?.id ??
        nativeRenderEndpoints.find((endpoint) => endpoint.state === "active")?.id ??
        ""
      );
    });
  }, [nativeEndpoints, nativeCaptureEndpoints, nativeRenderEndpoints]);

  useEffect(() => {
    if (!captureChannelOptions.some((option) => option.value === nativeCaptureMap))
      setNativeCaptureMap(
        captureChannelOptions.find((option) => option.value === "0,1")?.value ?? captureChannelOptions[0]?.value ?? "",
      );
  }, [captureChannelOptions, nativeCaptureMap]);

  useEffect(() => {
    if (!renderChannelOptions.some((option) => option.value === nativeRenderMap))
      setNativeRenderMap(
        renderChannelOptions.find((option) => option.value === "0,1")?.value ?? renderChannelOptions[0]?.value ?? "",
      );
  }, [renderChannelOptions, nativeRenderMap]);

  const startNativeAudio = async () => {
    if (!nativeAudioBridge?.startWindowsSession) return;
    const startToken = ++nativeStartTokenRef.current;
    nativeStartingSessionIdRef.current = null;
    setNativeSessionState("starting");
    setNativeSessionError(null);
    setNativeStartupStage(null);
    setNativeNegotiation(null);
    setNativeStats(null);
    let sessionId: string | null = null;
    // A plain `let pendingStage` is narrowed to `null` by control-flow
    // analysis: the only write TypeScript can see in the straight-line flow
    // is the initializer, because the write inside the stage-listener
    // callback is not tracked. The read below (`pendingStage?.sessionId`)
    // then resolved against `never` and failed to compile. A mutable holder
    // object keeps the declared type at the read site — the assignment inside
    // the callback invalidates the property narrowing, so the union survives.
    const pendingStageRef: { current: { sessionId: string; stage: string } | null } = { current: null };
    let transferredPort: MessagePort | null = null;
    try {
      const live = engine.getLiveAudioContext() ?? engine.ensureContext();
      if (!isLiveAudioContext(live)) throw new Error("Native Windows audio requires the live studio AudioContext");
      if (live.state === "suspended") await live.resume();
      if (startToken !== nativeStartTokenRef.current) return;
      if (!nativeCaptureEndpoint || nativeCaptureEndpoint.state !== "active")
        throw new Error("Choose an active Windows capture endpoint");
      if (!nativeRenderEndpoint || nativeRenderEndpoint.state !== "active")
        throw new Error("Choose an active Windows output endpoint");
      if (
        nativeCaptureEndpoint.mixFormat?.sampleRateHz !== live.sampleRate ||
        nativeRenderEndpoint.mixFormat?.sampleRateHz !== live.sampleRate
      ) {
        throw new Error(
          "Both selected Windows endpoints must match the KYX audio sample rate; resampling is not enabled yet",
        );
      }
      if (!nativePeriodFrames) throw new Error("The selected endpoints have no common supported shared-mode period");
      if (!nativeCaptureMap || !nativeRenderMap) throw new Error("Select the capture and output hardware channels");
      const candidate: WindowsAudioIoRequest = {
        backend: "wasapi-shared",
        inputEndpointId: nativeCaptureEndpoint.id,
        outputEndpointId: nativeRenderEndpoint.id,
        sampleRateHz: live.sampleRate,
        periodFrames: nativePeriodFrames,
        inputChannelMap: parseChannelMap(nativeCaptureMap),
        outputChannelMap: parseChannelMap(nativeRenderMap),
        exclusiveAcknowledged: false,
      };
      const validated = validateWindowsAudioIoRequest(candidate);
      if (!validated.ok) throw new Error(validated.errors.join("; "));
      nativeStageUnsubscribeRef.current?.();
      nativeStageUnsubscribeRef.current =
        nativeAudioBridge.onWindowsSessionStage?.((stageEvent) => {
          if (sessionId === stageEvent.sessionId) setNativeStartupStage(stageEvent.stage);
          else if (sessionId === null) pendingStageRef.current = stageEvent;
        }) ?? null;
      const windowsAudioIoBridge = await import("../audio-engine/windowsAudioIoBridge");
      discardNativeSessionPortRef.current = windowsAudioIoBridge.discardWindowsAudioSessionPort;
      if (startToken !== nativeStartTokenRef.current) return;
      const started = await nativeAudioBridge.startWindowsSession(validated.value);
      sessionId = started.sessionId;
      nativeStartingSessionIdRef.current = sessionId;
      if (startToken !== nativeStartTokenRef.current) {
        windowsAudioIoBridge.discardWindowsAudioSessionPort(sessionId);
        await nativeAudioBridge.stopWindowsSession(sessionId).catch(() => undefined);
        if (nativeStartingSessionIdRef.current === sessionId) nativeStartingSessionIdRef.current = null;
        return;
      }
      setNativeSessionId(sessionId);
      if (pendingStageRef.current?.sessionId === sessionId) {
        setNativeStartupStage(pendingStageRef.current.stage);
      }
      transferredPort = await windowsAudioIoBridge.waitForWindowsAudioSessionPort(sessionId);
      if (startToken !== nativeStartTokenRef.current) {
        transferredPort.close();
        transferredPort = null;
        await nativeAudioBridge.stopWindowsSession(sessionId).catch(() => undefined);
        if (nativeStartingSessionIdRef.current === sessionId) nativeStartingSessionIdRef.current = null;
        return;
      }
      const connection = await windowsAudioIoBridge.connectWindowsAudioIoToEngine(
        engine,
        sessionId,
        transferredPort,
        validated.value,
      );
      transferredPort = null;
      if (startToken !== nativeStartTokenRef.current) {
        connection.stop();
        await nativeAudioBridge.stopWindowsSession(sessionId).catch(() => undefined);
        if (nativeStartingSessionIdRef.current === sessionId) nativeStartingSessionIdRef.current = null;
        return;
      }
      nativeStartingSessionIdRef.current = null;
      nativeConnectionRef.current = connection;
      observeNativeConnection(connection);
      setNativeSessionState("ready");
      setNativeSessionError(null);
    } catch (error) {
      nativeStageUnsubscribeRef.current?.();
      nativeStageUnsubscribeRef.current = null;
      transferredPort?.close();
      if (sessionId) {
        discardNativeSessionPortRef.current?.(sessionId);
        await nativeAudioBridge.stopWindowsSession(sessionId).catch(() => undefined);
      }
      nativeConnectionRef.current?.stop();
      nativeConnectionRef.current = null;
      if (nativeStartingSessionIdRef.current === sessionId) nativeStartingSessionIdRef.current = null;
      if (startToken !== nativeStartTokenRef.current) return;
      setNativeSessionId(null);
      setNativeSessionState("error");
      setNativeSessionError(error instanceof Error ? error.message : String(error));
      setNativeNegotiation(null);
    }
  };

  const stopNativeAudio = async () => {
    nativeStartTokenRef.current += 1;
    const startingSessionId = nativeStartingSessionIdRef.current;
    const sessionId = nativeSessionId ?? startingSessionId ?? nativeConnectionRef.current?.sessionId;
    nativeStartingSessionIdRef.current = null;
    if (startingSessionId) discardNativeSessionPortRef.current?.(startingSessionId);
    setNativeSessionState("stopping");
    nativeConnectionUnsubscribeRef.current?.();
    nativeConnectionUnsubscribeRef.current = null;
    nativeStageUnsubscribeRef.current?.();
    nativeStageUnsubscribeRef.current = null;
    nativeConnectionRef.current?.stop();
    nativeConnectionRef.current = null;
    try {
      if (sessionId) await nativeAudioBridge?.stopWindowsSession(sessionId);
      setNativeSessionId(null);
      setNativeSessionState("idle");
      setNativeSessionError(null);
      setNativeNegotiation(null);
      setNativeStats(null);
    } catch (error) {
      setNativeSessionState("error");
      setNativeSessionError(error instanceof Error ? error.message : String(error));
    }
  };

  const tone = () => {
    const result = engine.playTestTone();
    if (result.status === "error") setOutputMessage(result.message ?? null);
  };

  return (
    <div className="io-panel" aria-label="Studio I/O">
      <PanelHeader kicker="STUDIO I/O" title="Audio devices" hint="Per-browser prefs" />

      {/* OUTPUT */}
      <section className="panel-section">
        <div className="panel-section-head">
          <span className="panel-section-title">OUTPUT</span>
          {liveCtx && (
            <span className="io-readout" data-hint="Active audio context" data-hint-value={liveCtx.state}>
              {liveCtx.state}
            </span>
          )}
        </div>
        <label className="io-field">
          <span className="io-field-label">DEVICE</span>
          <select
            value={outputId}
            onChange={(event) => changeOutput(event.target.value)}
            disabled={outputs.length <= 1 && !outputUnavailable}
          >
            {outputs.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || `Audio output ${device.deviceId.slice(0, 8)}`}
              </option>
            ))}
            {outputUnavailable && (
              <option value={outputId} disabled>
                Saved output unavailable
              </option>
            )}
          </select>
        </label>
        {outputUnavailable && (
          <div className="io-error" role="status">
            The saved output is not currently listed. Choose an available output or explicitly select System default
            output.
          </div>
        )}
        {!sinkSupported && (
          <div className="io-note" role="note">
            This browser cannot switch outputs (no setSinkId) — sound follows the system default.
          </div>
        )}
        {outputsMissingLabels && sinkSupported && (
          <div className="io-note" role="note">
            Device names appear after the first playback in this session (browser privacy rule).
          </div>
        )}
        {outputMessage && (
          <div className="io-error" role="status">
            {outputMessage}
          </div>
        )}
        {liveCtx && (
          <div className="io-stats">
            <span data-hint="Context sample rate" data-hint-value={`${liveCtx.sampleRate} Hz`}>
              {liveCtx.sampleRate} Hz
            </span>
            <span
              data-hint="Base latency (lower = tighter)"
              data-hint-value={`${Math.round((liveCtx.baseLatency ?? 0) * 1000)} ms`}
            >
              base {(1000 * (liveCtx.baseLatency ?? 0)).toFixed(1)} ms
            </span>
            {liveCtx.outputLatency !== undefined && (
              <span
                data-hint="Reported output latency"
                data-hint-value={`${Math.round(liveCtx.outputLatency * 1000)} ms`}
              >
                out {(1000 * liveCtx.outputLatency).toFixed(1)} ms
              </span>
            )}
          </div>
        )}
        <div className="io-actions">
          <button type="button" className="btn btn-small" onClick={tone} disabled={!liveCtx}>
            TEST TONE
          </button>
        </div>
      </section>

      {/* INPUT */}
      <section className="panel-section">
        <div className="panel-section-head">
          <span className="panel-section-title">INPUT</span>
        </div>
        <label className="io-field">
          <span className="io-field-label">DEVICE</span>
          <select value={inputId} onChange={(event) => changeInput(event.target.value)}>
            <option value="">System default input</option>
            {inputUnavailable && (
              <option value={inputId} disabled>
                Saved input unavailable
              </option>
            )}
            {inputs.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </select>
        </label>
        {inputUnavailable && (
          <div className="io-error" role="status">
            The saved input is not currently listed. Recording stays pinned to this device ID and will report an error
            if the browser cannot resolve it; it will not switch inputs silently.
          </div>
        )}
        {inputsMissingLabels && inputs.length > 0 && (
          <div className="io-note" role="note">
            Microphone names appear after granting input permission (arm a recording once).
          </div>
        )}
        <label className="io-field io-field-slider">
          <span className="io-field-label">TRIM</span>
          <input
            type="range"
            min={-24}
            max={24}
            step={0.5}
            value={inputGainDb}
            data-hint="Input trim — pre-gain for every recording take"
            data-hint-value={`${inputGainDb > 0 ? "+" : ""}${inputGainDb.toFixed(1)} dB`}
            onChange={(event) => changeInputGain(Number(event.target.value))}
          />
          <span className="io-field-value">
            {inputGainDb > 0 ? "+" : ""}
            {inputGainDb.toFixed(1)} dB
          </span>
        </label>
        <div className="io-note" role="note">
          Applies to audio-input takes; the arrangement recording toolbar picks the same device.
        </div>
      </section>

      {/* WINDOWS CORE AUDIO — exact endpoint selection and native duplex session. */}
      {nativeAudioBridge && (
        <section className="panel-section">
          <div className="panel-section-head">
            <span className="panel-section-title">WINDOWS AUDIO</span>
            <button
              type="button"
              className="btn btn-small"
              onClick={loadNativeEndpoints}
              disabled={nativeEndpointState === "loading"}
              title="Re-enumerate Windows Core Audio endpoints"
            >
              {nativeEndpointState === "loading" ? "SCANNING…" : "RESCAN"}
            </button>
          </div>
          {nativeEndpointState === "error" && (
            <div className="io-error" role="status">
              Discovery failed: {nativeEndpointError}
            </div>
          )}
          {nativeEndpoints?.status === "ok" && nativeEndpoints.endpoints.length === 0 && (
            <EmptyState
              icon="🔌"
              title="No Windows audio endpoints"
              hint="Connect or enable an audio device, then rescan."
            />
          )}
          {(nativeEndpoints?.endpoints.length ?? 0) > 0 && (
            <ul className="io-driver-list">
              {nativeEndpoints!.endpoints.map((endpoint) => (
                <li key={`${endpoint.flow}:${endpoint.id}`} className="io-driver">
                  <span className="io-driver-name" title={endpoint.name}>
                    {endpoint.name}
                  </span>
                  <span className="io-driver-meta">
                    {endpoint.flow} · {endpoint.state}
                    {endpoint.isDefaultConsole ? " · console default" : ""}
                    {endpoint.mixFormat
                      ? ` · engine mix: ${endpoint.mixFormat.channels} ch / ${Math.round(endpoint.mixFormat.sampleRateHz / 1000)} kHz / ${endpoint.mixFormat.validBitsPerSample === endpoint.mixFormat.bitsPerSample ? `${endpoint.mixFormat.bitsPerSample}-bit` : `${endpoint.mixFormat.validBitsPerSample} valid / ${endpoint.mixFormat.bitsPerSample} container bits`} ${endpoint.mixFormat.floatingPoint ? "float" : "PCM"}`
                      : ""}
                    {endpoint.mixFormat?.sharedPeriods
                      ? ` · shared period ${endpoint.mixFormat.sharedPeriods.minFrames}–${endpoint.mixFormat.sharedPeriods.maxFrames} frames (default ${endpoint.mixFormat.sharedPeriods.defaultFrames})`
                      : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {nativeEndpoints?.status === "ok" && nativeEndpoints.endpoints.length > 0 && (
            <>
              <label className="io-field">
                <span className="io-field-label">NATIVE INPUT</span>
                <select
                  value={nativeCaptureId}
                  onChange={(event) => {
                    const nextId = event.target.value;
                    setNativeCaptureId(nextId);
                    const endpoint = nativeCaptureEndpoints.find((candidate) => candidate.id === nextId);
                    const options = channelMapOptions(endpoint?.mixFormat?.channels ?? 0, false);
                    setNativeCaptureMap(
                      options.find((option) => option.value === "0,1")?.value ?? options[0]?.value ?? "",
                    );
                  }}
                  disabled={nativeSessionState === "starting" || nativeSessionState === "stopping"}
                >
                  <option value="">Choose exact input…</option>
                  {nativeCaptureEndpoints.map((endpoint) => (
                    <option key={endpoint.id} value={endpoint.id}>
                      {endpoint.name} · {endpoint.state}
                    </option>
                  ))}
                </select>
              </label>
              <label className="io-field">
                <span className="io-field-label">INPUT CHANNELS</span>
                <select
                  value={nativeCaptureMap}
                  onChange={(event) => setNativeCaptureMap(event.target.value)}
                  disabled={
                    !nativeCaptureEndpoint || nativeSessionState === "starting" || nativeSessionState === "stopping"
                  }
                >
                  {captureChannelOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="io-field">
                <span className="io-field-label">NATIVE OUTPUT</span>
                <select
                  value={nativeRenderId}
                  onChange={(event) => {
                    const nextId = event.target.value;
                    setNativeRenderId(nextId);
                    const endpoint = nativeRenderEndpoints.find((candidate) => candidate.id === nextId);
                    setNativeRenderMap(channelMapOptions(endpoint?.mixFormat?.channels ?? 0, true)[0]?.value ?? "");
                  }}
                  disabled={nativeSessionState === "starting" || nativeSessionState === "stopping"}
                >
                  <option value="">Choose exact output…</option>
                  {nativeRenderEndpoints.map((endpoint) => (
                    <option key={endpoint.id} value={endpoint.id}>
                      {endpoint.name} · {endpoint.state}
                    </option>
                  ))}
                </select>
              </label>
              <label className="io-field">
                <span className="io-field-label">OUTPUT CHANNELS</span>
                <select
                  value={nativeRenderMap}
                  onChange={(event) => setNativeRenderMap(event.target.value)}
                  disabled={
                    !nativeRenderEndpoint || nativeSessionState === "starting" || nativeSessionState === "stopping"
                  }
                >
                  {renderChannelOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="io-note" role="note">
                KYX rate {liveCtx ? `${liveCtx.sampleRate} Hz` : "available after audio starts"} · common shared period{" "}
                {nativePeriodFrames
                  ? `${nativePeriodFrames} frames (${((nativePeriodFrames / (liveCtx?.sampleRate ?? 48_000)) * 1000).toFixed(1)} ms)`
                  : "unavailable"}
                . The active native input is used for arrangement recording.
              </div>
              <div className="io-actions">
                {canStopNativeAudioSession(nativeSessionState, nativeConnectionRef.current !== null) ? (
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => void stopNativeAudio()}
                    disabled={nativeSessionState === "stopping"}
                  >
                    {nativeSessionState === "stopping" ? "STOPPING…" : "STOP NATIVE AUDIO"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => void startNativeAudio()}
                    disabled={
                      nativeEndpointState === "loading" ||
                      !nativeCaptureEndpoint ||
                      nativeCaptureEndpoint.state !== "active" ||
                      !nativeRenderEndpoint ||
                      nativeRenderEndpoint.state !== "active" ||
                      !nativePeriodFrames ||
                      !nativeRenderMap
                    }
                  >
                    {nativeSessionState === "lost" || nativeSessionState === "error"
                      ? "RETRY NATIVE AUDIO"
                      : "START NATIVE AUDIO"}
                  </button>
                )}
                <span className="io-readout" role="status">
                  {nativeSessionState === "ready" ? "WASAPI SHARED · RUNNING" : nativeSessionState.toUpperCase()}
                </span>
              </div>
              {nativeSessionState === "starting" && nativeStartupStage && (
                <div className="io-note" role="status">
                  WASAPI startup stage: {nativeStartupStage}
                </div>
              )}
              {nativeSessionError && (
                <div className="io-error" role="status">
                  {nativeSessionError}
                </div>
              )}
              {(nativeStats || nativeNegotiation) && nativeSessionState === "ready" && (
                <div className="io-stats" aria-label="Native Windows audio diagnostics">
                  {nativeNegotiation && (
                    <span>
                      endpoint-reported stream latency · input{" "}
                      {formatReportedWindowsAudioLatency(
                        nativeNegotiation.reportedInputLatencyFrames,
                        nativeNegotiation.sampleRateHz,
                      )}{" "}
                      / output{" "}
                      {formatReportedWindowsAudioLatency(
                        nativeNegotiation.reportedOutputLatencyFrames,
                        nativeNegotiation.sampleRateHz,
                      )}
                      · acoustic loopback not measured
                    </span>
                  )}
                  {nativeStats && (
                    <>
                      <span>render underflows {nativeStats.renderUnderflows}</span>
                      <span>worklet drops {nativeStats.renderDrops}</span>
                      <span>utility rejected/gaps {nativeStats.utilityRejectedPackets}</span>
                      <span>capture overruns {nativeStats.captureOverruns}</span>
                      <span>capture gaps {nativeStats.captureDiscontinuities}</span>
                      <span>bridge ready {nativeStats.bridgeReady ? "yes" : "no"}</span>
                      <span>
                        bridge periods/in-flight {nativeStats.bridgeRenderSequence}/
                        {nativeStats.bridgeRenderInFlightPackets}
                      </span>
                      <span>
                        queued {nativeStats.renderQueuedFrames}/{nativeStats.captureQueuedFrames} frames
                      </span>
                    </>
                  )}
                </div>
              )}
            </>
          )}
          {nativeEndpoints && nativeEndpoints.status !== "ok" && (
            <div className="io-note" role="note">
              {nativeEndpoints.message ?? `Endpoint discovery: ${nativeEndpoints.status}`}
            </div>
          )}
          <div className="io-note" role="note">
            Native sessions use the exact selected endpoints in shared mode, with no automatic fallback. Hardware
            connector mapping, loopback latency, extended soak and device-loss recovery still need physical
            qualification.
          </div>
        </section>
      )}

      {/* DRIVERS — desktop shell only */}
      {bridge && (
        <section className="panel-section">
          <div className="panel-section-head">
            <span className="panel-section-title">ASIO DRIVERS</span>
            <button
              type="button"
              className="btn btn-small"
              onClick={loadAsio}
              disabled={asioState === "loading"}
              title="Re-run discovery (registry + out-of-process probe)"
            >
              {asioState === "loading" ? "SCANNING…" : "RESCAN"}
            </button>
          </div>
          {asioState === "error" && (
            <div className="io-error" role="status">
              Discovery failed: {asioError}
            </div>
          )}
          {asio?.registry.status === "ok" && (asio.registry.names?.length ?? 0) === 0 && (
            <EmptyState icon="🎛" title="No ASIO drivers registered" hint="Install a driver (or FlexASIO) and rescan." />
          )}
          {(asio?.registry.names?.length ?? 0) > 0 && (
            <ul className="io-driver-list">
              {asio!.registry.names!.map((name) => {
                const detail = detailsByName.get(name);
                return (
                  <li key={name} className="io-driver">
                    <span className="io-driver-name" title={name}>
                      {name}
                    </span>
                    <span className="io-driver-meta">
                      {detail
                        ? [
                            detail.inputChannels !== undefined ? `${detail.inputChannels}in` : null,
                            detail.outputChannels !== undefined ? `${detail.outputChannels}out` : null,
                            detail.bufferSize?.min !== undefined
                              ? `${detail.bufferSize.min}–${detail.bufferSize.max ?? "?"} smp`
                              : null,
                            detail.sampleRate !== undefined ? formatHz(detail.sampleRate) : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")
                        : "registered — details unavailable"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {asio && asio.details.status !== "ok" && (asio.registry.names?.length ?? 0) > 0 && (
            <div className="io-note" role="note">
              {asio.details.status === "no-probe"
                ? "Detailed probe not built on this machine — registry names only."
                : asio.details.partial
                  ? "Some drivers did not answer before the timeout — partial results shown."
                  : `Probe status: ${asio.details.status}`}
            </div>
          )}
          <div className="io-note" role="note">
            Discovery only (ADR 0017). Streaming from real hardware stays an owner gate — the playback pipeline itself
            is soak-tested (ADR 0018).
          </div>
        </section>
      )}
    </div>
  );
}
