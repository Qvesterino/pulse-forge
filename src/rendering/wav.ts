import { mulberry32, quantizeInt16Sample, softClipSample } from "../export/quantize";
import { downloadBlob } from "../export/download";

export type WavBitDepth = 16 | 24 | 32;

/**
 * BWF `bext` loudness fields (EBU Tech 3285 v2). Values are supplied in dB/LUFS/LU;
 * the serializer applies the specification's 100× fixed-point scale. Missing or
 * out-of-range values use the specified 0x7fff unavailable sentinel.
 */
export interface WavBextLoudness {
  integratedLufs: number;
  /** Loudness range, LU. */
  rangeLu?: number | null;
  truePeakDbtp: number;
  momentaryLufs?: number | null;
  shortTermLufs?: number | null;
}

export type WavBextLoudnessField = "integratedLufs" | "rangeLu" | "truePeakDbtp" | "momentaryLufs" | "shortTermLufs";

const UNKNOWN_BWF_LOUDNESS = 0x7fff;

function roundTiesAwayFromZero(value: number): number {
  const magnitude = Math.abs(value);
  const rounded = Math.floor(magnitude + 0.5 + Number.EPSILON * magnitude);
  return Math.sign(value) * rounded;
}

/** Encode/decode a BWF v2 loudness field using Tech 3285's ×100 scale and sentinel. */
export function encodeBwfLoudnessValue(value: number | null | undefined, field: WavBextLoudnessField): number {
  const minimum = field === "rangeLu" ? 0 : -99.99;
  if (value == null || !Number.isFinite(value) || value < minimum || value > 99.99) return UNKNOWN_BWF_LOUDNESS;
  return roundTiesAwayFromZero(value * 100);
}

export function decodeBwfLoudnessValue(raw: number, field: WavBextLoudnessField): number | null {
  const minimum = field === "rangeLu" ? 0 : -99.99;
  if (!Number.isInteger(raw) || raw === UNKNOWN_BWF_LOUDNESS || raw < minimum * 100 || raw > 9999) return null;
  return raw / 100;
}

/**
 * BWF `bext` chunk payload (EBU Tech 3285) — the Broadcast Wave metadata that
 * Pro Tools / Nuendo / film workflows read on import. Field strings are
 * printable ASCII (everything else is replaced with "?", matching what DAWs
 * do with non-ASCII project names); fixed fields are null-padded and
 * truncated to their spec widths.
 */
export interface WavBextMetadata {
  description: string;
  originator: string;
  originatorReference: string;
  /** "yyyy:mm:dd" — the colons are the EBU spec, not a typo. */
  originationDate: string;
  originationTime: string;
  /** First-frame sample offset relative to the session origin (0 for full exports). */
  timeReference?: number;
  /** When present, the chunk is written as version 2 with the loudness fields. */
  loudness?: WavBextLoudness;
  /** Free-form ASCII history; \n is normalized to the spec's \r\n at write time. */
  codingHistory?: string;
}

/** Base bext body per EBU Tech 3285 v2 (everything before codingHistory). */
const BEXT_BASE_BYTES = 602;

const asciiText = (text: string): string => text.replace(/[^\x20-\x7e]/g, "?");
/** Coding history keeps line structure (spec: CRLF-terminated lines). */
const asciiHistory = (text: string): string => text.replace(/\r?\n/g, "\r\n").replace(/[^\x20-\x7e\r\n]/g, "?");

/**
 * Build a {@link WavBextMetadata} with KYX defaults: the current wall clock
 * (like every DAW bounce) and the product as originator. Pass `date` for
 * deterministic output in tests.
 */
export function createBextMetadata(input: {
  description: string;
  originator?: string;
  originatorReference?: string;
  date?: Date;
  timeReference?: number;
  loudness?: WavBextLoudness;
  codingHistory?: string;
}): WavBextMetadata {
  const d = input.date ?? new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  return {
    description: input.description,
    originator: input.originator ?? "KYX",
    originatorReference: input.originatorReference ?? globalThis.location?.hostname ?? "KYX",
    originationDate: `${d.getFullYear()}:${p2(d.getMonth() + 1)}:${p2(d.getDate())}`,
    originationTime: `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`,
    timeReference: input.timeReference ?? 0,
    ...(input.loudness ? { loudness: input.loudness } : {}),
    ...(input.codingHistory ? { codingHistory: input.codingHistory } : {}),
  };
}

