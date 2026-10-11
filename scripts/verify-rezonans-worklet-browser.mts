import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const root = process.cwd();
const workletPath = path.join(root, "public", "rezonans-worklet.js");
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (request.method !== "GET") {
    response.writeHead(405).end();
  } else if (pathname === "/") {
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end("<!doctype html><html><body></body></html>");
  } else if (pathname === "/rezonans-worklet.js") {
    response
      .writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" })
      .end(await readFile(workletPath));
  } else {
    response.writeHead(404).end();
  }
});

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("REZONANS browser check did not get a local port");

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "load" });
  const result = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const frames = sampleRate * 2;
    const context = new OfflineAudioContext(2, frames, sampleRate);
    await context.audioWorklet.addModule("/rezonans-worklet.js");

    let latencySamples: number | null = null;
    let processorError = false;
    let resolveLatency: (() => void) | undefined;
    const latencyReported = new Promise<void>((resolve) => {
      resolveLatency = resolve;
    });
    const node = new AudioWorkletNode(context, "rezonans-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: "explicit",
      processorOptions: {
        bpm: 120,
        harmonyContext: { keyRootPc: 0, scaleMask: 0b101010110101, chords: [] },
        params: {
          quality: 2,
          mix: 1,
          "harmony.mode": 2,
          "harmony.voices": 4,
          "detect.clarity": 0.45,
          "voice0.enabled": 1,
          "voice1.enabled": 1,
          "voice2.enabled": 1,
          "voice3.enabled": 1,
          "voice0.level": 0.35,
          "voice1.level": 0.35,
          "voice2.level": 0.35,
          "voice3.level": 0.35,
        },
      },
    });
    node.port.onmessage = (event: MessageEvent<{ type?: string; samples?: number }>) => {
      if (event.data?.type === "latency" && Number.isInteger(event.data.samples)) {
        latencySamples = event.data.samples ?? null;
        resolveLatency?.();
      }
    };
    node.onprocessorerror = () => {
      processorError = true;
    };

    const oscillator = context.createOscillator();
    oscillator.frequency.value = 220;
    const inputGain = context.createGain();
    inputGain.gain.value = 0.12;
    oscillator.connect(inputGain).connect(node);
    node.connect(context.destination);
    oscillator.start(0);

    const rendered = await context.startRendering();
    await Promise.race([latencyReported, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);

    const left = rendered.getChannelData(0);
    const right = rendered.getChannelData(1);
    let peak = 0;
    let sumSquares = 0;
    let finite = true;
    for (let i = 0; i < frames; i++) {
      const l = left[i]!;
      const r = right[i]!;
      if (!Number.isFinite(l) || !Number.isFinite(r)) finite = false;
      peak = Math.max(peak, Math.abs(l), Math.abs(r));
      sumSquares += l * l + r * r;
    }

    return {
      browser: navigator.userAgent,
      sampleRate,
      frames,
      processorError,
      latencySamples,
      expectedLatencySamples: 4_095,
      peak,
      rms: Math.sqrt(sumSquares / (frames * 2)),
      finite,
    };
  });

  console.log(JSON.stringify({ check: "REZONANS shipped AudioWorklet", ...result }, null, 2));
  if (result.processorError) throw new Error("REZONANS AudioWorklet reported processorerror");
  if (result.latencySamples !== result.expectedLatencySamples) {
    throw new Error(
      `REZONANS reported ${result.latencySamples} latency samples, expected ${result.expectedLatencySamples}`,
    );
  }
  if (!result.finite || !(result.rms > 1e-5) || !(result.peak < 1)) {
    throw new Error(`REZONANS output failed finite/audible/headroom checks (rms=${result.rms}, peak=${result.peak})`);
  }
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
