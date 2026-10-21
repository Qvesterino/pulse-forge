/**
 * Pattern assist — deterministic "iteration on your idea" operations over
 * EXISTING pattern data. Unlike the prompt generator (which re-generates
 * from groove templates), these ops treat the user's pattern as canonical
 * and modify it surgically:
 *
 *   VARY        — nudge velocities / ghosts / microtiming (same seed = same result)
 *   BUILD       — expand to N bars with a progressive element + energy ramp
 *   REPLACE     — swap one pad family's row for a style groove (hats→house…)
 *   FILL        — crescendo snare fill over the last bar
 *
 * Pure functions over pattern data — no audio engine or provider imports,
 * unit-testable and safe to reuse from preview/apply workflows.
 *
 * ## The metre (ADR 0057 Stage 2g)
 *
 * Every op below used to believe that one bar is SIXTEEN sixteenth steps: the
 * build expanded to `bars * 16`, the fill's zone was the last sixteen steps,
 * the style grooves were tiled every sixteen steps, and "the beat" was
 * `step % 4`. Those are 4/4 CONTENT wearing the clothes of arithmetic — in a
 * 6/8 document the build produced 1.33 bars, the fill's zone started a third
 * of a bar past the bar line, and the "four-on-floor" kick landed on the
 * eighths instead of the dotted quarter.
 *
 * The ops now speak the document's METER. The metrical facts are NOT
 * re-derived here: `src/ai/meter.ts` owns the pulse, the backbeat and the
 * bar length, and `src/ai/groove-view.ts` owns how 4/4 material says itself
 * in another metre. This file only asks those two questions.
 *
 * **4/4 is the identity.** Every op takes the meter as its LAST argument and
 * defaults to `DEFAULT_AI_METER` (4/4), so a caller that knows no meter keeps
 * the legacy behaviour byte-for-byte — the same promise ADR 0057 Stage 2b/2c
 * made for the generator.
 */
import { mulberry32, hashString } from "../shared/rng";
import {
  STEP_TICKS,
  type DrumPad,
  type NoteEvent,
  type Pattern,
  type PatternPhraseBar,
  type StepMeta,
} from "../project-model/types";
import { buildPhrasePlan } from "../ai/phrase";
import { DEFAULT_AI_METER, isBackbeatAnchor, isPulse, type AiMeter } from "../ai/meter";
import { projectRowToMeter } from "../ai/groove-view";
import type { PadRole } from "../ai/pad-roles";
import type { AssistTarget } from "./types";
import { humanizeNotes } from "../midi/creative";

/** Pad families by name — factory kit and sensible user kits classify cleanly. */
export interface PadFamilies {
  kicks: DrumPad[];
  snares: DrumPad[];
  hats: DrumPad[];
  others: DrumPad[];
}

export function classifyPads(pads: DrumPad[]): PadFamilies {
  const fams: PadFamilies = { kicks: [], snares: [], hats: [], others: [] };
  for (const pad of pads) {
    const n = pad.name.toLowerCase();
    if (/(kick|808|sub|bass drum)/.test(n)) fams.kicks.push(pad);
    else if (/(snare|clap|rim)/.test(n)) fams.snares.push(pad);
    else if (/(hat|cymbal|ride|crash|open)/.test(n)) fams.hats.push(pad);
    else fams.others.push(pad);
  }
  // Within a family, lead with the most representative pad (the op engines
  // use family[0]): a proper snare before a rim, a closed hat before a ride.
  const priority = (list: DrumPad[], ranks: string[]) =>
    [...list].sort((a, b) => {
      const rank = (p: DrumPad) => {
        const n = p.name.toLowerCase();
        const i = ranks.findIndex((r) => n.includes(r));
        return i === -1 ? ranks.length : i;
      };
      return rank(a) - rank(b);
    });
  fams.snares = priority(fams.snares, ["snare", "clap", "rim"]);
  fams.hats = priority(fams.hats, ["hat", "cymbal", "crash", "ride"]);
  fams.kicks = priority(fams.kicks, ["kick", "808", "sub"]);
  return fams;
}

function randFromSeed(seed: string): () => number {
  return mulberry32(hashString(seed));
}

