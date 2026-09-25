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
