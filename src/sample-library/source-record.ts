/**
 * SOURCE RECORDS (roadmap wave 3, TSAR plan R2).
 *
 * "Navrhnúť lokálny zdrojový záznam s identitou, názvom, technickými
 * metadátami, informáciami o root/loop bodoch, pôvode a stave chýbajúceho
 * súboru."
 *
 * The problem this solves. Today a source IS a string: `track.sampleId`
 * points at an id, and what that id MEANS — its name, its length, its root,
 * where it came from, whether the file is still there — lives in a
 * repository row that the project does not carry, or (for factory sounds) in
 * a manifest the project does not carry. A patch that travels without the
 * user's library arrives with dangling ids and no way to tell the producer
 * WHICH sound is missing.
 *
 * So a source gets a record of its own, with:
 *
 *  - an IDENTITY that survives the patch (the id plus a content hash, so the
 *    same file imported twice is recognisable as the same source);
 *  - a NAME and TECHNICAL METADATA (duration, sample rate, channels);
 *  - the MEASURED PITCH information (root note and how sure we are of it)
 *    and LOOP information, which is what a sound-design tool needs and what
 *    the Forge already measures;
 *  - an ORIGIN — imported, recorded, generated, or shipped factory content —
 *    with the LICENSE where one applies;
 *  - a STATE, so a source whose bytes are gone is VISIBLE and FIXABLE
 *    rather than silently silent.
 *
 * This module is PURE: it defines the record and the functions that build
 * one from what the app already knows. It does not touch IndexedDB and does
 * not touch the project document — a source record lives beside the patch,
 * in the user's library, and the patch keeps only the id.
 *
 * The one thing this module does NOT do is invent a root. `rootMidi` is
 * null when no pitch was read, and `rootConfidence` says how sure the
 * reading is. A weak reading is not dressed up as a precise note.
 */

/** Where a source came from. */
export type SourceOrigin = "imported" | "recorded" | "generated" | "factory";

/** The measured pitch of a source. */
export interface SourcePitch {
  /** The detected root as a MIDI note, or null when no pitch was readable. */
  rootMidi: number | null;
  /**
   * How sure the analysis is (0..1). 0 means "no pitch was found"; a low
   * value means "a pitch was read, but weakly" — which is NOT the same as a
   * precise note, and must never be presented as one.
   */
  rootConfidence: number;
  /** The measured fundamental in Hz (0 when unknown). */
  rootHz: number;
}

/** The measured envelope of a source. */
export interface SourceEnvelope {
  attackSec: number;
  releaseSec: number;
}

/** The license a source ships under, when one applies. */
export interface SourceLicense {
  /** The license id (see src/sample-library/licenses.ts for the table). */
  id: string;
  /** Human-readable attribution the producer must carry. */
  attribution?: string;
  /** Whether the source may be redistributed with a project. */
  redistributable: boolean;
}

/**
 * A source's state.
 *
 * `missing` is the important one: the project references a source whose
 * bytes are not here. That is a VISIBLE, FIXABLE condition — the producer
 * can re-link the file — not a silent hole in the patch.
 */
export type SourceState = "ready" | "missing";

/** A source, described independently of any patch that uses it. */
export interface SourceRecord {
  /** The stable id the patches reference. */
  id: string;
  /**
   * A content hash of the audio, so the same file imported twice is
   * recognisable as the same source even when the ids differ.
   */
  contentHash: string;
  /** The producer-facing name. */
  name: string;
  /** The file the source came from (empty for factory content). */
  fileName: string;
  /** Where the source came from. */
  origin: SourceOrigin;
  /** The license, when the source has one (imported user audio does not). */
  license?: SourceLicense;
  /** Technical metadata. */
  durationSec: number;
  sampleRate: number;
  channels: number;
  /** The measured pitch information. */
  pitch: SourcePitch;
  /** The measured envelope. */
  envelope: SourceEnvelope;
  /** Loop information: is the source a loop, and at what tempo. */
  loop: { isLoop: boolean; bpm?: number };
  /** Whether the bytes are actually here. */
  state: SourceState;
  /**
   * Why the source is missing (only when `state` is "missing"). The
   * producer-facing hint: re-link the file, or pick another source.
   */
  missingReason?: string;
}

