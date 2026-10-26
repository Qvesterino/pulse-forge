/**
 * LOW-END STACK wave 2 — the bassline and the fit metric.
 *
 * Wave 1 (lowEnd.ts) tunes the instruments and wires the ducking; the bass
 * track itself stayed EMPTY — "the bass plays the tonic" only held once a
 * human wrote the notes. This module closes that half:
 *
 *  - `planBassline` is the PURE generator: the rhythm locks to the KOPA
 *    onsets of the active pattern (the 808 way — bass follows kick, the
 *    sidechain has something to duck), the pitch follows the chord sounding
 *    at each bar (doc.arrangement.chords), degrading to the key tonic and
 *    then to the chromatic C anchor. The played line is a proposal, not
 *    law — the user edits it in the piano roll like any other notes.
 *  - `measureLowEndFit` is the PURE fit metric (MUG-01/E2 spirit: measure
 *    the low end as a SYSTEM, not two tracks): rhythm lock, harmonic lock,
 *    register distance between the kick's tuned fundamental and the bass's,
 *    and whether the ducking is wired — rolled into one honest verdict.
 *
 * Both run on the project model, not on audio: deterministic, vitest-first,
 * no render needed to say "these two fight for the same register".
 */

import { ticksPerBar } from "../project-model/schema";
import { parseKey } from "../project-model/scales";
import {
  STEP_TICKS,
  type ID,
  type InstrumentTrack,
  type NoteEvent,
  type ProjectDocument,
} from "../project-model/types";
import { uid } from "../shared/ids";
import type { LowEndPlan } from "./lowEnd";

export type BasslineStyle = "root" | "fifth" | "octave";

export interface BasslinePlan {
  events: NoteEvent[];
  /** What the pitch followed: the chord track, the key tonic, or chromatic C. */
  basis: "chords" | "key" | "chromatic";
  /** The kick onset ticks the line locked to (the downbeat skeleton when the kick is silent). */
  kickOnsets: number[];
  /** Share of kick onsets carrying a bass note (1 for the skeleton). */
  coverage: number;
}

/** The 808 register: C2 — the same floor KOPA's fixed body sits on. */
const BASS_ROOT_MIDI = 36;

const isInstrument = (track: ProjectDocument["tracks"][number]): track is InstrumentTrack =>
  track.kind === "instrument";

interface ChordSpan {
  root: number;
  fromBar: number;
  toBar: number;
}

/** The chord track as flat [fromBar, toBar) spans, sorted, for bar lookups. */
function chordSpans(doc: ProjectDocument): ChordSpan[] {
  const chords = doc.arrangement?.chords ?? [];
  return chords
    .map((chord) => ({
      root: ((chord.root % 12) + 12) % 12,
      fromBar: chord.startBar,
      toBar: chord.startBar + chord.lengthBars,
    }))
    .filter((span) => span.toBar > span.fromBar)
    .sort((a, b) => a.fromBar - b.fromBar);
}

/**
 * The root pitch class sounding at an absolute bar: the chord track first,
 * then the key tonic, then the chromatic C anchor. `wrap` folds the bar
 * back into the progression's span so a 2-bar pattern loops a 1-bar
 * progression instead of falling off its end.
 */
export function bassRootAtBar(doc: ProjectDocument, bar: number): { rootPc: number; basis: BasslinePlan["basis"] } {
  const spans = chordSpans(doc);
  if (spans.length > 0) {
    const first = spans[0]!.fromBar;
    const last = spans.reduce((max, span) => Math.max(max, span.toBar), first);
    let probe = bar;
    const span = last - first;
    if (span > 0) probe = first + ((((bar - first) % span) + span) % span);
    const hit = spans.find((s) => probe >= s.fromBar && probe < s.toBar) ?? spans[0]!;
    return { rootPc: hit.root, basis: "chords" };
  }
  const tonic = doc.key ? parseKey(doc.key)?.root : undefined;
  if (tonic !== undefined) return { rootPc: tonic, basis: "key" };
  return { rootPc: 0, basis: "chromatic" };
}

/**
 * The kick onset ticks of the active pattern: the KOPA track's note starts.
 * A silent kick yields the downbeat skeleton — one onset per bar — so the
 * seeded line still has a pulse to lock to (and the summary says so).
 */
export function kickOnsetsOf(doc: ProjectDocument, kickTrackId: ID | null): { onsets: number[]; skeleton: boolean } {
  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId);
  const patternTicks = pattern ? pattern.stepCount * STEP_TICKS : 0;
  const notes = (pattern?.notes?.[kickTrackId ?? ""] ?? []).slice().sort((a, b) => a.start - b.start);
  const onsets = notes.map((note) => note.start).filter((start) => start >= 0 && start < patternTicks);
  const unique = Array.from(new Set(onsets));
  if (unique.length > 0) return { onsets: unique, skeleton: false };
  const perBar = ticksPerBar(doc);
  const skeleton: number[] = [];
  for (let bar = 0; bar * perBar < patternTicks; bar++) skeleton.push(bar * perBar);
  return { onsets: skeleton, skeleton: true };
}

