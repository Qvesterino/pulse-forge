import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const root = process.cwd();
const workletPath = path.join(root, "public", "spectral-worklet.js");
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (request.method !== "GET") {
    response.writeHead(405).end();
  } else if (pathname === "/") {
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end("<!doctype html><html><body></body></html>");
  } else if (pathname === "/spectral-worklet.js") {
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
  if (!address || typeof address === "string") throw new Error("PORTAL browser check did not get a local port");

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "load" });
  const result = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const frames = Math.floor(sampleRate * 1.2);
    const context = new OfflineAudioContext(2, frames, sampleRate);
    await context.audioWorklet.addModule("/spectral-worklet.js");

    let processorError = false;
    const node = new AudioWorkletNode(context, "portal", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: "explicit",
      processorOptions: {
        params: {
          mode: 0,
          time: 80,
          sync: 0,
          feedback: 0.9,
          decay: 0,
          resonance: 0.35,
          focus: 1200,
          focusWidth: 1,
          shift: 0,
          diffuse: 0,
          freeze: 0,
          drive: 0,
          tone: 0,
          mix: 1,
        },
      },
    });
    node.onprocessorerror = () => {
      processorError = true;
    };
    const mix = node.parameters.get("mix");
    if (!mix) throw new Error("PORTAL AudioParam 'mix' is missing");
    mix.setValueAtTime(0, 0.4);
    mix.setValueAtTime(1, 0.7);

    const buffer = context.createBuffer(2, frames, sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (let i = 0; i < Math.floor(sampleRate * 0.22); i++) {
      const sample =
        0.5 * Math.sin((2 * Math.PI * 220 * i) / sampleRate) + 0.25 * Math.sin((2 * Math.PI * 660 * i) / sampleRate);
      left[i] = sample;
      right[i] = sample;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(node);
    node.connect(context.destination);
    source.start(0);
    const rendered = await context.startRendering();
    const output = rendered.getChannelData(0);
    let finite = true;
    let preCloseEnergy = 0;
    let preCloseSamples = 0;
    let reopenedEnergy = 0;
    let reopenedSamples = 0;
    for (let i = 0; i < output.length; i++) {
      const value = output[i]!;
      finite &&= Number.isFinite(value);
      if (i >= Math.floor(sampleRate * 0.3) && i < Math.floor(sampleRate * 0.4)) {
        preCloseEnergy += value * value;
        preCloseSamples++;
      }
      if (i >= Math.floor(sampleRate * 0.85) && i < Math.floor(sampleRate * 1.1)) {
        reopenedEnergy += value * value;
        reopenedSamples++;
      }
    }
    return {
      browser: navigator.userAgent,
      processorError,
      finite,
      preCloseTailRms: Math.sqrt(preCloseEnergy / Math.max(1, preCloseSamples)),
      reopenedTailRms: Math.sqrt(reopenedEnergy / Math.max(1, reopenedSamples)),
    };
  });

  console.log(
    JSON.stringify({ check: "PORTAL shipped AudioWorklet — MIX close clears frozen tail", ...result }, null, 2),
  );
  if (result.processorError || !result.finite || !(result.preCloseTailRms > 1e-4) || !(result.reopenedTailRms < 1e-4)) {
    throw new Error(
      `MIX close did not clear the frozen wet tail (finite=${result.finite}, ` +
        `before=${result.preCloseTailRms}, after=${result.reopenedTailRms})`,
    );
  }
} finally {
  console.log("[portal-browser] closing chromium");
  await browser?.close();
  console.log("[portal-browser] chromium closed");
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  console.log("[portal-browser] server closed");
}
