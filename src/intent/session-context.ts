/**
 * SESSION CONTEXT (vibe-code wave 2): the last generation stays
 * addressable — "that one, but darker" refers to candidate #2 of the
 * previous prompt instead of starting over. Plus a capped prompt history
 * for the UI strip.
 *
 * Module-level store (like the favorites ledger, but session-scoped and
 * NOT persisted — a reload legitimately forgets the working context).
 * The IntentPanel remembers after every generation and resolves
 * referential prompts through resolveSessionReference.
 */
import type { Command } from "../commands/types";
import { snapshot } from "../commands/commands";
import type { Pattern, ProjectDocument } from "../project-model/types";
import type { IntentInput, IntentSpec } from "./types";

export interface SessionCandidate {
  index: number;
  pattern: Pattern;
  intent: IntentSpec;
}

export interface SessionGeneration {
  /** The prompt that produced it. */
  text: string;
  intent: IntentInput;
  candidates: SessionCandidate[];
  /** Which candidate the user applied (null = audition only). */
  appliedIndex: number | null;
  docId: string;
  at: number;
}

export interface PromptHistoryEntry {
  text: string;
  at: number;
}

const HISTORY_CAP = 24;
let last: SessionGeneration | null = null;
const history: PromptHistoryEntry[] = [];

export function rememberGeneration(generation: SessionGeneration): void {
  last = generation;
}

export function lastGeneration(): SessionGeneration | null {
  return last;
}

export function rememberPrompt(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const at = Date.now();
  const duplicate = history.find((entry) => entry.text === trimmed);
  if (duplicate) {
    duplicate.at = at;
    return;
  }
  history.push({ text: trimmed, at });
  if (history.length > HISTORY_CAP) history.shift();
}

export function promptHistory(): PromptHistoryEntry[] {
  return [...history].sort((a, b) => b.at - a.at);
}

/** Ordinals (EN + SK, de-accented) → 0-based candidate index. */
const ORDINALS: ReadonlyArray<readonly [string, number]> = [
  ["first", 0],
  ["prvy", 0],
  ["second", 1],
  ["druhy", 1],
  ["third", 2],
  ["treti", 2],
  ["fourth", 3],
  ["stvrty", 3],
];

const DETERMINERS = new Set(["that", "the", "ten", "ta", "to"]);
const NOUNS = new Set(["one", "klip", "beat", "verzia", "version", "cand"]);

export interface SessionReference {
  /** 0-based candidate index in the last generation. */
  index: number;
  /** The prompt MINUS the reference phrase — re-parses downstream. */
  rest: string;
}

/**
 * Resolve a referential phrase — "that second one, darker" / "ten tretí ale
 * tvrdší" — against the last generation. Word-token based: a determiner
 * (optional) + ordinal + optional noun forms the consumed phrase. Returns
 * null when there is no reference, no candidates, or the ordinal points
 * past the bank.
 */
export function resolveSessionReference(text: string, candidates: SessionCandidate[]): SessionReference | null {
  if (candidates.length === 0) return null;
  const fold = (word: string) =>
    word
      .toLowerCase()
      .normalize("NFD")
      .replace(/[^a-z0-9 #]/g, "");
  const words = text.replace(/[\s,.]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const folded = words.map(fold);

  const findReference = (): { index: number; start: number; end: number } | null => {
    for (let i = 0; i < folded.length; i++) {
      const ordinal = ORDINALS.find(([word]) => folded[i] === word);
      if (!ordinal) continue;
      if (ordinal[1] >= candidates.length) return null;
      const start = i > 0 && DETERMINERS.has(folded[i - 1] ?? "") ? i - 1 : i;
      const end = NOUNS.has(folded[i + 1] ?? "") ? i + 1 : i;
      return { index: ordinal[1], start, end };
    }
    for (let i = 0; i < folded.length - 1; i++) {
      if (DETERMINERS.has(folded[i]) && (folded[i + 1] === "one" || folded[i + 1] === "to")) {
        return candidates.length > 0 ? { index: 0, start: i, end: i + 1 } : null;
      }
    }
    return null;
  };

  const hit = findReference();
  if (!hit) return null;
  const consumed = new Set(words.slice(hit.start, hit.end + 1).map((w) => w.toLowerCase()));
  const rest = words.filter((w) => !consumed.has(w.toLowerCase())).join(" ");
  return { index: hit.index, rest };
}

/**
 * Re-apply a candidate pattern from the last generation: if the pattern id
 * still exists in the doc (applied earlier, undo still in history) it just
 * becomes active again; otherwise it is appended and activated. ONE
 * undoable snapshot either way.
 */
export function applySessionCandidateCommand(doc: ProjectDocument, pattern: Pattern): Command {
  const exists = doc.patterns.some((p) => p.id === pattern.id);
  const next: ProjectDocument = exists
    ? { ...doc, activePatternId: pattern.id }
    : { ...doc, patterns: [...doc.patterns, pattern], activePatternId: pattern.id };
  return snapshot("applySessionCandidate", exists ? "Re-apply candidate" : "Re-apply candidate (re-added)", doc, next);
}
