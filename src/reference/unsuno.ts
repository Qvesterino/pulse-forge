/**
 * U4 — UN-SUNO RECONSTRUCTION: transcription → editable project (one undo).
 *
 * Pure `(doc, input, options) → Command`, the apply.ts contract: everything
 * is decided here, the panel only executes the result. The command composes
 * plain commands into a `next` document and wraps it in ONE `snapshot()`, so
 * a single Ctrl-Z removes the whole reconstruction.
 *
 * What lands in the project:
 * - BPM + project key (confirmed user values win over detected; the tempo
 *   reading applies half/double exactly like the Reference Map apply seam);
 * - a drum track, a bass track ("bass") and a chord track ("keys") — created
 *   only when their layer carries content (honest: no layer, no empty track);
 * - ONE pattern per section chunk (≤ 8 bars = 128 steps, the pattern ceiling;
 *   longer sections chunk into `<name> pt N`), holding the drum rows (when
 *   the U3 layer is implemented — skipped honestly with a warning today),
 *   the bass notes for its time window (seconds → ticks) and the chord
 *   voicings (spans → voice-led triads/sevenths, the multi-voice convention);
 * - a scene per pattern (the arrangement handle) and a marker per section;
 * - patterns are named `UN-SUNO <section role>`.
 *
 * Honesty: a section without any detectable content still gets its pattern
 * shell (so the arrangement skeleton matches the source), but empty layers
 * are reported in the result, never faked. Deterministic: no RNG anywhere.
 */
import {
  PPQ,
  STEP_TICKS,
  BAR_TICKS,
  type MusicalKey,
  type ProjectDocument,
  type NoteEvent,
} from "../project-model/types";
import { snapshot } from "../commands/core";
import { setBpm } from "../commands/project";
import { setProjectKey } from "../commands/metadata";
import { createDrumTrack, createInstrumentTrack } from "../commands/tracks";
import { addAudioClip } from "../commands/audioClips";
import { createPattern, setPatternLength } from "../commands/patterns";
import { addMarker } from "../commands/markers";
import { createScene, setScenePattern } from "../commands/scenes";
import { musicalKeyFor } from "./apply";
import { voiceLead } from "../ai/harmony";
import { inferPadRole } from "../ai/pad-roles";
import type { Command } from "../commands/types";
import type { UnsunoTranscription, TranscribedChordSpan } from "./transcribe";

/** One arrangement section — normally `ReferenceMap.structure.sections`. */
export interface UnsunoSection {
  role: string;
  startSec: number;
  endSec: number;
  energy?: number;
}

export interface UnsunoInput {
  transcription: UnsunoTranscription;
  /** Section skeleton (energy curve roles). Absent → one "full" section. */
  sections?: readonly UnsunoSection[];
}

export interface UnsunoOptions {
  /** Tempo reading — "half"/"double" rescales the detected BPM. */
  reading?: "as-detected" | "half" | "double";
  /** Confirmed values win over everything detected (the apply.ts rule). */
  confirmedBpm?: number | null;
  confirmedKey?: { tonic: string; mode: "major" | "minor" } | null;
  /** Max pattern size in bars before chunking (pattern ceiling is 128 steps). */
  maxPatternBars?: number;
  /**
   * U4.5 — SOURCE AUDIO LANE. The bank id of the imported original file
   * (the caller imports it through the user-sample flow BEFORE reconstructing;
   * the command only references the buffer). When present, a sampler track
   * carrying the full original as one arrangement clip is added — the
   * reference layer you remix against. The clip's stretchRate warps it to
   * the project grid; `needsWarpWarm` in the result tells the caller to
   * warm the WarpManager after executing (the command stays pure).
   */
  sourceSampleId?: string | null;
}

export interface UnsunoResult {
  command: Command | null;
  /** Human summary for the panel status line. */
  summary: string;
  /** Per-layer notes — empty layers with their reason (never silent). */
  layers: Record<string, string>;
  bpm: number | null;
  patternCount: number;
  /** The source-audio clip needs a WarpManager warm-up after execute. */
  needsWarpWarm: boolean;
}

/** Chord voicing sits in C4 territory, bass an octave and a half below. */
const CHORD_BASE_MIDI = 48;
const BASS_MIN_MIDI = 24;
const BASS_MAX_MIDI = 60;

