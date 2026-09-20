import type { ArrangementTransitionType, Pattern, ProjectDocument } from "../project-model/types";
import { inferPadRole, type PadRole } from "../ai/pad-roles";
import { refreshPatternOutputHash } from "./quality";

/**
 * REAL TRANSITION SOUNDS (INTENT_ENGINE.md T3) — transitions stop being
 * metadata-only: the OUTGOING section's pattern is modified so the
 * arrangement actually SOUNDS the transition.
 *
 *   fill   → full-bar snare/clap roll with a velocity crescendo + tom run
 *   riser  → two-bar build: quarter-note snare pulse → 16th roll + open hats
 *   break  → dropout: the outgoing last bar goes SILENT (the gap before the
 *            next section IS the sound)
 *   others → unchanged
 *
 * All treatments are deterministic (fixed velocity ramps, no RNG) and bake
 * into the section pattern at build time, so a song stays one undo step with
 * reproducible content hashes.
 */

const LAST_BAR_STEPS = 16;

export type TransitionTreatment = "fill" | "riser" | "dropout";

/** Map an arrangement transition type to its pattern treatment (or none). */
export function transitionTreatmentOf(type: ArrangementTransitionType): TransitionTreatment | null {
  switch (type) {
    case "fill":
      return "fill";
    case "riser":
      return "riser";
    case "break":
      return "dropout";
    default:
      return null; // drop/impact/custom: no outgoing-pattern change
  }
}

interface PadGroups {
  roll: string[]; // snare + clap — the roll voice
  tom: string[];
  hat: string[]; // open hats — riser sparkle
  kick: string[];
}

function padGroupsOf(doc: ProjectDocument): PadGroups {
  const groups: PadGroups = { roll: [], tom: [], hat: [], kick: [] };
  const byRole: Record<string, string[]> = {};
  for (const track of doc.tracks) {
    if (track.kind !== "drum") continue;
    for (const [index, pad] of track.pads.entries()) {
      const role: PadRole = inferPadRole(pad.name, index);
      const list = byRole[role] ?? (byRole[role] = []);
      list.push(pad.id);
    }
  }
  groups.roll = [...(byRole.snare ?? []), ...(byRole.clap ?? [])];
  groups.tom = byRole.tom ?? [];
  groups.hat = byRole.openHat ?? [];
  groups.kick = byRole.kick ?? [];
  return groups;
}

function zeroBar(row: number[], bar: number): void {
  const start = bar * LAST_BAR_STEPS;
  for (let step = start; step < start + LAST_BAR_STEPS && step < row.length; step++) row[step] = 0;
}

function hit(row: number[], step: number, velocity: number): void {
  if (step >= 0 && step < row.length) row[step] = Math.max(0, Math.min(1, velocity));
}

/** Apply one treatment to the pattern's drum rows. Mutates rows copies. */
function treat(pattern: Pattern, doc: ProjectDocument, treatment: TransitionTreatment): Pattern {
  const stepCount = pattern.stepCount;
  if (stepCount < LAST_BAR_STEPS) return pattern;
  const groups = padGroupsOf(doc);
  // The roll voice gates only the treatments that PLAY it — dropout is pure
  // removal (zero the last bar) and must fire even on kits without snare/clap.
  if (treatment !== "dropout" && groups.roll.length === 0) return pattern;

  const rows: Record<string, number[]> = {};
  for (const [padId, row] of Object.entries(pattern.rows ?? {})) {
    rows[padId] = [...row];
  }
  // treatment voices may hit pads the pattern never used — give them rows
  for (const group of [groups.roll, groups.tom, groups.hat, groups.kick]) {
    for (const padId of group) {
      if (!rows[padId]) rows[padId] = new Array(stepCount).fill(0);
    }
  }

  const bars = Math.floor(stepCount / LAST_BAR_STEPS);
  const lastBar = bars - 1;

  if (treatment === "fill") {
    // zero the last bar, keep the downbeat kick anchor
    for (const row of Object.values(rows)) zeroBar(row, lastBar);
    for (const padId of groups.kick) hit(rows[padId], lastBar * LAST_BAR_STEPS, 0.9);
    // 16th roll across the whole bar, alternating roll voices, crescendo
    const base = lastBar * LAST_BAR_STEPS;
    for (let step = 0; step < LAST_BAR_STEPS; step++) {
      const velocity = 0.3 + 0.6 * (step / (LAST_BAR_STEPS - 1));
      const padId = groups.roll[step % groups.roll.length];
      hit(rows[padId], base + step, velocity);
    }
    // tom run on the final 4 steps (fall back to roll voices)
    const runPads = groups.tom.length > 0 ? groups.tom : groups.roll;
    for (let i = 0; i < 4; i++) {
      const padId = runPads[i % runPads.length];
      hit(rows[padId], base + 12 + i, 0.8 + 0.05 * i);
    }
  } else if (treatment === "riser") {
    if (bars < 2) return treat(pattern, doc, "fill");
    // zero the last TWO bars, keep the kick anchor of the first riser bar
    for (const row of Object.values(rows)) {
      zeroBar(row, lastBar);
      zeroBar(row, lastBar - 1);
    }
    const anchor = (lastBar - 1) * LAST_BAR_STEPS;
    for (const padId of groups.kick) hit(rows[padId], anchor, 0.8);
    // bar n-2: quarter snare pulse rising + open-hat 8ths
    for (let step = 0; step < 16; step += 4) {
      const padId = groups.roll[0];
      hit(rows[padId], anchor + step, 0.4 + 0.1 * (step / 4));
    }
    for (const padId of groups.hat) {
      for (let step = 2; step < 16; step += 4) hit(rows[padId], anchor + step, 0.35);
    }
    // bar n-1: full 16th roll crescendo + rising open hats on 8ths
    const base = lastBar * LAST_BAR_STEPS;
    for (let step = 0; step < LAST_BAR_STEPS; step++) {
      const padId = groups.roll[step % groups.roll.length];
      hit(rows[padId], base + step, 0.4 + 0.55 * (step / (LAST_BAR_STEPS - 1)));
    }
    for (const padId of groups.hat) {
      for (let step = 0; step < 16; step += 2) {
        hit(rows[padId], base + step, 0.3 + 0.4 * (step / 14));
      }
    }
  } else {
    // dropout: the last bar goes completely silent — the gap is the sound
    for (const row of Object.values(rows)) zeroBar(row, lastBar);
  }

  return refreshPatternOutputHash(doc, { ...pattern, rows });
}

/**
 * Bake a real transition sound into the OUTGOING pattern. Pure — returns a
 * new pattern (rows copied, output hash refreshed). Unknown types return the
 * pattern unchanged.
 *
 * `allowDrums: false` (the outgoing section plays without drums — e.g. a
 * bridge, or the user requested "no drums") suppresses the DRUM-based
 * treatments (fill/riser): the user's role request cuts across transitions.
 * dropout (silence) always applies — it removes, never adds.
 */
export function applyTransitionToPattern(
  doc: ProjectDocument,
  pattern: Pattern,
  type: ArrangementTransitionType,
  options: { allowDrums?: boolean } = {},
): Pattern {
  const treatment = transitionTreatmentOf(type);
  if (!treatment) return pattern;
  if (options.allowDrums === false && treatment !== "dropout") return pattern;
  return treat(pattern, doc, treatment);
}
