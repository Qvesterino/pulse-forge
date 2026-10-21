/**
 * W2 — Public-domain MIDI corpus INGEST CORE
 * (docs/intent-killer-feature-plan.md W2, audit docs/W2-MIDI-CORPUS-AUDIT-2026-10-04.md).
 *
 * Pure, dependency-light transformations that turn a parsed Standard MIDI File
 * into MELODIC next-note training samples. They live in `src/` (not in the
 * dataset script) for the same reason `ranker-favorites.ts` does: the
 * decisions that shape the training corpus must be covered by vitest AND tsc,
 * and the tsconfig `include` list does not reach `scripts/`.
 *
 * Every transformation mirrors the engine's own contracts:
 *   - notes quantize to the 16-step grid (STEP_TICKS),
 *   - pitches invert to scale degrees through the SAME `degreeToPitch` math
 *     the provider uses (so every sampled degree is in-key by construction),
 *   - key detection reuses the committed Krumhansl-Kessler profiles,
 *   - rows are built by the shared `buildMelodicFeatureRow` (no layout drift).
 *
 * Deterministic: no RNG anywhere in this module. The same MIDI bytes always
 * produce the same corpus rows.
 */
import type { MidiNote } from "../midi/midiFile";
import { STEP_TICKS } from "../project-model/types";
import type { MusicalKey } from "../project-model/types";
import { parseKey, formatKey, SCALE_INTERVALS } from "../project-model/scales";
import { degreeToPitch } from "./melodic";
import {
  buildMelodicFeatureRow,
  durationClass,
  type MelodicRole,
  type MelodicGenre,
} from "./symbolic/melodic-features";
import { DEFAULT_AI_METER } from "./meter";
import { CHORD_INTERVALS, type ChordQuality, type HarmonicFunction } from "./harmony";

// ── Krumhansl-Kessler key profiles (same values as src/ai/audio-tempo-key.ts) ──
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** Correlate a duration-weighted chroma histogram with a key profile. */
export function correlate(chroma: number[], profile: number[], root: number): number {
  let meanC = 0;
  let meanP = 0;
  for (let i = 0; i < 12; i++) {
    meanC += chroma[(i + root) % 12];
    meanP += profile[i];
  }
  meanC /= 12;
  meanP /= 12;
  let num = 0;
  let denC = 0;
  let denP = 0;
  for (let i = 0; i < 12; i++) {
    const c = chroma[(i + root) % 12] - meanC;
    const p = profile[i] - meanP;
    num += c * p;
    denC += c * c;
    denP += p * p;
  }
  const den = Math.sqrt(denC) * Math.sqrt(denP);
  return den > 0 ? num / den : 0;
}

/** Detect key from MIDI notes via duration-weighted chroma (Pearson r per rotation). */
export function detectKeyFromNotes(notes: MidiNote[]): MusicalKey | null {
  const chroma = new Array<number>(12).fill(0);
  for (const note of notes) {
    const semitone = ((note.pitch % 12) + 12) % 12;
    chroma[semitone] += Math.max(1, note.endTick - note.startTick) * note.velocity;
  }
  if (chroma.every((v) => v === 0)) return null;
  let best = { score: -Infinity, root: 0, minor: false };
  for (let root = 0; root < 12; root++) {
    const major = correlate(chroma, MAJOR_PROFILE, root);
    const minor = correlate(chroma, MINOR_PROFILE, root);
    if (major > best.score) best = { score: major, root, minor: false };
    if (minor > best.score) best = { score: minor, root, minor: true };
  }
  if (best.score < 0.5) return null; // ambiguous — skip rather than mislabel
  return formatKey(best.root, best.minor ? "natural_minor" : "major");
}

// ── role heuristics ──────────────────────────────────────────────────────────

export interface RoleSplit {
  bass: MidiNote[];
  chord: MidiNote[];
  lead: MidiNote[];
  key: MusicalKey | null;
  bpm: number | null;
}

