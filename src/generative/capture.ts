import type { IUserSampleRepository } from "../persistence/contracts";
import { sanitizeFilename } from "../rendering/wav";
import { addAudioClip } from "../commands/commands";
import type { Command } from "../commands/types";
import type { AudioClip, ProjectDocument } from "../project-model/types";
import type { GeneratedAudio } from "./types";

function assertAudioShape(audio: GeneratedAudio): void {
  if (!Number.isInteger(audio.sampleRate) || audio.sampleRate <= 0) throw new Error("Generated sample rate is invalid");
  if (!Number.isInteger(audio.channels) || audio.channels < 1 || audio.channels > 2) {
    throw new Error("Generated channel count is invalid");
  }
  if (!Number.isInteger(audio.frames) || audio.frames <= 0) throw new Error("Generated frame count is invalid");
  if (audio.data.length !== audio.frames * audio.channels)
    throw new Error("Generated PCM length does not match metadata");
  for (const sample of audio.data) {
    if (!Number.isFinite(sample)) throw new Error("Generated PCM contains a non-finite sample");
  }
}

/** Encode interleaved finite PCM as a compact RIFF/WAVE 32-bit float asset. */
export function generatedAudioToWav(audio: GeneratedAudio): ArrayBuffer {
  assertAudioShape(audio);
  const bytesPerSample = 4;
  const blockAlign = audio.channels * bytesPerSample;
  const dataSize = audio.frames * blockAlign;
  if (dataSize > 0xffffffff - 44) throw new Error("Generated audio is too large for a WAV asset");
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);
  const text = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // IEEE float
  view.setUint16(22, audio.channels, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 32, true);
  text(36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (const sample of audio.data) {
    view.setFloat32(offset, sample, true);
    offset += bytesPerSample;
  }
  return out;
}

export interface PersistedGeneratedAudio {
  asset: {
    id: string;
    name: string;
    fileName: string;
    category: "Custom";
    duration: number;
    sampleRate: number;
    channels: number;
    createdAt: string;
    origin: "generated";
    generated: { providerId: string; modelId: string; inputHash: string };
  };
  wav: ArrayBuffer;
}

export async function persistGeneratedAudio(
  repository: IUserSampleRepository,
  audio: GeneratedAudio,
  name: string,
  options: { assetId: string; createdAt?: string },
): Promise<PersistedGeneratedAudio["asset"]> {
  assertAudioShape(audio);
  if (!options.assetId || options.assetId.length > 200) throw new Error("Generated asset id is invalid");
  const safeName = name.trim().slice(0, 80) || "Generated audio";
  const asset = {
    id: options.assetId,
    name: safeName,
    fileName: `${sanitizeFilename(safeName)}.wav`,
    category: "Custom" as const,
    duration: audio.durationSec,
    sampleRate: audio.sampleRate,
    channels: audio.channels,
    createdAt: options.createdAt ?? new Date().toISOString(),
    origin: "generated" as const,
    generated: { providerId: audio.providerId, modelId: audio.modelId, inputHash: audio.inputHash },
  };
  await repository.save(asset, generatedAudioToWav(audio));
  return asset;
}

export interface GeneratedClipPlacement {
  trackId: string;
  startBar: number;
  lengthBars: number;
  patch?: Partial<Omit<AudioClip, "id" | "trackId" | "bufferId" | "startBar" | "lengthBars">>;
}

export interface PersistedGeneratedClip {
  asset: PersistedGeneratedAudio["asset"];
  wav: ArrayBuffer;
  command: Command;
}

/**
 * Persist a generated take and return the regular AudioClip command that can
 * be committed by ProjectStore. The document remains untouched until the
 * caller executes the returned command, preserving normal undo/redo rules.
 */
export async function persistGeneratedAudioAsClip(
  repository: IUserSampleRepository,
  doc: ProjectDocument,
  audio: GeneratedAudio,
  name: string,
  options: { assetId: string; createdAt?: string; placement: GeneratedClipPlacement },
): Promise<PersistedGeneratedClip> {
  const { placement } = options;
  const wav = generatedAudioToWav(audio);
  const command = addAudioClip(
    doc,
    placement.trackId,
    options.assetId,
    placement.startBar,
    placement.lengthBars,
    placement.patch,
  );
  const asset = await persistGeneratedAudio(repository, audio, name, {
    assetId: options.assetId,
    ...(options.createdAt !== undefined ? { createdAt: options.createdAt } : {}),
  });
  return { asset, wav, command };
}
