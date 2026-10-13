import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cpus, arch, platform } from "node:os";
import { access, readFile, rename, rm, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, relative, sep, isAbsolute } from "node:path";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  MASTERING_RANKER_MEMORY_SAMPLE_EVERY,
  MASTERING_RANKER_MEMORY_MEASUREMENT_METHOD,
  MASTERING_RANKER_RUNTIME_MEASUREMENT_METHOD,
  masteringRankerMemorySampleEvery,
  parseMasteringRankerBlindDataset,
} from "../src/mastering/evaluation";
import { MASTERING_FEATURE_VERSION } from "../src/mastering/intelligence";
import { isMasteringRankerManifest } from "../src/mastering/ranker-types";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_DATASET_BYTES = 32 * 1024 * 1024;
const MAX_MODEL_BYTES = 16 * 1024 * 1024;
const MAX_WASM_BYTES = 32 * 1024 * 1024;
const execFileAsync = promisify(execFile);

type CliOptions = {
  dataset: string;
  model: string;
  manifest: string;
  out: string;
  runtimeOut: string;
  overwrite: boolean;
};

function usage(): string {
  return [
    "Usage: npm run mastering-ranker:predict:browser -- --dataset <held-out.json> --model <candidate.onnx> --manifest <candidate-manifest.json> --out <predictions.json> --runtime-out <runtime-measurement.json>",
    "Runs the production mastering-ranker worker locally in headless Chromium with ONNX Runtime Web/WASM and a Windows process-tree private-memory sampler. Writes only after all hashes and measurements validate.",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  let overwrite = false;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token === "--overwrite") {
      overwrite = true;
      continue;
    }
    if (token === "--help") throw new Error(usage());
    if (!token.startsWith("--") || values.has(token)) throw new Error(usage());
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(usage());
    values.set(token, value);
    index++;
  }
  const required = ["--dataset", "--model", "--manifest", "--out", "--runtime-out"] as const;
  if (required.some((key) => !values.has(key))) throw new Error(usage());
  const out = resolve(values.get("--out")!);
  const runtimeOut = resolve(values.get("--runtime-out")!);
  if (out === runtimeOut) throw new Error("Prediction and runtime measurement outputs must be different files.");
  return {
    dataset: resolve(values.get("--dataset")!),
    model: resolve(values.get("--model")!),
    manifest: resolve(values.get("--manifest")!),
    out,
    runtimeOut,
    overwrite,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readBrowserProcessTreePrivateBytes(rootPid: number): Promise<number> {
  if (platform() !== "win32") throw new Error("The process-tree memory sampler currently supports Windows only.");
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) throw new Error("Chromium process ID is invalid.");
  const script = `
$rootPid = ${rootPid}
$all = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
$ids = [System.Collections.Generic.HashSet[int]]::new()
[void]$ids.Add($rootPid)
$added = $true
while ($added) {
  $added = $false
  foreach ($candidate in $all) {
    if ($ids.Contains([int]$candidate.ParentProcessId) -and $ids.Add([int]$candidate.ProcessId)) { $added = $true }
  }
}
$sum = 0L
foreach ($item in $all) {
  if ($ids.Contains([int]$item.ProcessId)) {
    try {
      $process = Get-Process -Id ([int]$item.ProcessId) -ErrorAction Stop
      $process.Refresh()
      $sum += [long]$process.PrivateMemorySize64
    } catch { }
  }
}
if ($sum -le 0) { throw "Chromium process tree returned no private-memory sample." }
[Console]::Out.WriteLine([string]$sum)
`;
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  const bytes = Number(stdout.trim());
  if (!Number.isFinite(bytes) || bytes <= 0)
    throw new Error("Windows returned an invalid Chromium private-memory sample.");
  return bytes;
}

function isUnderPublic(path: string): boolean {
  const publicPath = resolve(ROOT, "public");
  const fromPublic = relative(publicPath, path);
  return (
    fromPublic === "" ||
    (!isAbsolute(fromPublic) &&
      fromPublic !== ".." &&
      !fromPublic.startsWith(`..${sep}`) &&
      !fromPublic.startsWith(sep))
  );
}

