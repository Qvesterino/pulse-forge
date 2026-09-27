/**
 * "Snares vs hates" recipe — the canonical conflict-resolution case.
 *
 * Trigger phrases the mockProvider pattern-matches against (Slovak + English,
 * common DAW slang — "hates" is a frequent phonetic shortening of "hi-hats"):
 *   - "sprav snary aby sa nebili s hates"
 *   - "uprav snares aby sa nebili s hates"
 *   - "snare clashes with hi-hat"
 *   - "snare and hats are masking"
 *
 * Why two strategies:
 *   - EQ CARVE (cut hi-hat in 4-8 kHz): always-on, preserves both elements,
 *     static.
 *   - SIDECHAIN DUCK (snare pulls hi-hat down on each hit): dynamic, more
 *     transparent, but uses a sidechain slot on the target track.
 * The recipe tilts between them via UserPreferencesSnapshot:
 *   - eq-carve weight > sidechain-duck weight → milder carve + heavier duck
 *   - sidechain-duck weight > eq-carve weight   → no carve, heavier duck
 *   - 50/50 (default) → recipe defaults below
 *
 * Determinism: every parameter here is a closed-form function of the input
 * snapshot — no Math.random, no Date.now, no I/O. Same project + same
 * prefs → identical batch. The executor's job is to validate and apply.
 */

import type { BridgeCommand, Recipe, RecipeInput } from "../types";

const RECIPE_ID = "snares-vs-hates";

const INTENT_PATTERNS: readonly string[] = [
  "snares.*hates",
  "snares.*hihat",
  "snare.*hat",
  "snare.*clash",
  "hat.*mask",
  "masking.*snare",
];

export const snaresVsHatesRecipe: Recipe = {
  id: RECIPE_ID,
  description:
    "Resolve the classic snare/hi-hat spectral clash with a frequency carve plus an optional sidechain duck. Tilted by user preferences.",
  intentPatterns: INTENT_PATTERNS,
  build(input: RecipeInput): BridgeCommand[] {
    const { doc, userPreferences } = input;

    // ── Guard: both source and target must exist in the project ───────────
    // The matcher is a strict regex against `track.name` (case-insensitive).
    // "hates" / "hi-hat" / "hihat" / "hi hat" are all accepted (DAW slang).
    const HIHAT_RE = /hi[- ]?hats?|^hats$|\bhates\b/i;
    const SNARE_RE = /\bsnare\b/i;
    const hasHihat = doc.tracks.some((t) => HIHAT_RE.test(t.name));
    const hasSnare = doc.tracks.some((t) => SNARE_RE.test(t.name));
    if (!hasHihat || !hasSnare) {
      // Empty batch is the recipe's way of saying "I don't apply here".
      // The executor surfaces this as a `no-track-match` BridgeExecutionError.
      return [];
    }

    // ── Personalization tilt ──────────────────────────────────────────────
    const eqWeight = userPreferences.conflictResolution["eq-carve"];
    const scWeight = userPreferences.conflictResolution["sidechain-duck"];
    const total = eqWeight + scWeight;
    // Normalise to [0, 1]: 0 = pure EQ carve, 1 = pure sidechain.
    const sidechainTilt = total > 0 ? scWeight / total : 0.5;

    // ── EQ carve on hi-hats ───────────────────────────────────────────────
    // The 6 kHz band sits on top of hi-hat tick. Default -3 dB; reduced when
    // the user prefers sidechain (less static cut, more dynamic duck).
    const baseCarveDb = -userPreferences.eqCutIntensityDb;
    const carveGainDb = baseCarveDb * (1 - 0.6 * sidechainTilt);
    const carveGainDbRounded = Math.round(carveGainDb * 10) / 10;

    // ── EQ boost on snare (always small, keeps the crack readable) ────────
    // 4 kHz is the classic "snare crack" centre. +2 dB is enough; we do not
    // tilt this with personalisation because masking happens regardless.
    const boostGainDb = 2;

    // ── Sidechain duck on hi-hats, keyed from snare ───────────────────────
    // `duckDb` is MUSICAL INTENT (worst-case depth), not a param — the
    // executor turns it into the canonical ratio/amount pair. Deeper when
    // the user prefers sidechain (6 dB at tilt=1), shallower when the carve
    // is doing more of the work (2.5 dB at tilt=0).
    const duckMinDb = 2.5;
    const duckMaxDb = 6;
    const duckDb = duckMinDb + (duckMaxDb - duckMinDb) * sidechainTilt;
    const duckDbRounded = Math.round(duckDb * 10) / 10;

    // ── Build the batch ───────────────────────────────────────────────────
    const commands: BridgeCommand[] = [];

    // EQ carve — only when there's something to carve. If the user is at the
    // pure-sidechain end (sidechainTilt >= 0.95) we skip the carve entirely.
    //
    // Slot choice: the hi-hat tick lives at 6 kHz, squarely inside the
    // highMid BELL window (500–8000 Hz) — a bell only touches the mask band
    // instead of tilting the whole top end the way highShelf would.
    if (sidechainTilt < 0.95) {
      commands.push({
        kind: "eq-carve",
        label: `Carve ${carveGainDbRounded.toFixed(1)} dB @ 6 kHz on hi-hats`,
        rationale:
          "Reduce hi-hat energy in the 4-8 kHz band where snare attack dominates — keeps both elements audible.",
        target: { namePattern: "hi[-_ ]?hats?|\\bhates\\b", regex: true, preferKind: "any" },
        band: "highMid",
        freqHz: 6000,
        gainDb: carveGainDbRounded,
        q: 1.5,
      });
      // Snare crack sits at 4 kHz — also highMid, but on the SNARE track, so
      // the two moves never collide on the same EffectInstance.
      commands.push({
        kind: "eq-boost",
        label: `Boost ${boostGainDb.toFixed(1)} dB @ 4 kHz on snare`,
        rationale:
          "After carving the hi-hat, give the snare crack a small boost so it stays the focal point of the back-beat.",
        target: { namePattern: "\\bsnare\\b", regex: true, preferKind: "any" },
        band: "highMid",
        freqHz: 4000,
        gainDb: boostGainDb,
        q: 1.0,
      });
    }

    commands.push({
      kind: "sidechain-duck",
      label: `Sidechain duck hi-hats ${duckDbRounded.toFixed(1)} dB from snare`,
      rationale:
        "When snare hits, hi-hats duck briefly — punchier transient, less masking, transparent in the gaps. Depth is a starting point; nudge RATIO in the rack to taste.",
      target: { namePattern: "hi[-_ ]?hats?|\\bhates\\b", regex: true, preferKind: "any" },
      source: { namePattern: "\\bsnare\\b", regex: true, preferKind: "any" },
      // Seconds, not ms — the canonical `attack`/`release` are time constants.
      duckDb: duckDbRounded,
      attackSec: 0.001,
      releaseSec: 0.12,
      thresholdDb: -18,
    });

    return commands;
  },
};