const GM_DRUM_CHANNEL = 9;

/** Average pitch of a note list (0 when empty). */
export function averagePitch(notes: MidiNote[]): number {
  if (notes.length === 0) return 0;
  return notes.reduce((sum, n) => sum + n.pitch, 0) / notes.length;
}

/** Share of note-pairs sharing a start tick (chord voicing signature). */
export function simultaneousShare(notes: MidiNote[]): number {
  if (notes.length < 2) return 0;
  const starts = new Map<number, number>();
  for (const note of notes) starts.set(note.startTick, (starts.get(note.startTick) ?? 0) + 1);
  let overlapping = 0;
  for (const count of starts.values()) if (count > 1) overlapping += count;
  return overlapping / notes.length;
}

/**
 * Split a parsed MIDI file into the three melodic roles the prior knows.
 *
 * Deliberately conservative: a track qualifies for a role only when its
 * content fits the role's musical signature; otherwise it is DROPPED (a
 * wrong-label sample is worse than a missing one). Drum channels (GM 9)
 * never reach the melodic corpus.
 */
export function splitRoles(parsed: {
  bpm: number | null;
  tracks: { name: string; channel: number; notes: MidiNote[] }[];
}): RoleSplit {
  const melodicTracks = parsed.tracks
    .filter((t) => t.channel !== GM_DRUM_CHANNEL && t.notes.length >= 4)
    .map((t) => ({ ...t, notes: [...t.notes].sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch) }));
  if (melodicTracks.length === 0) return { bass: [], chord: [], lead: [], key: null, bpm: parsed.bpm };

  // Key from ALL melodic material (more notes → more stable chroma).
  const allNotes = melodicTracks.flatMap((t) => t.notes);
  const key = detectKeyFromNotes(allNotes);

  // Bass: lowest average pitch track with meaningful monophonic-ish content.
  const byPitch = [...melodicTracks].sort((a, b) => averagePitch(a.notes) - averagePitch(b.notes));
  const bassTrack = byPitch[0] && averagePitch(byPitch[0].notes) < 55 ? byPitch.shift()! : undefined;

  // Chord: among the rest, the track with the highest simultaneity share.
  let chordTrack: (typeof byPitch)[number] | undefined;
  let chordIdx = -1;
  let bestShare = 0.25; // must clear the bar to be labelled chords at all
  byPitch.forEach((t, i) => {
    const share = simultaneousShare(t.notes);
    if (share > bestShare) {
      bestShare = share;
      chordTrack = t;
      chordIdx = i;
    }
  });
  if (chordTrack) byPitch.splice(chordIdx, 1);

  // Lead: the highest remaining monophonic-ish track (top melody).
  const leadCandidates = byPitch.sort((a, b) => averagePitch(b.notes) - averagePitch(a.notes));
  const leadTrack = leadCandidates[0];

  return {
    bass: bassTrack ? bassTrack.notes : [],
    chord: chordTrack ? chordTrack.notes : [],
    lead: leadTrack ? leadTrack.notes : [],
    key,
    bpm: parsed.bpm,
  };
}

// ── quantization + degree inversion ───────────────────────────────────────────

/** Role → octaveOffset used by degreeToPitch (mirrors MELODIC_BY_GENRE layout). */
export const ROLE_OCTAVE: Record<MelodicRole, number> = { bass: 0, chord: 1, lead: 2 };

export interface DegreeEvent {
  degree: number; // 0..6
  duration: number; // steps
  startStep: number; // absolute 16th steps
}

/**
 * Quantize a note list to the 16-step grid and invert pitches to scale
 * degrees. Off-scale pitches are snapped to the nearest degree (chromatic
 * material collapses to its scale neighbour — the same snap the runtime
 * applies to sampled notes); a note further than a whole tone from every
 * candidate in the role's register is dropped as chromatic noise.
 */
