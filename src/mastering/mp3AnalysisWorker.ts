import { MasterAnalysisAccumulator, type MasterBufferAnalysis, type MasterAnalysisProgressListener } from "./analysis";
import { mp3AudioStartOffset, parseMp3FrameHeader, sameMp3Stream, type Mp3FrameHeader } from "./mp3Frames";
import type { MasterProfile } from "./profiles";

const MAX_ANALYSIS_SECONDS = 12 * 60 * 60;
const READ_BLOCK_BYTES = 128 * 1024;
const MAX_DECODE_QUEUE = 32;
const PROFILE_IDS = new Set(["streaming", "apple", "loud", "vinyl", "custom"]);

interface WorkerScope extends EventTarget {
  AudioDecoder?: typeof AudioDecoder;
  EncodedAudioChunk?: typeof EncodedAudioChunk;
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
}

const scope = self as unknown as WorkerScope;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProfile(value: unknown): value is MasterProfile {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    PROFILE_IDS.has(value.id) &&
    typeof value.label === "string" &&
    value.label.length <= 96 &&
    typeof value.targetLufs === "number" &&
    Number.isFinite(value.targetLufs) &&
    value.targetLufs >= -70 &&
    value.targetLufs <= 6 &&
    typeof value.targetToleranceLufs === "number" &&
    Number.isFinite(value.targetToleranceLufs) &&
    value.targetToleranceLufs >= 0 &&
    value.targetToleranceLufs <= 24 &&
    typeof value.warningToleranceLufs === "number" &&
    Number.isFinite(value.warningToleranceLufs) &&
    value.warningToleranceLufs >= value.targetToleranceLufs &&
    value.warningToleranceLufs <= 36 &&
    typeof value.maxTruePeakDb === "number" &&
    Number.isFinite(value.maxTruePeakDb) &&
    value.maxTruePeakDb >= -60 &&
    value.maxTruePeakDb <= 6 &&
    typeof value.truePeakGraceDb === "number" &&
    Number.isFinite(value.truePeakGraceDb) &&
    value.truePeakGraceDb >= 0 &&
    value.truePeakGraceDb <= 12 &&
    typeof value.note === "string" &&
    value.note.length <= 1000 &&
    typeof value.recommendedFormat === "string" &&
    value.recommendedFormat.length <= 160 &&
    typeof value.intendedUse === "string" &&
    value.intendedUse.length <= 1000
  );
}

function post(jobId: number, type: string, details: Record<string, unknown> = {}): void {
  scope.postMessage({ type, jobId, ...details });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "The browser MP3 decoder failed.";
}

function bytesStartWithTag(bytes: Uint8Array, offset: number): boolean {
  return offset + 3 <= bytes.length && bytes[offset] === 0x54 && bytes[offset + 1] === 0x41 && bytes[offset + 2] === 0x47;
}

