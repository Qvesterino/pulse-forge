const path = require("node:path");
const { validateRequest } = require("./windows-audio-io.cjs");

const SESSION_SCRIPT = path.join(__dirname, "windows-audio-session-host.cjs");
const SMOKE_CHANNEL = "kyx:audio:windows-session-port";
const STATUS_POLL_MS = 250;
const START_TIMEOUT_MS = 20_000;
const HOST_STOP_TIMEOUT_MS = 1_500;

function readConfiguration() {
  let parsed;
  try {
    parsed = JSON.parse(process.env.KYX_WINDOWS_AUDIO_DEVICE_SMOKE_REQUEST || "");
  } catch {
    throw new Error("Set a valid exact-endpoint request with the device-smoke CLI");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("The Windows audio device-smoke request must be an object");
  const durationMs = parsed.durationMs;
  if (!Number.isSafeInteger(durationMs) || durationMs < 5_000 || durationMs > 1_800_000)
    throw new Error("The smoke duration must be between 5000 and 1800000 milliseconds");
  return { request: validateRequest(parsed.request), durationMs };
}

function rendererSetupScript(sessionId, request) {
  const config = JSON.stringify({ sessionId, request });
  const channel = JSON.stringify(SMOKE_CHANNEL);
  return [
    "(() => {",
    "  const config = " + config + ";",
    "  const state = { status: 'preparing', sessionId: config.sessionId, negotiation: null, snapshot: null, bridge: null, maxCaptureQueuedFrames: 0, maxRenderQueuedFrames: 0, statusMessages: 0, error: null, contextSampleRateHz: null, stop: null };",
    "  window.__kyxWindowsAudioDeviceSmoke = state;",
    "  let context = null, node = null, source = null, captureDestination = null, onSessionPort = null;",
    "  const fail = (error) => { state.status = 'error'; state.error = error instanceof Error ? error.message : String(error); };",
    "  const start = async () => {",
    "    context = new AudioContext({ latencyHint: 'interactive', sampleRate: config.request.sampleRateHz });",
    "    await context.audioWorklet.addModule('/windows-audio-io-bridge.js');",
    "    node = new AudioWorkletNode(context, 'kyx-windows-audio-io-bridge', {",
    "      numberOfInputs: 1, numberOfOutputs: 2, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'discrete',",
    "      outputChannelCount: [2, config.request.inputChannelMap.length],",
    "      processorOptions: { sessionId: config.sessionId, periodFrames: config.request.periodFrames, captureChannels: config.request.inputChannelMap.length, poolSize: 6 },",
    "    });",
    "    source = context.createConstantSource();",
    "    source.offset.value = 0;",
    "    captureDestination = context.createMediaStreamDestination();",
    "    node.connect(context.destination, 0, 0);",
    "    node.connect(captureDestination, 1, 0);",
    "    source.connect(node);",
    "    node.port.onmessage = (event) => {",
    "      const message = event.data;",
    "      if (!message || typeof message !== 'object') return;",
    "      if (message.type === 'ready') { state.status = 'ready'; state.readyAt = performance.now(); state.negotiation = message.negotiation; }",
    "      else if (message.type === 'status') {",
    "        state.statusMessages++; state.snapshot = message.snapshot || null; state.bridge = message.bridge || null;",
    "        state.maxCaptureQueuedFrames = Math.max(state.maxCaptureQueuedFrames, Number(message.snapshot?.captureQueuedFrames) || 0);",
    "        state.maxRenderQueuedFrames = Math.max(state.maxRenderQueuedFrames, Number(message.snapshot?.renderQueuedFrames) || 0);",
    "      } else if (message.type === 'error' || message.type === 'device-lost' || message.type === 'stopped') {",
    "        state.status = message.type; state.error = typeof message.message === 'string' ? message.message : message.type;",
    "      }",
    "    };",
    "    node.port.start();",
    "    onSessionPort = (event) => {",
    "      const message = event.data;",
    "      if (event.source !== window || event.origin !== location.origin || message?.type !== " +
      channel +
      " || message.sessionId !== config.sessionId || !(message.port instanceof MessagePort)) return;",
    "      window.removeEventListener('message', onSessionPort);",
    "      node.port.postMessage({ type: 'attach', port: message.port }, [message.port]);",
    "    };",
    "    window.addEventListener('message', onSessionPort);",
    "    await context.resume();",
    "    if (context.sampleRate !== config.request.sampleRateHz) throw new Error('The smoke AudioContext did not honor the requested sample rate');",
    "    state.contextSampleRateHz = context.sampleRate;",
    "    source.start();",
    "    state.status = 'waiting-native';",
    "    state.stop = async () => {",
    "      if (onSessionPort) window.removeEventListener('message', onSessionPort);",
    "      try { source?.stop(); } catch {}",
    "      try { node?.disconnect(); captureDestination?.disconnect(); } catch {}",
    "      for (const track of captureDestination?.stream.getTracks() || []) track.stop();",
    "      if (context && context.state !== 'closed') await context.close();",
    "    };",
    "  };",
    "  void start().catch(fail);",
    "  return { started: true };",
    "})()",
  ].join("\n");
}

function rendererSnapshotScript() {
  return "(() => { const state = window.__kyxWindowsAudioDeviceSmoke; if (!state) return null; const { stop, ...snapshot } = state; return snapshot; })()";
}

async function runWindowsAudioDeviceSmoke({ app, mainWindow, utilityProcess, MessageChannelMain }) {
  const summary = { ok: false, mode: "native-wasapi-plus-worklet", started: false };
  const window = mainWindow;
  let host = null;
  let hostExited = false;
  let hostExitCode = null;
  let sessionId = null;
  let port1 = null;
  let port2 = null;
  let finished = false;
  let guardTimer = null;
  let stageStartedAt = 0;

  const waitForHostExit = (timeoutMs) =>
    new Promise((resolve) => {
      if (!host || hostExited) return resolve(true);
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        host.removeListener("exit", onExit);
        resolve(false);
      }, timeoutMs);
      host.once("exit", onExit);
    });

  const stopHost = async () => {
    if (!host || hostExited) return;
    try {
      host.postMessage({ type: "stop", sessionId });
    } catch {
      /* The utility may already be exiting after a device error. */
    }
    if (!(await waitForHostExit(HOST_STOP_TIMEOUT_MS)) && !hostExited) {
      try {
        host.kill();
      } catch {
        /* Electron may have observed the utility's exit concurrently. */
      }
      await waitForHostExit(HOST_STOP_TIMEOUT_MS);
    }
  };

  const finish = async (error = null) => {
    if (finished) return;
    finished = true;
    if (guardTimer) clearTimeout(guardTimer);
    if (window && !window.isDestroyed()) {
      try {
        await window.webContents.executeJavaScript("window.__kyxWindowsAudioDeviceSmoke?.stop?.() || undefined");
      } catch {
        /* Renderer may have exited during device loss. */
      }
    }
    try {
      port1?.close();
      port2?.close();
    } catch {
      /* Port ownership may already have transferred. */
    }
    await stopHost();
    if (error) summary.error = error instanceof Error ? error.message : String(error);
    summary.utilityExitCode = hostExitCode;
    summary.ok =
      !summary.error &&
      summary.completedDuration === true &&
      summary.ready === true &&
      summary.cleanCounters === true &&
      hostExited &&
      hostExitCode === 0;
    console.log(JSON.stringify(summary, null, 2));
    app.exit(summary.ok ? 0 : 1);
  };

  try {
    const { request, durationMs } = readConfiguration();
    if (!window || window.isDestroyed()) throw new Error("The KYX smoke window is unavailable");
    summary.request = request;
    summary.durationMs = durationMs;
    const startupAt = Date.now();
    sessionId = require("node:crypto").randomUUID();
    await window.webContents.executeJavaScript(rendererSetupScript(sessionId, request));

    const rendererSetupDeadline = Date.now() + 10_000;
    let rendererState = null;
    while (Date.now() < rendererSetupDeadline) {
      rendererState = await window.webContents.executeJavaScript(rendererSnapshotScript());
      if (rendererState?.status === "waiting-native") break;
      if (rendererState?.status === "error") throw new Error(rendererState.error || "Worklet setup failed");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (rendererState?.status !== "waiting-native") throw new Error("Windows audio worklet setup timed out");

    const channel = new MessageChannelMain();
    port1 = channel.port1;
    port2 = channel.port2;
    host = utilityProcess.fork(SESSION_SCRIPT, [], { cwd: __dirname });
    stageStartedAt = Date.now();
    summary.utilityStages = [];
    host.on("message", (message) => {
      if (
        message?.type === "windows-audio-session-stage" &&
        message.sessionId === sessionId &&
        typeof message.stage === "string"
      )
        summary.utilityStages.push({ stage: message.stage, elapsedMs: Date.now() - stageStartedAt });
    });
    host.once("exit", (code) => {
      hostExited = true;
      hostExitCode = code;
    });
    host.postMessage({ type: "start", sessionId, request }, [port1]);
    window.webContents.postMessage(SMOKE_CHANNEL, { sessionId }, [port2]);
    port1 = null;
    port2 = null;

    const readyDeadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < readyDeadline) {
      rendererState = await window.webContents.executeJavaScript(rendererSnapshotScript());
      if (rendererState?.status === "ready") break;
      if (["error", "device-lost", "stopped"].includes(rendererState?.status))
        throw new Error(rendererState.error || "Native audio bridge failed before readiness");
      if (hostExited) throw new Error("Windows audio utility exited before readiness (code " + hostExitCode + ")");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (rendererState?.status !== "ready")
      throw new Error("Native Windows audio did not become ready within 20 seconds");

    summary.started = true;
    summary.ready = true;
    summary.startupMs = Date.now() - startupAt;
    summary.negotiation = rendererState.negotiation;
    const soakStartedAt = Date.now();
    const soakDeadline = soakStartedAt + durationMs;
    while (Date.now() < soakDeadline) {
      await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_MS));
      rendererState = await window.webContents.executeJavaScript(rendererSnapshotScript());
      if (["error", "device-lost", "stopped"].includes(rendererState?.status))
        throw new Error(rendererState.error || "Native audio bridge failed during the soak");
      if (hostExited) throw new Error("Windows audio utility exited during the soak (code " + hostExitCode + ")");
    }
    summary.elapsedMs = Date.now() - soakStartedAt;
    summary.completedDuration = true;
    summary.finalState = rendererState?.snapshot ?? null;
    summary.finalBridge = rendererState?.bridge ?? null;
    summary.statusMessages = rendererState?.statusMessages ?? 0;
    summary.maxCaptureQueuedFrames = rendererState?.maxCaptureQueuedFrames ?? 0;
    summary.maxRenderQueuedFrames = rendererState?.maxRenderQueuedFrames ?? 0;
    const native = summary.finalState || {};
    const bridge = summary.finalBridge || {};
    summary.measurement = {
      workletRenderSequence: bridge.renderSequence ?? null,
      workletRenderDrops: bridge.renderDroppedPeriods ?? null,
      utilityRenderRejectedPackets: bridge.utilityRenderRejectedPackets ?? null,
      nativeRenderUnderruns: native.renderUnderrunPeriods ?? null,
      nativeCaptureOverruns: native.captureOverrunPackets ?? null,
      nativeCaptureDiscontinuities: native.captureDiscontinuities ?? null,
      nativeTimestampErrors: native.captureTimestampErrors ?? null,
      capturePackets: bridge.captureSequence ?? null,
      workletCaptureDrops: bridge.captureDroppedPackets ?? null,
      reportedInputLatencyFrames: summary.negotiation?.reportedInputLatencyFrames ?? null,
      reportedOutputLatencyFrames: summary.negotiation?.reportedOutputLatencyFrames ?? null,
    };
    summary.cleanCounters =
      summary.measurement.workletRenderSequence > 0 &&
      summary.measurement.capturePackets > 0 &&
      summary.measurement.workletRenderDrops === 0 &&
      summary.measurement.utilityRenderRejectedPackets === 0 &&
      summary.measurement.nativeRenderUnderruns === 0 &&
      summary.measurement.nativeCaptureOverruns === 0 &&
      summary.measurement.nativeCaptureDiscontinuities === 0 &&
      summary.measurement.nativeTimestampErrors === 0 &&
      summary.measurement.workletCaptureDrops === 0;
    await finish();
  } catch (error) {
    await finish(error);
  } finally {
    if (!finished) await finish(new Error("Windows audio device smoke exited unexpectedly"));
  }
}

module.exports = { readConfiguration, runWindowsAudioDeviceSmoke };
