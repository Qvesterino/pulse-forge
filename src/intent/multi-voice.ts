import type { MusicalKey, NoteEvent, ProjectDocument } from "../project-model/types";
import { STEP_TICKS } from "../project-model/types";
import { parseKey, SCALE_INTERVALS, snapToScale } from "../project-model/scales";
import { uid } from "../shared/ids";
import { forkRandom } from "../shared/rng";
import { MELODIC_BY_GENRE } from "../ai/grooves/melodic-data";
import {
  selectProgression,
  expandProgression,
  chordToneSemitones,
  voiceLead,
  type ChordEvent,
} from "../ai/harmony";

/**
 * MULTI-VOICE ORCHESTRATOR (INTENT_ENGINE.md #1+2) — the three melodic voices
 * (bass, chords, lead) are generated SEQUENTIALLY with harmonic awareness:
 *
 *   1. CHORD PROGRESSION is selected from the genre library (functional
 *      harmony: I-IV-V, i-VI-III-VII, etc.) and expanded to fill the pattern.
 *   2. CHORDS are placed on the progression's chord roots, voiced with
 *      voice-leading (minimal movement from the previous voicing).
 *   3. BASS follows the chord ROOTS (with octave jumps and passing notes),
 *      sidechain-aware (ducks under the kick).
 *   4. LEAD uses chord tones (root, 3rd, 5th) + approach tones from the
 *      scale, resolving onto targets (tension → resolution).
 *
 * All three voices share the SAME harmonic foundation — the result sounds
 * like a BAND playing together, not three unrelated MIDI tracks.
 */

export interface MultiVoiceResult {
  bass: NoteEvent[];
  chord: NoteEvent[];
  lead: NoteEvent[];
  /** The progression used — for diagnostics and provenance. */
  progressionName: string;
  progressionDegree: number;
}

/** Rhythmic patterns per role (steps relative to section start). */
const RHYTHM_LEAD = [0, 3, 6, 8, 11, 14]; // syncopated pattern

/** Expanded chord timeline — one chord per entry with start step. */
interface ChordSlot {
  event: ChordEvent;
  startStep: number;
  endStep: number;
}

function expandToSlots(progressionEvents: ChordEvent[], stepCount: number): ChordSlot[] {
  const slots: ChordSlot[] = [];
  let step = 0;
  for (const event of progressionEvents) {
    if (step >= stepCount) break;
    const end = Math.min(step + event.duration, stepCount);
    slots.push({ event, startStep: step, endStep: end });
    step = end;
  }
  // Fill remaining steps by looping the last chord
  if (slots.length > 0 && step < stepCount) {
    const last = slots[slots.length - 1];
    while (step < stepCount) {
      const end = Math.min(step + last.event.duration, stepCount);
      slots.push({ event: last.event, startStep: step, endStep: end });
      step = end;
    }
  }
  return slots;
}

/** Find the chord slot at a given step. */
function chordAtStep(slots: ChordSlot[], step: number): ChordSlot | null {
  for (const slot of slots) {
    if (step >= slot.startStep && step < slot.endStep) return slot;
  }
  return slots.length > 0 ? slots[slots.length - 1] : null;
}

/** Get the octave offset for a role from the genre's melodic data. */
function octaveOffsetFor(genre: string, role: string): number {
  const pattern = MELODIC_BY_GENRE[genre]?.find((entry) => entry.role === role);
  return pattern ? pattern.octaveOffset : role === "bass" ? 0 : role === "chord" ? 1 : 2;
}

/**
 * Generate the three melodic voices with harmonic awareness.
 * This replaces independent Markov chains with a UNIFIED harmonic model.
 */