export function toDegreeEvents(notes: MidiNote[], role: MelodicRole, key: MusicalKey, maxSteps: number): DegreeEvent[] {
  const parsedKey = parseKey(key);
  if (!parsedKey) return [];
  const intervals = SCALE_INTERVALS[parsedKey.scaleType];
  const octaveOffset = ROLE_OCTAVE[role];
  const out: DegreeEvent[] = [];
  for (const note of notes) {
    const startStep = Math.round(note.startTick / STEP_TICKS);
    if (startStep >= maxSteps) continue;
    const durationSteps = Math.max(1, Math.min(8, Math.round((note.endTick - note.startTick) / STEP_TICKS)));
    // Invert pitch → degree: nearest degreeToPitch match over 0..6 in the
    // SAME octave the engine uses for the role (favorites-core parity).
    let degree = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let candidate = 0; candidate <= 6; candidate++) {
      const base = degreeToPitch(candidate, octaveOffset, parsedKey.root, intervals);
      // Match the note's octave: compare against base + k*12 for k in -2..2.
      for (let octave = -2; octave <= 2; octave++) {
        const candidatePitch = base + octave * 12;
        const distance = Math.abs(candidatePitch - note.pitch);
        if (distance < bestDistance) {
          bestDistance = distance;
          degree = candidate;
        }
      }
    }
    if (bestDistance > 2) continue; // >2 semitones from any degree: chromatic noise, drop
    out.push({ degree, duration: durationSteps, startStep });
  }
  return out.sort((a, b) => a.startStep - b.startStep || a.degree - b.degree);
}

export interface CorpusSample {
  x: number[];
  degree: number;
  duration: number;
  group: string;
}

/**
 * One role's events → next-note samples with wrap-around (mirrors the base
 * dataset generator: sequences loop, so the last note's successor is the
 * first). Bar-relative start position uses cumulative steps mod 16 — the
 * feature contract's rhythmic slot.
 *
 * `groupPrefix` must start with a conditioning key the v2 embedding lookup
 * knows (see `eraOf` → `classical.<era>`); the tail keeps every piece its own
 * leak-guard group.
 */
export function collectSamples(
  events: DegreeEvent[],
  groupPrefix: string,
  genreKey: MelodicGenre,
  role: MelodicRole,
  limit: number,
): CorpusSample[] {
  const samples: CorpusSample[] = [];
  if (events.length === 0) return samples;
  const addSample = (
    noteIndex: number,
    startStep: number,
    prevDegree: number,
    prevDuration: number,
    prevPrevDegree: number,
  ) => {
    const note = events[noteIndex];
    samples.push({
      x: buildMelodicFeatureRow({
        genre: genreKey,
        role,
        startStep,
        prevDegree,
        prevDuration,
        prevPrevDegree,
        // The corpus IS 4/4 material (Mutopia sheet music), and the pinned
        // models were trained on these very rows — so the corpus declares the
        // training frame explicitly and its rows stay byte-identical
        // (ADR 0057 Stage 2d).
        meter: DEFAULT_AI_METER,
      }),
      degree: note.degree < 0 ? 0 : Math.min(7, note.degree + 1),
      duration: durationClass(note.duration),
      group: `${groupPrefix}#${role}`,
    });
  };
  // In-sequence transitions. The head of the sequence is the part the model
  // actually needs to generalize over — a long chorale tail is many samples
  // of the same local distribution, so the cap keeps the corpus balanced
  // across pieces instead of letting fugue length decide the weight.
  const span = Math.min(events.length, Math.max(2, limit - 1));
  let cumulative = 0;
  for (let i = 0; i < span; i++) {
    const prev = i > 0 ? events[i - 1] : null;
    const prevPrev = i > 1 ? events[i - 2] : null;
    addSample(i, cumulative % 16, prev ? prev.degree : -1, prev ? prev.duration : 2, prevPrev ? prevPrev.degree : -1);
    cumulative += events[i].duration;
  }
  // Wrap-around: last → first (sequences loop when tiled).
  const last = events[span - 1];
  const beforeLast = span > 1 ? events[span - 2] : null;
  addSample(0, cumulative % 16, last.degree, last.duration, beforeLast ? beforeLast.degree : -1);
  return samples;
}

