import type { ArrangementTransitionType, Pattern, ProjectDocument } from "../project-model/types";
import { inferPadRole, type PadRole } from "../ai/pad-roles";
import { refreshPatternOutputHash } from "./quality";
import { forkRandom } from "../shared/rng";

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
 * Treatments bake into the section pattern at build time, so a song stays
 * one undo step with reproducible content hashes. Since the fill vocabulary
 * (2026-10-10) the fill/riser shapes are a SEEDED pick from a recipe pool —
 * deterministic per boundary (no runtime randomness), but varied across a
 * song's sections and gated by the incoming section's intensity.
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

/**
 * FILL VOCABULARY (2026-10-10) — one hardcoded roll shape meant every fill
 * in every song read identically. A recipe paints the OUTGOING last bar
 * (already zeroed) into the kit's role rows; the recipe is picked
 * deterministically per section boundary (seeded by the outgoing pattern id
 * + the incoming label) and the pool is gated by the INCOMING section's
 * intensity, so a bridge turnaround reads subtle and a drop lands the big
 * one. All recipes stay deterministic — the variety is a seeded pick, never
 * runtime randomness.
 */
interface FillContext {
  rows: Record<string, number[]>;
  groups: PadGroups;
  /** First step of the fill bar. */
  base: number;
  /** The incoming section's intensity (0..1) — recipes may scale velocities. */
  intensity: number;
}

interface FillRecipe {
  id: string;
  /** "subtle" recipes serve low-intensity boundaries; "big" the high ones. */
  tier: "subtle" | "big";
  weight: number;
  paint: (ctx: FillContext, rand: () => number) => void;
}

const FILL_RECIPES: readonly FillRecipe[] = [
  {
    id: "crescendo-roll",
    tier: "big",
    weight: 3,
    paint: ({ rows, groups, base }) => {
      // Full-bar 16th roll alternating the roll voices, crescendo, tom run
      // on the last 4 steps (the classic — kept as one voice among many).
      for (let step = 0; step < LAST_BAR_STEPS; step++) {
        const padId = groups.roll[step % groups.roll.length];
        hit(rows[padId], base + step, 0.3 + 0.6 * (step / (LAST_BAR_STEPS - 1)));
      }
      const runPads = groups.tom.length > 0 ? groups.tom : groups.roll;
      for (let i = 0; i < 4; i++) {
        hit(rows[runPads[i % runPads.length]], base + 12 + i, 0.8 + 0.05 * i);
      }
    },
  },
  {
    id: "half-push",
    tier: "subtle",
    weight: 3,
    paint: ({ rows, groups, base }) => {
      // The last 8 steps only: 8ths into 16ths, a short push that lifts the
      // boundary without stealing the bar.
      for (let step = 8; step < LAST_BAR_STEPS; step++) {
        const padId = groups.roll[step % groups.roll.length];
        const ramp = (step - 8) / 7;
        hit(rows[padId], base + step, 0.3 + 0.45 * ramp);
      }
      const runPads = groups.tom.length > 0 ? groups.tom : groups.roll;
      hit(rows[runPads[0]], base + 14, 0.72);
      hit(rows[runPads[runPads.length - 1] ?? runPads[0]], base + 15, 0.78);
    },
  },
  {
    id: "tom-cascade",
    tier: "big",
    weight: 2,
    paint: ({ rows, groups, base }) => {
      // Descending tom cascade across the back half + snare anchor on 1.
      hit(rows[groups.roll[0]], base, 0.85);
      const cascade = groups.tom.length > 1 ? groups.tom : [...groups.tom, ...groups.roll];
      for (let i = 0; i < 8; i++) {
        const padId = cascade[Math.min(cascade.length - 1, Math.floor((i / 8) * cascade.length))];
        hit(rows[padId], base + 8 + i, 0.55 + 0.35 * (i / 7));
      }
    },
  },
  {
    id: "ghost-turnaround",
    tier: "subtle",
    weight: 2,
    paint: ({ rows, groups, base }) => {
      // Ghost 16ths under the line with one accented push on the 4-and —
      // the played turnaround, not a statement.
      for (let step = 0; step < LAST_BAR_STEPS; step += 2) {
        hit(rows[groups.roll[step % groups.roll.length]], base + step, 0.22 + 0.14 * (step / 14));
      }
      hit(rows[groups.roll[0]], base + 14, 0.68);
      const kickPad = groups.kick[0];
      if (kickPad) hit(rows[kickPad], base, 0.7);
    },
  },
  {
    id: "kick-drive",
    tier: "big",
    weight: 2,
    paint: ({ rows, groups, base }) => {
      // Kick 8ths under a short terminal roll — the drive into a heavy
      // section (drops, choruses at full energy).
      if (groups.kick.length === 0) return;
      for (let step = 0; step < LAST_BAR_STEPS; step += 2) {
        hit(rows[groups.kick[0]], base + step, 0.82);
      }
      for (let step = 8; step < LAST_BAR_STEPS; step++) {
        const padId = groups.roll[step % groups.roll.length];
        hit(rows[padId], base + step, 0.4 + 0.4 * ((step - 8) / 7));
      }
    },
  },
  {
    id: "stop-tail",
    tier: "subtle",
    weight: 1,
    paint: ({ rows, groups, base }) => {
      // Hits on 1, 2, 3 — then beat 4 is SILENT except the pickup on the
      // 4-and. The gap IS the arrangement.
      const accents = [0, 4, 8];
      for (const step of accents) {
        hit(rows[groups.roll[0]], base + step, 0.8);
        const kickPad = groups.kick[0];
        if (kickPad) hit(rows[kickPad], base + step, 0.85);
      }
      hit(rows[groups.roll[0]], base + 14, 0.6);
    },
  },
];

