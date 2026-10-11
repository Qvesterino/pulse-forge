/**
 * Single source of truth for which audio files KYX accepts on EVERY import
 * path, and the ceiling that bounds what a decode may cost in memory.
 *
 * This module exists because the acceptance rules used to live in four places
 * — `DropZone`, `sample-import`, `ReferenceMapPanel` — with three different
 * lists, a "single source" constant that nothing imported, and no test pinning
 * any of them. A new format added to one surface silently failed to appear in
 * the others, and KYX could export a format its own library refused to re-open.
 *
 * **Import is gated by DECODING, not encoding.** That asymmetry is deliberate
 * and is why this list is wider than the export menu: browsers decode AAC/M4A
 * in essentially every engine (Firefox included, via platform codecs) even
 * though they mostly cannot *encode* it. See `compressed-audio-capabilities.ts`
 * for the encode-side gaps. Never copy this list from the export side, and
 * never narrow it to match what KYX can write.
 *
 * Nothing here validates that a file *is* audio — the browser's
 * `decodeAudioData` is the authority, exactly as on the export side where the
 * muxer is. This module only answers "is this shape of file worth attempting".
 */

/**
 * Import ceiling. Decoded PCM is roughly 5–10× the encoded size, so a 25 MB
 * file can cost a few hundred MB of Float32 — enough to kill a tab. Mirrors
 * the documented limit in AGENTS.md; the bound lives here rather than in a UI
 * component so every path that reaches a decode inherits it.
 */
export const MAX_AUDIO_IMPORT_BYTES = 25 * 1024 * 1024;

/** Named so callers can distinguish "too big" from "could not decode". */
export class AudioImportTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`Audio file is ${(bytes / 1024 / 1024).toFixed(1)} MB — the import limit is 25 MB.`);
    this.name = "AudioImportTooLargeError";
  }
}

/** Extensions worth handing to `decodeAudioData`. Kept lowercase, no dot. */
export const AUDIO_IMPORT_EXTENSIONS = [
  "wav",
  "wave",
  "mp3",
  "ogg",
  "oga",
  "opus",
  "flac",
  "aiff",
  "aif",
  "aifc",
  "m4a",
  "aac",
  "webm",
] as const;

/**
 * MIME types accepted as an alternative signal to the extension. Browsers and
 * operating systems label the same container half a dozen different ways
 * (`audio/x-wav`, `audio/vnd.wave`, `audio/x-m4a`, …), so the list is
 * deliberately generous — it only has to avoid rejecting files the decoder
 * would have handled.
 */
export const AUDIO_IMPORT_MIME_TYPES = [
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/vnd.wave",
  "audio/mpeg",
  "audio/mp3",
  "audio/ogg",
  "audio/flac",
  "audio/aiff",
  "audio/x-aiff",
  "audio/aif",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/opus",
  "audio/webm",
] as const;

export function audioImportExtension(fileName: string): string | null {
  const match = /\.([a-z0-9]+)$/i.exec(fileName.trim());
  return match ? match[1].toLowerCase() : null;
}

export function isAudioImportExtension(fileName: string): boolean {
  const extension = audioImportExtension(fileName);
  return extension !== null && (AUDIO_IMPORT_EXTENSIONS as readonly string[]).includes(extension);
}

export function isAudioImportMimeType(type: string): boolean {
  if (!type) return false;
  // A parameterised type (`audio/ogg; codecs=opus`) still identifies the format.
  const bare = type.split(";")[0].trim().toLowerCase();
  return (AUDIO_IMPORT_MIME_TYPES as readonly string[]).includes(bare);
}

/** Accept a file if EITHER its extension or its declared MIME type matches. */
export function isAudioImportFile(file: { name: string; type?: string }): boolean {
  return isAudioImportExtension(file.name) || isAudioImportMimeType(file.type ?? "");
}

/** Value for an `<input type="file" accept="…">`. */
export function audioImportAcceptAttribute(): string {
  return AUDIO_IMPORT_EXTENSIONS.map((extension) => `.${extension}`).join(",");
}

/** Short, human-readable list for the drop-zone hint. */
export function describeAudioImportFormats(): string {
  return "WAV · MP3 · OGG · FLAC · AIFF · M4A · OPUS · AAC · WEBM";
}

/**
 * Reject an oversized file BEFORE its bytes are read.
 *
 * This must be called ahead of `arrayBuffer()` on every path. Checking after
 * the read (or only on the drag-and-drop surface) leaves the other callers
 * free to hand an arbitrarily large payload straight to `decodeAudioData`.
 */
export function assertAudioImportSize(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error("Audio import: unreadable file size.");
  if (bytes > MAX_AUDIO_IMPORT_BYTES) throw new AudioImportTooLargeError(bytes);
}

/**
 * Longest base64 payload that can encode a file within the ceiling, including
 * padding. Lets a network intake reject an oversized body from its *encoded*
 * length, before `atob` materialises it in memory.
 */
export function maxAudioImportBase64Chars(): number {
  return Math.ceil((MAX_AUDIO_IMPORT_BYTES + 2) / 3) * 4;
}

/**
 * Decode a base64 audio body, refusing anything the ceiling would reject.
 *
 * Explicitly `Uint8Array<ArrayBuffer>`: the default `ArrayBufferLike` element
 * type is not assignable to `BlobPart`, which is what every caller feeds the
 * result into.
 */
export function base64ToAudioBytes(dataB64: string): Uint8Array<ArrayBuffer> {
  if (dataB64.length > maxAudioImportBase64Chars()) {
    // Upper bound on the decoded size without decoding it.
    throw new AudioImportTooLargeError(Math.floor((dataB64.length * 3) / 4));
  }
  const binary = atob(dataB64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
