/**
 * UN-SUNO TRANSCRIPTION CONTRACT — `transcribeTrack(pcm, sampleRate)`.
 *
 * The single seam every transcription wave lands behind (docs/UN-SUNO-PLAN.md
 * U1–U3): audio in, an honest transcription out. Chords run since U1 (the
 * pure detector in `analysis/chords.ts`); tempo + key come from
 * `audio-tempo-key`; bass/drums remain EXPLICITLY unimplemented —
 * `implemented: false` with a warning, never invented content (the apply.ts
 * honesty rule: a section under the confidence gate stays empty).
 *
 * Async by contract: U2/U3 run heavy DSP in the reference worker; the
 * main-thread signature must not change when they land. Calls are cheap and
 * never throw — every estimator inside has its own guard.
 */
import { estimateKey, estimateTempo, type KeyEstimate, type TempoEstimate } from "../ai/audio-tempo-key";
import { deriveKeyFromChords, detectChordSpans, type ChordSpan, type TranscribedChordQuality } from "./analysis/chords";
import { detectBassNotes, type TranscribedBassNote } from "./analysis/bass";

export interface TranscribedLayer {
  /** false = this layer is not transcribed yet — consumers must treat it as
   * "no opinion", not as "verified empty". */
  implemented: boolean;
  warning: string | null;
}

/** Chord-function shorthand compatible with the harmony engine (src/ai/harmony.ts). */
export type ChordFunc = "T" | "S" | "D" | "p";

export interface TranscribedChordSpan extends ChordSpan {
  /** Scale degree 1–7 of the span's root against the DETECTED key (null when
   * the key estimator had no opinion or the root sits off-scale). */
  degree: number | null;
  /** Tonic/subdominant/dominant/passing tag (null without a degree). */
  func: ChordFunc | null;
}

export interface TranscribedChords {
  /** true from U1 on — the layer HAS an implementation. Whether it found
   * anything is `spans` + `warning`, never folded into this flag. */
  implemented: boolean;
  warning: string | null;
  spans: TranscribedChordSpan[];
}

export interface TranscribedBass {
  /** true from U2 on — the layer HAS an implementation. Whether it found
   * anything is `notes` + `warning`, never folded into this flag. */
  implemented: boolean;
  warning: string | null;
  notes: TranscribedBassNote[];
}

export interface UnsunoTranscription {
  sampleRate: number;
  durationSec: number;
  tempo: TempoEstimate | null;
  key: KeyEstimate | null;
  drums: TranscribedLayer;
  bass: TranscribedBass;
  chords: TranscribedChords;
}

/** Which wave owns which layer — drives the pending warnings and the gated
 * KPI tests in tests/unsuno/golden-set.test.ts. */
export const TRANSCRIPTION_WAVE_OWNERS = { drums: "U3", bass: "U2", chords: "U1" } as const;

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];
const DEGREE_FUNC: Record<number, ChordFunc> = { 1: "T", 4: "S", 5: "D" };

interface ParsedKey {
  tonicPc: number;
  scale: readonly number[];
}

/** Parse the estimator's key string ("F# Natural Minor" | "C Major" | …) into
 * the tonal anchors chords need. Unknown formats → null (degree stays null). */
function parseKeyEstimate(key: KeyEstimate | null): ParsedKey | null {
  if (!key) return null;
  const parts = key.key.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const tonicPc = NOTE_NAMES.indexOf(parts[0]);
  if (tonicPc < 0) return null;
  return { tonicPc, scale: key.key.toLowerCase().includes("minor") ? MINOR_SCALE : MAJOR_SCALE };
}

/** Decorate a raw span with scale degree + function against the detected key.
 * Off-scale roots snap to the NEAREST degree (documented, like the
 * beat_modifier recipe) — a chromatic mediant still gets a usable tag. */
