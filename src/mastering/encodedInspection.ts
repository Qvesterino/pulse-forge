import type { MixHealthReport } from "../analysis/mixDoctor";
import type { BufferSummary, MasterVerdict } from "../audio-engine/metering";
import type { LoudnessTimeline } from "../audio-engine/kweighting";
import { decodeAudioData } from "../services/audio-decode";
import type { MasterAnalysisProgressListener } from "./analysis";
import { analyzeMasterBufferAsync, analyzeMasterPcmStreamAsync } from "./analysisClient";
import { analyzeMp3BlobAsync } from "./mp3AnalysisClient";
import { fingerprintEncodedMasterAsync, type EncodedMasterFingerprint } from "./fingerprintClient";
import type { MasterProfile } from "./profiles";
import { decodeBwfLoudnessValue, encodeBwfLoudnessValue, type WavBextLoudnessField } from "../rendering/wav";
import { parseMp3FrameHeader, type Mp3FrameHeader } from "./mp3Frames";

export type EncodedMasterFormat = "wav" | "mp3";
export type MasteringReferenceFormat = EncodedMasterFormat | "flac";

export interface EncodedMasterFileDetails {
  sampleRate: number;
  channels: number;
  durationSeconds: number;
  durationAccuracy: "exact" | "estimated";
  bitDepth?: number;
  averageBitrateKbps?: number;
  bext?: {
    version: number;
    description: string;
    loudness?: {
      integratedLufs: number | null;
      rangeLu: number | null;
      truePeakDbtp: number | null;
      momentaryLufs: number | null;
      shortTermLufs: number | null;
    };
  };
}

export interface EncodedMasterInspection {
  format: EncodedMasterFormat;
  byteLength: number;
  file: EncodedMasterFileDetails;
  fingerprint: EncodedMasterFingerprint;
  decode: {
    status: "measured" | "not-measured";
    decoder: "Web Audio" | "KYX WAV PCM reader" | "WebCodecs MP3 worker" | "not invoked";
    sampleRate?: number;
    channels?: number;
    durationSeconds?: number;
    measurements?: BufferSummary;
    loudnessTimeline?: LoudnessTimeline | null;
    mixHealth?: MixHealthReport;
    verdict?: MasterVerdict;
    reason?: string;
    warnings: string[];
  };
}

const MAX_WAV_DECODE_BYTES = 96 * 1024 * 1024;
const MAX_MP3_DECODE_BYTES = 12 * 1024 * 1024;

function cancelledError(): DOMException {
  return new DOMException("Master inspection cancelled", "AbortError");
}

/** Stop waiting promptly when a browser byte read or atomic decoder cannot itself be cancelled. */
function awaitWithAbort<T>(operation: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(operation);
  if (signal.aborted) return Promise.reject(cancelledError());

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let onAbort: () => void = () => undefined;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };
    onAbort = () => finish(() => reject(cancelledError()));

    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}

interface ParsedWav extends EncodedMasterFileDetails {
  bitDepth: 16 | 24 | 32;
  formatCode: 1 | 3;
  blockAlign: number;
  dataBytes: number;
  dataOffset: number;
  frameCount: number;
}

interface ParsedMp3 extends EncodedMasterFileDetails {
  averageBitrateKbps: number;
}

function readFourCc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function readAscii(view: DataView, offset: number, length: number): string {
  let value = "";
  for (let i = 0; i < length; i++) {
    const byte = view.getUint8(offset + i);
    if (byte === 0) break;
    value += String.fromCharCode(byte);
  }
  return value.trim();
}

