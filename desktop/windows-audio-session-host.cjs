/**
 * Product WASAPI session host. PCM only crosses its dedicated MessagePort;
 * endpoint control remains on the utility-process parent port.
 */
const fs = require("node:fs");
const path = require("node:path");
const { ringCapacityFramesForPeriod } = require("./windows-audio-io.cjs");
const {
  DEFAULT_TIMEOUT_MS: NATIVE_STARTUP_TIMEOUT_MS,
  isNativeStartupPending,
  scheduleNativeStartupWatchdog,
} = require("./windows-audio-startup-watchdog.cjs");

const MAX_PACKET_FRAMES = 8_192;
const MAX_CHANNELS = 2;
const POOL_SIZE = 6;
const CAPTURE_POLL_MS = 2;
const STATUS_INTERVAL_MS = 250;
const BRIDGE_ATTACH_TIMEOUT_MS = 8_000;

let active = null;

function isInteger(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function validChannelMap(value, maxChannels) {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= maxChannels &&
    value.every((channel) => isInteger(channel, 0, 31)) &&
    new Set(value).size === value.length
  );
}

function validateRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Audio request must be an object");
  if (value.backend !== "wasapi-shared") throw new Error("Only Windows shared-mode audio is currently available");
  for (const key of ["inputEndpointId", "outputEndpointId"]) {
    if (typeof value[key] !== "string" || value[key].trim().length === 0 || value[key].length > 2048)
      throw new Error(`${key} must select an exact endpoint ID`);
  }
  if (!isInteger(value.sampleRateHz, 8_000, 384_000)) throw new Error("Sample rate is outside the supported range");
  if (!isInteger(value.periodFrames, 128, MAX_PACKET_FRAMES))
    throw new Error("Audio period is outside the packet bound");
  if (!validChannelMap(value.inputChannelMap, MAX_CHANNELS))
    throw new Error("Capture routing must select one or two channels");
  if (!validChannelMap(value.outputChannelMap, MAX_CHANNELS) || value.outputChannelMap.length !== 2)
    throw new Error("The KYX master output requires an explicit stereo channel pair");
  if (value.exclusiveAcknowledged !== false)
    throw new Error("Shared mode must not request exclusive-mode acknowledgement");
  return value;
}

function addonPath() {
  const name = "kyx_windows_audio_host.node";
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, "windows-audio-host", name),
    path.join(__dirname, "..", "native", "windows-audio-host", "build", "Release", name),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function negotiationFrom(snapshot, request) {
  if (!snapshot || snapshot.state !== "running")
    throw new Error(snapshot?.lastError || "WASAPI session did not enter running state");
  return {
    backend: "wasapi-shared",
    inputEndpointId: snapshot.inputEndpointId,
    outputEndpointId: snapshot.outputEndpointId,
    sampleRateHz: snapshot.sampleRateHz,
    periodFrames: snapshot.periodFrames,
    nativeSampleFormat: "f32le",
    ringSampleFormat: "f32le",
    inputChannelCount: snapshot.inputEndpointChannels,
    outputChannelCount: snapshot.outputEndpointChannels,
    inputChannelMap: snapshot.inputChannelMap,
    outputChannelMap: snapshot.outputChannelMap,
    inputBufferFrames: snapshot.inputBufferFrames,
    outputBufferFrames: snapshot.outputBufferFrames,
    ...(Number.isSafeInteger(snapshot.reportedInputLatencyFrames)
      ? { reportedInputLatencyFrames: snapshot.reportedInputLatencyFrames }
      : {}),
    ...(Number.isSafeInteger(snapshot.reportedOutputLatencyFrames)
      ? { reportedOutputLatencyFrames: snapshot.reportedOutputLatencyFrames }
      : {}),
    sharedPeriods: snapshot.sharedPeriods,
    captureChannels: request.inputChannelMap.length,
    renderChannels: request.outputChannelMap.length,
  };
}

function stopActive(reason, notify = true, closePort = true) {
  const current = active;
  if (!current || current.stopping) return;
  current.stopping = true;
  clearInterval(current.captureTimer);
  clearInterval(current.statusTimer);
  clearInterval(current.nativeStageTimer);
  clearTimeout(current.attachTimer);
  current.cancelNativeStartupWatchdog?.();
  current.cancelNativeStartupWatchdog = null;
  try {
    current.nativeSession?.stop();
  } catch {
    /* the native session may already have stopped after device loss */
  }
  if (notify) {
    try {
      current.port?.postMessage({
        type: "stopped",
        sessionId: current.sessionId,
        message: reason || "Native audio stopped",
      });
    } catch {
      /* the renderer may have closed its port */
    }
  }
  if (closePort) {
    try {
      current.port?.close();
    } catch {
      /* already closed */
    }
  }
  if (active === current) active = null;
}

