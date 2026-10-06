import { analyzeMixHealthBuffer, type MixHealthReport } from "../analysis/mixDoctor";
import { summarizeBuffer, type BufferSummary } from "../audio-engine/metering";
import { decodeAudioData } from "../services/audio-decode";

export type EncodedMasterFormat = "wav" | "mp3";

export interface EncodedMasterFileDetails {
  sampleRate: number;
  channels: number;
  durationSeconds: number;
  bitDepth?: 16 | 24 | 32;
  averageBitrateKbps?: number;
  bext?: { version: number; description: string };
}

export interface EncodedMasterInspection {
  format: EncodedMasterFormat;
  byteLength: number;
  file: EncodedMasterFileDetails;
  decode: {
    status: "measured" | "not-measured";
    decoder: "Web Audio";
    sampleRate?: number;
    channels?: number;
    durationSeconds?: number;
    measurements?: BufferSummary;
    mixHealth?: MixHealthReport;
    reason?: string;
    warnings: string[];
  };
}

const MAX_WAV_DECODE_BYTES = 96 * 1024 * 1024;
const MAX_MP3_DECODE_BYTES = 12 * 1024 * 1024;

interface ParsedWav extends EncodedMasterFileDetails {
  bitDepth: 16 | 24 | 32;
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
      blockAlign = view.getUint16(chunkStart + 12, true);
      bitDepth = view.getUint16(chunkStart + 14, true);
    } else if (chunkId === "data") {
      dataBytes = chunkSize;
    } else if (chunkId === "bext") {
      if (chunkSize < 602) throw new Error("The WAV broadcast metadata (bext) chunk is incomplete.");
      bext = {
        version: view.getUint16(chunkStart + 346, true),
        description: readAscii(view, chunkStart, 256),
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
  if (dataBytes % blockAlign !== 0) throw new Error("The WAV audio data is not aligned to complete sample frames.");

  return {
    sampleRate,
    channels,
    durationSeconds: dataBytes / blockAlign / sampleRate,
    bitDepth: bitDepth as 16 | 24 | 32,
    ...(bext ? { bext } : {}),
  };
}

const MPEG1_L3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0] as const;
const MPEG2_L3_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0] as const;

interface Mp3FrameHeader {
  version: 1 | 2 | 2.5;
  sampleRate: number;
  channels: number;
  bitrateKbps: number;
  frameBytes: number;
  samplesPerFrame: number;
}

function parseMp3FrameHeader(view: DataView, offset: number): Mp3FrameHeader | null {
  if (offset + 4 > view.byteLength) return null;
  const word = view.getUint32(offset, false);
  if ((word & 0xffe00000) !== 0xffe00000) return null;
  const versionBits = (word >>> 19) & 0b11;
  const layerBits = (word >>> 17) & 0b11;
  const bitrateIndex = (word >>> 12) & 0b1111;
  const sampleRateIndex = (word >>> 10) & 0b11;
  if (versionBits === 1 || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3)
    return null;

  const version: Mp3FrameHeader["version"] = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
  const baseRate = [44100, 48000, 32000][sampleRateIndex];
  const sampleRate = baseRate / (version === 1 ? 1 : version === 2 ? 2 : 4);
  const bitrateKbps = (version === 1 ? MPEG1_L3_KBPS : MPEG2_L3_KBPS)[bitrateIndex];
  const padding = (word >>> 9) & 1;
  const samplesPerFrame = version === 1 ? 1152 : 576;
  const frameBytes = Math.floor(((version === 1 ? 144 : 72) * bitrateKbps * 1000) / sampleRate) + padding;
  return {
    version,
    sampleRate,
    channels: ((word >>> 6) & 0b11) === 3 ? 1 : 2,
    bitrateKbps,
    frameBytes,
    samplesPerFrame,
  };
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
  const firstOffset = offset;
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

  const audioBytes = offset - firstOffset;
  return {
    sampleRate: first.sampleRate,
    channels: first.channels,
    durationSeconds: (frames * first.samplesPerFrame) / first.sampleRate,
    averageBitrateKbps: bitrateSum / frames,
  };
}

function notMeasured(
  format: EncodedMasterFormat,
  byteLength: number,
  file: EncodedMasterFileDetails,
  reason: string,
  warnings: string[],
): EncodedMasterInspection {
  return { format, byteLength, file, decode: { status: "not-measured", decoder: "Web Audio", reason, warnings } };
}

/** Verify the finished WAV/MP3 container, then measure the browser-decoded deliverable. */
export async function inspectEncodedMaster(input: {
  format: EncodedMasterFormat;
  bytes: ArrayBuffer;
  expectedDurationSeconds: number;
  signal?: AbortSignal;
}): Promise<EncodedMasterInspection> {
  const { format, bytes, expectedDurationSeconds, signal } = input;
  if (signal?.aborted) throw new DOMException("Master inspection cancelled", "AbortError");
  const byteLength = bytes.byteLength;
  const file = format === "wav" ? parseWav(bytes) : parseMp3(bytes);
  const warnings: string[] = [];
  const durationTolerance = Math.max(0.25, (2 * 1152) / file.sampleRate);
  if (Math.abs(file.durationSeconds - expectedDurationSeconds) > durationTolerance) {
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

  const maxDecodeBytes = format === "wav" ? MAX_WAV_DECODE_BYTES : MAX_MP3_DECODE_BYTES;
  if (bytes.byteLength > maxDecodeBytes) {
    const limitMb = (maxDecodeBytes / 1024 / 1024).toFixed(0);
    return notMeasured(
      format,
      byteLength,
      file,
      `File exceeds the ${limitMb} MiB in-memory decode limit; the encoded header was checked, but post-encode audio measurements were skipped.`,
      warnings,
    );
  }

  let decoded: AudioBuffer;
  try {
    decoded = await decodeAudioData(bytes, file.sampleRate);
  } catch (error) {
    return notMeasured(
      format,
      byteLength,
      file,
      `The browser decoder could not measure this file: ${error instanceof Error ? error.message : String(error)}`,
      warnings,
    );
  }
  if (signal?.aborted) throw new DOMException("Master inspection cancelled", "AbortError");

  try {
    const measurements = summarizeBuffer(decoded);
    const finiteMeasurements = Object.values(measurements).every(Number.isFinite);
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
      decode: {
        status: "measured",
        decoder: "Web Audio",
        sampleRate: decoded.sampleRate,
        channels: decoded.numberOfChannels,
        durationSeconds: decoded.duration,
        measurements,
        mixHealth: analyzeMixHealthBuffer(decoded),
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
    );
  }
}
