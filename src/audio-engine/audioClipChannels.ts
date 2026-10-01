/**
 * Connect an audio clip source either with its full channel layout or with a
 * single source channel routed as mono. Returning the splitter lets callers
 * disconnect the whole branch when the one-shot ends.
 */
export function connectAudioClipSourceChannel(
  context: BaseAudioContext,
  source: AudioBufferSourceNode,
  destination: AudioNode,
  sourceChannel?: number,
): ChannelSplitterNode | null {
  const channelCount = source.buffer?.numberOfChannels ?? 0;
  if (!Number.isSafeInteger(sourceChannel) || sourceChannel! < 0 || sourceChannel! >= channelCount) {
    source.connect(destination);
    return null;
  }

  const splitter = context.createChannelSplitter(channelCount);
  source.connect(splitter);
  splitter.connect(destination, sourceChannel!, 0);
  return splitter;
}

/** Resolve the source PCM used by clip-specific analysis and waveform display. */
export function audioClipChannelData(buffer: AudioBuffer, sourceChannel?: number): Float32Array {
  const channel =
    Number.isSafeInteger(sourceChannel) && sourceChannel! >= 0 && sourceChannel! < buffer.numberOfChannels
      ? sourceChannel!
      : 0;
  return buffer.getChannelData(channel);
}

export interface AudioClipWaveformWindow {
  startSec: number;
  endSec: number;
}

/**
 * The temporal window a clip's waveform must display: the playable content
 * between `offsetSec + trimStart` and `duration - trimEnd` — the same window
 * `audioClipPlayWindow` plays. Drawing the whole buffer instead would misalign
 * the envelope with playback for every recorded take (count-in head trimmed
 * via offsetSec), loop pass and manual trim. Degenerate windows collapse to a
 * minimal span so callers can still render something instead of crashing.
 */
export function audioClipWaveformWindow(
  bufferDurationSec: number,
  offsetSec = 0,
  trimStartSec = 0,
  trimEndSec = 0,
): AudioClipWaveformWindow {
  const duration = Number.isFinite(bufferDurationSec) ? bufferDurationSec : 0;
  const start =
    Math.max(0, Number.isFinite(offsetSec) ? offsetSec : 0) +
    Math.max(0, Number.isFinite(trimStartSec) ? trimStartSec : 0);
  const end = duration - Math.max(0, Number.isFinite(trimEndSec) ? trimEndSec : 0);
  if (duration <= 0) return { startSec: 0, endSec: 0 };
  if (end - start >= 0.001) return { startSec: start, endSec: Math.min(end, duration) };
  // Offset/trims consume the entire buffer: show the last audible sliver.
  const clampedStart = Math.min(start, duration - 0.001);
  return { startSec: Math.max(0, clampedStart), endSec: Math.max(Math.max(0, clampedStart) + 0.001, duration) };
}
