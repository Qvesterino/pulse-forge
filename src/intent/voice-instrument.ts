/**
 * VOICE INSTRUMENT — the artist's own sound BECOMES the playable instrument
 * (Hum-to-Beat W3, IDEA 2.0).
 *
 * The recorded take is trimmed, normalized and stored as a user sample; a
 * "Voice Lead" sampler track is created whose ROOT NOTE is the median
 * hummed pitch — so the hummed melody plays back through the artist's OWN
 * timbre, pitch-shifted per note by the sampler. The whole install is one
 * undoable command; nothing leaves the machine (user samples live in
 * IndexedDB and restore into the local SampleBank).
 *
 * Deterministic ids where tests need them (caller may pass explicit ids);
 * the audio pipeline is pure math — trim points, normalize gain and the
 * WAV bytes are fully reproducible from the same take.
 */
import { userSampleId, UserSampleRepository, type UserSampleAsset } from "../persistence/UserSampleRepository";
import { createInstrumentTrackModel } from "../project-model/schema";
import type { Command } from "../commands/types";
import type { InstrumentTrack, NoteEvent, ProjectDocument } from "../project-model/types";

/** Peak level after normalization — headroom for the sampler's voices. */
const NORMALIZE_PEAK = 0.9;
/** Frames below this share of peak RMS count as silence at the edges. */
const TRIM_LEVEL_SHARE = 0.02;
/** Keep a short fade-in/out ramp (samples) after trimming, avoiding clicks. */
const FADE_SAMPLES = 256;
/** Median hummed pitch clamps to a usable vocal register. */
const ROOT_PITCH_FLOOR = 36;
const ROOT_PITCH_CEIL = 84;
const DEFAULT_ROOT_PITCH = 60;

/**
 * Trim leading/trailing silence (edges under TRIM_LEVEL_SHARE of peak RMS),
 * normalize the peak to NORMALIZE_PEAK and apply short fades. Pure.
 */
export function trimAndNormalizeVoice(pcm: Float32Array, sampleRate: number): Float32Array {
  if (pcm.length === 0) return pcm;
  let peak = 0;
  for (let index = 0; index < pcm.length; index += 1) peak = Math.max(peak, Math.abs(pcm[index]!));
  if (peak === 0) return pcm;
  const silenceLevel = peak * TRIM_LEVEL_SHARE;
  const frameLength = Math.max(1, Math.round(0.01 * sampleRate));
  const frameCount = Math.floor(pcm.length / frameLength);
  const loud = (frame: number): boolean => {
    let sum = 0;
    const start = frame * frameLength;
    for (let index = start; index < start + frameLength; index += 1) sum += pcm[index]! * pcm[index]!;
    return Math.sqrt(sum / frameLength) > silenceLevel;
  };
  let firstFrame = 0;
  while (firstFrame < frameCount - 1 && !loud(firstFrame)) firstFrame += 1;
  let lastFrame = frameCount - 1;
  while (lastFrame > firstFrame && !loud(lastFrame)) lastFrame -= 1;
  const start = Math.max(0, firstFrame * frameLength - frameLength);
  const end = Math.min(pcm.length, (lastFrame + 2) * frameLength);
  const trimmed = pcm.slice(Math.max(0, start), Math.max(1, end));
  let trimmedPeak = 0;
  for (let index = 0; index < trimmed.length; index += 1)
    trimmedPeak = Math.max(trimmedPeak, Math.abs(trimmed[index]!));
  const gain = trimmedPeak > 0 ? NORMALIZE_PEAK / trimmedPeak : 1;
  const fade = Math.min(FADE_SAMPLES, Math.floor(trimmed.length / 4));
  for (let index = 0; index < trimmed.length; index += 1) {
    let value = trimmed[index]! * gain;
    if (index < fade) value *= index / fade;
    if (index >= trimmed.length - fade) value *= (trimmed.length - 1 - index) / fade;
    trimmed[index] = value;
  }
  return trimmed;
}

