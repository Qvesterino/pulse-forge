import type { UserSampleAsset } from "../persistence/UserSampleRepository";
import { userSampleId } from "../persistence/UserSampleRepository";
import { detectLoopBpm } from "../audio-engine/bpm-detect";
import type { Services } from "../services";
import { assertAudioImportSize } from "../audio-import-capabilities";
import { persistBankBuffer } from "../sample-library/bank-persist";

/**
 * Decode one audio File into a playable, persisted user sample — the exact
 * DropZone per-file body, extracted so the SEND-TO-KYX intake tray and the
 * TSAR forge import through the SAME path (same persistence, same BPM probe).
 * Throws on decode/persist failure; the caller owns the error surface.
 *
 * The size ceiling is enforced HERE rather than at each call site on purpose:
 * this function is reached from the drop zone, the network intake tray and the
 * forge file picker, and the ceiling is what stops a hostile or merely huge
 * file from reaching `decodeAudioData` (decoded PCM is 5–10× the encoded
 * bytes). A guard that only the drag-and-drop path applies is not a guard.
 * Extension acceptance lives in `audio-import-capabilities.ts` and is applied
 * by the surfaces that show a file picker or receive a drop.
 */
export async function importAudioFile(services: Services, file: File): Promise<UserSampleAsset> {
  const ctx = services.engine.context;
  if (!ctx) throw new Error("Audio engine not ready");
  // Before arrayBuffer(): reading an oversized file first is the failure mode
  // the ceiling exists to prevent.
  assertAudioImportSize(file.size);
  // Read the encoded bytes once: decodeAudioData detaches the buffer it
  // receives, so hand it a copy and keep the original for IDB.
  const raw = await file.arrayBuffer();
  const buffer = await ctx.decodeAudioData(raw.slice(0));
  const id = userSampleId(file.name);

  // One-time tempo detection for the "Fit to project BPM" workflow.
  // Best-effort: a failed/absent detection just leaves `bpm` unset.
  let bpm: number | undefined;
  try {
    const detected = detectLoopBpm(buffer.getChannelData(0), buffer.sampleRate);
    if (detected) bpm = detected.bpm;
  } catch (err) {
    console.warn("[sample-import] bpm detection failed:", err);
  }

  // Persist metadata + encoded bytes (survives reloads since DB v5). The
  // buffer is added to the audio bank (immediately playable) by the helper,
  // which rolls it back on persistence failure so the in-memory bank and the
  // on-disk library cannot disagree.
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
  await persistBankBuffer(services.bank, id, buffer, () => services.userSamples.save(asset, raw));
  return asset;
}