const clampV = (v: number) => Math.max(0.08, Math.min(1, v));

/**
 * True when a step carries a METRICAL ANCHOR — the positions the metre's
 * skeleton puts a hit on: the pulse (the kick's ride) and the backbeat (the
 * snare's place).
 *
 * In 4/4 this is exactly the legacy `step % 4 === 0`: the pulse is the quarter
 * note (0, 4, 8, 12) and the backbeat (4, 12) already sits inside it. In 6/8
 * the pulse is the dotted quarter (0, 6) and the backbeat the shuffle's
 * "2 & 5" (2, 8), so the union protects four positions per bar — and, crucially,
 * keeps the backbeat safe from a thinning pass that would otherwise delete
 * it (the legacy protected every fourth step, which in 6/8 is NOT the
 * backbeat).
 */
function isMetricalAnchor(meter: AiMeter, step: number): boolean {
  return isPulse(meter, step) || isBackbeatAnchor(meter, step);
}

export type RowsPatch = {
  rows: Record<string, number[]>;
  notes?: Record<string, NoteEvent[]>;
  stepMeta?: Record<string, Record<number, StepMeta>>;
  clearStepMeta?: { from: number; to: number; padIds?: string[] };
  phrasePlan?: PatternPhraseBar[];
  stepCount?: number;
  /**
   * How the source's material met the document's metre — present when the
   * operation copies the source BAR BY BAR, so the user can be told what the
   * copy did (and what it left out).
   */
  sourceAlignment?: SourceAlignment;
};

/**
 * How a bar-by-bar copy meets the document's metre.
 *
 * The build copies the source one BAR at a time, and a bar is the document's
 * bar. A source that is a whole number of the metrical bars — the normal
 * case, and the case every producer in this product now produces — is copied
 * exactly. A source that is NOT (sixteen steps in a 6/8 project is 1.33 bars)
 * is cut at the bar line, and the cut is COUNTED: the legacy had the same
 * policy (a twenty-step source in 4/4 lost four steps the same way), with the
 * bar length corrected. A cut that is not counted is a cut the user cannot
 * see.
 */
export interface SourceAlignment {
  /** The source's own bar count, in the document's metre. */
  bars: number;
  /** The source's steps that fall outside those bars — the material not copied. */
  cutSteps: number;
}

/**
 * The source's alignment with the document's metre.
 *
 * The source's bar count is ROUNDED, exactly as the legacy rounded it against
 * sixteen steps: a source that is a little over a bar keeps its last partial
 * bar's material (the copy fills the rest with silence), and a source that is
 * a little under a bar is one bar with silence in it.
 */
export function assistSourceAlignment(pattern: Pattern, meter: AiMeter = DEFAULT_AI_METER): SourceAlignment {
  const stepsPerBar = meter.stepsPerBar;
  const bars = Math.max(1, Math.round(pattern.stepCount / stepsPerBar));
  return { bars, cutSteps: Math.max(0, pattern.stepCount - bars * stepsPerBar) };
}

export interface StepSelectionScope {
  padIds: readonly string[];
  from: number;
  to: number;
}

export interface NoteSelectionScope {
  trackId: string;
  noteIds: readonly string[];
}

/**
 * Apply only the row/step-metadata cells inside a sequencer selection.
 * Everything outside the selected pads and inclusive step range is copied
 * from the source pattern byte-for-byte; notes and pattern length are never
 * part of this operation.
 */
