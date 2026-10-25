import type { Services } from "../services";

/**
 * The document revision, when the store has one (ADR 0065).
 *
 * The local `ProjectStore` counts every applied change; the Yjs-backed store
 * has no counter. A transport that cannot report a revision gets `null`, and
 * the permission lattice then SKIPS the staleness rule rather than inventing
 * a revision and refusing honest writes.
 */
export function storeRevision(store: Services["store"]): number | null {
  if (!("getRevision" in store)) return null;
  return store.getRevision();
}
