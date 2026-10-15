/**
 * REACTION LEDGER (F1) — what the human does with what the machine proposed.
 *
 * The Intent Engine's proposals flow through `store.execute()`, which the
 * style observer deliberately cannot see: a DAW must never learn from its own
 * output (see INTENT-REACTION-LISTENING-PLAN §0). The USER'S ANSWER is a
 * different signal, and nothing captured it until now. This module captures it.
 *
 * WHAT IS RECORDED, and the boundary that matters:
 *   { route kind, compact action, affected track IDS, before/after hashes,
 *     timings, outcome }
 *   NEVER: prompt text, audio, project names, track names, file paths, or any
 *   free-form string. `sanitizeAction` cannot represent prose at all — it maps
 *   a closed vocabulary onto a compact token string. That is deliberate: a
 *   privacy promise enforced by "we were careful at the call site" is not a
 *   privacy promise, and a pin test asserts a prompt string cannot survive a
 *   round trip through this module.
 *
 * OUTCOMES (the plan's three signals):
 *   kept    — 90 s passed with no undo, or the transport moved on
 *   undone  — the user undid exactly this action after the mash-guard window
 *   tweaked — after `kept`, a human edit touched the same tracks
 *
 * MASH GUARD: an undo within 5 s of the apply is not a considered reaction —
 * it is a frustrated key mash. Such an entry is DISCARDED, not marked `undone`
 * and not left to age into `kept`: recording it either way would teach the
 * wrong thing (the second way teaches "undoing quickly = kept").
 */

import { hashString } from "../shared/rng";

export const REACTION_LEDGER_VERSION = 1 as const;
export const REACTION_LEDGER_KEY = "pf:reaction-ledger";
/** How long a proposal stays "awaiting a reaction". */
export const REACTION_KEEP_WINDOW_MS = 90_000;
/** Undo inside this window after the apply = mash, not a verdict. */
export const REACTION_MASH_GUARD_MS = 5_000;
/** Bounded local history — reactions are frequent, and local-only. */
export const REACTION_LEDGER_CAP = 256;

export type ReactionOutcome = "pending" | "kept" | "undone" | "tweaked";

export interface ReactionEntry {
  id: string;
  createdAt: number;
  /** Which intent route produced the proposal ("paramIntent", "effectIntent"…). */
  routeKind: string;
  /** Compact, sanitised description — never prose. */
  action: string;
  /** Track ids only. No names. */
  trackIds: string[];
  beforeHash: string;
  afterHash: string;
  outcome: ReactionOutcome;
  resolvedAt: number | null;
}

export interface ReactionPackV1 {
  schemaVersion: typeof REACTION_LEDGER_VERSION;
  exportedAt: number;
  entries: ReactionEntry[];
}

export interface ReactionSummary {
  kept: number;
  undone: number;
  tweaked: number;
  pending: number;
  /** kept / (kept + undone + tweaked) — "how often a proposal survives". */
  keepRate: number;
  byRouteKind: Record<string, { kept: number; undone: number; tweaked: number }>;
}

/* ------------------------------------------------------------------ */
/* sanitising — the privacy boundary lives here, not at the call sites   */
/* ------------------------------------------------------------------ */

/**
 * Route kinds are the existing intent vocabulary and are camelCase
 * ("paramIntent", "effectIntent"), so the shape is a lowercase lead followed by
 * alphanumerics. That admits the real kinds and still refuses prose: no spaces,
 * no non-ASCII, no punctuation - "lower the vocal reverb mix" cannot be a
 * route kind.
 */
const ROUTE_KIND_RE = /^[a-z][A-Za-z0-9]{0,47}$/;
const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const HASH_RE = /^[a-f0-9]{1,16}$/;
const MAX_TRACK_IDS = 16;

/**
 * The closed vocabulary of action descriptors. A caller states WHAT changed
 * structurally; this module decides how it is written down. Adding a word here
 * is a deliberate, reviewable widening of what may be stored — which is the
 * point: the privacy surface is a diff you can read.
 */
const ACTION_VERBS = ["set", "adjust", "bypass", "add", "remove", "mix", "bpm", "generate", "arrange"] as const;
type ActionVerb = (typeof ACTION_VERBS)[number];