export function applyAssistPatchToStepSelection(
  pattern: Pattern,
  patch: Pick<RowsPatch, "rows" | "stepMeta">,
  selection: StepSelectionScope,
): Pattern {
  if (!Number.isFinite(selection.from) || !Number.isFinite(selection.to) || pattern.stepCount <= 0) return pattern;
  const from = Math.min(selection.from, selection.to);
  const to = Math.max(selection.from, selection.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to >= pattern.stepCount) return pattern;
  const padIds = [...new Set(selection.padIds)].filter(
    (padId) => pattern.rows[padId] !== undefined && patch.rows[padId] !== undefined,
  );
  if (padIds.length === 0) return pattern;

  const rows = { ...pattern.rows };
  const stepMeta: Record<string, Record<number, StepMeta>> = Object.fromEntries(
    Object.entries(pattern.stepMeta ?? {}).map(([padId, entries]) => [padId, { ...entries }]),
  );

  for (const padId of padIds) {
    const nextRow = [...pattern.rows[padId]!];
    const proposedRow = patch.rows[padId]!;
    for (let step = from; step <= to; step++) {
      if (step < nextRow.length && step < proposedRow.length) nextRow[step] = proposedRow[step]!;
    }
    rows[padId] = nextRow;

    const nextPadMeta = { ...(stepMeta[padId] ?? {}) };
    for (const rawStep of Object.keys(nextPadMeta)) {
      const step = Number(rawStep);
      if (step >= from && step <= to) delete nextPadMeta[step];
    }
    for (const [rawStep, meta] of Object.entries(patch.stepMeta?.[padId] ?? {})) {
      const step = Number(rawStep);
      if (Number.isInteger(step) && step >= from && step <= to) nextPadMeta[step] = { ...meta };
    }
    if (Object.keys(nextPadMeta).length > 0) stepMeta[padId] = nextPadMeta;
    else delete stepMeta[padId];
  }

  return {
    ...pattern,
    rows,
    stepMeta: Object.keys(stepMeta).length > 0 ? stepMeta : undefined,
  };
}

/**
 * Thin only selected drum cells by removing the softest selected off-beat
 * hits. The metrical ANCHORS are preserved — in 4/4 that is the legacy "every
 * fourth step" (the quarter notes), in 6/8 the dotted quarter and the
 * shuffle's backbeat. Removed hits also lose their step locks/metadata; all
 * other cells remain untouched.
 */
export function thinStepSelection(
  pattern: Pattern,
  selection: StepSelectionScope,
  amount = 0.4,
  meter: AiMeter = DEFAULT_AI_METER,
): Pattern {
  if (!Number.isFinite(amount) || amount <= 0 || pattern.stepCount <= 0) return pattern;
  const from = Math.min(selection.from, selection.to);
  const to = Math.max(selection.from, selection.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to >= pattern.stepCount) return pattern;
  const strength = Math.min(1, amount);
  const padIds = [...new Set(selection.padIds)].filter((padId) => pattern.rows[padId] !== undefined);
  if (padIds.length === 0) return pattern;

  const rows = { ...pattern.rows };
  const stepMeta: Record<string, Record<number, StepMeta>> = Object.fromEntries(
    Object.entries(pattern.stepMeta ?? {}).map(([padId, entries]) => [padId, { ...entries }]),
  );
  let changed = false;
  for (const padId of padIds) {
    const row = pattern.rows[padId]!;
    const candidates = Array.from({ length: to - from + 1 }, (_, offset) => from + offset)
      .filter((step) => !isMetricalAnchor(meter, step) && step < row.length && row[step]! > 0)
      .sort((a, b) => row[a]! - row[b]! || b - a);
    const removeCount = candidates.length > 0 ? Math.max(1, Math.floor(candidates.length * strength)) : 0;
    if (removeCount === 0) continue;

    const nextRow = [...row];
    const nextMeta = { ...(stepMeta[padId] ?? {}) };
    for (const step of candidates.slice(0, removeCount)) {
      nextRow[step] = 0;
      delete nextMeta[step];
    }
    rows[padId] = nextRow;
    if (Object.keys(nextMeta).length > 0) stepMeta[padId] = nextMeta;
    else delete stepMeta[padId];
    changed = true;
  }

  return changed ? { ...pattern, rows, stepMeta: Object.keys(stepMeta).length > 0 ? stepMeta : undefined } : pattern;
}

/**
 * Humanize only selected melodic notes. Pitch, duration, id, locks, every
 * unselected note, and every other pattern field remain untouched. Invalid
 * or stale selections are rejected atomically instead of partially applied.
 */