/** Write the bext chunk body (id + size handled by the caller). Returns body bytes. */
function writeBextBody(view: DataView, offset: number, meta: WavBextMetadata, history: string): number {
  const writeFixed = (pos: number, text: string, width: number) => {
    const clean = asciiText(text).slice(0, width);
    for (let i = 0; i < width; i++) view.setUint8(pos + i, i < clean.length ? clean.charCodeAt(i) : 0);
  };
  writeFixed(offset, meta.description, 256);
  writeFixed(offset + 256, meta.originator, 32);
  writeFixed(offset + 288, meta.originatorReference, 32);
  writeFixed(offset + 320, meta.originationDate, 10);
  writeFixed(offset + 330, meta.originationTime, 8);
  const time = Math.max(0, Math.floor(meta.timeReference ?? 0));
  view.setUint32(offset + 338, time % 0x100000000, true);
  view.setUint32(offset + 342, Math.floor(time / 0x100000000), true);
  view.setUint16(offset + 346, meta.loudness ? 2 : 1, true);
  // UMID (348..412) stays zero = unallocated, per spec.
  const loudness = meta.loudness;
  if (loudness) {
    view.setInt16(offset + 412, encodeBwfLoudnessValue(loudness.integratedLufs, "integratedLufs"), true);
    view.setInt16(offset + 414, encodeBwfLoudnessValue(loudness.rangeLu, "rangeLu"), true);
    view.setInt16(offset + 416, encodeBwfLoudnessValue(loudness.truePeakDbtp, "truePeakDbtp"), true);
    view.setInt16(offset + 418, encodeBwfLoudnessValue(loudness.momentaryLufs, "momentaryLufs"), true);
    view.setInt16(offset + 420, encodeBwfLoudnessValue(loudness.shortTermLufs, "shortTermLufs"), true);
  }
  // 180 reserved bytes (422..602) stay zero.
  // History arrives pre-normalized (asciiHistory) — writing it raw keeps the
  // spec's CRLF line endings; running it through asciiText would eat them.
  for (let i = 0; i < history.length; i++) view.setUint8(offset + 602 + i, history.charCodeAt(i));
  return BEXT_BASE_BYTES + history.length;
}

/** Internal: RIFF header + container sizing shared by sync/async encoders. */
function createWavContainer(
  numChannels: number,
  sampleRate: number,
  frames: number,
  bitDepth: WavBitDepth,
  bext?: WavBextMetadata,
): { arrayBuffer: ArrayBuffer; view: DataView; dataSize: number; dataStart: number } {
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = frames * blockAlign;
  // Coding history is normalized once so sizing and writing agree.
  const history = bext ? asciiHistory(bext.codingHistory ?? "") : "";
  const bextBody = bext ? BEXT_BASE_BYTES + history.length : 0;
  const bextChunk = bext ? 8 + bextBody + (bextBody % 2) : 0;
  // RIFF chunk fields are unsigned 32-bit. Past ~4 GB they wrap and the file
  // is silently corrupt — an explicit failure beats wasting a 20-minute
  // render on a WAV no player will read.
  if (dataSize > 0xffffffff - (44 + bextChunk)) {
    throw new Error(
      `Render too large for WAV export (${(dataSize / 1024 ** 3).toFixed(1)} GB data). Export in segments or lower the sample rate/bit depth.`,
    );
  }
  // Audit 11 D4: RIFF requires an odd `data` chunk to carry one pad byte —
  // currently unreachable (all sources are stereo), but encodeWav is public
  // API and a future mono/odd-frame call would emit a spec-violating file.
  const padByte = dataSize % 2 === 1 ? 1 : 0;
  const arrayBuffer = new ArrayBuffer(44 + bextChunk + dataSize + padByte);
  const view = new DataView(arrayBuffer);

  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, "RIFF");
  // RIFF sizes count the data chunk WITH its pad byte (spec: chunks are
  // word-aligned); the declared `dataSize` stays the raw sample bytes.
  view.setUint32(4, 36 + bextChunk + dataSize + padByte, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  let cursor = 36;
  if (bext) {
    // BWF: `bext` sits between `fmt ` and `data` so streaming readers meet
    // the metadata before the audio.
    writeString(cursor, "bext");
    view.setUint32(cursor + 4, bextBody, true);
    writeBextBody(view, cursor + 8, bext, history);
    cursor += 8 + bextBody;
    if (bextBody % 2 === 1) cursor += 1; // pad byte stays zero
  }
  writeString(cursor, "data");
  view.setUint32(cursor + 4, dataSize, true);
  return { arrayBuffer, view, dataSize, dataStart: cursor + 8 };
}

