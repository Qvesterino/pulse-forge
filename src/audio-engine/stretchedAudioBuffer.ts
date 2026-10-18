import { timeStretch } from "./time-stretch";

/** Render the same bounded, deterministic pitch-preserving buffer used by
 * AudioClip playback so auditions and inserted clips can share its cache. */
export function renderStretchedAudioBuffer(
  ctx: BaseAudioContext,
  source: AudioBuffer,
  stretchRate: number,
  reverse = false,
): AudioBuffer {
  const sampleRate = source.sampleRate;
  const channels = source.numberOfChannels;
  const stretchFactor = Math.min(4, Math.max(0.25, stretchRate));
  const outputFrames = Math.max(1, Math.round(source.duration * stretchFactor * sampleRate));
  const output = ctx.createBuffer(channels, outputFrames, sampleRate);

  for (let channel = 0; channel < channels; channel++) {
    const input = source.getChannelData(channel);
    const stretched = timeStretch(input, sampleRate, stretchFactor);
    // timeStretch can return its input unchanged on fallback paths; reversing
    // that shared bank data in place would corrupt every later playback.
    const rendered = reverse ? (stretched === input ? stretched.slice() : stretched).reverse() : stretched;
    output.getChannelData(channel).set(rendered);
  }

  return output;
}
