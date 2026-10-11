/**
 * Repeatable local-core CPU probe for REZONANS' worst-case voice configuration.
 *
 * Run with `npm run benchmark:rezonans`. The reported ratio compares elapsed
 * JavaScript processing time to audio duration; it is a single-thread core
 * measurement, not a browser AudioWorklet or mobile-device certification.
 */
import { readFileSync } from "node:fs";
import { cpus, arch, platform } from "node:os";
import { performance } from "node:perf_hooks";
import { RezonansProcessor } from "../src/effects/rezonans-core/dsp/rezonansProcessor.js";
import { QUALITY_FINE, REZ_PARAM, voiceParamId } from "../src/effects/rezonans-core/contracts/parameters.js";

const SOURCE_PATH = "tests/fixtures/rezonans-cc0-female-speech.wav";
const SOURCE_RATE = 24000;
const TARGET_RATE = 48000;
const BLOCK = 128;
const WARMUP_SECONDS = 2;
const MEASURE_SECONDS = 8;
const REPEATS = 4;
const C_MAJOR = 0b101010110101;

function readMonoPcm16Wav(path: string): { samples: Float32Array; sampleRate: number } {
  const bytes = readFileSync(path);
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${path} is not a RIFF/WAVE file`);
  }

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const payload = offset + 8;
    if (payload + length > bytes.length) throw new Error(`Truncated ${id} WAV chunk`);
    if (id === "fmt ") {
      format = bytes.readUInt16LE(payload);
      channels = bytes.readUInt16LE(payload + 2);
      sampleRate = bytes.readUInt32LE(payload + 4);
      bitsPerSample = bytes.readUInt16LE(payload + 14);
    } else if (id === "data") {
      dataOffset = payload;
      dataLength = length;
    }
    offset = payload + length + (length & 1);
  }

  if (format !== 1 || channels !== 1 || bitsPerSample !== 16 || dataOffset < 0) {
    throw new Error("Benchmark fixture must be mono PCM16 WAV");
  }
  const count = Math.floor(dataLength / 2);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) samples[i] = bytes.readInt16LE(dataOffset + i * 2) / 32768;
  return { samples, sampleRate };
}

function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const length = Math.floor((input.length * toRate) / fromRate);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const sourcePos = (i * fromRate) / toRate;
    const lo = Math.floor(sourcePos);
    const hi = Math.min(input.length - 1, lo + 1);
    const fraction = sourcePos - lo;
    output[i] = input[lo]! + (input[hi]! - input[lo]!) * fraction;
  }
  return output;
}

function percentile(values: number[], q: number): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))]!;
}

function makeProcessor(): RezonansProcessor {
  const processor = new RezonansProcessor();
  processor.prepare(TARGET_RATE, 2, BLOCK, 120);
  processor.setParameter(REZ_PARAM.quality, QUALITY_FINE);
  processor.setParameter(REZ_PARAM.harmonyMode, 2);
  processor.setParameter(REZ_PARAM.voices, 4);
  processor.setParameter(REZ_PARAM.mix, 1);
  processor.setParameter(REZ_PARAM.bodyGate, 0.5);
  processor.setHarmonyContext({ keyRootPc: 0, scaleMask: C_MAJOR, chords: [] });
  for (let voice = 0; voice < 4; voice++) {
    processor.setParameter(voiceParamId(voice, "enabled"), 1);
    processor.setParameter(voiceParamId(voice, "degree"), [2, 4, 6, 8][voice]!);
    processor.setParameter(voiceParamId(voice, "level"), 0.35);
    processor.setParameter(voiceParamId(voice, "pan"), [-0.75, -0.25, 0.25, 0.75][voice]!);
    processor.setParameter(voiceParamId(voice, "humanize"), 0.15);
  }
  processor.prepareOfflineRender();
  return processor;
}

function processSeconds(
  processor: RezonansProcessor,
  source: Float32Array,
  seconds: number,
): { elapsedMs: number; cpuMs: number; blockMs: number[]; peak: number; allFinite: boolean } {
  const frames = Math.floor(seconds * TARGET_RATE);
  const prepared: Array<{ channels: Float32Array[]; frames: number }> = [];
  let sourceCursor = 0;
  for (let done = 0; done < frames;) {
    const length = Math.min(BLOCK, frames - done);
    const left = new Float32Array(length);
    const right = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const sample = source[sourceCursor]!;
      left[i] = sample;
      right[i] = sample;
      sourceCursor++;
      if (sourceCursor === source.length) sourceCursor = 0;
    }
    prepared.push({ channels: [left, right], frames: length });
    done += length;
  }

  const blockMs: number[] = [];
  const start = performance.now();
  const cpuStart = process.cpuUsage();

  for (const block of prepared) {
    const blockStart = performance.now();
    processor.process(block.channels, block.frames);
    blockMs.push(performance.now() - blockStart);
  }

  const elapsedMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  let peak = 0;
  let allFinite = true;
  for (const block of prepared) {
    const [left, right] = block.channels;
    for (let i = 0; i < block.frames; i++) {
      const l = left![i]!;
      const r = right![i]!;
      if (!Number.isFinite(l) || !Number.isFinite(r)) allFinite = false;
      peak = Math.max(peak, Math.abs(l), Math.abs(r));
    }
  }

  return {
    elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    blockMs,
    peak,
    allFinite,
  };
}

const fixture = readMonoPcm16Wav(SOURCE_PATH);
if (fixture.sampleRate !== SOURCE_RATE) {
  throw new Error(`Expected the pinned ${SOURCE_RATE} Hz fixture, got ${fixture.sampleRate} Hz`);
}
const source = resampleLinear(fixture.samples, fixture.sampleRate, TARGET_RATE);
const results: Array<{
  cpuPercent: number;
  cpuTimePercent: number;
  p95BlockMs: number;
  maxBlockMs: number;
  peak: number;
  allFinite: boolean;
}> = [];

for (let repeat = 0; repeat < REPEATS; repeat++) {
  const processor = makeProcessor();
  processSeconds(processor, source, WARMUP_SECONDS);
  processor.reset();
  const measured = processSeconds(processor, source, MEASURE_SECONDS);
  const audioMs = MEASURE_SECONDS * 1000;
  results.push({
    cpuPercent: (measured.elapsedMs / audioMs) * 100,
    cpuTimePercent: (measured.cpuMs / audioMs) * 100,
    p95BlockMs: percentile(measured.blockMs, 0.95),
    maxBlockMs: Math.max(...measured.blockMs),
    peak: measured.peak,
    allFinite: measured.allFinite,
  });
}

const cpu = cpus()[0];
const report = {
  benchmark: "REZONANS local core CPU probe",
  date: new Date().toISOString(),
  runtime: process.version,
  platform: `${platform()} ${arch()}`,
  cpu: cpu?.model ?? "unknown",
  logicalCores: cpus().length,
  sampleRate: TARGET_RATE,
  blockFrames: BLOCK,
  quality: "fine / 4096 FFT",
  harmonyVoices: 4,
  fixture: SOURCE_PATH,
  fixtureRate: fixture.sampleRate,
  warmupSeconds: WARMUP_SECONDS,
  measuredSecondsPerRepeat: MEASURE_SECONDS,
  repeats: REPEATS,
  cpuPercentMedian: percentile(
    results.map((r) => r.cpuPercent),
    0.5,
  ),
  cpuPercentP95: percentile(
    results.map((r) => r.cpuPercent),
    0.95,
  ),
  cpuTimePercentMedian: percentile(
    results.map((r) => r.cpuTimePercent),
    0.5,
  ),
  blockTimeP95MsMedian: percentile(
    results.map((r) => r.p95BlockMs),
    0.5,
  ),
  blockTimeMaxMs: Math.max(...results.map((r) => r.maxBlockMs)),
  audioBlockDeadlineMs: (BLOCK / TARGET_RATE) * 1000,
  allFinite: results.every((r) => r.allFinite),
  peak: Math.max(...results.map((r) => r.peak)),
  repeatsDetail: results,
  caveat:
    "CPU-time fields isolate the Node process from host scheduling pauses; wall-time and per-block fields include them. Both time the local TypeScript core, not browser AudioWorklet scheduling or mobile CPUs.",
};

console.log(JSON.stringify(report, null, 2));