function effectiveBpm(transcription: UnsunoTranscription, options: UnsunoOptions): number | null {
  if (options.confirmedBpm && options.confirmedBpm > 0) return Math.round(options.confirmedBpm);
  let bpm = transcription.tempo?.bpm ?? null;
  if (bpm === null) return null;
  if (options.reading === "half") bpm /= 2;
  if (options.reading === "double") bpm *= 2;
  return Math.round(bpm * 10) / 10;
}

/** Parse the estimator string into the MusicalKey the project model stores. */
function projectKeyOf(transcription: UnsunoTranscription, options: UnsunoOptions): MusicalKey | null {
  if (options.confirmedKey) return musicalKeyFor(options.confirmedKey.tonic, options.confirmedKey.mode);
  const key = transcription.key?.key;
  if (!key) return null;
  const parts = key.trim().split(/\s+/);
  if (parts.length < 2) return null;
  return musicalKeyFor(parts[0], key.toLowerCase().includes("minor") ? "minor" : "major");
}

/** Sections, or the honest fallback when the caller has no structure lane. */
function sectionsOf(input: UnsunoInput): UnsunoSection[] {
  if (input.sections && input.sections.length > 0) return [...input.sections];
  return [{ role: "full", startSec: 0, endSec: input.transcription.durationSec }];
}

/** Chunk a section into ≤ maxBars pieces so patterns stay under 128 steps. */
function chunkSection(section: UnsunoSection, bpm: number, maxBars: number): UnsunoSection[] {
  const barSec = 240 / bpm;
  const bars = Math.max(1, Math.round((section.endSec - section.startSec) / barSec));
  if (bars <= maxBars) return [section];
  const chunks: UnsunoSection[] = [];
  for (let i = 0; i < bars; i += maxBars) {
    const start = section.startSec + i * barSec;
    chunks.push({ ...section, startSec: start, endSec: Math.min(section.endSec, start + maxBars * barSec) });
  }
  return chunks;
}

/** Chord spans (or their silence) for one section window. */
function spansInSection(
  spans: readonly TranscribedChordSpan[],
  startSec: number,
  endSec: number,
  bpm: number,
): TranscribedChordSpan[] {
  const barSec = 240 / bpm;
  return spans.filter((span) => {
    const spanStart = span.startBar * barSec;
    const spanEnd = spanStart + span.bars * barSec;
    return spanStart < endSec && spanEnd > startSec;
  });
}

