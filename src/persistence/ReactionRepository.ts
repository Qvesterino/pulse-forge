import { openDb, STORE_REACTIONS, tx } from "./db";
import {
  REACTION_LEDGER_CAP,
  sanitizeReactionEntry,
  type ReactionEntry,
  type ReactionStorage,
} from "../intent/reaction-ledger";

/**
 * Durable side of the Reaction Ledger. Local-only by construction: the ledger
 * never leaves this machine, and there is no network path in this file.
 *
 * The ledger writes the WHOLE bounded history on each resolution rather than
 * one row per event. Reactions are low-frequency (one per proposal the human
 * actually answered), the history is capped at 256, and a rewrite keeps the
 * privacy story simple: whatever is in this store is exactly what the export
 * button will hand over, because both read the same sanitised array.
 */

/** Storage adapter for `ReactionLedger`. Never throws — a blocked store stays empty. */
export const reactionStorage: ReactionStorage = {
  async load(): Promise<ReactionEntry[]> {
    try {
      const db = await openDb();
      const rows = await tx<unknown[]>(db, STORE_REACTIONS, "readonly", (store) => store.getAll());
      return rows
        .map(sanitizeReactionEntry)
        .filter((entry): entry is ReactionEntry => entry !== null)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, REACTION_LEDGER_CAP);
    } catch {
      return [];
    }
  },
  async save(entries: readonly ReactionEntry[]): Promise<void> {
    try {
      const db = await openDb();
      await tx(db, STORE_REACTIONS, "readwrite", (store) => {
        store.clear();
        for (const entry of entries) {
          const safe = sanitizeReactionEntry(entry);
          if (safe) store.put(safe);
        }
      });
    } catch {
      // Storage unavailable: the ledger keeps working in memory for this session.
    }
  },
  async clear(): Promise<void> {
    try {
      const db = await openDb();
      await tx(db, STORE_REACTIONS, "readwrite", (store) => store.clear());
    } catch {
      /* nothing to clear when the store never opened */
    }
  },
};

/** Read the stored reactions without constructing a ledger (panel + tests). */
export async function listStoredReactions(): Promise<ReactionEntry[]> {
  return reactionStorage.load();
}