/**
 * F1 GLUE (docs/INTENT-REACTION-LISTENING-PLAN.md) — the one-call bridge
 * between the intent dispatch sites and the Reaction Ledger.
 *
 * Call AFTER `store.execute(command)` for any intent-applied action:
 * the helper registers the proposal (route kind, compact sanitized action,
 * affected track ids, before/after state hashes, undo-stack depth). The
 * ledger's own hooks then resolve keep/undo/tweak — nothing else to wire.
 *
 * A disabled ledger or a non-intent route is a silent no-op. NEVER throws.
 *
 * ── Two measured defects this file exists to prevent ────────────────────────
 * Both were live in the first version of this bridge, and both made the ledger
 * write rows that could not teach F2 anything:
 *
 *  1. THE ACTION COLUMN WAS CONSTANT. `compactIntentResponse(route)` returns
 *     `{kind: …}` — an envelope — while `sanitizeAction` takes
 *     `{verb, subject, relative}`. Every single row therefore degraded to
 *     `adjust:unknown:abs`, whatever the user actually asked for.
 *
 *  2. THE CORRECTION PAIR WAS VACUOUS. The hashes were taken over
 *     `doc.tracks.map(t => t.id)` — the track-id LIST, which a parameter
 *     change does not alter. beforeHash === afterHash on every proposal, so
 *     the "what the machine did / what the human did instead" pair F2 learns
 *     from was empty by construction.
 *
 * A third defect is fixed here because it is the same class of error — a field
 * documented as one thing and carrying another: `trackIds` is documented as
 * document track ids, but the routes that carry ids carry FAMILY tokens
 * (`FaderIntent.targets` is `FaderTarget[]` — "drums" | "bass" | "lead" …,
 * and `ExactOp.target` is the same). Those never match a document track id,
 * so `noteUserEdit` could never fire and the `tweaked` outcome was unreachable
 * in production. Families are now filtered against the real document, and a
 * route that names only families falls back to the before/after DIFF — the
 * information that is actually being recorded, not a guess at the parse.
 */
import type { ProjectDocument, Track } from "../project-model/types";
import type { RoutedIntent } from "./route";
import { activeReactionLedger, hashReactionState, trackIdsChangedBetween } from "./reaction-ledger";
import type { ReactionActionInput } from "./reaction-ledger";

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

/**
 * Register one proposal.
 *
 * `undoDepthBeforeApply` — NOT the depth after the command. The ledger matches
 * an undo by the depth the stack SETTLES at: stack at L, apply pushes one
 * command (L+1), the human undoes, the store fires `onUndoCommitted(L)`. So
 * the value that identifies this proposal is L — the depth read BEFORE the
 * command ran. Passing L+1 (the depth after) can never match, and `undone`
 * silently becomes unreachable: the ledger looks healthy because every row
 * still resolves to `kept`.
 *
 * Call this AFTER the command has run, with the document from before it.
 */
export function noteIntentProposal(
  route: RoutedIntent,
  beforeDoc: ProjectDocument,
  afterDoc: ProjectDocument,
  undoDepthBeforeApply: number,
): void {
  const ledger = activeReactionLedger();
  if (!ledger || !isMutatingIntentRoute(route)) return;

  const trackIds = affectedTrackIds(route, beforeDoc, afterDoc);
  const beforeHash = hashReactionState(proposalState(beforeDoc, trackIds));
  const afterHash = hashReactionState(proposalState(afterDoc, trackIds));

  // POSTCONDITION. A route that changed nothing is not a proposal — it is a
  // no-op command, a query, or a re-ask that landed on the current value.
  // Registering it would teach "kept" for a machine action the user never
  // heard, and would keep the ledger's keep-rate honest only by accident.
  if (beforeHash === afterHash) return;

  ledger.register({
    routeKind: route.kind,
    action: describeIntentAction(route),
    trackIds,
    beforeHash,
    afterHash,
    undoDepth: undoDepthBeforeApply,
  });
}

/* ------------------------------------------------------------------ */
/* the action column                                                    */
/* ------------------------------------------------------------------ */

type RouteRecord = Record<string, unknown>;
type Direction = { verb?: string; subject?: string; relative: boolean };

/**
 * Describe the proposal in the ledger's closed vocabulary.
 *
 * Deterministic and field-driven: `direction: "up" | "set"` really is the
 * relative/absolute signal, so the form token is a fact about the parse, not
 * a guess. Anything this function cannot name honestly degrades to
 * `adjust:unknown` inside `sanitizeAction` — never to a raw string.
 */