export function humanizeNoteSelection(
  pattern: Pattern,
  selection: readonly NoteSelectionScope[],
  seed: string,
  amount = 0.6,
): Pattern {
  if (pattern.stepCount <= 0 || selection.length === 0 || !Number.isFinite(amount) || amount <= 0) return pattern;

  const idsByTrack = new Map<string, Set<string>>();
  for (const scope of selection) {
    if (!scope.trackId || scope.noteIds.length === 0 || scope.noteIds.some((id) => !id)) return pattern;
    const ids = idsByTrack.get(scope.trackId) ?? new Set<string>();
    for (const id of scope.noteIds) ids.add(id);
    idsByTrack.set(scope.trackId, ids);
  }

  const selectedNotes: Array<{ trackId: string; note: NoteEvent }> = [];
  for (const [trackId, ids] of idsByTrack) {
    const notes = pattern.notes[trackId];
    if (!notes) return pattern;
    const matches = notes.filter((note) => ids.has(note.id));
    // Fail closed when even one requested id is stale or ambiguous.
    if (matches.length !== ids.size) return pattern;
    selectedNotes.push(...matches.map((note) => ({ trackId, note })));
  }
  if (selectedNotes.length === 0) return pattern;

  const strength = Math.min(1, amount);
  const varied = humanizeNotes(
    selectedNotes.map(({ note }) => note),
    { seed, timingTicks: Math.round(10 * strength), velocityAmount: 0.12 * strength },
    pattern.stepCount * STEP_TICKS,
  );
  const updates = new Map<string, Map<string, NoteEvent>>();
  for (let index = 0; index < selectedNotes.length; index++) {
    const { trackId, note: original } = selectedNotes[index]!;
    const humanized = varied[index]!;
    const next = { ...original, start: humanized.start, velocity: humanized.velocity };
    const trackUpdates = updates.get(trackId) ?? new Map<string, NoteEvent>();
    trackUpdates.set(original.id, next);
    updates.set(trackId, trackUpdates);
  }

  const notes = { ...pattern.notes };
  for (const [trackId, trackUpdates] of updates) {
    notes[trackId] = pattern.notes[trackId]!.map((note) => trackUpdates.get(note.id) ?? note);
  }
  return { ...pattern, notes };
}

// ─── VARY ─────────────────────────────────────────────────────────────────

export function varyPattern(
  pattern: Pattern,
  pads: DrumPad[],
  seed: string,
  amount = 0.6,
  meter: AiMeter = DEFAULT_AI_METER,
): RowsPatch {
  const rand = randFromSeed(seed);
  const fams = classifyPads(pads);
  const snareIds = new Set(fams.snares.map((p) => p.id));
  const rows: Record<string, number[]> = {};
  const meta: Record<string, Record<number, StepMeta>> = {};
  for (const [padId, row] of Object.entries(pattern.rows)) {
    const next = [...row];
    const padMeta: Record<number, StepMeta> = {};
    for (let i = 0; i < next.length; i++) {
      // The metrical anchor, not "the fourth step": in 4/4 the two are the
      // same set, in 6/8 the anchor is the dotted quarter and the backbeat.
      const onBeat = isMetricalAnchor(meter, i);
      if (next[i] > 0) {
        // Velocity humanization — downbeats move less than ghosts.
        const wobble = (rand() - 0.5) * (onBeat ? 0.18 : 0.3) * amount;
        next[i] = clampV(next[i] + wobble);
        // Occasionally thin non-downbeat hits (never the backbone).
        if (!onBeat && snareIds.has(padId) && rand() < amount * 0.1) next[i] = 0;
      } else if (snareIds.has(padId) && i % 2 === 1 && rand() < amount * 0.07) {
        // Ghost note on an off-16th.
        next[i] = 0.15 + rand() * 0.15;
      }
      // Occasional microtiming feel.
      if (next[i] > 0 && rand() < amount * 0.15) {
        padMeta[i] = {
          ...(pattern.stepMeta?.[padId]?.[i] ?? {}),
          microtiming: Math.round((rand() - 0.5) * 0.2 * 100) / 100,
        };
      }
    }
    rows[padId] = next;
    if (Object.keys(padMeta).length > 0) meta[padId] = padMeta;
  }
  return { rows, stepMeta: meta };
}

// ─── BUILD (expand to N bars with a ramp) ─────────────────────────────────

const FAMILY_TIER: Array<keyof PadFamilies> = ["kicks", "snares", "hats", "others"];

