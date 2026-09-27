/**
 * mockProvider — the LLM-free path through the AI bridge.
 *
 * This is the adapter that lets the rest of KYX be built and tested without
 * any Anthropic / OpenAI / Ollama call. It takes the user's prompt, pattern-
 * matches it against the recipe registry, runs the matching recipe against
 * the current project + user-pref snapshot, and returns a fully-shaped
 * CommandBatch — the same shape the LLM provider will produce, so the
 * executor and the UI never need to know which path was used.
 *
 * When a real LLM provider lands (./provider/<name>.ts), it will satisfy the
 * same `generateBatch` signature and the executor stays untouched. The
 * recipe registry is the boundary between the LLM world (intent parsing)
 * and the KYX world (project mutation).
 */

import type { BridgeCommand, CommandBatch, EstimatedImpact, RecipeInput } from "./types";
import { findRecipe } from "./recipes";

export interface GenerateBatchResult {
  readonly ok: boolean;
  readonly batch: CommandBatch | null;
  /** When `ok` is false, why — surfaced verbatim in the AI chat panel. */
  readonly reason?: "no-recipe-match" | "recipe-applied-no-commands" | "empty-prompt";
}

/**
 * Run the recipe registry against the user's prompt. Pure; no side effects.
 */
export function generateBatch(prompt: string, input: RecipeInput): GenerateBatchResult {
  if (!prompt || !prompt.trim()) {
    return { ok: false, batch: null, reason: "empty-prompt" };
  }

  const recipe = findRecipe(prompt);
  if (!recipe) {
    return { ok: false, batch: null, reason: "no-recipe-match" };
  }

  const commands = recipe.build(input);
  if (commands.length === 0) {
    // Recipe matched but the project doesn't have the required tracks.
    // The executor would surface this as `no-track-match`; here we report
    // it earlier so the UI can show a helpful "I don't see a hi-hat here".
    return { ok: false, batch: null, reason: "recipe-applied-no-commands" };
  }

  return {
    ok: true,
    batch: {
      recipeId: recipe.id,
      label: humanLabel(recipe.id, commands),
      rationale: aggregateRationale(commands),
      commands,
      estimatedImpact: estimateImpact(commands),
    },
  };
}

/**
 * One-line label for the AI chat panel header. "<recipe>: <commands joined>".
 * Kept deterministic so snapshots in tests don't drift on label cosmetics.
 */
function humanLabel(recipeId: string, commands: readonly BridgeCommand[]): string {
  return `${recipeId}: ${commands.map((c) => c.label).join(" + ")}`;
}

function aggregateRationale(commands: readonly BridgeCommand[]): string {
  return commands.map((c) => c.rationale).join(" ");
}

/**
 * Heuristic peak / RMS / risk estimate from the command kinds. Real audio
 * prediction needs a render pass; this is a coarse pre-check for the UI so
 * a "high risk" batch can show a confirm dialog before applying.
 *
 * Numbers are conservative — better to warn one extra time than to clip the
 * master by accident.
 */
function estimateImpact(commands: readonly BridgeCommand[]): EstimatedImpact {
  let peakDeltaDb = 0;
  let rmsDeltaDb = 0;

  for (const cmd of commands) {
    switch (cmd.kind) {
      case "eq-carve":
      case "eq-boost":
        // EQ has minimal peak impact (parametric bands don't add gain unless
        // positive boost at low freqs), small RMS impact on boosted bands.
        rmsDeltaDb += cmd.kind === "eq-boost" ? Math.max(0, cmd.gainDb) * 0.3 : 0;
        peakDeltaDb += cmd.kind === "eq-boost" ? Math.max(0, cmd.gainDb) * 0.4 : 0;
        break;
      case "sidechain-duck":
        // `duckDb` is the intended worst-case depth; a duck only ever pulls
        // signal down, so it contributes to the risk estimate in that
        // direction (half on peak, quarter on RMS for rhythmic material).
        peakDeltaDb += Math.abs(cmd.duckDb) * 0.5;
        rmsDeltaDb += Math.abs(cmd.duckDb) * 0.25;
        break;
      case "compressor":
        // Compression is level-reducing and the character carries its own
        // makeup, so the net delta stays small. Only the makeup can lift it.
        rmsDeltaDb += cmd.intensity * 2;
        peakDeltaDb += cmd.intensity * 1.5;
        break;
      case "haas-widener":
      case "ms-eq":
        // Mid/side and Haas both reshape level distribution; Haas can raise
        // peaks because the two channels sum differently than the dry source.
        peakDeltaDb += cmd.intensity * 1.5;
        rmsDeltaDb += cmd.intensity * 1;
        break;
      case "distortion":
        // A hard clipper without its makeup trim is a level change disguised
        // as a tone change — the spec's output trim is what makes the
        // estimate flat, so this stays small.
        peakDeltaDb += cmd.intensity * 1.5;
        rmsDeltaDb += cmd.intensity * 2;
        break;
      case "reverb":
        // A wet insert raises the perceived level of the track, which is the
        // thing most likely to push a master into the limiter.
        rmsDeltaDb += cmd.intensity * 3;
        peakDeltaDb += cmd.intensity * 1.5;
        break;
      case "delay":
        rmsDeltaDb += cmd.intensity * 2.5;
        peakDeltaDb += cmd.intensity * 1;
        break;
      case "eq-corner":
        // A high-pass only removes energy, and only below the corner — it can
        // never raise a level, so the loudness delta is effectively zero. It
        // still counts toward the "how much did we touch" risk proxy.
        break;
      case "insert-transient":
        // Shaping redistributes the spectrum in place; the output trim is the
        // only part that moves the level.
        rmsDeltaDb += cmd.params.outputDb * 0.5;
        peakDeltaDb += cmd.params.outputDb * 0.5;
        break;
      case "set-volume":
        peakDeltaDb += cmd.volumeDb * 0.5;
        rmsDeltaDb += cmd.volumeDb * 0.5;
        break;
      case "set-track-pan":
        // Pan changes don't shift overall loudness materially.
        break;
    }
  }

  // Risk: cumulative positive gain (could clip) OR many simultaneous changes.
  const totalPositive = commands.reduce((acc, cmd) => {
    if (cmd.kind === "eq-boost") return acc + Math.max(0, cmd.gainDb);
    if (cmd.kind === "set-volume") return acc + Math.max(0, cmd.volumeDb);
    return acc;
  }, 0);
  const riskLevel: EstimatedImpact["riskLevel"] =
    totalPositive > 6 || commands.length > 8 ? "high" : totalPositive > 3 || commands.length > 4 ? "medium" : "low";

  return {
    peakDeltaDb: round1(peakDeltaDb),
    rmsDeltaDb: round1(rmsDeltaDb),
    riskLevel,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