// ── corpus era / licensing mapping ───────────────────────────────────────────

export interface CatalogPiece {
  id: string;
  title: string;
  composer: string;
  style?: string;
  file: string;
  license: string;
  sha1: string;
  sourceUrl?: string;
}

/**
 * Catalog `style` → the `classical.*` conditioning region the corpus trains
 * under. Values that are not an era (Jazz, Technique, March, Song, Popular)
 * fold into `classical.classical` — the generic period region. Keeping the
 * corpus inside its OWN semantic neighbourhood is what stops baroque
 * counterpoint from teaching the model "ambient" (the shared-prefix
 * experiment measurably cost degree accuracy on the ds.v3 gate).
 */
export const ERA_BY_CATALOG_STYLE: Record<string, string> = {
  baroque: "baroque",
  classical: "classical",
  romantic: "romantic",
  impressionist: "impressionist",
  modern: "modern",
  jazz: "classical",
  march: "classical",
  song: "classical",
  technique: "classical",
  "popular / dance": "classical",
};

export function eraOf(piece: CatalogPiece): string {
  const key = (piece.style ?? "classical").trim().toLowerCase();
  return ERA_BY_CATALOG_STYLE[key] ?? "classical";
}

/** Cap so one monster fugue can't dominate the corpus weight. */
export const MAX_BARS_PER_PIECE = 8;
/** ~2 bars of next-note context per role per piece. */
export const MAX_SAMPLES_PER_ROLE = 48;

// ── W1: chord track → ChordEvent[] (the harmony-aware v3 bridge) ────────────

/** Tonic-relative degree of a pitch class against the key (0..6), nearest match. */
function pcToDegree(pc: number, parsedKey: { root: number; scaleType: string }, intervals: readonly number[]): number {
  const tonicRelative = (((pc - parsedKey.root) % 12) + 12) % 12;
  let degree = 0;
  let best = Number.POSITIVE_INFINITY;
  for (let d = 0; d < 7; d++) {
    const distance = Math.min(Math.abs(intervals[d] - tonicRelative), 12 - Math.abs(intervals[d] - tonicRelative));
    if (distance < best) {
      best = distance;
      degree = d;
    }
  }
  return degree;
}

/** Harmonic function by scale degree (harmony.ts convention: I/vi = T, ii/IV = S, V = D, rest = p). */
export function harmonicFunctionOfDegree(degree: number): HarmonicFunction {
  switch (degree) {
    case 0:
    case 5:
      return "T";
    case 1:
    case 3:
      return "S";
    case 4:
      return "D";
    default:
      return "p";
  }
}

/**
 * Joint root+quality match: every quality template over all 12 rotations
 * scores `covered/|template| − 0.5 × extra/|sounding|` — coverage rewards
 * the template's own tones, the extra-tone penalty rejects chromatic
 * clusters that merely CONTAIN a two-tone template subset ({C,C#,F#} reads
 * as neither dim@C nor sus2@D). Max score wins, ties prefer the smaller
 * template then the lower root (deterministic). Joint matching is what
 * makes INVERSIONS read correctly — {C,E,G} is maj@C with any voicing, not
 * "min@E" from the lowest-note shortcut. Below the 2/3 floor the slice has
 * no recognizable chord.
 */