export function describeIntentAction(route: RoutedIntent): ReactionActionInput {
  const record = route as unknown as RouteRecord;
  switch (route.kind) {
    case "fader": {
      const intent = (record.intent ?? {}) as RouteRecord;
      const targets = Array.isArray(intent.targets) ? intent.targets.map(String) : [];
      const direction = typeof intent.direction === "string" ? intent.direction : "up";
      return {
        verb: direction === "set" ? "set" : "adjust",
        subject: targets.includes("master") ? "master" : "trackGain",
        relative: direction !== "set",
      };
    }
    case "tempo": {
      const intent = (record.intent ?? {}) as RouteRecord;
      const direction = typeof intent.direction === "string" ? intent.direction : "set";
      return { verb: direction === "set" ? "bpm" : "adjust", subject: "tempo", relative: direction !== "set" };
    }
    case "paramIntent": {
      const intent = (record.intent ?? {}) as RouteRecord;
      const mode = typeof intent.mode === "string" ? intent.mode : "more";
      return { verb: mode === "set" ? "set" : "adjust", subject: "param", relative: mode !== "set" };
    }
    case "effectIntent":
    case "sendIntent":
      return effectDirection((record.intent ?? {}) as RouteRecord);
    case "bypassIntent":
      return { verb: "bypass", subject: "effect", relative: false };
    case "mix":
      return { verb: "mix", subject: "sceneMix", relative: true };
    case "loudness": {
      const parse = (record.parse ?? {}) as RouteRecord;
      const detected = Array.isArray(parse.detected) ? parse.detected : [];
      return {
        verb: "adjust",
        subject: detected.length > 0 ? "trackGain" : "master",
        relative: parse.targetDb == null,
      };
    }
    case "preset":
      return { verb: "set", subject: "preset", relative: false };
    case "markerIntent": {
      const intent = (record.intent ?? {}) as RouteRecord;
      const action = typeof intent.action === "string" ? intent.action : "add";
      return { verb: action === "remove" ? "remove" : "add", subject: "marker", relative: false };
    }
    case "grooveIntent": {
      const intent = (record.intent ?? {}) as RouteRecord;
      const direction = typeof intent.direction === "string" ? intent.direction : "set";
      return { verb: direction === "set" ? "set" : "adjust", subject: "param", relative: direction !== "set" };
    }
    case "arrange":
      return { verb: "arrange", subject: "scene", relative: false };
    case "clips":
    case "selectedClipArrange":
      return { verb: "arrange", subject: "clip", relative: false };
    case "exact":
      return exactAction((record.plan ?? {}) as RouteRecord);
    case "production":
    case "sectionProduction":
      return { verb: "generate", subject: "pattern", relative: false };
    case "revise":
      return { verb: "generate", subject: "pattern", relative: false };
    default:
      // queryIntent / undoIntent / complaintIntent carry no mutating subject.
      // `adjust:unknown` is the honest degradation; the no-op postcondition in
      // noteIntentProposal drops whatever did not actually change.
      return {};
  }
}

function effectDirection(intent: RouteRecord): Direction {
  const direction = typeof intent.direction === "string" ? intent.direction : "more";
  if (direction === "remove") return { verb: "remove", subject: "effect", relative: false };
  if (direction === "set") return { verb: "set", subject: "effect", relative: false };
  return { verb: "adjust", subject: "effect", relative: true };
}

/**
 * An exact plan is a bag of heterogeneous ops ("mute the bass", "add a track").
 * Report the subject only when EVERY op agrees on it — a mixed plan is
 * `adjust:unknown` rather than whichever op happened to be read last.
 */
function exactAction(plan: RouteRecord): ReactionActionInput {
  const ops = Array.isArray(plan.ops) ? (plan.ops as RouteRecord[]) : [];
  if (ops.length === 0) return {};
  const subjects = new Set<string>();
  const forms = new Set<boolean>();
  for (const op of ops) {
    const described = describeExactOp(op);
    subjects.add(described.subject);
    forms.add(described.relative);
  }
  if (subjects.size !== 1) return {};
  const relative = forms.has(true);
  // A relative op inside an otherwise absolute plan is still a relative
  // change: "lower the drums by 3 db" carries a delta, not a target.
  return { verb: relative ? "adjust" : "set", subject: [...subjects][0], relative };
}