function decorateSpan(span: ChordSpan, parsed: ParsedKey | null): TranscribedChordSpan {
  if (!parsed) return { ...span, degree: null, func: null };
  const offset = (span.rootPc - parsed.tonicPc + 12) % 12;
  let nearestIndex = 0;
  let nearestDist = 12;
  for (let i = 0; i < parsed.scale.length; i++) {
    const raw = Math.abs(offset - parsed.scale[i]);
    const dist = Math.min(raw, 12 - raw);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestIndex = i;
    }
  }
  const degree = nearestIndex + 1;
  return { ...span, degree, func: DEGREE_FUNC[degree] ?? "p" };
}

export function transcribeTrack(pcm: Float32Array, sampleRate: number): UnsunoTranscription {
  const tempo = estimateTempo(pcm, sampleRate);
  const pending = (layer: keyof typeof TRANSCRIPTION_WAVE_OWNERS): TranscribedLayer => ({
    implemented: false,
    warning: `${layer} transcription not implemented yet — lands in ${TRANSCRIPTION_WAVE_OWNERS[layer]} (docs/UN-SUNO-PLAN.md)`,
  });

  const rawSpans: ChordSpan[] = [];
  let derived: ReturnType<typeof deriveKeyFromChords> = null;
  if (tempo) {
    const detection = detectChordSpans(pcm, sampleRate, { bpm: tempo.bpm });
    if (detection) {
      rawSpans.push(...detection.spans);
      // U1.5 — the chord sequence decides the key whenever it exists: a
      // diatonic progression reads as several rotations and raw chroma
      // cannot pick one, but what the song PLAYS (first chord, tonic
      // returns, mode matches) can. estimateKey stays the fallback for
      // material without a readable harmony.
      derived = deriveKeyFromChords(detection.spans, detection.barsAnalyzed);
    }
  }
  const key: KeyEstimate | null =
    derived !== null
      ? {
          key: `${NOTE_NAMES[derived.tonicPc]} ${derived.mode === "minor" ? "Natural Minor" : "Major"}`,
          confidence: derived.confidence,
        }
      : estimateKey(pcm, sampleRate);
  const parsedKey = parseKeyEstimate(key);

  const chords: TranscribedChords = !tempo
    ? {
        implemented: true,
        warning: "tempo unavailable — no bar grid, chord segmentation skipped (honest empty)",
        spans: [],
      }
    : rawSpans.length > 0
      ? { implemented: true, warning: null, spans: rawSpans.map((span) => decorateSpan(span, parsedKey)) }
      : {
          implemented: true,
          warning: "no stable harmony detected — chords left empty, never invented",
          spans: [],
        };

  // U2 — bass transcription shares the tempo gate (note-length decisions
  // need the grid) AND the chord gate: the kick is louder than the bass in
  // the same band, and without the chord lane's per-bar roots the prior has
  // nothing to filter phantom kick notes with — so no readable harmony means
  // no bass attempt, honestly.
  const bass: TranscribedBass = !tempo
    ? {
        implemented: true,
        warning: "tempo unavailable — no bar grid, bass segmentation skipped (honest empty)",
        notes: [],
      }
    : rawSpans.length === 0
      ? {
          implemented: true,
          warning: "no chord context — bass prior unavailable, transcription skipped (honest empty)",
          notes: [],
        }
      : (() => {
          // Chord context for the bass prior: per-bar roots in the SAME grid,
          // -1 where the chord lane had no confident read.
          const barSec = 240 / tempo.bpm;
          const barRoots = new Array(Math.ceil(pcm.length / sampleRate / barSec)).fill(-1);
          for (const span of rawSpans) {
            for (let bar = span.startBar; bar < span.startBar + span.bars && bar < barRoots.length; bar++) {
              barRoots[bar] = span.rootPc;
            }
          }
          const detection = detectBassNotes(pcm, sampleRate, {
            bpm: tempo.bpm,
            chordContext: { barRoots, barSec },
          });
          const notes = detection?.notes ?? [];
          return notes.length > 0
            ? { implemented: true, warning: null, notes }
            : {
                implemented: true,
                warning: "no pitched bass found — notes left empty, never invented",
                notes: [],
              };
        })();

  return {
    sampleRate,
    durationSec: sampleRate > 0 ? pcm.length / sampleRate : 0,
    tempo,
    key,
    drums: pending("drums"),
    bass,
    chords,
  };
}

export type { TranscribedChordQuality };