/** The metadata a source needs before its analysis is known. */
export interface SourceDraft {
  id: string;
  contentHash: string;
  name: string;
  fileName: string;
  origin: SourceOrigin;
  license?: SourceLicense;
  durationSec: number;
  sampleRate: number;
  channels: number;
  bpm?: number;
  isLoop?: boolean;
}

/**
 * A content hash for a source's audio.
 *
 * The identity of a sound is its CONTENT, not the moment it was imported —
 * so the same file imported twice gets the same hash and can be recognised
 * as one source. FNV-1a over a sampled fingerprint of the PCM: cheap, stable
 * across machines, and sensitive enough to tell two different files apart.
 * (It is an identity marker, not a security hash.)
 */
export function sourceContentHash(pcm: Float32Array, sampleRate: number): string {
  // Sample the signal at a fixed stride so the hash depends on the AUDIO,
  // not on the file's length in bytes or the machine that read it.
  const stride = Math.max(1, Math.floor(pcm.length / 4096));
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < pcm.length; i += stride) {
    const v = Math.round(pcm[i]! * 32767);
    h1 ^= v & 0xffff;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (v >>> 16) & 0xffff;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  const rate = Math.round(sampleRate);
  h1 ^= rate & 0xffff;
  h1 = Math.imul(h1, 0x01000193) >>> 0;
  h2 ^= (rate >>> 16) & 0xffff;
  h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/**
 * Build a source record from the draft metadata and the measured analysis.
 *
 * The analysis is optional: a source that was imported but never analysed
 * still has a record — it just has no measured pitch, and says so.
 */
export function buildSourceRecord(
  draft: SourceDraft,
  analysis?: { pitch?: SourcePitch; envelope?: SourceEnvelope; loop?: { isLoop?: boolean } },
): SourceRecord {
  const pitch = analysis?.pitch ?? { rootMidi: null, rootConfidence: 0, rootHz: 0 };
  const envelope = analysis?.envelope ?? { attackSec: 0, releaseSec: 0 };
  const isLoop = analysis?.loop?.isLoop ?? draft.isLoop ?? false;
  return {
    id: draft.id,
    contentHash: draft.contentHash,
    name: draft.name,
    fileName: draft.fileName,
    origin: draft.origin,
    license: draft.license,
    durationSec: draft.durationSec,
    sampleRate: draft.sampleRate,
    channels: draft.channels,
    pitch,
    envelope,
    loop: { isLoop, bpm: draft.bpm },
    state: "ready",
  };
}

/**
 * The record of a source whose bytes are not here.
 *
 * The identity and metadata SURVIVE — the producer still sees the name of
 * the missing sound and can act on it. Only the state says it is gone.
 */
export function markSourceMissing(record: SourceRecord, reason: string): SourceRecord {
  return { ...record, state: "missing", missingReason: reason };
}

/**
 * A one-line, honest description of a source's pitch.
 *
 * A precise reading is stated as a note; a weak reading is stated as a
 * weak reading; no reading is stated as no reading. The producer must never
 * be told a pitch is certain when the analysis was not sure.
 */
export function describeSourcePitch(pitch: SourcePitch): string {
  if (pitch.rootMidi === null) return "no pitch detected";
  if (pitch.rootConfidence >= 0.5) return `root MIDI ${pitch.rootMidi} (${(pitch.rootConfidence * 100).toFixed(0)} % sure)`;
  return `root ~MIDI ${pitch.rootMidi} (weak, ${(pitch.rootConfidence * 100).toFixed(0)} % sure)`;
}

/**
 * The producer-facing state of a source: what to show when it is missing.
 *
 * The message must be ACTIONABLE — a missing file is fixable by re-linking
 * it, and saying only "missing" would leave the producer stuck.
 */
export function describeSourceState(record: SourceRecord): string {
  if (record.state === "ready") return "source available";
  return `source missing${record.missingReason ? ` — ${record.missingReason}` : ""}`;
}
