import type { SampleBank } from "../sample-library/factory";
import type { AudioClip, ProjectDocument } from "../project-model/types";

/**
 * VOCAL TAKE RESOLVER (V1.4 follow-through) — arrangement clip → analyzer PCM.
 *
 * Arrangement vocal takes are staged into the runtime SampleBank keyed by
 * bufferId (ArrangementPanel on take commit), so resolving is a lookup, not
 * new plumbing: find the clip, pull its buffer, downmix to mono, apply the
 * clip's trim window + gain. Pure (no I/O, no RNG) — the bank is injected.
 */

export interface VocalTakeAudio {
  /** Mono PCM honoring the clip trim window + gain. */
  pcm: Float32Array;
  sampleRate: number;
  clipId: string;
  bufferId: string;
}

export type ResolveVocalTakeResult = { ok: true; take: VocalTakeAudio } | { ok: false; error: string };

function allAudioClips(doc: ProjectDocument): AudioClip[] {
  return doc.arrangement.audioClips ?? [];
}

/** Explicit clipId wins; otherwise the longest clip (the main take). */
export function pickVocalClip(doc: ProjectDocument, clipId?: string | null): AudioClip | null {
  const clips = allAudioClips(doc);
  if (clips.length === 0) return null;
  if (clipId) return clips.find((c) => c.id === clipId) ?? null;
  let best = clips[0];
  for (const clip of clips) {
    if (clip.lengthBars > best.lengthBars) best = clip;
  }
  return best;
}

/** Average all channels to mono (copies — bank buffers are never mutated). */
export function downmixBuffer(buffer: {
  numberOfChannels: number;
  length: number;
  getChannelData: (channel: number) => Float32Array;
}): Float32Array {
  const channels = Math.max(1, buffer.numberOfChannels);
  const out = new Float32Array(buffer.length);
  for (let channel = 0; channel < channels; channel++) {
    const data = buffer.getChannelData(channel);
    const limit = Math.min(out.length, data.length);
    for (let i = 0; i < limit; i++) out[i] += data[i] / channels;
  }
  return out;
}

export function resolveVocalTake(
  doc: ProjectDocument,
  bank: SampleBank,
  options: { clipId?: string | null } = {},
): ResolveVocalTakeResult {
  try {
    const clip = pickVocalClip(doc, options.clipId);
    if (!clip) {
      return {
        ok: false,
        error: options.clipId
          ? "vocal clip not found in this arrangement"
          : "no vocal clips in this arrangement — record a take first",
      };
    }
    const buffer = bank.get(clip.bufferId);
    if (!buffer) {
      return { ok: false, error: "take audio is not loaded — replay the take once so its buffer stages" };
    }
    const sampleRate = buffer.sampleRate;
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      return { ok: false, error: "take audio has an invalid sample rate" };
    }
    const mono = downmixBuffer(buffer);
    // Honor the clip window: offset + trimStart .. end − trimEnd, then gain.
    const startSec = Math.max(0, (clip.offsetSec ?? 0) + (clip.trimStart ?? 0));
    const endSec = Math.max(startSec, mono.length / sampleRate - (clip.trimEnd ?? 0));
    const from = Math.min(mono.length, Math.floor(startSec * sampleRate));
    const to = Math.min(mono.length, Math.ceil(endSec * sampleRate));
    if (to <= from) return { ok: false, error: "take clip window is empty after trimming" };
    const gain = Number.isFinite(clip.gain) ? clip.gain : 1;
    const pcm = mono.subarray(from, to).slice();
    if (gain !== 1) {
      for (let i = 0; i < pcm.length; i++) pcm[i] *= gain;
    }
    return { ok: true, take: { pcm, sampleRate, clipId: clip.id, bufferId: clip.bufferId } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
