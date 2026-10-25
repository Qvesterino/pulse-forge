import type { Services } from "../services";
import { decodeAudioData } from "../services/audio-decode";
import { isPcmRecordingAudio, type PcmRecordingAudioRef } from "../persistence/UserSampleRepository";

function isBlob(value: ArrayBuffer | Blob): value is Blob {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Blob).arrayBuffer === "function" &&
    typeof (value as Blob).size === "number"
  );
}

function toMono(buffer: AudioBuffer): { mono: Float32Array; sampleRate: number } {
  const channels = buffer.numberOfChannels;
  const mono = new Float32Array(buffer.length);
  if (channels <= 0) return { mono, sampleRate: buffer.sampleRate };
  for (let channel = 0; channel < channels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++) mono[i] += data[i]!;
  }
  if (channels > 1) {
    for (let i = 0; i < mono.length; i++) mono[i] /= channels;
  }
  return { mono, sampleRate: buffer.sampleRate };
}

/**
 * kyx_unsuno's PCM loader. A live KYX session already restores user samples
 * into the SampleBank at boot, so the common path is a bank hit. The fallback
 * reads the repository entry directly (encoded bytes or a durable PCM
 * recording reference) and decodes it — this is what makes transcribe work
 * for a sample imported after the boot restore completed.
 */
export async function loadUserSampleMono(
  services: Pick<Services, "bank" | "userSamples">,
  sampleId: string,
  decode: (bytes: ArrayBuffer) => Promise<AudioBuffer> = (bytes) => decodeAudioData(bytes),
  materialize?: (reference: PcmRecordingAudioRef) => Promise<AudioBuffer>,
): Promise<{ mono: Float32Array; sampleRate: number } | null> {
  const materializePcm =
    materialize ??
    (async (reference: PcmRecordingAudioRef) => {
      const { RecordingRecoveryRepository } = await import("../persistence/RecordingRecoveryRepository");
      return new RecordingRecoveryRepository().materializeStoredSample(reference);
    });
  const id = sampleId.trim();
  if (id === "") return null;
  let buffer = services.bank.get(id);
  if (buffer == null) {
    const data = await services.userSamples.loadAudio(id).catch(() => undefined);
    if (data == null) return null;
    buffer = isPcmRecordingAudio(data)
      ? await materializePcm(data)
      : await decode(isBlob(data) ? await data.arrayBuffer() : (data as ArrayBuffer));
    if (buffer == null) return null;
    services.bank.add(id, buffer);
  }
  return toMono(buffer);
}