/** Inspect the RIFF chunks emitted by KYX before asking a browser to decode the file. */
function parseWav(bytes: ArrayBuffer): ParsedWav {
  if (bytes.byteLength < 44) throw new Error("The WAV file is shorter than its header.");
  const view = new DataView(bytes);
  if (readFourCc(view, 0) !== "RIFF" || readFourCc(view, 8) !== "WAVE") {
    throw new Error("The exported file does not have a RIFF/WAVE header.");
  }

  const declaredEnd = view.getUint32(4, true) + 8;
  if (declaredEnd > bytes.byteLength) throw new Error("The WAV RIFF size extends beyond the exported file.");

  let formatCode = 0;
  let channels = 0;
  let sampleRate = 0;
  let blockAlign = 0;
  let bitDepth = 0;
  let dataBytes = 0;
  let dataOffset = 0;
  let byteRate = 0;
  let bext: EncodedMasterFileDetails["bext"];
  let offset = 12;

  while (offset + 8 <= declaredEnd) {
    const chunkId = readFourCc(view, offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > declaredEnd) throw new Error(`The WAV ${chunkId} chunk extends beyond the RIFF boundary.`);

    if (chunkId === "fmt ") {
      if (chunkSize < 16) throw new Error("The WAV format chunk is incomplete.");
      formatCode = view.getUint16(chunkStart, true);
      channels = view.getUint16(chunkStart + 2, true);
      sampleRate = view.getUint32(chunkStart + 4, true);
      byteRate = view.getUint32(chunkStart + 8, true);
      blockAlign = view.getUint16(chunkStart + 12, true);
      bitDepth = view.getUint16(chunkStart + 14, true);
    } else if (chunkId === "data") {
      dataBytes = chunkSize;
      dataOffset = chunkStart;
    } else if (chunkId === "bext") {
      if (chunkSize < 602) throw new Error("The WAV broadcast metadata (bext) chunk is incomplete.");
      const version = view.getUint16(chunkStart + 346, true);
      bext = {
        version,
        description: readAscii(view, chunkStart, 256),
        ...(version >= 2
          ? {
              loudness: {
                integratedLufs: decodeBwfLoudnessValue(view.getInt16(chunkStart + 412, true), "integratedLufs"),
                rangeLu: decodeBwfLoudnessValue(view.getInt16(chunkStart + 414, true), "rangeLu"),
                truePeakDbtp: decodeBwfLoudnessValue(view.getInt16(chunkStart + 416, true), "truePeakDbtp"),
                momentaryLufs: decodeBwfLoudnessValue(view.getInt16(chunkStart + 418, true), "momentaryLufs"),
                shortTermLufs: decodeBwfLoudnessValue(view.getInt16(chunkStart + 420, true), "shortTermLufs"),
              },
            }
          : {}),
      };
    }

    offset = chunkEnd + (chunkSize & 1);
  }

  if (!channels || !sampleRate || !blockAlign || !dataBytes)
    throw new Error("The WAV is missing audio format or sample data.");
  if ((formatCode !== 1 && formatCode !== 3) || ![16, 24, 32].includes(bitDepth)) {
    throw new Error(`Unsupported WAV encoding (${formatCode}, ${bitDepth}-bit).`);
  }
  if (formatCode === 1 && bitDepth === 32)
    throw new Error("The exported 32-bit WAV must contain floating-point samples.");
  if (formatCode === 3 && bitDepth !== 32) throw new Error("The exported floating-point WAV must be 32-bit.");
  if (blockAlign !== channels * (bitDepth / 8) || byteRate !== sampleRate * blockAlign) {
    throw new Error("The WAV sample layout does not match its channel, rate or bit-depth fields.");
  }
  if (dataBytes % blockAlign !== 0) throw new Error("The WAV audio data is not aligned to complete sample frames.");

  return {
    sampleRate,
    channels,
    durationSeconds: dataBytes / blockAlign / sampleRate,
    durationAccuracy: "exact",
    bitDepth: bitDepth as 16 | 24 | 32,
    formatCode: formatCode as 1 | 3,
    blockAlign,
    dataBytes,
    dataOffset,
    frameCount: dataBytes / blockAlign,
    ...(bext ? { bext } : {}),
  };
}

function publicWavDetails(wav: ParsedWav): EncodedMasterFileDetails {
  return {
    sampleRate: wav.sampleRate,
    channels: wav.channels,
    durationSeconds: wav.durationSeconds,
    durationAccuracy: wav.durationAccuracy,
    bitDepth: wav.bitDepth,
    ...(wav.bext ? { bext: wav.bext } : {}),
  };
}