/** Minimal mono 16-bit RIFF/WAVE writer — no AudioContext needed (tests). */
export function encodeMonoWav16(pcm: Float32Array, sampleRate: number): Blob {
  const dataBytes = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let index = 0; index < pcm.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, pcm[index]!));
    view.setInt16(offset, Math.round(clamped * 32767), true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** Median hummed pitch (MIDI), clamped to a usable register. */
export function medianVoiceRootPitch(notes: readonly NoteEvent[]): number {
  const pitches = [...notes].map((note) => Math.round(note.pitch)).sort((a, b) => a - b);
  if (pitches.length === 0) return DEFAULT_ROOT_PITCH;
  const middle = Math.floor(pitches.length / 2);
  const median =
    pitches.length % 2 === 1 ? pitches[middle]! : Math.round((pitches[middle - 1]! + pitches[middle]!) / 2);
  return Math.max(ROOT_PITCH_FLOOR, Math.min(ROOT_PITCH_CEIL, median));
}

export interface PreparedVoiceSample {
  asset: UserSampleAsset;
  blob: Blob;
  /** Trimmed, normalized mono PCM — the same bytes the blob carries. */
  pcm: Float32Array;
  rootPitch: number;
}

/**
 * Trim + normalize the recorded take and prepare its persistence shape.
 * The CALLER persists (`saveVoiceSample`) — analysis stays pure, the panel
 * decides when the IndexedDB write happens.
 */
export function prepareVoiceSample(take: AudioBuffer, name: string, notes: readonly NoteEvent[]): PreparedVoiceSample {
  const channels = Math.max(1, take.numberOfChannels);
  const length = take.length;
  const mono = new Float32Array(length);
  for (let channel = 0; channel < channels; channel += 1) {
    const data = take.getChannelData(Math.min(channel, take.numberOfChannels - 1));
    for (let index = 0; index < length; index += 1) mono[index] = (mono[index] ?? 0) + (data[index] ?? 0) / channels;
  }
  const pcm = trimAndNormalizeVoice(mono, take.sampleRate);
  const asset: UserSampleAsset = {
    id: userSampleId(name),
    name,
    fileName: `${name}.wav`,
    category: "Custom",
    duration: pcm.length / Math.max(1, take.sampleRate),
    sampleRate: take.sampleRate,
    channels: 1,
    createdAt: new Date().toISOString(),
  };
  return { asset, blob: encodeMonoWav16(pcm, take.sampleRate), pcm, rootPitch: medianVoiceRootPitch(notes) };
}

export async function saveVoiceSample(prepared: PreparedVoiceSample): Promise<void> {
  await new UserSampleRepository().save(prepared.asset, prepared.blob);
}

export interface VoiceInstrumentSpec {
  trackId: string;
  sampleId: string;
  rootPitch: number;
  name?: string;
}

/** The "Voice Lead" sampler track: one full-range layer rooted at the hum. */
export function voiceInstrumentTrack(spec: VoiceInstrumentSpec, index: number, layerId: string): InstrumentTrack {
  const track = createInstrumentTrackModel("sampler", index);
  return {
    ...track,
    id: spec.trackId,
    name: spec.name ?? "Voice Lead",
    sampleId: spec.sampleId,
    velocityLayers: [
      {
        id: layerId,
        sampleId: spec.sampleId,
        min: 0,
        max: 1,
        root: spec.rootPitch,
      },
    ],
  };
}

/** One undoable step: the Voice Lead track joins the project. */
export function voiceInstrumentTrackCommand(doc: ProjectDocument, track: InstrumentTrack): Command {
  return {
    type: "voiceInstrumentTrack",
    label: `Voice instrument — ${track.name}`,
    execute: () => ({ ...doc, tracks: [...doc.tracks, track] }),
    undo: () => doc,
  };
}
