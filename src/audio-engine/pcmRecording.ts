import type { RecordingPcmChunk, RecordingSession } from "../persistence/RecordingRecoveryRepository";
import type { IRecordingRecoveryRepository } from "../persistence/contracts";

export interface MaterializedPcmTake {
  session: RecordingSession;
  buffer: AudioBuffer;
  /** What the take actually contains (audit R-1). */
  silence: PcmSilenceMeasurement;
}

/**
 * What a materialized take actually contains (audit R-1).
 *
 * A take whose audio is digital silence is still a take as far as the frame
 * count is concerned — and the frame count was the ONLY gate. A muted input, a
 * device that delivered nothing, a capture that never started: each produced a
 * take that looked like any other and sounded like nothing. The measurement
 * is what lets the app SAY so.
 */
export interface PcmSilenceMeasurement {
  /** The highest absolute sample value in the take. */
  peak: number;
  /** The root-mean-square level of the take. */
  rms: number;
  /** True when the take carries no signal at all. */
  silent: boolean;
}

/**
 * Below this peak a take is digital silence (about -100 dBFS). Any real
 * recording — even a quiet room, even a whisper at the noise floor — is well
 * above it.
 */
export const PCM_SILENCE_PEAK_THRESHOLD = 1e-5;

/**
 * Measure a materialized take. Exact, not strided: a take can be minutes
 * long, and this runs once when the user stops the recording — never on the
 * audio thread.
 */
export function measurePcmSilence(buffer: AudioBuffer): PcmSilenceMeasurement {
  let peak = 0;
  let sumSquares = 0;
  let frames = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    let data: Float32Array | null = null;
    try {
      data = buffer.getChannelData(channel);
    } catch {
      // A buffer without readable channel data carries no signal — the
      // alignment path treats the same case as "nothing to align".
      continue;
    }
    if (!data) continue;
    frames += data.length;
    for (let index = 0; index < data.length; index += 1) {
      const sample = data[index] ?? 0;
      const magnitude = Math.abs(sample);
      if (magnitude > peak) peak = magnitude;
      sumSquares += sample * sample;
    }
  }
  const rms = frames > 0 ? Math.sqrt(sumSquares / frames) : 0;
  return { peak, rms, silent: peak <= PCM_SILENCE_PEAK_THRESHOLD };
}

/**
 * Materialize only after capture has stopped. The durable store is visited
 * one half-second block at a time; no full-take encoded file or lossy codec pass
 * is created. Samples are copied unchanged into the AudioBuffer.
 */
export async function materializePcmTake(
  recovery: IRecordingRecoveryRepository,
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

  const takeBoundaries: number[] = [];
  await recovery.forEachChunk(sessionId, (chunk, frameOffset) => {
    copyChunkToBuffer(buffer, chunk, frameOffset);
    const localBoundaries = chunk.takeBoundaries ?? [];
    if (
      !Array.isArray(localBoundaries) ||
      localBoundaries.some(
        (frame, index) =>
          !Number.isSafeInteger(frame) ||
          frame < 0 ||
          frame >= chunk.frames ||
          (index > 0 && frame <= localBoundaries[index - 1]!),
      )
    ) {
      throw new Error("Saved loop-take boundary metadata is invalid");
    }
    for (const frame of localBoundaries) {
      const absoluteFrame = frameOffset + frame;
      if (absoluteFrame <= (takeBoundaries[takeBoundaries.length - 1] ?? -1)) {
        throw new Error("Saved loop-take boundaries are out of order");
      }
      takeBoundaries.push(absoluteFrame);
    }
  });
  return {
    session: { ...session, ...(takeBoundaries.length ? { takeBoundaries } : {}) },
    buffer,
    silence: measurePcmSilence(buffer),
  };
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
