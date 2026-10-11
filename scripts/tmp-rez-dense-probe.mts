import { readFileSync } from "node:fs";
import { PitchTracker } from "../src/effects/rezonans-core/dsp/pitchTrack.js";

const path = "tests/fixtures/rezonans-cc0-female-speech.wav";
const bytes = readFileSync(path);
let offset = 12;
let sampleRate = 0;
let dataOffset = -1;
let dataLength = 0;
while (offset + 8 <= bytes.length) {
  const id = bytes.toString("ascii", offset, offset + 4);
  const size = bytes.readUInt32LE(offset + 4);
  if (id === "fmt ") sampleRate = bytes.readUInt32LE(offset + 12);
  if (id === "data") {
    dataOffset = offset + 8;
    dataLength = size;
  }
  offset += 8 + size + (size & 1);
}
const source = new Float32Array(dataLength / 2);
for (let i = 0; i < source.length; i++) source[i] = bytes.readInt16LE(dataOffset + 2 * i) / 32768;

const TARGET_RATE = 48000;
const block = 1024;
const window = 4096;
const resampled = new Float32Array(source.length * 2);
for (let i = 0; i < resampled.length; i++) {
  const p = i / 2;
  const lo = Math.floor(p);
  const hi = Math.min(source.length - 1, lo + 1);
  resampled[i] = source[lo]! + (source[hi]! - source[lo]!) * (p - lo);
}

function renderVariant(kind: "original" | "double-9c" | "triple-12c-clipped"): number[][] {
  const ring = new Float32Array(window * 2);
  const tracker = new PitchTracker();
  tracker.prepare(TARGET_RATE, window, 70, 800);
  const result: number[][] = [];
  let write = 0;
  for (let pos = 0; pos < resampled.length; pos += block) {
    for (let j = 0; j < block && pos + j < resampled.length; j++) {
      const t = pos + j;
      let sample = resampled[t]!;
      if (kind !== "original") {
        const delayed = t - Math.round(TARGET_RATE * 0.006);
        if (delayed >= 0) {
          const ratioA = 2 ** (9 / 1200);
          const ratioB = 2 ** (-9 / 1200);
          const a = resampled[Math.max(0, Math.min(resampled.length - 1, Math.floor(delayed * ratioA)))]!;
          sample += 0.72 * a;
          if (kind === "triple-12c-clipped") {
            const secondDelay = t - Math.round(TARGET_RATE * 0.011);
            if (secondDelay >= 0) {
              const b = resampled[Math.max(0, Math.min(resampled.length - 1, Math.floor(secondDelay * ratioB)))]!;
              sample += 0.48 * b;
            }
            sample = Math.tanh(4 * sample) / Math.tanh(4);
          }
        }
      }
      ring[write % ring.length] = sample;
      write++;
    }
    const estimate = tracker.detect(ring, ring.length, write);
    result.push([estimate.hz, estimate.clarity]);
  }
  return result;
}

function confirmLargeJumps(raw: number[][], threshold: number): number[][] {
  const accepted: number[][] = [];
  let heldHz = 0;
  let pendingHz = 0;
  let pendingCount = 0;
  for (const [hz, clarity] of raw) {
    if (!(hz > 0) || clarity < threshold) {
      accepted.push([0, clarity]);
      pendingHz = 0;
      pendingCount = 0;
      continue;
    }
    if (heldHz <= 0) {
      heldHz = hz;
      accepted.push([hz, clarity]);
      continue;
    }
    const jump = Math.abs(1200 * Math.log2(hz / heldHz));
    if (jump >= 120) {
      const agrees = pendingHz > 0 && Math.abs(1200 * Math.log2(hz / pendingHz)) <= 50;
      pendingCount = agrees ? pendingCount + 1 : 1;
      pendingHz = hz;
      if (pendingCount >= 2 || clarity >= 0.98) {
        heldHz = hz;
        pendingHz = 0;
        pendingCount = 0;
        accepted.push([hz, clarity]);
      } else {
        accepted.push([heldHz, clarity]);
      }
    } else {
      heldHz = hz;
      pendingHz = 0;
      pendingCount = 0;
      accepted.push([hz, clarity]);
    }
  }
  return accepted;
}

const original = renderVariant("original");
for (const kind of ["original", "double-9c", "triple-12c-clipped"] as const) {
  const result = kind === "original" ? original : renderVariant(kind);
  const medianClarity = [...result.map(([, clarity]) => clarity)].sort((a, b) => a - b)[Math.floor(result.length / 2)]!;
  for (const threshold of [0.75, 0.8, 0.85, 0.9]) {
    const filtered = confirmLargeJumps(result, threshold);
    const confident = filtered.filter(([, clarity]) => clarity >= threshold);
    const errors: number[] = [];
    const badFrames: Array<{ frame: number; baseHz: number; hz: number; cents: number; clarity: number }> = [];
    const bins = [0, 0, 0, 0, 0];
    for (let i = 0; i < result.length; i++) {
      const [hz, clarity] = filtered[i]!;
      const [baseHz, baseClarity] = original[i]!;
      if (hz > 0 && baseHz > 0 && clarity >= threshold && baseClarity >= 0.2) {
        const error = Math.abs(1200 * Math.log2(hz / baseHz));
        errors.push(error);
        if (error > 100 && badFrames.length < 8) badFrames.push({ frame: i, baseHz: +baseHz.toFixed(1), hz: +hz.toFixed(1), cents: +error.toFixed(1), clarity: +clarity.toFixed(3) });
        bins[error < 25 ? 0 : error < 50 ? 1 : error < 100 ? 2 : error < 300 ? 3 : 4]!++;
      }
    }
    const p95 = errors.length ? [...errors].sort((a, b) => a - b)[Math.floor((errors.length - 1) * 0.95)]! : NaN;
    const over100 = errors.filter((error) => error > 100).length;
    console.log(JSON.stringify({
      kind,
      threshold,
      frames: result.length,
      clarityPassPct: +(100 * confident.length / result.length).toFixed(1),
      medianClarity: +medianClarity.toFixed(3),
      matchedF0Windows: errors.length,
      matchedF0ErrorP95Cents: +p95.toFixed(1),
      matchedF0ErrorsOver100cPct: +(100 * over100 / Math.max(1, errors.length)).toFixed(1),
      errorBinsCents: { "<25": bins[0], "25-50": bins[1], "50-100": bins[2], "100-300": bins[3], ">=300": bins[4] },
      examples: badFrames,
    }));
  }
}