/** Kinds of value, not the value itself. A magnitude never enters the ledger. */
const ACTION_SUBJECTS = [
  "param",
  "effect",
  "trackGain",
  "trackPan",
  "sceneMix",
  "master",
  "tempo",
  "pattern",
  "clip",
  /** Scene structure — "make the bridge 8 bars" is about the arrangement, not a value. */
  "scene",
  "marker",
  "automation",
  "preset",
  "unknown",
] as const;
type ActionSubject = (typeof ACTION_SUBJECTS)[number];

export interface ReactionActionInput {
  verb?: string;
  subject?: string;
  /** TRUE for a relative change, FALSE for an absolute one. */
  relative?: boolean;
}

function sanitizeToken(value: unknown, allowed: readonly string[], fallback: string): string {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value : fallback;
}

/**
 * Render a compact action token. Unknown vocabulary degrades to
 * `adjust:unknown`, it never degrades to the caller's raw string — a
 * sanitiser that falls back to the input is not a sanitiser.
 */
export function sanitizeAction(input: unknown): string {
  const raw = (input ?? {}) as ReactionActionInput;
  const verb = sanitizeToken(raw.verb, ACTION_VERBS, "adjust") as ActionVerb;
  const subject = sanitizeToken(raw.subject, ACTION_SUBJECTS, "unknown") as ActionSubject;
  const form = raw.relative === true ? "rel" : "abs";
  return `${verb}:${subject}:${form}`;
}

export function sanitizeRouteKind(value: unknown): string {
  return typeof value === "string" && ROUTE_KIND_RE.test(value) ? value : "unknown";
}

export function sanitizeTrackIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id === "string" && ID_RE.test(id)) seen.add(id);
    if (seen.size >= MAX_TRACK_IDS) break;
  }
  return [...seen].sort();
}

export function sanitizeHash(value: unknown): string {
  return typeof value === "string" && HASH_RE.test(value) ? value : "";
}

/** Defensive parse for anything read back from storage. Never throws. */
export function sanitizeReactionEntry(value: unknown): ReactionEntry | null {
  if (value == null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) return null;
  const createdAt = Number(raw.createdAt);
  if (!Number.isFinite(createdAt)) return null;
  const outcome =
    raw.outcome === "kept" || raw.outcome === "undone" || raw.outcome === "tweaked" ? raw.outcome : "pending";
  const resolvedAt = Number(raw.resolvedAt);
  return {
    id: raw.id,
    createdAt,
    routeKind: sanitizeRouteKind(raw.routeKind),
    action: sanitizeAction({
      verb: String(raw.action ?? "").split(":")[0],
      subject: String(raw.action ?? "").split(":")[1],
      relative: String(raw.action ?? "").split(":")[2] === "rel",
    }),
    trackIds: sanitizeTrackIds(raw.trackIds),
    beforeHash: sanitizeHash(raw.beforeHash),
    afterHash: sanitizeHash(raw.afterHash),
    outcome,
    resolvedAt: Number.isFinite(resolvedAt) ? resolvedAt : null,
  };
}

export function sanitizeReactionPack(value: unknown): ReactionPackV1 | null {
  if (value == null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.entries)) return null;
  const entries = raw.entries.map(sanitizeReactionEntry).filter((entry): entry is ReactionEntry => entry !== null);
  const exportedAt = Number(raw.exportedAt);
  return {
    schemaVersion: REACTION_LEDGER_VERSION,
    exportedAt: Number.isFinite(exportedAt) ? exportedAt : 0,
    entries,
  };
}

/** Stable hash of a compact projection — reused for before/after pairing. */
export function hashReactionState(value: unknown): string {
  return hashString(JSON.stringify(value) ?? "")
    .toString(16)
    .padStart(8, "0");
}

/**
 * Ids of tracks whose state differs between two documents.
 *
 * Used to answer "did the human touch a track this proposal was about?". It
 * compares a JSON projection of each track rather than the objects themselves
 * so an equal-but-rebuilt track does not read as a change. O(tracks), and only
 * ever called from the human-edit path — never per frame.
 */
export function trackIdsChangedBetween(
  previous: { tracks?: readonly unknown[] } | null | undefined,
  next: { tracks?: readonly unknown[] } | null | undefined,
): string[] {
  const before = new Map<string, string>();
  for (const track of previous?.tracks ?? []) {
    const id = (track as { id?: unknown }).id;
    if (typeof id === "string") before.set(id, JSON.stringify(track) ?? "");
  }
  const changed: string[] = [];
  for (const track of next?.tracks ?? []) {
    const id = (track as { id?: unknown }).id;
    if (typeof id !== "string") continue;
    const now = JSON.stringify(track) ?? "";
    if (before.get(id) !== now) changed.push(id);
  }
  return changed;
}