export function unsunoCommand(doc: ProjectDocument, input: UnsunoInput, options: UnsunoOptions = {}): UnsunoResult {
  const layers: Record<string, string> = {
    drums: "drums transcription pending (U3) — drum track skipped",
    bass: "no bass notes — bass track skipped",
    chords: "no chord spans — chord track skipped",
    source: "no source sample given",
  };
  const { transcription } = input;
  const bpm = effectiveBpm(transcription, options);
  if (bpm === null) {
    return {
      command: null,
      summary: "no tempo — cannot place a bar grid, nothing reconstructed",
      layers,
      bpm: null,
      patternCount: 0,
      needsWarpWarm: false,
    };
  }

  const key = projectKeyOf(transcription, options);
  const barSec = 240 / bpm;
  const maxBars = Math.min(8, Math.max(1, options.maxPatternBars ?? 8));

  // ── build the next document with plain commands, wrap once ──
  let next = doc;
  next = setBpm(next, Math.round(bpm)).execute(next);
  if (key) next = setProjectKey(next, key).execute(next);

  const ids = { drums: null as string | null, bass: null as string | null, chords: null as string | null };

  // Tracks: only when the layer carries content.
  const drumSlots = transcription.drums.kick.length + transcription.drums.snare.length + transcription.drums.hat.length;
  if (transcription.drums.implemented && drumSlots > 0) {
    next = createDrumTrack(next).execute(next);
    ids.drums = next.tracks[next.tracks.length - 1].id;
    layers.drums = transcription.drums.warning ?? `${drumSlots} drum steps transcribed`;
  }
  const bassNotes = transcription.bass.notes;
  if (bassNotes.length > 0) {
    next = createInstrumentTrack(next, "bass").execute(next);
    ids.bass = next.tracks[next.tracks.length - 1].id;
    layers.bass = `${bassNotes.length} bass notes transcribed`;
  }
  if (transcription.chords.spans.length > 0) {
    next = createInstrumentTrack(next, "keys").execute(next);
    ids.chords = next.tracks[next.tracks.length - 1].id;
    layers.chords = `${transcription.chords.spans.length} chord spans transcribed`;
  }

  // Patterns per section chunk (one pattern holds rows AND notes for all tracks).
  const sections = sectionsOf(input).flatMap((section) => chunkSection(section, bpm, maxBars));
  let patternCount = 0;
  let prevVoicing: number[] = [];
  const sectionCounts = new Map<string, number>();

  for (const section of sections) {
    const role = section.role || "section";
    const occurrence = sectionCounts.get(role) ?? 0;
    sectionCounts.set(role, occurrence + 1);
    const bars = Math.max(1, Math.round((section.endSec - section.startSec) / barSec));
    const steps = bars * 16;

    next = createPattern(next, `UN-SUNO ${role}`).execute(next);
    const patternId = next.activePatternId;
    next = setPatternLength(next, patternId, steps).execute(next);
    const pattern = next.patterns.find((p) => p.id === patternId)!;

    // The document is deep-frozen (snapshot contract) — the pattern is
    // REBUILT by spread, never mutated in place.
    let updatedPattern = { ...pattern, notes: { ...pattern.notes } };

    // Chord voicings — voice-led from the previous chunk's last chord.
    if (ids.chords) {
      const spans = spansInSection(transcription.chords.spans, section.startSec, section.endSec, bpm);
      const notes: NoteEvent[] = [];
      for (const span of spans) {
        const rootPc = span.rootPc;
        const rootPitch = CHORD_BASE_MIDI + rootPc;
        const basePitch = Math.abs(rootPitch - (prevVoicing[0] ?? rootPitch)) <= 6 ? rootPitch : rootPitch - 12;
        const voicing = voiceLead(prevVoicing, basePitch, span.quality).filter((p) => p > 0);
        prevVoicing = voicing;
        const spanStartTick = Math.max(0, Math.round(((span.startBar * barSec - section.startSec) * bpm * PPQ) / 60));
        const durationTicks = Math.max(STEP_TICKS, Math.round((span.bars * barSec * bpm * PPQ) / 60));
        voicing.forEach((pitch, index) => {
          notes.push({
            id: `us-ch-${patternId}-${span.startBar}-${index}`,
            pitch,
            start: spanStartTick,
            duration: durationTicks,
            velocity: span.quality.startsWith("min") ? 76 : 80,
          });
        });
      }
      updatedPattern.notes[ids.chords!] = notes;
    }

    // Bass notes — seconds inside the window → ticks.
    if (ids.bass) {
      const notes: NoteEvent[] = [];
      for (const note of bassNotes) {
        if (note.startSec < section.startSec || note.startSec >= section.endSec) continue;
        const startTick = Math.max(0, Math.round(((note.startSec - section.startSec) * bpm * PPQ) / 60));
        const durationTicks = Math.max(
          STEP_TICKS,
          Math.round((Math.min(note.durationSec, section.endSec - note.startSec) * bpm * PPQ) / 60),
        );
        notes.push({
          id: `us-b-${patternId}-${notes.length}`,
          pitch: Math.max(BASS_MIN_MIDI, Math.min(BASS_MAX_MIDI, note.midi)),
          start: startTick,
          duration: durationTicks,
          velocity: note.velocity,
        });
      }
      updatedPattern.notes[ids.bass!] = notes;
    }

    // Drum rows — the U3 pattern slots mapped onto the default kit through
    // pad-role resolution (never by index): kick/snares get their inferred
    // pads, hats land on the first closedHat. Per-section maps (U3.5) win
    // when one covers this chunk's midpoint; the whole-track fold is the
    // fallback so the rows are never empty merely because a window missed.
    if (ids.drums && drumSlots > 0) {
      const drumTrack = next.tracks.find((t) => t.id === ids.drums);
      if (drumTrack && drumTrack.kind === "drum") {
        const rows: Record<string, number[]> = {};
        for (const pad of drumTrack.pads) rows[pad.id] = new Array<number>(steps).fill(0);
        const midSec = (section.startSec + section.endSec) / 2;
        const sectionMap = transcription.drums.sections?.find(
          (entry) => midSec >= entry.startSec && midSec < entry.endSec,
        );
        const hasSlots = (pattern_: { kick: number[]; snare: number[]; hat: number[] }): boolean =>
          pattern_.kick.length + pattern_.snare.length + pattern_.hat.length > 0;
        const chosen =
          sectionMap && hasSlots(sectionMap)
            ? sectionMap
            : {
                kick: transcription.drums.kick,
                snare: transcription.drums.snare,
                hat: transcription.drums.hat,
              };
        const slotPattern: Record<string, number[]> = {
          kick: chosen.kick,
          snare: chosen.snare,
          hat: chosen.hat,
        };
        const taken = new Set<string>();
        drumTrack.pads.forEach((pad, index) => {
          const role = inferPadRole(pad.name, index);
          if (role === "kick" && !taken.has("kick")) {
            for (const step of slotPattern.kick) if (step < steps) rows[pad.id][step] = 0.9;
            taken.add("kick");
          } else if ((role === "snare" || role === "clap") && !taken.has("snare")) {
            for (const step of slotPattern.snare) if (step < steps) rows[pad.id][step] = 0.85;
            taken.add("snare");
          } else if (role === "closedHat" && !taken.has("hat")) {
            for (const step of slotPattern.hat) if (step < steps) rows[pad.id][step] = 0.6;
            taken.add("hat");
          }
        });
        updatedPattern = { ...updatedPattern, rows };
      }
    }

    next = { ...next, patterns: next.patterns.map((p) => (p.id === patternId ? updatedPattern : p)) };

    // Scene per pattern — the arrangement handle.
    next = createScene(next, `${role} ${occurrence + 1}`).execute(next);
    const sceneId = next.scenes[next.scenes.length - 1].id;
    next = setScenePattern(next, sceneId, patternId).execute(next);

    // Marker at the section start.
    if (section.startSec > 0) {
      const tick = Math.round((section.startSec * bpm * PPQ) / 60 / BAR_TICKS) * BAR_TICKS;
      next = addMarker(next, { tick, type: "cue", name: `${role} ${occurrence + 1}` }).execute(next);
    }
    patternCount += 1;
  }

  // ── U4.5 source-audio lane: the original as one arrangement clip ──
  let needsWarpWarm = false;
  const sourceSampleId = options.sourceSampleId?.trim();
  if (sourceSampleId && transcription.durationSec > 0.5) {
    next = createInstrumentTrack(next, "sampler").execute(next);
    const carrier = next.tracks[next.tracks.length - 1];
    const barSec = 240 / bpm;
    // Playback rate = the pure BPM ratio (project grid vs the detected
    // source tempo). A length-fit rate would silently absorb tempo
    // differences through fractional bars; the ratio makes the warp honest
    // and triggers the warm-up exactly when the grids disagree.
    const sourceBpm = transcription.tempo?.bpm ?? bpm;
    const stretchRate = Math.min(4, Math.max(0.25, Math.round((bpm / sourceBpm) * 1000) / 1000));
    const lengthBars = Math.max(0.25, Math.ceil((transcription.durationSec / stretchRate / barSec) * 100) / 100);
    needsWarpWarm = Math.abs(stretchRate - 1) > 0.01;
    next = addAudioClip(next, carrier.id, sourceSampleId, 0, lengthBars, {
      gain: 0.9,
      fadeOut: 0.01,
      stretchRate,
    }).execute(next);
    layers.source = `original attached (${lengthBars} bars${needsWarpWarm ? `, warp ×${stretchRate.toFixed(2)}` : ""})`;
  } else if (sourceSampleId) {
    layers.source = "source sample given but too short to attach";
  }

  const command = snapshot("unsuno", `UN-SUNO reconstruct — ${patternCount} section pattern(s), ${bpm} BPM`, doc, next);
  const parts = [ids.drums ? "drums" : null, ids.bass ? "bass" : null, ids.chords ? "chords" : null].filter(Boolean);
  return {
    command,
    summary: `${patternCount} pattern(s) · ${parts.join(" + ") || "no layers"} · ${bpm} BPM${key ? ` · ${key}` : ""}${needsWarpWarm ? " · source warped" : ""}`,
    layers,
    bpm,
    patternCount,
    needsWarpWarm,
  };
}
