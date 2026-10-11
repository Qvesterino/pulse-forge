/**
 * Browser-engine CPU probe for REZONANS' DSP core.
 *
 * Run with `npm run benchmark:rezonans:browser`. Chromium's
 * AudioWorkletGlobalScope has no high-resolution wall clock, so this measures
 * the DSP core in Chromium's main JavaScript runtime, not on the audio thread.
 */
import { build } from "esbuild";
import { cpus, arch, platform } from "node:os";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSET_NAME = `rezonans-browser-benchmark-${process.pid}.js`;
const ASSET_PATH = path.join(ROOT, "public", ASSET_NAME);
const fixturePath = path.join(ROOT, "tests", "fixtures", "rezonans-cc0-female-speech.wav");
const WARMUP_SECONDS = 2;
const MEASURE_SECONDS = 2;
const server = createHttpServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (request.method !== "GET") {
    response.writeHead(405).end();
  } else if (pathname === "/") {
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end("<!doctype html><html><body></body></html>");
  } else if (pathname === `/${ASSET_NAME}`) {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(await readFile(ASSET_PATH));
  } else if (pathname === "/rezonans-fixture.wav") {
    response.writeHead(200, { "content-type": "audio/wav" }).end(await readFile(fixturePath));
  } else {
    response.writeHead(404).end();
  }
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

try {
  await build({
    entryPoints: [path.join(ROOT, "scripts", "benchmark-rezonans-browser.entry.js")],
    bundle: true,
    format: "iife",
    target: "es2022",
    outfile: ASSET_PATH,
    globalName: "RezonansBenchmark",
    minify: true,
    logLevel: "warning",
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Benchmark server did not expose its listening port");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(
    async ({ assetName, warmupSeconds, measureSeconds }) => {
      const ctx = new AudioContext({ sampleRate: 48000 });
      if (ctx.sampleRate !== 48000) throw new Error(`Expected 48 kHz browser context, got ${ctx.sampleRate}`);
      const fixtureResponse = await fetch("/rezonans-fixture.wav");
      if (!fixtureResponse.ok) throw new Error(`Could not load REZONANS fixture (${fixtureResponse.status})`);
      const buffer = await ctx.decodeAudioData(await fixtureResponse.arrayBuffer());
      const source = buffer.getChannelData(0);
      let fixturePeak = 0;
      for (let i = 0; i < source.length; i++) fixturePeak = Math.max(fixturePeak, Math.abs(source[i]));
      if (fixturePeak < 0.001) throw new Error("Decoded REZONANS fixture is silent");
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = `/${assetName}`;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Could not load bundled REZONANS benchmark"));
        document.head.append(script);
      });
      const benchmark = (
        window as Window & {
          RezonansBenchmark?: {
            benchmarkRezonansBrowser: (
              source: Float32Array,
              sampleRate: number,
              warmupSeconds: number,
              measureSeconds: number,
              harmonyVoices: number,
            ) => Record<string, unknown>;
          };
        }
      ).RezonansBenchmark;
      if (!benchmark) throw new Error("The bundled REZONANS benchmark did not register");
      const profiles = [1, 2, 3, 4].map((harmonyVoices) =>
        benchmark.benchmarkRezonansBrowser(source, ctx.sampleRate, warmupSeconds, measureSeconds, harmonyVoices),
      );
      const browserContext = { sampleRate: ctx.sampleRate, baseLatency: ctx.baseLatency };
      await ctx.close();
      const decodedFixture = { sampleRate: buffer.sampleRate, frames: buffer.length, peak: fixturePeak };
      return { profiles, browserContext, decodedFixture };
    },
    { assetName: ASSET_NAME, warmupSeconds: WARMUP_SECONDS, measureSeconds: MEASURE_SECONDS },
  );

  const report = {
    benchmark: "REZONANS Chromium DSP-core timing (main thread)",
    date: new Date().toISOString(),
    browser: `Chromium ${browser.version()}`,
    runtime: process.version,
    platform: `${platform()} ${arch()}`,
    cpu: cpus()[0]?.model ?? "unknown",
    logicalCores: cpus().length,
    browserContext: result.browserContext,
    decodedFixture: result.decodedFixture,
    fixture: "tests/fixtures/rezonans-cc0-female-speech.wav",
    warmupSeconds: WARMUP_SECONDS,
    measuredSecondsPerRepeat: MEASURE_SECONDS,
    profiles: result.profiles,
    caveat:
      "This times the production DSP core in Chromium's main JavaScript runtime. It does not measure AudioWorklet scheduling or certify realtime deadlines; the project browser checks separately exercise the live worklet path.",
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(ASSET_PATH, { force: true });
}
