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
 */
import { mulberry32, hashString } from "../shared/rng";
import { STEP_TICKS, type DrumPad, type NoteEvent, type Pattern, type PatternPhraseBar, type StepMeta } from "../project-model/types";
import { buildPhrasePlan } from "../ai/phrase";
import type { AssistTarget } from "./types";

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

export type RowsPatch = {
  rows: Record<string, number[]>;
  notes?: Record<string, NoteEvent[]>;
  stepMeta?: Record<string, Record<number, StepMeta>>;
  clearStepMeta?: { from: number; to: number; padIds?: string[] };
  phrasePlan?: PatternPhraseBar[];
  stepCount?: number;
};

// ─── VARY ─────────────────────────────────────────────────────────────────

export function varyPattern(pattern: Pattern, pads: DrumPad[], seed: string, amount = 0.6): RowsPatch {
  const rand = randFromSeed(seed);
  const fams = classifyPads(pads);
  const snareIds = new Set(fams.snares.map((p) => p.id));
  const rows: Record<string, number[]> = {};
  const meta: Record<string, Record<number, StepMeta>> = {};
  for (const [padId, row] of Object.entries(pattern.rows)) {
    const next = [...row];
    const padMeta: Record<number, StepMeta> = {};
    for (let i = 0; i < next.length; i++) {
      const onBeat = i % 4 === 0;
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
        padMeta[i] = { ...(pattern.stepMeta?.[padId]?.[i] ?? {}), microtiming: Math.round(((rand() - 0.5) * 0.2) * 100) / 100 };
      }
    }
    rows[padId] = next;
    if (Object.keys(padMeta).length > 0) meta[padId] = padMeta;
  }
  return { rows, stepMeta: meta };
}

// ─── BUILD (expand to N bars with a ramp) ─────────────────────────────────

const FAMILY_TIER: Array<keyof PadFamilies> = ["kicks", "snares", "hats", "others"];

export function expandWithBuild(pattern: Pattern, pads: DrumPad[], bars: number, seed: string): RowsPatch {
  const rand = randFromSeed(seed);
  const fams = classifyPads(pads);
  const baseBars = Math.max(1, Math.round(pattern.stepCount / 16));
  const stepCount = bars * 16;
  // Element entry points across the build: kick always, each next family
  // joins at ~1/4, 1/2, 3/4 of the build (deterministic jitter per seed).
  const entryBar: Record<string, number> = {};
  FAMILY_TIER.forEach((family, tier) => {
    const base = tier === 0 ? 0 : Math.round((bars * tier) / 4);
    for (const pad of fams[family]) entryBar[pad.id] = Math.min(bars - 1, base + (tier > 0 ? Math.floor(rand() * 2) : 0));
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
      for (let s = 0; s < 16; s++) {
        const v = baseRow[sourceBar * 16 + s] ?? 0;
        if (v > 0) row[bar * 16 + s] = clampV(v * energy);
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
        const step = bar * 16 + (sourceStep % 16);
        if ((rows[padId]?.[step] ?? 0) > 0) expanded[step] = { ...meta };
      }
    }
    if (Object.keys(expanded).length > 0) stepMeta[padId] = expanded;
  }

  const notes: Record<string, NoteEvent[]> = {};
  const sourceBarTicks = 16 * STEP_TICKS;
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

  return { rows, notes, stepMeta, phrasePlan: buildPhrasePlan(stepCount), stepCount };
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

export type ReplaceTarget = AssistTarget;

export function styleNames(target: ReplaceTarget): string[] {
  return Object.keys(STYLE_TABLES[target]);
}

/**
 * Replace ONLY the given pad family's rows with a style groove, tiled across
 * the whole pattern; every other pad keeps the user's data untouched.
 */
export function replaceRows(pattern: Pattern, pads: DrumPad[], target: ReplaceTarget, style: string, seed: string): RowsPatch {
  const rand = randFromSeed(seed);
  const fams = classifyPads(pads);
  const table = STYLE_TABLES[target];
  const groove = table[style] ?? Object.values(table)[0];
  const family = fams[target === "kicks" ? "kicks" : target === "snares" ? "snares" : "hats"];

  const rows: Record<string, number[]> = {};
  // Every pad NOT in the family is passed through untouched.
  for (const [padId, row] of Object.entries(pattern.rows)) {
    rows[padId] = family.some((p) => p.id === padId) ? row : [...row];
  }
  for (const [familyIndex, pad] of family.entries()) {
    const row = new Array<number>(pattern.stepCount).fill(0);
    const baseBars = Math.max(1, Math.round(pattern.stepCount / 16));
    for (let bar = 0; bar < baseBars; bar++) {
      for (const hit of groove) {
        // Second pad of the family plays a lighter shadow of the groove.
        const shade = familyIndex === 0 ? 1 : 0.5;
        row[bar * 16 + hit.step] = clampV(hit.v * shade * (0.92 + rand() * 0.16));
      }
    }
    rows[pad.id] = row;
  }
  return { rows, clearStepMeta: { from: 0, to: pattern.stepCount, padIds: family.map((pad) => pad.id) } };
}

// ─── FILL (crescendo over the last bar) ───────────────────────────────────

export function makeFill(pattern: Pattern, pads: DrumPad[], seed: string): RowsPatch {
  const rand = randFromSeed(seed);
  const fams = classifyPads(pads);
  const start = Math.max(0, pattern.stepCount - 16);
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
    const hits = [
      { step: 4, v: 0.25 },
      { step: 8, v: 0.4 },
      { step: 10, v: 0.5 },
      { step: 12, v: 0.65 },
      { step: 13, v: 0.7 },
      { step: 14, v: 0.85 },
      { step: 15, v: 1 },
    ];
    for (const hit of hits) {
      rows[snare.id][start + hit.step] = clampV(hit.v * (0.92 + rand() * 0.16));
    }
    // Seeded optional tom/ghost flavor on the second snare-ish pad.
    const second = fams.snares[1];
    if (second && rand() < 0.6) {
      rows[second.id][start + 12] = 0.5;
      rows[second.id][start + 14] = 0.65;
    }
  }
  const phrasePlan = buildPhrasePlan(pattern.stepCount);
  if (phrasePlan.length > 0) {
    phrasePlan[phrasePlan.length - 1] = {
      ...phrasePlan[phrasePlan.length - 1],
      section: "fill",
    };
  }
  return { rows, clearStepMeta: { from: start, to: pattern.stepCount }, phrasePlan };
}