function decodeWavPcmRange(
  bytes: ArrayBuffer,
  wav: ParsedWav,
  frameOffset: number,
  frameCount: number,
): Float32Array[] {
  const start = wav.dataOffset + frameOffset * wav.blockAlign;
  const view = new DataView(bytes, start, frameCount * wav.blockAlign);
  const channels = Array.from({ length: wav.channels }, () => new Float32Array(frameCount));
  const bytesPerSample = wav.bitDepth / 8;
  for (let frame = 0; frame < frameCount; frame++) {
    const frameStart = frame * wav.blockAlign;
    for (let channel = 0; channel < wav.channels; channel++) {
      const sampleOffset = frameStart + channel * bytesPerSample;
      let sample: number;
      if (wav.formatCode === 3) {
        sample = view.getFloat32(sampleOffset, true);
        if (!Number.isFinite(sample)) throw new Error("The WAV contains a non-finite floating-point sample.");
      } else if (wav.bitDepth === 16) {
        sample = view.getInt16(sampleOffset, true) / 0x8000;
      } else {
        let value = view.getUint8(sampleOffset) | (view.getUint8(sampleOffset + 1) << 8);
        value |= view.getUint8(sampleOffset + 2) << 16;
        if (value & 0x800000) value -= 0x1000000;
        sample = value / 0x800000;
      }
      channels[channel][frame] = sample;
    }
  }
  return channels;
}

/** Read MPEG Layer III frame headers so MP3 metadata comes from the file, not the dropdown. */
function parseMp3(bytes: ArrayBuffer): ParsedMp3 {
  if (bytes.byteLength < 4) throw new Error("The MP3 file is too short to contain an audio frame.");
  const view = new DataView(bytes);
  let offset = 0;

  // LAME may write an ID3v2 tag before the first MPEG frame.
  if (bytes.byteLength >= 10 && view.getUint8(0) === 0x49 && view.getUint8(1) === 0x44 && view.getUint8(2) === 0x33) {
    const synchsafeSize =
      ((view.getUint8(6) & 0x7f) << 21) |
      ((view.getUint8(7) & 0x7f) << 14) |
      ((view.getUint8(8) & 0x7f) << 7) |
      (view.getUint8(9) & 0x7f);
    offset = 10 + synchsafeSize + ((view.getUint8(5) & 0x10) !== 0 ? 10 : 0);
    if (offset > bytes.byteLength) throw new Error("The MP3 ID3 tag extends beyond the exported file.");
  }

  const searchEnd = Math.min(bytes.byteLength - 4, offset + 64 * 1024);
  let first: Mp3FrameHeader | null = null;
  while (offset <= searchEnd && !(first = parseMp3FrameHeader(view, offset))) offset++;
  if (!first) throw new Error("No valid MPEG Layer III frame was found in the exported MP3.");
  let frames = 0;
  let bitrateSum = 0;
  while (offset + 4 <= bytes.byteLength) {
    const frame = parseMp3FrameHeader(view, offset);
    if (
      !frame ||
      frame.version !== first.version ||
      frame.sampleRate !== first.sampleRate ||
      frame.channels !== first.channels ||
      frame.frameBytes < 4 ||
      offset + frame.frameBytes > bytes.byteLength
    ) {
      break;
    }
    frames++;
    bitrateSum += frame.bitrateKbps;
    offset += frame.frameBytes;
  }
  if (frames === 0) throw new Error("The exported MP3 contains no complete audio frames.");

  return {
    sampleRate: first.sampleRate,
    channels: first.channels,
    durationSeconds: (frames * first.samplesPerFrame) / first.sampleRate,
    durationAccuracy: "exact",
    averageBitrateKbps: bitrateSum / frames,
  };
}

