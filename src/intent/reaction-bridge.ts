/**
 * F1 GLUE (docs/INTENT-REACTION-LISTENING-PLAN.md) — the one-call bridge
 * between the intent dispatch sites and the Reaction Ledger.
 *
 * Call AFTER `store.execute(command)` for any intent-applied action:
 * the helper registers the proposal (route kind, compact sanitized action,
 * affected track ids, before/after doc hashes, undo-stack depth). The
 * ledger's own hooks then resolve keep/undo/tweak — nothing else to wire.
 *
 * A disabled ledger or a non-intent route is a silent no-op. NEVER throws.
 */
import { hashString } from "../shared/rng";
import { compactIntentResponse } from "./dataset";
import type { RoutedIntent } from "./route";
import { activeReactionLedger } from "./reaction-ledger";
import type { ProjectDocument } from "../project-model/types";

const MUTATING_KINDS: ReadonlySet<string> = new Set([
  "fader",
  "exact",
  "paramIntent",
  "effectIntent",
  "sendIntent",
  "bypassIntent",
  "mix",
  "loudness",
  "tempo",
  "production",
  "revise",
  "arrange",
  "clips",
  "complaintIntent",
  "undoIntent",
  "queryIntent",
  "preset",
  "markerIntent",
  "sectionProduction",
  "grooveIntent",
]);

export function isMutatingIntentRoute(route: RoutedIntent): boolean {
  return MUTATING_KINDS.has(route.kind);
}

export function noteIntentProposal(
  route: RoutedIntent,
  beforeDoc: ProjectDocument,
  afterDoc: ProjectDocument,
  undoDepthAfter: number,
): void {
  const ledger = activeReactionLedger();
  if (!ledger || !isMutatingIntentRoute(route)) return;
  const compact = compactIntentResponse(route);
  ledger.register({
    routeKind: route.kind,
    action: compact,
    trackIds: collectTrackIds(route),
    beforeHash: String(hashString(JSON.stringify(beforeDoc.tracks.map((track) => track.id)))),
    afterHash: String(hashString(JSON.stringify(afterDoc.tracks.map((track) => track.id)))),
    undoDepth: undoDepthAfter,
  });
}

function collectTrackIds(route: RoutedIntent): string[] {
  const routeAny = route as unknown as { intent?: { targets?: unknown }; ops?: unknown };
  const intent = routeAny.intent as { targets?: unknown } | undefined;
  if (intent && Array.isArray(intent.targets)) return intent.targets.map(String);
  if (Array.isArray(routeAny.ops)) {
    const ops = routeAny.ops as Array<Record<string, unknown>>;
    const targets = ops.map((op) => op.target).filter((target): target is string => typeof target === "string");
    if (targets.length > 0) return [...new Set(targets)];
  }
  return [];
}