const CHORD_SCORE_FLOOR = 2 / 3;
const EXTRA_TONE_PENALTY = 0.5;
function matchChord(pcs: Set<number>): { rootPc: number; quality: ChordQuality } | null {
  let best: { rootPc: number; quality: ChordQuality; score: number; size: number } | null = null;
  for (const quality of Object.keys(CHORD_INTERVALS) as ChordQuality[]) {
    const intervals = CHORD_INTERVALS[quality];
    for (let rootPc = 0; rootPc < 12; rootPc++) {
      const template = intervals.map((i) => (rootPc + i) % 12);
      const covered = template.filter((pc) => pcs.has(pc)).length;
      const extra = [...pcs].filter((pc) => !template.includes(pc)).length;
      const score = covered / intervals.length - EXTRA_TONE_PENALTY * (extra / pcs.size);
      if (score < CHORD_SCORE_FLOOR) continue;
      if (
        best === null ||
        score > best.score ||
        (score === best.score && intervals.length < best.size) ||
        (score === best.score && intervals.length === best.size && rootPc < best.rootPc)
      ) {
        best = { rootPc, quality, score, size: intervals.length };
      }
    }
  }
  return best;
}

/**
 * W1 bridge (docs/W1-CHORD-AWARE-PLAN.md §2.1): turn a piece's extracted
 * chord track into the `ChordEvent[]` progression shape the v3 dataset
 * generator and `buildMelodicFeatureRowV3` consume — so corpus rows and
 * library rows flow through the SAME harmony-aware feature path.
 *
 * Segmentation: a new slice starts at every distinct chord-note onset; the
 * slice lasts until the next onset group (or the note's end). Per slice the
 * sounding pc set picks root (lowest covered pc → template match) → degree +
 * quality + function. Deterministic: sorted onsets, fixed iteration order.
 * Empty input → empty progression (no invented harmony).
 */
export function deriveCorpusChordEvents(
  chordNotes: MidiNote[],
  key: MusicalKey | null,
  maxSteps: number,
): { degree: number; quality: ChordQuality; duration: number; func: HarmonicFunction }[] {
  const parsedKey = key ? parseKey(key) : null;
  if (!parsedKey || chordNotes.length === 0) return [];
  const intervals = SCALE_INTERVALS[parsedKey.scaleType];
  const sorted = [...chordNotes].sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
  const step = STEP_TICKS;

  // Onset groups: distinct quantized start steps in order.
  const onsets: number[] = [];
  for (const note of sorted) {
    const onset = Math.round(note.startTick / step) * step;
    if (onsets.length === 0 || onsets[onsets.length - 1] !== onset) onsets.push(onset);
  }

  const events: { degree: number; quality: ChordQuality; duration: number; func: HarmonicFunction }[] = [];
  for (let g = 0; g < onsets.length; g++) {
    const from = onsets[g]!;
    // The last slice lasts until the sounding notes actually end (not an
    // invented 4-step tail); every slice caps at the corpus window.
    const sliceEnd = g + 1 < onsets.length ? onsets[g + 1]! : Math.max(...sorted.map((n) => n.endTick));
    const to = Math.min(sliceEnd, maxSteps * step);
    const sounding = new Set<number>();
    for (const note of sorted) {
      if (note.startTick >= to) break; // sorted by startTick
      if (note.endTick <= from) continue; // ended before the slice
      const pc = ((note.pitch % 12) + 12) % 12;
      sounding.add(pc);
    }
    if (sounding.size === 0) continue;
    const matched = matchChord(sounding);
    if (!matched) continue; // no recognizable chord — honest skip, no guess
    const rootPc = matched.rootPc;
    const quality = matched.quality;
    const degree = pcToDegree(rootPc, parsedKey, intervals);
    const startStep = Math.max(0, Math.round(from / step));
    const endStep = Math.min(maxSteps, Math.max(startStep + 1, Math.round(to / step)));
    if (startStep >= maxSteps) continue;
    events.push({
      degree,
      quality,
      duration: Math.max(1, endStep - startStep),
      func: harmonicFunctionOfDegree(degree),
    });
    if (startStep + events[events.length - 1]!.duration >= maxSteps) break;
  }
  return events;
}
