import type { ProjectDocument } from "../project-model/types";

/**
 * The document revision, when the store has one (ADR 0065).
 *
 * The local `ProjectStore` counts every applied change; the Yjs-backed store
 * has no counter. A transport that cannot report a revision gets `null`, and
 * the permission lattice then SKIPS the staleness rule rather than inventing a
 * revision and refusing honest writes.
 *
 * The contract is deliberately NARROW: a store participates in it by exposing
 * the document and, optionally, a revision — nothing else about the store is
 * part of it. Typing it as the whole `ProjectStore | YDocStore` forced every
 * caller that only needs the revision to fake an entire store (or cast it
 * away), which is how a real mismatch gets hidden behind a lie.
 *
 * `getDoc` is REQUIRED, not optional, and that is deliberate: an interface
 * whose every member is optional is a "weak type", and TypeScript then rejects
 * any argument that shares no property with it. A store WITHOUT a revision is
 * a legal state (ADR 0065), not a type error — so the contract must not be
 * one that makes "has no revision" unspellable.
 */
export interface RevisionSource {
  getDoc: () => ProjectDocument;
  getRevision?: () => number;
}

export function storeRevision(store: RevisionSource): number | null {
  if (typeof store.getRevision !== "function") return null;
  return store.getRevision();
}
