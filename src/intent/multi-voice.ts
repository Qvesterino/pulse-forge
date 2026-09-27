import type { MusicalKey, NoteEvent, ProductionProfile, ProjectDocument } from "../project-model/types";
import { STEP_TICKS } from "../project-model/types";
import { parseKey, SCALE_INTERVALS, snapToScale } from "../project-model/scales";
import { uid } from "../shared/ids";
import { forkRandom } from "../shared/rng";
import { MELODIC_BY_GENRE, MELODIC_BY_PROFILE } from "../ai/grooves/melodic-data";
import { selectProgression, expandProgression, chordToneSemitones, voiceLead, type ChordEvent } from "../ai/harmony";

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
const RHYTHM_LEAD_FULL = [0, 3, 6, 8, 11, 14]; // syncopated pattern (high energy)
const RHYTHM_LEAD_SPARSE = [0, 8, 11]; // sparser subset (mid energy)

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
function octaveOffsetFor(genre: string, role: string, profile?: ProductionProfile): number {
  const patterns = (profile ? MELODIC_BY_PROFILE[profile] : undefined) ?? MELODIC_BY_GENRE[genre];
  const pattern = patterns?.find((entry) => entry.role === role);
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
  density = 0.5,
  complexity = 0.5,
  productionProfile?: ProductionProfile,
  flow?: "straight" | "triplet" | "offbeat",
): MultiVoiceResult {
  const rand = forkRandom(`${seed}|harmony`, "stream");
  const progression = selectProgression(genre, seed);
  const expanded = expandProgression(progression, stepCount);
  const slots = expandToSlots(expanded, stepCount);
  const spaceyProfile = productionProfile === "spacey-melodic-rap" || productionProfile === "spacey-dark-trap";
  const chordSlots = spaceyProfile
    ? slots
        .filter((_, index) => index % 2 === 0)
        .map((slot, index, selected) => ({
          ...slot,
          endStep: selected[index + 1]?.startStep ?? stepCount,
        }))
    : slots;

  const parsedKey = key ? parseKey(key) : null;
  const root = parsedKey?.root ?? 0;
  const intervals = SCALE_INTERVALS[parsedKey?.scaleType ?? (productionProfile ? "natural_minor" : "major")];

  const bars = stepCount / 16;
  const velocitySpread = 0.08 + velocityVariation * 0.1;

  // P2 melodic dynamics — energy/density/complexity shape all three voices.
  // Every gain is identity at the intent defaults (energy 0.7, density 0.5,
  // complexity 0.5): default calls (including the 7-arg legacy form) render
  // bit-identical output, so golden fixtures stay green.
  const energyVelocityGain = Math.max(0.5, Math.min(1.3, 1 + (energy - 0.7) * 0.8));
  const approachChance = 0.3 * (0.7 + complexity * 0.6); // 0.5 → 0.3
  const bassPickupChance = Math.max(0, (density - 0.5) * 1.2); // 0.5 → 0 (8ths only)

  // ── Voice 1: CHORDS (the harmonic foundation) ─────────────────────────
  const chordEvents: NoteEvent[] = [];
  const chordOctave = octaveOffsetFor(genre, "chord", productionProfile);
  let prevChordPitches: number[] = [];

  for (const slot of chordSlots) {
    const quality = slot.event.quality;
    const rootPitch = root + intervals[slot.event.degree % intervals.length];
    const basePitch = 3 * 12 + chordOctave * 12 + rootPitch;

    // Voice leading: minimise movement from the previous chord
    const voicedPitches = voiceLead(prevChordPitches, basePitch, quality);

    const velocity = Math.max(0.15, Math.min(1, (0.6 + (rand() - 0.5) * velocitySpread) * energyVelocityGain));
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
  const bassOctave = octaveOffsetFor(genre, "bass", productionProfile);
  const bassStride = productionProfile === "spacey-melodic-rap" ? 4 : 1;

  for (const [slotIndex, slot] of slots.entries()) {
    const rootPitch = root + intervals[slot.event.degree % intervals.length];
    const bassPitch = 3 * 12 + bassOctave * 12 + rootPitch;
    // Next chord root for the P3 chromatic approach (null on the last slot).
    const nextSlot = slotIndex + 1 < slots.length ? slots[slotIndex + 1] : null;
    const nextBassPitch =
      nextSlot !== null
        ? 3 * 12 + bassOctave * 12 + (root + intervals[nextSlot.event.degree % intervals.length])
        : null;

    // Bass rhythm: 8th notes with accent on downbeat (P2: density above the
    // 0.5 default adds quiet 16th pickups between them). At the default no
    // extra rand() is consumed, so the 8th-note stream stays bit-identical.
    for (let step = slot.startStep; step < slot.endStep; step += 1) {
      if (bassStride > 1 && step % bassStride !== slot.startStep % bassStride) continue;
      const isEighth = step % 2 === 0;
      const isTail = step === slot.endStep - 1;
      // P3 passing tone: the last 16th before a chord change walks
      // chromatically into the next root from below (jazz approach into the
      // downbeat). Fully determined by the harmony — fixed velocity, no
      // rand() — density-gated alongside the pickups (off at the default).
      if (!isEighth && isTail && nextBassPitch !== null && bassPickupChance > 0) {
        bassEvents.push({
          id: uid("note"),
          pitch: Math.max(0, Math.min(127, nextBassPitch - 1)),
          start: step * STEP_TICKS,
          duration: 1 * STEP_TICKS,
          velocity: Math.max(0.15, Math.min(1, 0.35 * energyVelocityGain)),
        });
        continue;
      }
      if (!isEighth && bassPickupChance <= 0) continue;
      if (!isEighth && rand() >= bassPickupChance) continue;
      const isDownbeat = step - slot.startStep === 0;
      const velocity = isEighth
        ? isDownbeat
          ? Math.min(1, (0.85 + rand() * 0.1) * energyVelocityGain)
          : Math.max(0.3, (0.5 + (rand() - 0.5) * velocitySpread * 2) * energyVelocityGain)
        : Math.max(0.15, Math.min(1, (0.3 + rand() * 0.15) * energyVelocityGain));
      const duration = isEighth ? 2 : 1; // 8th note, 16th pickup
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
  const leadOctave = octaveOffsetFor(genre, "lead", productionProfile);

  if (energy > 0.4) {
    // Lead exists only when energy is high enough (P2: the rhythm thins to a
    // sparse subset below 0.7 instead of vanishing — identity at/above 0.7).
    const rhythmSteps = spaceyProfile
      ? energy >= 0.7
        ? [0, 8, 12]
        : [0, 8]
      : energy >= 0.7
        ? RHYTHM_LEAD_FULL
        : RHYTHM_LEAD_SPARSE;
    // Flow grid (roadmap: flow density) — per-bar NOTE START OFFSETS in
    // ticks, generated ON-grid instead of post-quantized: triplet 16ths
    // (80 ticks, the trap/detroit bounce — includes true triplet pairs the
    // straight 16th grid cannot represent) or the offbeat push (+60).
    // Bass and chords keep the straight grid — the groove anchors while
    // the lead flow rides.
    const TRIPLET_LEAD_FULL = [0, 80, 240, 320, 480, 560, 720, 960, 1040, 1200, 1440, 1680];
    const TRIPLET_LEAD_SPARSE = [0, 240, 480, 720, 960, 1200];
    const flowOffsets = (): number[] => {
      if (flow === "triplet") return spaceyProfile || energy < 0.7 ? TRIPLET_LEAD_SPARSE : TRIPLET_LEAD_FULL;
      if (flow === "offbeat") return rhythmSteps.map((s) => s * STEP_TICKS + STEP_TICKS / 2);
      return rhythmSteps.map((s) => s * STEP_TICKS);
    };
    // P3 motif carry: bar 0 is the motif — every 4th bar replays its rhythm
    // and tone choices transposed onto that bar's own chord (same idea, new
    // harmony — call-and-response across the phrase). Recorded, not
    // re-sampled: motif bars skip the tone/approach draws, velocities stay
    // fresh from the stream. The motif stores TICK OFFSETS so the flow grid
    // survives the replay.
    const motif: Array<{ offset: number; toneIndex: number; approachDir: number }> = [];
    for (let bar = 0; bar < bars; bar++) {
      const barStartTicks = bar * 16 * STEP_TICKS;
      const replay = bar > 0 && bar % 4 === 0 && motif.length > 0;
      const offsets = replay ? motif.map((m) => m.offset) : flowOffsets();
      for (let i = 0; i < offsets.length; i++) {
        const offset = offsets[i]!;
        const startTick = barStartTicks + offset;
        const maxTick = stepCount * STEP_TICKS;
        if (startTick >= maxTick) continue;
        const step = Math.floor(startTick / STEP_TICKS);
        const slot = chordAtStep(chordSlots, Math.min(step, stepCount - 1));
        if (!slot) continue;

        // Chord tone selection: root, 3rd, or 5th of the current chord
        const chordRoot = root + intervals[slot.event.degree % intervals.length];
        const tones = chordToneSemitones(slot.event.quality);
        let toneIndex: number;
        let approachDir = 0;
        if (replay) {
          toneIndex = motif[i].toneIndex;
          approachDir = motif[i].approachDir;
        } else {
          toneIndex = Math.floor(rand() * tones.length);
          // Approach tone: a scale neighbour instead of the chord tone itself
          // (P2: chance widens with complexity — 0.3 at the 0.5 default).
          const isApproach = rand() < approachChance && step > 0;
          approachDir = isApproach ? (rand() > 0.5 ? 1 : -1) : 0;
          if (bar === 0) motif.push({ offset, toneIndex, approachDir });
        }
        const toneOffset = tones[toneIndex % tones.length];

        const pitch = 3 * 12 + leadOctave * 12 + chordRoot + toneOffset + approachDir;
        const snapped = key ? snapToScale(pitch, key) : pitch;

        const velocity = Math.max(0.2, Math.min(1, (0.7 + (rand() - 0.5) * velocitySpread * 2) * energyVelocityGain));
        // Flow gating: on triplet/offbeat grids the note cuts at the next
        // flow position (rap staccato) instead of ringing over the grid.
        const baseDuration = (spaceyProfile ? 4 : 1) * STEP_TICKS;
        const gated =
          flow === "triplet" || flow === "offbeat"
            ? Math.max(STEP_TICKS / 2, Math.min(baseDuration, STEP_TICKS - (offset % STEP_TICKS) / 2))
            : baseDuration;
        leadEvents.push({
          id: uid("note"),
          pitch: Math.max(0, Math.min(127, snapped)),
          start: startTick,
          duration: Math.min(gated, Math.max(STEP_TICKS / 2, maxTick - startTick)),
          velocity,
        });
      }
    }
    // Overlap gate: within the lead voice a later note cuts the earlier one
    // (monophonic rap flow) — sort and clamp so no two notes sound at once.
    leadEvents.sort((a, b) => a.start - b.start);
    for (let i = 0; i < leadEvents.length - 1; i++) {
      const cur = leadEvents[i]!;
      const next = leadEvents[i + 1]!;
      if (cur.start + cur.duration > next.start) {
        cur.duration = Math.max(STEP_TICKS / 3, next.start - cur.start);
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