/** Read the FLAC STREAMINFO block and first-frame marker without decoding or changing source bytes. */
function parseFlac(bytes: ArrayBuffer): EncodedMasterFileDetails {
  const view = new DataView(bytes);
  if (bytes.byteLength < 42 || readFourCc(view, 0) !== "fLaC") {
    throw new Error("The FLAC file is missing its marker or STREAMINFO block.");
  }

  let offset = 4;
  let streamInfo: { sampleRate: number; channels: number; bitDepth: number; totalSamples: number } | undefined;
  let isLastBlock = false;
  while (!isLastBlock) {
    if (offset + 4 > bytes.byteLength) throw new Error("The FLAC metadata header is incomplete.");
    const header = view.getUint8(offset);
    const blockType = header & 0x7f;
    isLastBlock = (header & 0x80) !== 0;
    const blockLength =
      (view.getUint8(offset + 1) << 16) | (view.getUint8(offset + 2) << 8) | view.getUint8(offset + 3);
    const blockStart = offset + 4;
    const blockEnd = blockStart + blockLength;
    if (blockEnd > bytes.byteLength) throw new Error("The FLAC metadata block extends beyond the file.");

    if (offset === 4 && (blockType !== 0 || blockLength !== 34)) {
      throw new Error("The FLAC file must begin with a 34-byte STREAMINFO block.");
    }
    if (blockType === 0) {
      if (blockLength !== 34 || streamInfo) throw new Error("The FLAC STREAMINFO block is invalid or duplicated.");
      const packedOffset = blockStart + 10;
      const packed = [
        view.getUint8(packedOffset),
        view.getUint8(packedOffset + 1),
        view.getUint8(packedOffset + 2),
        view.getUint8(packedOffset + 3),
        view.getUint8(packedOffset + 4),
        view.getUint8(packedOffset + 5),
        view.getUint8(packedOffset + 6),
        view.getUint8(packedOffset + 7),
      ];
      const sampleRate = (packed[0] << 12) | (packed[1] << 4) | (packed[2] >>> 4);
      const channels = ((packed[2] >>> 1) & 0x07) + 1;
      const bitDepth = (((packed[2] & 0x01) << 4) | (packed[3] >>> 4)) + 1;
      const totalSamples =
        (packed[3] & 0x0f) * 0x1_0000_0000 +
        packed[4] * 0x1_000_000 +
        packed[5] * 0x1_0000 +
        packed[6] * 0x100 +
        packed[7];
      if (sampleRate < 1 || channels < 1 || channels > 8 || bitDepth < 4 || bitDepth > 32 || totalSamples <= 0) {
        throw new Error("The FLAC STREAMINFO audio fields are invalid or do not include a known duration.");
      }
      streamInfo = { sampleRate, channels, bitDepth, totalSamples };
    }
    offset = blockEnd;
  }

  if (!streamInfo) throw new Error("The FLAC file does not contain a STREAMINFO block.");
  if (offset + 6 > bytes.byteLength || view.getUint8(offset) !== 0xff || (view.getUint8(offset + 1) & 0xfc) !== 0xf8) {
    throw new Error("The FLAC metadata is not followed by an audio frame.");
  }

  return {
    sampleRate: streamInfo.sampleRate,
    channels: streamInfo.channels,
    durationSeconds: streamInfo.totalSamples / streamInfo.sampleRate,
    durationAccuracy: "exact",
    bitDepth: streamInfo.bitDepth,
  };
}

/** Infer a supported read-only mastering input format from its filename. */
export function masteringReferenceFormatFromFileName(fileName: string): MasteringReferenceFormat {
  const extension = fileName.toLowerCase().split(".").pop();
  if (extension === "wav" || extension === "wave") return "wav";
  if (extension === "mp3") return "mp3";
  if (extension === "flac") return "flac";
  throw new Error("Mastering reference input supports WAV, MP3 and FLAC files.");
}

/** Parse WAV/MP3/FLAC source metadata without decoding or modifying the source bytes. */
export function inspectMasteringReferenceContainer(
  format: MasteringReferenceFormat,
  bytes: ArrayBuffer,
): EncodedMasterFileDetails {
  if (format === "wav") return publicWavDetails(parseWav(bytes));
  if (format === "mp3") return parseMp3(bytes);
  return parseFlac(bytes);
}