export function expandWithBuild(
  pattern: Pattern,
  pads: DrumPad[],
  bars: number,
  seed: string,
  meter: AiMeter = DEFAULT_AI_METER,
): RowsPatch {
  const rand = randFromSeed(seed);
  const fams = classifyPads(pads);
  // The bar is the METRE's bar: sixteen steps in 4/4, twelve in 6/8, twenty
  // in 5/4. Everything below counts in metrical bars, so a build of four bars
  // is four bars of the document's metre — not 1.33 of them.
  const stepsPerBar = meter.stepsPerBar;
  const sourceAlignment = assistSourceAlignment(pattern, meter);
  const baseBars = sourceAlignment.bars;
  const stepCount = bars * stepsPerBar;
  // Element entry points across the build: kick always, each next family
  // joins at ~1/4, 1/2, 3/4 of the build (deterministic jitter per seed).
  const entryBar: Record<string, number> = {};
  FAMILY_TIER.forEach((family, tier) => {
    const base = tier === 0 ? 0 : Math.round((bars * tier) / 4);
    for (const pad of fams[family])
      entryBar[pad.id] = Math.min(bars - 1, base + (tier > 0 ? Math.floor(rand() * 2) : 0));
  });

  const rows: Record<string, number[]> = {};
  for (const [padId, baseRow] of Object.entries(pattern.rows)) {
    const row = new Array<number>(stepCount).fill(0);
    const entersAt = entryBar[padId] ?? 0;
    for (let bar = 0; bar < bars; bar++) {
      if (bar < entersAt) continue;
      const sourceBar = bar % baseBars;
      // Energy ramp: early bars breathe, the last bar is full power.
      const energy = 0.72 + 0.28 * (bar / Math.max(1, bars - 1));
      for (let s = 0; s < stepsPerBar; s++) {
        const v = baseRow[sourceBar * stepsPerBar + s] ?? 0;
        if (v > 0) row[bar * stepsPerBar + s] = clampV(v * energy);
      }
    }
    rows[padId] = row;
  }

  const stepMeta: Record<string, Record<number, StepMeta>> = {};
  for (const [padId, sourceMeta] of Object.entries(pattern.stepMeta ?? {})) {
    const expanded: Record<number, StepMeta> = {};
    for (let bar = 0; bar < bars; bar++) {
      for (const [stepKey, meta] of Object.entries(sourceMeta)) {
        const sourceStep = Number(stepKey);
        const step = bar * stepsPerBar + (sourceStep % stepsPerBar);
        if ((rows[padId]?.[step] ?? 0) > 0) expanded[step] = { ...meta };
      }
    }
    if (Object.keys(expanded).length > 0) stepMeta[padId] = expanded;
  }

  const notes: Record<string, NoteEvent[]> = {};
  const sourceBarTicks = stepsPerBar * STEP_TICKS;
  for (const [trackId, sourceNotes] of Object.entries(pattern.notes ?? {})) {
    const expanded: NoteEvent[] = [];
    for (let bar = 0; bar < bars; bar++) {
      const sourceBar = bar % baseBars;
      const sourceStart = sourceBar * sourceBarTicks;
      const energy = 0.72 + 0.28 * (bar / Math.max(1, bars - 1));
      for (const note of sourceNotes) {
        if (note.start < sourceStart || note.start >= sourceStart + sourceBarTicks) continue;
        expanded.push({
          ...note,
          id: `${note.id}:build:${seed}:${bar}`,
          start: bar * sourceBarTicks + (note.start - sourceStart),
          velocity: Math.max(0.1, Math.min(1, note.velocity * energy)),
        });
      }
    }
    notes[trackId] = expanded;
  }

  return { rows, notes, stepMeta, phrasePlan: buildPhrasePlan(stepCount, meter), stepCount, sourceAlignment };
}

// ─── REPLACE (pad family → style groove) ──────────────────────────────────

type StyleRow = Array<{ step: number; v: number }>;