export function generateMultiVoice(
  _doc: ProjectDocument,
  genre: string,
  seed: number,
  stepCount: number,
  key: MusicalKey | null,
  energy: number,
  velocityVariation: number,
): MultiVoiceResult {
  const rand = forkRandom(`${seed}|harmony`, "stream");
  const progression = selectProgression(genre, seed);
  const expanded = expandProgression(progression, stepCount);
  const slots = expandToSlots(expanded, stepCount);

  const parsedKey = key ? parseKey(key) : null;
  const root = parsedKey?.root ?? 0;
  const intervals = SCALE_INTERVALS[parsedKey?.scaleType ?? "major"];

  const bars = stepCount / 16;
  const velocitySpread = 0.08 + velocityVariation * 0.1;

  // ── Voice 1: CHORDS (the harmonic foundation) ─────────────────────────
  const chordEvents: NoteEvent[] = [];
  const chordOctave = octaveOffsetFor(genre, "chord");
  let prevChordPitches: number[] = [];

  for (const slot of slots) {
    const quality = slot.event.quality;
    const rootPitch = root + intervals[slot.event.degree % intervals.length];
    const basePitch = 3 * 12 + chordOctave * 12 + rootPitch;

    // Voice leading: minimise movement from the previous chord
    const voicedPitches = voiceLead(
      prevChordPitches,
      basePitch,
      quality,
    );

    const velocity = Math.max(0.15, Math.min(1, 0.6 + (rand() - 0.5) * velocitySpread));
    const durationSteps = slot.endStep - slot.startStep;

    for (const pitch of voicedPitches) {
      const snapped = key ? snapToScale(pitch, key) : pitch;
      chordEvents.push({
        id: uid("note"),
        pitch: Math.max(0, Math.min(127, snapped)),
        start: slot.startStep * STEP_TICKS,
        duration: durationSteps * STEP_TICKS,
        velocity,
      });
    }
    prevChordPitches = voicedPitches.map((pitch) => pitch);
  }

  // ── Voice 2: BASS (follows the chord roots) ──────────────────────────
  const bassEvents: NoteEvent[] = [];
  const bassOctave = octaveOffsetFor(genre, "bass");

  for (const slot of slots) {
    const rootPitch = root + intervals[slot.event.degree % intervals.length];
    const bassPitch = 3 * 12 + bassOctave * 12 + rootPitch;

    // Bass rhythm: 8th notes with accent on downbeat
    for (let step = slot.startStep; step < slot.endStep; step += 2) {
      const isDownbeat = (step - slot.startStep) === 0;
      const velocity = isDownbeat
        ? Math.min(1, 0.85 + rand() * 0.1)
        : Math.max(0.3, 0.5 + (rand() - 0.5) * velocitySpread * 2);
      const duration = 2; // 8th note
      bassEvents.push({
        id: uid("note"),
        pitch: Math.max(0, Math.min(127, bassPitch)),
        start: step * STEP_TICKS,
        duration: duration * STEP_TICKS,
        velocity,
      });
    }
  }

  // ── Voice 3: LEAD (chord tones + approach notes) ─────────────────────
  const leadEvents: NoteEvent[] = [];
  const leadOctave = octaveOffsetFor(genre, "lead");

  if (energy > 0.4) {
    // Lead exists only when energy is high enough
    for (let bar = 0; bar < bars; bar++) {
      const barStart = bar * 16;
      for (const rhythmStep of RHYTHM_LEAD) {
        const step = barStart + rhythmStep;
        if (step >= stepCount) continue;
        const slot = chordAtStep(slots, step);
        if (!slot) continue;

        // Chord tone selection: root, 3rd, or 5th of the current chord
        const chordRoot = root + intervals[slot.event.degree % intervals.length];
        const tones = chordToneSemitones(slot.event.quality);
        const toneIndex = Math.floor(rand() * tones.length);
        const toneOffset = tones[toneIndex];

        // Approach: 50% chance to use a scale neighbour (approach tone)
        const isApproach = rand() < 0.3 && step > 0;
        const pitch = 3 * 12 + leadOctave * 12 + chordRoot + toneOffset + (isApproach ? (rand() > 0.5 ? 1 : -1) : 0);
        const snapped = key ? snapToScale(pitch, key) : pitch;

        const velocity = Math.max(0.2, Math.min(1, 0.7 + (rand() - 0.5) * velocitySpread * 2));
        leadEvents.push({
          id: uid("note"),
          pitch: Math.max(0, Math.min(127, snapped)),
          start: step * STEP_TICKS,
          duration: 1 * STEP_TICKS, // 16th note lead
          velocity,
        });
      }
    }
  }

  return {
    bass: bassEvents,
    chord: chordEvents,
    lead: leadEvents,
    progressionName: progression.name,
    progressionDegree: progression.events[0]?.degree ?? 0,
  };
}
