import { createServer } from "vite";
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT) || 5224;
const route = "/__windows-audio-worklet-bridge-smoke";
const server = await createServer({
  root,
  logLevel: "error",
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [
    {
      name: "windows-audio-worklet-bridge-smoke-page",
      configureServer(devServer) {
        devServer.middlewares.use(route, (_request, response) => {
          response.statusCode = 200;
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
        });
      },
    },
  ],
  server: { host: "127.0.0.1", port, strictPort: true },
});

let browser;
let exitCode = 0;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}${route}`, { waitUntil: "commit", timeout: 30_000 });
  const result = await page.evaluate(async () => {
    const withTimeout = (promise, ms, message) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), ms);
        Promise.resolve(promise).then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const rms = (samples) => {
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      return Math.sqrt(sum / Math.max(1, samples.length));
    };

    const context = new OfflineAudioContext(2, 480 * 6, 48_000);
    let engine;
    let node;
    let channel;
    let oscillator;
    let inputGain;
    try {
      await context.audioWorklet.addModule("/windows-audio-io-bridge.js");
      const { AudioEngine } = await import("/src/audio-engine/AudioEngine.ts");
      const { createDefaultProject } = await import("/src/project-model/schema.ts");
      engine = new AudioEngine();
      engine.useContext(context);
      // Project sync owns the master-insert bypass edge. Build a valid minimal
      // document and wait for that normal AudioEngine wiring before rendering.
      const project = createDefaultProject();
      project.tracks = [];
      project.returns = [];
      engine.setProject(project);
      await engine.projectPromise;
      // The production live sink is intentionally limited to a live AudioContext.
      // For this offline integration smoke, route the real post-master tap into
      // the same public AudioWorklet node used by the native bridge.
      const masterChain = engine.masterChain;
      const masterInput = masterChain?.input;
      const postMaster = masterChain?.monitorBypassOutputGain;
      if (!masterInput || !postMaster) throw new Error("AudioEngine master graph did not initialize");
      const sessionId = "worklet-bridge-offline-smoke";
      const request = {
        backend: "wasapi-shared",
        inputEndpointId: "synthetic-input",
        outputEndpointId: "synthetic-output",
        sampleRateHz: 48_000,
        periodFrames: 480,
        inputChannelMap: [0, 1],
        outputChannelMap: [0, 1],
        exclusiveAcknowledged: false,
      };
      const negotiation = {
        backend: "wasapi-shared",
        inputEndpointId: request.inputEndpointId,
        outputEndpointId: request.outputEndpointId,
        sampleRateHz: request.sampleRateHz,
        periodFrames: request.periodFrames,
        nativeSampleFormat: "f32le",
        ringSampleFormat: "f32le",
        inputChannelCount: 2,
        outputChannelCount: 2,
        inputChannelMap: [0, 1],
        outputChannelMap: [0, 1],
        inputBufferFrames: 960,
        outputBufferFrames: 960,
        sharedPeriods: { minFrames: 480, maxFrames: 960, fundamentalFrames: 480 },
      };
      node = new AudioWorkletNode(context, "kyx-windows-audio-io-bridge", {
        numberOfInputs: 1,
        numberOfOutputs: 2,
        channelCount: 2,
        channelCountMode: "explicit",
        channelInterpretation: "discrete",
        outputChannelCount: [2, 2],
        processorOptions: { sessionId, periodFrames: 480, captureChannels: 2, poolSize: 6 },
      });
      oscillator = context.createOscillator();
      inputGain = context.createGain();
      oscillator.frequency.value = 440;
      inputGain.gain.value = 0.25;
      oscillator.connect(inputGain).connect(masterInput);
      postMaster.disconnect();
      postMaster.connect(node);
      oscillator.start(0);
      node.connect(context.destination, 0, 0);
      node.connect(context.destination, 1, 0);

      channel = new MessageChannel();
      let bridgeReady = 0;
      let renderPackets = 0;
      let activeRenderPackets = 0;
      let renderRmsMax = 0;
      let captureAcks = 0;
      const bridgeErrors = [];
      const nodeMessages = [];
      let resolveBridgeReady;
      const bridgeReadyPromise = new Promise((resolve) => (resolveBridgeReady = resolve));
      let resolveWorkletReady;
      const workletReadyPromise = new Promise((resolve) => (resolveWorkletReady = resolve));
      node.port.onmessage = (event) => {
        const message = event.data;
        nodeMessages.push(message);
        if (message?.type === "error") bridgeErrors.push(String(message.message || "unknown worklet error"));
        if (message?.type === "ready") resolveWorkletReady();
      };
      let processorError = false;
      node.addEventListener("processorerror", () => {
        processorError = true;
      });
      node.port.start();
      channel.port2.onmessage = (event) => {
        const message = event.data;
        if (!message || typeof message !== "object") return;
        if (message.type === "bridge-ready" && message.sessionId === sessionId) {
          bridgeReady++;
          resolveBridgeReady();
        } else if (message.type === "render" && message.sessionId === sessionId) {
          renderPackets++;
          if (message.samples instanceof ArrayBuffer) {
            const packetRms = rms(new Float32Array(message.samples));
            renderRmsMax = Math.max(renderRmsMax, packetRms);
            if (packetRms > 0.01) activeRenderPackets++;
          }
          channel.port2.postMessage({ type: "recycle-render", sessionId, sequence: message.sequence });
        } else if (message.type === "recycle-capture" && message.sessionId === sessionId) captureAcks++;
        else if (message.type === "error") bridgeErrors.push(String(message.message || "unknown worklet error"));
      };
      channel.port2.start();
      node.port.postMessage({ type: "attach", port: channel.port1 }, [channel.port1]);
      await withTimeout(bridgeReadyPromise, 2_000, "AudioWorklet did not attach the utility port");
      channel.port2.postMessage({
        type: "ready",
        sessionId,
        sampleRateHz: request.sampleRateHz,
        periodFrames: request.periodFrames,
        captureChannels: request.inputChannelMap.length,
        renderChannels: request.outputChannelMap.length,
        negotiation,
      });
      await withTimeout(workletReadyPromise, 2_000, "AudioWorklet did not accept the utility negotiation");
      for (let sequence = 0; sequence < 6; sequence++) {
        const samples = new Float32Array(request.periodFrames * 2);
        for (let frame = 0; frame < request.periodFrames; frame++) {
          const value = 0.25 * Math.sin((2 * Math.PI * 440 * frame) / request.sampleRateHz);
          samples[frame * 2] = value;
          samples[frame * 2 + 1] = value;
        }
        channel.port2.postMessage(
          { type: "capture", sessionId, sequence, frames: request.periodFrames, samples: samples.buffer },
          [samples.buffer],
        );
      }

      const audio = await withTimeout(context.startRendering(), 8_000, "OfflineAudioContext render did not finish");
      await withTimeout(
        (async () => {
          while (renderPackets < 6 || captureAcks < 6) await delay(10);
        })(),
        2_000,
        `AudioWorklet output stalled (render=${renderPackets}, capture-acks=${captureAcks}, errors=${bridgeErrors.join("|")})`,
      );
      channel.port2.postMessage({ type: "status", sessionId, snapshot: {}, bridge: {} });
      await withTimeout(
        (async () => {
          while (!nodeMessages.some((message) => message?.type === "status")) await delay(10);
        })(),
        1_000,
        "Worklet did not return its post-render status",
      );
      await delay(100);
      const report = {
        signalPath: "AudioEngine master → Windows AudioWorklet bridge",
        sampleRateHz: audio.sampleRate,
        bridgeReady,
        renderPackets,
        activeRenderPackets,
        renderRmsMax,
        captureAcks,
        capturedRms: rms(audio.getChannelData(0)),
        bridgeErrors,
        processorError,
        nodeMessages: nodeMessages.slice(-4).map((message) => ({
          type: message?.type,
          bridge: message?.bridge,
          message: message?.message,
        })),
      };
      const finalBridgeStatus = [...nodeMessages].reverse().find((message) => message?.type === "status")?.bridge;
      if (activeRenderPackets < 1 || renderRmsMax < 0.01)
        throw new Error(`Render signal did not reach native packets: ${JSON.stringify(report)}`);
      if (captureAcks !== 6 || report.capturedRms < 0.01)
        throw new Error(`Capture signal did not reach offline audio output: ${JSON.stringify(report)}`);
      if (
        finalBridgeStatus?.renderSequence !== 6 ||
        finalBridgeStatus.renderDroppedPeriods !== 0 ||
        finalBridgeStatus.inFlightRenderPackets !== 0 ||
        finalBridgeStatus.captureDroppedPackets !== 0 ||
        finalBridgeStatus.captureInvalidPackets !== 0
      ) {
        throw new Error(`Bridge pool did not drain cleanly: ${JSON.stringify(finalBridgeStatus)}`);
      }
      return report;
    } finally {
      channel?.port1.close();
      channel?.port2.close();
      try {
        node?.disconnect();
      } catch {
        /* a partially initialized worklet node may already be disconnected */
      }
      try {
        oscillator?.disconnect();
        inputGain?.disconnect();
      } catch {
        /* graph teardown below owns any remaining engine nodes */
      }
      engine?.dispose();
    }
  });
  console.log(`[PASS] Offline AudioWorklet PCM bridge: ${JSON.stringify(result)}`);
} catch (error) {
  console.error("Windows AudioWorklet bridge smoke failed:", error);
  exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
}

process.exitCode = exitCode;
