/**
 * "Punchier drums" recipe — the second recipe in the registry, and the first
 * one to use the `compressor` command rather than `eq-carve` / `sidechain-duck`.
 *
 * Trigger phrases:
 *   - "sprav tie drums viac agresivne"
 *   - "drums su moc mäkké / ploché"
 *   - "make the drums punchier"
 *   - "punchier drums"
 *
 * What "punchier" actually means in a mix, and why it maps to these moves:
 *
 *   1. TRANSIENT SHAPER on the drum bus. The single most direct control over
 *      perceived attack. `transientParams` exposes attack/sustain in −1…1
 *      (negative sustain pulls the body down so the click reads), plus
 *      `sensitivity` to control how much material reacts.
 *
 *   2. BUS COMPRESSOR in `punch` character. Catches the transient and holds
 *      the level between hits, so the loud/quiet difference collapses and the
 *      kit sits up front. `punch` uses a fast attack (2 ms) and a short
 *      release (120 ms) so it reacts to hits rather than riding the whole bar,
 *      and the PEAK detector avoids pumping between transients.
 *
 *   3. HIGH-PASS on the drum bus. Punch reads better when the kick's sub
 *      energy is not fighting the bass. This is a tone move, not a dynamics
 *      one, but it is part of why an aggressive drum bus sounds aggressive.
 *
 * Deliberately NOT included: swapping the sample kit. That is a destructive,
 * hard-to-undo change to the musical content, and the bridge should not do it
 * on an inferred intent — the user can reach for the kit picker themselves.
 *
 * Determinism: no randomness, no clock, no I/O. Same project + same prefs →
 * same batch.
 */

import type { BridgeCommand, Recipe, RecipeInput } from "../types";

const RECIPE_ID = "punchier-drums";

// Slovak ("drumy") and English ("drums") stems both appear, and the endings
// differ, so `drums?` covers both rather than listing each suffix twice.
// `[aä]` matches both ASCII and diacritic spellings of "mäkké".
const INTENT_PATTERNS: readonly string[] = [
  "drums?.*agres",
  "drums?.*raz",
  "drums?.*m[aä]kk",
  "drums?.*ploch",
  "drums?.*sit\\s*up",
  "drums?.*forward",
  "punchier",
  "punchy",
  "agresivn.*drum",
];

export const punchierDrumsRecipe: Recipe = {
  id: RECIPE_ID,
  description:
    "Add a transient shaper, a fast bus compressor and a high-pass to the drum bus so the kit reads as aggressive instead of soft.",
  intentPatterns: INTENT_PATTERNS,
  build(input: RecipeInput): BridgeCommand[] {
    const { doc, userPreferences } = input;

    // A drum bus is a TRACK, so the matcher looks at track names. KYX routes
    // kits through a "Drums"/"DRUMS" track in every template.
    const drumBus = findDrumBus(doc);
    if (!drumBus) return [];

    // Intensity is the bridge's single dial for the whole recipe. Personal
    // preference for EQ carving is reused here as a general "how much do you
    // want me to touch this" signal — a user who prefers gentle structural
    // moves gets a lighter touch on the bus as well.
    const eqWeight = userPreferences.conflictResolution["eq-carve"];
    const total = eqWeight + userPreferences.conflictResolution["sidechain-duck"];
    const aggression = total > 0 ? eqWeight / total : 0.5;

    const commands: BridgeCommand[] = [];

    // 1) Transient shaper — the most audible part of "punch".
    const transientAmount = round2(0.35 + 0.45 * aggression);
    commands.push({
      kind: "insert-transient",
      label: `Transient shaper — attack ${(transientAmount * 100).toFixed(0)}%`,
      rationale:
        "Adds perceived attack and pulls the body down, so the kit reads as 'in your face' without raising its level.",
      target: drumBus,
      params: {
        attack: transientAmount,
        sustain: -round2(0.2 + 0.3 * aggression),
        sensitivity: 0.5,
        mix: 1,
        // TransientSpec exposes the post-effect trim as `outputDb` (dB, −24…24).
        // `output` is not a canonical key — normalizeEffects would drop it on
        // the next load and the trim would silently do nothing.
        outputDb: 0,
      },
    });

    // 2) Bus compressor in `punch` character — holds the level between hits.
    commands.push({
      kind: "compressor",
      label: `Bus compressor — punch, intensity ${(0.45 + 0.35 * aggression).toFixed(2)}`,
      rationale:
        "Fast attack catches the transient, short release fills the gaps between hits, so the kit stops pumping up and down.",
      target: drumBus,
      character: "punch",
      intensity: round2(0.45 + 0.35 * aggression),
    });

    // 3) High-pass — the sub fight is what makes a "punchy" mix sound muddy.
    //    Corners are their own command kind: `hp` has no gain param, so an
    //    `eq-carve` here would be rejected rather than applied.
    commands.push({
      kind: "eq-corner",
      label: "High-pass drum bus",
      rationale:
        "Keeps the kick's sub energy from fighting the bass track, which is what lets the rest of the kit stay forward.",
      target: drumBus,
      band: "hp",
      freqHz: 40,
    });

    return commands;
  },
};

/**
 * Find the drum bus track. Prefers an explicitly named drum track, then a
 * group track that is clearly the kit bus, and finally nothing — a project
 * whose kit is spread across single-hit tracks has no bus to treat, and
 * guessing one would push the whole recipe onto the wrong element.
 */
function findDrumBus(doc: RecipeInput["doc"]): { namePattern: string; regex: boolean; preferKind: "any" } {
  const named = doc.tracks.find((t) => /^\s*(drums?|drum\s?bus|kit|percussion)\s*$/i.test(t.name));
  if (named) return { namePattern: escapeLiteral(named.name), regex: false, preferKind: "any" };
  const loose = doc.tracks.find((t) => /\bdrums?\b/i.test(t.name));
  if (loose) return { namePattern: escapeLiteral(loose.name), regex: false, preferKind: "any" };
  // Nothing drum-shaped: the caller turns the empty batch into
  // "no drum bus found", which is far more useful than a wrong guess.
  return { namePattern: "__no_drum_bus__", regex: false, preferKind: "any" };
}

function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
