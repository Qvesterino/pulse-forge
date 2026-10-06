/**
 * SIMILARITY ADVISORY (the last beat_modifier idea, rebuilt for KYX):
 * a NUMERICAL composition-overlap diagnostic between the source track's
 * transcription and the current project — "how much of the original
 * composition survives in what you have now".
 *
 * WHAT IT IS: three deterministic, purely symbolic components
 *   - DRUMS: Jaccard overlap of lit 16-slot patterns per band (mean),
 *   - HARMONY: Jaccard of pitch-class sets (source chord roots vs the
 *     project chord track's used pitch classes),
 *   - BASS: Jaccard of pitch-class sets (source bass notes vs the project
 *     bass track), scaled by an onset-density ratio.
 *
 * WHAT IT IS NOT (beat_modifier's own disclaimer, kept verbatim in spirit):
 * **NOT a legal or copyright clearance.** A high number says the
 * compositions overlap symbolically; it says nothing about ownership,
 * licensing or infringement. The UI renders that disclaimer next to every
 * verdict.
 *
 * Etiquette: components only exist when BOTH sides have content — an empty
 * project drags its component to 0 (honest), but a component absent on
 * either side (e.g. no bass lane in the project) is excluded from the
 * overall score rather than counted as zero.
 */

import type { ProjectDocument } from "../project-model/types";
import { inferPadRole } from "../ai/pad-roles";
import { chordToneSemitones } from "../ai/harmony";
import type { UnsunoTranscription } from "../reference/transcribe";

export interface SourceCompositionFingerprint {
  bpm: number;
  /** Folded lit pattern slots per band (0..15). */
  drumSlots: { kick: number[]; snare: number[]; hat: number[] };
  /** UNION of each chord span's full pitch-class content (root + quality
   * tones) — the project side carries voicings, so comparing roots alone
   * would artificially depress the harmony score. */
  chordPcs: number[];
  /** Bass note pitch classes in onset order. */
  bassPcs: number[];
}

export interface ProjectCompositionFingerprint {
  drumSlots: { kick: number[]; snare: number[]; hat: number[] };
  chordPcs: number[];
  bassPcs: number[];
}

export interface SimilarityVerdict {
  drums: number | null;
  harmony: number | null;
  bass: number | null;
  overall: number;
  verdict: string;
  disclaimer: string;
}

const DISCLAIMER = "Numerický kompozičný overlap — NIE je právna/copyright clearance ani odhad hodnoty.";

function jaccard(a: ReadonlySet<number>, b: ReadonlySet<number>): number | null {
  if (a.size === 0 && b.size === 0) return null; // absent on both sides
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : null;
}

/** Fingerprint from a finished transcription (what BUILD PROJECT derived). */
export function sourceFingerprintFromTranscription(transcription: UnsunoTranscription): SourceCompositionFingerprint {
  return {
    bpm: transcription.tempo?.bpm ?? 0,
    drumSlots: {
      kick: [...transcription.drums.kick],
      snare: [...transcription.drums.snare],
      hat: [...transcription.drums.hat],
    },
    chordPcs: [
      ...new Set(
        transcription.chords.spans.flatMap((span) =>
          chordToneSemitones(span.quality).map((interval) => (span.rootPc + interval) % 12),
        ),
      ),
    ].sort((a, b) => a - b),
    bassPcs: transcription.bass.notes.map((note) => ((note.midi % 12) + 12) % 12),
  };
}

/** Fingerprint from the CURRENT project: drum rows folded per band across
 * all patterns (roles resolved by name, never by index), chord-track pitch
 * classes, bass-track pitch classes. */
