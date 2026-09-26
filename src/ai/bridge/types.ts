/**
 * Bridge contract — the surface between any AI provider (cloud LLM, local
 * LLM, or deterministic mock) and the rest of KYX.
 *
 * Design invariants (see AGENTS.md §3):
 *   1. The bridge produces INTENT in the form of Command[] batches. It never
 *      touches AudioNodes, the live AudioContext, or the offline renderer.
 *   2. Every batch is validated and wrapped into a single snapshot Command
 *      so the user gets exactly ONE undo entry per AI suggestion.
 *   3. LLM-free path (mockProvider) and LLM path (provider/<name>.ts) share
 *      the same Recipe + CommandBatch contract — the model is a swappable
 *      adapter, not a hard dependency.
 *   4. The bridge never sees audio sample data; only structured project
 *      metadata and numerical meter readings.
 *
 * The "snares vs hates" recipe in ./recipes/snaresVsHates.ts is the canonical
 * shape every other recipe should match: declarative BridgeCommands, pure
 * resolvers, executable through a single snapshot().
 */

import type { ProjectDocument } from "../../project-model/types";

/**
 * All bridge command kinds the MVP knows how to execute. Adding a kind here
 * forces the executor to handle it (the union is exhaustive at the apply
 * site via `assertNever`). Future recipe authors add a new variant here AND
 * a matching executor branch in `./executor.ts`.
 */
export type BridgeCommandKind = "sidechain-duck" | "eq-carve" | "eq-boost" | "set-volume" | "set-track-pan";

/**
 * High-level command produced by a recipe. The executor (./executor.ts) is
 * the only place that turns these into concrete ProjectDocument mutations.
 *
 * `apply` MUST be a pure function of its `doc` argument — no hidden state,
 * no randomness, no I/O. Determinism is the bridge's whole point: the same
 * recipe + same project + same personalization must yield the same batch.
 */
export interface BridgeCommandBase {
  readonly kind: BridgeCommandKind;
  readonly label: string;
  /** Free-text explanation for the UI; never rendered as HTML (invariant §10). */
  readonly rationale: string;
}

/**
 * Insert a sidechain compressor on `target` whose key input is `source`.
 * Used for the canonical "snares duck hi-hats" recipe.
 */
export interface SidechainDuckCommand extends BridgeCommandBase {
  readonly kind: "sidechain-duck";
  readonly target: TrackMatcher;
  readonly source: TrackMatcher;
  readonly params: {
    /** Depth in dB; negative = duck (target is pulled down when source plays). */
    readonly amountDb: number;
    readonly attackMs: number;
    readonly releaseMs: number;
    /** Below this linear level on the source, ducking is bypassed. */
    readonly bypassThreshold: number;
  };
}

/**
 * Narrow a frequency band on `target`. Negative `gainDb` = carve (cut).
 * `q` is the standard audio Q factor (higher = narrower).
 */
export interface EqCarveCommand extends BridgeCommandBase {
  readonly kind: "eq-carve";
  readonly target: TrackMatcher;
  readonly freqHz: number;
  readonly gainDb: number;
  readonly q: number;
}

/**
 * Boost a frequency band on `target` (positive `gainDb`).
 */
export interface EqBoostCommand extends BridgeCommandBase {
  readonly kind: "eq-boost";
  readonly target: TrackMatcher;
  readonly freqHz: number;
  readonly gainDb: number;
  readonly q: number;
}

/**
 * Set a track's output volume in dBFS.
 */
export interface SetVolumeCommand extends BridgeCommandBase {
  readonly kind: "set-volume";
  readonly target: TrackMatcher;
  readonly volumeDb: number;
}

/**
 * Set a track's stereo pan in [-1, +1] (-1 = full left, +1 = full right).
 */
export interface SetTrackPanCommand extends BridgeCommandBase {
  readonly kind: "set-track-pan";
  readonly target: TrackMatcher;
  readonly pan: number;
}