function pickFillRecipe(poolKey: string, tier: "subtle" | "big"): FillRecipe {
  const pool = FILL_RECIPES.filter((recipe) => recipe.tier === tier);
  const rand = forkRandom(poolKey, "song.fill");
  let total = 0;
  for (const recipe of pool) total += recipe.weight;
  let pick = rand() * total;
  for (const recipe of pool) {
    pick -= recipe.weight;
    if (pick <= 0) return recipe;
  }
  return pool[pool.length - 1];
}

function zeroBar(row: number[], bar: number): void {
  const start = bar * LAST_BAR_STEPS;
  for (let step = start; step < start + LAST_BAR_STEPS && step < row.length; step++) row[step] = 0;
}

function hit(row: number[], step: number, velocity: number): void {
  if (step >= 0 && step < row.length) row[step] = Math.max(0, Math.min(1, velocity));
}

/** Apply one treatment to the pattern's drum rows. Mutates rows copies. */
function treat(
  pattern: Pattern,
  doc: ProjectDocument,
  treatment: TransitionTreatment,
  options: { intensity?: number; fillSeed?: string } = {},
): Pattern {
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
    // zero the last bar, keep the downbeat kick anchor, then paint the
    // boundary's seeded recipe (the pool gates on the incoming intensity)
    for (const row of Object.values(rows)) zeroBar(row, lastBar);
    for (const padId of groups.kick) hit(rows[padId], lastBar * LAST_BAR_STEPS, 0.9);
    const intensity = options.intensity ?? 0.8;
    const tier = intensity >= 0.7 ? "big" : "subtle";
    const recipe = pickFillRecipe(options.fillSeed ?? pattern.id, tier);
    recipe.paint({ rows, groups, base: lastBar * LAST_BAR_STEPS, intensity }, () => 0.5);
  } else if (treatment === "riser") {
    if (bars < 2) return treat(pattern, doc, "fill", options);
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
    // bar n-1: the boundary's seeded recipe carries the lift (the fixed
    // 16th crescendo is one recipe among many now) + rising open hats
    const intensity = options.intensity ?? 0.8;
    const recipe = pickFillRecipe(options.fillSeed ?? pattern.id, intensity >= 0.7 ? "big" : "subtle");
    recipe.paint({ rows, groups, base: lastBar * LAST_BAR_STEPS, intensity }, () => 0.5);
    for (const padId of groups.hat) {
      for (let step = 0; step < 16; step += 2) {
        hit(rows[padId], lastBar * LAST_BAR_STEPS + step, 0.3 + 0.4 * (step / 14));
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
  options: { allowDrums?: boolean; intensity?: number; fillSeed?: string } = {},
): Pattern {
  const treatment = transitionTreatmentOf(type);
  if (!treatment) return pattern;
  if (options.allowDrums === false && treatment !== "dropout") return pattern;
  return treat(pattern, doc, treatment, options);
}