/* ------------------------------------------------------------------ */
/* the ledger                                                           */
/* ------------------------------------------------------------------ */

export interface ReactionStorage {
  load(): Promise<ReactionEntry[]>;
  save(entries: readonly ReactionEntry[]): Promise<void>;
  clear(): Promise<void>;
}

export interface ReactionLedgerOptions {
  /** Injectable clock — the keep window and the mash guard are time-dependent. */
  now?: () => number;
  storage?: ReactionStorage | null;
  cap?: number;
  /** Random id source; injected so tests get stable ids. */
  newId?: () => string;
}

let idCounter = 0;
function defaultNewId(): string {
  idCounter += 1;
  const random = Math.floor(Math.random() * 0xffffffff).toString(16);
  return `rx-${Date.now().toString(36)}-${idCounter.toString(36)}-${random}`;
}

export interface RegisterInput {
  routeKind: unknown;
  action: unknown;
  trackIds: unknown;
  beforeHash: unknown;
  afterHash: unknown;
  /** Undo-stack depth right after the apply — identifies the action later. */
  undoDepth: number;
}

export class ReactionLedger {
  private readonly now: () => number;
  private readonly storage: ReactionStorage | null;
  private readonly cap: number;
  private readonly newId: () => string;
  /** Pending proposals, oldest first. */
  private pending: Array<ReactionEntry & { undoDepth: number }> = [];
  /** Resolved history, newest first, bounded by `cap`. */
  private history: ReactionEntry[] = [];

  constructor(options: ReactionLedgerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.storage = options.storage ?? null;
    this.cap = options.cap ?? REACTION_LEDGER_CAP;
    this.newId = options.newId ?? defaultNewId;
  }

  /**
   * Record a proposal that is now awaiting a reaction. Anything malformed is
   * dropped rather than half-recorded — a reaction with no route kind teaches
   * nothing and still costs storage.
   */
  register(input: RegisterInput): ReactionEntry | null {
    const routeKind = sanitizeRouteKind(input.routeKind);
    if (routeKind === "unknown") return null;
    const entry: ReactionEntry & { undoDepth: number } = {
      id: this.newId(),
      createdAt: this.now(),
      routeKind,
      action: sanitizeAction(input.action),
      trackIds: sanitizeTrackIds(input.trackIds),
      beforeHash: sanitizeHash(input.beforeHash),
      afterHash: sanitizeHash(input.afterHash),
      outcome: "pending",
      resolvedAt: null,
      undoDepth: input.undoDepth,
    };
    this.pending.push(entry);
    return stripDepth(entry);
  }

  /**
   * The store reverted one history entry. `depthAfterPop` is what identifies
   * WHICH proposal was undone: a proposal registered at depth N is undone when
   * the stack drops back to N.
   */
  noteUndo(depthAfterPop: number): ReactionEntry | null {
    this.sweep();
    const index = this.pending.findIndex((entry) => entry.undoDepth === depthAfterPop);
    if (index < 0) return null;
    const [entry] = this.pending.splice(index, 1);
    const age = this.now() - entry.createdAt;
    // Mash guard: reverted instantly = a frustrated keypress, not a verdict.
    // The entry is DISCARDED so it cannot later age into "kept".
    if (age < REACTION_MASH_GUARD_MS) return null;
    entry.outcome = "undone";
    entry.resolvedAt = this.now();
    this.pushHistory(stripDepth(entry));
    return stripDepth(entry);
  }

  /**
   * A human edit touched these tracks. If a proposal on them was already kept,
   * that is the correction pair F2 learns from (same contract as
   * style-correction-learning: before/after content hashes).
   */
  noteUserEdit(trackIds: readonly string[]): ReactionEntry | null {
    this.sweep();
    const touched = new Set(sanitizeTrackIds([...trackIds]));
    if (touched.size === 0) return null;
    const kept = this.history.find((entry) => entry.outcome === "kept" && entry.trackIds.some((id) => touched.has(id)));
    if (!kept) return null;
    kept.outcome = "tweaked";
    kept.resolvedAt = this.now();
    return { ...kept };
  }