function exitUtilitySoon(delayMs = 0) {
  setTimeout(() => {
    process.parentPort.close();
    process.exit(0);
  }, delayMs);
}

function reportStage(current, stage) {
  try {
    process.parentPort.postMessage({ type: "windows-audio-session-stage", sessionId: current.sessionId, stage });
  } catch {
    /* diagnostic status is best effort */
  }
}

function startSession(sessionId, requestValue, port) {
  if (active) stopActive("Replaced by an explicitly started Windows audio session");
  const request = validateRequest(requestValue);
  const pathToAddon = addonPath();
  if (!pathToAddon) throw new Error("Windows audio native module is missing; rebuild the desktop package");
  const addon = require(pathToAddon);
  if (typeof addon.createSession !== "function") throw new Error("Windows audio native module has no session API");
  const periodFrames = request.periodFrames;
  const ringCapacityFrames = ringCapacityFramesForPeriod(periodFrames);
  const nativeSession = addon.createSession({
    inputEndpointId: request.inputEndpointId,
    outputEndpointId: request.outputEndpointId,
    sampleRateHz: request.sampleRateHz,
    periodFrames,
    inputChannelMap: request.inputChannelMap,
    outputChannelMap: request.outputChannelMap,
    ringCapacityFrames,
  });
  const current = {
    sessionId,
    request,
    port,
    nativeSession,
    capturePool: [],
    captureInFlight: new Map(),
    capturePolls: 0,
    captureEmptyPolls: 0,
    captureFramesRead: 0,
    renderSequence: null,
    renderPacketsReceived: 0,
    renderPacketsAcknowledged: 0,
    renderRejectedPackets: 0,
    captureSequence: 0,
    starting: true,
    nativeStartPending: false,
    bridgeReady: false,
    attachTimer: null,
    stopRequested: false,
    stopReason: "Native Windows audio stopped by the user",
    stopping: false,
    captureTimer: null,
    statusTimer: null,
    nativeStageTimer: null,
    cancelNativeStartupWatchdog: null,
    reportedNativeStage: null,
    nativeStartTimedOut: false,
  };
  active = current;
  const sampleCount = periodFrames * request.inputChannelMap.length;
  for (let index = 0; index < POOL_SIZE; index++)
    current.capturePool.push(new ArrayBuffer(sampleCount * Float32Array.BYTES_PER_ELEMENT));
  port.on("message", (event) => {
    const message = event.data;
    if (message?.type === "bridge-ready" && message.sessionId === current.sessionId) {
      if (!current.bridgeReady && active === current && !current.stopping) {
        current.bridgeReady = true;
        beginNativeSession(current);
      }
      return;
    }
    receivePcm(current, message);
  });
  port.on("close", () => requestStop(current, "Renderer PCM port closed", false));
  port.start();
  reportStage(current, "waiting-for-worklet");
  current.attachTimer = setTimeout(() => {
    if (active !== current || current.bridgeReady || current.stopping) return;
    const message = "Timed out waiting for the AudioWorklet PCM bridge to attach";
    reportStage(current, "worklet-attach-timeout");
    try {
      port.postMessage({ type: "error", sessionId, message });
    } catch {
      /* renderer is already gone */
    }
    stopActive(message, false, false);
    exitUtilitySoon(100);
  }, BRIDGE_ATTACH_TIMEOUT_MS);
}

