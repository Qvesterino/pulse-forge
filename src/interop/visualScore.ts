import type { ProjectDocument } from "../project-model/types";
import { arrangementSecondsBetweenTicks } from "../project-model/scene-time";
import { chordName } from "../project-model/chords";
import { ticksPerBar } from "../project-model/schema";

/**
 * VISUAL SCORE — the declarative dramaturgy export for the Audio Canvas
 * visualizer (ATOOMA interop, schema-free JSON artifact).
 *
 * The handoff v2 already carries the SOUND (WAV master, stems, bpm, key,
 * beat-grid phase). This artifact carries the STRUCTURE: sections with roles,
 * markers, chord events and per-section intensity — everything KYX *knows*
 * about the song's dramaturgy because it authored it. Audio Canvas's
 * SectionDetector GUESSES sections from energy heuristics; the visual score
 * REPLACES the guess with the truth (declared beats inferred).
 *
 * All times are SECONDS in the rendered WAV's timeline, resolved through the
 * scene-tempo-aware tick→seconds mapping (the same math the transport and
 * scheduler use), so the score aligns with the audio at any tempo map.
 */

export interface VisualScoreSection {
  role: string;
  label: string;
  startBar: number;
  bars: number;
  /** Start time in the rendered audio (seconds). */
  startSec: number;
  endSec: number;
  /** Scene intensity 0..1 for this section's span. */
  intensity: number;
}

export interface VisualScoreMarker {
  name: string;
  type: string;
  sec: number;
}

export interface VisualScoreChord {
  /** Root pitch class 0–11 (C = 0). */
  root: number;
  quality: string;
  name: string;
  startBar: number;
  lengthBars: number;
  startSec: number;
  endSec: number;
}

export interface VisualScore {
  version: 1;
  generatedAt: string;
  sourceApp: "pulse_forge";
  bpm: number | null;
  key: string | null;
  mode: "major" | "minor" | null;
  camelot: string | null;
  durationSec: number;
  sections: VisualScoreSection[];
  markers: VisualScoreMarker[];
  chords: VisualScoreChord[];
  /** Per-section intensity samples (bar-aligned, scene-tempo aware). */
  intensity: Array<{ startSec: number; endSec: number; value: number }>;
}

function keyToMode(key: ProjectDocument["key"]): "major" | "minor" | null {
  if (!key) return null;
  return /Minor/i.test(key) ? "minor" : /Major/i.test(key) ? "major" : null;
}

/** Build the declarative visual score for the whole arrangement. */
export function buildVisualScore(doc: ProjectDocument, durationSec: number): VisualScore {
  const clips = [...doc.arrangement.clips].sort((a, b) => a.startBar - b.startBar);
  const barStartSec = (bar: number): number =>
    arrangementSecondsBetweenTicks(
      doc.arrangement.clips,
      doc.scenes,
      0,
      bar * ticksPerBar(doc),
      doc.bpm,
      ticksPerBar(doc),
    );

  const sections: VisualScoreSection[] = [];
  const intensity: VisualScore["intensity"] = [];
  for (const clip of clips) {
    const scene = doc.scenes.find((s) => s.id === clip.sceneId);
    const startSec = barStartSec(clip.startBar);
    const endSec = barStartSec(clip.startBar + clip.lengthBars);
    sections.push({
      role: (scene?.role as string) ?? "custom",
      label: scene?.name ?? clip.sceneId,
      startBar: clip.startBar,
      bars: clip.lengthBars,
      startSec,
      endSec,
      intensity: Math.max(0, Math.min(1, scene?.intensity ?? 0.7)),
    });
    intensity.push({ startSec, endSec, value: Math.max(0, Math.min(1, scene?.intensity ?? 0.7)) });
  }

  const markers: VisualScoreMarker[] = (doc.markers ?? []).map((marker) => ({
    name: marker.name,
    type: marker.type,
    sec: arrangementSecondsBetweenTicks(doc.arrangement.clips, doc.scenes, 0, marker.tick, doc.bpm, ticksPerBar(doc)),
  }));

  const chords: VisualScoreChord[] = (doc.arrangement.chords ?? []).map((chord) => {
    const startSec = barStartSec(chord.startBar);
    return {
      root: chord.root,
      quality: chord.quality,
      name: chordName(chord.root, chord.quality),
      startBar: chord.startBar,
      lengthBars: chord.lengthBars,
      startSec,
      endSec: barStartSec(chord.startBar + chord.lengthBars),
    };
  });

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    sourceApp: "pulse_forge",
    bpm: Number.isFinite(doc.bpm) ? doc.bpm : null,
    key: doc.key ?? null,
    mode: keyToMode(doc.key),
    camelot: null,
    durationSec,
    sections,
    markers,
    chords,
    intensity,
  };
}

/** The handoff artifact type for the visual score input. */
export const VISUAL_SCORE_ARTIFACT_TYPE = "kyx_visual_score";
