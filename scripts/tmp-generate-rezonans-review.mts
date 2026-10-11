import { mkdir, readFile, writeFile } from "node:fs/promises";
import { RezonansProcessor } from "../src/effects/rezonans-core/dsp/rezonansProcessor.js";
import { QUALITY_FINE, REZ_PARAM, voiceParamId } from "../src/effects/rezonans-core/contracts/parameters.js";

const sourcePath = "tests/fixtures/rezonans-cc0-female-speech.wav";
const outDir = "artifacts/rezonans-listening-review";
const sourceRate = 24000;
const sampleRate = 48000;
const block = 128;
const fftSize = 4096;
const latency = fftSize - 1;

function decodeMonoPcm16(bytes: Buffer): Float32Array {
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Expected a RIFF/WAVE fixture");
  }
  let format = 0;
  let channels = 0;
  let rate = 0;
  let bits = 0;
  let dataOffset = -1;
  let dataLength = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const payload = offset + 8;
    if (id === "fmt ") {
      format = bytes.readUInt16LE(payload);
      channels = bytes.readUInt16LE(payload + 2);
      rate = bytes.readUInt32LE(payload + 4);
      bits = bytes.readUInt16LE(payload + 14);
    } else if (id === "data") {
      dataOffset = payload;
      dataLength = size;
      break;
    }
    offset = payload + size + (size & 1);
  }
  if (format !== 1 || channels !== 1 || rate !== sourceRate || bits !== 16 || dataOffset < 0) {
    throw new Error("Expected mono 24 kHz PCM16 source");
  }
  const samples = new Float32Array(dataLength / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(dataOffset + i * 2) / 32768;
  return samples;
}

function resample48k(input: Float32Array): Float32Array {
  const out = new Float32Array(input.length * 2);
  for (let i = 0; i < out.length; i++) {
    const p = i / 2;
    const lo = Math.floor(p);
    const hi = Math.min(input.length - 1, lo + 1);
    out[i] = input[lo]! + (input[hi]! - input[lo]!) * (p - lo);
  }
  return out;
}

function render(source: Float32Array, formant: number, semitones: number): Float32Array {
  const frames = source.length + fftSize * 2;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const processor = new RezonansProcessor();
  processor.prepare(sampleRate, 2, block, 120);
  const params: Record<string, number> = {
    [REZ_PARAM.quality]: QUALITY_FINE,
    [REZ_PARAM.harmonyMode]: 1,
    [REZ_PARAM.voices]: 1,
    [REZ_PARAM.mix]: 1,
    [REZ_PARAM.bodyGate]: 0.5,
    [REZ_PARAM.clarity]: 0.75,
    [REZ_PARAM.formant]: formant,
    [voiceParamId(0, "enabled")]: 1,
    [voiceParamId(0, "degree")]: semitones,
    [voiceParamId(0, "level")]: 1,
    [voiceParamId(0, "pan")]: 0,
    [voiceParamId(0, "humanize")]: 0,
  };
  for (const [id, value] of Object.entries(params)) processor.setParameter(id, value);
  processor.prepareOfflineRender();
  for (let pos = 0; pos < frames; pos += block) {
    const n = Math.min(block, frames - pos);
    for (let i = 0; i < n; i++) {
      const sample = source[pos + i] ?? 0;
      left[i] = sample;
      right[i] = sample;
    }
    processor.process([left, right], n);
    left.set(left.subarray(0, n), pos);
    right.set(right.subarray(0, n), pos);
  }
  return left;
}

function delayedReference(source: Float32Array, frames: number): Float32Array {
  const out = new Float32Array(frames);
  out.set(source.subarray(0, Math.max(0, frames - latency)), latency);
  return out;
}

function rms(values: Float32Array, start: number, length: number): number {
  let sum = 0;
  for (let i = start; i < start + length; i++) sum += values[i]! * values[i]!;
  return Math.sqrt(sum / length);
}

function peak(values: Float32Array, start: number, length: number): number {
  let max = 0;
  for (let i = start; i < start + length; i++) max = Math.max(max, Math.abs(values[i]!));
  return max;
}

