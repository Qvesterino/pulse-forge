import type {
  RecordingPcmChunk,
  RecordingSession,
  RecordingRecoveryRepository,
} from "../persistence/RecordingRecoveryRepository";

export interface MaterializedPcmTake {
  session: RecordingSession;
  buffer: AudioBuffer;
}

/**
 * Materialize only after capture has stopped. The durable store is visited
 * one ~second block at a time; no full-take encoded file or lossy codec pass
 * is created. Samples are copied unchanged into the AudioBuffer.
 */
export async function materializePcmTake(
  recovery: RecordingRecoveryRepository,
  sessionId: string,
  context: BaseAudioContext,
): Promise<MaterializedPcmTake> {
  const session = await recovery.get(sessionId);
  if (!session || session.totalFrames <= 0) throw new Error("No recoverable audio was captured");
  if (
    !Number.isInteger(session.channels) ||
    session.channels < 1 ||
    session.channels > 32 ||
    !Number.isInteger(session.sampleRate) ||
    session.sampleRate < 8_000 ||
    session.sampleRate > 384_000 ||
    !Number.isSafeInteger(session.totalFrames)
  ) {
    throw new Error("Saved PCM recording metadata is invalid");
  }
  let buffer: AudioBuffer;
  try {
    buffer = context.createBuffer(session.channels, session.totalFrames, session.sampleRate);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`This take is saved safely but is too large to open as an in-memory audio clip${detail}`);
  }

  await recovery.forEachChunk(sessionId, (chunk, frameOffset) => {
    copyChunkToBuffer(buffer, chunk, frameOffset);
  });
  return { session, buffer };
}

function copyChunkToBuffer(buffer: AudioBuffer, chunk: RecordingPcmChunk, frameOffset: number): void {
  if (chunk.channels.length !== buffer.numberOfChannels || frameOffset + chunk.frames > buffer.length)
    throw new Error("Recording block dimensions do not match the saved session");
  for (let channel = 0; channel < chunk.channels.length; channel++) {
    const data = new Float32Array(chunk.channels[channel]);
    if (data.length !== chunk.frames) throw new Error("Recording block has an invalid frame count");
    buffer.getChannelData(channel).set(data, frameOffset);
  }
}
