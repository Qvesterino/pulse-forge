import type { RoutedIntent } from "./route";

/**
 * DESTRUCTIVE-ROUTE GUARD (signal-flow audit re-run 2026-10).
 *
 * Shared predicate for both intent surfaces: the MCP layer gates destructive
 * routes behind an explicit unlock + auto-checkpoint (destructiveAllowed-
 * WithCheckpoint), while the in-app Intent Bar executed removeTrack /
 * deleteClip / scene-remove / effect-remove immediately — undo was the only
 * net, and the 256-deep undo stack evicts the pre-delete state in a long
 * session. The Intent Bar now consults the SAME predicate before executing
 * and saves a durable checkpoint first.
 *
 * Lives in src/intent (not src/mcp) so the UI can import it without pulling
 * the lazy MCP surface into the App chunk.
 */
export function routeIsDestructive(route: RoutedIntent): boolean {
  switch (route.kind) {
    case "exact":
      return route.plan.ops.some((op) => op.kind === "removeTrack");
    case "arrange":
      return route.ops.some((op) => op.op === "remove");
    case "clips":
      return route.ops.some((op) => op.op === "deleteClip");
    case "effectIntent":
      return route.intent.direction === "remove";
    case "compound":
      return route.parts.some(
        (part) =>
          (part.kind === "effect" && part.intent.direction === "remove") ||
          (part.kind === "exact" && part.plan.ops.some((op) => op.kind === "removeTrack")),
      );
    default:
      return false;
  }
}

/** Checkpoint name for a destructive route — readable in both surfaces. */
export function destructiveCheckpointName(route: RoutedIntent): string {
  switch (route.kind) {
    case "exact":
      return "auto-before-remove-track";
    case "arrange":
      return "auto-before-remove-scene";
    case "clips":
      return "auto-before-delete-clip";
    case "effectIntent":
      return "auto-before-remove-effect";
    default:
      return "auto-before-compound";
  }
}
