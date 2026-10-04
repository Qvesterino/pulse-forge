/**
 * W2 — PUBLIC-DOMAIN MIDI CORPUS INGEST (docs/intent-killer-feature-plan.md).
 *
 * Turns Mutopia-derived Public Domain MIDI files into MELODIC next-note
 * training samples for the symbolic melodic prior, using the SAME contracts
 * as every other data source:
 *
 *   - notes are quantized to the project's 16-step grid (STEP_TICKS = 120),
 *   - pitches are inverted to scale degrees through the SAME math the engine
 *     emits with (degreeToPitch + role octaveOffset), so every sampled degree
 *     is in-key by construction,
 *   - rows are built by the shared `buildMelodicFeatureRow` — layout drift is
 *     impossible,
 *   - group keys `midi:<piece>#<role>#<bar>` never collide with library
 *     groups, so the trainer's leak guard keeps them train-only and
 *     validation stays library-pure.
 *
 * Determinism: fixed processing order (catalog order), no RNG in the feature
 * pipeline; the same corpus always produces the same dataset.
 *
 * Licensing (hard rule from the plan §4 W2): only pieces whose catalog entry
 * says `license == "Public Domain"` are ingested. The per-piece manifest is
 * written NEXT to the dataset — no data without provenance.
 *
 * Input layout (produced by the corpus downloader):
 *   scripts/data/midi-corpus/midi/*.mid
 *   scripts/data/midi-corpus/manifest.json   (catalog slice: license, sourceUrl, sha1)
 *
 * Output:
 *   scripts/data/midi-melodic-dataset.json — { data: MelodicTrainingSample[] }
 *   with featureVersion melodic-features.v1 (29-dim rows; the v2 embedding
 *   transform resolves `midi:<...>` prefixes — see SemanticLookup notes).
 *
 * Run: npx vite-node scripts/ingest-midi-corpus.mts
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseMidiFile, type MidiNote } from "../src/midi/midiFile";
import { STEP_TICKS } from "../src/project-model/types";
import { parseKey, formatKey, SCALE_INTERVALS, type MusicalKey } from "../src/project-model/scales";
import { degreeToPitch } from "../src/ai/melodic";
import {
  MELODIC_FEATURES_VERSION,
  MELODIC_FEATURE_COUNT,
  MELODIC_DURATION_VALUES,
  durationClass,
  buildMelodicFeatureRow,
  melodicGenreOf,
  type MelodicRole,
} from "../src/ai/symbolic/melodic-features";

const OUT_DIR = path.join(process.cwd(), "scripts", "data");
const CORPUS_DIR = path.join(OUT_DIR, "midi-corpus");

// ── Krumhansl-Kessler key profiles (same values as src/ai/audio-tempo-key.ts) ──
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** Correlate a duration-weighted chroma histogram with a key profile. */
function correlate(chroma: number[], profile: number[], root: number): number {
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
function detectKeyFromNotes(notes: MidiNote[]): MusicalKey | null {
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

interface RoleSplit {
  bass: MidiNote[];
  chord: MidiNote[];
  lead: MidiNote[];
  key: MusicalKey | null;
  bpm: number | null;
}

const GM_DRUM_CHANNEL = 9;

/** Average pitch of a note list (0 when empty). */
function averagePitch(notes: MidiNote[]): number {
  if (notes.length === 0) return 0;
  return notes.reduce((sum, n) => sum + n.pitch, 0) / notes.length;
}

/** Share of note-pairs sharing a start tick (chord voicing signature). */
function simultaneousShare(notes: MidiNote[]): number {
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
function splitRoles(parsed: { bpm: number | null; tracks: { name: string; channel: number; notes: MidiNote[] }[] }): RoleSplit {
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
const ROLE_OCTAVE: Record<MelodicRole, number> = { bass: 0, chord: 1, lead: 2 };

interface DegreeEvent {
  degree: number; // 0..6
  duration: number; // steps
  startStep: number; // absolute 16th steps
}

/**
 * Quantize a note list to the 16-step grid and invert pitches to scale
 * degrees. Notes OFF the detected scale by more than a semitone are snapped
 * to the nearest degree (chromatic material collapses to its scale neighbour
 * — the same snap the runtime applies to sampled notes).
 */
function toDegreeEvents(
  notes: MidiNote[],
  role: MelodicRole,
  key: MusicalKey,
  maxSteps: number,
): DegreeEvent[] {
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

/**
 * One role's events → next-note samples with wrap-around (mirrors the base
 * dataset generator: sequences loop, so the last note's successor is the
 * first). Bar-relative start position uses cumulative steps mod 16 — the
 * feature contract's rhythmic slot.
 *
 * Group keys start with a KNOWN genre prefix (`ambient`) so the v2 embedding
 * transform resolves them through the existing SemanticLookup (these rows are
 * train-only; the conditioning carries "generic melodic material", and the
 * group tail keeps every piece its own leak-guard group).
 */
function collectSamples(
  events: DegreeEvent[],
  groupPrefix: string,
  genreKey: Parameters<typeof melodicGenreOf>[0],
  role: MelodicRole,
  limit: number,
): { x: number[]; degree: number; duration: number; group: string }[] {
  const samples: { x: number[]; degree: number; duration: number; group: string }[] = [];
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
      x: buildMelodicFeatureRow({ genre: genreKey, role, startStep, prevDegree, prevDuration, prevPrevDegree }),
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

// ── ingest ───────────────────────────────────────────────────────────────────

interface CatalogPiece {
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
 * Catalog `style` → the classical.* conditioning region the corpus trains
 * under. Values that are not an era (Jazz, Technique, March, Song, Popular)
 * fold into `classical.classical` — the generic period region. Keeping the
 * corpus inside its OWN semantic neighbourhood is what stops baroque
 * counterpoint from teaching the model "ambient" (the shared-prefix
 * experiment measurably cost degree accuracy on the ds.v3 gate).
 */
const ERA_BY_CATALOG_STYLE: Record<string, string> = {
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

function eraOf(piece: CatalogPiece): string {
  const key = (piece.style ?? "classical").trim().toLowerCase();
  return ERA_BY_CATALOG_STYLE[key] ?? "classical";
}

interface MelodicSample {
  x: number[];
  degree: number;
  duration: number;
  group: string;
}

const MAX_BARS_PER_PIECE = 8; // cap so one monster fugue can't dominate
const MAX_SAMPLES_PER_ROLE = 48; // ~2 bars of next-note context per role

function main(): void {
  const manifestPath = path.join(CORPUS_DIR, "manifest.json");
  const midiDir = path.join(CORPUS_DIR, "midi");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `corpus manifest not found at ${manifestPath} — download the Public Domain pack first (see docs/intent-killer-feature-plan.md W2)`,
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { pieces: CatalogPiece[] };
  const pdPieces = manifest.pieces.filter((p) => p.license === "Public Domain");
  if (pdPieces.length === 0) throw new Error("no Public Domain pieces in the corpus manifest");

  const samples: MelodicSample[] = [];
  const piecesIngested: string[] = [];
  const piecesSkipped: { id: string; reason: string }[] = [];
  const barSamples = new Map<string, number>();
  const maxSteps = MAX_BARS_PER_PIECE * 16;

  for (const piece of pdPieces) {
    const filePath = path.join(midiDir, path.basename(piece.file));
    if (!existsSync(filePath)) {
      piecesSkipped.push({ id: piece.id, reason: "file missing" });
      continue;
    }
    try {
      const parsed = parseMidiFile(new Uint8Array(readFileSync(filePath)));
      if (!parsed.bpm || parsed.bpm < 30 || parsed.bpm > 240) {
        piecesSkipped.push({ id: piece.id, reason: `implausible bpm ${parsed.bpm}` });
        continue;
      }
      const split = splitRoles(parsed);
      if (!split.key) {
        piecesSkipped.push({ id: piece.id, reason: "key detection below confidence bar" });
        continue;
      }
      let pieceSamples = 0;
      for (const role of ["bass", "chord", "lead"] as const) {
        const events = toDegreeEvents(split[role], role, split.key, maxSteps);
        if (events.length < 8) continue; // too short to teach transitions
        // One leak-guard group per piece+role: the trainer keeps corpus rows
        // train-only anyway (never in the held-out library validation), and
        // per-piece grouping guarantees a piece's bars are never split
        // across train/val even if the corpus is ever promoted to the base set.
        const roleSamples = collectSamples(events, `classical.${eraOf(piece)}#midi:${piece.id}`, "ambient", role, MAX_SAMPLES_PER_ROLE);
        for (const s of roleSamples) {
          samples.push(s);
          pieceSamples++;
        }
        barSamples.set(role, (barSamples.get(role) ?? 0) + roleSamples.length);
      }
      if (pieceSamples > 0) piecesIngested.push(piece.id);
      else piecesSkipped.push({ id: piece.id, reason: "no role cleared the content bars" });
    } catch (error) {
      piecesSkipped.push({ id: piece.id, reason: `parse error: ${error instanceof Error ? error.message : "unknown"}` });
    }
  }

  // Sanity: fixed feature width, finite values, class ranges (base generator contract).
  for (const sample of samples) {
    if (sample.x.length !== MELODIC_FEATURE_COUNT) throw new Error("feature width drift");
    if (sample.degree < 0 || sample.degree > 7) throw new Error("degree class out of range");
    if (sample.duration < 0 || sample.duration >= MELODIC_DURATION_VALUES.length) throw new Error("duration out of range");
    for (const value of sample.x) if (!Number.isFinite(value)) throw new Error("non-finite feature");
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, "midi-melodic-dataset.json");
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        datasetVersion: "midi-melodic-v1",
        featureVersion: MELODIC_FEATURES_VERSION,
        featureCount: MELODIC_FEATURE_COUNT,
        durationValues: MELODIC_DURATION_VALUES,
        samples: samples.length,
        groups: new Set(samples.map((s) => s.group)).size,
        source: "Mutopia Project (Public Domain) via Defiance99/midi-catalog",
        licenseManifest: "scripts/data/midi-corpus/manifest.json",
        data: samples,
      },
      null,
      0,
    ),
  );

  const report = {
    piecesIngested: piecesIngested.length,
    piecesSkipped: piecesSkipped.length,
    skipReasons: piecesSkipped.reduce<Record<string, number>>((acc, s) => {
      acc[s.reason] = (acc[s.reason] ?? 0) + 1;
      return acc;
    }, {}),
    samplesByRole: Object.fromEntries(barSamples),
    totalSamples: samples.length,
  };
  console.log(`[midi-corpus] ingested ${report.piecesIngested}/${pdPieces.length} pieces → ${samples.length} samples`);
  console.log(`[midi-corpus] by role: ${JSON.stringify(report.samplesByRole)}`);
  console.log(`[midi-corpus] skipped: ${JSON.stringify(report.skipReasons)}`);
  console.log(`[midi-corpus] dataset → ${outPath}`);
}

main();