/**
 * Benchmark a packaged Windows MRT2 companion without booting KYX.
 *
 * The script deliberately speaks the same framed protocol as Electron. It is
 * useful for the inference spike and must not be treated as proof of support
 * until the printed gate values pass on representative hardware.
 *
 * Required environment:
 *   KYX_MRT2_WINDOWS_HOST       fixed companion executable
 *   KYX_MRT2_WINDOWS_MODEL_ROOT model root passed to --model-root
 * Optional:
 *   KYX_MRT2_BENCHMARK_SECONDS  default 10
 *   KYX_MRT2_BENCHMARK_MODE     capture (default) or live
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const HOST_PATH = process.env.KYX_MRT2_WINDOWS_HOST;
const MODEL_ROOT = process.env.KYX_MRT2_WINDOWS_MODEL_ROOT;
const DURATION_SECONDS = Number(process.env.KYX_MRT2_BENCHMARK_SECONDS ?? 10);
const BENCHMARK_MODE = process.env.KYX_MRT2_BENCHMARK_MODE ?? "capture";
const REPORT_PATH = process.env.KYX_MRT2_BENCHMARK_REPORT;
const FRAME_HEADER_BYTES = 32;
const MAX_FRAME_BYTES = 5_760_288;
const MAX_BENCHMARK_SECONDS = BENCHMARK_MODE === "live" ? 600 : 120;

if (!HOST_PATH || !MODEL_ROOT) {
  throw new Error("Set KYX_MRT2_WINDOWS_HOST and KYX_MRT2_WINDOWS_MODEL_ROOT before running this benchmark");
}
if (!Number.isFinite(DURATION_SECONDS) || DURATION_SECONDS < 1 || DURATION_SECONDS > MAX_BENCHMARK_SECONDS) {
  throw new Error(`KYX_MRT2_BENCHMARK_SECONDS must be between 1 and ${MAX_BENCHMARK_SECONDS}`);
}
if (BENCHMARK_MODE !== "capture" && BENCHMARK_MODE !== "live") {
  throw new Error("KYX_MRT2_BENCHMARK_MODE must be capture or live");
}
if (REPORT_PATH && (REPORT_PATH.length > 4096 || REPORT_PATH.includes("\0"))) {
  throw new Error("KYX_MRT2_BENCHMARK_REPORT must be a bounded filesystem path");
}

const child = spawn(HOST_PATH, ["--model-root", MODEL_ROOT], {
  shell: false,
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
  cwd: MODEL_ROOT,
});

let stdoutBuffer = Buffer.alloc(0);
let startupReady = false;
let exitError = null;
const controls = [];
const audioPackets = [];
const statusEvents = [];
const waiters = [];
let previousSequence = null;
let sequenceGapCount = 0;
let underrunCount = 0;

function fail(error) {
  const reason = error instanceof Error ? error : new Error(String(error));
  exitError ??= reason;
  for (const waiter of waiters.splice(0)) waiter.reject(reason);
}

function requestId(prefix) {
  return `${prefix}-${randomUUID()}`;
}

function encodeFrame(type, transportId, payload = Buffer.alloc(0)) {
  const id = Buffer.from(transportId, "utf8");
  const bodyLength = 3 + id.byteLength + payload.byteLength;
  if (bodyLength > MAX_FRAME_BYTES) throw new Error("benchmark frame is too large");
  const frame = Buffer.allocUnsafe(4 + bodyLength);
  frame.writeUInt32BE(bodyLength, 0);
  frame.writeUInt8(type, 4);
  frame.writeUInt16BE(id.byteLength, 5);
  id.copy(frame, 7);
  payload.copy(frame, 7 + id.byteLength);
  return frame;
}

function sendControl(transportId, message) {
  child.stdin.write(encodeFrame(0, transportId, Buffer.from(JSON.stringify(message), "utf8")));
}

function waitFor(predicate, timeoutMs = 15_000) {
  if (exitError) return Promise.reject(exitError);
  const existing = controls.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = waiters.findIndex((candidate) => candidate.resolve === resolve);
      if (index >= 0) waiters.splice(index, 1);
      reject(new Error("Timed out waiting for MRT2 companion response"));
    }, timeoutMs);
    waiters.push({
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
      predicate,
    });
  });
}

function deliverControl(message) {
  controls.push(message);
  if (message?.type === "status") {
    statusEvents.push({ state: message.state, receivedAt: performance.now() });
    if (message.state === "buffering") underrunCount++;
  }
  for (let index = waiters.length - 1; index >= 0; index--) {
    const waiter = waiters[index];
    if (!waiter.predicate(message)) continue;
    waiters.splice(index, 1);
    waiter.resolve(message);
  }
}

function consumeStdout(chunk) {
  stdoutBuffer = Buffer.concat([stdoutBuffer, Buffer.from(chunk)]);
  if (!startupReady) {
    const newline = stdoutBuffer.indexOf(0x0a);
    if (newline === -1) return;
    const line = stdoutBuffer.subarray(0, newline).toString("utf8").trim();
    const ready = JSON.parse(line);
    if (ready.version !== 1 || ready.type !== "ready" || ready.providerId !== "mrt2") {
      throw new Error("MRT2 companion reported an incompatible ready handshake");
    }
    startupReady = true;
    stdoutBuffer = stdoutBuffer.subarray(newline + 1);
  }
  while (stdoutBuffer.byteLength >= 4) {
    const bodyLength = stdoutBuffer.readUInt32BE(0);
    if (bodyLength < 3 || bodyLength > MAX_FRAME_BYTES) throw new Error("MRT2 companion frame length is invalid");
    if (stdoutBuffer.byteLength < bodyLength + 4) return;
    const body = stdoutBuffer.subarray(4, bodyLength + 4);
    stdoutBuffer = stdoutBuffer.subarray(bodyLength + 4);
    const frameType = body.readUInt8(0);
    const idLength = body.readUInt16BE(1);
    const transportId = body.subarray(3, 3 + idLength).toString("utf8");
    const payload = body.subarray(3 + idLength);
    if (frameType === 0) {
      deliverControl(JSON.parse(payload.toString("utf8")));
    } else if (frameType === 1) {
      if (payload.byteLength < FRAME_HEADER_BYTES) throw new Error("MRT2 audio packet is truncated");
      const sampleRate = payload.readUInt32LE(12);
      const frames = payload.readUInt32LE(16);
      const sequence = payload.readUInt32LE(20);
      const channels = payload.readUInt8(11);
      const dataBytes = payload.readUInt32LE(24);
      if (
        payload.readUInt8(10) !== 0 ||
        channels < 1 ||
        channels > 2 ||
        frames < 1 ||
        dataBytes !== frames * channels * 4 ||
        payload.byteLength !== FRAME_HEADER_BYTES + dataBytes
      ) {
        throw new Error("MRT2 companion emitted an invalid output packet");
      }
      let finite = true;
      for (let offset = FRAME_HEADER_BYTES; offset < payload.byteLength; offset += 4) {
        if (!Number.isFinite(payload.readFloatLE(offset))) finite = false;
      }
      if (previousSequence !== null && sequence !== previousSequence + 1) sequenceGapCount++;
      previousSequence = sequence;
      audioPackets.push({
        transportId,
        sequence,
        sampleRate,
        frames,
        channels,
        finite,
        receivedAt: performance.now(),
      });
    } else if (frameType === 2) {
      fail(new Error(`MRT2 companion closed transport: ${payload.toString("utf8")}`));
    } else {
      throw new Error("MRT2 companion emitted an unsupported frame type");
    }
  }
}

child.stdout.on("data", (chunk) => {
  try {
    consumeStdout(chunk);
  } catch (error) {
    fail(error);
  }
});
child.once("error", fail);
child.once("exit", (code, signal) => {
  if (code !== 0 && !exitError) fail(new Error(`MRT2 companion exited with ${code ?? signal ?? "unknown status"}`));
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  const processStartedAt = performance.now();
  const startupDeadline = Date.now() + 30_000;
  while (!startupReady && !exitError && Date.now() < startupDeadline) await sleep(25);
  if (!startupReady) throw exitError ?? new Error("Timed out waiting for MRT2 companion startup");
  const readyAt = performance.now();
  const transportId = randomUUID();
  const helloRequest = requestId("hello");
  const helloSentAt = performance.now();
  sendControl(transportId, { version: 1, type: "hello", requestId: helloRequest, client: "kyx" });
  const hello = await waitFor((message) => message.type === "hello.ok" && message.requestId === helloRequest);
  const helloReceivedAt = performance.now();
  if (!hello.modelIds?.includes("mrt2_small")) throw new Error("MRT2 Small is not advertised by the companion");
  if (BENCHMARK_MODE === "live" && !hello.supportsRealtime) {
    throw new Error("Companion advertises capture-only mode; it cannot be promoted to the live benchmark gate");
  }
  if (BENCHMARK_MODE === "capture" && !hello.supportsCapture) {
    throw new Error("Companion does not advertise capture support; install the JAX runtime and MRT2 assets first");
  }
  if (!hello.outputSampleRates?.includes(48_000) || !hello.outputChannels?.includes(2)) {
    throw new Error("Companion does not advertise 48 kHz stereo output");
  }

  const sessionRequest = requestId("session");
  sendControl(transportId, {
    version: 1,
    type: "session.create",
    requestId: sessionRequest,
    config: { modelId: "mrt2_small", outputSampleRate: 48_000, outputChannels: 2 },
  });
  const session = await waitFor((message) => message.type === "session.ok" && message.requestId === sessionRequest);
  const sessionId = session.sessionId;
  const input = {
    bpm: 120,
    frameRateHz: 25,
    startTick: 0,
    style: { kind: "text", text: "instrumental cinematic pulse" },
    // Keep the benchmark control payload under the 64 KiB protocol ceiling;
    // the companion holds the last note frame for the remainder of a soak.
    noteFrames: hello.supportsNoteConditioning
      ? Array.from({ length: Math.min(25, Math.ceil(DURATION_SECONDS * 25)) }, (_, frameIndex) => ({
          frameIndex,
          pitchState: new Array(128).fill(0),
        }))
      : [],
    drumsMode: "off",
    macros: { energy: 0.5, density: 0.35, variation: 0.25, texture: 0.5 },
  };
  const inputRequest = requestId("input");
  const inputSentAt = performance.now();
  sendControl(transportId, { version: 1, type: "input.update", requestId: inputRequest, sessionId, input });
  await waitFor((message) => message.type === "status" && message.requestId === inputRequest);
  const inputReceivedAt = performance.now();
  const startedAt = performance.now();
  let operationResponseAt = startedAt;
  let operationFrames = null;
  if (BENCHMARK_MODE === "live") {
    const startRequest = requestId("start");
    sendControl(transportId, { version: 1, type: "session.start", requestId: startRequest, sessionId });
    await waitFor((message) => message.type === "status" && message.requestId === startRequest);
    operationResponseAt = performance.now();
    await sleep(DURATION_SECONDS * 1000);
  } else {
    const captureRequest = requestId("capture");
    sendControl(transportId, {
      version: 1,
      type: "capture.start",
      requestId: captureRequest,
      sessionId,
      durationSec: DURATION_SECONDS,
    });
    const capture = await waitFor(
      (message) => message.type === "capture.ok" && message.requestId === captureRequest,
      600_000,
    );
    operationFrames = capture.frames;
    operationResponseAt = performance.now();
  }
  const endedAt = performance.now();
  const outputFrames = audioPackets.reduce((total, packet) => total + packet.frames, 0);
  const generatedSeconds = outputFrames / 48_000;
  const wallSeconds = (endedAt - startedAt) / 1000;
  const realtimeFactor = generatedSeconds / wallSeconds;
  const packetIntervals = audioPackets
    .slice(1)
    .map((packet, index) => packet.receivedAt - audioPackets[index].receivedAt);
  packetIntervals.sort((a, b) => a - b);
  const p95Index = Math.min(packetIntervals.length - 1, Math.floor(packetIntervals.length * 0.95));
  const result = {
    backendId: hello.runtimeProfile?.backendId ?? "unknown",
    benchmarkMode: BENCHMARK_MODE,
    requestedSeconds: DURATION_SECONDS,
    executionMode: hello.runtimeProfile?.executionMode ?? (hello.supportsRealtime ? "realtime" : "capture"),
    runtimeVersion: hello.runtimeProfile?.runtimeVersion ?? null,
    advertisedLatencyMs: hello.runtimeProfile?.measuredLatencyMs ?? null,
    advertisedFrameP95Ms: hello.runtimeProfile?.frameP95Ms ?? null,
    advertisedRealtimeFactor: hello.runtimeProfile?.realtimeFactor ?? null,
    wallSeconds,
    outputFrames,
    generatedSeconds,
    measuredRealtimeFactor: realtimeFactor,
    packetCount: audioPackets.length,
    captureResponseFrames: operationFrames,
    packetIntervalP95Ms: packetIntervals.length ? packetIntervals[p95Index] : null,
    timing: {
      startupReadyMs: readyAt - processStartedAt,
      helloRoundTripMs: helloReceivedAt - helloSentAt,
      inputRoundTripMs: inputReceivedAt - inputSentAt,
      operationResponseMs: operationResponseAt - startedAt,
    },
    sequenceGapCount,
    underrunCount,
    statusEvents,
    finitePcm: audioPackets.every((packet) => packet.finite),
    gate: {
      hasAudioPackets: audioPackets.length > 0,
      frameP95Under32Ms:
        (hello.runtimeProfile?.frameP95Ms ?? (packetIntervals.length ? packetIntervals[p95Index] : Infinity)) < 32,
      realtimeFactorAtLeast1_25: realtimeFactor >= 1.25,
      outputCoverageAtLeast99Percent: generatedSeconds >= DURATION_SECONDS * 0.99,
      captureResponseMatchesPcm:
        BENCHMARK_MODE !== "capture" || (operationFrames !== null && operationFrames === outputFrames),
      producedFinite48kStereo:
        audioPackets.every((packet) => packet.sampleRate === 48_000 && packet.channels === 2) &&
        audioPackets.every((packet) => packet.finite),
      noSequenceGaps: sequenceGapCount === 0,
      noUnderruns: underrunCount === 0,
    },
  };
  if (REPORT_PATH) {
    await mkdir(path.dirname(path.resolve(REPORT_PATH)), { recursive: true });
    await writeFile(REPORT_PATH, JSON.stringify(result, null, 2) + "\n", "utf8");
  }
  console.log(JSON.stringify(result, null, 2));
  sendControl(transportId, { version: 1, type: "session.stop", requestId: requestId("stop"), sessionId });
  sendControl(transportId, { version: 1, type: "session.close", requestId: requestId("close"), sessionId });
  child.stdin.end(encodeFrame(3, ""));
} catch (error) {
  fail(error);
  child.kill();
  throw error;
}