function beginNativeSession(current) {
  if (active !== current || current.stopping || current.nativeStartPending) return;
  current.nativeStartPending = true;
  reportStage(current, "worklet-attached-starting-wasapi");
  clearTimeout(current.attachTimer);
  current.nativeStageTimer = setInterval(() => {
    try {
      const snapshot = current.nativeSession.snapshot();
      const endpoint = typeof snapshot?.startupEndpoint === "string" ? snapshot.startupEndpoint : "";
      const phase = typeof snapshot?.startupStage === "string" ? snapshot.startupStage : "unknown";
      const stage = `native-start:${endpoint ? `${endpoint}/` : ""}${phase}`;
      if (stage !== current.reportedNativeStage) {
        current.reportedNativeStage = stage;
        reportStage(current, stage);
      }
    } catch {
      reportStage(current, "native-start:snapshot-failed");
    }
  }, 100);
  current.cancelNativeStartupWatchdog = scheduleNativeStartupWatchdog({
    timeoutMs: NATIVE_STARTUP_TIMEOUT_MS,
    sessionId: current.sessionId,
    isActive: () => isNativeStartupPending(current, active),
    readSnapshot: () => current.nativeSession.snapshot(),
    reportStage: (stage) => {
      current.nativeStartTimedOut = true;
      reportStage(current, stage);
    },
    postError: (message) => current.port.postMessage(message),
    terminate: (code) => process.exit(code),
  });
  Promise.resolve()
    .then(() => current.nativeSession.start())
    .then(() => {
      if (current.nativeStartTimedOut) return;
      current.cancelNativeStartupWatchdog?.();
      current.cancelNativeStartupWatchdog = null;
      clearInterval(current.nativeStageTimer);
      current.nativeStageTimer = null;
      current.starting = false;
      if (current.stopRequested) {
        stopActive(current.stopReason, false);
        exitUtilitySoon();
        return;
      }
      if (active !== current || current.stopping) return;
      const snapshot = current.nativeSession.snapshot();
      const negotiation = negotiationFrom(snapshot, current.request);
      if (
        negotiation.inputEndpointId !== current.request.inputEndpointId ||
        negotiation.outputEndpointId !== current.request.outputEndpointId ||
        negotiation.sampleRateHz !== current.request.sampleRateHz ||
        negotiation.periodFrames !== current.request.periodFrames ||
        negotiation.inputChannelMap.join(",") !== current.request.inputChannelMap.join(",") ||
        negotiation.outputChannelMap.join(",") !== current.request.outputChannelMap.join(",")
      )
        throw new Error("WASAPI changed the selected endpoint, rate, period or channel map");
      current.port.postMessage({
        type: "ready",
        sessionId: current.sessionId,
        sampleRateHz: current.request.sampleRateHz,
        periodFrames: current.request.periodFrames,
        captureChannels: current.request.inputChannelMap.length,
        renderChannels: current.request.outputChannelMap.length,
        negotiation,
      });
      reportStage(current, "wasapi-running");
      current.captureTimer = setInterval(() => pumpCapture(current), CAPTURE_POLL_MS);
      current.statusTimer = setInterval(() => publishStatus(current), STATUS_INTERVAL_MS);
      publishStatus(current);
    })
    .catch((error) => {
      if (current.nativeStartTimedOut) return;
      current.cancelNativeStartupWatchdog?.();
      current.cancelNativeStartupWatchdog = null;
      clearInterval(current.nativeStageTimer);
      current.nativeStageTimer = null;
      current.starting = false;
      if (current.stopRequested) {
        stopActive(current.stopReason, false);
        exitUtilitySoon();
        return;
      }
      if (active !== current) return;
      const message = error instanceof Error ? error.message : String(error);
      reportStage(current, "wasapi-start-failed");
      try {
        current.port.postMessage({ type: "error", sessionId: current.sessionId, message });
      } catch {
        /* renderer is already gone */
      }
      stopActive(message, false, false);
      exitUtilitySoon(100);
    });
}

function requestStop(current, reason, notify = true) {
  if (active !== current || current.stopping) return;
  if (current.starting) {
    current.stopRequested = true;
    current.stopReason = reason;
    if (!current.nativeStartPending) {
      stopActive(reason, notify);
      exitUtilitySoon();
    }
    return;
  }
  stopActive(reason, notify);
  exitUtilitySoon();
}

function receivePcm(current, message) {
  if (active !== current || current.stopping || !message || typeof message !== "object") return;
  if (message.sessionId !== current.sessionId) return;
  if (message.type === "recycle-capture") {
    if (!Number.isSafeInteger(message.sequence) || message.sequence < 0) return;
    const samples = current.captureInFlight.get(message.sequence);
    if (!samples) return;
    current.captureInFlight.delete(message.sequence);
    if (current.capturePool.length < POOL_SIZE) current.capturePool.push(samples);
    return;
  }
  if (message.type !== "render") return;
  current.renderPacketsReceived++;
  const samples = message.samples;
  const valid =
    Number.isSafeInteger(message.sequence) &&
    message.sequence >= 0 &&
    message.frames === current.request.periodFrames &&
    message.channels === current.request.outputChannelMap.length &&
    samples instanceof ArrayBuffer &&
    samples.byteLength === message.frames * message.channels * Float32Array.BYTES_PER_ELEMENT;
  if (!valid) {
    current.renderRejectedPackets++;
    try {
      if (Number.isSafeInteger(message.sequence) && message.sequence >= 0)
        current.port.postMessage({ type: "recycle-render", sessionId: current.sessionId, sequence: message.sequence });
      current.renderPacketsAcknowledged++;
    } catch {
      /* ignore malformed packet acknowledgement */
    }
    return;
  }
  if (current.renderSequence !== null && message.sequence <= current.renderSequence) {
    current.renderRejectedPackets++;
  } else {
    if (current.renderSequence !== null && message.sequence > current.renderSequence + 1)
      current.renderRejectedPackets += message.sequence - current.renderSequence - 1;
    const accepted = current.nativeSession.writeRender(new Float32Array(samples));
    if (!accepted) current.renderRejectedPackets++;
    current.renderSequence = message.sequence;
  }
  try {
    current.port.postMessage({ type: "recycle-render", sessionId: current.sessionId, sequence: message.sequence });
    current.renderPacketsAcknowledged++;
  } catch {
    /* the worklet port can be closing during user stop */
  }
}