export function projectFingerprint(doc: ProjectDocument): ProjectCompositionFingerprint {
  const drumSlots = { kick: new Set<number>(), snare: new Set<number>(), hat: new Set<number>() };
  const roleBand: Partial<Record<string, "kick" | "snare" | "hat">> = {
    kick: "kick",
    snare: "snare",
    clap: "snare",
    closedHat: "hat",
    openHat: "hat",
  };
  for (const pattern of doc.patterns) {
    for (const [padId, row] of Object.entries(pattern.rows ?? {})) {
      const owner = doc.tracks.find((t) => t.kind === "drum" && t.pads.some((pad) => pad.id === padId));
      if (!owner || owner.kind !== "drum") continue;
      const padIndex = owner.pads.findIndex((pad) => pad.id === padId);
      const role = inferPadRole(owner.pads[padIndex]?.name, padIndex);
      const band = roleBand[role];
      if (!band) continue;
      row.forEach((velocity, slot) => {
        if (velocity > 0) drumSlots[band].add(slot % 16);
      });
    }
  }

  // Pitch classes WITH duplicates (one entry per note onset) — the bass
  // density factor compares onset counts, so the project side must count
  // the same way the source side does.
  const chordPcs: number[] = [];
  const bassPcs: number[] = [];
  for (const pattern of doc.patterns) {
    for (const [trackId, notes] of Object.entries(pattern.notes ?? {})) {
      const owner = doc.tracks.find((t) => t.id === trackId);
      if (!owner || owner.kind !== "instrument") continue;
      const target = owner.instrument === "bass" ? bassPcs : owner.instrument === "keys" ? chordPcs : null;
      if (!target) continue;
      for (const note of notes) target.push(((Math.round(note.pitch) % 12) + 12) % 12);
    }
  }

  return {
    drumSlots: {
      kick: [...drumSlots.kick].sort((a, b) => a - b),
      snare: [...drumSlots.snare].sort((a, b) => a - b),
      hat: [...drumSlots.hat].sort((a, b) => a - b),
    },
    chordPcs: [...chordPcs].sort((a, b) => a - b),
    bassPcs: [...bassPcs].sort((a, b) => a - b),
  };
}

/** Verdict band for an overall score. */
function verdictFor(overall: number): string {
  if (overall >= 0.85) return "kompozícia takmer identická so zdrojom";
  if (overall >= 0.6) return "jasne odvodené zo zdroja";
  if (overall >= 0.35) return "voľne postavené na zdroji";
  return "podstatne prepracované — so zdrojom už veľa nesúvisí";
}

export function similarityAdvisory(
  source: SourceCompositionFingerprint,
  project: ProjectCompositionFingerprint,
): SimilarityVerdict {
  const sourceSlots = {
    kick: new Set(source.drumSlots.kick),
    snare: new Set(source.drumSlots.snare),
    hat: new Set(source.drumSlots.hat),
  };
  const projectSlots = {
    kick: new Set(project.drumSlots.kick),
    snare: new Set(project.drumSlots.snare),
    hat: new Set(project.drumSlots.hat),
  };

  const drumScores: number[] = [];
  for (const band of ["kick", "snare", "hat"] as const) {
    const score = jaccard(sourceSlots[band], projectSlots[band]);
    if (score !== null) drumScores.push(score);
  }
  // The drums component exists only when at least one band has content on
  // both sides (a melody-only project has no drum opinion).
  const drums = drumScores.length > 0 ? drumScores.reduce((sum, v) => sum + v, 0) / drumScores.length : null;

  const harmony = jaccard(new Set(source.chordPcs), new Set(project.chordPcs));
  const bassJaccard = jaccard(new Set(source.bassPcs), new Set(project.bassPcs));
  // Bass also weighs onset density: one bass note vs a walking line is not
  // the same composition even at identical pitch classes.
  const bass =
    bassJaccard === null
      ? null
      : Math.min(1, bassJaccard * Math.min(1, (project.bassPcs.length || 1) / Math.max(1, source.bassPcs.length)));

  const components = [drums, harmony, bass].filter((value): value is number => value !== null);
  const overall = components.length > 0 ? components.reduce((sum, v) => sum + v, 0) / components.length : 0;

  return {
    drums,
    harmony,
    bass,
    overall,
    verdict: verdictFor(overall),
    disclaimer: DISCLAIMER,
  };
}
