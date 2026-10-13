/**
 * HUM→VOICE ENSEMBLE (KROK 1 of the HUM A HIT roadmap, 2026-10-12) — a
 * vocal STACK from ONE hum: the voiceified render staged once, played by
 * three vocalchop tracks with identity constants:
 *
 *   Lead    — pitch 62 (root 60 + 2, the Hook convention), pan 0,   gain 1.0
 *   Double  — same pitch, notes offset ~20 ms, pan -0.5,            gain 0.6
 *   Harmony — pitch +3 (parallel minor third),          pan +0.5, gain 0.5
 *
 * All constants — offsets and intervals are NEVER random, so the same hum
 * always renders the same stack. Re-apply matches the tracks by name prefix
 * ("Voice Ensemble — hum") and refreshes sampleId to the new render (a
 * re-apply carries a new staged buffer by definition). ONE undoable
 * snapshot installs/updates all three.
 */
import { createInstrumentTrackModel } from "../project-model/schema";
import { uid } from "../shared/ids";
import { snapshot } from "../commands/commands";
import { HOOK_PARAMS } from "./adapt";
import type { Command } from "../commands/types";
import type { InstrumentTrack, NoteEvent, ProjectDocument } from "../project-model/types";

export interface VoiceEnsembleOptions {
  /** The voiceified render's bank id (the caller stages the Float32Array). */
  bufferId: string;
  /** The render's length in ticks — the stack notes span it. */
  renderTicks: number;
  /** Project tempo — the double's ~20 ms offset converts through it. */
  bpm: number;
  /** Harmony interval in semitones above the lead. Default 3 (minor third). */
  harmonyInterval?: 3 | 4;
  patternId?: string;
}

export interface VoiceEnsembleOutcome {
  ok: boolean;
  label?: string;
  command?: Command;
  trackIds?: string[];
  error?: string;
}

const ENSEMBLE_PREFIX = "Voice Ensemble — hum";
const DOUBLE_OFFSET_MS = 20;

export function applyVocalEnsembleCommand(doc: ProjectDocument, options: VoiceEnsembleOptions): VoiceEnsembleOutcome {
  if (typeof options.bufferId !== "string" || options.bufferId === "") {
    throw new Error("The voiceified render is not staged — stage the voiceify render first");
  }
  if (!Number.isFinite(options.renderTicks) || options.renderTicks <= 0) {
    throw new Error("The voice ensemble needs the render's length in ticks");
  }
  const patternId = options.patternId ?? doc.activePatternId;
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error("No active pattern to plant the ensemble into");

  const harmony = options.harmonyInterval ?? 3;
  const renderTicks = Math.max(1, Math.round(options.renderTicks));
  // ~20 ms in ticks at the project tempo (the double's time offset).
  const doubleOffsetTicks = Math.max(1, Math.round((DOUBLE_OFFSET_MS / 1000) * (options.bpm / 60) * 480));

  // Pan is a TRACK property in this model — the note only spans the render.
  const spanNote = (pitch: number, startTicks: number): NoteEvent => ({
    id: uid("note"),
    pitch,
    start: startTicks,
    duration: renderTicks,
    velocity: 0.8,
  });

  interface Voice {
    name: string;
    pitch: number;
    startTicks: number;
    pan: number;
    gain: number;
  }
  const voices: Voice[] = [
    { name: `${ENSEMBLE_PREFIX} (Lead)`, pitch: 62, startTicks: 0, pan: 0, gain: 1.0 },
    { name: `${ENSEMBLE_PREFIX} (Double)`, pitch: 62, startTicks: doubleOffsetTicks, pan: -0.5, gain: 0.6 },
    { name: `${ENSEMBLE_PREFIX} (Harmony)`, pitch: 62 + harmony, startTicks: 0, pan: 0.5, gain: 0.5 },
  ];

  // Re-apply matches the ensemble by name prefix and REFRESHES sampleId to
  // the new render (a re-apply carries a new staged buffer by definition).
  const isEnsembleTrack = (t: ProjectDocument["tracks"][number]): t is InstrumentTrack =>
    t.kind === "instrument" && t.name.startsWith(ENSEMBLE_PREFIX);
  const existing = doc.tracks.filter(isEnsembleTrack);
  const byName = new Map(existing.map((t) => [t.name, t]));

  let tracks: ProjectDocument["tracks"] = doc.tracks;
  const trackIds: string[] = [];
  const notesByTrack = new Map<string, NoteEvent[]>();

  for (const voice of voices) {
    const reused = byName.get(voice.name);
    let track: InstrumentTrack;
    if (reused) {
      track =
        reused.sampleId === options.bufferId && reused.pan === voice.pan
          ? reused
          : { ...reused, sampleId: options.bufferId, pan: voice.pan, gain: voice.gain };
      tracks = tracks.map((t) => (t.id === track.id ? track : t));
    } else {
      const count = existing.length + trackIds.length + 1;
      track = {
        ...createInstrumentTrackModel("vocalchop", count),
        name: voice.name,
        sampleId: options.bufferId,
        params: { ...HOOK_PARAMS },
        pan: voice.pan,
        gain: voice.gain,
      };
      tracks = [...tracks, track];
    }
    trackIds.push(track.id);
    notesByTrack.set(track.id, [spanNote(voice.pitch, voice.startTicks)]);
  }

  const next: ProjectDocument = {
    ...doc,
    tracks,
    patterns: doc.patterns.map((p) => {
      if (p.id !== pattern.id) return p;
      const merged = { ...p.notes };
      for (const [trackId, notes] of notesByTrack) merged[trackId] = notes;
      return { ...p, notes: merged };
    }),
  };
  return {
    ok: true,
    label: `Voice ensemble: your hum times 3 (lead + double + harmony +${harmony} st)`,
    command: snapshot("applyVocalEnsemble", "Voice ensemble from your hum", doc, next),
    trackIds,
  };
}
