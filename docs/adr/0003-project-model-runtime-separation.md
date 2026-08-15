# ADR 0003 — Project model / runtime separation

Date: 2026-08-15
Status: Accepted

The persisted `ProjectDocument` is pure serializable data (schema-versioned, JSON round-trip stable). It never contains AudioNodes, AudioParams, DOM or React objects. All mutations pass through a command system with undo/redo; the audio engine is synchronized as a projection of the document and is always reconstructable from it.

Consequence: `ProjectStore` holds the single source of truth; React renders via `useSyncExternalStore`; the engine diffs documents on change instead of being mutated by components.