/** Internal: one sample write, shared by sync/async encoders. */
function writeSample(
  view: DataView,
  offset: number,
  input: number,
  bitDepth: WavBitDepth,
  ditherRand: () => number,
): number {
  // Keep non-finite render artefacts from poisoning the file, but feed
  // hot finite samples through the shared soft-knee policy. Clamping
  // before softClipSample would turn the 24/32-bit paths into a hidden
  // hard clip at exactly full scale.
  const sample = Number.isFinite(input) ? input : 0;
  if (bitDepth === 16) {
    view.setInt16(offset, quantizeInt16Sample(sample, ditherRand), true);
    return offset + 2;
  }
  // 32-bit float is the interchange/mastering format: retain finite
  // over-range samples and let the receiving DAW preserve the headroom.
  // Integer PCM still uses the export soft-knee to avoid hard clipping.
  const clipped = bitDepth === 32 ? sample : softClipSample(sample);
  if (bitDepth === 24) {
    const value = Math.round(clipped * (clipped < 0 ? 0x800000 : 0x7fffff));
    view.setUint8(offset, value & 0xff);
    view.setUint8(offset + 1, (value >> 8) & 0xff);
    view.setUint8(offset + 2, (value >> 16) & 0xff);
    return offset + 3;
  }
  view.setFloat32(offset, clipped, true);
  return offset + 4;
}

export interface EncodeWavOptions {
  /** Optional BWF `bext` chunk (EBU Tech 3285) — pro-interchange metadata. */
  bext?: WavBextMetadata;
}

export function encodeWav(buffer: AudioBuffer, bitDepth: WavBitDepth, options: EncodeWavOptions = {}): ArrayBuffer {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const frames = buffer.length;
  const { arrayBuffer, view, dataStart } = createWavContainer(numChannels, sampleRate, frames, bitDepth, options.bext);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));

  let offset = dataStart;
  // TPDF dither PRNG for the 16-bit path (seeded → byte-reproducible exports)
  const ditherRand = mulberry32(0x57415631);
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      offset = writeSample(view, offset, channels[ch][i], bitDepth, ditherRand);
    }
  }
  return arrayBuffer;
}

export interface EncodeWavAsyncOptions extends EncodeWavOptions {
  /** Progress fraction 0..1 — fired once per processed block. */
  onProgress?: (fraction: number) => void;
  /** Aborts between blocks. */
  signal?: AbortSignal;
}

const ENCODE_BLOCK_FRAMES = 65536;

/**
 * Audit 11 (reliability wave): yielding variant of {@link encodeWav} for
 * long masters — the sync encoder freezes the main thread for the whole
 * per-sample loop (~seconds on a 4-minute 24-bit master), while this one
 * processes 64k-frame blocks and hands control back to the event loop
 * between them, reporting progress and honoring an abort signal.
 * Byte-identical output: same soft-knee/dither policy, one continuous
 * seeded PRNG across blocks.
 */
export async function encodeWavAsync(
  buffer: AudioBuffer,
  bitDepth: WavBitDepth,
  options: EncodeWavAsyncOptions = {},
): Promise<ArrayBuffer> {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const frames = buffer.length;
  const { arrayBuffer, view, dataStart } = createWavContainer(numChannels, sampleRate, frames, bitDepth, options.bext);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));

  let offset = dataStart;
  const ditherRand = mulberry32(0x57415631); // same seed → identical bytes
  for (let start = 0; start < frames; start += ENCODE_BLOCK_FRAMES) {
    const end = Math.min(frames, start + ENCODE_BLOCK_FRAMES);
    for (let i = start; i < end; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        offset = writeSample(view, offset, channels[ch][i], bitDepth, ditherRand);
      }
    }
    options.onProgress?.(end / frames);
    if (options.signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
    // Hand control back to the event loop so the UI stays alive.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return arrayBuffer;
}

export function downloadWav(arrayBuffer: ArrayBuffer, filename: string): void {
  downloadBlob(new Blob([arrayBuffer], { type: "audio/wav" }), filename);
}

export function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[^\w\- ]+/g, "")
      .replace(/\s+/g, "-")
      .slice(0, 60) || "pulse-forge"
  );
}