async function run(jobId: number, blob: Blob, expected: { sampleRate: number; channels: number }, profile: MasterProfile) {
  const Decoder = scope.AudioDecoder;
  const EncodedChunk = scope.EncodedAudioChunk;
  if (!Decoder || !EncodedChunk) {
    post(jobId, "MP3_ANALYSIS_UNSUPPORTED", { reason: "This browser does not expose the WebCodecs audio decoder in workers." });
    return;
  }

  const config: AudioDecoderConfig = {
    codec: "mp3",
    sampleRate: expected.sampleRate,
    numberOfChannels: expected.channels,
  };
  let support: AudioDecoderSupport;
  try {
    support = await Decoder.isConfigSupported(config);
  } catch (error) {
    post(jobId, "MP3_ANALYSIS_UNSUPPORTED", { reason: `MP3 WebCodecs capability check failed: ${errorText(error)}` });
    return;
  }
  if (!support.supported) {
    post(jobId, "MP3_ANALYSIS_UNSUPPORTED", { reason: "This browser does not support MP3 through WebCodecs." });
    return;
  }

  let analyzer: MasterAnalysisAccumulator;
  try {
    analyzer = new MasterAnalysisAccumulator(expected.sampleRate, expected.channels, profile);
  } catch (error) {
    post(jobId, "MP3_ANALYSIS_ERROR", { message: `Could not initialize the MP3 analyzer: ${errorText(error)}` });
    return;
  }

  let decodedFrames = 0;
  let decodeError: string | null = null;
  const frameScratch = new Float64Array(expected.channels);
  let decoder: AudioDecoder;
  try {
    decoder = new Decoder({
      output(audioData) {
        try {
          if (
            audioData.sampleRate !== expected.sampleRate ||
            audioData.numberOfChannels !== expected.channels ||
            !Number.isSafeInteger(audioData.numberOfFrames) ||
            audioData.numberOfFrames <= 0
          ) {
            throw new Error("The MP3 decoder changed the file sample rate, channel count or frame layout.");
          }
          if (decodedFrames + audioData.numberOfFrames > expected.sampleRate * MAX_ANALYSIS_SECONDS) {
            throw new Error(`Master analysis is limited to ${MAX_ANALYSIS_SECONDS / 3600} hours per file.`);
          }
          const planes = Array.from({ length: expected.channels }, (_, channel) => {
            const samples = new Float32Array(audioData.allocationSize({ format: "f32-planar", planeIndex: channel }));
            audioData.copyTo(samples, { format: "f32-planar", planeIndex: channel });
            return samples;
          });
          for (let frame = 0; frame < audioData.numberOfFrames; frame++) {
            for (let channel = 0; channel < expected.channels; channel++) frameScratch[channel] = planes[channel][frame];
            analyzer.processFrame(frameScratch);
          }
          decodedFrames += audioData.numberOfFrames;
        } catch (error) {
          decodeError = errorText(error);
        } finally {
          audioData.close();
        }
      },
      error(error) {
        decodeError = errorText(error);
      },
    });
    decoder.configure(config);
  } catch (error) {
    post(jobId, "MP3_ANALYSIS_UNSUPPORTED", { reason: `The browser could not configure its MP3 decoder: ${errorText(error)}` });
    return;
  }

  const maximumFrames = expected.sampleRate * MAX_ANALYSIS_SECONDS;
  let readOffset = 0;
  let carry = new Uint8Array(0);
  let firstHeader: Mp3FrameHeader | null = null;
  let encodedFrames = 0;
  let timestampUs = 0;
  let trailingTag = false;
  let failed = "";
  try {
    const initialHeader = await blob.slice(0, Math.min(10, blob.size)).arrayBuffer();
    readOffset = mp3AudioStartOffset(initialHeader);
    if (!Number.isSafeInteger(readOffset) || readOffset < 0 || readOffset >= blob.size) {
      throw new Error("The MP3 ID3 tag contains no following audio frames.");
    }

    while (readOffset < blob.size) {
      const blockStart = readOffset;
      const block = new Uint8Array(await blob.slice(blockStart, Math.min(blob.size, blockStart + READ_BLOCK_BYTES)).arrayBuffer());
      if (block.length === 0) break;
      readOffset += block.length;
      const combined = new Uint8Array(carry.length + block.length);
      combined.set(carry);
      combined.set(block, carry.length);
      const baseOffset = blockStart - carry.length;
      const view = new DataView(combined.buffer, combined.byteOffset, combined.byteLength);
      let cursor = 0;
      let awaitingMore = false;

      while (cursor + 4 <= combined.length) {
        const header = parseMp3FrameHeader(view, cursor);
        if (!header) {
          const absoluteOffset = baseOffset + cursor;
          if (encodedFrames === 0 && cursor < 64 * 1024) {
            cursor++;
            continue;
          }
          if (bytesStartWithTag(combined, cursor) && absoluteOffset + 128 === blob.size) {
            trailingTag = true;
            cursor = combined.length;
            break;
          }
          if (readOffset === blob.size && combined.length - cursor < 4) {
            awaitingMore = true;
            break;
          }
          throw new Error(`Invalid or truncated MP3 frame sequence at byte ${absoluteOffset}.`);
        }
        if (!firstHeader) firstHeader = header;
        else if (!sameMp3Stream(firstHeader, header)) throw new Error("The MP3 changes sample rate, channel count or MPEG version mid-file.");
        if (header.sampleRate !== expected.sampleRate || header.channels !== expected.channels) {
          throw new Error("The MP3 frame layout differs from its inspected metadata.");
        }
        if (header.frameBytes < 4 || cursor + header.frameBytes > combined.length) {
          awaitingMore = true;
          break;
        }
        if (encodedFrames >= maximumFrames / header.samplesPerFrame + 1) {
          throw new Error(`Master analysis is limited to ${MAX_ANALYSIS_SECONDS / 3600} hours per file.`);
        }
        const frameData = combined.slice(cursor, cursor + header.frameBytes);
        decoder.decode(
          new EncodedChunk({
            type: "key",
            timestamp: timestampUs,
            duration: Math.round((header.samplesPerFrame * 1_000_000) / header.sampleRate),
            data: frameData,
          }),
        );
        timestampUs += Math.round((header.samplesPerFrame * 1_000_000) / header.sampleRate);
        encodedFrames++;
        cursor += header.frameBytes;
        if (decodeError) throw new Error(decodeError);
        if (decoder.decodeQueueSize >= MAX_DECODE_QUEUE) await decoder.flush();
        if (decodeError) throw new Error(decodeError);
      }

      carry = awaitingMore ? combined.slice(cursor) : combined.slice(cursor);
      post(jobId, "MP3_ANALYSIS_PROGRESS", {
        progress: Math.min(0.8, (readOffset / blob.size) * 0.8),
        stage: "Decoding and analyzing MP3 frames in bounded worker blocks",
      });
      if (trailingTag) break;
      if (readOffset === blob.size) break;
    }

    if (encodedFrames === 0 || !firstHeader) throw new Error("No valid MPEG Layer III frames were found in the MP3 file.");
    if (!trailingTag && carry.length > 0) {
      const isCompleteTrailingId3 = carry.length >= 3 && bytesStartWithTag(carry, 0) && readOffset + 128 === blob.size;
      if (!isCompleteTrailingId3) throw new Error("The MP3 ends with an incomplete audio frame.");
      trailingTag = true;
    }
    await decoder.flush();
    if (decodeError) throw new Error(decodeError);
    if (decodedFrames === 0) throw new Error("The MP3 decoder returned no audio samples.");
    const onProgress: MasterAnalysisProgressListener = ({ progress, stage }) =>
      post(jobId, "MP3_ANALYSIS_PROGRESS", { progress: 0.8 + Math.max(0, Math.min(1, progress)) * 0.2, stage });
    const analysis: MasterBufferAnalysis = analyzer.finish(onProgress);
    post(jobId, "MP3_ANALYSIS_RESULT", {
      analysis,
      sampleRate: expected.sampleRate,
      channels: expected.channels,
      durationSeconds: decodedFrames / expected.sampleRate,
      frameCount: decodedFrames,
    });
  } catch (error) {
    failed = errorText(error);
  } finally {
    try {
      decoder.close();
    } catch {
      // A decoder that failed during flush may already be closed.
    }
  }
  if (failed) post(jobId, "MP3_ANALYSIS_ERROR", { message: failed });
}

