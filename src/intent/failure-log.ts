/**
 * INTENT FAILURE MINING — a local ring-buffer log of what the intent engine
 * could NOT resolve on its own (2026-10-01, the v30-activation follow-up).
 *
 * Why: the SFT corpus grew from ENGINEER-GUESSED phrases. Every clarify the
 * panel shows and every model-miss that falls through to generation is a
 * real producer sentence the deterministic layer + model both failed on —
 * exactly the rows the next corpus round needs. This module records them
 * with zero UI cost so mining replaces guessing.
 *
 * Etiquette:
 *  - LOCAL ONLY. The log never leaves the machine (no network, no telemetry
 *    endpoint); export is an explicit console action by the user.
 *  - Bounded. One localStorage key, ≤200 events, prompts capped at 280
 *    chars, consecutive duplicates collapse into a count — storage is a few
 *    dozen KB worst case.
 *  - Defensive. Storage is user-tamperable: every parse is guarded and every
 *    entry re-validated on read (the favorites-ledger pattern).
 *
 * Console workflow (the devtools hook installs `window.__kyxIntentFailures`):
 *   __kyxIntentFailures.read()     // the raw events
 *   __kyxIntentFailures.export()   // copy-paste JSON for the corpus round
 *   __kyxIntentFailures.clear()    // wipe after mining
 */

export const INTENT_FAILURE_LOG_KEY = "pf:intent-failures-v1";
export const INTENT_FAILURE_LOG_CAP = 200;
const PROMPT_CAP = 280;

export type IntentMiningOutcome = "clarify" | "clarify-picked" | "model-miss" | "model-hit";

export interface IntentMiningEvent {
  /** Wall clock (Date.now()) — oldest first. */
  ts: number;
  /** The producer's raw instruction (capped at 280 chars). */
  prompt: string;
  outcome: IntentMiningOutcome;
  /** Clarify reason shown to the user. */
  reason?: string;
  /** Which suggestion chip the user picked (outcome "clarify-picked"). */
  pickedSuggestion?: string;
  /** The adapted route kind the model produced (outcome "model-hit"). */
  routeKind?: string;
  /** Consecutive repeats collapse into one event with count>1. */
  count?: number;
}

const OUTCOMES: ReadonlySet<string> = new Set(["clarify", "clarify-picked", "model-miss", "model-hit"]);

function isValidEvent(value: unknown): value is IntentMiningEvent {
  if (value == null || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.ts === "number" &&
    Number.isFinite(event.ts) &&
    typeof event.prompt === "string" &&
    typeof event.outcome === "string" &&
    OUTCOMES.has(event.outcome) &&
    (event.reason === undefined || typeof event.reason === "string") &&
    (event.pickedSuggestion === undefined || typeof event.pickedSuggestion === "string") &&
    (event.routeKind === undefined || typeof event.routeKind === "string") &&
    (event.count === undefined || (typeof event.count === "number" && event.count >= 1))
  );
}

function safeRead(): IntentMiningEvent[] {
  try {
    const raw = localStorage.getItem(INTENT_FAILURE_LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidEvent);
  } catch {
    return [];
  }
}

function safeWrite(events: IntentMiningEvent[]): void {
  try {
    localStorage.setItem(INTENT_FAILURE_LOG_KEY, JSON.stringify(events));
  } catch {
    /* quota/blocked — the log is best-effort */
  }
}

/**
 * Record one mining event. Consecutive identical (prompt, outcome) events
 * collapse into the last entry with an incremented count — a producer
 * re-sending the same misunderstood ask is ONE mining row with a weight,
 * not log spam. FIFO-capped at {@link INTENT_FAILURE_LOG_CAP}.
 */
export function logIntentMiningEvent(event: Omit<IntentMiningEvent, "ts" | "count">): void {
  const prompt = event.prompt.slice(0, PROMPT_CAP);
  const events = safeRead();
  const last = events[events.length - 1];
  if (last && last.prompt === prompt && last.outcome === event.outcome && last.reason === event.reason) {
    last.ts = Date.now();
    last.count = (last.count ?? 1) + 1;
    safeWrite(events);
    return;
  }
  events.push({ ...event, prompt, ts: Date.now(), count: 1 });
  while (events.length > INTENT_FAILURE_LOG_CAP) events.shift();
  safeWrite(events);
}

export function readIntentMiningLog(): IntentMiningEvent[] {
  return safeRead();
}

export function clearIntentMiningLog(): void {
  try {
    localStorage.removeItem(INTENT_FAILURE_LOG_KEY);
  } catch {
    /* no-op */
  }
}

/** The corpus-round artifact: everything above as a stable JSON string. */
export function exportIntentMiningLog(): string {
  return JSON.stringify({ version: 1, exportedAt: Date.now(), events: safeRead() }, null, 2);
}

/**
 * Console surface for the producer/miner: installs `window.__kyxIntentFailures`
 * with read/export/clear. Idempotent; assigns a plain object (no eval, no
 * HTML — just a debug handle). Called from the IntentPanel mount.
 */
export function installIntentFailureDevtools(): void {
  try {
    (window as unknown as Record<string, unknown>).__kyxIntentFailures = {
      read: readIntentMiningLog,
      export: exportIntentMiningLog,
      clear: clearIntentMiningLog,
    };
  } catch {
    /* no window (tests/node) — the functions stay importable */
  }
}
