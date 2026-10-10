import { canEncodeAudio, Quality } from "mediabunny";
import type { CompressedAudioCodec, CompressedAudioSupportOptions } from "./compressed-audio-capabilities";

/**
 * Keep the capability probe behind its own dynamic import. Importing the
 * Mediabunny package namespace dynamically retains every public export; this
 * named import lets Vite tree-shake the probe down to the audio encoder path.
 */
export async function probeCompressedAudioCodec(
  codec: CompressedAudioCodec,
  options: Required<CompressedAudioSupportOptions>,
): Promise<boolean> {
  return canEncodeAudio(codec, {
    sampleRate: options.sampleRate,
    numberOfChannels: options.numberOfChannels,
    quality: new Quality(options.quality),
  });
}