export function planBassline(
  doc: ProjectDocument,
  plan: LowEndPlan,
  options: { style?: BasslineStyle; gate?: number } = {},
): BasslinePlan {
  const { onsets } = kickOnsetsOf(doc, plan.kickTrackId);
  const style = options.style ?? "root";
  const gate = Number.isFinite(options.gate) ? Math.min(1, Math.max(0.1, options.gate!)) : 0.9;
  const perBar = ticksPerBar(doc);
  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId);
  const patternTicks = pattern ? pattern.stepCount * STEP_TICKS : 0;

  const events: NoteEvent[] = onsets.map((start, index) => {
    const bar = Math.floor(start / perBar);
    const { rootPc } = bassRootAtBar(doc, bar);
    const odd = index % 2 === 1;
    // The fifth folds back into the octave (it is a pitch class); the
    // octave style must NOT fold — an octave-up 808 is genuinely +12.
    const shift = style === "fifth" && odd ? 7 : 0;
    const octaveUp = style === "octave" && odd ? 12 : 0;
    const next = onsets[index + 1];
    const until = next !== undefined ? next : Math.max(patternTicks, start + perBar);
    const duration = Math.max(STEP_TICKS, Math.round((until - start) * gate));
    return {
      id: uid("note"),
      pitch: BASS_ROOT_MIDI + ((rootPc + shift) % 12) + octaveUp,
      start,
      duration,
      velocity: start % perBar === 0 ? 0.9 : 0.75,
    };
  });

  return {
    events,
    basis: onsets.length === 0 ? "chromatic" : bassRootAtBar(doc, 0).basis,
    kickOnsets: onsets,
    coverage: events.length > 0 ? 1 : 0,
  };
}

/* ---------------- the fit metric ---------------- */

export type LowEndFitVerdict = "silent" | "sparse" | "fighting" | "locked";

export interface LowEndFit {
  verdict: LowEndFitVerdict;
  summary: string;
  bassNotes: number;
  kickOnsets: number;
  /** Share of kick onsets with a bass note attacking on the same tick. */
  coverage: number;
  /** Share of bass notes whose pitch class is the chord/key root at their bar. */
  harmonicLock: number;
  /** |bass fundamental − kick fundamental| folded into 0–6 st. */
  registerDistanceSt: number;
  ducked: boolean;
}

/** The kick's tuned fundamental: its note pitch (or the fixed C2) + bodyTune. */
export function kickFundamentalMidi(doc: ProjectDocument, plan: LowEndPlan): number {
  const kick = doc.tracks.find((t): t is InstrumentTrack => isInstrument(t) && t.id === plan.kickTrackId);
  if (!kick) return 36;
  const tune = Number.isFinite(kick.params.bodyTune) ? kick.params.bodyTune : 0;
  const keyTrack = kick.params.keyTrack ?? 1;
  const { onsets, skeleton } = kickOnsetsOf(doc, plan.kickTrackId);
  let notePitch = 36;
  if (!skeleton) {
    const pattern = doc.patterns.find((p) => p.id === doc.activePatternId);
    const notes = pattern?.notes?.[kick.id] ?? [];
    const first = notes.find((note) => note.start === onsets[0]);
    if (first && Number.isFinite(first.pitch)) notePitch = first.pitch;
  }
  // keyTrack OFF pins the body to the fixed C2 reference regardless of note pitch.
  const base = keyTrack ? notePitch : 36;
  return base + tune;
}

function registerDistance(a: number, b: number): number {
  const raw = Math.abs(a - b) % 12;
  return Math.min(raw, 12 - raw);
}

export function measureLowEndFit(doc: ProjectDocument, plan: LowEndPlan): LowEndFit {
  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId);
  const bassNotes = (pattern?.notes?.[plan.bassTrackId ?? ""] ?? []).slice().sort((a, b) => a.start - b.start);
  const { onsets } = kickOnsetsOf(doc, plan.kickTrackId);
  const perBar = ticksPerBar(doc);
  const ducked = plan.sidechainWired;

  const starts = new Set(bassNotes.map((note) => note.start));
  const covered = onsets.filter((start) => starts.has(start)).length;
  const coverage = onsets.length > 0 ? covered / onsets.length : 0;

  const bassRootMidi = bassNotes.length > 0 ? Math.min(...bassNotes.map((note) => note.pitch)) : null;
  const registerDistanceSt =
    bassRootMidi === null ? 12 : registerDistance(bassRootMidi, kickFundamentalMidi(doc, plan));

  let harmonicLock = 0;
  if (bassNotes.length > 0) {
    const hits = bassNotes.filter((note) => {
      const { rootPc, basis } = bassRootAtBar(doc, Math.floor(note.start / perBar));
      if (basis === "chromatic") return true; // nothing to lock to — count as free
      return (((note.pitch - rootPc) % 12) + 12) % 12 === 0;
    });
    harmonicLock = hits.length / bassNotes.length;
  }

  let verdict: LowEndFitVerdict;
  if (bassNotes.length === 0) verdict = "silent";
  else if (coverage < 0.5) verdict = "sparse";
  else if (!ducked && registerDistanceSt <= 5) verdict = "fighting";
  else verdict = "locked";

  const pct = (value: number) => `${Math.round(value * 100)}%`;
  let summary: string;
  switch (verdict) {
    case "silent":
      summary = "The bass is silent in this pattern — seed a line or write notes first.";
      break;
    case "sparse":
      summary = `Sparse: only ${pct(coverage)} of kick onsets carry a bass note — the pump has gaps.`;
      break;
    case "fighting":
      summary = `Fighting: kick and bass sit ${registerDistanceSt} st apart in the same register with no ducking wired — build the stack to add the sidechain.`;
      break;
    case "locked":
      summary = `Locked: ${pct(coverage)} rhythm lock, ${pct(harmonicLock)} harmonic lock, ${registerDistanceSt} st register gap${ducked ? ", sidechain ducking wired" : ""}.`;
      break;
  }

  return {
    verdict,
    summary,
    bassNotes: bassNotes.length,
    kickOnsets: onsets.length,
    coverage,
    harmonicLock,
    registerDistanceSt,
    ducked,
  };
}