const HAT_STYLES: Record<string, StyleRow> = {
  house: [2, 6, 10, 14].map((step) => ({ step, v: 0.7 })),
  straight: [0, 2, 4, 6, 8, 10, 12, 14].map((step) => ({ step, v: step % 8 === 0 ? 0.7 : 0.5 })),
  trap: Array.from({ length: 16 }, (_, step) => ({ step, v: step % 4 === 0 ? 0.65 : 0.4 })),
  breaks: [0, 3, 4, 6, 8, 10, 11, 14].map((step) => ({ step, v: step % 8 === 0 ? 0.7 : 0.5 })),
  sparse: [2, 10].map((step) => ({ step, v: 0.55 })),
};

const KICK_STYLES: Record<string, StyleRow> = {
  "four-on-floor": [0, 4, 8, 12].map((step) => ({ step, v: 0.9 })),
  trap: [
    { step: 0, v: 0.95 },
    { step: 10, v: 0.9 },
  ],
  breaks: [
    { step: 0, v: 0.9 },
    { step: 10, v: 0.85 },
  ],
  halftime: [0, 8].map((step) => ({ step, v: 0.9 })),
};

const SNARE_STYLES: Record<string, StyleRow> = {
  backbeat: [4, 12].map((step) => ({ step, v: 0.85 })),
  double: [
    { step: 4, v: 0.8 },
    { step: 7, v: 0.7 },
    { step: 12, v: 0.85 },
  ],
  halftime: [{ step: 12, v: 0.9 }],
  march: [4, 12].map((step) => ({ step, v: 0.8 })),
};

const STYLE_TABLES = { hats: HAT_STYLES, kicks: KICK_STYLES, snares: SNARE_STYLES } as const;

/** The bar the style tables are written in — they are 4/4 material. */
const STYLE_STEPS = 16;

/**
 * The semantic role each style family speaks for. The metrical view re-voices
 * the kick on the pulse and the snare on the backbeat; the hats keep their
 * folded positions (a hat is not the metre's skeleton).
 */
const STYLE_ROLE: Record<ReplaceTarget, PadRole> = {
  kicks: "kick",
  snares: "snare",
  hats: "closedHat",
};

export type ReplaceTarget = AssistTarget;

export function styleNames(target: ReplaceTarget): string[] {
  return Object.keys(STYLE_TABLES[target]);
}

/**
 * The style groove as the DOCUMENT's metre says it.
 *
 * The tables above are sixteen-step 4/4 material: the "four-on-floor" kick is
 * four quarter notes, the "backbeat" snare is on beats 2 and 4. In 6/8 that
 * material is re-voiced by the metrical view — the kick rides the dotted
 * quarter (0, 6) and the snare the shuffle's "2 & 5" (2, 8) — so the style
 * keeps its MEANING in the new metre instead of being cut at the bar line.
 *
 * In 4/4 the projection is the identity, so the hits come back exactly as the
 * table wrote them.
 */
function projectStyleToMeter(groove: StyleRow, role: PadRole, meter: AiMeter): StyleRow {
  const dense = new Array<number>(STYLE_STEPS).fill(0);
  for (const hit of groove) dense[hit.step] = hit.v;
  const projected = projectRowToMeter(dense, role, meter);
  const hits: StyleRow = [];
  for (let step = 0; step < projected.length; step++) {
    const value = projected[step] ?? 0;
    if (value > 0) hits.push({ step, v: value });
  }
  return hits;
}

/**
 * Replace ONLY the given pad family's rows with a style groove, tiled across
 * the whole pattern; every other pad keeps the user's data untouched.
 */
export function replaceRows(
  pattern: Pattern,
  pads: DrumPad[],
  target: ReplaceTarget,
  style: string,
  seed: string,
  meter: AiMeter = DEFAULT_AI_METER,
): RowsPatch {
  const rand = randFromSeed(seed);
  const fams = classifyPads(pads);
  const table = STYLE_TABLES[target];
  const groove = table[style] ?? Object.values(table)[0];
  const family = fams[target === "kicks" ? "kicks" : target === "snares" ? "snares" : "hats"];
  const stepsPerBar = meter.stepsPerBar;
  const hits = projectStyleToMeter(groove, STYLE_ROLE[target], meter);

  const rows: Record<string, number[]> = {};
  // Every pad NOT in the family is passed through untouched.
  for (const [padId, row] of Object.entries(pattern.rows)) {
    rows[padId] = family.some((p) => p.id === padId) ? row : [...row];
  }
  const baseBars = Math.max(1, Math.round(pattern.stepCount / stepsPerBar));
  for (const [familyIndex, pad] of family.entries()) {
    const row = new Array<number>(pattern.stepCount).fill(0);
    for (let bar = 0; bar < baseBars; bar++) {
      for (const hit of hits) {
        // Second pad of the family plays a lighter shadow of the groove.
        const shade = familyIndex === 0 ? 1 : 0.5;
        row[bar * stepsPerBar + hit.step] = clampV(hit.v * shade * (0.92 + rand() * 0.16));
      }
    }
    rows[pad.id] = row;
  }
  return { rows, clearStepMeta: { from: 0, to: pattern.stepCount, padIds: family.map((pad) => pad.id) } };
}