async function readBounded(path: string, limit: number, label: string): Promise<Uint8Array> {
  const bytes = new Uint8Array(await readFile(path));
  if (bytes.byteLength === 0 || bytes.byteLength > limit) {
    throw new Error(`${label} must be between 1 byte and ${limit} bytes.`);
  }
  return bytes;
}

async function parseJsonFile(
  path: string,
  limit: number,
  label: string,
): Promise<{ value: unknown; bytes: Uint8Array }> {
  const bytes = await readBounded(path, limit, label);
  try {
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown, bytes };
  } catch {
    throw new Error(`${label} is not valid UTF-8 JSON.`);
  }
}

const browserRunnerSource = `
declare global {
  interface Window {
    kyxPredictMasteringRanker?: (payload: { pairCount: number; manifest: unknown }) => Promise<{
      pairs: Array<{ pairId: string; modelOrder: [string, string]; deterministicOrder: [string, string] }>;
      p95InferenceMs: number;
      inferenceCount: number;
    }>;
  }
}

window.kyxPredictMasteringRanker = async ({ pairCount, manifest }) => {
  const memorySampleEveryPairs = Math.max(${MASTERING_RANKER_MEMORY_SAMPLE_EVERY}, Math.ceil(pairCount / 100));
  const markMemorySample = async (): Promise<void> => {
    const response = await fetch("/memory-sample", { method: "POST", cache: "no-store" });
    if (!response.ok) throw new Error("Windows process-tree memory sample failed.");
  };
  const datasetResponse = await fetch("/dataset.json", { cache: "no-store" });
  if (!datasetResponse.ok) throw new Error("Local held-out dataset is unavailable.");
  const dataset = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await datasetResponse.arrayBuffer()));
  await markMemorySample();
  if (dataset.schema !== "kyx.mastering-ranker-blind-set" || dataset.schemaVersion !== 3 ||
      dataset.split !== "held-out-blind" || !Array.isArray(dataset.pairs) || dataset.pairs.length !== pairCount) {
    throw new Error("Held-out dataset shape changed before browser inference.");
  }
  const worker = new Worker("/ranker-worker.js");
  let requestId = 0;
  const request = (message: Record<string, unknown>): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const validRequestId = ++requestId;
    const timer = setTimeout(() => finish(new Error("Ranker worker request timed out.")), 30000);
    const finish = (error: Error | null, value?: Record<string, unknown>) => {
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve(value!);
    };
    const onMessage = (event: MessageEvent) => {
      const response = event.data as Record<string, unknown> | null;
      if (!response || response.requestId !== validRequestId) return;
      if (response.type !== message.type || response.ok !== true) {
        finish(new Error(typeof response.error === "string" ? response.error : "Ranker worker response invalid."));
      } else finish(null, response);
    };
    const onError = () => finish(new Error("Ranker worker failed."));
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage({ ...message, requestId: validRequestId });
  });
  try {
    const loadResult = await request({ type: "load", manifest });
    if (loadResult.ok !== true) throw new Error("Candidate ranker did not load.");
    const flatFeatures = (pair: any): Float32Array => {
      if (!Array.isArray(pair.candidates) || pair.candidates.length !== 2) throw new Error("Invalid held-out candidate pair.");
      const values = pair.candidates.flatMap((candidate: any) => candidate.features);
      if (values.length !== 102 || values.some((value: any) => !Number.isFinite(value) || value < -1 || value > 1)) {
        throw new Error("Invalid held-out feature vector.");
      }
      return Float32Array.from(values);
    };
    const runScores = async (pair: any): Promise<number[]> => {
      const features = flatFeatures(pair);
      const result = await request({ type: "score", batch: features, candidateCount: 2 });
      if (!Array.isArray(result.scores) || result.scores.length !== 2 ||
          result.scores.some((score) => typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1)) {
        throw new Error("Ranker worker returned an invalid pair score shape.");
      }
      return result.scores as number[];
    };
    const firstPair = dataset.pairs[0];
    if (!firstPair) throw new Error("Held-out dataset has no pairs.");
    for (let index = 0; index < 20; index++) await runScores(firstPair);
    await markMemorySample();

    const pairs: Array<{ pairId: string; modelOrder: [string, string]; deterministicOrder: [string, string] }> = [];
    const timings: number[] = [];
    for (let index = 0; index < dataset.pairs.length; index++) {
      const pair = dataset.pairs[index];
      if (!pair || typeof pair.pairId !== "string") throw new Error("Invalid held-out pair ID.");
      const started = performance.now();
      const scores = await runScores(pair);
      timings.push(Math.max(0, performance.now() - started));
      const candidateIds = pair.candidates.map((candidate: any) => candidate.id);
      if (typeof candidateIds[0] !== "string" || typeof candidateIds[1] !== "string") {
        throw new Error("Invalid held-out candidate ID.");
      }
      const modelOrder: [string, string] = scores[1]! > scores[0]!
        ? [candidateIds[1], candidateIds[0]]
        : [candidateIds[0], candidateIds[1]];
      pairs.push({
        pairId: pair.pairId,
        modelOrder,
        deterministicOrder: [candidateIds[0], candidateIds[1]],
      });
      if ((index + 1) % memorySampleEveryPairs === 0 || index + 1 === dataset.pairs.length) {
        await markMemorySample();
      }
    }
    return {
      pairs,
      p95InferenceMs: Math.max(0.0001, timings.sort((left, right) => left - right)[Math.max(0, Math.ceil(timings.length * 0.95) - 1)]!),
      inferenceCount: timings.length,
    };
  } finally {
    try { await request({ type: "dispose" }); } catch { /* worker may already be unavailable */ }
    worker.terminate();
  }
};
`;