function pumpCapture(current) {
  if (active !== current || current.stopping || current.capturePool.length === 0) return;
  current.capturePolls++;
  for (let index = 0; index < POOL_SIZE && current.capturePool.length > 0; index++) {
    const buffer = current.capturePool.pop();
    const samples = new Float32Array(buffer);
    let frames = 0;
    try {
      frames = current.nativeSession.readCaptureInto(samples);
    } catch (error) {
      current.renderRejectedPackets++;
      current.capturePool.push(buffer);
      publishError(current, error);
      return;
    }
    if (frames < 1) {
      current.captureEmptyPolls++;
      current.capturePool.push(buffer);
      return;
    }
    current.captureFramesRead += frames;
    const sequence = current.captureSequence++;
    current.captureInFlight.set(sequence, buffer);
    try {
      current.port.postMessage({ type: "capture", sessionId: current.sessionId, sequence, frames, samples: buffer });
    } catch (error) {
      current.captureInFlight.delete(sequence);
      current.capturePool.push(buffer);
      publishError(current, error);
      return;
    }
  }
}

function publishStatus(current) {
  if (active !== current || current.stopping) return;
  let snapshot;
  try {
    snapshot = current.nativeSession.snapshot();
  } catch (error) {
    publishError(current, error);
    return;
  }
  if (snapshot.state === "device-lost") {
    try {
      current.port.postMessage({
        type: "device-lost",
        sessionId: current.sessionId,
        message: snapshot.lastError,
        snapshot,
      });
    } catch {
      /* renderer may already be disconnected */
    }
    stopActive(snapshot.lastError || "Selected Windows audio device was lost", false, false);
    exitUtilitySoon(100);
    return;
  }
  if (snapshot.state === "failed" || snapshot.state === "stopped") {
    try {
      current.port.postMessage({
        type: "error",
        sessionId: current.sessionId,
        message: snapshot.lastError || snapshot.state,
        snapshot,
      });
    } catch {
      /* renderer may already be disconnected */
    }
    stopActive(snapshot.lastError || snapshot.state, false, false);
    exitUtilitySoon(100);
    return;
  }
  const bridge = {
    renderRejectedPackets: current.renderRejectedPackets,
    renderDroppedPeriods: current.renderRejectedPackets,
    renderPacketsReceived: current.renderPacketsReceived,
    renderPacketsAcknowledged: current.renderPacketsAcknowledged,
    capturePoolAvailable: current.capturePool.length,
    captureSequence: current.captureSequence,
    capturePolls: current.capturePolls,
    captureEmptyPolls: current.captureEmptyPolls,
    captureFramesRead: current.captureFramesRead,
    captureInFlightPackets: current.captureInFlight.size,
  };
  try {
    current.port.postMessage({ type: "status", sessionId: current.sessionId, snapshot, bridge });
  } catch {
    stopActive("Could not publish Windows audio status", false, false);
    exitUtilitySoon(100);
  }
}

function publishError(current, error) {
  const message = error instanceof Error ? error.message : String(error);
  try {
    current.port.postMessage({ type: "error", sessionId: current.sessionId, message });
  } catch {
    /* renderer may already be disconnected */
  }
  stopActive(message, false, false);
  exitUtilitySoon(100);
}

process.parentPort.on("message", (event) => {
  const message = event.data;
  if (message?.type === "start" && event.ports?.length === 1) {
    try {
      startSession(message.sessionId, message.request, event.ports[0]);
    } catch (error) {
      const port = event.ports[0];
      try {
        port.start();
        port.postMessage({
          type: "error",
          sessionId: message.sessionId,
          message: error instanceof Error ? error.message : String(error),
        });
      } catch {
        /* receiver cannot accept a startup error */
      }
      exitUtilitySoon(100);
    }
    return;
  }
  if (message?.type === "stop" && active?.sessionId === message.sessionId) {
    requestStop(active, "Native Windows audio stopped by the user");
    process.parentPort.postMessage({ type: "stopped", sessionId: message.sessionId });
  }
});
process.parentPort.start();
