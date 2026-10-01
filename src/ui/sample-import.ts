import type { UserSampleAsset } from "../persistence/UserSampleRepository";
import { userSampleId } from "../persistence/UserSampleRepository";
import { detectLoopBpm } from "../audio-engine/bpm-detect";
import type { Services } from "../services";

/** Identical acceptance rules to the DropZone (single source via this helper —
 * both the drag-and-drop path and the SEND-TO-KYX intake tray import here). */
export const ACCEPTED_IMPORT_EXTENSIONS = /\.(wav|mp3|ogg|flac|aiff|opus)$/i;

/** Import ceiling mirrored from DropZone (decoded PCM is ~5–10× the file size). */
export const MAX_AUDIO_IMPORT_BYTES = 25 * 1024 * 1024;

/**
 * Decode one audio File into a playable, persisted user sample — the exact
 * DropZone per-file body, extracted so the SEND-TO-KYX intake tray imports
 * through the SAME path (same acceptance, same persistence, same BPM probe).
 * Throws on decode/persist failure; the caller owns the error surface.
 */
export async function importAudioFile(services: Services, file: File): Promise<UserSampleAsset> {
  const ctx = services.engine.context;
  if (!ctx) throw new Error("Audio engine not ready");
  // Read the encoded bytes once: decodeAudioData detaches the buffer it
  // receives, so hand it a copy and keep the original for IDB.
  const raw = await file.arrayBuffer();
  const buffer = await ctx.decodeAudioData(raw.slice(0));
  const id = userSampleId(file.name);

  // Add to audio bank (immediately playable)
  services.bank.add(id, buffer);

  // One-time tempo detection for the "Fit to project BPM" workflow.
  // Best-effort: a failed/absent detection just leaves `bpm` unset.
  let bpm: number | undefined;
  try {
    const detected = detectLoopBpm(buffer.getChannelData(0), buffer.sampleRate);
    if (detected) bpm = detected.bpm;
  } catch (err) {
    console.warn("[sample-import] bpm detection failed:", err);
  }

  // Persist metadata + encoded bytes (survives reloads since DB v5)
  const asset: UserSampleAsset = {
    id,
    name: file.name.replace(/\.[^.]+$/, ""),
    fileName: file.name,
    category: "Custom",
    duration: buffer.duration,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    createdAt: new Date().toISOString(),
    ...(bpm !== undefined ? { bpm } : {}),
  };
  await services.userSamples.save(asset, raw);
  return asset;
}