async function main(): Promise<void> {
  if (platform() !== "win32")
    throw new Error(
      "Browser ranker runtime evaluation currently requires Windows for process-tree memory measurement.",
    );
  if (process.argv.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  if (isUnderPublic(options.out) || isUnderPublic(options.runtimeOut)) {
    throw new Error("Prediction and runtime artifacts must stay outside public/.");
  }
  if (
    [options.dataset, options.model, options.manifest].includes(options.out) ||
    [options.dataset, options.model, options.manifest].includes(options.runtimeOut)
  ) {
    throw new Error("Output paths must not overwrite the held-out dataset, candidate model, or candidate manifest.");
  }
  if (!options.overwrite) {
    for (const path of [options.out, options.runtimeOut]) {
      try {
        await access(path);
        throw new Error(`Output already exists: ${path}. Choose another path or pass --overwrite.`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Output already exists:")) throw error;
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  }

  const [datasetFile, manifestFile, modelBytes, wasmBytes, runtimePackageFile, benchmarkScriptBytes] =
    await Promise.all([
      parseJsonFile(options.dataset, MAX_DATASET_BYTES, "Held-out dataset"),
      parseJsonFile(options.manifest, 1024 * 1024, "Candidate manifest"),
      readBounded(options.model, MAX_MODEL_BYTES, "Candidate model"),
      readBounded(
        resolve(ROOT, "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm"),
        MAX_WASM_BYTES,
        "ONNX Runtime WebAssembly asset",
      ),
      parseJsonFile(
        resolve(ROOT, "node_modules/onnxruntime-web/package.json"),
        1024 * 1024,
        "ONNX Runtime package manifest",
      ),
      readFile(fileURLToPath(import.meta.url)).then((bytes) => new Uint8Array(bytes)),
    ]);
  if (
    !runtimePackageFile.value ||
    typeof runtimePackageFile.value !== "object" ||
    Array.isArray(runtimePackageFile.value)
  )
    throw new Error("ONNX Runtime package manifest is invalid.");
  const onnxRuntimeVersion = (runtimePackageFile.value as Record<string, unknown>).version;
  if (typeof onnxRuntimeVersion !== "string" || onnxRuntimeVersion.length === 0 || onnxRuntimeVersion.length > 128)
    throw new Error("ONNX Runtime package version is invalid.");
  const dataset = parseMasteringRankerBlindDataset(datasetFile.value);
  if (dataset.split !== "held-out-blind")
    throw new Error("Browser predictions are allowed only for held-out-blind data.");
  const candidateManifest = manifestFile.value;
  if (
    !isMasteringRankerManifest(candidateManifest) ||
    candidateManifest.evaluation !== null ||
    candidateManifest.featureVersion !== MASTERING_FEATURE_VERSION
  ) {
    throw new Error("Candidate manifest must be valid, unevaluated, and use the current mastering feature version.");
  }
  const modelHash = sha256(modelBytes);
  const datasetHash = sha256(datasetFile.bytes);
  const benchmarkScriptHash = sha256(benchmarkScriptBytes);
  const onnxRuntimeWasmHash = sha256(wasmBytes);
  if (modelHash !== candidateManifest.modelHash)
    throw new Error("Candidate model SHA-256 does not match its manifest.");
  if (dataset.pairs.length < 1) throw new Error("Held-out dataset is empty.");

  const bundledWorker = await build({
    entryPoints: [resolve(ROOT, "src/mastering/mastering-ranker-worker.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    minify: true,
    logLevel: "silent",
  });
  const workerBytes = bundledWorker.outputFiles[0]?.contents;
  if (!workerBytes || workerBytes.byteLength === 0 || workerBytes.byteLength > 16 * 1024 * 1024) {
    throw new Error("Could not bundle the production mastering-ranker worker.");
  }
  const rankerWorkerBundleHash = sha256(workerBytes);

  const bundledRunner = await build({
    stdin: {
      contents: browserRunnerSource,
      resolveDir: ROOT,
      sourcefile: "mastering-ranker-browser-runner.ts",
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    target: "es2022",
    write: false,
    minify: true,
    logLevel: "silent",
  });
  const runnerBytes = bundledRunner.outputFiles[0]?.contents;
  if (!runnerBytes || runnerBytes.byteLength === 0 || runnerBytes.byteLength > 16 * 1024 * 1024) {
    throw new Error("Could not bundle the local mastering-ranker browser harness.");
  }

  const processMemorySamples: number[] = [];
  let browserRootPid: number | null = null;
  let memorySampleError: string | null = null;
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Cache-Control", "no-store");
    if (pathname === "/memory-sample" && request.method === "POST") {
      try {
        if (browserRootPid === null) throw new Error("Chromium process has not started.");
        processMemorySamples.push(await readBrowserProcessTreePrivateBytes(browserRootPid));
        response.writeHead(204).end();
      } catch (error) {
        memorySampleError = error instanceof Error ? error.message : String(error);
        response.writeHead(503).end("memory sample unavailable");
      }
    } else if (request.method !== "GET") {
      response.writeHead(405).end();
    } else if (pathname === "/") {
      response
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    } else if (pathname === "/runner.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(runnerBytes);
    } else if (pathname === "/ranker-worker.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(workerBytes);
    } else if (pathname === candidateManifest.modelPath) {
      response.writeHead(200, { "content-type": "application/octet-stream" }).end(modelBytes);
    } else if (pathname === "/dataset.json") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(datasetFile.bytes);
    } else if (pathname === "/models/ort/ort-wasm-simd-threaded.wasm") {
      response.writeHead(200, { "content-type": "application/wasm" }).end(wasmBytes);
    } else {
      response.writeHead(404).end();
    }
  });

  let browserServer: Awaited<ReturnType<typeof chromium.launchServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.connect>> | undefined;
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Local browser server did not expose its port.");
    browserServer = await chromium.launchServer({ headless: true });
    browserRootPid = browserServer.process().pid ?? null;
    if (browserRootPid === null) throw new Error("Could not identify the local Chromium process.");
    browser = await chromium.connect(browserServer.wsEndpoint());
    const page = await browser.newPage();
    page.on("pageerror", (error) => process.stderr.write(`[mastering-ranker:browser] ${error.message}\n`));
    await page.goto(`http://127.0.0.1:${address.port}`, { waitUntil: "domcontentloaded" });
    const baselineBytes = await readBrowserProcessTreePrivateBytes(browserRootPid);
    processMemorySamples.push(baselineBytes);
    await page.addScriptTag({ url: `http://127.0.0.1:${address.port}/runner.js` });
    const result = (await page.evaluate(
      async ({ pairCount, manifest }) => {
        const runner = (
          window as Window & {
            kyxPredictMasteringRanker?: (payload: { pairCount: number; manifest: unknown }) => Promise<unknown>;
          }
        ).kyxPredictMasteringRanker;
        if (typeof runner !== "function") throw new Error("Local browser inference runner did not initialize.");
        return await runner({ pairCount, manifest });
      },
      { pairCount: dataset.pairs.length, manifest: candidateManifest },
    )) as {
      pairs: Array<{ pairId: string; modelOrder: [string, string]; deterministicOrder: [string, string] }>;
      p95InferenceMs: number;
      inferenceCount: number;
    };

    if (
      result.pairs.length !== dataset.pairs.length ||
      !Number.isFinite(result.p95InferenceMs) ||
      result.p95InferenceMs < 0 ||
      result.inferenceCount !== dataset.pairs.length
    ) {
      throw new Error("Chromium returned incomplete prediction or runtime measurements; no output was written.");
    }
    if (memorySampleError) throw new Error(`Windows process-tree memory sampling failed: ${memorySampleError}`);
    processMemorySamples.push(await readBrowserProcessTreePrivateBytes(browserRootPid));
    const maxPrivateBytes = Math.max(...processMemorySamples);
    const memoryDeltaBytes = maxPrivateBytes - baselineBytes;
    if (memoryDeltaBytes <= 0)
      throw new Error("Chromium private-memory peak did not exceed its baseline; no output was written.");
    const peakMemoryMiB = memoryDeltaBytes / (1024 * 1024);
    const memoryBaselineMiB = baselineBytes / (1024 * 1024);
    const memorySampleCount = processMemorySamples.length;
    const memorySampleEveryPairs = masteringRankerMemorySampleEvery(dataset.pairs.length);
    const minimumMemorySampleCount = Math.ceil(dataset.pairs.length / memorySampleEveryPairs) + 4;
    if (memorySampleCount < minimumMemorySampleCount)
      throw new Error("Windows process-tree memory sampling returned too few samples; no output was written.");

    const predictions = {
      schema: "kyx.mastering-ranker-predictions",
      schemaVersion: 1,
      featureVersion: MASTERING_FEATURE_VERSION,
      modelHash,
      p95InferenceMs: result.p95InferenceMs,
      peakMemoryMiB,
      pairs: result.pairs,
    };
    const runtimeMeasurement = {
      schema: "kyx.mastering-ranker-runtime-measurement",
      schemaVersion: 2,
      modelHash,
      datasetHash,
      browser: "Chromium",
      browserVersion: browser.version(),
      platform: platform(),
      architecture: arch(),
      cpu: cpus()[0]?.model ?? "unknown",
      measurementMethod: MASTERING_RANKER_RUNTIME_MEASUREMENT_METHOD,
      memoryMeasurementMethod: MASTERING_RANKER_MEMORY_MEASUREMENT_METHOD,
      benchmarkScriptHash,
      rankerWorkerBundleHash,
      onnxRuntimeVersion,
      onnxRuntimeWasmHash,
      pairCount: result.pairs.length,
      inferenceCount: result.inferenceCount,
      memorySampleCount,
      memorySampleEveryPairs,
      memoryBaselineMiB,
      p95InferenceMs: result.p95InferenceMs,
      peakMemoryMiB,
    };
    const predictionsText = `${JSON.stringify(predictions, null, 2)}\n`;
    const runtimeText = `${JSON.stringify(runtimeMeasurement, null, 2)}\n`;
    await mkdir(dirname(options.out), { recursive: true });
    await mkdir(dirname(options.runtimeOut), { recursive: true });
    const predictionsTemp = `${options.out}.${process.pid}.tmp`;
    const runtimeTemp = `${options.runtimeOut}.${process.pid}.tmp`;
    try {
      await Promise.all([
        writeFile(predictionsTemp, predictionsText, { flag: "wx" }),
        writeFile(runtimeTemp, runtimeText, { flag: "wx" }),
      ]);
      await rename(predictionsTemp, options.out);
      await rename(runtimeTemp, options.runtimeOut);
    } catch (error) {
      await Promise.all([rm(predictionsTemp, { force: true }), rm(runtimeTemp, { force: true })]);
      throw error;
    }
    process.stdout.write(
      `${JSON.stringify({ predictions: options.out, runtimeMeasurement: options.runtimeOut, modelHash, datasetHash, pairCount: dataset.pairs.length, p95InferenceMs: result.p95InferenceMs, peakPrivateMemoryDeltaMiB: peakMemoryMiB, privateMemoryBaselineMiB: memoryBaselineMiB, memorySampleCount, browser: `Chromium ${browser.version()}` }, null, 2)}\n`,
    );
  } finally {
    await browser?.close();
    await browserServer?.close();
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
