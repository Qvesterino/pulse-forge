/**
 * Capability table for the lossy share/web delivery formats (OGG + M4A).
 *
 * Both codecs are encoded through the WebCodecs `AudioEncoder` via Mediabunny,
 * so availability is a *runtime* question, not a build-time constant:
 *
 * - Opus encoding is broadly available (Chromium, Firefox desktop, Safari 26+).
 * - AAC encoding is missing in Firefox on every platform and in every browser
 *   on desktop Linux; Safari only gained `AudioEncoder` in Safari 26.
 * - WebCodecs audio encoding is not in Firefox for Android at all.
 *
 * Every surface that offers these formats must probe first and hide what the
 * browser cannot actually produce — an export option that always fails is worse
 * than a missing one.
 *
 * Mediabunny is imported *dynamically* on purpose: `ExportPanel` is part of the
 * eager DAW chunk, while `src/export/flac.ts` keeps its static Mediabunny import
 * inside a lazily loaded module (see `flac-loader.ts`). A static import here
 * would pull the whole media library into the entry bundle for a panel mount.
 */

export type CompressedAudioCodec = "opus" | "aac";

export interface CompressedAudioFormat {
  id: CompressedAudioFormatId;
  codec: CompressedAudioCodec;
  /** Menu label, including the use case. */
  label: string;
  /** File extension written to disk (no leading dot). */
  extension: string;
  /** Blob MIME type handed to the download. */
  mimeType: string;
}

export type CompressedAudioFormatId = "ogg-opus" | "m4a-aac";

export const COMPRESSED_AUDIO_FORMATS: readonly CompressedAudioFormat[] = [
  {
    id: "ogg-opus",
    codec: "opus",
    label: "OGG (Opus · web)",
    extension: "ogg",
    mimeType: "audio/ogg",
  },
  {
    id: "m4a-aac",
    codec: "aac",
    label: "M4A (AAC · phones)",
    extension: "m4a",
    mimeType: "audio/mp4",
  },
];

export function findCompressedAudioFormat(id: CompressedAudioFormatId): CompressedAudioFormat {
  const format = COMPRESSED_AUDIO_FORMATS.find((candidate) => candidate.id === id);
  if (!format) throw new Error(`Unknown compressed audio target: ${id}`);
  return format;
}

/**
 * Rates these formats are offered at. Deliberately identical to MP3's ceiling
 * (`mp3-capabilities.ts`): AAC has native support for both, and Mediabunny
 * resamples anything else for Opus, so widening this adds render cost without
 * adding a delivery option a user actually asked for.
 */
export const COMPRESSED_AUDIO_SAMPLE_RATES = [44_100, 48_000] as const;

export function isCompressedAudioSampleRateSupported(sampleRate: number): boolean {
  return Number.isInteger(sampleRate) && (COMPRESSED_AUDIO_SAMPLE_RATES as readonly number[]).includes(sampleRate);
}

/**
 * Whether this browser can encode `codec`, or `false` when the WebCodecs
 * surface is missing entirely. Never throws: a browser without `AudioEncoder`
 * is a supported configuration, not an error.
 */
export async function canEncodeCompressedAudio(codec: CompressedAudioCodec): Promise<boolean> {
  if (typeof AudioEncoder === "undefined") return false;
  try {
    const { canEncodeAudio } = await import("mediabunny");
    return await canEncodeAudio(codec);
  } catch {
    return false;
  }
}

/** The formats this browser can actually produce, in menu order. */
export async function supportedCompressedAudioFormats(): Promise<CompressedAudioFormat[]> {
  const results = await Promise.all(
    COMPRESSED_AUDIO_FORMATS.map(async (format) => ((await canEncodeCompressedAudio(format.codec)) ? format : null)),
  );
  return results.filter((format): format is CompressedAudioFormat => format !== null);
}

/** Human-readable reason shown next to a format this browser cannot encode. */
export function compressedAudioUnavailableReason(format: CompressedAudioFormat): string {
  return format.codec === "aac"
    ? "AAC encoding needs WebCodecs — unavailable in Firefox and on desktop Linux."
    : "Opus encoding needs WebCodecs, which this browser does not expose.";
}
