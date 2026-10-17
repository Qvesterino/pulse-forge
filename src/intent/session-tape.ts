/**
 * SESSION TAPE — from one-shot prompts to jamming.
 *
 * The panel could always re-run a prompt ("RECENT"), but a re-run is a fresh
 * roll, not a return: nothing recorded what a step DID, and nothing could take
 * you back to the state before it. The tape is that missing journal: an
 * ordered, bounded record of the session's intent steps — prompt, outcome,
 * what it applied, and the undo depth it settled at — with a REWIND that uses
 * the store's own `jumpTo` (Cubase-style history jump), so going back is exact
 * and itself redoable.
 *
 * ── Why this is NOT the reaction ledger ─────────────────────────────────────
 * The reaction ledger is LEARNING data and is prose-free by construction (no
 * prompt text, ever). The tape is the opposite kind of object: the user's own
 * local journal, which is why it may hold prompts. The boundary is enforced by
 * what it is used for, not by hope: `tapeSteps()` feeds a UI strip and the
 * rewind; nothing here is exported, trained on, or attached to MCP payloads.
 * It is persisted (bounded, local-only) because a journal that dies with a
 * panel toggle is not a journal; the session CONTEXT (`session-context.ts`)
 * stays deliberately in-memory where it belongs.
 *
 * ── Rewind semantics, stated honestly ───────────────────────────────────────
 * A step records the undo-stack length AFTER its command, so rewinding to it
 * means "the state as this step left it" = `jumpTo(length - 1)`. The stack is
 * pruned, so a step older than the retained window can no longer be reached —
 * the tape REFUSES with the reason instead of silently landing somewhere else.
 * Rewinding detaches every later step (marked `abandoned`) because the branch
 * they ran on is no longer the current one.
 */
import type { ProjectDocument } from "../project-model/types";

export const SESSION_TAPE_KEY = "pf:session-tape-v1";
export const SESSION_TAPE_CAP = 40;
export const SESSION_TAPE_PROMPT_MAX = 240;
export const SESSION_TAPE_DETAIL_MAX = 120;
export const SESSION_TAPE_RATIONALE_MAX = 280;

export type TapeOutcome = "applied" | "applied-candidate" | "generated" | "clarify" | "failed";

export interface TapeStep {
  id: string;
  at: number;
  docId: string;
  /** The user's own prompt (local journal — never exported, never trained on). */
  prompt: string;
  outcome: TapeOutcome;
  routeKind: string;
  action: string;
  /** Extra honest context ("3 candidates", a clarify reason, an error message). */
  detail?: string;
  /**
   * The MEASURED reason the step turned out the way it did (the E1 selection
   * rationale), recorded at the call site where it exists. The session story
   * prints it or prints NOTHING about why — never filler prose.
   */
  rationale?: string;
  /** Undo-stack length AFTER this step's command; null = nothing applied. */
  undoDepthAfter: number | null;
  generationId?: string;
  candidateIndex?: number;
  /** Detached from the current branch by a later rewind. */
  abandoned: boolean;
}

export interface RecordTapeStepInput {
  doc: Pick<ProjectDocument, "id">;
  prompt: string;
  outcome: TapeOutcome;
  routeKind: string;
  action: string;
  detail?: string;
  rationale?: string;
  undoDepthAfter: number | null;
  generationId?: string;
  candidateIndex?: number;
  /** Injectable clock for deterministic tests. */
  at?: number;
}

let steps: TapeStep[] = [];
let nextId = 1;
let revision = 0;
let loaded = false;
const listeners = new Set<() => void>();