scope.onmessage = (event) => {
  const value: unknown = event.data;
  if (!isRecord(value) || value.type !== "MP3_ANALYSIS_START") return;
  const { jobId, blob, file, profile } = value;
  if (
    typeof jobId !== "number" ||
    !Number.isSafeInteger(jobId) ||
    jobId <= 0 ||
    typeof Blob === "undefined" ||
    !(blob instanceof Blob) ||
    blob.size < 4 ||
    !isRecord(file) ||
    typeof file.sampleRate !== "number" ||
    !Number.isInteger(file.sampleRate) ||
    file.sampleRate < 8000 ||
    file.sampleRate > 48000 ||
    typeof file.channels !== "number" ||
    !Number.isInteger(file.channels) ||
    file.channels < 1 ||
    file.channels > 2 ||
    !isProfile(profile)
  ) {
    if (typeof jobId === "number" && Number.isSafeInteger(jobId) && jobId > 0)
      post(jobId, "MP3_ANALYSIS_ERROR", { message: "Invalid MP3 mastering analysis request." });
    return;
  }
  void run(jobId, blob, { sampleRate: file.sampleRate, channels: file.channels }, profile).catch((error: unknown) => {
    post(jobId, "MP3_ANALYSIS_ERROR", { message: errorText(error) });
  });
};