export type BridgeCommand =
  SidechainDuckCommand | EqCarveCommand | EqBoostCommand | SetVolumeCommand | SetTrackPanCommand;

/**
 * Pattern-match helper used by every recipe's `apply` to locate the right
 * track. Pure; resolution lives in the executor (`resolveTrack`).
 */
export function bridgeCommandKind(cmd: BridgeCommand): BridgeCommandKind {
  return cmd.kind;
}

/**
 * Declarative track selector used by recipes. Resolution is centralised in
 * the executor so all recipes agree on what "the hi-hat" means.
 *
 * `namePattern` matches against the track's `name` field (case-insensitive
 * substring by default; explicit `regex: true` switches to a real regex).
 *
 * `preferKind` lets the executor prefer drum sub-buses over instrument
 * tracks when both contain "snare" — the snare drum kit is usually routed
 * to its own drum sub-bus, not an instrument track.
 */
export interface TrackMatcher {
  readonly namePattern: string;
  readonly regex?: boolean;
  readonly preferKind?: "drum" | "instrument" | "any";
}

/**
 * A recipe is a named bundle of BridgeCommands built from a project context.
 * Recipes are pure: given the same inputs they produce the same batch.
 *
 * `id` is stable across runs and is the lookup key in the registry.
 * `intentPatterns` is what the mockProvider pattern-matches against user
 * prompts ("uprav snares aby sa nebili s hates" → "snares-vs-hates").
 * `requiresPersonalization` lets the recipe opt in to user-pref weighting.
 */
export interface Recipe {
  readonly id: string;
  readonly description: string;
  readonly intentPatterns: readonly string[];
  build(input: RecipeInput): BridgeCommand[];
}

/**
 * Everything a recipe needs to produce its commands. Built by the executor
 * from a ProjectDocument + personalization snapshot.
 */
export interface RecipeInput {
  readonly doc: ProjectDocument;
  readonly userPreferences: UserPreferencesSnapshot;
}

/**
 * Lightweight, serializable snapshot of the user-pref state. Stored in
 * IndexedDB (see ../persistence/userPreferences.ts, follow-up) and read at
 * recipe time to tilt parameters toward the user's demonstrated taste.
 *
 * `weight` ∈ [0, 1]: how strongly the historical preference should dominate
 * the recipe's default. 0 = pure default; 1 = override default completely.
 */
export interface UserPreferencesSnapshot {
  readonly weight: number;
  readonly conflictResolution: {
    readonly "eq-carve": number;
    readonly "sidechain-duck": number;
  };
  readonly eqCutIntensityDb: number;
  readonly notes: string;
}

export const EMPTY_PREFERENCES: UserPreferencesSnapshot = {
  weight: 0,
  conflictResolution: { "eq-carve": 0.5, "sidechain-duck": 0.5 },
  eqCutIntensityDb: 3,
  notes: "",
};

/**
 * The atomic unit the executor commits to the project. Wraps one or more
 * BridgeCommands and carries rationale + estimated impact for the UI.
 *
 * `riskLevel` is heuristic; the executor computes it from the command kinds
 * and the project's master limiter state.
 */
export interface CommandBatch {
  readonly recipeId: string;
  readonly label: string;
  readonly rationale: string;
  readonly commands: readonly BridgeCommand[];
  readonly estimatedImpact: EstimatedImpact;
}

export interface EstimatedImpact {
  readonly peakDeltaDb: number;
  readonly rmsDeltaDb: number;
  readonly riskLevel: "low" | "medium" | "high";
}

/**
 * Result of resolving a CommandBatch against a project. The executor either
 * succeeds (with the new doc + the wrapped Command) or fails (with a
 * structured error the UI can show).
 */
export type BridgeExecutionResult =
  | { ok: true; doc: ProjectDocument; command: import("../../commands/types").Command }
  | { ok: false; error: BridgeExecutionError };

export interface BridgeExecutionError {
  readonly code: "no-recipe-match" | "no-track-match" | "invalid-command" | "project-saturated" | "validation-failed";
  readonly message: string;
  readonly hint?: string;
}