function boundedText(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function isTapeOutcome(value: unknown): value is TapeOutcome {
  return (
    value === "applied" ||
    value === "applied-candidate" ||
    value === "generated" ||
    value === "clarify" ||
    value === "failed"
  );
}

function sanitizeStep(value: unknown): TapeStep | null {
  if (value == null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id === "") return null;
  const at = Number(raw.at);
  if (!Number.isFinite(at)) return null;
  if (!isTapeOutcome(raw.outcome)) return null;
  const undoDepthAfter = Number(raw.undoDepthAfter);
  return {
    id: raw.id,
    at,
    docId: boundedText(raw.docId, 64),
    prompt: boundedText(raw.prompt, SESSION_TAPE_PROMPT_MAX),
    outcome: raw.outcome,
    routeKind: boundedText(raw.routeKind, 48),
    action: boundedText(raw.action, 64),
    ...(raw.detail !== undefined ? { detail: boundedText(raw.detail, SESSION_TAPE_DETAIL_MAX) } : {}),
    ...(raw.rationale !== undefined ? { rationale: boundedText(raw.rationale, SESSION_TAPE_RATIONALE_MAX) } : {}),
    undoDepthAfter: Number.isFinite(undoDepthAfter) && undoDepthAfter >= 0 ? Math.floor(undoDepthAfter) : null,
    ...(typeof raw.generationId === "string" ? { generationId: boundedText(raw.generationId, 64) } : {}),
    ...(typeof raw.candidateIndex === "number" && Number.isInteger(raw.candidateIndex) && raw.candidateIndex >= 0
      ? { candidateIndex: raw.candidateIndex }
      : {}),
    abandoned: raw.abandoned === true,
  };
}

function safeRead(): TapeStep[] {
  try {
    const raw = localStorage.getItem(SESSION_TAPE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizeStep).filter((step): step is TapeStep => step !== null);
  } catch {
    return [];
  }
}

function safeWrite(list: readonly TapeStep[]): void {
  try {
    localStorage.setItem(SESSION_TAPE_KEY, JSON.stringify(list.slice(-SESSION_TAPE_CAP)));
  } catch {
    /* quota/blocked — the tape keeps working in memory for this session */
  }
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  const stored = safeRead();
  if (stored.length > 0) {
    for (const step of stored) {
      const numeric = Number.parseInt(step.id.replace(/^tape-/, ""), 10);
      if (Number.isFinite(numeric)) nextId = Math.max(nextId, numeric + 1);
    }
    steps = stored.slice(-SESSION_TAPE_CAP);
  }
}

function notify(): void {
  revision += 1;
  for (const listener of [...listeners]) listener();
}

/** Append one step. Returns the stored step. Never throws. */
export function recordTapeStep(input: RecordTapeStepInput): TapeStep {
  ensureLoaded();
  const step: TapeStep = {
    id: `tape-${nextId}`,
    at: input.at ?? Date.now(),
    docId: boundedText(input.doc.id, 64),
    prompt: boundedText(input.prompt.trim(), SESSION_TAPE_PROMPT_MAX),
    outcome: input.outcome,
    routeKind: boundedText(input.routeKind, 48),
    action: boundedText(input.action, 64),
    ...(input.detail !== undefined ? { detail: boundedText(input.detail, SESSION_TAPE_DETAIL_MAX) } : {}),
    ...(input.rationale !== undefined ? { rationale: boundedText(input.rationale, SESSION_TAPE_RATIONALE_MAX) } : {}),
    undoDepthAfter: input.undoDepthAfter,
    ...(input.generationId !== undefined ? { generationId: input.generationId } : {}),
    ...(input.candidateIndex !== undefined ? { candidateIndex: input.candidateIndex } : {}),
    abandoned: false,
  };
  nextId += 1;
  steps = [...steps, step];
  while (steps.length > SESSION_TAPE_CAP) steps.shift();
  safeWrite(steps);
  notify();
  return step;
}

/** Newest first — the order the UI renders. */
export function tapeSteps(): TapeStep[] {
  ensureLoaded();
  return [...steps].reverse();
}

/** Monotonic revision, for React consumers that re-render on change. */
export function tapeTick(): number {
  return revision;
}

export function tapeSubscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export type RewindTarget = { index: number } | { refusal: string };

/**
 * Where `jumpTo` must land to restore the state this step left behind.
 * Pure: the caller passes the CURRENT undo length so the check is honest about
 * the retained window rather than guessing.
 */
export function rewindTargetFor(step: TapeStep, currentUndoLength: number): RewindTarget {
  if (step.undoDepthAfter == null) {
    return { refusal: "This step applied nothing — there is no state to return to." };
  }
  const index = step.undoDepthAfter - 1;
  if (index < 0) {
    return { refusal: "This step is the very first state — nothing to rewind." };
  }
  if (index >= currentUndoLength) {
    return { refusal: "The undo window no longer reaches this step (it has been pruned) — re-run the prompt instead." };
  }
  return { index };
}

/**
 * Mark every step NEWER than `stepId` as abandoned (detached from the current
 * branch). Returns how many were marked. Pure bookkeeping — the undo/redo
 * stacks themselves are the source of truth.
 */
export function markTapeAbandonedAfter(stepId: string): number {
  ensureLoaded();
  const index = steps.findIndex((step) => step.id === stepId);
  if (index < 0) return 0;
  let marked = 0;
  steps = steps.map((step, position) => {
    if (position <= index || step.abandoned) return step;
    marked += 1;
    return { ...step, abandoned: true };
  });
  if (marked > 0) {
    safeWrite(steps);
    notify();
  }
  return marked;
}

export function clearTape(): void {
  steps = [];
  try {
    localStorage.removeItem(SESSION_TAPE_KEY);
  } catch {
    /* storage unavailable */
  }
  notify();
}

/** Test/teardown hook — the tape is per-window by design. */
export function resetTapeForTests(): void {
  steps = [];
  nextId = 1;
  revision = 0;
  loaded = false;
  listeners.clear();
}
