/**
 * Runtime-only PCM MessagePort and Windows native-addon probes for
 * `npm run desktop:smoke`. This does not test audible or Volt hardware I/O.
 */
const fs = require("node:fs");
const path = require("node:path");

const PERIOD_FRAMES = 480;
const CHANNELS = 2;
const PERIOD_SAMPLES = PERIOD_FRAMES * CHANNELS;
const MAX_SEQUENCE = 100;

let activePort = null;
let nativeAddon = null;

async function runNativeHostProbe() {
  const addonName = "kyx_windows_audio_host.node";
  const candidates = [
    path.join(__dirname, "..", "native", "windows-audio-host", "build", "Release", addonName),
    process.resourcesPath && path.join(process.resourcesPath, "windows-audio-host", addonName),
  ].filter(Boolean);
  const addonPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!addonPath) throw new Error("Windows audio N-API module is missing; build the desktop package first");

  const addon = require(addonPath);
  nativeAddon = addon;
  if (typeof addon.createSession !== "function")
    throw new Error("Windows audio N-API module has no createSession export");
  const request = {
    inputEndpointId: "KYX-SMOKE-NONEXISTENT-CAPTURE-ENDPOINT",
    outputEndpointId: "KYX-SMOKE-NONEXISTENT-RENDER-ENDPOINT",
    sampleRateHz: 48000,
    periodFrames: 480,
    inputChannelMap: [0],
    outputChannelMap: [0],
    ringCapacityFrames: 4096,
  };
  const session = addon.createSession(request);
  let rejected = false;
  try {
    await session.start();
  } catch {
    rejected = true;
  } finally {
    session.stop();
  }

  const snapshot = session.snapshot();
  if (!rejected || snapshot.state !== "failed" || !snapshot.lastError) {
    throw new Error(`unknown endpoint was not rejected safely (state=${snapshot.state})`);
  }
  return { ok: true, state: snapshot.state, exactEndpointRejected: true, addonLocation: addonPath };
}

void runNativeHostProbe()
  .then((result) => process.parentPort.postMessage({ type: "native-host-probe-result", result }))
  .catch((error) =>
    process.parentPort.postMessage({
      type: "native-host-probe-error",
      message: error instanceof Error ? error.message : String(error),
    }),
  );

function attach(port) {
  if (activePort) {
    port.close();
    return;
  }
  activePort = port;
  let sharedBufferMessageReceived = false;
  port.on("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "shared-buffer-probe-control") {
      process.parentPort.postMessage({ type: "shared-buffer-probe-control-received" });
      port.postMessage({ type: "shared-buffer-probe-control-result" });
      return;
    }
    if (message.type === "shared-buffer-probe-control-check") {
      if (sharedBufferMessageReceived) {
        port.postMessage({
          type: "shared-buffer-probe-error",
          message: "shared-buffer probe response was not observed",
        });
      } else {
        process.parentPort.postMessage({
          type: "shared-buffer-transport-unavailable",
          reason: "renderer SharedArrayBuffer message did not reach the utility process",
        });
        port.postMessage({ type: "shared-buffer-probe-dropped" });
      }
      return;
    }
    if (message.type === "shared-buffer-probe") {
      sharedBufferMessageReceived = true;
      process.parentPort.postMessage({ type: "shared-buffer-probe-received" });
      try {
        if (!(message.samples instanceof SharedArrayBuffer) || !nativeAddon) {
          throw new Error("utility process did not receive a SharedArrayBuffer");
        }
        const samples = new Float32Array(message.samples);
        if (nativeAddon.probeSharedFloat32View(samples) !== samples.length) {
          throw new Error("native probe returned the wrong shared-buffer length");
        }
        port.postMessage({ type: "shared-buffer-probe-result" });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        process.parentPort.postMessage({ type: "shared-buffer-probe-error", message: messageText });
        port.postMessage({ type: "shared-buffer-probe-error", message: messageText });
      }
      return;
    }
    if (message.type === "shared-buffer-probe-verified") {
      process.parentPort.postMessage({ type: "shared-buffer-probe-result", samples: message.samples });
      return;
    }
    if (message.type === "shared-buffer-probe-error") {
      const messageText = message.message || "renderer could not observe the native shared-buffer mutation";
      process.parentPort.postMessage({
        type: "shared-buffer-probe-error",
        message: messageText,
      });
      process.parentPort.postMessage({ type: "probe-error", message: messageText });
      return;
    }
    if (message.type === "probe-result" || message.type === "probe-error") {
      process.parentPort.postMessage(message);
      port.postMessage({ type: "probe-result-ack" });
      return;
    }
    if (message.type !== "capture") return;
    const sequence = message.sequence;
    const samples = message.samples;
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      sequence >= MAX_SEQUENCE ||
      !(samples instanceof ArrayBuffer) ||
      samples.byteLength !== PERIOD_SAMPLES * Float32Array.BYTES_PER_ELEMENT
    ) {
      port.postMessage({ type: "error", message: "invalid or out-of-range PCM period" });
      return;
    }

    const input = new Float32Array(samples);
    const marker = sequence + 1;
    if (input.some((sample) => sample !== marker)) {
      port.postMessage({ type: "error", message: "PCM period data changed in transit" });
      return;
    }
    if (sequence === 0) process.parentPort.postMessage({ type: "first-period-received" });

    const output = new Float32Array(PERIOD_SAMPLES);
    output.fill(marker);
    port.postMessage({ type: "render", sequence, samples: output.buffer });
  });
  port.on("close", () => {
    if (activePort === port) activePort = null;
  });
  port.start();
  port.postMessage({ type: "ready" });
}

process.parentPort.on("message", (event) => {
  const message = event.data;
  if (message?.type === "attach" && event.ports?.length === 1) {
    attach(event.ports[0]);
    process.parentPort.postMessage({ type: "port-attached" });
    return;
  }
  if (message?.type === "shutdown") {
    activePort?.close();
    activePort = null;
    process.parentPort.close();
    process.exit(0);
  }
});
process.parentPort.start();