// ─── FILL (crescendo over the last bar) ───────────────────────────────────

/**
 * The fill's crescendo, measured BACKWARDS from the end of the fill zone.
 *
 * The legacy shape was a sixteen-step 4/4 bar with hits at offsets
 * 4, 8, 10, 12, 13, 14, 15 — i.e. at distances 11, 7, 5, 3, 2, 1, 0 from the
 * zone's last step. Measuring from the END is what lets the same crescendo
 * live in any bar: the offsets become `(barLength - 1) - distance`, so the
 * fill always ends with its loudest hit on the pattern's last step and the
 * sixteenth-note roll always sits in the bar's final quarter.
 *
 * In 4/4 this is the legacy shape by construction (15 - distance).
 */
const FILL_CRESCENDO: Array<{ fromEnd: number; v: number }> = [
  { fromEnd: 11, v: 0.25 },
  { fromEnd: 7, v: 0.4 },
  { fromEnd: 5, v: 0.5 },
  { fromEnd: 3, v: 0.65 },
  { fromEnd: 2, v: 0.7 },
  { fromEnd: 1, v: 0.85 },
  { fromEnd: 0, v: 1 },
];

export function makeFill(
  pattern: Pattern,
  pads: DrumPad[],
  seed: string,
  meter: AiMeter = DEFAULT_AI_METER,
): RowsPatch {
  const rand = randFromSeed(seed);
  const fams = classifyPads(pads);
  const stepsPerBar = meter.stepsPerBar;
  // The zone is the LAST METRICAL BAR — sixteen steps in 4/4, twelve in 6/8.
  const start = Math.max(0, pattern.stepCount - stepsPerBar);
  const rows: Record<string, number[]> = {};
  for (const [padId, row] of Object.entries(pattern.rows)) {
    rows[padId] = [...row];
    for (let i = start; i < pattern.stepCount; i++) rows[padId][i] = 0; // clear the fill zone
  }
  // Kick anchors the fill's downbeat.
  const kick = fams.kicks[0];
  if (kick) rows[kick.id][start] = 0.9;
  // Snare crescendo: sparse early, dense + loud at the end. Rising energy
  // via density steps and a velocity ramp with seeded jitter.
  const snare = fams.snares[0];
  if (snare) {
    // A bar too short to hold the whole crescendo keeps its tail (the hits
    // that still fit); nothing is stretched to make room.
    const hits = FILL_CRESCENDO.map((hit) => ({ step: stepsPerBar - 1 - hit.fromEnd, v: hit.v })).filter(
      (hit) => hit.step >= 0,
    );
    for (const hit of hits) {
      rows[snare.id][start + hit.step] = clampV(hit.v * (0.92 + rand() * 0.16));
    }
    // Seeded optional tom/ghost flavor on the second snare-ish pad.
    const second = fams.snares[1];
    if (second && rand() < 0.6) {
      rows[second.id][start + stepsPerBar - 1 - 3] = 0.5;
      rows[second.id][start + stepsPerBar - 1 - 1] = 0.65;
    }
  }
  const phrasePlan = buildPhrasePlan(pattern.stepCount, meter);
  if (phrasePlan.length > 0) {
    phrasePlan[phrasePlan.length - 1] = {
      ...phrasePlan[phrasePlan.length - 1],
      section: "fill",
    };
  }
  return { rows, clearStepMeta: { from: start, to: pattern.stepCount }, phrasePlan };
}