function describeExactOp(op: RouteRecord): { subject: string; relative: boolean } {
  const kind = typeof op.kind === "string" ? op.kind : "";
  switch (kind) {
    case "gainDb":
      return { subject: "trackGain", relative: true };
    case "gainDbAbsolute":
      return { subject: "trackGain", relative: false };
    case "pan":
      return { subject: "trackPan", relative: false };
    case "mute":
    case "solo":
      return { subject: "trackGain", relative: false };
    case "swing":
      return { subject: "param", relative: false };
    case "patternLengthDelta":
      return { subject: "pattern", relative: true };
    case "patternLength":
    case "transpose":
      return { subject: "pattern", relative: false };
    default:
      // addTrack / removeTrack / renameTrack / duplicateTrack / key change:
      // real mutations the closed vocabulary has no honest word for.
      return { subject: "unknown", relative: false };
  }
}

/* ------------------------------------------------------------------ */
/* affected tracks + the state pair                                    */
/* ------------------------------------------------------------------ */

/**
 * Document track ids this proposal is about.
 *
 * Route-supplied ids are accepted only when they RESOLVE in the document; the
 * family tokens ("drums", "lead", …) the parsers use are not ids and must never
 * reach a field the ledger matches edits against. When the route names only
 * families — which is the common case for fader/effect/param asks — the
 * before/after diff is the authoritative answer.
 */
function affectedTrackIds(route: RoutedIntent, beforeDoc: ProjectDocument, afterDoc: ProjectDocument): string[] {
  const known = new Set<string>();
  for (const track of beforeDoc.tracks) known.add(track.id);
  for (const track of afterDoc.tracks) known.add(track.id);
  const declared = routeDeclaredIds(route).filter((id) => known.has(id));
  if (declared.length > 0) return [...new Set(declared)].sort();
  return [...new Set(trackIdsChangedBetween(beforeDoc, afterDoc))].sort();
}

/** Candidate ids from the route — validated against the document by the caller. */
function routeDeclaredIds(route: RoutedIntent): string[] {
  const record = route as unknown as RouteRecord;
  const intent = (record.intent ?? {}) as RouteRecord;
  const out: string[] = [];
  if (Array.isArray(intent.trackIds)) out.push(...intent.trackIds.map(String));
  const plan = (record.plan ?? {}) as RouteRecord;
  const ops = (record.ops ?? plan.ops) as unknown;
  if (Array.isArray(ops)) {
    for (const op of ops) {
      const target = (op as RouteRecord)?.target;
      if (typeof target === "string") out.push(target);
    }
  }
  return out;
}

/**
 * String values that survive into the hash.
 *
 * Everything else that is a string is replaced by a marker: track names, pad
 * names, MIDI device names, marker labels and clip titles are the USER's text,
 * and the ledger's promise is that none of it is recorded. Only closed
 * code-owned enumerations are kept — they are what makes a reverb change
 * distinguishable from a delay change.
 */
const SAFE_STRING_KEYS: ReadonlySet<string> = new Set(["kind", "type", "instrument", "macro"]);
const DROPPED_STRING = "~";

function projectState(value: unknown, key: string): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : 0;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return SAFE_STRING_KEYS.has(key) ? value : DROPPED_STRING;
  if (Array.isArray(value)) return value.map((item) => projectState(item, key));
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const projected: Record<string, unknown> = {};
    for (const objectKey of Object.keys(object).sort())
      projected[objectKey] = projectState(object[objectKey], objectKey);
    return projected;
  }
  return null;
}

/**
 * The state this proposal is ABOUT. Scoped to the affected tracks; the
 * project-wide mix slice travels with it so a tempo or master change — which
 * touches no track — still has a before and an after that differ.
 */
function proposalState(doc: ProjectDocument, trackIds: readonly string[]): unknown {
  const wanted = new Set(trackIds);
  const tracks: Track[] = trackIds.length > 0 ? doc.tracks.filter((track) => wanted.has(track.id)) : [];
  return projectState(
    {
      scope: tracks.length > 0 ? "tracks" : "project",
      tracks,
      bpm: doc.bpm,
      master: doc.master,
      returns: doc.returns,
      markers: doc.markers,
      scenes: tracks.length > 0 ? [] : doc.scenes,
    },
    "",
  );
}