async function mp3MetadataWindow(blob: Blob, signal?: AbortSignal): Promise<ArrayBuffer> {
  const header = await awaitWithAbort(blob.slice(0, Math.min(10, blob.size)).arrayBuffer(), signal);
  const headerView = new DataView(header);
  let start = 0;
  if (
    header.byteLength >= 10 &&
    headerView.getUint8(0) === 0x49 &&
    headerView.getUint8(1) === 0x44 &&
    headerView.getUint8(2) === 0x33
  ) {
    const size =
      ((headerView.getUint8(6) & 0x7f) << 21) |
      ((headerView.getUint8(7) & 0x7f) << 14) |
      ((headerView.getUint8(8) & 0x7f) << 7) |
      (headerView.getUint8(9) & 0x7f);
    start = 10 + size + ((headerView.getUint8(5) & 0x10) !== 0 ? 10 : 0);
  }
  if (start >= blob.size) throw new Error("The MP3 ID3 tag contains no following audio frames.");
  return awaitWithAbort(blob.slice(start, Math.min(blob.size, start + 64 * 1024)).arrayBuffer(), signal);
}

function notMeasured(
  format: EncodedMasterFormat,
  byteLength: number,
  file: EncodedMasterFileDetails,
  reason: string,
  warnings: string[],
  fingerprint: EncodedMasterFingerprint,
  decoder: EncodedMasterInspection["decode"]["decoder"] = "not invoked",
): EncodedMasterInspection {
  return { format, byteLength, file, fingerprint, decode: { status: "not-measured", decoder, reason, warnings } };
}