function encodeStereoPcm16(mono: Float32Array): Buffer {
  const dataBytes = mono.length * 4;
  const out = Buffer.alloc(44 + dataBytes);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(2, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 4, 28);
  out.writeUInt16LE(4, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < mono.length; i++) {
    const x = Math.max(-1, Math.min(1, mono[i]!));
    const q = x < 0 ? Math.round(x * 32768) : Math.round(x * 32767);
    out.writeInt16LE(q, 44 + i * 4);
    out.writeInt16LE(q, 46 + i * 4);
  }
  return out;
}

const sourceBytes = await readFile(sourcePath);
const source = resample48k(decodeMonoPcm16(sourceBytes));
const frames = source.length + fftSize * 2;
const variants = [
  { file: "00-reference-aligned.wav", label: "Source, latency aligned", samples: delayedReference(source, frames) },
  { file: "01-fine-identity.wav", label: "Fine, unison, formant 0 st", samples: render(source, 0, 0) },
  { file: "02-fine-harmony-plus-7.wav", label: "Fine, +7 st harmony, formant 0 st", samples: render(source, 0, 7) },
  { file: "03-fine-harmony-plus-7-formant-plus-6.wav", label: "Fine, +7 st harmony, formant +6 st", samples: render(source, 6, 7) },
  { file: "04-fine-harmony-plus-7-formant-minus-6.wav", label: "Fine, +7 st harmony, formant -6 st", samples: render(source, -6, 7) },
];

const activeStart = latency;
const activeLength = source.length;
const targetRms = rms(variants[0]!.samples, activeStart, activeLength);
for (const variant of variants) {
  const ownRms = rms(variant.samples, activeStart, activeLength);
  variant.samples = Float32Array.from(variant.samples, (x) => x * (targetRms / Math.max(ownRms, 1e-12)));
}
const maxPeak = Math.max(...variants.map((variant) => peak(variant.samples, activeStart, activeLength)));
const sharedPeakScale = Math.min(1, 0.89 / Math.max(maxPeak, 1e-12));
for (const variant of variants) {
  variant.samples = Float32Array.from(variant.samples, (x) => x * sharedPeakScale);
}

await mkdir(outDir, { recursive: true });
const levels: string[] = [];
for (const variant of variants) {
  const outRms = rms(variant.samples, activeStart, activeLength);
  const outPeak = peak(variant.samples, activeStart, activeLength);
  await writeFile(`${outDir}/${variant.file}`, encodeStereoPcm16(variant.samples));
  levels.push(`| ${variant.file} | ${variant.label} | ${outRms.toFixed(4)} | ${(20 * Math.log10(outPeak)).toFixed(2)} dBFS |`);
}
await writeFile(
  `${outDir}/README.md`,
  `# REZONANS listening review\n\n` +
    `A human listening reference, not a pass/fail golden. Source: Wikimedia Commons, ` +
    `“Do you mind if I open the window.wav” by Czechcamp, CC0 1.0. ` +
    `The fixture is pinned in the test suite (SHA-1 1bf2d93eb310128ed323457ddc70ef2b0b9f980b).\n\n` +
    `All clips are stereo 48 kHz / 16-bit PCM, latency-aligned to the measured Fine path ` +
    `(${latency} samples / ${(latency / sampleRate * 1000).toFixed(2)} ms), RMS-matched over the phrase, ` +
    `and peak-safe with a shared final gain. REZONANS uses Fine (4096 FFT), 100% wet, one centered voice, ` +
    `clarity 0.75, body gate 0.5, no humanization.\n\n` +
    `| File | Signal | Phrase RMS | Peak |\n| --- | --- | ---: | ---: |\n${levels.join("\n")}\n\n` +
    `## Listen for\n\n` +
    `1. Compare 00 and 01: does identity processing smear or color consonants?\n` +
    `2. Compare 02 with 00: are word onsets intelligible at a perfect fifth?\n` +
    `3. Compare 03 and 04 with 02: do the formant extremes remain natural, or become hollow / pinched?\n` +
    `4. Note any syllable where the harmony jumps or sounds like the wrong singer.\n\n` +
    `These files stress the spectral path at 100% wet. They do not replace a musical sung-vocal review.\n`,
);
console.log(`Generated ${variants.length} clips in ${outDir}`);
