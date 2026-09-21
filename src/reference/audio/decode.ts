/**
 * Reference audio decoding.
 *
 * Unlike audiokey `src/audio/decodeAudio.ts` (which owns a shared
 * `AudioContext`), KYX must decode through the shared engine context:
 * `AudioEngine.useContext()` is the only path that creates AudioNodes on a
 * context, so a caller passes `services.engine.context`. This module only
 * wraps `decodeAudioData` with typed errors and extracts channel copies.
 */

export interface DecodedReference {
  channels: Float32Array[];
  sampleRate: number;
  duration: number;
  length: number;
}

export class ReferenceDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferenceDecodeError";
  }
}

export async function decodeReferenceFile(
  file: File,
  context: AudioContext | OfflineAudioContext,
): Promise<DecodedReference> {
  let arrayBuffer: ArrayBuffer;
  try {
    arrayBuffer = await file.arrayBuffer();
  } catch {
    throw new ReferenceDecodeError("The file could not be read.");
  }
  if (arrayBuffer.byteLength === 0) {
    throw new ReferenceDecodeError("The file is empty.");
  }

  let buffer: AudioBuffer;
  try {
    buffer = await context.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    throw new ReferenceDecodeError("This file could not be decoded by your browser. Try WAV, MP3, FLAC, OGG or M4A.");
  }
  if (buffer.length === 0) {
    throw new ReferenceDecodeError("The decoded audio contains no samples.");
  }

  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(buffer.getChannelData(c).slice());
  }

  return {
    channels,
    sampleRate: buffer.sampleRate,
    duration: buffer.duration,
    length: buffer.length,
  };
}