/** Verify the finished WAV/MP3 container, then measure the browser-decoded deliverable. */
export async function inspectEncodedMaster(input: {
  format: EncodedMasterFormat;
  bytes: ArrayBuffer | Blob;
  /** Exact download Blob for bounded output hashing when `bytes` is an ArrayBuffer. */
  fingerprintBlob?: Blob;
  expectedDurationSeconds: number;
  sourceMeasurements: BufferSummary;
  profile: MasterProfile;
  onProgress?: MasterAnalysisProgressListener;
  signal?: AbortSignal;
}): Promise<EncodedMasterInspection> {
  const { format, bytes, expectedDurationSeconds, sourceMeasurements, profile, onProgress, signal } = input;
  if (signal?.aborted) throw new DOMException("Master inspection cancelled", "AbortError");
  const blobInput = typeof Blob !== "undefined" && bytes instanceof Blob ? bytes : null;
  const byteLength = blobInput?.size ?? (bytes as ArrayBuffer).byteLength;
  let file: EncodedMasterFileDetails;
  let decoderBytes: ArrayBuffer;
  let parsedWav: ParsedWav | null = null;
  if (format === "wav") {
    if (blobInput) throw new Error("WAV inspection requires the encoded RIFF byte buffer.");
    decoderBytes = bytes as ArrayBuffer;
    parsedWav = parseWav(decoderBytes);
    file = publicWavDetails(parsedWav);
  } else if (blobInput && byteLength > MAX_MP3_DECODE_BYTES) {
    const frameWindow = await mp3MetadataWindow(blobInput, signal);
    const sampledFile = parseMp3(frameWindow);
    file = {
      ...sampledFile,
      durationSeconds: (byteLength * 8) / (sampledFile.averageBitrateKbps * 1000),
      durationAccuracy: "estimated",
    };
    decoderBytes = frameWindow;
  } else {
    decoderBytes = blobInput ? await awaitWithAbort(blobInput.arrayBuffer(), signal) : (bytes as ArrayBuffer);
    file = parseMp3(decoderBytes);
  }
  const fingerprintBlob = input.fingerprintBlob ?? null;
  const fingerprint =
    fingerprintBlob && fingerprintBlob.size === byteLength
      ? await fingerprintEncodedMasterAsync(fingerprintBlob, {
          signal,
          onProgress: ({ progress }) =>
            onProgress?.({ progress: progress * 0.15, stage: "Fingerprinting encoded file" }),
        })
      : {
          algorithm: "SHA-256" as const,
          status: "not-computed" as const,
          hex: null,
          reason: fingerprintBlob
            ? "The fingerprint Blob size does not match the inspected delivery bytes."
            : "The exact delivery Blob was not provided for bounded fingerprinting.",
        };
  const analysisProgress: MasterAnalysisProgressListener | undefined = onProgress
    ? ({ progress, stage }) => onProgress({ progress: 0.15 + progress * 0.85, stage })
    : undefined;
  const warnings: string[] = [];
  const durationTolerance = Math.max(0.25, (2 * 1152) / file.sampleRate);
  if (
    file.durationAccuracy === "exact" &&
    Math.abs(file.durationSeconds - expectedDurationSeconds) > durationTolerance
  ) {
    warnings.push(
      `File duration differs from the rendered program by ${(file.durationSeconds - expectedDurationSeconds).toFixed(3)} s.`,
    );
  }
  if (file.channels !== 2)
    warnings.push(
      `The exported file has ${file.channels} channel${file.channels === 1 ? "" : "s"}; stereo was expected.`,
    );
  if (format === "wav" && !file.bext) warnings.push("The WAV has no BWF bext metadata chunk.");
  if (format === "wav" && file.bext && file.bext.version < 2)
    warnings.push("The WAV BWF metadata has no version 2 loudness fields.");
  if (format === "wav" && file.bext && file.bext.version >= 2 && file.bext.loudness) {
    const expectedFields: Array<{ field: WavBextLoudnessField; label: string; value: number | null | undefined }> = [
      { field: "integratedLufs", label: "integrated loudness", value: sourceMeasurements.lufsIntegrated },
      { field: "rangeLu", label: "loudness range", value: sourceMeasurements.loudnessRangeLu },
      { field: "truePeakDbtp", label: "maximum true peak", value: sourceMeasurements.truePeakDb },
      { field: "momentaryLufs", label: "maximum momentary loudness", value: sourceMeasurements.lufsMomentary },
      { field: "shortTermLufs", label: "maximum short-term loudness", value: sourceMeasurements.lufsShortTerm },
    ];
    for (const { field, label, value } of expectedFields) {
      const expected = decodeBwfLoudnessValue(encodeBwfLoudnessValue(value, field), field);
      const actual = file.bext.loudness[field];
      if (actual !== expected) {
        warnings.push(
          `BWF v2 ${label} metadata ${actual == null ? "is unavailable" : `is ${actual.toFixed(2)}`} but source PCM measurement is ${expected == null ? "unavailable" : expected.toFixed(2)}.`,
        );
      }
    }
  }

  if (format === "wav" && byteLength > MAX_WAV_DECODE_BYTES && parsedWav) {
    try {
      onProgress?.({ progress: 0.15, stage: "Reading encoded WAV PCM in bounded chunks" });
      const analysis = await analyzeMasterPcmStreamAsync(
        {
          sampleRate: parsedWav.sampleRate,
          channelCount: parsedWav.channels,
          frameCount: parsedWav.frameCount,
          readChunk: (offset, length) => decodeWavPcmRange(decoderBytes, parsedWav!, offset, length),
        },
        profile,
        { onProgress: analysisProgress, signal },
      );
      const finiteMeasurements = Object.values(analysis.measurements).every(
        (value) => value === null || Number.isFinite(value),
      );
      if (!finiteMeasurements) throw new Error("The encoded WAV produced a non-finite measurement.");
      const durationSeconds = parsedWav.frameCount / parsedWav.sampleRate;
      if (Math.abs(analysis.mixHealth.durationSec - durationSeconds) > 1 / parsedWav.sampleRate) {
        warnings.push("The streamed WAV analysis duration differs from the RIFF frame count.");
      }
      return {
        format,
        byteLength,
        file,
        fingerprint,
        decode: {
          status: "measured",
          decoder: "KYX WAV PCM reader",
          sampleRate: parsedWav.sampleRate,
          channels: parsedWav.channels,
          durationSeconds,
          measurements: analysis.measurements,
          loudnessTimeline: analysis.loudnessTimeline,
          mixHealth: analysis.mixHealth,
          verdict: analysis.verdict,
          warnings,
        },
      };
    } catch (error) {
      if (signal?.aborted) throw cancelledError();
      return notMeasured(
        format,
        byteLength,
        file,
        `The encoded WAV PCM reader could not measure this file: ${error instanceof Error ? error.message : String(error)}`,
        warnings,
        fingerprint,
        "KYX WAV PCM reader",
      );
    }
  }

  if (format === "mp3" && blobInput && byteLength > MAX_MP3_DECODE_BYTES) {
    try {
      const result = await analyzeMp3BlobAsync(
        blobInput,
        { sampleRate: file.sampleRate, channels: file.channels },
        profile,
        { onProgress: analysisProgress, signal },
      );
      if (result.status === "unsupported") {
        return notMeasured(
          format,
          byteLength,
          file,
          `${result.reason} The MP3 header was checked, but post-encode audio measurements were skipped.`,
          warnings,
          fingerprint,
          "WebCodecs MP3 worker",
        );
      }
      file = {
        ...file,
        durationSeconds: result.durationSeconds,
        durationAccuracy: "exact",
        averageBitrateKbps: result.averageBitrateKbps,
      };
      if (Math.abs(result.durationSeconds - expectedDurationSeconds) > durationTolerance) {
        warnings.push(
          `Decoded file duration differs from the rendered program by ${(result.durationSeconds - expectedDurationSeconds).toFixed(3)} s.`,
        );
      }
      return {
        format,
        byteLength,
        file,
        fingerprint,
        decode: {
          status: "measured",
          decoder: "WebCodecs MP3 worker",
          sampleRate: file.sampleRate,
          channels: file.channels,
          durationSeconds: result.durationSeconds,
          measurements: result.analysis.measurements,
          loudnessTimeline: result.analysis.loudnessTimeline,
          mixHealth: result.analysis.mixHealth,
          verdict: result.analysis.verdict,
          warnings,
        },
      };
    } catch (error) {
      if (signal?.aborted) throw cancelledError();
      return notMeasured(
        format,
        byteLength,
        file,
        `The WebCodecs MP3 worker could not measure this file: ${error instanceof Error ? error.message : String(error)}`,
        warnings,
        fingerprint,
        "WebCodecs MP3 worker",
      );
    }
  }

  const maxDecodeBytes = format === "wav" ? MAX_WAV_DECODE_BYTES : MAX_MP3_DECODE_BYTES;
  if (byteLength > maxDecodeBytes) {
    const limitMb = (maxDecodeBytes / 1024 / 1024).toFixed(0);
    return notMeasured(
      format,
      byteLength,
      file,
      `File exceeds the ${limitMb} MiB in-memory decode limit; the encoded header was checked, but post-encode audio measurements were skipped.`,
      warnings,
      fingerprint,
    );
  }

  let decoded: AudioBuffer;
  try {
    decoded = await awaitWithAbort(decodeAudioData(decoderBytes, file.sampleRate), signal);
  } catch (error) {
    if (signal?.aborted) throw cancelledError();
    return notMeasured(
      format,
      byteLength,
      file,
      `The browser decoder could not measure this file: ${error instanceof Error ? error.message : String(error)}`,
      warnings,
      fingerprint,
      "Web Audio",
    );
  }
  if (signal?.aborted) throw new DOMException("Master inspection cancelled", "AbortError");

  try {
    const analysis = await analyzeMasterBufferAsync(decoded, profile, { onProgress: analysisProgress, signal });
    const finiteMeasurements = Object.values(analysis.measurements).every(
      (value) => value === null || Number.isFinite(value),
    );
    if (!finiteMeasurements) throw new Error("The decoded file produced a non-finite measurement.");
    if (decoded.numberOfChannels !== file.channels) {
      warnings.push(
        `Decoded channel count (${decoded.numberOfChannels}) differs from the file header (${file.channels}).`,
      );
    }
    if (Math.abs(decoded.duration - file.durationSeconds) > durationTolerance) {
      warnings.push(
        `Decoded duration differs from the file frame duration by ${(decoded.duration - file.durationSeconds).toFixed(3)} s.`,
      );
    }
    return {
      format,
      byteLength,
      file,
      fingerprint,
      decode: {
        status: "measured",
        decoder: "Web Audio",
        sampleRate: decoded.sampleRate,
        channels: decoded.numberOfChannels,
        durationSeconds: decoded.duration,
        measurements: analysis.measurements,
        loudnessTimeline: analysis.loudnessTimeline,
        mixHealth: analysis.mixHealth,
        verdict: analysis.verdict,
        warnings,
      },
    };
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Master inspection cancelled", "AbortError");
    return notMeasured(
      format,
      byteLength,
      file,
      `The browser decoder could not measure this file: ${error instanceof Error ? error.message : String(error)}`,
      warnings,
      fingerprint,
      "Web Audio",
    );
  }
}
