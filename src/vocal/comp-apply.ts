import { snapshot } from "../commands/commands";
import { createInstrumentTrackModel } from "../project-model/schema";
import { uid } from "../shared/ids";
import { STEP_TICKS, type InstrumentTrack, type NoteEvent, type ProjectDocument } from "../project-model/types";
import type { CompPlan } from "./comping";
import type { VocalProfile } from "./types";

/**
 * VOCAL COMP APPLY (vocal lane) — the plan becomes tracks.
 *
 * `planVocalComp` decides who wins each bar; this command INSTALLS the
 * decision: one vocalchop track per contributing take ("Comp — voice A"…),
 * each carrying notes ONLY in the bars where that take wins. The vocalchop
 * runtime resolves `sampleId` from the bank at play time (same degradation
 * contract as the hook), so the comp plays as one continuous vocal assembled
 * from the best moments — without this code ever touching PCM.
 *
 * ONE undo step for all tracks + notes. Re-apply replaces the previous
 * comp's tracks (matched by the "Comp — voice" name prefix) instead of
 * stacking duplicates.
 */

export interface CompTakeSource {
  /** The staged take's bank id (resolveVocalTake → take.bufferId). */
  bufferId: string;
  /** The analyzed profile — must be the same object list the plan was built from. */
  profile: VocalProfile;
}

const COMP_TRACK_PREFIX = "Comp — voice ";

/** Comp voicing: the same vocalchop family as the hook, slightly darker. */
const COMP_PARAMS: Record<string, number> = {
  root: 60,
  vowel: 1,
  color: 0.8,
  shift: 1.2,
  sharp: 0.65,
  cons: 0.28,
  morph: 0.3,
  tone: 8500,
  reverse: 0,
  attack: 0.005,
  release: 0.14,
  gain: 0.82,
};

/** Letters for the comp voice names: A, B, … Z, then A2, B2 … */
function voiceLetter(index: number): string {
  const base = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const letter = base[index % 26]!;
  const round = Math.floor(index / 26);
  return round === 0 ? letter : letter + String(round + 1);
}

export interface VocalCompApplyOptions {
  /** Target pattern; defaults to the active pattern. */
  patternId?: string | null;
}

/**
 * Install the comp: one vocalchop track per contributing take, notes only in
 * the winning bar spans, proportional to the plan's bar grid (same mapping
 * contract as the hook). ONE undo step. Throws honestly when the plan has no
 * sung bars or a contributing take's buffer is not staged.
 */
export function applyVocalCompCommand(
  doc: ProjectDocument,
  takes: readonly CompTakeSource[],
  plan: CompPlan,
  options: VocalCompApplyOptions = {},
): ReturnType<typeof snapshot> {
  if (plan.segments.length === 0) throw new Error("The comp plan has no sung bars — nothing to assemble");
  for (const { index } of plan.perTakeBars.map((count, index) => ({ count, index })).filter((e) => e.count > 0)) {
    const source = takes[index];
    if (!source || typeof source.bufferId !== "string" || source.bufferId === "") {
      throw new Error(`Take ${voiceLetter(index)} is not staged — analyze it before building the comp`);
    }
  }
  const patternId = options.patternId ?? doc.activePatternId;
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error("No active pattern to plant the comp into");
  const patternSteps = Math.max(1, Math.round(pattern.stepCount));

  // Contributing takes, sorted by contribution (winner first → track A)
  const contributors = plan.perTakeBars
    .map((count, index) => ({ count, index }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.index - b.index);

  let tracks = doc.tracks;
  const notesByTrack = new Map<string, NoteEvent[]>();

  contributors.forEach((contributor, letterIndex) => {
    const source = takes[contributor.index]!;
    const name = COMP_TRACK_PREFIX + voiceLetter(letterIndex);
    // Reuse a previous comp track with the same buffer on re-apply
    const existing = tracks.find(
      (t): t is InstrumentTrack =>
        t.kind === "instrument" && t.instrument === "vocalchop" && t.name === name && t.sampleId === source.bufferId,
    );
    let trackId: string;
    if (existing) {
      trackId = existing.id;
    } else {
      // Replace any stale comp track with the same name (previous comp)
      const stale = tracks.find((t) => t.name === name);
      const track: InstrumentTrack = {
        ...(stale ?? createInstrumentTrackModel("vocalchop", tracks.length)),
        id: stale?.id ?? uid("track"),
        kind: "instrument",
        instrument: "vocalchop",
        name,
        sampleId: source.bufferId,
        params: { ...COMP_PARAMS },
      };
      tracks = stale ? tracks.map((t) => (t.id === stale.id ? track : t)) : [...tracks, track];
      trackId = track.id;
    }
    const notes = notesByTrack.get(trackId) ?? [];

    for (const segment of plan.segments) {
      if (segment.takeIndex !== contributor.index) continue;
      const from = Math.min(1, Math.max(0, segment.startBar / plan.bars));
      const to = Math.min(1, Math.max(from + 1 / plan.bars, (segment.endBar + 1) / plan.bars));
      const start = Math.min(patternSteps - 1, Math.floor(from * patternSteps)) * STEP_TICKS;
      const endSteps = Math.max(1, Math.floor(to * patternSteps) - Math.floor(from * patternSteps));
      const duration = Math.max(STEP_TICKS, Math.min(patternSteps * STEP_TICKS - start, endSteps * STEP_TICKS));
      notes.push({
        id: uid("note"),
        pitch: 62,
        start,
        duration,
        velocity: Math.round((0.6 + 0.4 * Math.max(0, Math.min(1, segment.score / 1.3))) * 100) / 100,
      });
    }
    notesByTrack.set(trackId, notes);
  });

  const next: ProjectDocument = {
    ...doc,
    tracks,
    patterns: doc.patterns.map((p) => {
      if (p.id !== pattern.id) return p;
      const notes = { ...p.notes };
      for (const [trackId, list] of notesByTrack) notes[trackId] = list;
      return { ...p, notes };
    }),
  };
  const parts = contributors.map((c) => `${voiceLetter(c.index)}:${plan.perTakeBars[c.index]}`).join(" + ");
  return snapshot("applyVocalComp", `Vocal comp: ${plan.sungBars}/${plan.bars} bars (${parts})`, doc, next);
}