  /** The transport played or moved on — an implicit "I heard it, keep it". */
  noteTransportProgress(): void {
    this.sweep();
    const now = this.now();
    const settled = this.pending.filter((entry) => now - entry.createdAt >= REACTION_MASH_GUARD_MS);
    this.pending = this.pending.filter((entry) => !settled.includes(entry));
    for (const entry of settled) {
      entry.outcome = "kept";
      entry.resolvedAt = now;
      this.pushHistory(stripDepth(entry));
    }
  }

  /** Age out proposals nobody answered. Call from any interval tick. */
  sweep(): void {
    const now = this.now();
    const remaining: Array<ReactionEntry & { undoDepth: number }> = [];
    for (const entry of this.pending) {
      if (now - entry.createdAt >= REACTION_KEEP_WINDOW_MS) {
        entry.outcome = "kept";
        entry.resolvedAt = now;
        this.pushHistory(stripDepth(entry));
      } else {
        remaining.push(entry);
      }
    }
    this.pending = remaining;
  }

  /** Pending + resolved, for the panel. */
  entries(): ReactionEntry[] {
    this.sweep();
    return [...this.pending.map(stripDepth), ...this.history];
  }

  pendingCount(): number {
    return this.pending.length;
  }

  summary(): ReactionSummary {
    this.sweep();
    const summary: ReactionSummary = {
      kept: 0,
      undone: 0,
      tweaked: 0,
      pending: this.pending.length,
      keepRate: 0,
      byRouteKind: {},
    };
    for (const entry of this.history) {
      if (entry.outcome === "kept") summary.kept += 1;
      else if (entry.outcome === "undone") summary.undone += 1;
      else if (entry.outcome === "tweaked") summary.tweaked += 1;
      const bucket = (summary.byRouteKind[entry.routeKind] ??= { kept: 0, undone: 0, tweaked: 0 });
      if (entry.outcome === "kept" || entry.outcome === "tweaked") bucket.kept += 1;
      else if (entry.outcome === "undone") bucket.undone += 1;
    }
    const decided = summary.kept + summary.undone + summary.tweaked;
    summary.keepRate = decided > 0 ? (summary.kept + summary.tweaked) / decided : 0;
    return summary;
  }

  exportPack(): ReactionPackV1 {
    return {
      schemaVersion: REACTION_LEDGER_VERSION,
      exportedAt: this.now(),
      entries: this.entries(),
    };
  }

  async clear(): Promise<void> {
    this.pending = [];
    this.history = [];
    await this.storage?.clear();
  }

  /** Replace the resolved history (reload from storage). Never throws. */
  async hydrate(): Promise<void> {
    if (!this.storage) return;
    try {
      const rows = await this.storage.load();
      this.history = rows
        .map(sanitizeReactionEntry)
        .filter((entry): entry is ReactionEntry => entry !== null && entry.outcome !== "pending")
        .slice(0, this.cap);
    } catch {
      // A blocked or corrupt store keeps the ledger empty rather than broken.
      this.history = [];
    }
  }

  private pushHistory(entry: ReactionEntry): void {
    this.history.unshift(entry);
    if (this.history.length > this.cap) this.history.length = this.cap;
    void this.storage?.save(this.history);
  }
}

function stripDepth(entry: ReactionEntry & { undoDepth?: number }): ReactionEntry {
  const { undoDepth: _ignored, ...rest } = entry;
  return rest;
}

/* ------------------------------------------------------------------ */
/* opt-in flag + module singleton                                       */
/* ------------------------------------------------------------------ */

/** Default ON (the plan's opt-in is the kill switch). Reads tolerate a blocked store. */
export function isReactionLedgerEnabled(): boolean {
  try {
    return localStorage.getItem(REACTION_LEDGER_KEY) !== "off";
  } catch {
    return false;
  }
}

export function setReactionLedgerEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(REACTION_LEDGER_KEY, enabled ? "on" : "off");
  } catch {
    /* reaction learning safely becomes unavailable when storage is blocked */
  }
}

let activeLedger: ReactionLedger | null = null;

/** The wired ledger. Registering is a no-op while the flag is off. */
export function activeReactionLedger(): ReactionLedger | null {
  if (!isReactionLedgerEnabled()) return null;
  activeLedger ??= new ReactionLedger({ storage: null });
  return activeLedger;
}

/** Test/boot seam: install or clear the process-wide ledger. */
export function setActiveReactionLedger(ledger: ReactionLedger | null): void {
  activeLedger = ledger;
}
